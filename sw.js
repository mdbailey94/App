// Offline support: cache the app shell, serve it cache-first, refresh in the background.
const CACHE = 'athlete-readiness-v5';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg',
  'src/app.js', 'src/camera.js', 'src/charts.js', 'src/readiness.js', 'src/signal.js', 'src/storage.js',
  'src/ui.js', 'src/team.js', 'src/group.js', 'src/coach.js', 'apps-script/Code.gs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
      if (cached) network.catch(() => {});
      return cached || network;
    }),
  );
});
