const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const express = require("express");
const {
  solicitudesPendientes, solicitudesCambioPendientes, resumenDelPeriodo, rangoFechasDelPeriodo, numeroDeEmpleado,
  estadisticasInteracciones, primerMensajeRegistrado, correccionesPorEmpleado,
  ultimaActividadPorEmpleado, fichadasCompletasPorEmpleado, saludFichajePeriodo,
  crearLicencia, listarLicencias, licenciasActivasEnFecha, licenciasEnRango, eliminarLicencia,
  solicitudesCancelacionPendientes,
  filaDelDiaPorFecha, filasDelPeriodoDeEmpleado,
  todasLasSolicitudes, todosLosCambiosDeTurno, todasLasCancelaciones,
  pedidosTotalesPorEmpleado, periodosRecientes,
} = require("./db");
const { todosLosEmpleados, getSectorDeEmpleado } = require("./motorCalculo");
const { turnoRealDelDia, GRUPO_A, GRUPO_B } = require("./turnosMantenimiento");
const { twilioClient } = require("./twilioClient");
const whatsapp = require("./whatsapp");

const router = express.Router();
router.use(express.json());
// Sirve assets estaticos (ej. el logo) desde public/ bajo /panel/*.
router.use(express.static(path.join(__dirname, "..", "public")));

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
  // Para cada correccion pendiente, se suma el dato que YA existe ese dia
  // (si existe) -- asi el admin ve de entrada si esta pisando un fichaje
  // real o completando un dia vacio, sin tener que ir a buscarlo aparte.
  const correcciones = solicitudesPendientes().map((s) => {
    const actual = filaDelDiaPorFecha(s.empleado, s.fecha);
    return {
      ...s,
      dato_actual: actual ? { ingreso: actual.ingreso, egreso: actual.egreso, turno: actual.turno, alerta: actual.alerta } : null,
    };
  });

  res.json({
    correcciones,
    cambios: solicitudesCambioPendientes(),
    cancelaciones: solicitudesCancelacionPendientes(),
  });
});

function fechaISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Proximos 7 dias (incluye hoy) con francos de mantenimiento (via la formula
// + excepciones ya aprobadas) y licencias activas en ese rango -- para la
// tarjeta "proximos dias libres" del dashboard.
function proximosDiasLibres() {
  const hoy = new Date();
  const dentroDe6Dias = new Date(hoy);
  dentroDe6Dias.setDate(dentroDe6Dias.getDate() + 6);

  const equipoMantenimiento = [...GRUPO_A, ...GRUPO_B];
  const francos = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(hoy);
    d.setDate(d.getDate() + i);
    const iso = fechaISO(d);
    for (const empleado of equipoMantenimiento) {
      const turno = turnoRealDelDia(empleado, d);
      if (turno && turno.tipo === "franco") francos.push({ empleado, fecha: iso, tipo: "Franco" });
    }
  }

  const licencias = licenciasEnRango(fechaISO(hoy), fechaISO(dentroDe6Dias)).map((l) => ({
    empleado: l.empleado, fecha: l.fechaDesde > fechaISO(hoy) ? l.fechaDesde : fechaISO(hoy), tipo: l.tipo,
  }));

  return [...francos, ...licencias].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

router.get("/api/resumen-general", requerirAuth, async (req, res) => {
  const hoy = new Date();
  const periodo = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  const hoyISO = fechaISO(hoy);

  const empleados = todosLosEmpleados();
  const conWhatsapp = empleados.filter((e) => numeroDeEmpleado(e)).length;

  const resumen = resumenDelPeriodo(periodo);
  const totales = resumen.reduce(
    (acc, r) => ({ totalHs: acc.totalHs + r.totalHs, h50: acc.h50 + r.h50, h100: acc.h100 + r.h100 }),
    { totalHs: 0, h50: 0, h100: 0 }
  );

  const fichaje = saludFichajePeriodo(periodo);

  // Estado del sistema: uptime del proceso, si el watchdog detecto caidas
  // recientes, y el estado real de la cuenta de Twilio (llamada en vivo --
  // si falla no bloquea el resto del dashboard).
  let monitor = { unstableRestarts: 0, avisadoCaido: false };
  try {
    monitor = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".monitor-estado.json"), "utf8"));
  } catch { /* todavia no corrio el watchdog una vez */ }

  let twilioEstado = null;
  try {
    const cuenta = await twilioClient.api.v2010.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    twilioEstado = { status: cuenta.status, tipo: cuenta.type };
  } catch (err) {
    twilioEstado = { error: err.message };
  }

  res.json({
    periodo,
    rango: rangoFechasDelPeriodo(periodo),
    pendientes: {
      correcciones: solicitudesPendientes().length,
      cambios: solicitudesCambioPendientes().length,
      cancelaciones: solicitudesCancelacionPendientes().length,
    },
    licenciasHoy: licenciasActivasEnFecha(hoyISO),
    proximosLibres: proximosDiasLibres(),
    empleados: { total: empleados.length, conWhatsapp },
    horas: {
      total: Math.round(totales.totalHs * 100) / 100,
      h50: Math.round(totales.h50 * 100) / 100,
      h100: Math.round(totales.h100 * 100) / 100,
    },
    fichaje,
    sistema: {
      uptimeSegundos: Math.round(process.uptime()),
      unstableRestarts: monitor.unstableRestarts,
      avisadoCaido: monitor.avisadoCaido,
      twilio: twilioEstado,
    },
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

router.post("/api/cancelacion/:id/:accion", requerirAuth, async (req, res) => {
  const { id, accion } = req.params;
  if (!["aprobar", "rechazar"].includes(accion)) return res.status(400).json({ ok: false, error: "Accion invalida" });
  try {
    const periodosTocados = new Set();
    const resultado = await whatsapp.resolverUnaSolicitudCancelacion(accion, Number(id), periodosTocados);
    for (const periodo of periodosTocados) await whatsapp.regenerarYEnviarExcel(periodo);
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

// Detalle dia por dia de UN empleado en un periodo -- para que el admin
// pueda chequear si ya hay un fichaje real antes de aprobar/rechazar una
// correccion, o simplemente buscar el historial de alguien.
router.get("/api/dias", requerirAuth, (req, res) => {
  const { empleado } = req.query;
  if (!empleado || !todosLosEmpleados().includes(empleado)) {
    return res.status(400).json({ ok: false, error: "Empleado inválido" });
  }
  const hoy = new Date();
  const periodo = req.query.periodo || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  res.json({ periodo, rango: rangoFechasDelPeriodo(periodo), dias: filasDelPeriodoDeEmpleado(empleado, periodo) });
});

// Historial completo (todos los estados, no solo pendientes) de los tres
// tipos de solicitud -- el front los combina en una sola tabla ordenada.
router.get("/api/historial", requerirAuth, (req, res) => {
  res.json({
    correcciones: todasLasSolicitudes(200),
    cambios: todosLosCambiosDeTurno(200),
    cancelaciones: todasLasCancelaciones(200),
  });
});

router.get("/api/resumen", requerirAuth, (req, res) => {
  const hoy = new Date();
  const periodo = req.query.periodo || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  res.json({ periodo, rango: rangoFechasDelPeriodo(periodo), resumen: resumenDelPeriodo(periodo) });
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

  // Tendencia de horas extra (50%+100%) por sector, ultimos periodos con
  // datos -- para ver si la carga de mantenimiento vs conserjeria viene
  // subiendo o bajando mes a mes, no solo la foto del periodo actual.
  const tendenciaHoras = periodosRecientes(6).map((p) => {
    const filas = resumenDelPeriodo(p).map((r) => ({ ...r, sector: getSectorDeEmpleado(r.empleado) }));
    const sumar = (sector) => Math.round(
      filas.filter((r) => r.sector === sector).reduce((a, r) => a + r.h50 + r.h100, 0) * 100
    ) / 100;
    return { periodo: p, mantenimiento: sumar("mantenimiento"), conserjeria: sumar("conserjeria") };
  });

  res.json({
    desde: primerMensajeRegistrado(), // null si todavia no se registro nada
    periodo,
    rango: rangoFechasDelPeriodo(periodo),
    interacciones: interaccionesPorEmpleado,
    correcciones: correccionesPorEmpleado(),
    pedidosTotales: pedidosTotalesPorEmpleado(),
    actividad: ultimaActividadPorEmpleado(),
    fichadas,
    tendenciaHoras,
  });
});

const TIPOS_LICENCIA = ["Vacaciones", "Licencia médica", "Estudio", "Otro"];

function hoyISO() {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
}

router.get("/api/licencias", requerirAuth, (req, res) => {
  res.json({ licencias: listarLicencias(), hoy: licenciasActivasEnFecha(hoyISO()), tipos: TIPOS_LICENCIA });
});

router.post("/api/licencias", requerirAuth, async (req, res) => {
  const { empleado, fechaDesde, fechaHasta, tipo } = req.body || {};

  if (!empleado || !todosLosEmpleados().includes(empleado)) {
    return res.status(400).json({ ok: false, error: "Empleado inválido" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaDesde || "") || !/^\d{4}-\d{2}-\d{2}$/.test(fechaHasta || "")) {
    return res.status(400).json({ ok: false, error: "Fechas inválidas" });
  }
  if (fechaHasta < fechaDesde) {
    return res.status(400).json({ ok: false, error: "La fecha hasta no puede ser anterior a la fecha desde" });
  }
  const dias = Math.round((new Date(fechaHasta + "T00:00:00") - new Date(fechaDesde + "T00:00:00")) / 86400000) + 1;
  if (dias > 90) {
    return res.status(400).json({ ok: false, error: "El rango no puede superar los 90 días" });
  }
  if (!tipo || !TIPOS_LICENCIA.includes(tipo)) {
    return res.status(400).json({ ok: false, error: "Tipo inválido" });
  }

  try {
    const { id, omitidos, periodos } = crearLicencia({ empleado, fechaDesde, fechaHasta, tipo, cargadoPor: "panel" });
    for (const periodo of periodos) await whatsapp.regenerarYEnviarExcel(periodo);
    res.json({ ok: true, id, omitidos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete("/api/licencias/:id", requerirAuth, async (req, res) => {
  try {
    const { periodos } = eliminarLicencia(Number(req.params.id));
    for (const periodo of periodos) await whatsapp.regenerarYEnviarExcel(periodo);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "panel.html"));
});

module.exports = router;
