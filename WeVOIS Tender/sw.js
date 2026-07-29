/* WeVois Tender Portal - service worker.
 * Installable and quick to open, WITHOUT ever serving stale code.
 *
 *   pages (HTML)         -> network first, cache only as an offline fallback
 *   our own CSS/JS/icons -> cache first, refreshed quietly in the background
 *   Supabase and the CDN -> never touched, always live
 *
 * BUMP CACHE_VERSION ON EVERY DEPLOY that changes a .js or .css file.
 * Without a bump, a returning device keeps the old script: the page shows the
 * new markup but the JavaScript does nothing - a silent, confusing failure.
 */
const CACHE_VERSION = 'wevois-tender-8';
const SHELL = [
  './',
  'index.html',
  'tender-engine.js',
  'tender-data.js',
  'tender-app.js',
  'tender-theme.css',
  'supabase-config.js',
  'icon-192.png',
  'icon-512.png',
  'logo.png',
  'favicon.ico'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      const live = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || live;
    })
  );
});
