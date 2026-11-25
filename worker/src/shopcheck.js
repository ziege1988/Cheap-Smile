// Seriositätsprüfung eines Shops:
//  1. Sperr-/Positivliste
//  2. Trustpilot (TrustScore + Anzahl Bewertungen)
//  3. Impressum vorhanden, vollständig, Sitz nicht in Fernost
//  4. Widerrufs-/Rückgabebedingungen angemessen
//  5. Domain-Alter (RDAP), wenn verfügbar
// Ergebnis wird 30 Tage in KV zwischengespeichert.

import { REGION_PATTERNS, SHOP_CACHE_DAYS } from './config.js';
import { fetchText, extractLinks, htmlToText, domainMatches, parsePrice, DAY, BudgetExceeded } from './util.js';
import { extractJsonLd } from './extract.js';

export function detectRegions(text, blocked) {
  const hits = [];
  for (const code of blocked) {
    const re = REGION_PATTERNS[code];
    if (re && re.test(text)) hits.push(code);
  }
  return hits;
}

/** Trustpilot-Profilseite auswerten (JSON-LD oder Next.js-Daten). */
export function parseTrustpilot(html) {
  let score = null, count = null, name = null;
  for (const root of extractJsonLd(html)) {
    const nodes = [].concat(root?.['@graph'] || root);
    for (const n of nodes) {
      const ar = n?.aggregateRating;
      if (ar && score == null) {
        score = parseFloat(ar.ratingValue);
        count = parseInt(ar.reviewCount ?? ar.ratingCount, 10);
        name = n.name || null;
      }
    }
  }
  if (score == null) {
    const ts = html.match(/"trustScore"\s*:\s*([\d.]+)/);
    const nr = html.match(/"numberOfReviews"\s*:\s*(?:\{\s*"total"\s*:\s*)?(\d+)/);
    if (ts) score = parseFloat(ts[1]);
    if (nr) count = parseInt(nr[1], 10);
  }
  if (score == null || !Number.isFinite(score)) return null;
  return { score, count: Number.isFinite(count) ? count : 0, name };
}

const IMPRESSUM_RE = /impressum|imprint|legal[-_\s]?notice|anbieterkennzeichnung|rechtliche[-_\s]?hinweise/i;
const RETURNS_RE = /widerruf|rückgabe|rueckgabe|ruecksendung|rücksendung|retoure|returns?|umtausch/i;
const AGB_RE = /\bagb\b|allgemeine[-_\s]geschäftsbedingungen|terms/i;

function pickLink(links, re, domain) {
  const own = links.filter((l) => { try { return new URL(l.href).hostname.endsWith(domain); } catch { return false; } });
  return own.find((l) => re.test(l.text)) || own.find((l) => re.test(l.href)) || null;
}

const COMPANY_RE = /\b(gmbh|ag|ug|e\.\s?k\.|kg|ohg|gbr|e\.\s?v\.|ltd\.?|limited|b\.v\.|s\.r\.l\.|sarl|sas|s\.a\.|a\/s|ab|oy|inc\.?|llc|co\.\s?,?\s?ltd|einzelunternehm|inhaber|geschäftsführer|geschaeftsfuehrer|vertreten durch)\b/i;
const ADDRESS_RE = /\b(?:\d{4,5}\s+[A-ZÄÖÜ][a-zäöüß]+|D-\d{5}|A-\d{4}|CH-\d{4})|(?:straße|strasse|str\.|weg|platz|allee|gasse|ring)\s*\d+/i;
const CONTACT_RE = /[\w.+-]+@[\w-]+\.[\w.]+|(?:tel|telefon|phone|fon)\.?\s*:?\s*[+\d(]/i;
const REGISTER_RE = /(handelsregister|registergericht|hrb|hra|ust-?id|umsatzsteuer|vat|kvk|company number|firmenbuch)/i;

export function analyseImpressum(text, blocked) {
  const regions = detectRegions(text, blocked);
  const company = COMPANY_RE.test(text);
  const address = ADDRESS_RE.test(text);
  const contact = CONTACT_RE.test(text);
  const register = REGISTER_RE.test(text);
  const country = /deutschland|germany/i.test(text) ? 'DE'
    : /österreich|oesterreich|austria/i.test(text) ? 'AT'
    : /schweiz|switzerland/i.test(text) ? 'CH' : null;
  return { regions, company, address, contact, register, country, complete: company && address && contact };
}

export function analyseReturns(text, blocked, settings) {
  const t = text.replace(/\s+/g, ' ');
  const issues = [];
  const hasWithdrawal = /widerruf|right of withdrawal|cancellation right|rückgaberecht|rueckgaberecht/i.test(t);
  if (!hasWithdrawal) issues.push('Keine Widerrufsbelehrung gefunden');

  let days = null;
  const WORDS = { sieben: 7, zehn: 10, vierzehn: 14, zwanzig: 20, dreißig: 30, dreissig: 30, sechzig: 60, neunzig: 90, hundert: 100, seven: 7, fourteen: 14, thirty: 30 };
  const dm = t.match(/(?:widerrufsfrist|rückgabefrist|rueckgabefrist|rückgaberecht|innerhalb von|binnen|within)[^.\d]{0,30}?\b(\d{1,3}|sieben|zehn|vierzehn|zwanzig|dreißig|dreissig|sechzig|neunzig|hundert|seven|fourteen|thirty)\s*(?:tagen|tage|days)/i);
  if (dm) days = /\d/.test(dm[1]) ? parseInt(dm[1], 10) : WORDS[dm[1].toLowerCase()];
  if (days != null && days < settings.minWithdrawalDays) issues.push(`Widerrufsfrist nur ${days} Tage`);

  if (/vom umtausch ausgeschlossen|keine rücknahme|keine ruecknahme|no returns accepted|returns are not accepted|kein rückgaberecht/i.test(t)) {
    issues.push('Rückgabe ausgeschlossen');
  }
  if (/(wiedereinlagerungs|bearbeitungs|restocking)[-\s]?(gebühr|gebuehr|fee)/i.test(t)) {
    issues.push('Wiedereinlagerungs-/Bearbeitungsgebühr bei Rücksendung');
  }

  // Rücksendeadresse in Fernost?
  const returnParts = t.match(/[^.]{0,200}(rücksend|ruecksend|zurück(?:zu)?send|zurueck(?:zu)?send|senden sie [^.]{0,60}?zur(?:ü|ue)ck|retoure|return address|return to|send (?:it|them|the goods|items?) back)[^.]{0,300}/gi) || [];
  const returnRegions = detectRegions(returnParts.join(' '), blocked);
  if (returnRegions.length) issues.push(`Rücksendung nach ${returnRegions.join('/')}`);

  // Rücksendekosten in Euro (Verhältnis wird pro Angebot geprüft)
  let returnCost = null;
  const rc = t.match(/(?:rücksendekosten|ruecksendekosten|rückversandkosten|kosten der rücksendung|kosten der rücksendung|return shipping)[^.]{0,100}?(\d+[.,]\d{2})\s*(?:€|eur)/i);
  if (rc) returnCost = parsePrice(rc[1]);
  const buyerPays = /(kosten der rücksendung|rücksendekosten|unmittelbaren kosten der rücksendung)[^.]{0,80}(tragen sie|trägt der käufer|trägt der kunde|vom kunden zu tragen)/i.test(t);

  return { hasWithdrawal, days, returnCost, buyerPays, issues };
}

export async function rdapAgeDays(fetcher, domain) {
  const r = await fetchText(fetcher, `https://rdap.org/domain/${domain}`, { maxBytes: 200_000, init: { headers: { Accept: 'application/rdap+json, application/json' } } });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.text);
    const reg = (j.events || []).find((e) => e.eventAction === 'registration');
    if (!reg?.eventDate) return null;
    return Math.floor((Date.now() - Date.parse(reg.eventDate)) / DAY);
  } catch { return null; }
}

/**
 * Vollständige Prüfung (ohne Cache).
 * @returns {{domain, ok, reasons: string[], notes: string[], trustpilot, impressum, returns, ageDays, checkedAt}}
 */
export async function checkShop(domain, fetcher, settings) {
  const res = { domain, ok: true, reasons: [], notes: [], trustpilot: null, impressum: null, returns: null, ageDays: null, allowlisted: false, checkedAt: Date.now() };
  const fail = (r) => { res.ok = false; res.reasons.push(r); };

  if (domainMatches(domain, settings.blocklist)) { fail('Auf der Sperrliste'); return res; }
  if (/\.(cn|hk|mo|tw|vn|th|my|id|ph|kh)$/i.test(domain)) { fail('Domain-Endung aus Fernost'); return res; }
  if (domainMatches(domain, settings.allowlist)) {
    res.allowlisted = true;
    res.notes.push('Bekannter Händler (Positivliste)');
  }

  // 1) Trustpilot
  const tp = await fetchText(fetcher, `https://de.trustpilot.com/review/${domain}`, { maxBytes: 800_000 });
  res.trustpilot = tp.ok ? parseTrustpilot(tp.text) : null;
  const tpUnreachable = !tp.ok && tp.status !== 404;
  if (!res.allowlisted) {
    if (tpUnreachable) {
      res.retryable = true;
      fail(`Trustpilot nicht erreichbar (HTTP ${tp.status || 'Fehler'}) – neuer Versuch später`);
    } else if (!res.trustpilot) {
      if (settings.requireTrustpilot) fail('Kein Trustpilot-Profil gefunden');
      else res.notes.push('Kein Trustpilot-Profil');
    } else {
      const { score, count } = res.trustpilot;
      if (score < settings.minTrustScore) fail(`Trustpilot ${score.toFixed(1)} (< ${settings.minTrustScore})`);
      if (count < settings.minReviewCount) fail(`Nur ${count} Trustpilot-Bewertungen`);
    }
  }
  if (!res.ok) return res; // weitere Requests sparen

  // 2) Startseite -> Impressum- und Widerrufs-Links
  const home = await fetchText(fetcher, `https://${domain}/`);
  if (!home.ok) {
    if (!res.allowlisted) { res.retryable = true; fail(`Startseite nicht erreichbar (HTTP ${home.status || 'Fehler'})`); }
    return res;
  }
  const links = extractLinks(home.text, home.url);

  const impLink = pickLink(links, IMPRESSUM_RE, domain);
  if (!impLink) {
    if (!res.allowlisted) fail('Kein Impressum gefunden');
  } else {
    const imp = await fetchText(fetcher, impLink.href);
    const text = imp.ok ? htmlToText(imp.text) : '';
    res.impressum = { url: impLink.href, ...analyseImpressum(text, settings.blockedRegions) };
    if (res.impressum.regions.length) fail(`Firmensitz in Fernost (${res.impressum.regions.join('/')})`);
    else if (!res.allowlisted && !res.impressum.complete) fail('Impressum unvollständig (Firma/Adresse/Kontakt fehlt)');
  }
  if (!res.ok) return res;

  // 3) Rückgabe / Widerruf
  const retLink = pickLink(links, RETURNS_RE, domain) || pickLink(links, AGB_RE, domain);
  if (!retLink) {
    if (!res.allowlisted) fail('Keine Widerrufs-/Rückgabeinformationen gefunden');
  } else {
    const ret = await fetchText(fetcher, retLink.href);
    const text = ret.ok ? htmlToText(ret.text) : '';
    res.returns = { url: retLink.href, ...analyseReturns(text, settings.blockedRegions, settings) };
    if (!res.allowlisted) for (const i of res.returns.issues) fail(i);
  }
  if (!res.ok) return res;

  // 4) Domain-Alter
  try {
    res.ageDays = await rdapAgeDays(fetcher, domain);
  } catch (e) { if (e instanceof BudgetExceeded) throw e; }
  if (res.ageDays != null && res.ageDays < settings.minDomainAgeDays && !res.allowlisted) {
    fail(`Domain erst ${res.ageDays} Tage alt`);
  }
  return res;
}

/** Mit Cache in KV. */
export async function getShopVerdict(env, domain, fetcher, settings, { force = false } = {}) {
  const key = `shop:${domain}`;
  if (!force) {
    const cached = await env.DB.get(key, 'json');
    if (cached && Date.now() < (cached.validUntil ?? cached.checkedAt + SHOP_CACHE_DAYS * DAY)) return cached;
  }
  const verdict = await checkShop(domain, fetcher, settings);
  // Vorübergehende Fehler nur 6 h merken, echte Urteile 30 Tage.
  const ttl = verdict.retryable ? 6 * 3600 : SHOP_CACHE_DAYS * 86400;
  verdict.validUntil = Date.now() + ttl * 1000;
  await env.DB.put(key, JSON.stringify(verdict), { expirationTtl: ttl });
  return verdict;
}
