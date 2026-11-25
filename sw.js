/* ปุกป็อก — Service Worker: ให้เปิดแอปได้แม้ไม่มีเน็ต (เช่น ลานจอดใต้ดิน) */
const VERSION = 'pookpok-2.2.0'; // ให้ตรงกับ APP_VERSION ใน index.html
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
// ไฟล์จาก CDN ที่หน้าเว็บต้องใช้ (Tailwind, ฟอนต์)
const CDN_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // หน้าเว็บหลัก: เอาของใหม่จากเน็ตก่อน ถ้าไม่มีเน็ตใช้ของในเครื่อง
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); }
          return res;
        })
        .catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  // ไฟล์ในเว็บเรา + CDN: ใช้ของในเครื่องทันที แล้วอัปเดตเบื้องหลัง
  if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(req, { ignoreSearch: url.origin === self.location.origin });
        const network = fetch(req)
          .then((res) => {
            if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
