const CACHE_NAME = 'orchard-shell-v2';
const SHELL_FILES = ['./', './index.html', './app.js', './config.js', './icon.svg', './manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)))
    )
  );
  self.clients.claim();
});

const SHELL_BASENAMES = SHELL_FILES.map(f => f.replace('./', '') || '/');

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const basename = url.pathname.slice(url.pathname.lastIndexOf('/') + 1) || '/';
  const isShellFile = url.origin === self.location.origin && SHELL_BASENAMES.includes(basename);
  if (!isShellFile) return;

  // Network-first: always serve the freshest shell when online so deploys
  // reach users immediately; fall back to the cached copy offline.
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request))
  );
});
