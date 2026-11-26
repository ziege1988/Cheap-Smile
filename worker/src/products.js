// Prüft ein Produkt: neue Shops suchen, bekannte Angebote aktualisieren,
// Shops verifizieren, Bestpreis + Historie fortschreiben, Alarme auswerten.

import { MAX_CANDIDATES, SEARCH_INTERVAL_HOURS, PRICE_INTERVAL_HOURS } from './config.js';
import { fetchText, domainOf, matchScore, BudgetExceeded, HOUR, DAY } from './util.js';
import { extractOffer, normGtin, normMpn, normColor, normSize, colorsInText } from './extract.js';
import { getShopVerdict } from './shopcheck.js';
import { searchCandidates } from './search.js';
import { amazonSearch, AMAZON_DOMAIN } from './amazon.js';
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
export function sameArticle(product, ex) {
  if (ex.isListing) return { ok: false, why: 'Listen-/Kategorieseite statt Produktseite' };
  const gs = new Set([product.gtin, ...(product.gtins || [])].map(normGtin).filter(Boolean));
  const exG = normGtin(ex.gtin);
  if (gs.size && exG) return gs.has(exG) ? { ok: true, by: 'EAN' } : { ok: false, why: 'Andere EAN (anderer Artikel oder andere Variante)' };
  const m = normMpn(product.mpn), exM = normMpn(ex.mpn);
  if (m && exM) return m === exM ? { ok: true, by: 'Herstellernummer' } : { ok: false, why: 'Andere Herstellernummer' };

  // Merkmale
  const b1 = String(product.brand || '').toLowerCase().trim(), b2 = String(ex.brand || '').toLowerCase().trim();
  if (b1 && b2 && !b1.includes(b2) && !b2.includes(b1)) return { ok: false, why: `Andere Marke (${ex.brand})` };
  if (b1 && !b2 && !String(ex.title).toLowerCase().includes(b1)) return { ok: false, why: 'Marke nicht im Titel' };
  const fromLink = !!product.sourceUrl;
  const score = matchScore(coreName(product.name), coreName(ex.title));
  if (score < (fromLink ? 0.8 : 1)) return { ok: false, why: `Bezeichnung weicht ab (${Math.round(score * 100)} % gleich)` };

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

/** Lädt eine Produktseite und baut daraus ein Angebot (ohne Shop-Prüfung). */
async function loadOffer(fetcher, url, settings, want = {}) {
  const page = await fetchText(fetcher, url);
  if (!page.ok) {
    const blocked = [401, 403, 429, 503].includes(page.status);
    return { error: blocked ? `Shop blockiert automatische Abrufe (HTTP ${page.status})` : `Seite nicht erreichbar (HTTP ${page.status || 'Fehler'})` };
  }
  const ex = extractOffer(page.text, page.url || url, settings, { ...want, hintUrl: url });
  if (ex.isListing) return { error: 'Listen-/Kategorieseite statt Produktseite', ex, html: page.text };
  if (ex.price == null) return { error: 'Kein Preis erkennbar (Variante fehlt oder Seite ohne Produktdaten)', ex, html: page.text };
  return { ex, html: page.text };
}

async function considerCandidate(env, product, fetcher, settings, url, { manual = false } = {}) {
  const domain = domainOf(url);
  if (!domain) return;
  const { ex, error, html } = await loadOffer(fetcher, url, settings, identityOf(product));
  const skip = (why) => {
    if (manual) return;
    product.skipped = (product.skipped || []).filter((x) => x.domain !== domain);
    product.skipped.push({ domain, url, why, at: Date.now() });
  };
  if (error) {
    if (manual) product.lastError = `Eigener Link: ${error}`;
    skip(error);
    return;
  }
  if (manual) {
    // Varianten-Auswahl (Farbe/Größe) für die App merken
    if (ex.variants?.length) product.variants = ex.variants;
    // Eigener Link legt fest, welcher Artikel (inkl. Variante) gesucht ist
    if (!product.gtin && !product.gtins?.length && !product.mpn) {
      product.mpn = ex.mpn || null;
      product.brand = ex.brand || null;
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
  if (manual && product.nameFromUrl && ex.title) {
    product.name = ex.title.replace(/\s+[|–-]\s+[^|–]*$/, '').slice(0, 120) || ex.title;
    product.nameFromUrl = false;
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

async function refreshOffer(env, product, fetcher, settings, o) {
  const { ex, error } = await loadOffer(fetcher, o.url, settings, identityOf(product));
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

/** Amazon-Angebot über SerpApi suchen, mit denselben strengen Regeln abgleichen und eintragen. */
async function checkAmazon(env, product, fetcher, settings, { priority }) {
  const existing = product.offers.find((o) => o.source === 'amazon');
  const query = product.gtin || product.name;
  let { results, error, quota } = await amazonSearch(fetcher, env, query, { priority });
  // EAN liefert bei Amazon nicht immer Treffer -> einmal mit dem Namen nachfassen
  if (!results.length && !quota && product.gtin && priority) ({ results, error, quota } = await amazonSearch(fetcher, env, product.name, { priority }));
  product.amazonError = error || null;
  if (quota) {
    if (existing) existing.quotaStale = true; // letzter Preis bleibt, wird als veraltet markiert
    return;
  }
  product.lastAmazonAt = Date.now();
  let hit = null, note = null, whyNot = null;
  for (const r of results) {
    const m = sameArticle(product, r);
    if (m.ok) { hit = r; note = m.note; break; }
    whyNot ||= m.why;
  }
  product.offers = product.offers.filter((o) => o.source !== 'amazon');
  product.skipped = (product.skipped || []).filter((x) => x.domain !== AMAZON_DOMAIN);
  if (!hit) {
    if (results.length) product.skipped.push({ domain: AMAZON_DOMAIN, url: results[0].url, why: `Amazon: ${whyNot || 'kein exakt passender Artikel'}`, at: Date.now() });
    else if (!error) product.skipped.push({ domain: AMAZON_DOMAIN, url: `https://www.amazon.de/s?k=${encodeURIComponent(query)}`, why: 'Amazon: nicht gefunden', at: Date.now() });
    return;
  }
  const verdict = await getShopVerdict(env, AMAZON_DOMAIN, fetcher, settings);
  const shipping = hit.shipping ?? settings.fallbackShipping;
  const notes = [note, 'Verkäufer bei Amazon prüfen (Amazon oder Drittanbieter)'].filter(Boolean).join(', ');
  product.offers.push({
    source: 'amazon', url: hit.url, domain: AMAZON_DOMAIN, shopName: 'Amazon.de', title: hit.title,
    price: hit.price, shipping, shippingEstimated: hit.shipping == null || hit.shippingEstimated,
    freeShippingFrom: null, total: Math.round((hit.price + shipping) * 100) / 100, currency: 'EUR',
    oldPrice: hit.oldPrice && hit.oldPrice > hit.price ? hit.oldPrice : null,
    discountPct: hit.oldPrice && hit.oldPrice > hit.price ? Math.round((1 - hit.price / hit.oldPrice) * 100) : null,
    condition: hit.condition, available: hit.available, coupons: [], returnCost: null, seller: null,
    shop: shopSummary(verdict), manual: false, matchedBy: sameArticle(product, hit).by, matchNote: notes,
    fails: 0, checkedAt: Date.now(), firstSeen: existing?.firstSeen || Date.now(), quotaStale: false,
  });
  if (!product.image && hit.image) product.image = hit.image;
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
  try {
    // Eigener Link (beim Anlegen angegeben)
    // „Jetzt neu prüfen“ bzw. vorübergehende Fehler: ausgeschlossene Shops erneut bewerten
    if (force) product.excluded = product.excluded.filter((e) => !isTemporary(e));
    const srcDomain = product.sourceUrl && domainOf(product.sourceUrl);
    const srcExcluded = product.excluded.find((e) => e.domain === srcDomain);
    const srcDue = !srcExcluded || force || isTemporary(srcExcluded) || t - srcExcluded.at > DAY;
    if (product.sourceUrl && !product.offers.some((o) => o.manual) && srcDue) {
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
    } else if (!product.nameFromUrl && (force || !product.lastAmazonAt || t - product.lastAmazonAt > AMAZON_INTERVAL_HOURS * HOUR)) {
      await checkAmazon(env, product, fetcher, settings, { priority: force || !product.lastAmazonAt });
    }

    // Neue Shops suchen
    if (product.nameFromUrl) {
      product.searchError = 'Produktname noch unbekannt – Shop-Link konnte nicht gelesen werden';
    } else if (force || !product.lastSearchAt || t - product.lastSearchAt > SEARCH_INTERVAL_HOURS * HOUR) {
      const knownDomains = [
        ...product.offers.map((o) => o.domain),
        ...product.excluded.filter((e) => t - e.at < 7 * DAY && !isTemporary(e)).map((e) => e.domain),
      ];
      const prio = !product.lastSearchAt || force;
      if (force || !product.lastSearchAt) product.skipped = [];
      const { candidates, error, source } = await searchCandidates(fetcher, env, product.name, settings, { exclude: knownDomains, priority: prio });
      // Bei bekannter EAN zusätzlich direkt nach der EAN suchen (findet Shops mit anderer Bezeichnung)
      if (prio && product.gtin) {
        const byEan = await searchCandidates(fetcher, env, product.gtin, settings, { exclude: [...knownDomains, ...candidates.map((c) => c.domain)], priority: true, raw: true });
        candidates.push(...byEan.candidates);
      }
      product.searchError = error || null;
      product.searchSource = source || null;
      product.candidatesFound = candidates.length;
      for (const c of candidates.slice(0, MAX_CANDIDATES * 2)) {
        if (c.blocked) { excludeDomain(product, c.domain, ['Auf der Sperrliste'], c.url); continue; }
        if (c.domain === AMAZON_DOMAIN) {
          // Amazon blockiert direkte Abrufe – Preis kommt über die Amazon-Abfrage
          if (!product.includeAmazon) {
            product.skipped = (product.skipped || []).filter((x) => x.domain !== c.domain);
            product.skipped.push({ domain: c.domain, url: c.url, why: 'Amazon-Schalter ist aus', at: Date.now() });
          }
          continue;
        }
        await considerCandidate(env, product, fetcher, settings, c.url);
        if (product.offers.length >= 15) break;
      }
      product.lastSearchAt = Date.now();
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
      colors: [...new Set((p.variants || []).map((v) => v.color).filter(Boolean))],
      sizes: [...new Set((p.variants || []).map((v) => v.size).filter(Boolean))],
    },
    includeAmazon: !!p.includeAmazon, amazonError: p.amazonError || null, lastAmazonAt: p.lastAmazonAt || null,
    createdAt: p.createdAt, lastCheckAt: p.lastCheckAt, lastError: p.lastError, searchError: p.searchError, searchSource: p.searchSource,
    best: best ? { ...best, effectiveTotal: effectiveTotal(best) } : null,
    offers: (p.offers || []).map((o) => ({ ...o, effectiveTotal: o.total != null ? effectiveTotal(o) : null })),
    excluded: p.excluded || [],
    history: p.history || [],
    notify: p.notify || {},
    pending: !p.lastCheckAt,
  };
}
