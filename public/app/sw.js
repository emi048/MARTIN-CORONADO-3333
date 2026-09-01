const CACHE = "fich-coronado-v40"; // v40: pestana Novedades de vuelta, como tarjeta en Inicio
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

// Notificaciones push (Web Push) -- el payload lo arma enviarPushAEmpleado
// en el server como JSON { title, body, url }.
self.addEventListener("push", (event) => {
  let datos = { title: "Martín Coronado", body: "" };
  try { if (event.data) datos = { ...datos, ...event.data.json() }; } catch { /* payload no era JSON, se usa el default */ }
  event.waitUntil(
    self.registration.showNotification(datos.title, {
      body: datos.body,
      icon: "/app/icons/icon-192.png",
      badge: "/app/icons/icon-192.png",
      data: { url: datos.url || "/app/" },
    })
  );
});

// Al tocar la notificacion, si ya hay una pestaña de la app abierta la
// enfoca en vez de abrir una nueva.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/app/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for (const cliente of lista) {
        if (cliente.url.includes("/app/") && "focus" in cliente) return cliente.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
