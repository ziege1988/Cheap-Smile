// Amazon.de über die SerpApi-Amazon-Suche (Amazon blockiert direkte Abrufe).
// Verbraucht pro Abfrage eine SerpApi-Suche aus demselben Monatskontingent wie die Google-Suche.

import { fetchText, parsePrice, round2 } from './util.js';
import { googleAllowed, monthKey } from './search.js';
import { normColor, colorsInText } from './extract.js';

export const AMAZON_DOMAIN = 'amazon.de';
export const AMAZON_FREE_SHIPPING_FROM = 39; // Versandkostenfrei-Grenze ohne Prime (Stand 2026, wird markiert)

function priceOf(r) {
  if (Number.isFinite(r?.extracted_price)) return r.extracted_price;
  if (typeof r?.price === 'object' && r.price) return Number.isFinite(r.price.value) ? r.price.value : parsePrice(r.price.raw);
  return parsePrice(r?.price);
}

function oldPriceOf(r) {
  if (Number.isFinite(r?.extracted_old_price)) return r.extracted_old_price;
  const o = r?.old_price ?? r?.list_price ?? r?.price_strikethrough;
  return typeof o === 'object' && o ? (o.value ?? parsePrice(o.raw)) : parsePrice(o);
}

function shippingOf(r, price) {
  const d = [].concat(r?.delivery || [], r?.shipping || []).join(' ').toLowerCase();
  if (/kostenlos|gratis|free/.test(d) || r?.prime) return { shipping: 0, estimated: false };
  const m = d.match(/(\d+[.,]\d{2})\s*€/);
  if (m) return { shipping: parsePrice(m[1]), estimated: false };
  if (price >= AMAZON_FREE_SHIPPING_FROM) return { shipping: 0, estimated: true };
  return { shipping: null, estimated: true };
}

/** Wandelt SerpApi-Amazon-Ergebnisse in prüfbare Angebote um. */
export function parseAmazonResults(j) {
  const list = [...(j.organic_results || []), ...(j.product_results ? [j.product_results] : [])];
  return list
    .filter((r) => r && (r.asin || r.link) && !r.sponsored)
    .map((r) => {
      const price = priceOf(r);
      const ship = shippingOf(r, price);
      const title = String(r.title || '').replace(/\s+/g, ' ').trim();
      const asin = r.asin || String(r.link || '').match(/\/dp\/([A-Z0-9]{10})/)?.[1] || null;
      return {
        url: asin ? `https://www.amazon.de/dp/${asin}` : r.link_clean || r.link,
        asin,
        title,
        brand: r.brand || null,
        price,
        oldPrice: oldPriceOf(r),
        shipping: ship.shipping,
        shippingEstimated: ship.estimated,
        color: normColor(r.color) || colorsInText(title)[0] || null,
        colors: [],
        size: null,
        sizes: [],
        gtin: null,
        mpn: null,
        rating: r.rating ?? null,
        reviews: r.reviews ?? null,
        isListing: false,
        condition: /gebraucht|refurbished|renewed|generalüberholt/i.test(title) ? 'used' : 'new',
        available: price != null,
        image: r.thumbnail || null,
      };
    })
    .filter((x) => x.url && x.price != null);
}

/**
 * Sucht den Artikel bei Amazon.de.
 * @returns {{ results, error, quota }} – results leer, wenn nichts gefunden oder Kontingent verbraucht
 */
export async function amazonSearch(fetcher, env, query, { priority = false } = {}) {
  if (!env.SERPAPI_KEY) return { results: [], error: 'Amazon-Abfrage braucht einen SerpApi-Schlüssel' };
  const limit = Number(env.SERPAPI_MONTHLY_LIMIT || 240);
  const key = monthKey();
  const used = Number((await env.DB.get(key)) || 0);
  if (!googleAllowed(used, limit, new Date(), priority)) return { results: [], quota: true, error: `Suchkontingent für heute verbraucht (${used}/${limit} im Monat)` };
  const u = `https://serpapi.com/search.json?engine=amazon&amazon_domain=amazon.de&language=de_DE&k=${encodeURIComponent(query)}&api_key=${encodeURIComponent(env.SERPAPI_KEY)}`;
  const r = await fetchText(fetcher, u, { init: { headers: { Accept: 'application/json' }, timeout: 25000 } });
  await env.DB.put(key, String(used + 1), { expirationTtl: 40 * 86400 });
  if (!r.ok) return { results: [], error: `Amazon (SerpApi) HTTP ${r.status}` };
  try {
    const j = JSON.parse(r.text);
    if (j.error) return { results: [], error: `Amazon (SerpApi): ${j.error}`, quota: /run out|limit/i.test(j.error) };
    return { results: parseAmazonResults(j) };
  } catch { return { results: [], error: 'Amazon (SerpApi): ungültige Antwort' }; }
}

export const totalOf = (o) => round2(o.price + (o.shipping || 0));

/** Amazon-Artikelnummer (ASIN) aus einem Amazon-Link. */
export function asinOf(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)amazon\.(de|com|co\.uk|fr|it|es|nl|at)$/i.test(u.hostname) && !/^amzn\.(eu|to)$/i.test(u.hostname)) return null;
    return u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase() || null;
  } catch { return null; }
}
export const isAmazonUrl = (href) => { try { return /(^|\.)amazon\.[a-z.]+$|^amzn\./i.test(new URL(href).hostname); } catch { return false; } };

export const isAmazonShortLink = (href) => /^https?:\/\/(www\.)?(amzn\.(eu|to|com)|a\.co)\//i.test(String(href || ''));

/**
 * Amazon-Kurzlinks (amzn.eu/d/…, amzn.to/…) aus der Amazon-App zur ASIN auflösen.
 * Drei Wege, weil Amazon Server-Anfragen unterschiedlich beantwortet:
 *  1. Weiterleitungen einzeln verfolgen (Location-Header)
 *  2. Weiterleitungen automatisch folgen und die End-Adresse lesen
 *  3. ASIN im Seiteninhalt suchen (auch Amazons Sperrseite enthält oft den Ziel-Pfad)
 */
export async function resolveAmazonShortLink(href, fetchImpl = fetch) {
  if (!isAmazonShortLink(href)) return href;
  const UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Accept-Language': 'de-DE,de;q=0.9' };
  // 1) manuell
  try {
    let cur = href;
    for (let i = 0; i < 5; i++) {
      const res = await fetchImpl(cur, { method: 'GET', redirect: 'manual', headers: UA });
      const loc = res.headers.get('location');
      if (!loc) {
        const body = await res.text().catch(() => '');
        const a = asinInText(body);
        if (a) return `https://www.amazon.de/dp/${a}`;
        break;
      }
      cur = new URL(loc, cur).toString();
      if (asinOf(cur)) return cur;
    }
  } catch {}
  // 2) + 3) automatisch folgen
  try {
    const res = await fetchImpl(href, { method: 'GET', redirect: 'follow', headers: UA });
    if (asinOf(res.url)) return res.url;
    const a = asinInText(await res.text().catch(() => ''));
    if (a) return `https://www.amazon.de/dp/${a}`;
  } catch {}
  return href;
}

/** ASIN in HTML/Text finden (z. B. „/dp/B09Y2MYL5C“ oder data-asin="…"). */
export function asinInText(t) {
  const s = String(t || '');
  return (s.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?=[/?"'&#\s]|$)/) || s.match(/data-asin=["']([A-Z0-9]{10})["']/) || s.match(/["']asin["']\s*:\s*["']([A-Z0-9]{10})["']/i))?.[1] || null;
}
