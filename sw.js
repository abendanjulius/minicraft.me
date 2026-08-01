// sw.js — cache app shell so solo mode works offline / installed
const CACHE = 'minicraft-v45'; // UPDATE ON EVERY RELEASE (with version.json + APP_VERSION in main.js)
const CORE = [
  './', './index.html', './css/style.css', './manifest.json',
  './js/main.js', './js/world.js', './js/render.js', './js/player.js',
  './js/animals.js', './js/net.js', './js/ui.js', './js/audio.js', './js/survival.js', './js/mobs.js', './js/craft.js', './js/content.js', './js/mode.js', './js/persist.js', './js/physics.js', './js/drops.js', './js/chests.js', './js/keg.js',
  './icons/icon-192.png', './icons/icon-512.png', './assets/music.mp3',
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
// Cache-first with network fill-in (also caches the CDN libs after first load)
self.addEventListener('fetch', e=>{
  if(e.request.method!=='GET') return;
  // version.json is the update beacon — always network, never cache
  if(e.request.url.includes('version.json')){
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit=>{
      if(hit) return hit;
      return fetch(e.request).then(res=>{
        if(res.ok || res.type==='opaque'){
          const copy = res.clone();
          caches.open(CACHE).then(c=>c.put(e.request, copy));
        }
        return res;
      }).catch(()=>hit);
    })
  );
});
