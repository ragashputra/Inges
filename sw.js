/* Inges — Service Worker
   Cache app-shell untuk load instan & dukungan offline ringan.
   Data (Sheets API) selalu network-only — tidak pernah di-cache. */

// Naikkan angka versi ini SETIAP KALI index.html/app.js diubah, supaya
// browser pengguna lama otomatis buang cache basi dan ambil versi terbaru.
const CACHE_NAME = 'inges-shell-v6';
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Jangan pernah cache panggilan API (Sheets, OAuth, dsb) — selalu ambil dari network
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('accounts.google.com') ||
    url.hostname.includes('google.com')
  ) {
    return; // biarkan browser handle langsung
  }

  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // index.html & app.js: network-first — selalu coba versi terbaru dulu,
  // supaya perubahan penting (mis. Client ID, teks, dll) langsung kepakai
  // tanpa nyangkut cache lama. Fallback ke cache hanya kalau benar-benar offline.
  //
  // PENTING: pakai cache:'no-store' di sini, BUKAN cuma andalkan fetch(event.request)
  // biasa. Tanpa ini, fetch() masih bisa "dijawab" dari HTTP disk cache bawaan
  // browser (beda dari Cache Storage milik service worker ini) kalau server hosting
  // kasih header Cache-Control yang mengizinkan cache — hasilnya file lama tetap
  // muncul walau kode di sini sudah bener "network-first". no-store memaksa
  // permintaan selalu benar-benar sampai ke server, bukan dijawab dari cache manapun.
  const isCoreFile = url.pathname.endsWith('app.js') || url.pathname.endsWith('index.html') || url.pathname === '/' || url.pathname.endsWith('/Inges/');
  if (isCoreFile) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // File lain (manifest, icon, dst): cache-first seperti biasa
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
