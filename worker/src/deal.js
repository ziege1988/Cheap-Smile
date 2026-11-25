// Bestpreis-Ermittlung, Fake-Preis-Filter und Push-Entscheidungen.

import { median, round2, DAY } from './util.js';

/** Angebote, die für dieses Produkt zählen (Zustand, Verfügbarkeit, Ausschlüsse). */
export function eligibleOffers(product) {
  return (product.offers || []).filter((o) =>
    !o.excludedReason
    && !o.stale
    && o.available !== false
    && o.total != null
    && (o.currency || 'EUR') === 'EUR'
    && (product.allowUsed || o.condition === 'new'));
}

export function bestOffer(product) {
  const list = eligibleOffers(product);
  if (!list.length) return null;
  return list.reduce((a, b) => (effectiveTotal(b) < effectiveTotal(a) ? b : a));
}

/** Gesamtpreis inkl. Versand, ggf. abzüglich eines erkannten Prozent-/Euro-Codes. */
export function effectiveTotal(o) {
  const c = (o.coupons || [])[0];
  let price = o.price;
  if (c?.percent && c.percent <= 50) price = price * (1 - c.percent / 100);
  else if (c?.amount && c.amount < price / 2) price = price - c.amount;
  return round2(price + (o.shipping || 0));
}

/**
 * Markiert unrealistisch billige Angebote (klassisches Fake-Shop-Merkmal)
 * und unverhältnismäßige Rücksendekosten.
 */
export function applyOfferRules(product, settings) {
  const offers = product.offers || [];
  for (const o of offers) {
    if (o.excludedReason?.startsWith('Preis') || o.excludedReason?.startsWith('Rücksende')) delete o.excludedReason;
  }
  for (const o of offers) {
    if (o.returnCost != null && o.price && o.returnCost / o.price > settings.maxReturnCostRatio) {
      o.excludedReason = `Rücksendekosten ${o.returnCost.toFixed(2)} € unverhältnismäßig (${Math.round((o.returnCost / o.price) * 100)} % vom Preis)`;
    }
  }
  const sameCondition = (c) => offers.filter((o) => !o.excludedReason && o.total != null && o.condition === c);
  for (const cond of ['new', 'used', 'refurbished']) {
    const group = sameCondition(cond);
    if (group.length < 3) continue;
    for (const o of group) {
      const others = median(group.filter((x) => x !== o).map((x) => x.total));
      if (others && o.total < others * settings.fakePriceRatio) {
        o.excludedReason = `Preis unrealistisch niedrig (${Math.round((o.total / others) * 100)} % des Marktpreises) – Fake-Shop-Verdacht`;
      }
    }
  }
}

export function recordHistory(product) {
  const best = bestOffer({ ...product, allowUsed: false });
  const bestAll = bestOffer({ ...product, allowUsed: true });
  const point = { t: Date.now(), n: best ? effectiveTotal(best) : null, a: bestAll ? effectiveTotal(bestAll) : null };
  const h = product.history || (product.history = []);
  const last = h[h.length - 1];
  // Gleicher Wert innerhalb von 12 h -> nur Zeitstempel fortschreiben
  if (last && last.n === point.n && last.a === point.a && point.t - last.t < DAY / 2) return;
  h.push(point);
  const cutoff = Date.now() - 180 * DAY;
  while (h.length && (h[0].t < cutoff || h.length > 600)) h.shift();
}

function series(product, days) {
  const key = product.allowUsed ? 'a' : 'n';
  const cutoff = Date.now() - days * DAY;
  return (product.history || []).filter((p) => p.t >= cutoff && p[key] != null).map((p) => p[key]);
}

const eur = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/** Entscheidet, ob (und welche) Benachrichtigung fällig ist. Mutiert product.notify. */
export function evaluateAlerts(product, settings) {
  // Getrennter Alarm-Zustand für „nur neu“ (n) und „gebraucht erlaubt“ (a),
  // damit das Umschalten keine doppelten oder verschluckten Pushes erzeugt.
  const all = product.notify || (product.notify = {});
  const st = all[product.allowUsed ? 'a' : 'n'] || (all[product.allowUsed ? 'a' : 'n'] = {});
  const best = bestOffer(product);
  if (!best) return null;
  const total = effectiveTotal(best);
  const shop = best.shopName || best.domain;
  const coupon = (best.coupons || [])[0];
  const codeText = coupon ? ` Code: ${coupon.code}` : '';
  const usedText = best.condition !== 'new' ? ` (${best.condition === 'refurbished' ? 'refurbished' : 'gebraucht'})` : '';
  const base = { productId: product.id, url: `./?product=${product.id}`, tag: `p-${product.id}` };

  // 1) Wunschpreis
  if (product.wishPrice != null) {
    if (total <= product.wishPrice) {
      if (!st.wishActive || total < st.wishPrice * 0.98) {
        st.wishActive = true;
        st.wishPrice = total;
        all.lastAlertAt = Date.now();
        return {
          ...base, kind: 'wish',
          title: `🎯 Wunschpreis erreicht: ${product.name}`,
          body: `${eur(total)} inkl. Versand bei ${shop}${usedText} (Wunsch: ${eur(product.wishPrice)}).${codeText}`,
        };
      }
      return null;
    }
    st.wishActive = false;
  }

  // 2) Sehr gutes Angebot (aber nicht Wunschpreis)
  const hist = series(product, 30);
  const med = median(hist);
  const min90 = Math.min(...series(product, 90));
  let reason = null;
  if (hist.length >= settings.goodDealMinHistory && med && total <= med * (1 - settings.goodDealDropPct / 100) && total <= min90) {
    reason = `${Math.round((1 - total / med) * 100)} % unter dem 30-Tage-Mittel`;
  } else if (best.discountPct >= 25 && (!med || total <= med)) {
    reason = `Aktion: −${best.discountPct} % ggü. ${eur(best.oldPrice)}`;
  }
  if (reason) {
    if (st.dealPrice == null || total < st.dealPrice * 0.97) {
      st.dealPrice = total;
      all.lastAlertAt = Date.now();
      const wishText = product.wishPrice != null ? `Nicht dein Wunschpreis (${eur(product.wishPrice)}), aber ein sehr gutes Angebot: ` : 'Sehr gutes Angebot: ';
      return {
        ...base, kind: 'deal',
        title: `🔥 Top-Angebot: ${product.name}`,
        body: `${wishText}${eur(total)} inkl. Versand bei ${shop}${usedText} – ${reason}.${codeText}`,
      };
    }
  } else if (st.dealPrice != null && med && total > med) {
    st.dealPrice = null; // Preis wieder normal -> nächstes Angebot erneut melden
  }
  return null;
}
