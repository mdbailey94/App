// Offline support. Every request goes to the network first (revalidated with
// the server, so files from different releases are never mixed); the cached
// copy is used only when offline.
const CACHE = 'athlete-readiness-v20';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg',
  'src/app.js', 'src/camera.js', 'src/charts.js', 'src/readiness.js', 'src/signal.js', 'src/storage.js',
  'src/ui.js', 'src/team.js', 'src/group.js', 'src/coach.js', 'src/reading.js', 'src/vendor/qrcode.js', 'apps-script/Code.gs',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so the copy is current.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      // A URL (not the request) so this also works for page navigations.
      const res = await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(url.href, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(url.href, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});
