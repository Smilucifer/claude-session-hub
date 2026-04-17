const CACHE = 'csh-mobile-v5';
const ASSETS = ['/', '/index.html', '/app.js', '/router.js', '/transport.js',
                '/views/session-list.js', '/views/session-view.js', '/views/permission-card.js',
                '/styles/base.css', '/styles/list.css', '/styles/session.css', '/styles/responsive.css',
                '/manifest.json', '/vendor/xterm/xterm.js', '/vendor/xterm-css/xterm.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin static assets: always try fresh, fall back to
// cache when offline. This lets server-side code changes land on the next
// page load without requiring a CACHE version bump every time.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  e.respondWith(
    fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone).catch(() => {}));
      return resp;
    }).catch(() => caches.match(e.request).then(c => c || caches.match('/index.html')))
  );
});
