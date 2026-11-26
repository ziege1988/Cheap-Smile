// Websuche nach Shop-Seiten für ein Produkt.
// Anbieter (in dieser Reihenfolge):
//  - Google über SerpApi, wenn SERPAPI_KEY gesetzt ist (250 Suchen/Monat kostenlos).
//    Ein Zähler in KV verteilt das Kontingent gleichmäßig über den Monat.
//  - Brave Search API, wenn BRAVE_API_KEY gesetzt ist
//  - DuckDuckGo HTML-Ergebnisse (ohne Schlüssel; Rückfallebene)

import { NON_SHOP_DOMAINS } from './config.js';
import { fetchText, domainOf, domainMatches, decodeEntities } from './util.js';

export function parseDuckDuckGo(html) {
  const urls = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = decodeEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (/^https?:\/\//.test(href) && !/duckduckgo\.com\/y\.js/.test(href)) urls.push(href);
  }
  return urls;
}

export const monthKey = () => `serpapi:${new Date().toISOString().slice(0, 7)}`;

/** Darf jetzt eine Google-Suche verbraucht werden? (gleichmäßige Verteilung über den Monat) */
export function googleAllowed(used, limit, date = new Date(), priority = false) {
  if (used >= limit) return false;
  if (priority) return true; // neues Produkt: sofort suchen
  const days = new Date(date.getUTCFullYear(), date.getUTCMonth() + 1, 0).getDate();
  const allowedSoFar = Math.ceil((limit * date.getUTCDate()) / days) + 5;
  return used < allowedSoFar;
}

export function parseSerpApi(j) {
  const urls = [];
  for (const r of j.shopping_results || []) if (r.link) urls.push(r.link);
  for (const r of j.inline_shopping_results || []) if (r.link) urls.push(r.link);
  for (const r of j.organic_results || []) if (r.link) urls.push(r.link);
  return urls.filter((u) => { try { return /^https?:$/.test(new URL(u).protocol) && !/(^|\.)google\./.test(new URL(u).hostname); } catch { return false; } });
}

async function googleSearch(fetcher, env, query, priority) {
  const limit = Number(env.SERPAPI_MONTHLY_LIMIT || 240);
  const key = monthKey();
  const used = Number((await env.DB.get(key)) || 0);
  if (!googleAllowed(used, limit, new Date(), priority)) return { urls: [], error: `Google-Kontingent für heute verbraucht (${used}/${limit} im Monat)` };
  const u = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&google_domain=google.de&gl=de&hl=de&num=20&api_key=${encodeURIComponent(env.SERPAPI_KEY)}`;
  const r = await fetchText(fetcher, u, { init: { headers: { Accept: 'application/json' }, timeout: 20000 } });
  await env.DB.put(key, String(used + 1), { expirationTtl: 40 * 86400 });
  if (!r.ok) return { urls: [], error: `Google (SerpApi) HTTP ${r.status}` };
  try {
    const j = JSON.parse(r.text);
    if (j.error) return { urls: [], error: `Google (SerpApi): ${j.error}` };
    return { urls: parseSerpApi(j), source: 'google' };
  } catch { return { urls: [], error: 'Google (SerpApi): ungültige Antwort' }; }
}

async function braveSearch(fetcher, query, key) {
  const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&country=de&search_lang=de&count=20`;
  const r = await fetchText(fetcher, u, { init: { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } } });
  if (!r.ok) return { urls: [], error: `Brave HTTP ${r.status}` };
  try {
    const j = JSON.parse(r.text);
    return { urls: (j.web?.results || []).map((x) => x.url).filter(Boolean), source: 'brave' };
  } catch { return { urls: [], error: 'Brave: ungültige Antwort' }; }
}

async function ddgSearch(fetcher, query) {
  const r = await fetchText(fetcher, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=de-de`);
  if (!r.ok) return { urls: [], error: `DuckDuckGo HTTP ${r.status}` };
  const urls = parseDuckDuckGo(r.text);
  return { urls, error: urls.length ? null : 'DuckDuckGo: keine Treffer (evtl. gedrosselt)' };
}

/** Liefert eindeutige Kandidaten-URLs (max. eine pro Domain). */
export async function searchCandidates(fetcher, env, query, settings, { exclude = [], priority = false, raw = false } = {}) {
  const q = raw ? String(query) : `${query} kaufen`;
  const errors = [];
  let result = { urls: [] };
  if (env.SERPAPI_KEY) {
    result = await googleSearch(fetcher, env, q, priority);
    if (result.error) errors.push(result.error);
  }
  if (!result.urls.length && env.BRAVE_API_KEY) {
    result = await braveSearch(fetcher, q, env.BRAVE_API_KEY);
    if (result.error) errors.push(result.error);
  }
  if (!result.urls.length) {
    const d = await ddgSearch(fetcher, q);
    if (d.error) errors.push(d.error);
    result = { urls: d.urls, source: 'duckduckgo' };
  }
  result.error = result.urls.length ? null : errors.join('; ') || null;
  const seen = new Set(exclude);
  const out = [];
  for (const url of result.urls) {
    const d = domainOf(url);
    if (!d || seen.has(d)) continue;
    if (domainMatches(d, NON_SHOP_DOMAINS)) continue;
    seen.add(d);
    out.push({ url, domain: d, blocked: domainMatches(d, settings.blocklist) });
  }
  return { candidates: out, error: result.error, source: result.source };
}

/** Trustpilot-Daten aus Google-Ergebnissen lesen (Sterne + Anzahl). */
export function parseTrustpilotFromSerp(j, domain) {
  const hit = (j.organic_results || []).find((r) => {
    try { const u = new URL(r.link); return /(^|\.)trustpilot\.com$/.test(u.hostname) && u.pathname.toLowerCase().includes(`/review/${domain}`); } catch { return false; }
  });
  if (!hit) return { found: false };
  const ext = hit.rich_snippet?.top?.detected_extensions || hit.rich_snippet?.bottom?.detected_extensions || {};
  const text = `${hit.title || ''} ${hit.snippet || ''} ${(hit.rich_snippet?.top?.extensions || []).join(' ')}`;
  let score = Number(ext.rating ?? hit.rating);
  if (!Number.isFinite(score)) {
    const m = text.match(/TrustScore\s*(?:von|of|:)?\s*(\d[.,]\d)/i) || text.match(/(\d[.,]\d)\s*(?:\/|von|out of)\s*5/i) || text.match(/(?:Bewertung|Rating)\s*:?\s*(\d[.,]\d)/i);
    score = m ? parseFloat(m[1].replace(',', '.')) : NaN;
  }
  let count = Number(ext.reviews ?? hit.reviews);
  if (!Number.isFinite(count)) {
    const m = text.match(/(\d[\d.,]*)\s*(?:Bewertungen|Rezensionen|reviews|Kunden|customers|Erfahrungsberichte)/i);
    count = m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : NaN;
  }
  if (!Number.isFinite(score) || score < 1 || score > 5) return { found: true, score: null };
  return { found: true, score, count: Number.isFinite(count) ? count : null, name: null, source: 'google' };
}

export async function trustpilotViaGoogle(fetcher, env, domain) {
  const limit = Number(env.SERPAPI_MONTHLY_LIMIT || 240);
  const key = monthKey();
  const used = Number((await env.DB.get(key)) || 0);
  if (!googleAllowed(used, limit, new Date(), true)) return null;
  const u = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(`trustpilot ${domain}`)}&google_domain=google.de&gl=de&hl=de&num=10&api_key=${encodeURIComponent(env.SERPAPI_KEY)}`;
  const r = await fetchText(fetcher, u, { init: { headers: { Accept: 'application/json' }, timeout: 20000 } });
  await env.DB.put(key, String(used + 1), { expirationTtl: 40 * 86400 });
  if (!r.ok) return null;
  try { return parseTrustpilotFromSerp(JSON.parse(r.text), domain); } catch { return null; }
}

/**
 * Kontingent-Status: eigener Zähler + (wenn möglich) echter Stand bei SerpApi.
 * Die SerpApi-Kontoabfrage verbraucht keine Suche.
 */
export async function quotaStatus(env, fetcher = null, now = new Date()) {
  const limit = Number(env.SERPAPI_MONTHLY_LIMIT || 240);
  const month = now.toISOString().slice(0, 7);
  let used = Number((await env.DB.get(`serpapi:${month}`)) || 0);
  let left = Math.max(0, limit - used);
  let source = 'app';
  if (env.SERPAPI_KEY && fetcher) {
    try {
      const r = await fetchText(fetcher, `https://serpapi.com/account.json?api_key=${encodeURIComponent(env.SERPAPI_KEY)}`, { init: { headers: { Accept: 'application/json' }, timeout: 8000 } });
      if (r.ok) {
        const j = JSON.parse(r.text);
        const realLeft = Number(j.total_searches_left ?? j.plan_searches_left);
        if (Number.isFinite(realLeft)) {
          // 10 Suchen Puffer, damit SerpApi selbst nie ins Leere läuft
          left = Math.min(left, Math.max(0, realLeft - 10));
          source = 'serpapi';
          if (Number.isFinite(Number(j.this_month_usage))) used = Math.max(used, Number(j.this_month_usage));
        }
      }
    } catch {}
  }
  const exhausted = left <= 0;
  const pausedToday = !exhausted && !googleAllowed(limit - left, limit, now, false);
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { enabled: !!env.SERPAPI_KEY, month, used, limit, left, exhausted, pausedToday, resetDate: reset.toISOString().slice(0, 10), source };
}
