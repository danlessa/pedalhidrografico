// Pedal Hidrográfico — service worker
//
// Two cache buckets:
//   STATIC_CACHE  — app shell (HTML/CSS/JS/icons/routes.json/manifest).
//                    Cache-first; falls back to network.
//   RUNTIME_CACHE — map tiles, OSRM, elevation, Instagram embed, etc.
//                    Stale-while-revalidate so cached tiles render instantly
//                    and refresh in the background.

const VERSION = 'phidro-v1';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './routes.json',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Some assets may 404 in dev (e.g. before routes.json is built); use
      // cache.add per-item with catch so install doesn't fail the whole batch.
      Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn(`[sw] skip ${url}: ${err.message}`)),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

// Hosts whose responses we want to keep cached for offline / fast revisits.
const RUNTIME_HOSTS = [
  /(^|\.)tile\.openstreetmap\.org$/,
  /(^|\.)server\.arcgisonline\.com$/,
  /(^|\.)telhas\.pedalhidrografi\.co$/,
  /(^|\.)raster\.geosampa\.prefeitura\.sp\.gov\.br$/,
  /(^|\.)api\.open-meteo\.com$/,
  /(^|\.)router\.project-osrm\.org$/,
  /(^|\.)unpkg\.com$/,
  /(^|\.)cdn\.jsdelivr\.net$/,
];

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin app shell + routes.json: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Allowlisted third-party hosts: stale-while-revalidate.
  if (RUNTIME_HOSTS.some((re) => re.test(url.host))) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Everything else: pass through.
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      // Only cache successful, non-opaque responses to avoid filling cache
      // with failed/redirect garbage. Tile servers return 200 OK with image
      // bodies; OSRM/elevation return 200 OK with JSON.
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}
