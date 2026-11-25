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
import { trustpilotViaGoogle } from './search.js';

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

const COMPANY_RE = /\b(gmbh|ag|ug|e\.\s?k\.|kg|ohg|gbr|e\.\s?v\.|ltd\.?|limited|b\.v\.|s\.r\.l\.|sarl|sas|s\.a\.|a\/s|ab|oy|inc\.?|llc|co\.\s?,?\s?ltd|einzelunternehm\w*|inhaber\w*|geschäftsführer\w*|geschaeftsfuehrer\w*|vertreten durch)(?=\W|$)/i;
const ADDRESS_RE = /\b(?:\d{4,5}\s+[A-ZÄÖÜ][a-zäöüß]+|D-\d{5}|A-\d{4}|CH-\d{4})|(?:straße|strasse|str\.|weg|platz|allee|gasse|ring)\s*\d+/i;
const CONTACT_RE = /[\w.+-]+@[\w-]+\.[\w.]+|(?:tel|telefon|phone|fon)\.?\s*:?\s*[+\d(]/i;
const REGISTER_RE = /(handelsregister|registergericht|hrb|hra|ust-?id|umsatzsteuer|steuernummer|vat|mwst|moms|cvr|kvk|kbo|siret|siren|rcs|nip|regon|org\.?\s?nr|organisationsnummer|y-tunnus|company number|companies house|firmenbuch|uid-nr|che-\d)/i;

export function analyseImpressum(text, blocked) {
  const regions = detectRegions(text, blocked);
  const company = COMPANY_RE.test(text);
  const address = ADDRESS_RE.test(text);
  const contact = CONTACT_RE.test(text);
  const register = REGISTER_RE.test(text);
  const COUNTRIES = [['DE', /deutschland|germany/i], ['AT', /österreich|oesterreich|austria/i], ['CH', /schweiz|switzerland/i],
    ['DK', /dänemark|daenemark|denmark|danmark/i], ['NL', /niederlande|netherlands|nederland/i], ['BE', /belgien|belgium|belgique/i],
    ['FR', /frankreich|france/i], ['IT', /italien|italy|italia/i], ['ES', /spanien|spain|españa/i], ['PL', /polen|poland|polska/i],
    ['CZ', /tschechien|czech/i], ['SE', /schweden|sweden|sverige/i], ['LU', /luxemburg|luxembourg/i], ['IE', /irland|ireland/i],
    ['FI', /finnland|finland|suomi/i], ['GB', /großbritannien|united kingdom|england/i]];
  const country = COUNTRIES.find(([, re]) => re.test(text))?.[0] || null;
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
export async function checkShop(domain, fetcher, settings, env = {}) {
  const res = { domain, ok: true, reasons: [], notes: [], trustpilot: null, impressum: null, returns: null, ageDays: null, allowlisted: false, checkedAt: Date.now() };
  const fail = (r) => { res.ok = false; res.reasons.push(r); };

  if (domainMatches(domain, settings.blocklist)) { fail('Auf der Sperrliste'); return res; }
  if (/\.(cn|hk|mo|tw|vn|th|my|id|ph|kh)$/i.test(domain)) { fail('Domain-Endung aus Fernost'); return res; }
  if (domainMatches(domain, settings.allowlist)) {
    res.allowlisted = true;
    res.notes.push('Bekannter Händler – Originaldomain bestätigt');
  } else {
    const fake = lookalikeOf(domain, settings.allowlist);
    if (fake) { fail(`Nachahmer-Domain von ${fake} (Fake-Shop-Verdacht)`); return res; }
  }

  // 1) Trustpilot: direkt (zwei Adressen), sonst über Google (SerpApi)
  let tp = await fetchText(fetcher, `https://de.trustpilot.com/review/${domain}`, { maxBytes: 800_000 });
  if (!tp.ok && tp.status !== 404) tp = await fetchText(fetcher, `https://www.trustpilot.com/review/${domain}`, { maxBytes: 800_000 });
  res.trustpilot = tp.ok ? parseTrustpilot(tp.text) : null;
  let tpUnknown = !tp.ok && tp.status !== 404; // blockiert/Fehler: nichts bekannt
  if (tpUnknown && env.SERPAPI_KEY && env.DB) {
    const g = await trustpilotViaGoogle(fetcher, env, domain);
    if (g?.score != null) { res.trustpilot = g; tpUnknown = false; res.notes.push('Trustpilot-Bewertung über Google ermittelt'); }
  }
  if (!res.allowlisted) {
    if (tpUnknown) {
      if (settings.allowWithoutTrustpilotData) {
        res.strict = true;
        res.notes.push('Trustpilot nicht prüfbar – strengere Prüfung von Impressum, Rückgabe und Domain');
      } else {
        res.retryable = true;
        fail(`Trustpilot nicht erreichbar (HTTP ${tp.status || 'Fehler'}) – neuer Versuch später`);
      }
    } else if (!res.trustpilot) {
      if (settings.requireTrustpilot) fail('Kein Trustpilot-Profil gefunden');
      else res.notes.push('Kein Trustpilot-Profil');
    } else {
      const { score, count } = res.trustpilot;
      if (score < settings.minTrustScore) fail(`Trustpilot ${score.toFixed(1)} (< ${settings.minTrustScore})`);
      if (count != null && count < settings.minReviewCount) fail(`Nur ${count} Trustpilot-Bewertungen`);
    }
  }
  if (!res.ok) return res; // weitere Requests sparen

  // 2) Startseite -> Impressum- und Widerrufs-Links
  const home = await fetchText(fetcher, `https://${domain}/`);
  if (!home.ok) {
    if (!res.allowlisted) { res.retryable = true; fail(`Startseite nicht erreichbar (HTTP ${home.status || 'Fehler'})`); }
    else res.notes.push('Impressum nicht abrufbar (Bot-Schutz) – Echtheit über Originaldomain bestätigt');
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
    else if (res.strict && !res.impressum.register) fail('Ohne Trustpilot-Daten: Impressum ohne Handelsregister/USt-ID');
    else if (res.allowlisted && text) {
      // Bekannter Händler: Betreiber im Impressum muss zur Marke passen
      const brand = brandOf(domain)?.split('-')[0];
      if (brand && !new RegExp(brand.replace(/[^a-z0-9]/g, '.?'), 'i').test(text.replace(/\s+/g, ''))) {
        fail(`Impressum nennt nicht ${brand} als Betreiber – Echtheit fraglich`);
      } else if (brand) res.notes.push('Betreiber im Impressum bestätigt');
    }
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
    for (const i of res.returns.issues) {
      // Bei bekannten Händlern zählt nur die harte Regel (Rücksendung nach Fernost)
      if (!res.allowlisted || /Rücksendung nach/.test(i)) fail(i);
    }
  }
  if (!res.ok) return res;

  // 4) Domain-Alter
  try {
    res.ageDays = await rdapAgeDays(fetcher, domain);
  } catch (e) { if (e instanceof BudgetExceeded) throw e; }
  if (res.ageDays != null && res.ageDays < settings.minDomainAgeDays && !res.allowlisted) {
    fail(`Domain erst ${res.ageDays} Tage alt`);
  }
  if (res.strict && res.ok && res.returns && !res.returns.hasWithdrawal) fail('Ohne Trustpilot-Daten: keine Widerrufsbelehrung');
  return res;
}

/** Markenname aus der Domain: "mediamarkt.de" -> "mediamarkt" */
export function brandOf(domain) {
  const parts = String(domain).toLowerCase().split('.');
  const label = parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2];
  return label || null;
}

// Optimal String Alignment (Tippfehler inkl. vertauschter Buchstaben)
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Marken, die auch normale Wörter/Namen sind -> nur Tippfehler-Regel, keine Wort-Regel
const SUSPICIOUS_TLD = /\.(shop|store|online|top|xyz|site|club|vip|sale|buzz|icu|cfd|sbs|bond|live|life|fun|pro|website|space|click|cyou|monster)$/i;
const GENERIC_BRANDS = new Set(['apple', 'douglas', 'expert', 'bader', 'baur', 'jacob', 'conrad', 'thomann', 'proshop', 'zalando', 'coolblue']);

/**
 * Erkennt Nachahmer-Domains bekannter Händler, z. B. "otto-sale.de", "amaz0n-de.com",
 * "mediamartk.de". Gibt die echte Domain zurück oder null.
 */
export function lookalikeOf(domain, allowlist) {
  const label = brandOf(domain);
  if (!label) return null;
  const norm = (x) => x.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/5/g, 's');
  const tokensOfLabel = label.split(/[-_]+/).map(norm);
  const host = norm(domain.replace(/\.[a-z]+$/, '')).split(/[^a-z]+/);
  for (const real of allowlist) {
    const brand = brandOf(real);
    if (!brand || brand.length < 4 || domain === real) continue;
    // Gleicher Name, andere Endung: nur bei typischen Fake-Endungen verdächtig (otto.at ist echt, otto-de.shop nicht)
    if (norm(label) === brand && (label !== brand || SUSPICIOUS_TLD.test(domain))) return real; // amaz0n.de, otto.shop
    if (!GENERIC_BRANDS.has(brand) && ((tokensOfLabel.length > 1 && tokensOfLabel.includes(brand)) || (host.length > 1 && host.includes(brand)))) return real; // otto-sale.de
    if (brand.length >= 5 && osa(norm(label), brand) === 1) return real;      // mediamartk.de
    const joined = norm(label).replace(/[^a-z]/g, '');
    if (brand.length >= 6 && !GENERIC_BRANDS.has(brand) && joined !== brand && joined.includes(brand)) return real; // media-markt-outlet.de
  }
  return null;
}

/** Mit Cache in KV. */
export async function getShopVerdict(env, domain, fetcher, settings, { force = false } = {}) {
  const key = `shop2:${domain}`;
  if (!force) {
    const cached = await env.DB.get(key, 'json');
    if (cached && Date.now() < (cached.validUntil ?? cached.checkedAt + SHOP_CACHE_DAYS * DAY)) return cached;
  }
  const verdict = await checkShop(domain, fetcher, settings, env);
  // Vorübergehende Fehler 6 h merken, Urteile ohne Trustpilot-Daten 7 Tage, sonst 30 Tage.
  const ttl = verdict.retryable ? 6 * 3600 : verdict.strict ? 7 * 86400 : SHOP_CACHE_DAYS * 86400;
  verdict.validUntil = Date.now() + ttl * 1000;
  await env.DB.put(key, JSON.stringify(verdict), { expirationTtl: ttl });
  return verdict;
}
