// KV-Zugriffe. Ein Schlüssel pro Produkt + Index, damit der Cron gezielt laden kann.

import { DEFAULT_SETTINGS } from './config.js';

export async function getSettings(env) {
  const s = (await env.DB.get('settings', 'json')) || {};
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(env, patch) {
  const cur = (await env.DB.get('settings', 'json')) || {};
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k)) continue;
    if (Array.isArray(DEFAULT_SETTINGS[k])) {
      cur[k] = [].concat(v).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    } else if (typeof DEFAULT_SETTINGS[k] === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) cur[k] = n;
    } else if (typeof DEFAULT_SETTINGS[k] === 'boolean') {
      cur[k] = !!v;
    }
  }
  await env.DB.put('settings', JSON.stringify(cur));
  return { ...DEFAULT_SETTINGS, ...cur };
}

export async function listIds(env) {
  return (await env.DB.get('index', 'json')) || [];
}

export async function getProduct(env, id) {
  return env.DB.get(`product:${id}`, 'json');
}

export async function saveProduct(env, p) {
  p.updatedAt = Date.now();
  await env.DB.put(`product:${p.id}`, JSON.stringify(p));
  const ids = await listIds(env);
  if (!ids.includes(p.id)) { ids.push(p.id); await env.DB.put('index', JSON.stringify(ids)); }
}

/** Entfernt Produkt samt Alarm-Zustand (Push-Alarme hängen am Produkt). */
export async function deleteProduct(env, id) {
  await env.DB.delete(`product:${id}`);
  const ids = (await listIds(env)).filter((x) => x !== id);
  await env.DB.put('index', JSON.stringify(ids));
}

export async function allProducts(env) {
  const ids = await listIds(env);
  const list = await Promise.all(ids.map((id) => getProduct(env, id)));
  return list.filter(Boolean);
}

export async function getSubs(env) {
  return (await env.DB.get('subs', 'json')) || [];
}

export async function addSub(env, sub) {
  const subs = (await getSubs(env)).filter((s) => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: sub.keys, addedAt: Date.now() });
  await env.DB.put('subs', JSON.stringify(subs));
}

export async function removeSub(env, endpoint) {
  const subs = (await getSubs(env)).filter((s) => s.endpoint !== endpoint);
  await env.DB.put('subs', JSON.stringify(subs));
}
