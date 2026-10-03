// Офлайн-кэш оболочки приложения. При изменении файлов увеличьте VERSION.
const VERSION = 'v14';
const CACHE = 'spellbook-' + VERSION;
const FILES = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/store.js', 'js/parser.js', 'js/import.js', 'js/rules.js', 'js/sync.js', 'js/richtext.js', 'js/merge.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('spellbook-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Свои файлы: сеть с откатом на кэш (обновления подхватываются сразу, офлайн тоже работает).
// Чужие запросы (прокси) не трогаем.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
