// Liest Preis, Versand, Zustand, Aktionen und Gutscheincodes aus einer Produktseite.
// Primärquelle: schema.org-Daten (JSON-LD), wie sie fast jeder seriöse Shop
// für Google Shopping ausliefert. Fallback: Meta-Tags und Textmuster.

import { parsePrice, htmlToText, decodeEntities, round2 } from './util.js';

export function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim().replace(/^<!--|-->$/g, '');
    try { out.push(JSON.parse(raw)); } catch {
      try { out.push(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '))); } catch {}
    }
  }
  return out;
}

function* walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  yield node;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant']) {
    if (node[k]) yield* walk(node[k]);
  }
}

const isType = (n, t) => {
  const ty = n['@type'];
  return Array.isArray(ty) ? ty.includes(t) : ty === t;
};

const first = (v) => (Array.isArray(v) ? v[0] : v);

function meta(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${name}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) return decodeEntities(content);
  }
  return null;
}

const USED_RE = /\b(gebraucht|refurbished|generalüberholt|generalueberholt|b-ware|renewed|aufbereitet|second[\s-]?hand|vorführgerät|vorfuehrgeraet|wie neu|retoure|used)\b/i;

export function conditionFrom(value, title = '') {
  const v = String(value || '');
  if (/Used|Refurbished|Damaged/i.test(v)) return /Refurbished/i.test(v) ? 'refurbished' : 'used';
  if (/NewCondition/i.test(v)) return USED_RE.test(title) ? 'used' : 'new';
  if (USED_RE.test(title)) return /refurbished|generalüberholt|generalueberholt|renewed|aufbereitet/i.test(title) ? 'refurbished' : 'used';
  return 'new';
}

function offerFromLd(offers) {
  const list = [];
  for (const o of [].concat(offers || [])) {
    if (!o || typeof o !== 'object') continue;
    if (isType(o, 'AggregateOffer')) {
      list.push({ price: parsePrice(o.lowPrice ?? o.price), currency: o.priceCurrency, raw: o });
      if (o.offers) list.push(...offerFromLd(o.offers));
      continue;
    }
    let price = parsePrice(o.price);
    let oldPrice = null;
    for (const ps of [].concat(o.priceSpecification || [])) {
      const p = parsePrice(ps?.price);
      if (p == null) continue;
      if (/Strikethrough|ListPrice|SRP|MSRP/i.test(String(ps.priceType || ''))) oldPrice = p;
      else if (price == null) price = p;
    }
    list.push({ price, oldPrice, currency: o.priceCurrency || first(o.priceSpecification)?.priceCurrency, raw: o });
  }
  return list.filter((x) => x.price != null && x.price > 0);
}

function shippingFromLd(raw) {
  for (const sd of [].concat(raw?.shippingDetails || [])) {
    const rate = first(sd?.shippingRate);
    const v = parsePrice(rate?.value ?? rate?.price);
    if (v != null) {
      const dest = [].concat(sd.shippingDestination || []).map((d) => d?.addressCountry).flat();
      if (!dest.length || dest.some((c) => /DE|Germany|Deutschland/i.test(String(c)))) return v;
    }
  }
  return null;
}

/** Versandkosten aus dem Seitentext. */
export function shippingFromText(text, price) {
  const t = text.replace(/\s+/g, ' ');
  const thr = t.match(/(?:versandkostenfrei|kostenloser versand|gratis versand|versand kostenlos)\s*(?:ab|über|ueber)\s*(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur)/i)
    || t.match(/(?:ab|über|ueber)\s*(\d+(?:[.,]\d{1,2})?)\s*(?:€|eur)[^.]{0,40}?(?:versandkostenfrei|kostenlose[rn]? versand|gratis versand)/i);
  const threshold = thr ? parsePrice(thr[1]) : null;
  if (threshold != null && price != null && price >= threshold) return { shipping: 0, threshold };
  const paid = t.match(/(?:zzgl\.?|zuzüglich|plus|\+)\s*(\d+[.,]\d{2})\s*(?:€|eur)\s*versand/i)
    || t.match(/versand(?:kosten)?(?:\s*\(de\))?\s*[:\-]?\s*(?:ab\s*)?(\d+[.,]\d{2})\s*(?:€|eur)/i)
    || t.match(/(?:zzgl\.?|zuzüglich|plus|\+)\s*versand(?:kosten)?\s*(?:von|:)?\s*(\d+[.,]\d{2})\s*(?:€|eur)/i);
  if (paid) return { shipping: parsePrice(paid[1]), threshold };
  if (threshold == null && /(versandkostenfrei|kostenloser versand|gratis versand|versand kostenlos|free shipping|0[.,]00\s*€\s*versand)/i.test(t)) {
    return { shipping: 0, threshold: null };
  }
  return { shipping: null, threshold };
}

/** Alter Preis / Rabatt aus dem Text („statt 299 €“, „UVP“, „-20 %“). */
function oldPriceFromText(html, text, price) {
  const cands = [];
  const re1 = /<(?:del|s|strike)\b[^>]*>([\s\S]{0,120}?)<\/(?:del|s|strike)>/gi;
  let m;
  while ((m = re1.exec(html))) { const p = parsePrice(htmlToText(m[1]).match(/\d[\d.,]*/)?.[0]); if (p) cands.push(p); }
  const re2 = /(?:statt|uvp|unverbindliche preisempfehlung|bisher|vorher|streichpreis|regulär|regulaer|ursprünglich)\s*:?\s*(\d[\d.]*,\d{2}|\d+(?:\.\d{2})?)\s*(?:€|eur)/gi;
  while ((m = re2.exec(text))) { const p = parsePrice(m[1]); if (p) cands.push(p); }
  const valid = cands.filter((p) => price && p > price * 1.02 && p < price * 4);
  return valid.length ? Math.max(...valid) : null;
}

const CODE_STOP = new Set(['HIER', 'JETZT', 'GRATIS', 'SALE', 'CODE', 'EINLOESEN', 'KOPIEREN', 'COPY', 'APPLY', 'GUTSCHEIN', 'RABATT', 'NEWSLETTER', 'AKTION', 'DEALS', 'SHOP', 'HTTPS', 'HTTP', 'EUR', 'INKL', 'MWST']);

/** Gutscheincodes, die auf der Seite selbst beworben werden. */
export function extractCoupons(text) {
  const out = [];
  const seen = new Set();
  const re = /(?:gutschein(?:-?code)?|rabatt(?:-?code)?|promo(?:-?code)?|coupon(?:-?code)?|aktionscode|voucher|discount code|mit (?:dem )?code|code)\s*[:=]?\s*["„“»'‚]?\s*([A-Z0-9][A-Z0-9_-]{3,19})\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const code = m[1];
    if (code !== code.toUpperCase() || !/[A-Z]/.test(code) || CODE_STOP.has(code) || seen.has(code)) continue;
    if (/^\d+$/.test(code)) continue;
    seen.add(code);
    const ctx = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).replace(/\s+/g, ' ');
    const pct = ctx.match(/(\d{1,2})\s*%/);
    const eur = ctx.match(/(\d{1,3}(?:[.,]\d{2})?)\s*(?:€|eur)\s*(?:rabatt|sparen|nachlass|gutschein|off)/i);
    out.push({
      code,
      percent: pct ? Number(pct[1]) : null,
      amount: eur ? parsePrice(eur[1]) : null,
      text: ctx.trim().slice(0, 160),
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** Hauptfunktion: alles Relevante aus einer Produktseite. */
export function extractOffer(html, url, settings = {}) {
  const text = htmlToText(html);
  const ld = extractJsonLd(html);
  let product = null;
  for (const root of ld) for (const n of walk(root)) if (!product && isType(n, 'Product')) product = n;

  const title = decodeEntities(
    String(product?.name || meta(html, ['og:title', 'twitter:title']) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
  ).replace(/\s+/g, ' ').trim();

  let price = null, oldPrice = null, currency = 'EUR', raw = null;
  const offers = product ? offerFromLd(product.offers) : [];
  if (offers.length) {
    const best = offers.reduce((a, b) => (b.price < a.price ? b : a));
    ({ price, oldPrice, raw } = best);
    currency = best.currency || 'EUR';
  } else {
    price = parsePrice(meta(html, ['product:price:amount', 'og:price:amount', 'price']));
    currency = meta(html, ['product:price:currency', 'og:price:currency', 'priceCurrency']) || 'EUR';
    if (price == null) {
      const ip = html.match(/itemprop\s*=\s*["']price["'][^>]*content\s*=\s*["']([^"']+)["']/i)
        || html.match(/content\s*=\s*["']([^"']+)["'][^>]*itemprop\s*=\s*["']price["']/i);
      price = parsePrice(ip?.[1]);
    }
  }

  const conditionRaw = raw?.itemCondition || product?.itemCondition || meta(html, ['product:condition', 'og:condition']);
  const condition = conditionFrom(conditionRaw, title);

  const availRaw = String(raw?.availability || meta(html, ['product:availability', 'og:availability']) || '');
  const available = availRaw ? !/OutOfStock|Discontinued|SoldOut|oos|out of stock/i.test(availRaw) : !/(ausverkauft|nicht (?:mehr )?(?:lieferbar|verfügbar)|out of stock)/i.test(text.slice(0, 20000));

  let shipping = shippingFromLd(raw);
  let shippingEstimated = false;
  let freeShippingFrom = null;
  if (shipping == null) {
    const s = shippingFromText(text, price);
    shipping = s.shipping;
    freeShippingFrom = s.threshold;
  }
  if (shipping == null) {
    shipping = settings.fallbackShipping ?? 5.95;
    shippingEstimated = true;
  }

  if (oldPrice == null) oldPrice = oldPriceFromText(html, text, price);
  const discountPct = oldPrice && price ? Math.round((1 - price / oldPrice) * 100) : null;

  const image = (() => {
    const img = first(product?.image);
    const v = typeof img === 'object' ? img?.url || img?.contentUrl : img;
    const u = v || meta(html, ['og:image', 'twitter:image']);
    try { return u ? new URL(u, url).toString() : null; } catch { return null; }
  })();

  const gtin = String(product?.gtin13 || product?.gtin || product?.gtin14 || product?.gtin12 || product?.gtin8 || product?.ean || '').replace(/\D/g, '') || null;
  const sellerName = first(raw?.seller)?.name || null;

  return {
    url,
    title,
    price,
    currency: String(currency).toUpperCase(),
    shipping: shipping != null ? round2(shipping) : null,
    shippingEstimated,
    freeShippingFrom,
    total: price != null ? round2(price + (shipping || 0)) : null,
    oldPrice,
    discountPct: discountPct && discountPct > 0 ? discountPct : null,
    condition,
    available,
    image,
    gtin,
    brand: first(product?.brand)?.name || (typeof product?.brand === 'string' ? product.brand : null),
    sellerName,
    coupons: extractCoupons(text),
    hasStructuredData: !!product,
  };
}
