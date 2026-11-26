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

test('Kategorie-/Listenseite wird als solche erkannt', () => {
  const list = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: [1, 2, 3, 4].map((i) => ({ '@type': 'ListItem', item: { '@type': 'Product', name: `Merino Shirt ${i}`, gtin13: `400000000000${i}`, offers: { '@type': 'Offer', price: 20 + i, priceCurrency: 'EUR' } } })) })}</script>`;
  assert.equal(extractOffer(list, 'https://x.de/damen/merino').isListing, true);
  assert.equal(extractOffer(productPage({ name: 'A', price: 10 }), 'https://x.de/suche?q=merino').isListing, false, 'einzelnes Produkt bleibt Produkt');
});

test('Varianten: genau die gesuchte EAN (Größe/Farbe) wird gewählt', () => {
  const group = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', name: 'Merino Unterhemd', productGroupID: 'MU1', hasVariant: [
    { '@type': 'Product', name: 'Merino Unterhemd S', gtin13: '5712345000011', offers: { '@type': 'Offer', price: '34.95', priceCurrency: 'EUR', url: 'https://dilling.de/p/mu?variant=11' } },
    { '@type': 'Product', name: 'Merino Unterhemd M', gtin13: '5712345000028', offers: { '@type': 'Offer', price: '36.95', priceCurrency: 'EUR', url: 'https://dilling.de/p/mu?variant=22' } },
  ] })}</script>`;
  const m = extractOffer(group, 'https://dilling.de/p/mu', {}, { gtin: '5712345000028' });
  assert.equal(m.price, 36.95);
  assert.equal(m.gtin, '5712345000028');
  assert.equal(m.url, 'https://dilling.de/p/mu?variant=22', 'Link führt direkt zur Variante');
  const viaUrl = extractOffer(group, 'https://dilling.de/p/mu?variant=11');
  assert.equal(viaUrl.gtin, '5712345000011');
  assert.equal(extractOffer(group, 'https://dilling.de/p/mu').ambiguousVariant, true);
  assert.notEqual(extractOffer(group, 'https://dilling.de/p/mu', {}, { gtin: '9999999999999' }).gtin, '9999999999999', 'gesuchte Variante fehlt -> andere EAN, wird beim Abgleich verworfen');
  const byColor = `<script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', name: 'Shirt', productGroupID: 'S1', hasVariant: [
    { '@type': 'Product', name: 'Shirt', color: 'Black', size: 'M', offers: { '@type': 'Offer', price: '20', priceCurrency: 'EUR' } },
    { '@type': 'Product', name: 'Shirt', color: 'Navy', size: 'M', offers: { '@type': 'Offer', price: '22', priceCurrency: 'EUR' } },
  ] })}</script>`;
  const c = extractOffer(byColor, 'https://x.de/p/shirt', {}, { color: 'marine', size: 'm' });
  assert.equal(c.price, 22, 'Variante über Farbe + Größe gewählt (Navy = Marine)');
});

test('Variante aus dem Link: Adresse, SKU/EAN/ID im Pfad, Parameter, #Fragment, Farbe/Größe', async () => {
  const { variantFromUrl } = await import('../src/extract.js');
  const page = (variants) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', name: 'Shirt', productGroupID: 'S', hasVariant: variants })}</script>`;
  const v = (o) => ({ '@type': 'Product', name: 'Shirt', ...o, offers: { '@type': 'Offer', price: String(o.price || 30), priceCurrency: 'EUR', ...(o.url ? { url: o.url } : {}) } });
  const html = page([
    v({ color: 'Schwarz', size: 'M', sku: 'SH-BLK-M', gtin13: '4001234000011', productID: '881' }),
    v({ color: 'Schwarz', size: 'L', sku: 'SH-BLK-L', gtin13: '4001234000028', productID: '882' }),
    v({ color: 'Navy', size: 'M', sku: 'SH-NAV-M', gtin13: '4001234000035', productID: '883' }),
  ]);
  const g = (u) => extractOffer(html, u.split('#')[0], {}, { hintUrl: u }).gtin;
  assert.equal(g('https://shop.de/shirt?attribute_pa_farbe=navy&attribute_pa_groesse=m'), '4001234000035', 'Farbe+Größe als Parameter');
  assert.equal(g('https://shop.de/shirt/SH-BLK-L'), '4001234000028', 'SKU im Pfad');
  assert.equal(g('https://shop.de/shirt?pid=882'), '4001234000028', 'Varianten-ID unter beliebigem Namen');
  assert.equal(g('https://shop.de/shirt?ean=4001234000011'), '4001234000011', 'EAN im Link');
  assert.equal(g('https://shop.de/shirt#size=L&color=schwarz'), '4001234000028', 'Auswahl hinter #');
  assert.equal(g('https://shop.de/shirt-navy'), '4001234000035', 'nur eine Navy-Variante -> eindeutig');
  const amb = extractOffer(html, 'https://shop.de/shirt-schwarz', {}, { hintUrl: 'https://shop.de/shirt-schwarz' });
  assert.equal(amb.ambiguousVariant, true, 'Schwarz gibt es in M und L -> nicht eindeutig');

  const shopify = page([
    v({ color: 'Black', size: 'S', url: 'https://x.de/products/tee?variant=111', price: 20 }),
    v({ color: 'Black', size: 'M', url: 'https://x.de/products/tee?variant=222', price: 21 }),
  ]);
  const sx = extractOffer(shopify, 'https://x.de/products/tee?variant=222&utm_source=insta', {}, { hintUrl: 'https://x.de/products/tee?variant=222&utm_source=insta' });
  assert.deepEqual([sx.price, sx.size, sx.ambiguousVariant], [21, 'M', false], 'Shopify-Variante trotz Tracking-Parametern');
  assert.equal(variantFromUrl([], 'https://x.de'), null);
});
