// Websuche nach Shop-Seiten für ein Produkt.
// Anbieter (in dieser Reihenfolge):
//  - Brave Search API, wenn BRAVE_API_KEY gesetzt ist (kostenloses Kontingent, Konto nötig)
//  - DuckDuckGo HTML-Ergebnisse (ohne Schlüssel; kann gedrosselt werden)

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

async function braveSearch(fetcher, query, key) {
  const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&country=de&search_lang=de&count=20`;
  const r = await fetchText(fetcher, u, { init: { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } } });
  if (!r.ok) return { urls: [], error: `Brave HTTP ${r.status}` };
  try {
    const j = JSON.parse(r.text);
    return { urls: (j.web?.results || []).map((x) => x.url).filter(Boolean) };
  } catch { return { urls: [], error: 'Brave: ungültige Antwort' }; }
}

async function ddgSearch(fetcher, query) {
  const r = await fetchText(fetcher, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=de-de`);
  if (!r.ok) return { urls: [], error: `DuckDuckGo HTTP ${r.status}` };
  const urls = parseDuckDuckGo(r.text);
  return { urls, error: urls.length ? null : 'DuckDuckGo: keine Treffer (evtl. gedrosselt)' };
}

/** Liefert eindeutige Kandidaten-URLs (max. eine pro Domain). */
export async function searchCandidates(fetcher, env, query, settings, { exclude = [] } = {}) {
  const q = `${query} kaufen`;
  let result = env.BRAVE_API_KEY ? await braveSearch(fetcher, q, env.BRAVE_API_KEY) : { urls: [] };
  if (!result.urls.length) {
    const d = await ddgSearch(fetcher, q);
    result = { urls: d.urls, error: [result.error, d.error].filter(Boolean).join('; ') || null };
  }
  const seen = new Set(exclude);
  const out = [];
  for (const url of result.urls) {
    const d = domainOf(url);
    if (!d || seen.has(d)) continue;
    if (domainMatches(d, NON_SHOP_DOMAINS)) continue;
    seen.add(d);
    out.push({ url, domain: d, blocked: domainMatches(d, settings.blocklist) });
  }
  return { candidates: out, error: result.error };
}
