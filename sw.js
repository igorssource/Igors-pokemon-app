// Service Worker: macht die App installierbar und hält die App-Dateien
// (inkl. Texterkennung) sowie bereits gesehene Kartenbilder im Cache.
// Kartendaten und Preise werden NICHT zwischengespeichert, die kommen immer online.

const VERSION = 'v8';
const APP_CACHE = `app-${VERSION}`;
const IMG_CACHE = 'card-images';

const APP_FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/api.js', 'js/scanner.js', 'js/store.js', 'js/scan-state.js', 'js/detect.js', 'js/cards-db.js', 'js/ai.js', 'data/cards.json',
  'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/tesseract/tesseract.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('app-') && k !== APP_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Kartenbilder: aus dem Cache, sonst laden und merken
  if (url.hostname === 'images.pokemontcg.io') {
    event.respondWith(caches.open(IMG_CACHE).then(async cache => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok || res.type === 'opaque') cache.put(event.request, res.clone());
      return res;
    }));
    return;
  }

  // Eigene App-Dateien: erst Netz (damit Updates ankommen), sonst Cache
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res.ok) caches.open(APP_CACHE).then(c => c.put(event.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(event.request).then(hit => hit || caches.match('index.html'))),
    );
  }
});
