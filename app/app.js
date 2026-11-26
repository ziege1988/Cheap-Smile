// Cheap Smile – Frontend (PWA)
const APP_VERSION = '__VERSION__';

// ---------- Konfiguration (pro Gerät) ----------
const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const cfg = {
  get apiBase() { return (store.get('apiBase') || window.CHEAP_SMILE_API || '').replace(/\/+$/, ''); },
  get token() { return store.get('token') || ''; },
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => (n == null ? '–' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.toString() : '#'; } catch { return '#'; } };

let products = [];
let pollTimer = null;
let quota = null; // Stand des Suchkontingents (SerpApi)

const fmtDate = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
const amazonPaused = () => !!quota?.enabled && (quota.exhausted || quota.pausedToday);
function quotaText() {
  if (!quota?.enabled) return '';
  if (quota.exhausted) return `Suchkontingent aufgebraucht – Amazon-Abfragen und die Suche nach neuen Shops pausieren bis ${fmtDate(quota.resetDate)}. Bekannte Shops werden weiter geprüft. Es entstehen keine Kosten.`;
  if (quota.pausedToday) return 'Amazon-Abfragen sind für heute pausiert – das Monatskontingent wird gleichmäßig verteilt. Morgen geht es automatisch weiter.';
  return '';
}

async function loadQuota() {
  try { quota = await api('/api/quota'); } catch { quota = null; }
}

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  if (!cfg.apiBase) throw new Error('Bitte zuerst die API-Adresse in den Einstellungen eintragen.');
  const res = await fetch(cfg.apiBase + path, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

// ---------- UI-Helfer ----------
function toast(msg, ms = 2200) {
  const t = $('#toast');
  // Offene Fenster (dialog) liegen über allem – Meldung dort hinein verschieben, sonst ist sie unsichtbar
  const host = document.querySelector('dialog[open]') || document.body;
  if (t.parentElement !== host) host.append(t);
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(`„${text}“ kopiert`);
}

function open(id) { const d = document.getElementById(`sheet-${id}`); if (!d.open) d.showModal(); }
function close(id) { document.getElementById(`sheet-${id}`).close(); }

function shippingText(o) {
  if (!o) return '';
  if (o.shipping === 0) return 'versandkostenfrei';
  if (o.shippingEstimated) return `inkl. ~${eur(o.shipping)} Versand (geschätzt)`;
  return `inkl. ${eur(o.shipping)} Versand`;
}
const cap = (t) => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);
const condLabel = (c) => ({ used: 'Gebraucht', refurbished: 'Refurbished', new: 'Neu' }[c] || c);
const trustText = (s) => {
  if (s?.amazonRating != null) return `★ ${s.amazonRating.toFixed(1)} (${(s.amazonReviews || 0).toLocaleString('de-DE')} Bewertungen)`;
  if (s?.allowlisted) return s.verified ? '✓ geprüfter bekannter Händler' : '✓ bekannter Händler';
  if (s?.trustScore != null) return `★ ${s.trustScore.toFixed(1)}${s.trustCount != null ? ` (${s.trustCount.toLocaleString('de-DE')})` : ''} Trustpilot`;
  if (s?.trustUnknown) return '✓ geprüfter Shop';
  return '';
};

/** Grünes Vertrauens-Abzeichen für die Kachel */
function trustBadge(s) {
  if (!s) return '';
  if (s.amazonRating != null) return `<span class="badge wish">★ ${s.amazonRating.toFixed(1)} bei Amazon (${(s.amazonReviews || 0).toLocaleString('de-DE')})</span>`;
  if (s.allowlisted) return '<span class="badge wish">✓ Bekannter Händler</span>';
  if (s.trustScore != null) return `<span class="badge wish">★ ${s.trustScore.toFixed(1)} Trustpilot · geprüft</span>`;
  if (s.trustUnknown) return '<span class="badge wish">✓ Geprüfter Shop</span>';
  return '<span class="badge wish">✓ Geprüft</span>';
}

/** Was wurde geprüft? (Details) */
function checksText(s) {
  const c = s?.checks;
  if (!c) return '';
  const parts = [];
  if (c.impressum) parts.push('Impressum ✓');
  if (c.register) parts.push('Handelsregister/USt-ID ✓');
  if (c.withdrawal) parts.push(`${c.withdrawalDays || 14} Tage Widerruf ✓`);
  if (c.country) parts.push(`Sitz ${c.country}`);
  if (c.ageYears) parts.push(`Domain ${c.ageYears} Jahr${c.ageYears === 1 ? '' : 'e'}`);
  if (s.trustUnknown) parts.push('Trustpilot nicht abrufbar');
  return parts.join(' · ');
}

function relTime(ts) {
  if (!ts) return 'noch nie';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.round(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  return `vor ${Math.round(h / 24)} Tg.`;
}

// ---------- Übersicht ----------
function badgesFor(p) {
  const b = [];
  const best = p.best;
  if (p.pending || p.queued) b.push(`<span class="badge warn">⏳ ${p.queued ? `Noch ${p.queued} Shop${p.queued === 1 ? '' : 's'} in Prüfung` : 'Shops werden geprüft…'}</span>`);
  else if (!best && !p.queued) b.push('<span class="badge warn">Kein seriöses Angebot gefunden</span>');
  if (best && p.wishPrice != null && best.effectiveTotal <= p.wishPrice) b.push('<span class="badge wish">🎯 Wunschpreis erreicht</span>');
  if (best?.discountPct) b.push(`<span class="badge hot">🔥 Aktion −${best.discountPct} %</span>`);
  if (best && best.condition !== 'new') b.push(`<span class="badge gold">${condLabel(best.condition)}</span>`);
  if (best) b.push(trustBadge(best.shop));
  if (p.includeAmazon && (amazonPaused() || (p.offers || []).some((o) => o.source === 'amazon' && o.quotaStale))) {
    b.push('<span class="badge warn">Amazon pausiert</span>');
  }
  return b.join('');
}

function tileHtml(p) {
  const best = p.best;
  const coupon = best?.coupons?.[0];
  const progress = best && p.wishPrice ? Math.max(4, Math.min(100, (p.wishPrice / best.effectiveTotal) * 100)) : 0;
  return `
  <article class="tile" data-id="${esc(p.id)}">
    <div class="tile-top" data-action="detail">
      <div class="thumb">${p.image ? `<img src="${esc(safeUrl(p.image))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'🛍️'}))">` : '<span>🛍️</span>'}</div>
      <div class="tile-info">
        <div class="tile-name">${esc(p.name)}</div>
        ${p.color || p.size ? `<div class="sub">${[p.color ? cap(p.color) : '', p.size ? `Größe ${esc(p.size)}` : ''].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        ${best
          ? `<div class="price">${eur(best.effectiveTotal)}</div>
             <div class="sub">${best.oldPrice ? `<span class="old">${eur(best.oldPrice)}</span>` : ''}${esc(shippingText(best))}</div>
             <div class="sub">bei <strong>${esc(best.shopName || best.domain)}</strong></div>`
          : `<div class="price ${p.pending ? 'skeleton' : ''}">${p.pending ? '000,00 €' : '–'}</div>
             <div class="sub">${p.pending ? 'Suche läuft' : esc(p.amazonError || p.lastError || p.searchError || 'Noch kein passender Shop')}</div>`}
      </div>
    </div>
    <div class="badges">${badgesFor(p)}</div>
    ${coupon ? `<button class="coupon" data-action="copy" data-code="${esc(coupon.code)}"><span>Code <code>${esc(coupon.code)}</code>${coupon.percent ? ` · −${coupon.percent} %` : coupon.amount ? ` · −${eur(coupon.amount)}` : ''}</span><span class="copy">Kopieren</span></button>` : ''}
    ${p.wishPrice != null ? `<div class="wishbar">Wunschpreis ${eur(p.wishPrice)}${best ? ` · ${best.effectiveTotal <= p.wishPrice ? 'erreicht ✓' : `noch ${eur(best.effectiveTotal - p.wishPrice)}`}` : ''}<div class="bar"><i style="width:${progress}%"></i></div></div>` : ''}
    <div class="tile-actions">
      <label class="used-toggle"><input type="checkbox" class="switch sm" data-action="used" ${p.allowUsed ? 'checked' : ''}> Gebraucht</label>
      <button class="icon-btn" data-action="delete" aria-label="Entfernen" title="Entfernen">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      ${best ? `<a class="btn primary small" href="${esc(safeUrl(best.url))}" target="_blank" rel="noopener noreferrer">Zum Shop ↗</a>` : ''}
    </div>
  </article>`;
}

function render() {
  const grid = $('#grid');
  grid.innerHTML = products.map(tileHtml).join('');
  $('#empty').hidden = products.length > 0 || !cfg.apiBase;
  const hits = products.filter((p) => p.best && p.wishPrice != null && p.best.effectiveTotal <= p.wishPrice).length;
  $('#subtitle').textContent = products.length
    ? `${products.length} Produkt${products.length === 1 ? '' : 'e'}${hits ? ` · ${hits} × Wunschpreis` : ''}`
    : 'Deine Preisalarme';
}

async function load({ silent = false } = {}) {
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  try {
    [products] = await Promise.all([api('/api/products'), loadQuota()]);
    render();
    updateBanner();
    schedulePoll();
  } catch (e) {
    if (!silent) toast(e.message, 3500);
  } finally {
    btn.classList.remove('spin');
  }
}

/** Solange ein Produkt noch geprüft wird, regelmäßig nachladen. */
function schedulePoll() {
  clearTimeout(pollTimer);
  if (products.some((p) => p.pending)) pollTimer = setTimeout(() => load({ silent: true }), 5000);
}

// ---------- Details ----------
function chartSvg(p) {
  const key = p.allowUsed ? 'a' : 'n';
  const pts = (p.history || []).filter((h) => h[key] != null);
  if (pts.length < 2) return '<p class="hint muted">Preisverlauf erscheint nach einigen Prüfungen.</p>';
  const W = 600, H = 130, pad = 6;
  const xs = pts.map((h) => h.t), ys = pts.map((h) => h[key]);
  const lines = p.wishPrice != null ? [...ys, p.wishPrice] : ys;
  const minY = Math.min(...lines) * 0.97, maxY = Math.max(...lines) * 1.03;
  const x = (t) => pad + ((t - xs[0]) / Math.max(1, xs[xs.length - 1] - xs[0])) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - minY) / Math.max(0.01, maxY - minY)) * (H - 2 * pad);
  const d = pts.map((h, i) => `${i ? 'L' : 'M'}${x(h.t).toFixed(1)},${y(h[key]).toFixed(1)}`).join(' ');
  const area = `${d} L${x(xs[xs.length - 1]).toFixed(1)},${H} L${x(xs[0]).toFixed(1)},${H} Z`;
  const wish = p.wishPrice != null ? `<line x1="0" x2="${W}" y1="${y(p.wishPrice)}" y2="${y(p.wishPrice)}" stroke="var(--warn)" stroke-dasharray="6 5" stroke-width="1.5"/>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Preisverlauf">
    <path d="${area}" fill="var(--brand-soft)"/>${wish}
    <path d="${d}" fill="none" stroke="var(--brand)" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>
  <div class="chart-legend"><span>${new Date(xs[0]).toLocaleDateString('de-DE')}</span><span>min ${eur(Math.min(...ys))} · max ${eur(Math.max(...ys))}</span><span>heute</span></div>`;
}

function offerHtml(o, p, isBest) {
  const ok = !o.excludedReason && !o.stale && o.available !== false && (p.allowUsed || o.condition === 'new');
  const why = o.excludedReason || (o.stale ? 'Seite aktuell nicht erreichbar' : o.available === false ? 'Nicht lieferbar' : !p.allowUsed && o.condition !== 'new' ? `${condLabel(o.condition)} – ausgeblendet` : '');
  const c = o.coupons?.[0];
  return `<div class="offer ${isBest ? 'best' : ''} ${ok ? '' : 'dim'}">
    <div class="offer-head"><span class="offer-shop">${esc(o.shopName || o.domain)}</span><span class="offer-total">${eur(o.effectiveTotal ?? o.total)}</span></div>
    <div class="offer-meta">
      <span>${eur(o.price)} + ${o.shipping === 0 ? 'gratis Versand' : `${eur(o.shipping)} Versand${o.shippingEstimated ? ' (geschätzt)' : ''}`}</span>
      ${o.freeShippingFrom ? `<span>versandfrei ab ${eur(o.freeShippingFrom)}</span>` : ''}
      <span>${condLabel(o.condition)}</span>
      ${o.discountPct ? `<span>−${o.discountPct} % (statt ${eur(o.oldPrice)})</span>` : ''}
      ${o.shop ? `<span>${esc(trustText(o.shop))}</span>` : ''}
      ${o.shop?.allowlisted && o.shop?.trustScore != null ? `<span>Trustpilot ★ ${o.shop.trustScore.toFixed(1)}</span>` : ''}
      ${o.seller ? `<span>Verkäufer: ${esc(o.seller)}</span>` : ''}
      ${checksText(o.shop) ? `<span style="color:var(--brand)">Geprüft: ${esc(checksText(o.shop))}</span>` : `${o.shop?.country ? `<span>Sitz: ${esc(o.shop.country)}</span>` : ''}${o.shop?.withdrawalDays ? `<span>${o.shop.withdrawalDays} Tage Widerruf</span>` : ''}`}
      ${o.matchedBy ? `<span>Abgleich: ${esc(o.matchedBy)}</span>` : ''}
      ${o.quotaStale ? `<span style="color:var(--warn)">Preis vom ${new Date(o.checkedAt).toLocaleDateString('de-DE')} – Suchkontingent erreicht</span>` : ''}
      ${o.matchNote ? `<span style="color:var(--warn)">⚠️ ${esc(o.matchNote)}</span>` : ''}
      ${why ? `<span style="color:var(--hot)">${esc(why)}</span>` : ''}
    </div>
    <div class="offer-actions">
      ${c ? `<button class="btn small ghost" data-action="copy" data-code="${esc(c.code)}">Code ${esc(c.code)} kopieren</button>` : ''}
      <a class="btn small ${isBest ? 'primary' : ''}" href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener noreferrer">Zum Shop ↗</a>
    </div>
  </div>`;
}

/** Auswahl von Farbe/Größe: Listen aus dem Shop-Link, sonst freie Eingabe */
function variantPicker(p) {
  const o = p.variantOptions || { colors: [], sizes: [], combos: [] };
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const sel = (name, label, list, value, allLabel) => list.length
    ? `<label class="field"><span>${label}</span><select name="${name}" class="select">
        <option value="">${allLabel}</option>
        ${list.map((v) => `<option value="${esc(v)}" ${same(value, v) ? 'selected' : ''}>${esc(cap(v))}</option>`).join('')}
      </select></label>`
    : `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value || '')}" placeholder="${allLabel} (frei eintragen)" autocomplete="off"></label>`;
  const none = !o.colors.length && !o.sizes.length;
  return `<form id="form-variant" style="margin-top:14px">
    <div class="two">
      ${sel('color', 'Farbe', o.colors, p.color, 'Alle Farben')}
      ${sel('size', 'Größe', o.sizes, p.size, 'Alle Größen')}
    </div>
    <p class="hint muted" id="variant-info"></p>
    <button class="btn small" style="margin-top:6px">Variante übernehmen</button>
    ${none ? `<p class="hint muted">${p.asin ? 'Die Amazon-Abfrage liefert keine Variantenliste – Farbe/Größe bitte frei eintragen.' : 'Im Shop-Link wurden keine Auswahlmöglichkeiten erkannt – Farbe/Größe kannst du frei eintragen.'}</p>` : ''}
  </form>`;
}

/** Größenliste an die gewählte Farbe anpassen; Preis und Verfügbarkeit der Variante anzeigen. */
function wireVariantPicker(p) {
  const form = $('#form-variant');
  const o = p.variantOptions || { combos: [] };
  const combos = o.combos || [];
  const cSel = form.querySelector('select[name=color]');
  const sSel = form.querySelector('select[name=size]');
  const info = $('#variant-info');
  const low = (x) => String(x || '').toLowerCase();
  const refresh = () => {
    const c = cSel ? cSel.value : form.color?.value;
    const z = sSel ? sSel.value : form.size?.value;
    if (sSel && combos.length) {
      for (const opt of sSel.options) {
        if (!opt.value) continue;
        const hits = combos.filter((k) => low(k.s) === low(opt.value) && (!c || low(k.c) === low(c)));
        const label = cap(opt.value);
        opt.disabled = !!c && hits.length === 0;
        opt.textContent = !hits.length ? (c ? `${label} – in dieser Farbe nicht vorhanden` : label)
          : hits.every((k) => !k.ok) ? `${label} – ausverkauft` : label;
      }
      if (sSel.selectedOptions[0]?.disabled) sSel.value = '';
    }
    const match = combos.filter((k) => (!c || low(k.c) === low(c)) && (!z || low(k.s) === low(sSel ? sSel.value : z)));
    if ((c || z) && match.length) {
      const prices = match.map((k) => k.price).filter((x) => x != null);
      const min = prices.length ? Math.min(...prices) : null;
      info.textContent = `${match.length === 1 ? 'Diese Variante' : `${match.length} passende Varianten`}${min != null ? ` · beim Hersteller ab ${eur(min)}` : ''}${match.every((k) => !k.ok) ? ' · derzeit ausverkauft' : ''}`;
    } else info.textContent = '';
  };
  cSel?.addEventListener('change', refresh);
  sSel?.addEventListener('change', refresh);
  refresh();
}

function renderDetail(p) {
  $('#d-title').textContent = p.name;
  const offers = [...(p.offers || [])].sort((a, b) => (a.effectiveTotal ?? 1e9) - (b.effectiveTotal ?? 1e9));
  const bestUrl = p.best?.url;
  $('#d-body').innerHTML = `
    <div class="d-hero">
      <div class="thumb">${p.image ? `<img src="${esc(safeUrl(p.image))}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'🛍️'}))">` : '<span>🛍️</span>'}</div>
      <div>
        <div class="price">${eur(p.best?.effectiveTotal)} <small>inkl. Versand</small></div>
        <div class="sub">Zuletzt geprüft ${relTime(p.lastCheckAt)}</div>
        <div class="badges" style="padding:6px 0 0">${badgesFor(p)}</div>
      </div>
    </div>
    ${chartSvg(p)}
    <form class="d-edit" id="form-wish" style="margin-top:14px">
      <label class="field"><span>Wunschpreis (€)</span><input name="wishPrice" inputmode="decimal" value="${p.wishPrice ?? ''}" placeholder="kein Wunschpreis"></label>
      <button class="btn">Speichern</button>
    </form>
    ${variantPicker(p)}
    <label class="switch-row"><span><strong>Gebrauchte Artikel erlauben</strong><small class="muted">Gebraucht, refurbished, B-Ware</small></span>
      <input type="checkbox" class="switch" id="d-used" ${p.allowUsed ? 'checked' : ''}></label>
    <label class="switch-row"><span><strong>Amazon einbeziehen</strong><small class="muted">${p.includeAmazon ? (p.lastAmazonAt ? `Zuletzt abgefragt ${relTime(p.lastAmazonAt)}` : 'Wird beim nächsten Lauf abgefragt') : 'Aus – spart Suchkontingent'}${p.amazonError && !amazonPaused() ? ` · ${esc(p.amazonError)}` : ''}</small>${p.includeAmazon && amazonPaused() ? `<small style="color:var(--warn);display:block;margin-top:4px">⚠️ Kann aktuell nicht bei Amazon anfragen: ${esc(quotaText())}</small>` : ''}</span>
      <input type="checkbox" class="switch" id="d-amazon" ${p.includeAmazon ? 'checked' : ''}></label>
    <h3>Angebote (${offers.length})</h3>
    ${offers.length ? offers.map((o) => offerHtml(o, p, o.url === bestUrl)).join('') : '<p class="muted">Noch keine geprüften Angebote.</p>'}
    <p class="hint muted">Gesuchter Artikel: ${[p.brand, p.gtin ? `EAN ${p.gtin}` : '', p.mpn ? `Art.-Nr. ${p.mpn}` : '', p.color ? `Farbe ${p.color}` : '', p.size ? `Größe ${p.size}` : ''].filter(Boolean).map(esc).join(' · ') || 'nur Bezeichnung'}. Andere Shops zählen nur bei gleicher EAN – oder, wenn ein Shop keine EAN angibt, bei gleicher Marke, Bezeichnung, Farbe und Größe.</p>
    ${p.variantHint ? `<p class="hint muted">${esc(p.variantHint)}</p>` : ''}
    ${p.queued ? `<p class="hint muted">⏳ Noch ${p.queued} gefundene Shop-Seite(n) in der Warteschlange – werden bei den nächsten Läufen (alle 30 Min.) geprüft.</p>` : ''}
    ${p.nameFromSlug ? '<p class="hint muted">Name vorläufig aus der Adresse gelesen, weil der Shop automatische Abrufe blockiert.</p>' : ''}
    ${p.asin ? `<p class="hint muted">Amazon-Artikel ${esc(p.asin)} – Abfrage über SerpApi, Bewertung nach Amazon-Produktbewertungen.</p>` : ''}
    ${p.searchSource ? `<p class="hint muted">Gesucht über ${({ google: 'Google', brave: 'Brave', duckduckgo: 'DuckDuckGo' })[p.searchSource] || esc(p.searchSource)}</p>` : ''}
    ${p.searchError ? `<p class="hint muted">Suche: ${esc(p.searchError)}</p>` : ''}
    ${p.skipped?.length ? `<details class="excluded"><summary>Gefunden, aber nicht derselbe Artikel (${p.skipped.length})</summary>
      ${p.skipped.map((x) => `<div class="ex-item"><b>${esc(x.domain)}</b>${esc(x.why)} · <a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener noreferrer">Seite ansehen ↗</a></div>`).join('')}</details>` : ''}
    ${p.candidatesFound === 0 ? '<p class="hint muted">Die Suche hat keine weiteren Shop-Seiten geliefert.</p>' : ''}
    ${p.excluded?.length ? `<details class="excluded"><summary>Ausgeschlossene Shops (${p.excluded.length})</summary>
      ${p.excluded.map((e) => `<div class="ex-item"><b>${esc(e.domain)}</b>${e.reasons.map(esc).join(' · ')}</div>`).join('')}</details>` : ''}
    <div class="row gap" style="margin-top:20px">
      <button class="btn" id="d-refresh">Jetzt neu prüfen</button>
      <button class="btn danger" id="d-delete">Entfernen</button>
    </div>`;

  $('#form-wish').onsubmit = async (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get('wishPrice');
    await update(p.id, { wishPrice: v ? String(v).replace(',', '.') : null });
    toast('Wunschpreis gespeichert');
  };
  $('#d-used').onchange = (e) => update(p.id, { allowUsed: e.target.checked });
  wireVariantPicker(p);
  $('#form-variant').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await update(p.id, { color: String(f.get('color') || '').trim() || null, size: String(f.get('size') || '').trim() || null });
    toast('Variante übernommen – Shops werden neu geprüft …', 3500);
    setTimeout(() => load({ silent: true }), 15000);
    setTimeout(() => load({ silent: true }), 40000);
  };
  $('#d-amazon').onchange = (e) => {
    update(p.id, { includeAmazon: e.target.checked });
    if (e.target.checked && amazonPaused()) toast(`Eingeschaltet – Amazon kann aktuell aber nicht abgefragt werden. ${quotaText()}`, 6000);
    else toast(e.target.checked ? 'Amazon wird jetzt abgefragt …' : 'Amazon ausgeschaltet');
    if (e.target.checked) setTimeout(() => load({ silent: true }), 15000);
  };
  $('#d-delete').onclick = () => remove(p.id);
  $('#d-refresh').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Prüfe…';
    try {
      const r = await api(`/api/products/${p.id}/refresh`, { method: 'POST' });
      replace(r.product);
      toast('Aktualisiert');
    } catch (err) { toast(err.message, 3500); e.target.disabled = false; e.target.textContent = 'Jetzt neu prüfen'; }
  };
}

function showDetail(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  renderDetail(p);
  open('detail');
}

function replace(p) {
  const i = products.findIndex((x) => x.id === p.id);
  if (i >= 0) products[i] = p; else products.unshift(p);
  render();
  if ($('#sheet-detail').open && $('#d-title').textContent && $('#sheet-detail').dataset.id === p.id) renderDetail(p);
}

async function update(id, patch) {
  try { replace(await api(`/api/products/${id}`, { method: 'PATCH', body: patch })); }
  catch (e) { toast(e.message, 3500); load({ silent: true }); }
}

async function remove(id) {
  const p = products.find((x) => x.id === id);
  if (!confirm(`„${p?.name}“ entfernen? Der Preisalarm wird ebenfalls gelöscht.`)) return;
  try {
    await api(`/api/products/${id}`, { method: 'DELETE' });
    products = products.filter((x) => x.id !== id);
    render();
    if ($('#sheet-detail').open) close('detail');
    toast('Entfernt – Alarm gelöscht');
  } catch (e) { toast(e.message, 3500); }
}

// ---------- Ereignisse ----------
document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open]');
  if (opener) { if (opener.dataset.open === 'add' && !cfg.apiBase) return openSettings(); open(opener.dataset.open); return; }
  if (e.target.closest('[data-close]')) { e.target.closest('dialog').close(); return; }
  const act = e.target.closest('[data-action]');
  if (!act) return;
  const id = act.closest('[data-id]')?.dataset.id;
  switch (act.dataset.action) {
    case 'copy': e.stopPropagation(); copy(act.dataset.code); break;
    case 'delete': remove(id); break;
    case 'detail': $('#sheet-detail').dataset.id = id; showDetail(id); break;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.action === 'used') {
    const id = e.target.closest('[data-id]').dataset.id;
    update(id, { allowUsed: e.target.checked });
    toast(e.target.checked ? 'Gebrauchte Artikel werden berücksichtigt' : 'Nur Neuware');
  }
});
// Sheet schließen beim Tippen auf den Hintergrund
document.querySelectorAll('dialog.sheet').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

$('#form-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = $('#btn-add-submit');
  btn.disabled = true;
  try {
    const p = await api('/api/products', { method: 'POST', body: {
      query: String(f.get('query')).trim(),
      wishPrice: f.get('wishPrice') ? String(f.get('wishPrice')).replace(',', '.') : null,
      allowUsed: f.get('allowUsed') === 'on',
      includeAmazon: f.get('includeAmazon') === 'on',
      color: String(f.get('color') || '').trim() || null,
      size: String(f.get('size') || '').trim() || null,
    } });
    products.unshift(p);
    render();
    schedulePoll();
    e.target.reset();
    close('add');
    toast('Hinzugefügt – Shops werden geprüft');
  } catch (err) { toast(err.message, 3500); }
  finally { btn.disabled = false; }
});

$('#btn-refresh').onclick = () => load();

// ---------- Einstellungen ----------
async function openSettings() {
  const f = $('#form-settings');
  f.apiBase.value = cfg.apiBase;
  f.token.value = cfg.token;
  $('#version').textContent = `Version ${APP_VERSION === '__VERSION__' ? 'dev' : APP_VERSION.slice(0, 7)}`;
  updatePushState();
  open('settings');
  loadQuota().then(() => {
    const q = quota;
    $('#quota-state').textContent = !q ? '–' : q.enabled
      ? `${q.used} von ${q.limit} Suchen diesen Monat verbraucht, noch ${q.left} übrig${q.source === 'serpapi' ? ' (Stand direkt von SerpApi)' : ''}. Neues Kontingent ab ${fmtDate(q.resetDate)}. Kostenloser Tarif – es fallen keine Kosten an.${quotaText() ? ' ' + quotaText() : ''}`
      : 'Kein SerpApi-Schlüssel hinterlegt – Suche über DuckDuckGo, Amazon nicht verfügbar.';
  });
  if (!cfg.token) setTimeout(() => f.token.focus(), 300);
  if (!cfg.apiBase || !cfg.token) return;
  try {
    const s = await api('/api/settings');
    f.minTrustScore.value = s.minTrustScore;
    f.minReviewCount.value = s.minReviewCount;
    f.minDomainAgeDays.value = s.minDomainAgeDays;
    f.maxReturnCostPct.value = Math.round(s.maxReturnCostRatio * 100);
    f.goodDealDropPct.value = s.goodDealDropPct;
    f.fallbackShipping.value = s.fallbackShipping;
    f.amazonMinRating.value = s.amazonMinRating;
    f.amazonMinReviews.value = s.amazonMinReviews;
    f.requireTrustpilot.checked = !!s.requireTrustpilot;
    f.allowWithoutTrustpilotData.checked = !!s.allowWithoutTrustpilotData;
    f.allowlist.value = s.allowlist.join('\n');
    f.blocklist.value = s.blocklist.join('\n');
    f.blockedRegions.value = s.blockedRegions.join(', ');
  } catch (e) { toast(e.message, 3500); }
}
$('#btn-settings').onclick = openSettings;

$('#form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  store.set('apiBase', f.apiBase.value.trim());
  store.set('token', f.token.value.trim());
  try {
    if (f.minTrustScore.value) {
      const lines = (v) => v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      await api('/api/settings', { method: 'PUT', body: {
        minTrustScore: f.minTrustScore.value.replace(',', '.'),
        minReviewCount: f.minReviewCount.value,
        minDomainAgeDays: f.minDomainAgeDays.value,
        maxReturnCostRatio: Number(f.maxReturnCostPct.value) / 100,
        goodDealDropPct: f.goodDealDropPct.value,
        fallbackShipping: f.fallbackShipping.value.replace(',', '.'),
        amazonMinRating: f.amazonMinRating.value.replace(',', '.'),
        amazonMinReviews: f.amazonMinReviews.value,
        requireTrustpilot: f.requireTrustpilot.checked,
        allowWithoutTrustpilotData: f.allowWithoutTrustpilotData.checked,
        allowlist: lines(f.allowlist.value),
        blocklist: lines(f.blocklist.value),
        blockedRegions: lines(f.blockedRegions.value.toUpperCase()).map((x) => x.toUpperCase()),
      } });
    }
    toast('Gespeichert');
    close('settings');
    load();
    updateBanner();
  } catch (err) { toast(err.message, 4000); }
});

// ---------- Push ----------
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64ToBytes(b64) {
  const s = (b64 + '==='.slice((b64.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!pushSupported()) {
    pushInfo(isStandalone() ? 'Push wird auf diesem Gerät nicht unterstützt (iOS 16.4+ nötig).' : 'Erst über Teilen → „Zum Home-Bildschirm“ installieren und die App von dort öffnen.', false);
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { pushInfo('Benachrichtigungen wurden nicht erlaubt. iPhone-Einstellungen → Mitteilungen → Cheap Smile → Erlauben.', false); return; }
  const { publicKey } = await api('/api/vapid');
  if (!publicKey) { pushInfo('Server hat keinen Push-Schlüssel.', false); return; }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  toast('Push aktiviert 🎉');
  await updatePushState();
  pushInfo('Push ist auf diesem Gerät aktiv ✓ – jetzt „Test senden“ tippen.');
  updateBanner();
}

async function updatePushState() {
  const el = $('#push-state');
  if (!pushSupported()) { el.textContent = isStandalone() ? 'Dieses Gerät unterstützt kein Web-Push.' : 'Auf dem iPhone: Teilen → „Zum Home-Bildschirm“, dann die App von dort öffnen.'; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  el.textContent = sub && Notification.permission === 'granted' ? 'Push ist auf diesem Gerät aktiv.' : 'Push ist noch nicht aktiv.';
  $('#btn-push').textContent = sub ? 'Push erneut verbinden' : 'Push aktivieren';
}

function pushInfo(msg, ok = true) {
  const el = $('#push-state');
  el.textContent = msg;
  el.style.color = ok ? '' : 'var(--hot)';
}

$('#btn-push').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try { await enablePush(); } catch (err) { pushInfo(`Fehler: ${err.message}`, false); toast(err.message, 4000); }
  finally { btn.disabled = false; }
};
$('#btn-test-push').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Sende…';
  try {
    const r = await api('/api/test-push', { method: 'POST' });
    let msg;
    if (r.error) msg = r.error;
    else if (!r.total) msg = 'Noch kein Gerät für Push angemeldet – zuerst „Push aktivieren“ tippen.';
    else if (!r.sent) msg = `Senden fehlgeschlagen (0 von ${r.total}). Bitte „Push erneut verbinden“ tippen.`;
    else msg = `Test gesendet an ${r.sent} von ${r.total} Gerät(en) – die Mitteilung kommt in wenigen Sekunden.`;
    pushInfo(msg, !!r.sent);
    toast(msg, 4000);
  } catch (err) {
    pushInfo(`Fehler: ${err.message}`, false);
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test senden';
  }
};

async function updateBanner() {
  const b = $('#banner');
  let html = '';
  if (!cfg.apiBase || !cfg.token) {
    html = '<span>Willkommen! Gib einmalig dein Passwort ein.</span><button class="btn primary small" id="bn-act">Einrichten</button>';
  } else if (quotaText()) {
    html = `<span>ℹ️ ${esc(quotaText())}</span>`;
  } else if (!isStandalone() && /iPhone|iPad/.test(navigator.userAgent)) {
    html = '<span>Tipp: Über Teilen → „Zum Home-Bildschirm“ wird Cheap Smile zur App – nur dann gibt es Push.</span>';
  } else if (pushSupported() && Notification.permission !== 'granted') {
    html = '<span>Aktiviere Push, um bei Wunschpreis und Top-Angeboten informiert zu werden.</span><button class="btn primary small" id="bn-act">Aktivieren</button>';
  }
  b.innerHTML = html;
  b.hidden = !html;
  const act = $('#bn-act');
  if (act) act.onclick = () => (!cfg.apiBase || !cfg.token ? openSettings() : enablePush().catch((e) => toast(e.message, 4000)));
}

// ---------- Service Worker & Auto-Update ----------
async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Neue Version aktiv -> einmal neu laden (nicht beim allerersten Start)
    if (hadController && !reloading) { reloading = true; location.reload(); }
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-product') { $('#sheet-detail').dataset.id = e.data.id; showDetail(e.data.id); }
  });
  const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  reg.update().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { reg.update().catch(() => {}); load({ silent: true }); }
  });
}

// ---------- Start ----------
(async function init() {
  setupServiceWorker().catch(() => {});
  updateBanner();
  if (cfg.apiBase && cfg.token) {
    $('#grid').innerHTML = '<article class="tile"><div class="tile-top"><div class="thumb skeleton"></div><div class="tile-info"><div class="tile-name skeleton">Lade Produkte</div><div class="price skeleton">000,00 €</div></div></div></article>';
    await load();
    const id = new URLSearchParams(location.search).get('product');
    if (id) { $('#sheet-detail').dataset.id = id; showDetail(id); history.replaceState(null, '', location.pathname); }
  } else {
    render();
  }
})();
