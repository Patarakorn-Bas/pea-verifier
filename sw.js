/**
 * Service Worker สำหรับ PEA Material Verifier
 * แคชเฉพาะ "เปลือกแอป" (HTML/CSS/JS ของหน้าเว็บเอง + คลังมาตรฐานวัสดุ) เพื่อให้เปิดแอป
 * และดูข้อมูลที่เคยโหลดไว้ได้แม้ไม่มีอินเทอร์เน็ต
 *
 * สิ่งที่ "ทำไม่ได้" ตอนออฟไลน์ (ต้องมีเน็ตเท่านั้น): การเรียก AI ตรวจสอบวัสดุใหม่,
 * การบันทึก/ค้นหาประวัติผ่าน Worker — เพราะต้องคุยกับเซิร์ฟเวอร์ภายนอกจริง
 */
const CACHE_NAME = 'pea-verifier-cache-v1';
const APP_SHELL = [
  './pea-material-verifier.html',
  './pea-standards-library.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // ไม่แคชคำขอไปยัง Cloudflare Worker (ต้องสดใหม่เสมอ ห้ามใช้ของเก่าจาก cache)
  if (url.hostname.endsWith('workers.dev') || url.hostname.includes('generativelanguage')) {
    return; // ปล่อยผ่านให้เบราว์เซอร์จัดการตามปกติ (network only)
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (event.request.method === 'GET' && networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
