const crypto = require("crypto");
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const {
  buscarEmpleadoAppPorUsuario, empleadoAppPorId,
  crearSesionApp, renovarSesionApp, eliminarSesionApp, empleadoIdDeSesionApp,
  obtenerFichadaHoy, resumenDelPeriodo,
  estaBloqueadoLoginApp, registrarIntentoFallidoLoginApp, limpiarIntentosLoginApp,
  cambiarPasswordEmpleadoApp,
  numeroDeEmpleado, crearSolicitud, solicitudesDeEmpleado, crearSolicitudCambio, solicitudesCambioDeEmpleado,
} = require("../services/db");
const { turnoRealDelDia, GRUPO_A, GRUPO_B } = require("../services/turnosMantenimiento");
const { turnoDelDia: turnoConserjeriaDelDia } = require("../services/turnosConserjeria");
const { calcularAsistencia } = require("../services/asistencia");

const router = express.Router();
router.use(express.json());
// Sirve la PWA (index.html, manifest.json, sw.js, icons) desde public/app/ bajo /app/*.
router.use(express.static(path.join(__dirname, "..", "public", "app")));

// Mismo esquema de sesion deslizante que el panel de admin, pero en su
// propia tabla (sesiones_app) para que un token de empleado nunca se pueda
// confundir con uno de admin.
const DURACION_SESION_MS = 15 * 60 * 1000;

function generarToken() {
  return crypto.randomBytes(24).toString("hex");
}

function nuevoVencimiento() {
  return new Date(Date.now() + DURACION_SESION_MS).toISOString();
}

// Freno de fuerza bruta: sin este limite se podria probar por script,
// mas todavia con una contraseña inicial predecible (usuario + "1"). El
// bloqueo es por usuario (no por IP) y persiste en la base -- sobrevive a
// un reinicio del server.
router.post("/api/login", async (req, res) => {
  const { usuario, pin } = req.body || {};
  if (!usuario) return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrecta" });
  if (estaBloqueadoLoginApp(usuario)) {
    return res.status(429).json({ ok: false, error: "Demasiados intentos fallidos. Probá de nuevo en unos minutos." });
  }
  const empleado = buscarEmpleadoAppPorUsuario(usuario);
  const ok = empleado && (await bcrypt.compare(String(pin || ""), empleado.pin_hash));
  if (!ok) {
    registrarIntentoFallidoLoginApp(usuario);
    return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrecta" });
  }
  limpiarIntentosLoginApp(usuario);
  const token = generarToken();
  crearSesionApp(token, empleado.id, nuevoVencimiento());
  res.json({ ok: true, token, nombre: empleado.nombre, debeCambiarPin: !!empleado.debe_cambiar_pin });
});

router.post("/api/logout", (req, res) => {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token) eliminarSesionApp(token);
  res.json({ ok: true });
});

function requerirAuthEmpleado(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const valida = token && renovarSesionApp(token, nuevoVencimiento());
  if (!valida) return res.status(401).json({ ok: false, error: "No autorizado" });
  const empleado = empleadoAppPorId(empleadoIdDeSesionApp(token));
  if (!empleado || !empleado.activo) return res.status(401).json({ ok: false, error: "No autorizado" });
  req.empleadoApp = empleado;
  next();
}

// Cambio de contraseña iniciado por el empleado (ya logueado) -- pide la
// actual para confirmar identidad (no alcanza con tener el token: si el
// celular queda desbloqueado un momento, cualquiera podria entrar a esta
// pantalla). Limpia debe_cambiar_pin al aplicarse.
router.post("/api/cambiar-password", requerirAuthEmpleado, async (req, res) => {
  const { passwordActual, passwordNueva } = req.body || {};
  if (!passwordNueva || String(passwordNueva).length < 6) {
    return res.status(400).json({ ok: false, error: "La contraseña nueva tiene que tener al menos 6 caracteres" });
  }
  const ok = await bcrypt.compare(String(passwordActual || ""), req.empleadoApp.pin_hash);
  if (!ok) return res.status(401).json({ ok: false, error: "La contraseña actual no es correcta" });

  const nuevoHash = await bcrypt.hash(String(passwordNueva), 10);
  cambiarPasswordEmpleadoApp(req.empleadoApp.id, nuevoHash);
  res.json({ ok: true });
});

function fechaISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^\d{2}:\d{2}$/;

// Fichadas propias del dia (estado en vivo, via HikCentral) + historial del
// periodo con ausencias/llegadas tarde/deficit de sabado (mismo calculo que
// usa el panel de admin, ver services/asistencia.js) + resumen de horas.
router.get("/api/mis-fichadas", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  const hoy = new Date();
  const periodo = req.query.periodo || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  const asistencia = calcularAsistencia(nombre, periodo);
  const resumen = resumenDelPeriodo(periodo).find((r) => r.empleado === nombre) || null;
  res.json({
    ...asistencia,
    hoy: obtenerFichadaHoy(nombre, fechaISO(hoy)) || null,
    resumen,
  });
});

// Turno asignado de hoy + horas acumuladas del periodo actual.
router.get("/api/mi-horario", requerirAuthEmpleado, (req, res) => {
  const { nombre, sector } = req.empleadoApp;
  const hoy = new Date();
  const periodo = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  const turnoHoy = sector === "mantenimiento" ? turnoRealDelDia(nombre, hoy) : turnoConserjeriaDelDia(nombre, hoy);
  const resumen = resumenDelPeriodo(periodo).find((r) => r.empleado === nombre) || null;
  res.json({ periodo, turnoHoy, resumen });
});

// Pide corregir el ingreso y/o egreso de un dia puntual -- misma tabla y
// mismo flujo de aprobacion del admin que ya usa el bot de WhatsApp (panel
// -> pestaña Pendientes). No aplica nada todavia: solo queda "pendiente".
router.post("/api/solicitar-correccion", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  const { fecha, ingreso, egreso, mensaje } = req.body || {};
  if (!fecha || !RE_FECHA.test(fecha)) {
    return res.status(400).json({ ok: false, error: "Elegí una fecha válida" });
  }
  const ingresoLimpio = ingreso ? String(ingreso).trim() : "";
  const egresoLimpio = egreso ? String(egreso).trim() : "";
  if (!ingresoLimpio && !egresoLimpio) {
    return res.status(400).json({ ok: false, error: "Completá al menos un horario (ingreso o egreso)" });
  }
  if ((ingresoLimpio && !RE_HORA.test(ingresoLimpio)) || (egresoLimpio && !RE_HORA.test(egresoLimpio))) {
    return res.status(400).json({ ok: false, error: "El horario tiene que tener formato HH:MM" });
  }
  const id = crearSolicitud({
    empleado: nombre,
    numeroWhatsapp: numeroDeEmpleado(nombre) || "",
    periodo: fecha.slice(0, 7),
    fecha,
    ingresoPropuesto: ingresoLimpio || null,
    egresoPropuesto: egresoLimpio || null,
    mensajeOriginal: mensaje ? String(mensaje).trim().slice(0, 300) : "",
  });
  res.json({ ok: true, id });
});

// Compañeros elegibles para pedir un cambio de turno -- solo tiene sentido
// para el equipo rotativo de mantenimiento (GRUPO_A/GRUPO_B en
// turnosMantenimiento.js), que es como ya funciona por WhatsApp. Devuelve
// vacio para cualquier otro empleado, asi el front sabe que tiene que
// ocultar la opcion en vez de mostrar un formulario que nunca va a andar.
router.get("/api/companeros", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  if (![...GRUPO_A, ...GRUPO_B].includes(nombre)) return res.json({ ok: true, companeros: [] });
  res.json({ ok: true, companeros: [...GRUPO_A, ...GRUPO_B].filter((e) => e !== nombre) });
});

// Pide cambiar un turno propio por el de un compañero (ambos rotativos de
// mantenimiento) -- misma tabla/flujo que ya usa el bot de WhatsApp. Solo
// GRUPO_A/GRUPO_B (los 4 rotativos) pueden hacerlo -- Emiliano/Leonel tienen
// horario fijo y no entran en esta formula de intercambio.
router.post("/api/solicitar-cambio", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  if (![...GRUPO_A, ...GRUPO_B].includes(nombre)) {
    return res.status(403).json({ ok: false, error: "El cambio de turno es solo para el equipo rotativo de mantenimiento" });
  }
  const { fechaA, empleadoB, fechaB } = req.body || {};
  const companerosValidos = [...GRUPO_A, ...GRUPO_B].filter((e) => e !== nombre);
  if (!fechaA || !RE_FECHA.test(fechaA) || !fechaB || !RE_FECHA.test(fechaB)) {
    return res.status(400).json({ ok: false, error: "Elegí las dos fechas" });
  }
  if (!empleadoB || !companerosValidos.includes(empleadoB)) {
    return res.status(400).json({ ok: false, error: "Elegí un compañero válido" });
  }
  const id = crearSolicitudCambio({
    empleadoA: nombre,
    numeroWhatsappA: numeroDeEmpleado(nombre) || "",
    empleadoB,
    fechaA,
    fechaB,
  });
  res.json({ ok: true, id });
});

// Historial de pedidos propios (correcciones + cambios de turno), con su
// estado -- para que el empleado pueda ver si ya se lo resolvieron sin
// tener que preguntarle al admin.
router.get("/api/mis-solicitudes", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  res.json({
    ok: true,
    correcciones: solicitudesDeEmpleado(nombre, 20),
    cambios: solicitudesCambioDeEmpleado(nombre, 20),
  });
});

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "app", "index.html"));
});

module.exports = router;
