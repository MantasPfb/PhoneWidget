const CACHE = 'morning-v1';
const FILES = ['./', './index.html', './manifest.json', './icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))));
self.addEventListener('fetch', e => {
  if (e.request.url.includes('open-meteo.com')) return; // always live weather
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
