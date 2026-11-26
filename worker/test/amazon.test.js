import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { parseAmazonResults } from '../src/amazon.js';
import { MemoryKV, fakeWeb, productPage, trustpilotPage, homePage, impressumDE, widerrufOK } from './helpers.js';

const rdapOld = { body: JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' }] }) };
const shop = (d, page) => ({ [`https://de.trustpilot.com/review/${d}`]: trustpilotPage(4.6, 900, d), [`https://${d}/`]: homePage(d),
  [`https://${d}/impressum`]: impressumDE, [`https://${d}/widerruf`]: widerrufOK, [`https://rdap.org/domain/${d}`]: rdapOld, [`https://${d}/p/`]: page });
const amazonJson = (items) => ({ body: JSON.stringify({ organic_results: items }) });

test('Amazon-Ergebnisse: Preis, Versand, ASIN-Link, Werbung ignoriert', () => {
  const r = parseAmazonResults({ organic_results: [
    { asin: 'B0SPONSOR1', title: 'Werbung', extracted_price: 5, sponsored: true },
    { asin: 'B0ABCDEF12', title: 'Sony WH-1000XM5 Kopfhörer, Schwarz', extracted_price: 279, delivery: ['KOSTENLOSE Lieferung Mi., 3. Dez.'], extracted_old_price: 419 },
    { asin: 'B0CHEAP123', title: 'Kabel', price: '9,99 €' },
  ] });
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'https://www.amazon.de/dp/B0ABCDEF12');
  assert.equal(r[0].shipping, 0);
  assert.equal(r[0].oldPrice, 419);
  assert.equal(r[0].color, 'schwarz');
  assert.equal(r[1].price, 9.99);
  assert.equal(r[1].shipping, null, 'unter 39 € ohne Angabe -> unbekannt (wird geschätzt)');
});

async function setup(amazonRoute) {
  globalThis.fetch = fakeWeb({
    ...shop('muster.de', productPage({ name: 'Sony WH-1000XM5 Schwarz', price: 299, shipping: 0 })),
    'https://html.duckduckgo.com/': '<html></html>',
    'https://serpapi.com/search.json?engine=google': { body: JSON.stringify({ organic_results: [{ link: 'https://www.amazon.de/dp/B0ABCDEF12' }] }) },
    'https://serpapi.com/search.json?engine=amazon': amazonRoute,
    'https://de.trustpilot.com/review/amazon.de': trustpilotPage(1.9, 40000, 'Amazon'),
    'https://amazon.de/': { status: 503 },
  });
  const env = { DB: new MemoryKV(), APP_TOKEN: 'geheim', SERPAPI_KEY: 'k' };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (method, path, body) => (await worker.fetch(new Request(`https://api.test${path}`, { method, headers: { Authorization: 'Bearer geheim', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env, ctx)).json();
  return { env, call, waits };
}

test('Amazon-Schalter: exakter Artikel wird gefunden, anderer Artikel verworfen, Schalter aus entfernt Angebot', async () => {
  const { env, call, waits } = await setup(amazonJson([
    { asin: 'B0OTHER001', title: 'Sony WH-1000XM4 Kopfhörer, Schwarz', extracted_price: 199 },
    { asin: 'B0ABCDEF12', title: 'Sony WH-1000XM5 Noise Cancelling Kopfhörer, Schwarz', extracted_price: 279, delivery: ['Kostenlose Lieferung'] },
  ]));
  const p = await call('POST', '/api/products', { query: 'https://muster.de/p/1', includeAmazon: true });
  await Promise.all(waits);
  let d = await call('GET', `/api/products/${p.id}`);
  const amz = d.offers.find((o) => o.domain === 'amazon.de');
  assert.ok(amz, 'Amazon-Angebot vorhanden');
  assert.equal(amz.price, 279);
  assert.equal(amz.url, 'https://www.amazon.de/dp/B0ABCDEF12');
  assert.equal(amz.shop.allowlisted, true);
  assert.match(amz.matchNote, /Verkäufer/);
  assert.equal(d.best.domain, 'amazon.de');

  d = await call('PATCH', `/api/products/${p.id}`, { includeAmazon: false });
  assert.ok(!d.offers.some((o) => o.domain === 'amazon.de'));
  assert.equal(d.best.domain, 'muster.de');
  assert.ok(Number(await env.DB.get(`serpapi:${new Date().toISOString().slice(0, 7)}`)) >= 1, 'Kontingent gezählt');
});

test('Kontingent erschöpft: kein Abruf, letzter Amazon-Preis bleibt und wird markiert', async () => {
  const { env, call, waits } = await setup(amazonJson([{ asin: 'B0ABCDEF12', title: 'Sony WH-1000XM5 Kopfhörer Schwarz', extracted_price: 279 }]));
  const p = await call('POST', '/api/products', { query: 'https://muster.de/p/1', includeAmazon: true });
  await Promise.all(waits);
  await env.DB.put(`serpapi:${new Date().toISOString().slice(0, 7)}`, '240');
  const r = await call('POST', `/api/products/${p.id}/refresh`);
  const amz = r.product.offers.find((o) => o.domain === 'amazon.de');
  assert.ok(amz, 'Amazon-Preis bleibt erhalten');
  assert.equal(amz.quotaStale, true);
  assert.match(r.product.amazonError, /Suchkontingent/);
  const q = await call('GET', '/api/quota');
  assert.equal(q.used, 240);
});

test('Kontingent-Status: eigener Zähler, echter SerpApi-Stand, „heute pausiert“ und „aufgebraucht“', async () => {
  const { quotaStatus } = await import('../src/search.js');
  const { createFetcher } = await import('../src/util.js');
  const now = new Date(Date.UTC(2026, 10, 10)); // 10. November
  const env = { DB: new MemoryKV(), SERPAPI_KEY: 'k' };
  await env.DB.put('serpapi:2026-11', '50');
  let q = await quotaStatus(env, null, now);
  assert.deepEqual([q.left, q.exhausted, q.pausedToday, q.resetDate], [190, false, false, '2026-12-01']);
  await env.DB.put('serpapi:2026-11', '120'); // mehr als für den 10. vorgesehen (~85)
  q = await quotaStatus(env, null, now);
  assert.equal(q.pausedToday, true);
  const web = fakeWeb({ 'https://serpapi.com/account.json': { body: JSON.stringify({ total_searches_left: 8, this_month_usage: 242 }) } });
  q = await quotaStatus(env, createFetcher(web), now);
  assert.equal(q.exhausted, true, 'echter Stand bei SerpApi hat Vorrang');
  assert.equal(q.source, 'serpapi');
});
