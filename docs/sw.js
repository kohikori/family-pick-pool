// Minimal service worker: lets Android/Chrome offer "Install app".
// It deliberately caches nothing, so you always see the latest picks and standings.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
