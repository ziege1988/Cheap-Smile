// Cheap Smile Service Worker
// - Netz zuerst: beim Start wird immer die neueste Version geladen (Auto-Update)
// - Offline-Fallback aus dem Cache
// - Push-Benachrichtigungen
const VERSION = '__VERSION__';
const CACHE = `cheap-smile-${VERSION}`;
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // API & Bilder: direkt
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    } catch {
      return (await caches.match(e.request)) || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error());
    }
  })());
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Cheap Smile', {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.tag,
    renotify: !!data.tag,
    data: { url: data.url || './', productId: data.productId },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { url, productId } = e.notification.data || {};
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (productId) c.postMessage({ type: 'open-product', id: productId });
      return c.focus();
    }
    return self.clients.openWindow(new URL(url || './', self.registration.scope).toString());
  })());
});
