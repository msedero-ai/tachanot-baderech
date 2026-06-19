// Service worker — PWA installability, Web Share Target, and offline app shell.
// Bump CACHE when index.html or assets change so old caches are evicted.
const CACHE = "tachanot-v2";

// Same-origin app shell precached on install. index.html embeds all app code
// (including Leaflet), so caching it makes the whole UI work offline; saved
// places live in localStorage, so the list is fully usable without a network.
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192-v2.png",
  "./icon-512-v2.png",
];

// Cross-origin static libraries safe to cache-first (stable, versioned URLs):
// Firebase SDK on gstatic + the Heebo webfont. NOT tiles/geocoding/Firestore.
function isCacheableCrossOrigin(url) {
  const h = url.hostname;
  if (h === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) return true;
  if (h === "fonts.googleapis.com" || h === "fonts.gstatic.com") return true;
  return false;
}

// Hosts that must always hit the network (dynamic data / freshness / privacy).
function isLiveOnly(url) {
  const h = url.hostname;
  return (
    h.endsWith("tile.openstreetmap.org") ||
    h.endsWith("nominatim.openstreetmap.org") ||
    h.endsWith("router.project-osrm.org") ||
    h.endsWith("googleapis.com") ||           // Firestore + identitytoolkit auth
    h.endsWith("firebaseio.com") ||
    h.endsWith("firebaseapp.com")
  );
}

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never touch POST (share target, Firestore writes)
  const url = new URL(req.url);

  // AI proxy and any dynamic backend: never cache.
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;
  if (isLiveOnly(url)) return;

  // App-shell navigations: network-first, fall back to cached index.html offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isCacheableCrossOrigin(url)) return; // tiles etc. pass through

  // Static assets (icons, manifest, Firebase SDK, font): cache-first + bg refresh.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          // Cache successful or opaque (cross-origin no-cors) responses.
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});
