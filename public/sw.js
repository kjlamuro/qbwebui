/*
 * qBWebUI Service Worker
 *
 * 目标：iOS 加到主屏后秒开、弱网/离线也能看到界面骨架。
 * 策略：静态壳（页面 / css / js / 图标）用 stale-while-revalidate —— 先回缓存再后台更新；
 *       /api/* 与 /__* 动态接口一律直连不缓存（数据必须新鲜，封面图也会变）。
 * 版本：改任何壳文件后把 V 换个号，activate 时清掉旧缓存。
 */
const V = 'qbwebui-v43';
/* 与 index.html 里的 ?v= 保持一致：URL 变了旧缓存自然失效 */
const SHELL = ['/', '/styles.css?v=20261024al', '/app.js?v=20261024al', '/icon-180.png', '/icon.svg', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== V) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__')) return;

  // 页面导航：网络优先，断网时回缓存的壳
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(V);
        cache.put('/', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(V);
        return (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // 其余静态资源：先缓存后更新
  e.respondWith((async () => {
    const cache = await caches.open(V);
    const cached = await cache.match(req);
    const fresh = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await fresh) || Response.error();
  })());
});
