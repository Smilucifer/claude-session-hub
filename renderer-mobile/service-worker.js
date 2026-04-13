const CACHE = 'csh-mobile-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/router.js', '/transport.js',
                '/views/session-list.js', '/views/session-view.js', '/views/permission-card.js',
                '/styles/base.css', '/styles/list.css', '/styles/session.css', '/styles/responsive.css',
                '/manifest.json', '/vendor/xterm/xterm.js', '/vendor/xterm-css/xterm.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone).catch(() => {}));
      return resp;
    }).catch(() => caches.match('/index.html')))
  );
});
