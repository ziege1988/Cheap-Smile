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
export const normGtin = (g) => (g == null ? null : String(g).replace(/\D/g, '').replace(/^0+/, '') || null);
export const normMpn = (m) => (m == null ? null : String(m).toUpperCase().replace(/[^A-Z0-9]/g, '') || null);
const gtinOf = (n) => normGtin(n?.gtin13 ?? n?.gtin ?? n?.gtin14 ?? n?.gtin12 ?? n?.gtin8 ?? n?.ean ?? n?.isbn);

// Farben (deutsch/englisch) auf eine gemeinsame Form bringen
const COLOR_MAP = {
  schwarz: 'schwarz', black: 'schwarz', weiss: 'weiss', 'weiß': 'weiss', white: 'weiss', grau: 'grau', grey: 'grau', gray: 'grau',
  anthrazit: 'anthrazit', anthracite: 'anthrazit', blau: 'blau', blue: 'blau', navy: 'navy', marine: 'navy', dunkelblau: 'navy',
  hellblau: 'hellblau', 'light blue': 'hellblau', rot: 'rot', red: 'rot', gruen: 'gruen', 'grün': 'gruen', green: 'gruen',
  oliv: 'oliv', olive: 'oliv', gelb: 'gelb', yellow: 'gelb', orange: 'orange', rosa: 'rosa', pink: 'pink', lila: 'lila',
  violett: 'lila', purple: 'lila', braun: 'braun', brown: 'braun', beige: 'beige', natur: 'natur', natural: 'natur',
  silber: 'silber', silver: 'silber', gold: 'gold', bordeaux: 'bordeaux', burgundy: 'bordeaux', creme: 'creme', cream: 'creme',
  mint: 'mint', petrol: 'petrol', khaki: 'khaki', ecru: 'ecru', midnight: 'navy', graphit: 'graphit', graphite: 'graphit',
};
const COLOR_WORDS = Object.keys(COLOR_MAP).sort((a, b) => b.length - a.length);
export function normColor(c) {
  if (!c) return null;
  const t = String(c).toLowerCase().normalize('NFC');
  for (const w of COLOR_WORDS) if (new RegExp(`(^|[^a-zäöüß])${w}([^a-zäöüß]|$)`).test(t)) return COLOR_MAP[w];
  return t.trim() || null;
}
export function colorsInText(t) {
  const out = new Set();
  const s = String(t || '').toLowerCase();
  for (const w of COLOR_WORDS) if (new RegExp(`(^|[^a-zäöüß])${w}([^a-zäöüß]|$)`).test(s)) out.add(COLOR_MAP[w]);
  return [...out];
}
export const normSize = (z) => (z == null ? null : String(z).toUpperCase().replace(/\s+/g, '').replace(/^GR(ÖSSE|OESSE|\.)?/, '') || null);

function propOf(n, names) {
  for (const k of names) if (n?.[k]) return typeof n[k] === 'object' ? n[k].name || n[k].value : n[k];
  for (const ap of [].concat(n?.additionalProperty || [])) {
    if (names.some((k) => new RegExp(k, 'i').test(String(ap?.name || '')))) return ap.value;
  }
  return null;
}
const colorOfNode = (n) => normColor(propOf(n, ['color', 'colour', 'farbe']));
const sizeOfNode = (n) => normSize(propOf(n, ['size', 'groesse', 'größe', 'grösse']));

const SIZE_KEY = /(size|groesse|größe|grösse|gr$|taille|weite|laenge|länge)/i;
const SIZE_VALUE = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-6]xl|\d{2,3}(\/\d{2,3})?|\d{1,2}(\.5|,5)?|one ?size)$/i;

/** Teile eines Links: Parameter-Werte, Pfad-Abschnitte, Fragment – zerlegt in einzelne Kennungen. */
function urlTokens(href) {
  let u;
  try { u = new URL(href); } catch { return { tokens: [], params: [], text: '' }; }
  const params = [...u.searchParams.entries()];
  const frag = decodeURIComponent(u.hash.replace(/^#/, ''));
  for (const kv of frag.split(/[&;]/)) { const [k, v] = kv.split('='); if (v) params.push([k, v]); }
  const raw = [
    ...params.map(([, v]) => v),
    ...decodeURIComponent(u.pathname).split('/'),
    frag,
  ].filter(Boolean);
  const tokens = new Set();
  for (const r of raw) {
    tokens.add(r.toLowerCase());
    for (const part of r.split(/[-_.,+\s:=]+/)) if (part.length >= 3) tokens.add(part.toLowerCase());
  }
  return { tokens: [...tokens], params, text: decodeURIComponent(`${u.pathname} ${u.search} ${u.hash}`).toLowerCase() };
}

const normUrl = (h) => {
  try { const u = new URL(h); u.hash = ''; [...u.searchParams.keys()].filter((k) => /^(utm_|gclid|fbclid|ref|srsltid)/i.test(k)).forEach((k) => u.searchParams.delete(k)); return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') + u.search).toLowerCase(); } catch { return ''; }
};

/**
 * Welche Variante meint der Link? Prüft (1) exakte Varianten-Adresse, (2) EAN/SKU/MPN/IDs im Link,
 * (3) Farbe und Größe im Link. Gibt die Variante nur zurück, wenn sie eindeutig ist.
 */
export function variantFromUrl(entries, href) {
  if (!href || entries.length < 2) return null;
  const unique = (list) => {
    const keys = new Set(list.map((e) => e.gtin || e.ids?.[0] || `${e.color}|${e.size}|${e.price}`));
    return list.length && keys.size === 1 ? list.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  };
  // 1) Exakte Adresse der Variante
  const target = normUrl(href);
  const byUrl = entries.filter((e) => e.offerUrl && normUrl(new URL(e.offerUrl, href).toString()) === target);
  if (byUrl.length && byUrl.length < entries.length) return unique(byUrl); // alle gleich = nicht unterscheidend

  const { tokens, params, text } = urlTokens(href);
  if (!tokens.length) return null;
  const tset = new Set(tokens);
  // 2) Kennungen (EAN, SKU, MPN, Varianten-ID, auch in der Varianten-Adresse)
  const idHit = entries.filter((e) => {
    const ids = [...(e.ids || [])];
    if (e.gtin) ids.push(e.gtin, e.gtin.padStart(13, '0'), e.gtin.padStart(14, '0'));
    if (e.offerUrl) {
      try {
        const ou = new URL(e.offerUrl, href);
        for (const [, v] of ou.searchParams.entries()) ids.push(v);
        const last = ou.pathname.split('/').filter(Boolean).pop();
        if (last && normUrl(ou.toString()) !== normUrl(href.split('?')[0])) ids.push(last);
      } catch {}
    }
    return ids.some((id) => {
      const x = String(id).toLowerCase().replace(/^.*[#/]/, '');
      return x.length >= 3 && tset.has(x);
    });
  });
  if (idHit.length && idHit.length < entries.length) {
    const u = unique(idHit);
    if (u) return u;
  }

  // 3) Farbe/Größe im Link
  const colors = colorsInText(text);
  const sizesFromParams = params.filter(([k, v]) => SIZE_KEY.test(k) && v).map(([, v]) => normSize(v));
  const sizesFromPath = tokens.filter((t) => SIZE_VALUE.test(t) && /(gr|size|groesse|größe)[-_]?/.test(text)).map(normSize);
  const sizes = [...new Set([...sizesFromParams, ...sizesFromPath])];
  if (!colors.length && !sizes.length) return null;
  let list = entries;
  if (colors.length && entries.some((e) => e.color)) list = list.filter((e) => colors.includes(e.color));
  if (sizes.length && entries.some((e) => e.size)) list = list.filter((e) => sizes.includes(normSize(e.size)));
  return list.length < entries.length ? unique(list) : null;
}

// ---------- Varianten aus Shop-Systemen (Shopify, WooCommerce, Auswahlfelder) ----------

const COLOR_OPT = /(farb|colou?r|couleur|kleur)/i;
const SIZE_OPT = /(größe|groesse|grösse|size|taille|maat|gr\.?$|weite|länge|laenge)/i;

/** Teilt eine Varianten-Bezeichnung wie „Black / M“ in Farbe und Größe. */
function splitVariantTitle(t) {
  let color = null, size = null;
  for (const part of String(t || '').split(/\s*[/|,]\s*|\s+-\s+/)) {
    const p = part.trim();
    if (!p) continue;
    if (!color && colorsInText(p).length) color = p;
    else if (!size && SIZE_VALUE.test(p.replace(/^(gr\.?|größe|size)\s*/i, ''))) size = p.replace(/^(gr\.?|größe|size)\s*/i, '');
  }
  return { color, size };
}

/** WooCommerce: data-product_variations="[...]" */
function wooVariants(html, url) {
  const m = html.match(/data-product_variations\s*=\s*"([^"]*)"/) || html.match(/data-product_variations\s*=\s*'([^']*)'/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(decodeEntities(m[1])); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => {
    const attrs = v.attributes || {};
    const ck = Object.keys(attrs).find((k) => COLOR_OPT.test(k));
    const sk = Object.keys(attrs).find((k) => SIZE_OPT.test(k.replace(/^attribute_(pa_)?/, '')));
    let vurl = null;
    try { const u = new URL(url); for (const [k, val] of Object.entries(attrs)) if (val) u.searchParams.set(k, val); vurl = u.toString(); } catch {}
    return {
      color: ck ? attrs[ck] : null, size: sk ? attrs[sk] : null,
      price: parsePrice(v.display_price ?? v.price), gtin: v.gtin || v._gtin || v.ean || v.global_unique_id || null,
      sku: v.sku || null, id: v.variation_id ? String(v.variation_id) : null, url: vurl,
      available: v.is_in_stock !== false,
    };
  }).filter((v) => v.price != null);
}

/** Shopify: Varianten aus „var meta = {...}“ (auf jeder Produktseite) */
function shopifyMetaVariants(html, url) {
  const m = html.match(/var meta\s*=\s*(\{"product"[\s\S]*?\});\s*(?:\n|for|window|var)/);
  if (!m) return [];
  let j;
  try { j = JSON.parse(m[1]); } catch { return []; }
  const base = (() => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url; } })();
  return (j.product?.variants || []).map((v) => ({
    ...splitVariantTitle(v.public_title || v.name),
    price: Number.isFinite(v.price) ? v.price / 100 : parsePrice(v.price),
    gtin: null, sku: v.sku || null, id: v.id ? String(v.id) : null, url: v.id ? `${base}?variant=${v.id}` : null, available: true,
  })).filter((v) => v.price != null);
}

/** Shopify: Adresse der Produktdaten (/products/<handle>.json) – enthält EAN (barcode) je Variante. */
export function shopifyJsonUrl(html, url) {
  if (!/cdn\.shopify\.com|Shopify\.shop|shopify-section/i.test(html)) return null;
  try {
    const u = new URL(url);
    const handle = u.pathname.match(/\/products\/([^/?#.]+)/)?.[1];
    return handle ? `${u.origin}/products/${handle}.json` : null;
  } catch { return null; }
}

export function parseShopifyJson(j, url) {
  const p = j?.product;
  if (!p?.variants) return [];
  const opts = (p.options || []).map((o) => o.name || '');
  const ci = opts.findIndex((n) => COLOR_OPT.test(n));
  const si = opts.findIndex((n) => SIZE_OPT.test(n));
  const base = (() => { try { const u = new URL(url); return `${u.origin}/products/${p.handle}`; } catch { return url; } })();
  return p.variants.map((v) => {
    const o = [v.option1, v.option2, v.option3];
    const guess = splitVariantTitle(v.title);
    return {
      color: ci >= 0 ? o[ci] : guess.color, size: si >= 0 ? o[si] : guess.size,
      price: parsePrice(v.price), oldPrice: parsePrice(v.compare_at_price), gtin: v.barcode || null,
      sku: v.sku || null, id: v.id ? String(v.id) : null, url: v.id ? `${base}?variant=${v.id}` : null, available: v.available !== false,
    };
  }).filter((v) => v.price != null);
}

/** Allgemein: <select>-Felder für Farbe/Größe (nur Auswahlwerte, ohne Preise je Variante). */
export function selectOptions(html) {
  const out = { colors: [], sizes: [] };
  const re = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const kind = COLOR_OPT.test(attrs) ? 'colors' : SIZE_OPT.test(attrs) ? 'sizes' : null;
    if (!kind) continue;
    const opts = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
      .map(([, a, t]) => ({ value: (a.match(/value\s*=\s*["']([^"']*)["']/i) || [])[1], text: htmlToText(t) }))
      .filter((o) => o.value && o.text && !/bitte|wählen|waehlen|choose|select|auswahl/i.test(o.text))
      .map((o) => o.text.replace(/\s*[-–(].*(ausverkauft|nicht verfügbar|sold out).*$/i, '').trim());
    out[kind].push(...opts);
  }
  out.colors = [...new Set(out.colors)].slice(0, 40);
  out.sizes = [...new Set(out.sizes)].slice(0, 40);
  return out;
}

const LISTING_TYPES = ['ItemList', 'CollectionPage', 'SearchResultsPage', 'OfferCatalog'];
const LISTING_URL = /(\/search|\/suche|\/s\?|[?&](q|query|search|searchterm|keyword|k)=|\/kategorie|\/category|\/categories|\/c\/|\/collections\/[^/]+\/?(\?|$)|\/marke\/|\/brand\/|\/angebote\/?(\?|$)|\/sale\/?(\?|$))/i;

/**
 * Hauptfunktion: alles Relevante aus einer Produktseite.
 * want = { gtin, mpn }: gesuchter Artikel – bei Seiten mit Varianten (Größe/Farbe)
 * wird genau diese Variante gewählt.
 */
export function extractOffer(html, url, settings = {}, want = {}, extra = {}) {
  const text = htmlToText(html);
  const ld = extractJsonLd(html);

  // Alle Produkte der Seite sammeln (inkl. Varianten von ProductGroups)
  const products = [];
  let listing = false;
  for (const root of ld) {
    for (const n of walk(root)) {
      if (LISTING_TYPES.some((t) => isType(n, t)) && JSON.stringify(n.itemListElement || n.mainEntity || '').includes('Product')) listing = true;
      if (isType(n, 'Product') || isType(n, 'ProductGroup')) products.push(n);
    }
  }
  // Mehrere verschiedene Produkte ohne gemeinsame Produktgruppe = Liste/Kategorie
  const groupIds = new Set(products.map((p) => p.productGroupID || p.inProductGroupWithID || (isType(p, 'ProductGroup') ? 'G' : null)).filter(Boolean));
  const names = new Set(products.map((p) => String(p.name || '').toLowerCase().trim()).filter(Boolean));
  if (names.size > 3 && groupIds.size === 0) listing = true;
  try { if (LISTING_URL.test(new URL(url).pathname + new URL(url).search)) listing = listing || products.length !== 1; } catch {}

  // Kandidaten: jede Kombination aus Produkt(-variante) und Angebot
  let entries = [];
  for (const p of products) {
    for (const o of offerFromLd(p.offers)) {
      entries.push({
        product: p, ...o, gtin: gtinOf(o.raw) || gtinOf(p), mpn: normMpn(o.raw?.mpn || p.mpn), offerUrl: o.raw?.url || p.url || null,
        color: colorOfNode(o.raw?.itemOffered) || colorOfNode(p), size: sizeOfNode(o.raw?.itemOffered) || sizeOfNode(p),
        ids: [o.raw?.sku, p.sku, o.raw?.mpn, p.mpn, p.productID, o.raw?.productID, p['@id'], o.raw?.['@id'], o.raw?.serialNumber]
          .filter(Boolean).map((x) => String(x)),
      });
    }
  }
  // Varianten aus dem Shop-System ergänzen, wenn die Produktdaten selbst keine Farbe/Größe nennen
  const plat = (extra.variants?.length ? extra.variants : null) || wooVariants(html, url).concat(shopifyMetaVariants(html, url));
  if (plat.length > 1 && !entries.some((e) => e.color || e.size)) {
    const baseP = products.find((p) => isType(p, 'Product')) || products[0] || { name: null };
    const baseRaw = entries[0]?.raw || {};
    const baseCur = entries[0]?.currency || 'EUR';
    const seen = new Set();
    entries = plat.filter((v) => { const k = v.id || `${v.color}|${v.size}`; if (seen.has(k)) return false; seen.add(k); return true; }).map((v) => ({
      product: baseP, price: v.price, oldPrice: v.oldPrice && v.oldPrice > v.price ? v.oldPrice : null, currency: baseCur,
      raw: { ...baseRaw, availability: v.available === false ? 'OutOfStock' : baseRaw.availability },
      gtin: normGtin(v.gtin), mpn: null, offerUrl: v.url, color: normColor(v.color), size: normSize(v.size),
      ids: [v.sku, v.id].filter(Boolean).map(String),
    }));
    if (!products.length) products.push(baseP);
  }
  const allGtins = [...new Set(entries.map((e) => e.gtin).concat(products.map(gtinOf)).filter(Boolean))];
  const allMpns = [...new Set(entries.map((e) => e.mpn).concat(products.map((p) => normMpn(p.mpn))).filter(Boolean))];

  let chosen = null;
  let variantFromLink = false;
  const wantGs = new Set([want.gtin, ...(want.gtins || [])].map(normGtin).filter(Boolean));
  const wantG = wantGs.size ? [...wantGs][0] : null, wantM = normMpn(want.mpn);
  if (wantG) chosen = entries.filter((e) => wantGs.has(e.gtin)).reduce((a, b) => (!a || b.price < a.price ? b : a), null);
  if (!chosen && wantM && !wantG) chosen = entries.find((e) => e.mpn === wantM) || null;
  // Ohne passende EAN: Variante über Farbe/Größe wählen
  const wantC = normColor(want.color), wantS = normSize(want.size);
  if (!chosen && (wantC || wantS) && entries.some((e) => e.color || e.size)) {
    chosen = entries.find((e) => (!wantC || e.color === wantC) && (!wantS || e.size === wantS)) || null;
  }
  const noIdMatch = !chosen && (wantG || wantM);
  if (!chosen && (!wantG && !wantM || noIdMatch)) {
    // Variante aus dem Link erkennen (Adresse, Kennungen, Farbe/Größe im Link)
    chosen = variantFromUrl(entries, want.hintUrl || url);
    variantFromLink = !!chosen;
    if (!chosen && entries.length) {
      const fams = new Set(entries.map((e) => e.product));
      chosen = fams.size === 1 ? entries.reduce((a, b) => (b.price < a.price ? b : a)) : entries[0];
    }
  }
  const product = chosen?.product || products.find((p) => isType(p, 'Product')) || null;
  const ambiguousVariant = !wantG && !wantM && !variantFromLink && !(wantC || wantS)
    && new Set(entries.map((e) => e.gtin || e.mpn || `${e.color}|${e.size}`)).size > 1;

  const title = decodeEntities(
    String(product?.name || meta(html, ['og:title', 'twitter:title']) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
  ).replace(/\s+/g, ' ').trim();

  let price = null, oldPrice = null, currency = 'EUR', raw = null;
  if (chosen) {
    ({ price, oldPrice, raw } = chosen);
    currency = chosen.currency || 'EUR';
  } else if (!products.length && !wantG && !wantM) {
    // Seiten ohne strukturierte Daten: nur Meta-Angaben (kein Variantenabgleich möglich)
    price = parsePrice(meta(html, ['product:price:amount', 'og:price:amount', 'price']));
    currency = meta(html, ['product:price:currency', 'og:price:currency', 'priceCurrency']) || 'EUR';
    if (price == null) {
      const ip = html.match(/itemprop\s*=\s*["']price["'][^>]*content\s*=\s*["']([^"']+)["']/i)
        || html.match(/content\s*=\s*["']([^"']+)["'][^>]*itemprop\s*=\s*["']price["']/i);
      price = parsePrice(ip?.[1]);
    }
  }
  // Kein strukturierter Treffer, aber Seite hat Preis über Meta-Angaben
  if (!chosen && price == null && products.length === 0) {
    price = parsePrice(meta(html, ['product:price:amount', 'og:price:amount', 'price']));
  }
  const chosenGtin = chosen?.gtin || (products.length === 1 ? gtinOf(products[0]) : null);
  const chosenMpn = chosen?.mpn || (products.length === 1 ? normMpn(products[0].mpn) : null);

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

  const sellerName = first(raw?.seller)?.name || null;
  let offerUrl = url;
  try { if (chosen?.offerUrl && new URL(chosen.offerUrl, url).hostname === new URL(url).hostname) offerUrl = new URL(chosen.offerUrl, url).toString(); } catch {}

  return {
    url: offerUrl,
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
    gtin: chosenGtin,
    gtins: allGtins,
    color: chosen?.color || colorOfNode(product) || null,
    colors: [...new Set(entries.map((e) => e.color).filter(Boolean))],
    size: chosen?.size || sizeOfNode(product) || null,
    sizes: [...new Set(entries.map((e) => e.size).filter(Boolean))],
    optionLists: selectOptions(html),
    // Alle Varianten der Seite (für die Auswahl von Farbe/Größe in der App)
    variants: entries.filter((e) => e.color || e.size).slice(0, 80).map((e) => ({
      gtin: e.gtin || null, color: e.color || null, size: e.size || null, price: e.price,
      available: !/OutOfStock|SoldOut|Discontinued/i.test(String(e.raw?.availability || '')),
    })),
    mpn: chosenMpn,
    mpns: allMpns,
    isListing: listing,
    ambiguousVariant,
    brand: first(product?.brand)?.name || (typeof product?.brand === 'string' ? product.brand : null)
      || first(product?.manufacturer)?.name || (typeof product?.manufacturer === 'string' ? product.manufacturer : null),
    siteName: meta(html, ['og:site_name', 'application-name']) || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').split(/\s[|–-]\s/).pop()?.trim() || null,
    sellerName,
    coupons: extractCoupons(text),
    hasStructuredData: !!product,
  };
}
