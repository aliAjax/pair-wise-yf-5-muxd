// 离线缓存应用外壳；API 请求走网络，失败时由页面回退到 IndexedDB 缓存
const CACHE = 'coldchain-v1';
const SHELL = [
  '/', '/index.html', '/css/style.css',
  '/js/idb.js', '/js/sync.js', '/js/ui.js',
  '/js/dispatch.js', '/js/vehicle.js', '/js/anomalies.js', '/js/app.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // API 不走 SW 缓存
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return resp;
    }).catch(() => caches.match('/index.html')))
  );
});
