// Prüft ein Produkt: neue Shops suchen, bekannte Angebote aktualisieren,
// Shops verifizieren, Bestpreis + Historie fortschreiben, Alarme auswerten.

import { MAX_CANDIDATES, SEARCH_INTERVAL_HOURS, PRICE_INTERVAL_HOURS } from './config.js';
import { fetchText, domainOf, matchScore, BudgetExceeded, HOUR, DAY } from './util.js';
import { extractOffer, normGtin, normMpn } from './extract.js';
import { getShopVerdict } from './shopcheck.js';
import { searchCandidates } from './search.js';
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
export const identityOf = (p) => ({ gtin: p.gtin || null, gtins: p.gtins || [], mpn: p.mpn || null });

/**
 * Ist das Angebot exakt derselbe Artikel?
 * 1. EAN/GTIN (inkl. Variante) muss übereinstimmen, sonst
 * 2. Herstellernummer (MPN), sonst
 * 3. nur Name bekannt: alle Wörter inkl. Modellnummer müssen im Titel stehen.
 */
export function sameArticle(product, ex) {
  if (ex.isListing) return { ok: false, why: 'Listen-/Kategorieseite statt Produktseite' };
  const gs = new Set([product.gtin, ...(product.gtins || [])].map(normGtin).filter(Boolean));
  if (gs.size) return gs.has(normGtin(ex.gtin)) ? { ok: true } : { ok: false, why: 'Andere EAN/Variante' };
  const m = normMpn(product.mpn);
  if (m) return normMpn(ex.mpn) === m ? { ok: true } : { ok: false, why: 'Andere Herstellernummer' };
  const b1 = String(product.brand || '').toLowerCase(), b2 = String(ex.brand || '').toLowerCase();
  if (b1 && b2 && !b1.includes(b2) && !b2.includes(b1)) return { ok: false, why: 'Andere Marke' };
  return matchScore(product.name, ex.title) >= 1 ? { ok: true } : { ok: false, why: 'Titel passt nicht exakt' };
}

/** Lädt eine Produktseite und baut daraus ein Angebot (ohne Shop-Prüfung). */
async function loadOffer(fetcher, url, settings, want = {}) {
  const page = await fetchText(fetcher, url);
  if (!page.ok) return { error: `HTTP ${page.status || 'Fehler'}` };
  const ex = extractOffer(page.text, page.url || url, settings, want);
  if (ex.isListing) return { error: 'Listen-/Kategorieseite statt Produktseite', ex };
  if (ex.price == null) return { error: (want.gtin || want.gtins?.length || want.mpn) ? 'Gesuchte Variante nicht auf der Seite' : 'Kein Preis erkennbar', ex };
  return { ex };
}

async function considerCandidate(env, product, fetcher, settings, url, { manual = false } = {}) {
  const domain = domainOf(url);
  if (!domain) return;
  const { ex, error } = await loadOffer(fetcher, url, settings, identityOf(product));
  if (error) {
    if (manual) product.lastError = `Eigener Link: ${error}`;
    return;
  }
  if (manual) {
    // Eigener Link legt fest, welcher Artikel (inkl. Variante) gesucht ist
    if (!product.gtin && !product.gtins?.length && !product.mpn) {
      if (ex.ambiguousVariant && ex.gtins.length > 1) {
        product.gtins = ex.gtins; // Variante nicht eindeutig: alle Varianten dieses Artikels zulassen
        product.variantHint = 'Größe/Farbe im Link nicht eindeutig – alle Varianten dieses Artikels werden verglichen.';
      } else {
        product.gtin = ex.gtin || null;
      }
      product.mpn = ex.mpn || null;
      product.brand = ex.brand || null;
    }
  } else if (!sameArticle(product, ex).ok) {
    return; // nicht exakt derselbe Artikel
  }
  // Produktname und Bild sofort übernehmen – auch wenn der Shop danach ausgeschlossen wird,
  // damit die Suche nach weiteren Shops mit dem echten Produktnamen läuft.
  if (manual && product.nameFromUrl && ex.title) {
    product.name = ex.title.replace(/\s+[|–-]\s+[^|–]*$/, '').slice(0, 120) || ex.title;
    product.nameFromUrl = false;
  }
  if (manual && !product.image && ex.image) product.image = ex.image;

  const verdict = await getShopVerdict(env, domain, fetcher, settings);
  if (!verdict.ok) { excludeDomain(product, domain, verdict.reasons, url, verdict.retryable); return; }
  if (!product.image && ex.image) product.image = ex.image;

  const offer = {
    url: ex.url, domain, shopName: verdict.trustpilot?.name || domain,
    title: ex.title, price: ex.price, shipping: ex.shipping, shippingEstimated: ex.shippingEstimated,
    freeShippingFrom: ex.freeShippingFrom, total: ex.total, currency: ex.currency,
    oldPrice: ex.oldPrice, discountPct: ex.discountPct, condition: ex.condition, available: ex.available,
    coupons: ex.coupons, returnCost: verdict.returns?.returnCost ?? null, seller: ex.sellerName,
    shop: shopSummary(verdict), manual, fails: 0, checkedAt: Date.now(), firstSeen: Date.now(),
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
  if (!o.manual && !sameArticle(product, ex).ok) { o.remove = true; return; }
  // Shop-Urteil kann inzwischen abgelaufen sein -> erneut (gecacht) prüfen
  const verdict = await getShopVerdict(env, o.domain, fetcher, settings);
  if (!verdict.ok) { excludeDomain(product, o.domain, verdict.reasons, o.url); return; }
  Object.assign(o, {
    title: ex.title || o.title, price: ex.price, shipping: ex.shipping, shippingEstimated: ex.shippingEstimated,
    freeShippingFrom: ex.freeShippingFrom, total: ex.total, currency: ex.currency, oldPrice: ex.oldPrice,
    discountPct: ex.discountPct, condition: ex.condition, available: ex.available, coupons: ex.coupons, seller: ex.sellerName,
    returnCost: verdict.returns?.returnCost ?? null, shop: shopSummary(verdict), fails: 0, stale: false,
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

    // Bekannte Angebote aktualisieren (älteste zuerst)
    const due = product.offers
      .filter((o) => force || t - (o.checkedAt || 0) > PRICE_INTERVAL_HOURS * HOUR)
      .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0));
    for (const o of due) await refreshOffer(env, product, fetcher, settings, o);
    product.offers = product.offers.filter((o) => !o.remove && (!o.stale || t - o.checkedAt < 7 * DAY));

    // Neue Shops suchen
    if (product.nameFromUrl) {
      product.searchError = 'Produktname noch unbekannt – Shop-Link konnte nicht gelesen werden';
    } else if (force || !product.lastSearchAt || t - product.lastSearchAt > SEARCH_INTERVAL_HOURS * HOUR) {
      const knownDomains = [
        ...product.offers.map((o) => o.domain),
        ...product.excluded.filter((e) => t - e.at < 7 * DAY && !isTemporary(e)).map((e) => e.domain),
      ];
      const { candidates, error, source } = await searchCandidates(fetcher, env, product.name, settings, { exclude: knownDomains, priority: !product.lastSearchAt || force });
      product.searchError = error || null;
      product.searchSource = source || null;
      for (const c of candidates.slice(0, MAX_CANDIDATES * 2)) {
        if (c.blocked) { excludeDomain(product, c.domain, ['Auf der Sperrliste'], c.url); continue; }
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
    variantHint: p.variantHint || null, gtin: p.gtin || null,
    createdAt: p.createdAt, lastCheckAt: p.lastCheckAt, lastError: p.lastError, searchError: p.searchError, searchSource: p.searchSource,
    best: best ? { ...best, effectiveTotal: effectiveTotal(best) } : null,
    offers: (p.offers || []).map((o) => ({ ...o, effectiveTotal: o.total != null ? effectiveTotal(o) : null })),
    excluded: p.excluded || [],
    history: p.history || [],
    notify: p.notify || {},
    pending: !p.lastCheckAt,
  };
}
