// Cheap Smile API (Cloudflare Worker)
//  - HTTP-API für die PWA (Produkte, Einstellungen, Push-Abos)
//  - Cron-Trigger: Preise prüfen und Push-Nachrichten senden

import { createFetcher, uid, domainOf } from './util.js';
import { getSettings, saveSettings, getProduct, saveProduct, deleteProduct, allProducts, getSubs, addSub, removeSub } from './store.js';
import { checkProduct, toClient, applyVariantChoice } from './products.js';
import { bestOffer, effectiveTotal } from './deal.js';
import { sendPush, b64urlEncode } from './push.js';
import { quotaStatus } from './search.js';
import { asinOf, resolveAmazonShortLink } from './amazon.js';
import { nameFromUrl as slugName } from './util.js';

const json = (data, status = 200, env) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env) },
});

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function authorized(req, env) {
  if (!env.APP_TOKEN) return false;
  const h = req.headers.get('Authorization') || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (given.length !== env.APP_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.APP_TOKEN.charCodeAt(i);
  return diff === 0;
}

/**
 * VAPID-Schlüssel: aus Secrets, sonst einmalig automatisch erzeugt und in KV gespeichert.
 * So muss bei der Einrichtung niemand Schlüssel von Hand erzeugen.
 */
export async function getVapid(env) {
  const subject = env.VAPID_SUBJECT || 'https://github.com/';
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject };
  let v = await env.DB.get('vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    v = { publicKey: b64urlEncode(raw), privateKey: jwk.d };
    await env.DB.put('vapid', JSON.stringify(v));
  }
  return { ...v, subject };
}

export async function notifyAll(env, alert, fetchImpl = fetch) {
  const keys = await getVapid(env);
  const subs = await getSubs(env);
  let sent = 0;
  for (const s of subs) {
    try {
      const r = await sendPush(s, alert, keys, fetchImpl);
      if (r.ok) sent++;
      else if (r.gone) await removeSub(env, s.endpoint);
    } catch (e) { console.log('push error', e?.message); }
  }
  return { sent, total: subs.length };
}

async function runCheck(env, product, { force = false, fetchImpl = fetch } = {}) {
  const settings = await getSettings(env);
  const fetcher = createFetcher(fetchImpl, Number(env.SUBREQUEST_BUDGET || 40));
  const alert = await checkProduct(env, product, fetcher, settings, { force });
  // Produkt könnte während der Prüfung gelöscht worden sein
  if (!(await getProduct(env, product.id))) return null;
  await saveProduct(env, product);
  if (alert) await notifyAll(env, alert, fetchImpl);
  return alert;
}

function parseWish(v) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}

async function handleApi(req, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await req.json().catch(() => ({})) : {};

  if (path === '/api/health') return json({ ok: true, time: Date.now(), search: env.SERPAPI_KEY ? 'google' : env.BRAVE_API_KEY ? 'brave' : 'duckduckgo', tokenSet: !!env.APP_TOKEN }, 200, env);
  if (path === '/api/vapid' && method === 'GET') return json({ publicKey: (await getVapid(env)).publicKey }, 200, env);

  if (!authorized(req, env)) return json({ error: 'Nicht autorisiert – Zugangsschlüssel in den Einstellungen prüfen.' }, 401, env);

  // Produkte
  if (path === '/api/products' && method === 'GET') {
    const list = await allProducts(env);
    list.sort((a, b) => b.createdAt - a.createdAt);
    return json(list.map(toClient), 200, env);
  }
  if (path === '/api/products' && method === 'POST') {
    let q = String(body.query || '').trim();
    // Geteilter Text mit Link (z. B. aus der Amazon- oder Shop-App): Link herauslösen
    if (!/^https?:\/\//i.test(q)) {
      const link = q.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
      if (link) q = link.replace(/[).,;!]+$/, '');
    }
    if (/^https?:\/\/(amzn\.(eu|to)|a\.co)\//i.test(q)) q = await resolveAmazonShortLink(q);
    if (q.length < 3) return json({ error: 'Bitte Produktname oder Link angeben.' }, 400, env);
    const wish = parseWish(body.wishPrice);
    if (wish === undefined) return json({ error: 'Ungültiger Wunschpreis.' }, 400, env);
    const isUrl = /^https?:\/\//i.test(q);
    const asin = isUrl ? asinOf(q) : null;
    const product = {
      id: uid(), createdAt: Date.now(),
      name: isUrl ? (body.name?.trim() || slugName(q) || (asin ? 'Amazon-Artikel' : domainOf(q)) || q) : q,
      nameFromUrl: isUrl && !body.name,
      sourceUrl: isUrl ? q : null,
      asin, // Amazon-Link: Artikel wird über die ASIN abgefragt (Amazon blockiert direkte Abrufe)
      wishPrice: wish, allowUsed: !!body.allowUsed, includeAmazon: asin ? true : body.includeAmazon !== false,
      color: body.color ? String(body.color).trim().slice(0, 40) : null,
      size: body.size ? String(body.size).trim().slice(0, 20) : null,
      userVariant: !!(body.color || body.size),
      offers: [], excluded: [], history: [], notify: {},
    };
    await saveProduct(env, product);
    ctx.waitUntil(runCheck(env, product, { force: true }).catch((e) => console.log('check error', e)));
    return json(toClient(product), 201, env);
  }

  const m = path.match(/^\/api\/products\/([a-z0-9]+)(\/refresh)?$/);
  if (m) {
    const product = await getProduct(env, m[1]);
    if (!product) return json({ error: 'Produkt nicht gefunden' }, 404, env);
    if (m[2] && method === 'POST') {
      const alert = await runCheck(env, product, { force: true });
      return json({ product: toClient(product), alert }, 200, env);
    }
    if (method === 'GET') return json(toClient(product), 200, env);
    if (method === 'DELETE') {
      await deleteProduct(env, product.id); // Alarme sind Teil des Produkts -> mit entfernt
      return json({ ok: true }, 200, env);
    }
    if (method === 'PATCH') {
      if ('wishPrice' in body) {
        const w = parseWish(body.wishPrice);
        if (w === undefined) return json({ error: 'Ungültiger Wunschpreis.' }, 400, env);
        product.wishPrice = w;
        product.notify = { lastAlertAt: product.notify?.lastAlertAt }; // neuer Wunschpreis -> Alarm neu scharf
      }
      if ('allowUsed' in body) {
        product.allowUsed = !!body.allowUsed;
      }
      if ('includeAmazon' in body) {
        product.includeAmazon = !!body.includeAmazon;
        if (!product.includeAmazon) product.offers = (product.offers || []).filter((o) => o.source !== 'amazon');
        else product.lastAmazonAt = null;
      }
      const amazonTurnedOn = body.includeAmazon === true;
      let variantChanged = false;
      if ('color' in body || 'size' in body) {
        applyVariantChoice(product, 'color' in body ? body.color : product.color, 'size' in body ? body.size : product.size);
        product.notify = { lastAlertAt: product.notify?.lastAlertAt }; // anderer Artikel -> Alarme neu
        product.history = [];
        variantChanged = true;
      }
      if (typeof body.name === 'string' && body.name.trim()) product.name = body.name.trim().slice(0, 120);
      const best = bestOffer(product);
      product.best = best ? { domain: best.domain, total: effectiveTotal(best), url: best.url } : null;
      await saveProduct(env, product);
      if (variantChanged) ctx.waitUntil(runCheck(env, product, { force: true }).catch((e) => console.log('check error', e)));
      else if (amazonTurnedOn) ctx.waitUntil(runCheck(env, product).catch((e) => console.log('check error', e)));
      return json(toClient(product), 200, env);
    }
  }

  if (path === '/api/quota' && method === 'GET') {
    return json(await quotaStatus(env, createFetcher(fetch, 2)), 200, env);
  }

  // Einstellungen
  if (path === '/api/settings' && method === 'GET') return json(await getSettings(env), 200, env);
  if (path === '/api/settings' && method === 'PUT') return json(await saveSettings(env, body), 200, env);
  if (path === '/api/shops/recheck' && method === 'POST') {
    const d = String(body.domain || '').toLowerCase();
    if (d) await env.DB.delete(`shop:${d}`);
    return json({ ok: true }, 200, env);
  }

  // Push
  if (path === '/api/subscribe' && method === 'POST') {
    const s = body.subscription;
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json({ error: 'Ungültige Subscription' }, 400, env);
    await addSub(env, s);
    return json({ ok: true }, 200, env);
  }
  if (path === '/api/subscribe' && method === 'DELETE') {
    await removeSub(env, String(url.searchParams.get('endpoint') || body.endpoint || ''));
    return json({ ok: true }, 200, env);
  }
  if (path === '/api/test-push' && method === 'POST') {
    const r = await notifyAll(env, { title: '😊 Cheap Smile', body: 'Push funktioniert! Du wirst bei Wunschpreis und Top-Angeboten benachrichtigt.', url: './', tag: 'test' });
    return json(r, 200, env);
  }

  return json({ error: 'Unbekannter Endpunkt' }, 404, env);
}

/** Cron: pro Lauf so viele Produkte wie das Subrequest-Budget erlaubt. */
export async function scheduled(env, fetchImpl = fetch) {
  const settings = await getSettings(env);
  const fetcher = createFetcher(fetchImpl, Number(env.SUBREQUEST_BUDGET || 40));
  const products = await allProducts(env);
  products.sort((a, b) => (b.partial ? 1 : 0) - (a.partial ? 1 : 0) || (a.lastCheckAt || 0) - (b.lastCheckAt || 0));
  let checked = 0;
  for (const p of products) {
    if (fetcher.remaining() < 6) break;
    const alert = await checkProduct(env, p, fetcher, settings);
    if (!(await getProduct(env, p.id))) continue;
    await saveProduct(env, p);
    if (alert) await notifyAll(env, alert, fetchImpl);
    checked++;
  }
  // Einmal pro Monat Bescheid geben, wenn das Suchkontingent aufgebraucht ist
  const q = await quotaStatus(env);
  if (q.enabled && q.exhausted && !(await env.DB.get(`quota-notified:${q.month}`))) {
    await env.DB.put(`quota-notified:${q.month}`, '1', { expirationTtl: 40 * 86400 });
    const reset = new Date(q.resetDate).toLocaleDateString('de-DE');
    await notifyAll(env, { title: 'ℹ️ Suchkontingent aufgebraucht', body: `Amazon und die Suche nach neuen Shops pausieren bis ${reset}. Bekannte Shops werden weiter geprüft. Es entstehen keine Kosten.`, url: './', tag: 'quota' }, fetchImpl);
  }
  return { checked, used: fetcher.used() };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(req, env, ctx, url); } catch (e) {
        return json({ error: String(e?.message || e) }, 500, env);
      }
    }
    return new Response('Cheap Smile API', { headers: cors(env) });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduled(env).then((r) => console.log('cron', JSON.stringify(r))));
  },
};
