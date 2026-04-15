/**
 * Majordomo Service Worker
 * 
 * Minimal PWA support:
 * - Cache-first for static assets (offline shell)
 * - Network-first for all API routes (live data)
 */

const CACHE_NAME = 'majordomo-v4';
const STATIC_ASSETS = [
  '/',
  '/app.js',
  '/app.css',
  '/atreides-hawk.svg',
  '/apple-touch-icon.png',
  '/manifest.json'
];

// Install event — cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate event — clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Take control immediately
  self.clients.claim();
});

// Fetch event — routing strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Network-first for all API routes and SSE
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/sse') ||
    url.pathname.startsWith('/health') ||
    url.pathname.startsWith('/webhooks/')
  ) {
    event.respondWith(
      fetch(request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'Offline — API unavailable' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        // Cache successful responses for static assets
        if (response.status === 200 && request.method === 'GET') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return response;
      });
    })
  );
});
