// Minimal service worker — required for PWA installability and the Web Share Target.
// Network pass-through (no offline caching of the app shell for now).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* default network handling */ });
