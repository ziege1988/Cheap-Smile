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

test('Push-Schlüssel werden automatisch erzeugt, wenn keine Secrets gesetzt sind', async () => {
  const env = { DB: new MemoryKV(), APP_TOKEN: 'x' };
  const res = await worker.fetch(new Request('https://api.test/api/vapid'), env, { waitUntil() {} });
  const { publicKey } = await res.json();
  assert.equal(publicKey.length, 87); // 65 Bytes base64url
  const again = await (await worker.fetch(new Request('https://api.test/api/vapid'), env, { waitUntil() {} })).json();
  assert.equal(again.publicKey, publicKey, 'stabil gespeichert');
});

test('Shop-Link: Name sofort übernommen, nach Sperre wird bei „Jetzt neu prüfen“ neu bewertet', async () => {
  let blocked = true;
  const tpRoute = () => (blocked ? { status: 403 } : trustpilotPage(4.5, 2000, 'Dilling'));
  const web = fakeWeb({
    ...shop('dilling.de', productPage({ name: 'Merino Unterhemd Damen', price: 34.95, shipping: 0 })),
    'https://de.trustpilot.com/review/dilling.de': tpRoute,
    'https://www.trustpilot.com/review/dilling.de': tpRoute,
    'https://html.duckduckgo.com/': '<html></html>',
  });
  globalThis.fetch = web;
  const env = { DB: new MemoryKV(), APP_TOKEN: 'geheim' };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`https://api.test${path}`, { method, headers: { Authorization: 'Bearer geheim', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
    return res.json();
  };
  await call('PUT', '/api/settings', { allowWithoutTrustpilotData: false });
  const p = await call('POST', '/api/products', { query: 'https://dilling.de/p/1', wishPrice: 30 });
  await Promise.all(waits);
  let d = await call('GET', `/api/products/${p.id}`);
  assert.equal(d.name, 'Merino Unterhemd Damen', 'Name trotz Ausschluss übernommen');
  assert.equal(d.offers.length, 0);
  assert.match(d.excluded[0].reasons[0], /nicht erreichbar/);

  blocked = false;
  await env.DB.delete('shop3:dilling.de'); // 6-h-Cache simuliert abgelaufen
  d = (await call('POST', `/api/products/${p.id}/refresh`)).product;
  assert.equal(d.offers.length, 1, 'Shop nach erneuter Prüfung zugelassen');
  assert.equal(d.excluded.length, 0);
  assert.equal(d.best.effectiveTotal, 34.95);
});

test('Nur exakt derselbe Artikel: andere EAN, ähnliche Titel und Kategorieseiten fliegen raus', async () => {
  const listing = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: [1, 2, 3, 4].map((i) => ({ '@type': 'ListItem', item: { '@type': 'Product', name: `Sony Kopfhörer ${i}`, gtin13: '4548736132610', offers: { '@type': 'Offer', price: 100 + i, priceCurrency: 'EUR' } } })) })}</script>`;
  const web = fakeWeb({
    'https://html.duckduckgo.com/': ddg(['https://haendler-a.de/p/1', 'https://haendler-b.de/p/2', 'https://haendler-c.de/kategorie/kopfhoerer']),
    ...shop('muster.de', productPage({ name: 'Sony WH-1000XM5 Schwarz', price: 299, shipping: 0, gtin: '4548736132610' })),
    ...shop('haendler-a.de', productPage({ name: 'Sony WH-1000XM5 Kopfhörer schwarz', price: 279, shipping: 0, gtin: '4548736132610' })),
    ...shop('haendler-b.de', productPage({ name: 'Sony WH-1000XM5 Kopfhörer silber', price: 259, shipping: 0, gtin: '4548736132627' })),
    ...shop('haendler-c.de', listing),
    'https://haendler-c.de/kategorie/': listing,
  });
  globalThis.fetch = web;
  const env = { DB: new MemoryKV(), APP_TOKEN: 'geheim' };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body) => (await worker.fetch(new Request(`https://api.test${path}`, { method, headers: { Authorization: 'Bearer geheim', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx)).json();
  const p = await call('POST', '/api/products', { query: 'https://muster.de/p/1' });
  await Promise.all(waits);
  const d = await call('GET', `/api/products/${p.id}`);
  assert.equal(d.gtin, '4548736132610');
  assert.deepEqual(d.offers.map((o) => o.domain).sort(), ['haendler-a.de', 'muster.de'], 'silberne Variante und Kategorieseite ausgeschlossen');
  assert.equal(d.best.domain, 'haendler-a.de');
  assert.equal(d.best.url, 'https://haendler-a.de/p/1');
  assert.equal(d.best.shop.checks.register, true);
});

test('Ohne EAN beim Händler: Abgleich über Marke, Bezeichnung, Farbe und Größe – mit Begründung bei Ablehnung', async () => {
  const pg = (o) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: o.name, brand: { '@type': 'Brand', name: o.brand }, ...(o.gtin ? { gtin13: o.gtin } : {}), ...(o.color ? { color: o.color } : {}),
    offers: { '@type': 'Offer', price: String(o.price), priceCurrency: 'EUR', shippingDetails: { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: 0 } } } })}</script>`;
  const web = fakeWeb({
    'https://html.duckduckgo.com/': ddg(['https://amaz-shop.de/p/1', 'https://kids-club.de/p/2', 'https://andere-farbe.de/p/3', 'https://anderes-modell.de/p/4']),
    ...shop('hersteller.de', pg({ name: 'Lilliputiens Stoffbuch Lia Rot', brand: 'Lilliputiens', gtin: '5414834000011', color: 'Rot', price: 29.9 })),
    ...shop('amaz-shop.de', pg({ name: 'Lilliputiens 86751 Stoffbuch Lia - Rot', brand: 'Lilliputiens', color: 'rot', price: 24.5 })),
    ...shop('kids-club.de', pg({ name: 'Stoffbuch Lia von Lilliputiens, rot', brand: 'Lilliputiens', price: 22 })),
    ...shop('andere-farbe.de', pg({ name: 'Lilliputiens Stoffbuch Lia Blau', brand: 'Lilliputiens', color: 'Blau', price: 19 })),
    ...shop('anderes-modell.de', pg({ name: 'Lilliputiens Stoffbuch Jack Rot', brand: 'Lilliputiens', color: 'Rot', price: 18 })),
  });
  globalThis.fetch = web;
  const env = { DB: new MemoryKV(), APP_TOKEN: 'geheim' };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body) => (await worker.fetch(new Request(`https://api.test${path}`, { method, headers: { Authorization: 'Bearer geheim', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx)).json();
  const p = await call('POST', '/api/products', { query: 'https://hersteller.de/p/lia' });
  await Promise.all(waits);
  const d = await call('GET', `/api/products/${p.id}`);
  assert.deepEqual(d.offers.map((o) => o.domain).sort(), ['amaz-shop.de', 'hersteller.de', 'kids-club.de']);
  assert.equal(d.best.domain, 'kids-club.de');
  assert.equal(d.best.matchedBy, 'Bezeichnung & Merkmale');
  const why = Object.fromEntries(d.skipped.map((x) => [x.domain, x.why]));
  assert.match(why['andere-farbe.de'], /Farbe/);
  assert.match(why['anderes-modell.de'], /Bezeichnung/);
});

test('Farbe/Größe als Kriterium: Auswahl aus dem Shop-Link, danach nur passende Angebote', async () => {
  const group = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', name: 'Merino Shirt Damen', brand: { '@type': 'Brand', name: 'Dilling' }, productGroupID: 'MS', hasVariant: [
    { '@type': 'Product', name: 'Merino Shirt Damen', color: 'Schwarz', size: 'M', gtin13: '5700000000011', offers: { '@type': 'Offer', price: '39.95', priceCurrency: 'EUR', url: 'https://dilling.de/p/ms?variant=1' } },
    { '@type': 'Product', name: 'Merino Shirt Damen', color: 'Schwarz', size: 'L', gtin13: '5700000000028', offers: { '@type': 'Offer', price: '39.95', priceCurrency: 'EUR', url: 'https://dilling.de/p/ms?variant=2' } },
    { '@type': 'Product', name: 'Merino Shirt Damen', color: 'Navy', size: 'M', gtin13: '5700000000035', offers: { '@type': 'Offer', price: '42.95', priceCurrency: 'EUR', url: 'https://dilling.de/p/ms?variant=3' } },
  ] })}</script>`;
  const web = fakeWeb({
    'https://html.duckduckgo.com/': ddg(['https://shop-navy.de/p/1', 'https://shop-schwarz.de/p/2']),
    ...shop('dilling.de', group),
    ...shop('shop-navy.de', productPage({ name: 'Dilling Merino Shirt Damen navy', price: 35, shipping: 0, gtin: '5700000000035' })),
    ...shop('shop-schwarz.de', productPage({ name: 'Dilling Merino Shirt Damen schwarz', price: 33, shipping: 0, gtin: '5700000000011' })),
  });
  globalThis.fetch = web;
  const env = { DB: new MemoryKV(), APP_TOKEN: 'geheim' };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body) => (await worker.fetch(new Request(`https://api.test${path}`, { method, headers: { Authorization: 'Bearer geheim', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx)).json();

  const p = await call('POST', '/api/products', { query: 'https://dilling.de/p/ms', includeAmazon: false });
  await Promise.all(waits); waits.length = 0;
  let d = await call('GET', `/api/products/${p.id}`);
  assert.deepEqual([d.variantOptions.colors, d.variantOptions.sizes], [['schwarz', 'navy'], ['M', 'L']]);
  assert.equal(d.variantOptions.combos.length, 3);
  assert.equal(d.offers.length, 3, 'ohne Auswahl: alle Varianten zählen');

  d = await call('PATCH', `/api/products/${p.id}`, { color: 'navy', size: 'M' });
  await Promise.all(waits); waits.length = 0;
  d = await call('GET', `/api/products/${p.id}`);
  assert.equal(d.gtin, '5700000000035', 'EAN der gewählten Variante');
  assert.deepEqual(d.offers.map((o) => o.domain).sort(), ['dilling.de', 'shop-navy.de']);
  assert.equal(d.offers.find((o) => o.manual).price, 42.95, 'Preis der gewählten Variante beim Hersteller');
  assert.equal(d.offers.find((o) => o.manual).url, 'https://dilling.de/p/ms?variant=3', 'Link direkt zur Variante');

  // Direkt beim Anlegen vorgegeben
  const p2 = await call('POST', '/api/products', { query: 'https://dilling.de/p/ms', color: 'Schwarz', size: 'L', includeAmazon: false });
  await Promise.all(waits);
  const d2 = await call('GET', `/api/products/${p2.id}`);
  assert.equal(d2.gtin, '5700000000028');
  assert.deepEqual(d2.offers.map((o) => o.domain), ['dilling.de'], 'kein anderer Shop hat Schwarz/L');
});

test('Warteschlange: Abbruch wegen Abruf-Budget setzt beim nächsten Lauf fort – ohne neue Suche', async () => {
  const urls = Array.from({ length: 6 }, (_, i) => `https://laden${i}.de/p/${i}`);
  const routes = { 'https://html.duckduckgo.com/': ddg(urls), ...shop('muster.de', productPage({ name: 'Sony WH-1000XM5 Schwarz', price: 299, shipping: 0 })) };
  urls.forEach((u, i) => Object.assign(routes, shop(`laden${i}.de`, productPage({ name: 'Sony WH-1000XM5 Schwarz', price: 280 + i, shipping: 0 }))));
  const web = fakeWeb(routes);
  globalThis.fetch = web;
  const env = { DB: new MemoryKV(), APP_TOKEN: 'geheim', SUBREQUEST_BUDGET: '25' };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body) => (await worker.fetch(new Request(`https://api.test${path}`, { method, headers: { Authorization: 'Bearer geheim', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx)).json();
  const p = await call('POST', '/api/products', { query: 'https://muster.de/p/1', includeAmazon: false });
  await Promise.all(waits);
  let d = await call('GET', `/api/products/${p.id}`);
  assert.ok(d.queued > 0, 'Rest wartet in der Schlange');
  const before = d.offers.length;
  const searchesBefore = web.calls.filter((c) => c.url.includes('duckduckgo')).length;
  for (let i = 0; i < 4; i++) await scheduled(env, web);
  d = await call('GET', `/api/products/${p.id}`);
  assert.equal(d.queued, 0);
  assert.equal(d.offers.length, 7, 'Hersteller + 6 Läden');
  assert.ok(d.offers.length > before);
  assert.equal(web.calls.filter((c) => c.url.includes('duckduckgo')).length, searchesBefore, 'keine erneute Suche');
});
