import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { scheduled } from '../src/index.js';
import { b64urlEncode } from '../src/push.js';
import { MemoryKV, fakeWeb, productPage, trustpilotPage, homePage, impressumDE, impressumCN, widerrufOK } from './helpers.js';

const rdapOld = { body: JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' }] }) };
function shop(d, page, { impressum = impressumDE, tp = trustpilotPage(4.6, 900, d) } = {}) {
  return {
    [`https://de.trustpilot.com/review/${d}`]: tp,
    [`https://${d}/`]: homePage(d),
    [`https://${d}/impressum`]: impressum,
    [`https://${d}/widerruf`]: widerrufOK,
    [`https://rdap.org/domain/${d}`]: rdapOld,
    [`https://${d}/p/`]: page,
  };
}
const ddg = (urls) => `<html>${urls.map((u) => `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(u)}&rut=x">t</a>`).join('')}</html>`;

async function setup() {
  const pushes = [];
  const web = fakeWeb({
    'https://html.duckduckgo.com/html/': ddg([
      'https://www.idealo.de/preisvergleich/xyz', 'https://de.aliexpress.com/item/1.html',
      'https://muster.de/p/1', 'https://elektro-zwei.de/p/2', 'https://superbillig.de/p/3',
      'https://happy-deals.de/p/4', 'https://secondhand-shop.de/p/5', 'https://zubehoer.de/p/6',
    ]),
    ...shop('muster.de', productPage({ name: 'Sony WH-1000XM5 Kopfhörer Schwarz', price: 279, shipping: 4.99, extra: '<p>Jetzt 5 % sparen mit dem Code SMILE5</p>' })),
    ...shop('elektro-zwei.de', productPage({ name: 'Sony WH-1000XM5 Noise Cancelling', price: 299, shipping: 0 })),
    ...shop('superbillig.de', productPage({ name: 'Sony WH-1000XM5', price: 99, shipping: 0 })),
    ...shop('happy-deals.de', productPage({ name: 'Sony WH-1000XM5', price: 199, shipping: 0 }), { impressum: impressumCN }),
    ...shop('secondhand-shop.de', productPage({ name: 'Sony WH-1000XM5 gebraucht', price: 170, shipping: 3.9, condition: 'UsedCondition' })),
    ...shop('zubehoer.de', productPage({ name: 'Hülle für Sony WH-1000XM5', price: 12, shipping: 0, gtin: '4000000000017' })),
    'https://web.push.apple.com/': (url, init) => { pushes.push(init); return { status: 201 }; },
  });
  globalThis.fetch = web;
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const env = {
    DB: new MemoryKV(), APP_TOKEN: 'geheim',
    VAPID_PUBLIC_KEY: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d,
    VAPID_SUBJECT: 'https://example.github.io/',
  };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body, token = 'geheim') => {
    const res = await worker.fetch(new Request(`https://api.test${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }), env, ctx);
    return { status: res.status, data: await res.json() };
  };
  // Push-Abo eines iPhones
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  await call('POST', '/api/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/dev1', keys: {
    p256dh: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) } } });
  return { env, call, waits, pushes, web };
}

test('Ende-zu-Ende: anlegen, filtern, Gebraucht umschalten, löschen', async () => {
  const { env, call, waits, pushes } = await setup();

  assert.equal((await call('GET', '/api/products', null, 'falsch')).status, 401);

  const created = await call('POST', '/api/products', { query: 'Sony WH-1000XM5', wishPrice: '280', allowUsed: false });
  assert.equal(created.status, 201);
  await Promise.all(waits);

  const { data: [p] } = await call('GET', '/api/products');
  const domains = p.offers.map((o) => o.domain).sort();
  assert.deepEqual(domains, ['elektro-zwei.de', 'muster.de', 'secondhand-shop.de', 'superbillig.de']);

  const ex = Object.fromEntries(p.excluded.map((e) => [e.domain, e.reasons.join()]));
  assert.match(ex['happy-deals.de'], /Fernost/);
  assert.match(ex['aliexpress.com'], /Sperrliste/);
  assert.ok(!('idealo.de' in ex), 'Vergleichsportale werden gar nicht erst betrachtet');
  assert.ok(!p.offers.some((o) => o.domain === 'zubehoer.de'), 'Zubehör wird nicht als Angebot gewertet');

  const fake = p.offers.find((o) => o.domain === 'superbillig.de');
  assert.match(fake.excludedReason, /Fake-Shop-Verdacht/);

  // Bestes Neu-Angebot: 279 € −5 % Code + 4,99 € Versand = 270,04 €
  assert.equal(p.best.domain, 'muster.de');
  assert.equal(p.best.effectiveTotal, 270.04);
  assert.equal(p.best.coupons[0].code, 'SMILE5');

  // Wunschpreis 280 € erreicht -> genau eine Push
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].headers['Content-Encoding'], 'aes128gcm');

  // Gebraucht erlauben -> gebrauchtes Angebot wird Bestpreis
  const patched = await call('PATCH', `/api/products/${p.id}`, { allowUsed: true });
  assert.equal(patched.data.best.domain, 'secondhand-shop.de');
  assert.equal(patched.data.best.effectiveTotal, 173.9);
  const back = await call('PATCH', `/api/products/${p.id}`, { allowUsed: false });
  assert.equal(back.data.best.domain, 'muster.de');

  // Cron: keine doppelte Push beim gleichen Preis
  await env.DB.put(`product:${p.id}`, JSON.stringify({ ...JSON.parse(env.DB.m.get(`product:${p.id}`)), lastSearchAt: Date.now() }));
  const r = await scheduled(env, globalThis.fetch);
  assert.equal(r.checked, 1);
  assert.equal(pushes.length, 1);

  // Löschen entfernt Produkt und damit dessen Alarme
  await call('DELETE', `/api/products/${p.id}`);
  assert.equal((await call('GET', '/api/products')).data.length, 0);
  assert.equal(env.DB.m.has(`product:${p.id}`), false);
});

test('Produkt per Link anlegen übernimmt Titel', async () => {
  const { call, waits } = await setup();
  const c = await call('POST', '/api/products', { query: 'https://muster.de/p/1', wishPrice: null });
  await Promise.all(waits);
  const { data } = await call('GET', `/api/products/${c.data.id}`);
  assert.equal(data.name, 'Sony WH-1000XM5 Kopfhörer Schwarz');
  assert.ok(data.offers.some((o) => o.manual && o.domain === 'muster.de'));
});
