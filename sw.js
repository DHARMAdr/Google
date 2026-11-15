/* =====================================================================
   sw.js  -  the SERVICE WORKER (makes ClipCutter work offline)
   =====================================================================
   WHY THIS FILE EXISTS:
     After your first visit, the browser keeps a copy of the site files,
     so the page opens even without internet and can be installed as an app.

   HOW IT WORKS:
     - Page files (html, css, js): "network first" - always try to get the
       newest version, and use the saved copy only if you are offline.
       So new updates show up after a normal refresh.
     - Big engine files in /vendor (the 30 MB ffmpeg engine): "cache first" -
       downloaded once, then reused. Saves a lot of data.
     - Videos you add never pass through here (they stay on your device).

   HOW TO IMPROVE:
     - Change CACHE when you want to force everyone to re-download files.
   ===================================================================== */
const CACHE = "clipcutter-v3";
const CORE = ["./", "index.html", "css/style.css", "js/util.js", "js/profiles.js", "js/engine.js", "js/exporter.js", "js/app.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith(self.location.origin)) return;   // only our own files
  const isVendor = req.url.includes("/vendor/");
  if (isVendor) {                                                                    // cache first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then((res) => {                                           // network first
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match("index.html"))));
});
