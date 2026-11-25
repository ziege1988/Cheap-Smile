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

const monthKey = () => `serpapi:${new Date().toISOString().slice(0, 7)}`;

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
export async function searchCandidates(fetcher, env, query, settings, { exclude = [], priority = false } = {}) {
  const q = `${query} kaufen`;
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
