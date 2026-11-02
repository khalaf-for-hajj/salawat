// ===== عامل الخدمة: يفتح الصفحة حتى بلا إنترنت =====
// عند تحديث الملفات على GitHub غيّر رقم الإصدار ليُحدَّث الكاش عند المستخدمين
const VERSION = 'sl-v1';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest',
  'assets/style.css', 'assets/logo.png', 'assets/icon-192.png',
  'js/app.js', 'js/common.js', 'js/rpc.js', 'js/local-server.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                          // طلبات Supabase (POST) لا تمر بالكاش
  const url = new URL(req.url);
  if (url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/')) return;
  // الملفات: من الكاش فوراً مع تحديثه في الخلفية (stale-while-revalidate)
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: url.origin === location.origin });
    const net = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
