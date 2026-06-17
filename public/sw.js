/**
 * sw.js — Service Worker for VisionBridge PWA
 * Caches all assets for full offline functionality.
 * Strategy: Cache-first for static assets, network-first for API calls.
 */

const CACHE_VERSION = 'vb-v6';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;

// Assets to pre-cache on install (everything needed for offline)
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/camera.js',
  '/js/speech.js',
  '/js/detector.js',
  '/js/features.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/app.js',
  '/js/offline.js',
  '/js/assistant.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/screenshot.png'
];

// CDN assets to cache on first use (too large to precache)
const CDN_CACHE_PATTERNS = [
  'cdn.jsdelivr.net/npm/@tensorflow',
  'cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd',
  'cdn.jsdelivr.net/npm/tesseract',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// =============================================
//   INSTALL — Pre-cache static assets
// =============================================
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker v' + CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Precache failed:', err.message))
  );
});

// =============================================
//   ACTIVATE — Clean old caches
// =============================================
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker v' + CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== API_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// =============================================
//   FETCH — Smart caching strategy
// =============================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests (POST API calls, etc.)
  if (event.request.method !== 'GET') return;

  // API calls: network-first, cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(event.request, API_CACHE));
    return;
  }

  // CDN assets (TF.js, COCO-SSD, Tesseract, fonts): cache-first
  if (CDN_CACHE_PATTERNS.some(p => url.href.includes(p))) {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE));
    return;
  }

  // Static assets: cache-first with network fallback
  event.respondWith(cacheFirst(event.request, STATIC_CACHE));
});

// =============================================
//   CACHE STRATEGIES
// =============================================

// Cache-first: serve from cache, fall back to network (and update cache)
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // If both cache and network fail, return a basic offline response
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// Network-first: try network, fall back to cache
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'offline', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
