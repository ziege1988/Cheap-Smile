export class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); }
  async delete(k) { this.m.delete(k); }
}

/** Fake-Internet: map von URL-Präfix -> {status, body} oder Funktion */
export function fakeWeb(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).filter((k) => String(url).startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response('not found', { status: 404 });
    let r = routes[key];
    if (typeof r === 'function') r = await r(url, init);
    if (typeof r === 'string') r = { body: r };
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers || { 'Content-Type': 'text/html' } });
  };
  f.calls = calls;
  return f;
}

export const productPage = ({ name, price, shipping, condition = 'NewCondition', gtin = '4548736132610', old, extra = '' }) => `<!doctype html><html><head><title>${name} | Shop</title>
<meta property="og:image" content="/img/p.jpg">
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Product', name, gtin13: gtin, image: ['https://cdn.example/p.jpg'],
  offers: {
    '@type': 'Offer', price: String(price), priceCurrency: 'EUR', availability: 'https://schema.org/InStock',
    itemCondition: `https://schema.org/${condition}`,
    ...(old ? { priceSpecification: [{ '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: old }] } : {}),
    ...(shipping != null ? { shippingDetails: { '@type': 'OfferShippingDetails', shippingRate: { '@type': 'MonetaryAmount', value: shipping, currency: 'EUR' }, shippingDestination: { addressCountry: 'DE' } } } : {}),
  },
})}</script></head><body><h1>${name}</h1>${extra}</body></html>`;

export const trustpilotPage = (score, count, name) => `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@graph': [{ '@type': 'LocalBusiness', name, aggregateRating: { '@type': 'AggregateRating', ratingValue: String(score), reviewCount: String(count) } }],
})}</script></head><body></body></html>`;

export const homePage = (domain) => `<html><body><nav>
<a href="https://${domain}/impressum">Impressum</a> <a href="/widerruf">Widerrufsbelehrung</a> <a href="/agb">AGB</a>
</nav></body></html>`;

export const impressumDE = `<html><body><h1>Impressum</h1><p>Muster Elektronik GmbH<br>Hauptstraße 12<br>10115 Berlin<br>Deutschland</p>
<p>Telefon: +49 30 123456<br>E-Mail: info@muster.de</p><p>Handelsregister: HRB 12345, Amtsgericht Berlin. USt-IdNr. DE123456789</p></body></html>`;

export const impressumCN = `<html><body><h1>Impressum</h1><p>Shenzhen Happy Trading Co., Ltd.<br>Room 1203, Building A, Longhua District<br>518000 Shenzhen, Guangdong, China</p>
<p>Tel: +86 755 1234567, E-Mail: service@happy.com</p></body></html>`;

export const widerrufOK = `<html><body><h1>Widerrufsbelehrung</h1><p>Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen. Die Widerrufsfrist beträgt 14 Tage ab dem Tag, an dem Sie die Waren in Besitz genommen haben.</p>
<p>Sie haben die Waren unverzüglich an uns zurückzusenden: Muster Elektronik GmbH, Hauptstraße 12, 10115 Berlin. Wir tragen die Kosten der Rücksendung.</p></body></html>`;
