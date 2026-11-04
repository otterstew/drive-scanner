// Keeps the app's own files on the phone so it opens with no signal.
// Only this site's files are cached; Google requests always go to the network.
const CACHE = "scanner-v1";
const FILES = [
  "./", "index.html", "styles.css", "app.js", "scan.js", "pdf.js", "drive.js", "store.js", "config.js",
  "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Serve from the phone at once, refresh the copy in the background.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const key = e.request.mode === "navigate" ? "./" : e.request;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then((r) => {
      if (r.ok) cache.put(key, r.clone());
      return r;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
