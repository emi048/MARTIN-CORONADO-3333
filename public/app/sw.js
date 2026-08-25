const CACHE = "fich-coronado-v5"; // v5: sidebar deslizable (hamburguesa) en vez de barra inferior
const SHELL = ["/app/", "/app/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Datos (todo lo que empieza con /app/api/) siempre van a la red -- solo el
// shell de la app (HTML/manifest) se sirve desde cache si no hay conexion.
self.addEventListener("fetch", (event) => {
  if (event.request.url.includes("/app/api/")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
