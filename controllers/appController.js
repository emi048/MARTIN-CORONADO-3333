const crypto = require("crypto");
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const {
  buscarEmpleadoAppPorUsuario, empleadoAppPorId,
  crearSesionApp, renovarSesionApp, eliminarSesionApp, empleadoIdDeSesionApp,
  filasDelPeriodoDeEmpleado, rangoFechasDelPeriodo, obtenerFichadaHoy, resumenDelPeriodo,
} = require("../services/db");
const { turnoRealDelDia } = require("../services/turnosMantenimiento");
const { turnoDelDia: turnoConserjeriaDelDia } = require("../services/turnosConserjeria");

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

router.post("/api/login", async (req, res) => {
  const { usuario, pin } = req.body || {};
  const empleado = usuario ? buscarEmpleadoAppPorUsuario(usuario) : null;
  const ok = empleado && (await bcrypt.compare(String(pin || ""), empleado.pin_hash));
  if (!ok) return res.status(401).json({ ok: false, error: "Usuario o PIN incorrecto" });
  const token = generarToken();
  crearSesionApp(token, empleado.id, nuevoVencimiento());
  res.json({ ok: true, token, nombre: empleado.nombre });
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

function fechaISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Fichadas propias del dia (estado en vivo, via HikCentral) + historial del
// periodo (filas_diarias, el mismo dato que ya arma el pipeline mensual).
router.get("/api/mis-fichadas", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  const hoy = new Date();
  const periodo = req.query.periodo || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  res.json({
    periodo,
    rango: rangoFechasDelPeriodo(periodo),
    hoy: obtenerFichadaHoy(nombre, fechaISO(hoy)) || null,
    dias: filasDelPeriodoDeEmpleado(nombre, periodo),
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
