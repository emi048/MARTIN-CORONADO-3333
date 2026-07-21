const crypto = require("crypto");
const path = require("path");
const express = require("express");
const {
  solicitudesPendientes, solicitudesCambioPendientes, resumenDelPeriodo, numeroDeEmpleado,
  estadisticasInteracciones, primerMensajeRegistrado, correccionesPorEmpleado,
  ultimaActividadPorEmpleado, fichadasCompletasPorEmpleado,
} = require("./db");
const { todosLosEmpleados, getSectorDeEmpleado } = require("./motorCalculo");
const whatsapp = require("./whatsapp");

const router = express.Router();
router.use(express.json());

// Sesiones en memoria (token -> vencimiento). Si el server reinicia hay que
// volver a loguearse -- aceptable para un panel de uso ocasional, no vale
// la pena persistirlo en la base por esto.
const SESIONES = new Map();
const DURACION_SESION_MS = 12 * 60 * 60 * 1000; // 12hs

function generarToken() {
  return crypto.randomBytes(24).toString("hex");
}

router.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PANEL_PASSWORD || password !== process.env.ADMIN_PANEL_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Contraseña incorrecta" });
  }
  const token = generarToken();
  SESIONES.set(token, Date.now() + DURACION_SESION_MS);
  res.json({ ok: true, token });
});

function requerirAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const expira = token && SESIONES.get(token);
  if (!expira || expira < Date.now()) {
    if (token) SESIONES.delete(token);
    return res.status(401).json({ ok: false, error: "No autorizado" });
  }
  next();
}

router.get("/api/pendientes", requerirAuth, (req, res) => {
  res.json({
    correcciones: solicitudesPendientes(),
    cambios: solicitudesCambioPendientes(),
  });
});

router.post("/api/correccion/:id/:accion", requerirAuth, async (req, res) => {
  const { id, accion } = req.params;
  if (!["aprobar", "rechazar"].includes(accion)) return res.status(400).json({ ok: false, error: "Accion invalida" });
  try {
    const periodosTocados = new Set();
    const resultado = await whatsapp.resolverUnaSolicitud(accion, Number(id), periodosTocados);
    for (const periodo of periodosTocados) await whatsapp.regenerarYEnviarExcel(periodo);
    res.json({ ok: true, resultado });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/api/cambio/:id/:accion", requerirAuth, async (req, res) => {
  const { id, accion } = req.params;
  if (!["aprobar", "rechazar"].includes(accion)) return res.status(400).json({ ok: false, error: "Accion invalida" });
  try {
    const resultado = await whatsapp.resolverUnaSolicitudCambio(accion, Number(id));
    res.json({ ok: true, resultado });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/api/empleados", requerirAuth, (req, res) => {
  const empleados = todosLosEmpleados().map((nombre) => ({
    nombre,
    sector: getSectorDeEmpleado(nombre),
    whatsapp: numeroDeEmpleado(nombre) || null,
  }));
  res.json({ empleados });
});

router.get("/api/resumen", requerirAuth, (req, res) => {
  const hoy = new Date();
  const periodo = req.query.periodo || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  res.json({ periodo, resumen: resumenDelPeriodo(periodo) });
});

router.get("/api/estadisticas", requerirAuth, (req, res) => {
  const hoy = new Date();
  const periodo = req.query.periodo || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;

  // Interacciones: viene como filas (empleado, tipo, cantidad) -- se
  // agrupan en un objeto por empleado para que el front no tenga que hacerlo.
  const interaccionesPorEmpleado = {};
  for (const row of estadisticasInteracciones()) {
    if (!interaccionesPorEmpleado[row.empleado]) interaccionesPorEmpleado[row.empleado] = { total: 0 };
    interaccionesPorEmpleado[row.empleado][row.tipo] = row.cantidad;
    interaccionesPorEmpleado[row.empleado].total += row.cantidad;
  }

  const fichadas = fichadasCompletasPorEmpleado(periodo).map((f) => ({
    ...f,
    porcentaje: f.diasTotal > 0 ? Math.round((f.diasCompletos / f.diasTotal) * 100) : null,
  }));

  res.json({
    desde: primerMensajeRegistrado(), // null si todavia no se registro nada
    periodo,
    interacciones: interaccionesPorEmpleado,
    correcciones: correccionesPorEmpleado(),
    actividad: ultimaActividadPorEmpleado(),
    fichadas,
  });
});

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "panel.html"));
});

module.exports = router;
