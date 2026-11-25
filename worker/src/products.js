// Prüft ein Produkt: neue Shops suchen, bekannte Angebote aktualisieren,
// Shops verifizieren, Bestpreis + Historie fortschreiben, Alarme auswerten.

import { MAX_CANDIDATES, SEARCH_INTERVAL_HOURS, PRICE_INTERVAL_HOURS } from './config.js';
import { fetchText, domainOf, matchScore, BudgetExceeded, HOUR, DAY } from './util.js';
import { extractOffer } from './extract.js';
import { getShopVerdict } from './shopcheck.js';
import { searchCandidates } from './search.js';
import { applyOfferRules, recordHistory, evaluateAlerts, bestOffer, effectiveTotal } from './deal.js';

const MIN_MATCH = 0.7;

function shopSummary(v) {
  return {
    trustScore: v.trustpilot?.score ?? null,
    trustCount: v.trustpilot?.count ?? null,
    allowlisted: !!v.allowlisted,
    country: v.impressum?.country ?? null,
    withdrawalDays: v.returns?.days ?? null,
    notes: v.notes || [],
  };
}

function excludeDomain(product, domain, reasons, url) {
  product.excluded = (product.excluded || []).filter((e) => e.domain !== domain);
  product.excluded.push({ domain, url, reasons: [].concat(reasons), at: Date.now() });
  product.offers = (product.offers || []).filter((o) => o.domain !== domain);
}

/** Lädt eine Produktseite und baut daraus ein Angebot (ohne Shop-Prüfung). */
async function loadOffer(fetcher, url, settings) {
  const page = await fetchText(fetcher, url);
  if (!page.ok) return { error: `HTTP ${page.status || 'Fehler'}` };
  const ex = extractOffer(page.text, page.url || url, settings);
  if (ex.price == null) return { error: 'Kein Preis erkennbar', ex };
  return { ex };
}

async function considerCandidate(env, product, fetcher, settings, url, { manual = false } = {}) {
  const domain = domainOf(url);
  if (!domain) return;
  const { ex, error } = await loadOffer(fetcher, url, settings);
  if (error) {
    if (manual) product.lastError = `Eigener Link: ${error}`;
    return;
  }
  if (!manual) {
    const score = matchScore(product.name, ex.title);
    const gtinMatch = product.gtin && ex.gtin && product.gtin === ex.gtin;
    if (!gtinMatch && score < MIN_MATCH) return; // anderes Produkt / Zubehör
    if (product.gtin && ex.gtin && product.gtin !== ex.gtin) return;
  }
  const verdict = await getShopVerdict(env, domain, fetcher, settings);
  if (!verdict.ok) { excludeDomain(product, domain, verdict.reasons, url); return; }

  if (manual && product.nameFromUrl && ex.title) {
    product.name = ex.title.replace(/\s+[|–-]\s+[^|–]*$/, '').slice(0, 120) || ex.title;
    product.nameFromUrl = false;
  }
  if (!product.gtin && ex.gtin && (manual || matchScore(product.name, ex.title) >= 0.85)) product.gtin = ex.gtin;
  if (!product.image && ex.image) product.image = ex.image;

  const offer = {
    url: ex.url, domain, shopName: verdict.trustpilot?.name || domain,
    title: ex.title, price: ex.price, shipping: ex.shipping, shippingEstimated: ex.shippingEstimated,
    freeShippingFrom: ex.freeShippingFrom, total: ex.total, currency: ex.currency,
    oldPrice: ex.oldPrice, discountPct: ex.discountPct, condition: ex.condition, available: ex.available,
    coupons: ex.coupons, returnCost: verdict.returns?.returnCost ?? null,
    shop: shopSummary(verdict), manual, fails: 0, checkedAt: Date.now(), firstSeen: Date.now(),
  };
  product.excluded = (product.excluded || []).filter((e) => e.domain !== domain);
  product.offers = (product.offers || []).filter((o) => o.domain !== domain);
  product.offers.push(offer);
}

async function refreshOffer(env, product, fetcher, settings, o) {
  const { ex, error } = await loadOffer(fetcher, o.url, settings);
  o.checkedAt = Date.now();
  if (error) {
    o.fails = (o.fails || 0) + 1;
    if (o.fails >= 3) o.stale = true;
    return;
  }
  // Shop-Urteil kann inzwischen abgelaufen sein -> erneut (gecacht) prüfen
  const verdict = await getShopVerdict(env, o.domain, fetcher, settings);
  if (!verdict.ok) { excludeDomain(product, o.domain, verdict.reasons, o.url); return; }
  Object.assign(o, {
    title: ex.title || o.title, price: ex.price, shipping: ex.shipping, shippingEstimated: ex.shippingEstimated,
    freeShippingFrom: ex.freeShippingFrom, total: ex.total, currency: ex.currency, oldPrice: ex.oldPrice,
    discountPct: ex.discountPct, condition: ex.condition, available: ex.available, coupons: ex.coupons,
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
    if (product.sourceUrl && !product.offers.some((o) => o.manual) && !product.excluded.some((e) => e.domain === domainOf(product.sourceUrl))) {
      await considerCandidate(env, product, fetcher, settings, product.sourceUrl, { manual: true });
    }

    // Bekannte Angebote aktualisieren (älteste zuerst)
    const due = product.offers
      .filter((o) => force || t - (o.checkedAt || 0) > PRICE_INTERVAL_HOURS * HOUR)
      .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0));
    for (const o of due) await refreshOffer(env, product, fetcher, settings, o);
    product.offers = product.offers.filter((o) => !o.stale || t - o.checkedAt < 7 * DAY);

    // Neue Shops suchen
    if (force || !product.lastSearchAt || t - product.lastSearchAt > SEARCH_INTERVAL_HOURS * HOUR) {
      const knownDomains = [
        ...product.offers.map((o) => o.domain),
        ...product.excluded.filter((e) => t - e.at < 7 * DAY).map((e) => e.domain),
      ];
      const { candidates, error } = await searchCandidates(fetcher, env, product.name, settings, { exclude: knownDomains });
      product.searchError = error || null;
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
    createdAt: p.createdAt, lastCheckAt: p.lastCheckAt, lastError: p.lastError, searchError: p.searchError,
    best: best ? { ...best, effectiveTotal: effectiveTotal(best) } : null,
    offers: (p.offers || []).map((o) => ({ ...o, effectiveTotal: o.total != null ? effectiveTotal(o) : null })),
    excluded: p.excluded || [],
    history: p.history || [],
    notify: p.notify || {},
    pending: !p.lastCheckAt,
  };
}
