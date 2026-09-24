// Minimal service worker: makes the app installable.
// It doesn't cache anything, so you always get the newest version of the site.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
