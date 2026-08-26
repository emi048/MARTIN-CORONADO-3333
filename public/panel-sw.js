// Service worker minimo del panel de admin -- solo existe para poder
// suscribirse a Web Push (pushManager.subscribe necesita un
// ServiceWorkerRegistration activo). No cachea nada: el panel no es una
// PWA offline-first como la app de empleado, esto es exclusivamente para
// notificaciones.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let datos = { title: "Martín Coronado 3333", body: "" };
  try { if (event.data) datos = { ...datos, ...event.data.json() }; } catch { /* payload no era JSON, se usa el default */ }
  event.waitUntil(
    self.registration.showNotification(datos.title, {
      body: datos.body,
      icon: "/panel/logo-cr.png",
      data: { url: datos.url || "/panel/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/panel/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for (const cliente of lista) {
        if (cliente.url.includes("/panel") && "focus" in cliente) return cliente.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
