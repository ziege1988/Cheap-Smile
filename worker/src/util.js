// Hilfsfunktionen: Fetch mit Budget, Preis-Parsing, Text-Extraktion, Matching.

export const BROWSER_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export class BudgetExceeded extends Error {
  constructor() { super('Subrequest-Budget erschöpft'); this.name = 'BudgetExceeded'; }
}

/**
 * Cloudflare Workers (Free) erlauben 50 Subrequests pro Aufruf.
 * Der Fetcher zählt mit und bricht kontrolliert ab, damit der Cron-Lauf
 * den Rest beim nächsten Durchgang erledigt.
 */
export function createFetcher(fetchImpl, limit = 45) {
  let used = 0;
  const f = async (url, init = {}) => {
    if (used >= limit) throw new BudgetExceeded();
    used++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeout ?? 12000);
    try {
      return await fetchImpl(url, {
        redirect: 'follow',
        ...init,
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          ...(init.headers || {}),
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  f.remaining = () => limit - used;
  f.used = () => used;
  return f;
}

/** HTML laden, auf maxBytes begrenzen. Gibt null bei Fehler zurück. */
export async function fetchText(fetcher, url, { maxBytes = 1_500_000, init } = {}) {
  try {
    const res = await fetcher(url, init);
    if (!res.ok) return { ok: false, status: res.status, text: '', url: res.url || url };
    const text = await readLimited(res, maxBytes);
    return { ok: true, status: res.status, text, url: res.url || url };
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    return { ok: false, status: 0, text: '', url, error: String(e?.message || e) };
  }
}

async function readLimited(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return t.slice(0, maxBytes);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (size >= maxBytes) { try { await reader.cancel(); } catch {} break; }
  }
  return out + decoder.decode();
}

/** "1.299,00 €" -> 1299, "1,299.00" -> 1299, "19,99" -> 19.99 */
export function parsePrice(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // "1,299" (Tausender) vs. "19,99" (Dezimal)
    const decimals = s.length - lastComma - 1;
    s = decimals === 3 && s.indexOf(',') === lastComma ? s.replace(',', '') : s.replace(/,/g, '.');
  } else if (lastDot > -1) {
    const decimals = s.length - lastDot - 1;
    if (decimals === 3 && s.split('.').length === 2 && !/^0\./.test(s)) s = s.replace('.', '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export function domainOf(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.replace(/^(www\d?|m|shop|de)\./, '');
  } catch { return null; }
}

/** Prüft, ob domain == entry oder Subdomain davon ist. */
export function domainMatches(domain, list) {
  if (!domain) return false;
  return list.some((e) => domain === e || domain.endsWith('.' + e));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß' };
export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|tr|section|address)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const href = new URL(decodeEntities(m[1]), baseUrl).toString();
      links.push({ href, text: htmlToText(m[2]).slice(0, 120) });
    } catch {}
  }
  return links;
}

const STOP = new Set(['der', 'die', 'das', 'und', 'mit', 'für', 'fur', 'the', 'and', 'with', 'for', 'von', 'in', 'im', 'kaufen', 'online', 'neu', 'new', 'günstig', 'preis', '-', '–', '|']);

export function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

const ACCESSORY_WORDS = ['hulle', 'case', 'cover', 'tasche', 'ersatz', 'zubehor', 'adapter', 'kabel', 'folie', 'schutzfolie', 'panzerglas', 'ohrpolster', 'halterung', 'ladegerat', 'akku', 'ersatzteil', 'sticker', 'skin'];

/**
 * Wie gut passt ein Seitentitel zum gesuchten Produkt? 0..1
 * Modellnummern (Tokens mit Ziffern) müssen alle vorkommen.
 */
export function matchScore(query, title) {
  const q = tokens(query);
  const t = new Set(tokens(title));
  if (!q.length || !t.size) return 0;
  const modelTokens = q.filter((x) => /\d/.test(x));
  if (modelTokens.some((x) => !t.has(x))) return 0;
  const qset = new Set(q);
  for (const w of ACCESSORY_WORDS) if (t.has(w) && !qset.has(w)) return 0;
  const hit = q.filter((x) => t.has(x)).length;
  return hit / q.length;
}

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const now = () => Date.now();
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export function uid() {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 14);
}
