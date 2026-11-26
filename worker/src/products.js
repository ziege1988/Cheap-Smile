// Prüft ein Produkt: neue Shops suchen, bekannte Angebote aktualisieren,
// Shops verifizieren, Bestpreis + Historie fortschreiben, Alarme auswerten.

import { MAX_CANDIDATES, SEARCH_INTERVAL_HOURS, PRICE_INTERVAL_HOURS } from './config.js';
import { fetchText, domainOf, matchScore, nameFromUrl, tokens, BudgetExceeded, HOUR, DAY } from './util.js';
import { extractOffer, normGtin, normMpn, normColor, normSize, colorsInText, shopifyJsonUrl, parseShopifyJson } from './extract.js';
import { getShopVerdict } from './shopcheck.js';
import { searchCandidates } from './search.js';
import { amazonSearch, AMAZON_DOMAIN, asinOf, isAmazonShortLink, resolveAmazonShortLink } from './amazon.js';
import { applyOfferRules, recordHistory, evaluateAlerts, bestOffer, effectiveTotal } from './deal.js';


function shopSummary(v) {
  return {
    trustScore: v.trustpilot?.score ?? null,
    trustCount: v.trustpilot?.count ?? null,
    allowlisted: !!v.allowlisted,
    country: v.impressum?.country ?? null,
    withdrawalDays: v.returns?.days ?? null,
    notes: v.notes || [],
    verified: (v.notes || []).some((n) => /bestätigt/.test(n)),
    trustUnknown: !!v.strict,
    trustSource: v.trustpilot?.source || null,
    checks: {
      impressum: !!v.impressum?.complete,
      register: !!v.impressum?.register,
      withdrawal: !!v.returns?.hasWithdrawal,
      withdrawalDays: v.returns?.days ?? null,
      country: v.impressum?.country ?? null,
      ageYears: v.ageDays != null ? Math.floor(v.ageDays / 365) : null,
    },
  };
}

/** Adresse ohne Parameter – zum Wiedererkennen vom Nutzer aussortierter Angebote. */
export const offerKey = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).toLowerCase(); } catch { return String(u); } };
export const isRejected = (product, url) => (product.rejected || []).includes(offerKey(url));

/** Vorübergehender Ausschluss (z. B. Seite/Trustpilot nicht erreichbar)? */
export const isTemporary = (e) => !!e.retryable || (e.reasons || []).some((r) => /nicht erreichbar/.test(r));

function excludeDomain(product, domain, reasons, url, retryable = false) {
  product.excluded = (product.excluded || []).filter((e) => e.domain !== domain);
  product.excluded.push({ domain, url, reasons: [].concat(reasons), at: Date.now(), retryable: !!retryable });
  product.offers = (product.offers || []).filter((o) => o.domain !== domain);
}

/** Eindeutige Kennung des gesuchten Artikels (vom eigenen Link übernommen). */
export const identityOf = (p) => ({ gtin: p.gtin || null, gtins: p.gtins || [], mpn: p.mpn || null, color: p.color || null, size: p.size || null });

const COLOR_TOKENS = new Set(['schwarz', 'black', 'weiss', 'white', 'grau', 'grey', 'gray', 'blau', 'blue', 'navy', 'rot', 'red', 'gruen', 'green', 'beige', 'braun', 'brown', 'rosa', 'pink', 'natur']);
/** Name ohne Farb-/Größenangaben – diese werden separat verglichen. */
function coreName(name) {
  return String(name || '').split(/[,|/()]+/).join(' ')
    .split(/\s+/).filter((w) => !COLOR_TOKENS.has(w.toLowerCase()) && !/^(gr\.?|größe|size|xx?[sl]|[sml]|\d{2,3}(\/\d{2,3})?)$/i.test(w)).join(' ');
}

/**
 * Ist das Angebot exakt derselbe Artikel?
 * 1. EAN/GTIN vorhanden auf beiden Seiten: muss übereinstimmen (inkl. Variante).
 * 2. Herstellernummer (MPN) auf beiden Seiten: muss übereinstimmen.
 * 3. Sonst Merkmale: Marke, Produktbezeichnung (inkl. Modellnummer), Farbe und Größe.
 */
// Wörter, die einen anderen Artikel kennzeichnen, wenn sie nur auf einer Seite vorkommen
const DISTINCT_WORDS = [
  ['kinder', 'kids', 'kind', 'baby', 'babys', 'junior', 'jungen', 'maedchen', 'madchen', 'toddler'],
  ['damen', 'frauen', 'women', 'woman', 'ladies'],
  ['herren', 'maenner', 'manner', 'men', 'mens'],
  ['set', 'pack', 'paket', 'bundle', '2er', '3er', '4er', '5er', '6er', '10er', 'doppelpack', 'multipack'],
  ['mini'], ['max'], ['pro'], ['plus'], ['lite'], ['ultra'], ['xl'], ['refill', 'nachfuellung', 'nachfullung', 'ersatz'],
];
const GENERIC_TOKENS = new Set(['aus', 'fur', 'mit', 'und', 'oder', 'von', 'zum', 'zur', 'the', 'neu', 'original', 'premium', 'top', 'qualitat', 'hochwertig']);

/** Aussagekräftige Wörter der Bezeichnung (ohne Marke, Farbe, Größe, Füllwörter). */
function keyTokens(name, brand) {
  const b = new Set(tokens(brand || ''));
  return tokens(coreName(name)).filter((t) => t.length >= 3 && !b.has(t) && !GENERIC_TOKENS.has(t));
}

/**
 * Ist das Angebot exakt derselbe Artikel?
 * 1. EAN/GTIN vorhanden auf beiden Seiten: muss übereinstimmen (inkl. Variante).
 * 2. Herstellernummer (MPN) auf beiden Seiten: muss übereinstimmen.
 * 3. Sonst Merkmale: Marke (Pflicht), aussagekräftige Bezeichnung, unterscheidende Wörter, Farbe, Größe.
 */
export function sameArticle(product, ex) {
  if (ex.isListing) return { ok: false, why: 'Listen-/Kategorieseite statt Produktseite' };
  const gs = new Set([product.gtin, ...(product.gtins || [])].map(normGtin).filter(Boolean));
  const exG = normGtin(ex.gtin);
  if (gs.size && exG) return gs.has(exG) ? { ok: true, by: 'EAN' } : { ok: false, why: 'Andere EAN (anderer Artikel oder andere Variante)' };
  const m = normMpn(product.mpn), exM = normMpn(ex.mpn);
  if (m && exM) return m === exM ? { ok: true, by: 'Herstellernummer' } : { ok: false, why: 'Andere Herstellernummer' };

  // Merkmale
  const fromLink = !!product.sourceUrl;
  const b1 = String(product.brand || '').toLowerCase().trim(), b2 = String(ex.brand || '').toLowerCase().trim();
  // Ohne bekannte Marke nur, wenn die Bezeichnung eine Modellnummer enthält (z. B. „WH-1000XM5“)
  const hasModel = keyTokens(product.name, product.brand).some((k) => /\d/.test(k) && /[a-z]/.test(k));
  if (fromLink && !b1 && !hasModel) return { ok: false, why: 'Marke des Artikels unbekannt – Abgleich nur über EAN/Artikelnummer möglich' };
  if (b1 && b2 && !b1.includes(b2) && !b2.includes(b1)) return { ok: false, why: `Andere Marke (${ex.brand})` };
  if (b1 && !b2 && !tokens(ex.title).includes(tokens(b1)[0])) return { ok: false, why: 'Marke nicht im Titel' };

  // Zubehör („Hülle für …“) oder abweichende Modellnummer
  if (matchScore(coreName(product.name), ex.title) === 0) return { ok: false, why: 'Zubehör oder anderes Modell' };
  const keys = keyTokens(product.name, product.brand);
  if (keys.length < 2) return { ok: false, why: `Bezeichnung „${product.name}“ zu allgemein – nur Abgleich über EAN/Artikelnummer` };
  const exTok = new Set(tokens(`${ex.title}`));
  const hit = keys.filter((k) => exTok.has(k)).length;
  const score = hit / keys.length;
  const modelOk = keys.filter((k) => /\d/.test(k)).every((k) => exTok.has(k));
  if (!modelOk || score < (fromLink && b1 ? 0.8 : 1)) return { ok: false, why: `Bezeichnung weicht ab (${Math.round(score * 100)} % gleich)` };
  const refTok = new Set(tokens(product.name));
  for (const group of DISTINCT_WORDS) {
    const inRef = group.some((w) => refTok.has(w));
    const inEx = group.some((w) => exTok.has(w));
    if (inRef !== inEx) return { ok: false, why: `Anderer Artikel („${group.find((w) => (inEx ? exTok : refTok).has(w))}“ nur auf einer Seite)` };
  }

  const notes = [];
  const refC = normColor(product.color) || (fromLink ? null : colorsInText(product.name)[0]);
  if (refC) {
    const exC = normColor(ex.color);
    const exAll = new Set([exC, ...(ex.colors || []), ...colorsInText(`${ex.title} ${ex.url}`)].filter(Boolean));
    if (exC && exC !== refC && !exAll.has(refC)) return { ok: false, why: `Andere Farbe (${ex.color})` };
    if (!exAll.size) notes.push('Farbe im Shop prüfen');
    else if (!exAll.has(refC)) return { ok: false, why: 'Farbe nicht erhältlich' };
  }
  const refS = normSize(product.size);
  if (refS) {
    const sizes = new Set([normSize(ex.size), ...(ex.sizes || []).map(normSize)].filter(Boolean));
    if (sizes.size && !sizes.has(refS)) return { ok: false, why: `Größe ${product.size} nicht erhältlich` };
    if (!sizes.size) notes.push(`Größe ${product.size} im Shop wählen`);
  }
  return { ok: true, by: 'Bezeichnung & Merkmale', note: notes.join(', ') || null };
}

/**
 * Farbe/Größe als Suchkriterium setzen. Gibt es zur Auswahl eine eigene EAN, wird genau diese verglichen,
 * sonst über die Merkmale. Leere Auswahl = alle Varianten zulassen.
 */
export function applyVariantChoice(product, color, size) {
  const c = color ? String(color).trim().slice(0, 40) : null;
  const z = size ? String(size).trim().slice(0, 20) : null;
  product.color = c;
  product.size = z;
  product.userVariant = !!(c || z);
  const variants = product.variants || [];
  const fits = variants.filter((v) => (!c || v.color === normColor(c)) && (!z || normSize(v.size) === normSize(z)));
  const withGtin = fits.filter((v) => v.gtin);
  if (!c && !z) {
    product.gtin = null;
    product.gtins = [...new Set(variants.map((v) => v.gtin).filter(Boolean))];
    product.variantHint = product.gtins.length ? 'Alle Varianten werden verglichen.' : null;
  } else if (withGtin.length === 1 || (withGtin.length && c && z)) {
    product.gtin = withGtin[0].gtin;
    product.gtins = [];
    product.variantHint = null;
  } else if (withGtin.length > 1) {
    product.gtin = null;
    product.gtins = withGtin.map((v) => v.gtin); // z. B. nur Farbe gewählt: alle Größen dieser Farbe
    product.variantHint = null;
  } else {
    product.gtin = null;
    product.gtins = [];
    product.variantHint = variants.length ? 'Diese Kombination gibt es im Shop-Link nicht – Abgleich über Bezeichnung, Farbe und Größe.' : null;
  }
}

/** Lädt eine Produktseite und baut daraus ein Angebot (ohne Shop-Prüfung).
 *  deep=true (eigener Link): bei Shopify zusätzlich die Produktdaten mit allen Varianten laden. */
async function loadOffer(fetcher, url, settings, want = {}, { deep = false } = {}) {
  const page = await fetchText(fetcher, url);
  if (!page.ok) {
    const blocked = [401, 403, 429, 503].includes(page.status);
    return { error: blocked ? `Shop blockiert automatische Abrufe (HTTP ${page.status})` : `Seite nicht erreichbar (HTTP ${page.status || 'Fehler'})` };
  }
  let extra = {};
  const sj = deep && page.ok ? shopifyJsonUrl(page.text, page.url || url) : null;
  if (sj) {
    const r = await fetchText(fetcher, sj, { maxBytes: 600_000, init: { headers: { Accept: 'application/json' } } });
    if (r.ok) { try { extra = { variants: parseShopifyJson(JSON.parse(r.text), page.url || url) }; } catch {} }
  }
  const ex = extractOffer(page.text, page.url || url, settings, { ...want, hintUrl: url }, extra);
  if (ex.isListing) return { error: 'Listen-/Kategorieseite statt Produktseite', ex, html: page.text };
  if (ex.price == null) return { error: 'Kein Preis erkennbar (Variante fehlt oder Seite ohne Produktdaten)', ex, html: page.text };
  return { ex, html: page.text };
}

async function considerCandidate(env, product, fetcher, settings, url, { manual = false } = {}) {
  const domain = domainOf(url);
  if (!domain) return;
  const skip = (why) => {
    if (manual) return;
    product.skipped = (product.skipped || []).filter((x) => x.domain !== domain);
    product.skipped.push({ domain, url, why, at: Date.now() });
  };
  if (!manual && isRejected(product, url)) { skip('Von dir als falscher Artikel markiert'); return; }
  const { ex, error, html } = await loadOffer(fetcher, url, settings, identityOf(product), { deep: manual });
  if (error) {
    if (manual) {
      product.lastError = `Eigener Link: ${error}`;
      const slug = nameFromUrl(url);
      if (product.nameFromUrl && slug) {
        product.name = slug;
        product.nameFromUrl = false;
        product.nameFromSlug = true; // vorläufig – wird ersetzt, sobald die Seite lesbar ist
      }
    }
    skip(error);
    return;
  }
  if (manual) {
    // Varianten-Auswahl (Farbe/Größe) für die App merken
    rememberOptions(product, ex);
    // Eigener Link legt fest, welcher Artikel (inkl. Variante) gesucht ist
    if (!product.gtin && !product.gtins?.length && !product.mpn) {
      product.mpn = ex.mpn || null;
      product.brand = ex.brand || guessBrand(ex, domain);
      if (product.userVariant) {
        // Farbe/Größe vom Nutzer vorgegeben: passende Variante festlegen
        applyVariantChoice(product, product.color, product.size);
        if (!product.variants?.length && ex.gtin) product.gtin = ex.gtin; // Seite ohne Varianten = genau dieser Artikel
      } else if (ex.ambiguousVariant && ex.gtins.length > 1) {
        product.gtins = ex.gtins; // Variante nicht eindeutig: alle Varianten dieses Artikels zulassen
        product.variantHint = 'Farbe/Größe im Link nicht eindeutig – alle Varianten werden verglichen. In den Details kannst du eine Variante wählen.';
      } else {
        product.gtin = ex.gtin || null;
        product.color = ex.color || colorsInText(ex.title)[0] || null;
        product.size = ex.size || null;
      }
    }
  }
  const match = manual ? { ok: true, by: 'eigener Link' } : sameArticle(product, ex);
  if (!match.ok) { skip(match.why); return; } // nicht exakt derselbe Artikel
  // Produktname und Bild sofort übernehmen – auch wenn der Shop danach ausgeschlossen wird,
  // damit die Suche nach weiteren Shops mit dem echten Produktnamen läuft.
  if (manual && (product.nameFromUrl || product.nameFromSlug) && ex.title) {
    product.name = ex.title.replace(/\s+[|–-]\s+[^|–]*$/, '').slice(0, 120) || ex.title;
    product.nameFromUrl = false;
    product.nameFromSlug = false;
  }
  if (manual && !product.image && ex.image) product.image = ex.image;

  const verdict = await getShopVerdict(env, domain, fetcher, settings, { pageHtml: html, pageUrl: ex.url });
  if (!verdict.ok) { excludeDomain(product, domain, verdict.reasons, url, verdict.retryable); return; }
  product.skipped = (product.skipped || []).filter((x) => x.domain !== domain);
  if (!product.image && ex.image) product.image = ex.image;

  const offer = {
    url: ex.url, domain, shopName: verdict.trustpilot?.name || domain,
    title: ex.title, price: ex.price, shipping: ex.shipping, shippingEstimated: ex.shippingEstimated,
    freeShippingFrom: ex.freeShippingFrom, total: ex.total, currency: ex.currency,
    oldPrice: ex.oldPrice, discountPct: ex.discountPct, condition: ex.condition, available: ex.available,
    coupons: ex.coupons, returnCost: verdict.returns?.returnCost ?? null, seller: ex.sellerName,
    shop: shopSummary(verdict), manual, matchedBy: match.by, matchNote: match.note || null, fails: 0, checkedAt: Date.now(), firstSeen: Date.now(),
  };
  product.excluded = (product.excluded || []).filter((e) => e.domain !== domain);
  product.offers = (product.offers || []).filter((o) => o.domain !== domain);
  product.offers.push(offer);
}

/** Auswahlmöglichkeiten (Farbe/Größe) vom eigenen Shop-Link merken. */
/** Marke aus Seitentitel/Seitenname ableiten, wenn sie zur Domain passt (Herstellershop, z. B. „… | Dilling“ auf dilling.de). */
export function guessBrand(ex, domain) {
  const label = String(domain || '').split('.').slice(-2, -1)[0] || '';
  const site = String(ex.siteName || '');
  if (label.length >= 3 && site.toLowerCase().replace(/[^a-z0-9]/g, '').includes(label.replace(/[^a-z0-9]/g, ''))) return site.replace(/\s*(shop|online-?shop|store|gmbh|ag|official|offizieller.*)$/i, '').trim() || null;
  if (label.length >= 3 && tokens(ex.title).includes(label)) return label.charAt(0).toUpperCase() + label.slice(1);
  return null;
}

function rememberOptions(product, ex) {
  if (ex.variants?.length) product.variants = ex.variants;
  const ol = ex.optionLists || {};
  if (ol.colors?.length || ol.sizes?.length) product.optionLists = { colors: ol.colors || [], sizes: ol.sizes || [] };
}

async function refreshOffer(env, product, fetcher, settings, o) {
  const { ex, error } = await loadOffer(fetcher, o.url, settings, identityOf(product), { deep: !!o.manual });
  if (o.manual && ex) {
    rememberOptions(product, ex);
    if (!product.brand) product.brand = ex.brand || guessBrand(ex, o.domain);
  }
  o.checkedAt = Date.now();
  if (error) {
    // Liste statt Produktseite / falsche Variante: Angebot sofort entfernen
    if (!o.manual && ex && (ex.isListing || !sameArticle(product, ex).ok)) { o.remove = true; return; }
    o.fails = (o.fails || 0) + 1;
    if (o.fails >= 3) o.stale = true;
    return;
  }
  const m = o.manual ? { ok: true, by: 'eigener Link' } : sameArticle(product, ex);
  if (!m.ok) { o.remove = true; return; }
  o.matchedBy = m.by; o.matchNote = m.note || null;
  // Shop-Urteil kann inzwischen abgelaufen sein -> erneut (gecacht) prüfen
  const verdict = await getShopVerdict(env, o.domain, fetcher, settings);
  if (!verdict.ok) { excludeDomain(product, o.domain, verdict.reasons, o.url); return; }
  Object.assign(o, {
    url: ex.url && domainOf(ex.url) === o.domain ? ex.url : o.url, // z. B. Link zur gewählten Variante
    title: ex.title || o.title, price: ex.price, shipping: ex.shipping, shippingEstimated: ex.shippingEstimated,
    freeShippingFrom: ex.freeShippingFrom, total: ex.total, currency: ex.currency, oldPrice: ex.oldPrice,
    discountPct: ex.discountPct, condition: ex.condition, available: ex.available, coupons: ex.coupons, seller: ex.sellerName,
    returnCost: verdict.returns?.returnCost ?? null, shop: shopSummary(verdict), fails: 0, stale: false,
  });
}

const AMAZON_INTERVAL_HOURS = 24;
const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL'];
/** Größen sinnvoll sortieren: XS < S < M … bzw. numerisch. */
function sortSizes(list) {
  const rank = (z) => { const u = String(z).toUpperCase(); const i = SIZE_ORDER.indexOf(u); return i >= 0 ? i : 100 + (parseFloat(u.replace(',', '.')) || 999); };
  return [...list].sort((a, b) => rank(a) - rank(b));
}
const isShortName = (n) => /^(amzn\.(eu|to|com)|a\.co|amazon\.[a-z.]+)$/i.test(String(n || ''));

/** Amazon-Angebot über SerpApi suchen, mit denselben strengen Regeln abgleichen und eintragen. */
async function checkAmazon(env, product, fetcher, settings, { priority }) {
  const existing = product.offers.find((o) => o.source === 'amazon');
  const query = product.asin || product.gtin || product.name;
  let { results, error, quota } = await amazonSearch(fetcher, env, query, { priority });
  // EAN/ASIN liefert nicht immer Treffer -> einmal mit dem Namen nachfassen
  if (!results.length && !quota && query !== product.name && priority && !product.nameFromUrl) {
    ({ results, error, quota } = await amazonSearch(fetcher, env, product.name, { priority }));
  }
  product.amazonError = error || null;
  if (quota) {
    if (existing) existing.quotaStale = true; // letzter Preis bleibt, wird als veraltet markiert
    return;
  }
  product.lastAmazonAt = Date.now();
  let hit = null, match = null, whyNot = null;
  for (const r of results) {
    if (isRejected(product, r.url)) { whyNot ||= 'von dir als falscher Artikel markiert'; continue; }
    const m = product.asin
      ? (r.asin === product.asin ? { ok: true, by: 'ASIN (Amazon-Link)' } : { ok: false, why: 'Andere ASIN' })
      : sameArticle(product, r);
    if (m.ok) { hit = r; match = m; break; }
    whyNot ||= m.why;
  }
  product.offers = product.offers.filter((o) => o.source !== 'amazon');
  product.skipped = (product.skipped || []).filter((x) => x.domain !== AMAZON_DOMAIN);
  if (!hit) {
    if (results.length) product.skipped.push({ domain: AMAZON_DOMAIN, url: results[0].url, why: `Amazon: ${whyNot || 'kein exakt passender Artikel'}`, at: Date.now() });
    else if (!error) product.skipped.push({ domain: AMAZON_DOMAIN, url: `https://www.amazon.de/s?k=${encodeURIComponent(query)}`, why: 'Amazon: nicht gefunden', at: Date.now() });
    return;
  }
  // Amazon-Link: Name, Bild und Marke vom Amazon-Ergebnis übernehmen
  if (product.asin && (product.nameFromUrl || product.nameFromSlug || /^Amazon-Artikel$/.test(product.name) || isShortName(product.name)) && hit.title) {
    product.name = hit.title.split(/\s[-–|]\s|,\s/)[0].slice(0, 120) || hit.title.slice(0, 120);
    product.nameFromUrl = false;
    product.nameFromSlug = false;
    product.lastSearchAt = null; // mit dem echten Namen gleich nach anderen Shops suchen
  }
  if (!product.image && hit.image) product.image = hit.image;

  // Bei Amazon zählen in erster Linie die Produktbewertungen
  let excludedReason;
  if (hit.rating != null && hit.rating < settings.amazonMinRating) excludedReason = `Amazon-Bewertung ${hit.rating.toFixed(1)} ★ (unter ${settings.amazonMinRating})`;
  else if (hit.reviews != null && hit.reviews < settings.amazonMinReviews) excludedReason = `Nur ${hit.reviews} Amazon-Bewertungen (mind. ${settings.amazonMinReviews})`;

  const shipping = hit.shipping ?? settings.fallbackShipping;
  product.offers.push({
    source: 'amazon', url: hit.url, domain: AMAZON_DOMAIN, shopName: 'Amazon.de', title: hit.title,
    price: hit.price, shipping, shippingEstimated: hit.shipping == null || hit.shippingEstimated,
    freeShippingFrom: null, total: Math.round((hit.price + shipping) * 100) / 100, currency: 'EUR',
    oldPrice: hit.oldPrice && hit.oldPrice > hit.price ? hit.oldPrice : null,
    discountPct: hit.oldPrice && hit.oldPrice > hit.price ? Math.round((1 - hit.price / hit.oldPrice) * 100) : null,
    condition: hit.condition, available: hit.available, coupons: [], returnCost: null, seller: null,
    shop: { allowlisted: true, verified: true, amazonRating: hit.rating ?? null, amazonReviews: hit.reviews ?? null, notes: ['Amazon.de – Bewertung nach Produktbewertungen'] },
    manual: false, matchedBy: match.by,
    matchNote: [match.note, hit.rating == null ? 'Keine Amazon-Bewertungen sichtbar' : null].filter(Boolean).join(', ') || null,
    excludedReason,
    fails: 0, checkedAt: Date.now(), firstSeen: existing?.firstSeen || Date.now(), quotaStale: false,
  });
}

/**
 * @param {object} opts { force: alles neu prüfen }
 * @returns alert | null
 */
export async function checkProduct(env, product, fetcher, settings, { force = false } = {}) {
  product.offers ||= [];
  product.excluded ||= [];
  const t = Date.now();
  product.lastError = null;
  product.partial = false;
  // Amazon-Kurzlink, der beim Anlegen nicht aufgelöst werden konnte: erneut versuchen
  if (!product.asin && isAmazonShortLink(product.sourceUrl)) {
    try {
      const resolved = await resolveAmazonShortLink(product.sourceUrl, fetcher);
      if (asinOf(resolved)) product.sourceUrl = resolved;
      else product.amazonError = 'Amazon-Kurzlink ließ sich nicht auflösen – bitte den vollständigen Link (amazon.de/…/dp/…) einfügen';
    } catch { /* nächster Lauf versucht es erneut */ }
  }
  // Ältere Produkte mit Amazon-Link auf die ASIN-Abfrage umstellen
  if (!product.asin && product.sourceUrl && asinOf(product.sourceUrl)) {
    product.asin = asinOf(product.sourceUrl);
    product.includeAmazon = true;
    product.lastAmazonAt = null;
    product.excluded = product.excluded.filter((e) => e.domain !== AMAZON_DOMAIN);
    const slug = nameFromUrl(product.sourceUrl);
    if (slug && (product.nameFromUrl || isShortName(product.name))) { product.name = slug; product.nameFromUrl = false; product.nameFromSlug = true; }
    else if (isShortName(product.name)) product.name = 'Amazon-Artikel';
    product.amazonError = null;
  }
  try {
    // Eigener Link (beim Anlegen angegeben)
    // „Jetzt neu prüfen“ bzw. vorübergehende Fehler: ausgeschlossene Shops erneut bewerten
    if (force) product.excluded = product.excluded.filter((e) => !isTemporary(e));
    const srcDomain = product.sourceUrl && domainOf(product.sourceUrl);
    const srcExcluded = product.excluded.find((e) => e.domain === srcDomain);
    const srcDue = !srcExcluded || force || isTemporary(srcExcluded) || t - srcExcluded.at > DAY;
    // Amazon-Links werden nicht geladen (Amazon blockiert) – der Artikel kommt über die ASIN-Abfrage
    if (product.sourceUrl && !product.asin && !isAmazonShortLink(product.sourceUrl) && !product.offers.some((o) => o.manual) && srcDue) {
      await considerCandidate(env, product, fetcher, settings, product.sourceUrl, { manual: true });
    }

    // Bekannte Angebote aktualisieren (älteste zuerst) – Amazon läuft separat über SerpApi
    const due = product.offers
      .filter((o) => o.source !== 'amazon' && (force || t - (o.checkedAt || 0) > PRICE_INTERVAL_HOURS * HOUR))
      .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0));
    for (const o of due) await refreshOffer(env, product, fetcher, settings, o);
    product.offers = product.offers.filter((o) => !o.remove && (!o.stale || t - o.checkedAt < 7 * DAY));

    // Amazon.de (einmal täglich, nur mit Schalter)
    if (!product.includeAmazon) {
      product.offers = product.offers.filter((o) => o.source !== 'amazon');
    } else if ((!product.nameFromUrl || product.asin) && (force || !product.lastAmazonAt || t - product.lastAmazonAt > AMAZON_INTERVAL_HOURS * HOUR)) {
      await checkAmazon(env, product, fetcher, settings, { priority: force || !product.lastAmazonAt });
    }

    // Neue Shops suchen. Gefundene Seiten landen in einer Warteschlange: bricht ein Lauf ab
    // (max. 40 Abrufe pro Lauf), geht es beim nächsten Lauf dort weiter – ohne neue Google-Suche.
    if (product.nameFromUrl) {
      product.searchError = 'Produktname noch unbekannt – Shop-Link konnte nicht gelesen werden';
    } else {
      if (force) product.queue = [];
      const searchDue = force || !product.lastSearchAt || t - product.lastSearchAt > SEARCH_INTERVAL_HOURS * HOUR;
      if (!product.queue?.length && searchDue) {
        const knownDomains = [
          ...product.offers.map((o) => o.domain),
          ...product.excluded.filter((e) => t - e.at < 7 * DAY && !isTemporary(e)).map((e) => e.domain),
        ];
        const prio = !product.lastSearchAt || force;
        if (prio) product.skipped = [];
        const { candidates, error, source } = await searchCandidates(fetcher, env, product.name, settings, { exclude: knownDomains, priority: prio });
        // Bei bekannter EAN zusätzlich direkt nach der EAN suchen (findet Shops mit anderer Bezeichnung)
        if (prio && product.gtin) {
          const byEan = await searchCandidates(fetcher, env, product.gtin, settings, { exclude: [...knownDomains, ...candidates.map((c) => c.domain)], priority: true, raw: true });
          candidates.push(...byEan.candidates);
        }
        product.searchError = error || null;
        product.searchSource = source || null;
        product.candidatesFound = candidates.length;
        product.queue = candidates.slice(0, MAX_CANDIDATES * 2).map((c) => ({ url: c.url, domain: c.domain, blocked: !!c.blocked }));
        product.lastSearchAt = Date.now(); // sofort merken: kein erneutes Suchen bei Abbruch
      }
      while (product.queue?.length) {
        const c = product.queue[0];
        if (c.blocked) excludeDomain(product, c.domain, ['Auf der Sperrliste'], c.url);
        else if (c.domain === AMAZON_DOMAIN) {
          // Amazon blockiert direkte Abrufe – Preis kommt über die Amazon-Abfrage
          if (!product.includeAmazon) {
            product.skipped = (product.skipped || []).filter((x) => x.domain !== c.domain);
            product.skipped.push({ domain: c.domain, url: c.url, why: 'Amazon-Schalter ist aus', at: Date.now() });
          }
        } else if (!product.offers.some((o) => o.domain === c.domain)) {
          await considerCandidate(env, product, fetcher, settings, c.url); // bei Budget-Ende bleibt c in der Schlange
        }
        product.queue.shift();
        if (product.offers.length >= 15) { product.queue = []; break; }
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) product.lastError = String(e?.message || e);
    else product.partial = true; // Rest beim nächsten Cron-Lauf
  }

  applyOfferRules(product, settings);
  recordHistory(product);
  product.excluded = product.excluded.slice(-40);
  product.lastCheckAt = Date.now();
  const best = bestOffer(product);
  product.best = best ? { domain: best.domain, total: effectiveTotal(best), url: best.url } : null;
  return evaluateAlerts(product, settings);
}

/** Schlanke Darstellung für die Kachel-Übersicht. */
export function toClient(p) {
  const best = bestOffer(p);
  return {
    id: p.id, name: p.name, image: p.image, wishPrice: p.wishPrice, allowUsed: !!p.allowUsed,
    variantHint: p.variantHint || null, gtin: p.gtin || null, mpn: p.mpn || null, brand: p.brand || null,
    color: p.color || null, size: p.size || null, skipped: p.skipped || [], candidatesFound: p.candidatesFound ?? null,
    userVariant: !!p.userVariant,
    variantOptions: {
      colors: [...new Set([...(p.variants || []).map((v) => v.color), ...(p.optionLists?.colors || [])].filter(Boolean))],
      sizes: sortSizes([...new Set([...(p.variants || []).map((v) => v.size), ...(p.optionLists?.sizes || [])].filter(Boolean))]),
      // welche Kombinationen es gibt (für die App: nicht erhältliche ausgrauen)
      combos: (p.variants || []).filter((v) => v.color || v.size).map((v) => ({ c: v.color || null, s: v.size || null, ok: v.available !== false, price: v.price ?? null })),
    },
    includeAmazon: !!p.includeAmazon, amazonError: p.amazonError || null, lastAmazonAt: p.lastAmazonAt || null,
    asin: p.asin || null, queued: (p.queue || []).length, nameFromSlug: !!p.nameFromSlug,
    createdAt: p.createdAt, lastCheckAt: p.lastCheckAt, lastError: p.lastError, searchError: p.searchError, searchSource: p.searchSource,
    best: best ? { ...best, effectiveTotal: effectiveTotal(best) } : null,
    offers: (p.offers || []).map((o) => ({ ...o, effectiveTotal: o.total != null ? effectiveTotal(o) : null })),
    excluded: p.excluded || [],
    history: p.history || [],
    notify: p.notify || {},
    pending: !p.lastCheckAt || (!p.offers?.length && (p.queue || []).length > 0),
  };
}
