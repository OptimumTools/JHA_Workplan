const CACHE_NAME = 'jha-v5';
const ASSETS = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js'
];

// Install — cache all assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    }).then(() => self.clients.claim())
  );
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Don't cache webhook POSTs — handle separately
  if (event.request.method === 'POST' && url.hostname.includes('powerplatform.com')) {
    event.respondWith(
      fetch(event.request.clone()).catch(() => {
        // Queue failed submissions for retry
        return event.request.text().then(body => {
          return saveToQueue(body, event.request.url);
        }).then(() => {
          return new Response(JSON.stringify({ queued: true }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' }
          });
        });
      })
    );
    return;
  }

  // For everything else: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// --- OFFLINE QUEUE ---
// Uses IndexedDB to store failed webhook submissions

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('jha-queue', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function saveToQueue(body, url) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').add({ url, body, timestamp: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  });
}

function getQueuedItems() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readonly');
      const req = tx.objectStore('pending').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function removeFromQueue(id) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  });
}

// Retry queued submissions when back online
self.addEventListener('sync', event => {
  if (event.tag === 'retry-webhooks') {
    event.waitUntil(retryQueue());
  }
});

async function retryQueue() {
  const items = await getQueuedItems();
  for (const item of items) {
    try {
      const resp = await fetch(item.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: item.body
      });
      if (resp.ok || resp.status < 500) {
        await removeFromQueue(item.id);
      }
    } catch (e) {
      // Still offline, will retry next sync
    }
  }
}

// Also retry on periodic check (backup for browsers without background sync)
self.addEventListener('message', event => {
  if (event.data === 'retry-queue') {
    retryQueue().then(() => {
      self.clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: 'queue-retried' }));
      });
    });
  }
});
