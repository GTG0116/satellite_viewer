/* App-shell cache: the viewer's own files and the static map assets load from the cache, so a
 * repeat visit on a slow connection starts instantly. Satellite data is never cached here
 * (it changes every few minutes and is far too large). */
const VERSION = 'satview-v6';
const SHELL = ['./', 'index.html', 'css/app.css', 'config.js', 'icon.svg', 'manifest.webmanifest',
  'vendor/maplibre/maplibre-gl.mjs', 'vendor/maplibre/maplibre-gl-shared.mjs', 'vendor/maplibre/maplibre-gl-worker.mjs', 'vendor/maplibre/maplibre-gl.css',
  'js/boot.js', 'js/app.js', 'js/map.js', 'js/volume.js', 'js/catalog.js', 'js/geo.js', 'js/scenes.js', 'js/listing.js', 'js/pool.js', 'js/perf.js',
  'js/glm.js', 'js/overlays.js', 'js/polar.js', 'js/tiles/router.js', 'js/tiles/tileworker.js', 'js/decode/worker.js', 'js/decode/hdf5.js', 'js/decode/inflate.js', 'js/decode/range.js',
  'js/decode/bzip2.js', 'js/decode/hsd.js', 'js/decode/composites.js', 'js/decode/retrieve3d.js', 'js/decode/swath.js'];
const STATIC_HOSTS = ['tiles.openfreemap.org']; // (GIBS city lights: cached by the tile workers)

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (same && url.pathname.includes('/s3/')) return;
  if (same) {
    // network first for the app itself (fresh after deploys), cache as offline fallback
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then((cc) => cc.put(req, c)); } return r; })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
  } else if (STATIC_HOSTS.includes(url.hostname) && !/\.pbf$/.test(url.pathname) || url.pathname.includes('/fonts/')) {
    // base map + vector data: cache first (they practically never change)
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(VERSION).then((cc) => cc.put(req, c)); }
      return r;
    })));
  }
});
