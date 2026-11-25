import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOffer, shippingFromText, extractCoupons, conditionFrom } from '../src/extract.js';
import { parsePrice, matchScore, domainOf } from '../src/util.js';
import { productPage } from './helpers.js';

test('parsePrice: deutsche und englische Formate', () => {
  assert.equal(parsePrice('1.299,00 €'), 1299);
  assert.equal(parsePrice('19,99'), 19.99);
  assert.equal(parsePrice('1,299.50'), 1299.5);
  assert.equal(parsePrice('249.00'), 249);
  assert.equal(parsePrice('1.299'), 1299);
  assert.equal(parsePrice(''), null);
});

test('JSON-LD: Preis, Versand, Zustand, Streichpreis', () => {
  const html = productPage({ name: 'Sony WH-1000XM5 Schwarz', price: 279.0, shipping: 4.99, old: 419 });
  const o = extractOffer(html, 'https://shop.de/p/1');
  assert.equal(o.price, 279);
  assert.equal(o.shipping, 4.99);
  assert.equal(o.total, 283.99);
  assert.equal(o.shippingEstimated, false);
  assert.equal(o.condition, 'new');
  assert.equal(o.oldPrice, 419);
  assert.equal(o.discountPct, 33);
  assert.equal(o.gtin, '4548736132610');
});

test('Gebraucht wird aus itemCondition und Titel erkannt', () => {
  const html = productPage({ name: 'Sony WH-1000XM5', price: 180, shipping: 0, condition: 'UsedCondition' });
  assert.equal(extractOffer(html, 'https://x.de').condition, 'used');
  assert.equal(conditionFrom('', 'iPhone 15 128GB - Refurbished - Sehr gut'), 'refurbished');
  assert.equal(conditionFrom('https://schema.org/NewCondition', 'Sony WH-1000XM5 (B-Ware)'), 'used');
});

test('Versand aus Text, inkl. Schwelle für versandkostenfrei', () => {
  assert.deepEqual(shippingFromText('Preis 39,99 € zzgl. 4,95 € Versand', 39.99), { shipping: 4.95, threshold: null });
  assert.equal(shippingFromText('Versandkostenfrei ab 50 € Bestellwert', 79).shipping, 0);
  assert.equal(shippingFromText('Versandkostenfrei ab 50 € Bestellwert', 29).shipping, null);
  assert.equal(shippingFromText('Kostenloser Versand innerhalb Deutschlands', 10).shipping, 0);
});

test('Unbekannter Versand -> konservative Schätzung, markiert', () => {
  const html = productPage({ name: 'Testprodukt 123', price: 50 });
  const o = extractOffer(html, 'https://x.de', { fallbackShipping: 5.95 });
  assert.equal(o.shipping, 5.95);
  assert.equal(o.shippingEstimated, true);
});

test('Gutscheincodes werden gefunden, Füllwörter nicht', () => {
  const c = extractCoupons('Nur heute: 10 % Rabatt mit dem Code SOMMER10 im Warenkorb! Gutschein: hier einlösen');
  assert.equal(c.length, 1);
  assert.equal(c[0].code, 'SOMMER10');
  assert.equal(c[0].percent, 10);
});

test('Meta-Tag-Fallback ohne JSON-LD', () => {
  const html = '<html><head><title>Bosch PSR 18 LI-2</title><meta property="product:price:amount" content="89.90"><meta property="product:price:currency" content="EUR"></head><body>Versandkostenfrei</body></html>';
  const o = extractOffer(html, 'https://x.de');
  assert.equal(o.price, 89.9);
  assert.equal(o.shipping, 0);
});

test('matchScore: Modellnummer muss passen, Zubehör fliegt raus', () => {
  assert.ok(matchScore('Sony WH-1000XM5', 'Sony WH-1000XM5 Bluetooth Kopfhörer schwarz') >= 0.7);
  assert.equal(matchScore('Sony WH-1000XM5', 'Sony WH-1000XM4 Kopfhörer'), 0);
  assert.equal(matchScore('Sony WH-1000XM5', 'Hülle für Sony WH-1000XM5'), 0);
  assert.equal(domainOf('https://www.otto.de/p/123'), 'otto.de');
});
