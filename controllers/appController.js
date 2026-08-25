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
} = require("../services/db");
const { turnoRealDelDia } = require("../services/turnosMantenimiento");
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

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "app", "index.html"));
});

module.exports = router;
