const webpush = require("web-push");
const {
  suscripcionesDeEmpleado, eliminarPushSubscripcion, todasLasSuscripcionesPanel, eliminarPushSubscripcionPanel,
  registrarNotificacionApp, registrarNotificacionPanel,
} = require("./db");

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Manda un push a todos los dispositivos suscriptos de un empleado (puede
// tener mas de uno). Nunca tira error hacia arriba -- es un aviso, no la
// accion en si, mismo criterio que avisarResultado() por WhatsApp: si
// falla, se loguea y se sigue. Un endpoint que ya no existe (410/404, el
// navegador desinstalo la suscripcion) se borra solo.
async function enviarPushAEmpleado(empleadoAppId, { titulo, cuerpo, url }) {
  registrarNotificacionApp(empleadoAppId, { titulo, cuerpo, url });
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const subs = suscripcionesDeEmpleado(empleadoAppId);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: titulo, body: cuerpo, url: url || "/app/" })
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        eliminarPushSubscripcion(sub.endpoint);
      } else {
        console.error(`Error mandando push a empleado ${empleadoAppId}:`, err.message);
      }
    }
  }
}



// Mismo criterio que enviarPushAEmpleado, pero a TODAS las suscripciones
// del panel (login compartido, puede haber mas de un dispositivo). Se usa
// para avisar al admin de algo que necesita su atencion (ej. una
// solicitud nueva) sin depender de que tenga WhatsApp a mano.
async function enviarPushATodoElPanel({ titulo, cuerpo, url }) {
  registrarNotificacionPanel({ titulo, cuerpo, url });
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const subs = todasLasSuscripcionesPanel();
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: titulo, body: cuerpo, url: url || "/panel/" })
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        eliminarPushSubscripcionPanel(sub.endpoint);
      } else {
        console.error("Error mandando push al panel:", err.message);
      }
    }
  }
}

// Mismo criterio que enviarPushAEmpleado, pero a varios empleados a la vez
// (ej. todo un sector, o todos los jefes/coordinadores) -- se usa desde el
// Mural cuando se publica una tarea para un grupo.
async function enviarPushAEmpleados(empleadoIds, { titulo, cuerpo, url }) {
  for (const empleadoId of empleadoIds) {
    await enviarPushAEmpleado(empleadoId, { titulo, cuerpo, url });
  }
}

module.exports = { enviarPushAEmpleado, enviarPushAEmpleados, enviarPushATodoElPanel };
