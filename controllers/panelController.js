const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const express = require("express");
const bcrypt = require("bcryptjs");
const {
  solicitudesPendientes, solicitudesCambioPendientes, resumenDelPeriodo, rangoFechasDelPeriodo, numeroDeEmpleado,
  registrarNumero, eliminarNumero,
  crearSesionPanel, renovarSesionPanel, eliminarSesionPanel,
  estadisticasInteracciones, primerMensajeRegistrado, correccionesPorEmpleado,
  ultimaActividadPorEmpleado, fichadasCompletasPorEmpleado, saludFichajePeriodo,
  crearLicencia, listarLicencias, licenciasActivasEnFecha, eliminarLicencia,
  solicitudesCancelacionPendientes,
  filaDelDiaPorFecha,
  todasLasSolicitudes, todosLosCambiosDeTurno, todasLasCancelaciones,
  pedidosTotalesPorEmpleado, periodosRecientes,
  crearEmpleadoApp, listarEmpleadosApp, empleadoAppPorId, actualizarPinEmpleadoApp, eliminarEmpleadoApp,
  guardarPushSubscripcionPanel,
  crearAdmin, listarAdmins, adminPorUsuario, adminPorId, actualizarPerfilAdminPorId, actualizarPasswordAdmin,
  actualizarDatosAdmin, adminIdDeSesionPanel,
  listarNovedades, comentariosDeNovedades, crearComentarioNovedad,
  crearPostMural, listarPostsMural, reclamarPostMural, asignarPostMural, desasignarPostMural,
  finalizarPostMural, postMuralPorId, actualizarRolEmpleado, crearComentarioMural,
} = require("../services/db");
const { todosLosEmpleados, getSectorDeEmpleado, FERIADOS, calcularDeficitSabadoSemanal } = require("../services/motorCalculo");
const { turnoRealDelDia, esDelEquipo: esDelEquipoMantenimiento, GRUPO_A, GRUPO_B } = require("../services/turnosMantenimiento");
const { turnoDelDia: turnoConserjeriaDelDia, EQUIPO: EQUIPO_CONSERJERIA } = require("../services/turnosConserjeria");
const { calcularAsistencia } = require("../services/asistencia");
const { twilioClient } = require("../services/twilioClient");
const whatsapp = require("./whatsappController");
const { enviarPushATodoElPanel, enviarPushAEmpleado, enviarPushAEmpleados } = require("../services/pushNotifications");

const router = express.Router();
router.use(express.json({ limit: "6mb" }));
// Sirve assets estaticos (ej. el logo) desde public/ bajo /panel/*.
router.use(express.static(path.join(__dirname, "..", "public")));

// Sesiones persistidas en la base (sobreviven a un reinicio del server, que
// pasa seguido por el auto-deploy) y deslizantes: cada request autenticado
// empuja el vencimiento otros 15 min -- si no hay actividad se cierra sola,
// no hace falta un limite fijo desde el login.
const DURACION_SESION_MS = 15 * 60 * 1000;

function generarToken() {
  return crypto.randomBytes(24).toString("hex");
}

function nuevoVencimiento() {
  return new Date(Date.now() + DURACION_SESION_MS).toISOString();
}

router.post("/api/login", async (req, res) => {
  const { usuario, password } = req.body || {};
  if (!usuario || !password) {
    return res.status(401).json({ ok: false, error: "Completá usuario y contraseña" });
  }
  const admin = adminPorUsuario(String(usuario).trim());
  const ok = admin && (await bcrypt.compare(String(password), admin.pass_hash));
  if (!ok) {
    return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrecta" });
  }
  const token = generarToken();
  crearSesionPanel(token, nuevoVencimiento(), admin.id);
  res.json({ ok: true, token });
});

router.post("/api/logout", (req, res) => {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token) eliminarSesionPanel(token);
  res.json({ ok: true });
});

function requerirAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const valida = token && renovarSesionPanel(token, nuevoVencimiento());
  if (!valida) {
    return res.status(401).json({ ok: false, error: "No autorizado" });
  }
  req.adminId = adminIdDeSesionPanel(token);
  next();
}

// Cambio de contraseña del panel, ya logueado -- pide la actual para
// confirmar identidad (mismo criterio que el cambio de PIN de la app de
// empleado). Migro de env var a hash en base justamente para poder hacer
// esto sin tocar el .env ni reiniciar el servidor.
router.post("/api/cambiar-password", requerirAuth, async (req, res) => {
  const { passwordActual, passwordNueva } = req.body || {};
  if (!passwordNueva || String(passwordNueva).length < 8) {
    return res.status(400).json({ ok: false, error: "La contraseña nueva tiene que tener al menos 8 caracteres" });
  }
  const admin = adminPorId(req.adminId);
  const ok = admin && (await bcrypt.compare(String(passwordActual || ""), admin.pass_hash));
  if (!ok) return res.status(401).json({ ok: false, error: "La contraseña actual no es correcta" });
  const nuevoHash = await bcrypt.hash(String(passwordNueva), 10);
  actualizarPasswordAdmin(req.adminId, nuevoHash);
  res.json({ ok: true });
});

// Perfil del admin logueado (nombre/apellido/usuario/sector/foto).
router.get("/api/perfil", requerirAuth, (req, res) => {
  const admin = adminPorId(req.adminId);
  if (!admin) return res.json({ ok: true, perfil: null });
  const { pass_hash, ...perfil } = admin;
  res.json({ ok: true, perfil });
});

router.post("/api/perfil", requerirAuth, (req, res) => {
  const { nombre, apellido, usuario, sector, foto } = req.body || {};
  if (foto && !String(foto).startsWith("data:image/")) {
    return res.status(400).json({ ok: false, error: "La foto tiene que ser una imagen" });
  }
  if (!usuario || !String(usuario).trim()) {
    return res.status(400).json({ ok: false, error: "El usuario no puede estar vacío" });
  }
  try {
    actualizarPerfilAdminPorId(req.adminId, {
      nombre: nombre ? String(nombre).trim().slice(0, 60) : null,
      apellido: apellido ? String(apellido).trim().slice(0, 60) : null,
      usuario: String(usuario).trim().slice(0, 60),
      sector: sector && ["mantenimiento", "conserjeria"].includes(sector) ? sector : null,
      foto: foto || null,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: "Ese usuario ya está en uso" });
  }
  const admin = adminPorId(req.adminId);
  const { pass_hash, ...perfil } = admin;
  res.json({ ok: true, perfil });
});

// Clave publica VAPID -- la necesita el navegador para pushManager.subscribe.
router.get("/api/push/vapid-public-key", requerirAuth, (req, res) => {
  res.json({ ok: true, key: process.env.VAPID_PUBLIC_KEY || "" });
});

// Guarda la suscripcion Push del panel -- PushSubscription.toJSON() manda
// exactamente { endpoint, keys: { p256dh, auth } }.
router.post("/api/push/suscribirse", requerirAuth, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ ok: false, error: "Suscripción inválida" });
  }
  guardarPushSubscripcionPanel({ endpoint, p256dh: keys.p256dh, auth: keys.auth });
  res.json({ ok: true });
});

// ── Administracion de cuentas de admin (pestaña "Admins") ──
router.get("/api/admins", requerirAuth, (req, res) => {
  res.json({ ok: true, admins: listarAdmins() });
});

router.post("/api/admins", requerirAuth, async (req, res) => {
  const { nombre, apellido, puesto, usuario, permisos, password } = req.body || {};
  if (!usuario || !String(usuario).trim()) return res.status(400).json({ ok: false, error: "Elegí un usuario" });
  if (!password || String(password).length < 8) return res.status(400).json({ ok: false, error: "La contraseña tiene que tener al menos 8 caracteres" });
  const passHash = await bcrypt.hash(String(password), 10);
  try {
    const id = crearAdmin({
      nombre: nombre ? String(nombre).trim().slice(0, 60) : null,
      apellido: apellido ? String(apellido).trim().slice(0, 60) : null,
      puesto: puesto ? String(puesto).trim().slice(0, 60) : null,
      usuario: String(usuario).trim().slice(0, 60),
      passHash,
      permisos: permisos || "admin",
    });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(400).json({ ok: false, error: "Ese usuario ya está en uso" });
  }
});

router.post("/api/admins/:id", requerirAuth, (req, res) => {
  const id = Number(req.params.id);
  const admin = adminPorId(id);
  if (!admin) return res.status(404).json({ ok: false, error: "No encontrado" });
  const { nombre, apellido, puesto, permisos } = req.body || {};
  actualizarDatosAdmin(id, {
    nombre: nombre !== undefined ? (nombre ? String(nombre).trim().slice(0, 60) : null) : admin.nombre,
    apellido: apellido !== undefined ? (apellido ? String(apellido).trim().slice(0, 60) : null) : admin.apellido,
    puesto: puesto !== undefined ? (puesto ? String(puesto).trim().slice(0, 60) : null) : admin.puesto,
    permisos: permisos || admin.permisos,
    activo: !!admin.activo,
  });
  res.json({ ok: true });
});

router.post("/api/admins/:id/activo", requerirAuth, (req, res) => {
  const id = Number(req.params.id);
  const { activo } = req.body || {};
  if (id === req.adminId && activo === false) {
    return res.status(400).json({ ok: false, error: "No podés desactivar tu propia cuenta" });
  }
  const admin = adminPorId(id);
  if (!admin) return res.status(404).json({ ok: false, error: "No encontrado" });
  actualizarDatosAdmin(id, { nombre: admin.nombre, apellido: admin.apellido, puesto: admin.puesto, permisos: admin.permisos, activo: !!activo });
  res.json({ ok: true });
});

router.post("/api/admins/:id/resetear-password", requerirAuth, async (req, res) => {
  const id = Number(req.params.id);
  const admin = adminPorId(id);
  if (!admin) return res.status(404).json({ ok: false, error: "No encontrado" });
  const nueva = crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  const hash = await bcrypt.hash(nueva, 10);
  actualizarPasswordAdmin(id, hash);
  res.json({ ok: true, passwordNueva: nueva });
});

// ── Novedades del recorrido diario -- mismos datos que ya carga la app de
// empleado (services/db.js), leidos y comentados tambien desde el panel. ──
const RE_PERIODO_PANEL = /^\d{4}-\d{2}$/;
router.get("/api/novedades", requerirAuth, (req, res) => {
  const periodo = RE_PERIODO_PANEL.test(req.query.periodo || "") ? req.query.periodo : null;
  const novedades = listarNovedades(periodo);
  const comentarios = comentariosDeNovedades(novedades.map((n) => n.id));
  res.json({
    ok: true,
    novedades: novedades.map((n) => ({ ...n, comentarios: comentarios.filter((c) => c.novedad_id === n.id) })),
  });
});

router.post("/api/novedades/:id/comentarios", requerirAuth, (req, res) => {
  const novedadId = Number(req.params.id);
  const texto = String((req.body || {}).texto || "").trim().slice(0, 500);
  if (!novedadId || !texto) return res.status(400).json({ ok: false, error: "Escribí un comentario" });
  const admin = adminPorId(req.adminId);
  const nombreAdmin = admin ? `${admin.nombre || ""} ${admin.apellido || ""}`.trim() || admin.usuario : "Administrador";
  crearComentarioNovedad({ novedadId, empleadoAppId: null, usuarioNombre: nombreAdmin + " (admin)", texto });
  res.json({ ok: true });
});

// ── Mural de tareas -- posts de un admin dirigidos a una audiencia, que
// un empleado (o un admin, si la tarea es interna) puede reclamar y
// despues un admin aprobar/rechazar/finalizar. ──
const AUDIENCIAS_MURAL = ["mantenimiento", "conserjeria", "jefes", "individual", "admins"];

router.get("/api/mural", requerirAuth, (req, res) => {
  res.json({ ok: true, posts: listarPostsMural() });
});

const RE_FECHA_MURAL = /^\d{4}-\d{2}-\d{2}$/;
router.post("/api/mural", requerirAuth, (req, res) => {
  const { texto, foto, audiencia, empleadoIds, vence } = req.body || {};
  if (!texto || !String(texto).trim()) return res.status(400).json({ ok: false, error: "Escribí una descripción de la tarea" });
  if (!AUDIENCIAS_MURAL.includes(audiencia)) return res.status(400).json({ ok: false, error: "Audiencia inválida" });
  if (foto && !String(foto).startsWith("data:image/")) return res.status(400).json({ ok: false, error: "La foto tiene que ser una imagen" });
  if (vence && !RE_FECHA_MURAL.test(vence)) return res.status(400).json({ ok: false, error: "Fecha de vencimiento inválida" });
  const idsLimpios = audiencia === "individual" ? (Array.isArray(empleadoIds) ? empleadoIds.map(Number).filter(Boolean) : []) : null;
  if (audiencia === "individual" && idsLimpios.length === 0) {
    return res.status(400).json({ ok: false, error: "Elegí al menos un empleado" });
  }
  const admin = adminPorId(req.adminId);
  const autorNombre = admin ? `${admin.nombre || ""} ${admin.apellido || ""}`.trim() || admin.usuario : "Administrador";
  const textoLimpio = String(texto).trim().slice(0, 1000);
  const postId = crearPostMural({
    adminId: req.adminId, autorNombre, texto: textoLimpio,
    foto: foto || null, audiencia, empleadoIds: idsLimpios, vence: vence || null,
  });

  // Push a los destinatarios segun la audiencia -- no bloquea la respuesta
  // ni rompe la creacion del post si falla el envio (mismo criterio que
  // el resto de los avisos push del proyecto).
  const tituloPush = "📌 Nueva tarea";
  const CUERPOS_PUSH_MURAL = {
    individual: "Se te asignó una nueva tarea",
    mantenimiento: "Se agregó una nueva tarea para tu sector",
    conserjeria: "Se agregó una nueva tarea para tu sector",
    jefes: "Se agregó una nueva tarea para jefes/coordinadores",
    admins: "Se agregó una nueva tarea interna",
  };
  const cuerpoPush = CUERPOS_PUSH_MURAL[audiencia] || "Se agregó una nueva tarea";
  if (audiencia === "admins") {
    enviarPushATodoElPanel({ titulo: tituloPush, cuerpo: cuerpoPush, url: "/panel/" }).catch(() => {});
  } else {
    const empleadosActivos = listarEmpleadosApp().filter((e) => e.activo);
    let destino = [];
    if (audiencia === "individual") destino = empleadosActivos.filter((e) => idsLimpios.includes(e.id));
    else if (audiencia === "jefes") destino = empleadosActivos.filter((e) => e.rol === "jefe");
    else destino = empleadosActivos.filter((e) => e.sector === audiencia);
    enviarPushAEmpleados(destino.map((e) => e.id), { titulo: tituloPush, cuerpo: cuerpoPush, url: "/app/" }).catch(() => {});
  }

  res.json({ ok: true, id: postId });
});

// Un admin reclama una tarea interna (audiencia = "admins") -- las demas
// audiencias las reclaman empleados desde la app (appController.js). Deja
// asignado directo, sin paso de aprobacion.
router.post("/api/mural/:id/reclamar", requerirAuth, (req, res) => {
  const post = postMuralPorId(Number(req.params.id));
  if (!post) return res.status(404).json({ ok: false, error: "No encontrado" });
  if (post.audiencia !== "admins") return res.status(400).json({ ok: false, error: "Esta tarea no es para admins" });
  const admin = adminPorId(req.adminId);
  const nombre = admin ? `${admin.nombre || ""} ${admin.apellido || ""}`.trim() || admin.usuario : "Administrador";
  const ok = reclamarPostMural(post.id, { tipo: "admin", id: req.adminId, nombre });
  if (!ok) return res.status(409).json({ ok: false, error: "Ya fue reclamada por otro admin" });
  res.json({ ok: true });
});

// El admin asigna (o reasigna) la tarea a mano -- a un empleado o a otro
// admin, sin depender de que esa persona la reclame ella misma.
router.post("/api/mural/:id/asignar", requerirAuth, (req, res) => {
  const { tipo, id } = req.body || {};
  if (tipo !== "empleado" && tipo !== "admin") return res.status(400).json({ ok: false, error: "Tipo inválido" });
  const nombre = tipo === "admin"
    ? (() => { const a = adminPorId(Number(id)); return a ? `${a.nombre || ""} ${a.apellido || ""}`.trim() || a.usuario : "Administrador"; })()
    : (() => { const e = empleadoAppPorId(Number(id)); return e ? e.nombre : "Empleado"; })();
  const post = postMuralPorId(Number(req.params.id));
  const ok = asignarPostMural(Number(req.params.id), { tipo, id: Number(id), nombre });
  if (!ok) return res.status(400).json({ ok: false, error: "No se pudo asignar (¿ya está finalizada?)" });
  if (tipo === "empleado" && post) {
    enviarPushAEmpleado(Number(id), {
      titulo: "📌 Nueva tarea",
      cuerpo: "Se te asignó una nueva tarea",
      url: "/app/",
    }).catch(() => {});
  }
  res.json({ ok: true });
});

router.post("/api/mural/:id/desasignar", requerirAuth, (req, res) => {
  desasignarPostMural(Number(req.params.id));
  res.json({ ok: true });
});

router.post("/api/mural/:id/finalizar", requerirAuth, (req, res) => {
  const { fotos } = req.body || {};
  finalizarPostMural(Number(req.params.id), Array.isArray(fotos) ? fotos : []);
  res.json({ ok: true });
});

// Comentarios sobre una tarea del Mural -- una vez asignada, admins (y el
// empleado asignado, desde la app) pueden ir dejando observaciones.
router.post("/api/mural/:id/comentarios", requerirAuth, (req, res) => {
  const postId = Number(req.params.id);
  const texto = String((req.body || {}).texto || "").trim().slice(0, 500);
  if (!postId || !texto) return res.status(400).json({ ok: false, error: "Escribí un comentario" });
  const admin = adminPorId(req.adminId);
  const nombreAdmin = admin ? `${admin.nombre || ""} ${admin.apellido || ""}`.trim() || admin.usuario : "Administrador";
  crearComentarioMural({ postId, autorTipo: "admin", autorNombre: nombreAdmin, texto });
  res.json({ ok: true });
});

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
// Las licencias no se incluyen aca -- ya tienen su propia tarjeta "De
// licencia hoy" arriba, mostrarlas tambien aca era redundante (alguien de
// licencia hoy volvia a aparecer en "proximos dias libres").
function proximosDiasLibres() {
  const hoy = new Date();
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

  return francos.sort((a, b) => a.fecha.localeCompare(b.fecha));
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

  // Turno de hoy de cada uno de mantenimiento -- sirve para cualquier dia,
  // laborable o fin de semana (turnoRealDelDia ya sabe que tipo de dia es).
  const turnoHoy = [...GRUPO_A, ...GRUPO_B].map((empleado) => ({
    empleado, turno: turnoRealDelDia(empleado, hoy),
  }));

  // Igual que turnoHoy pero de conserjeria -- sin exceptions/cambios de
  // turno (ese sistema es solo para mantenimiento), asi que turnoDelDia
  // alcanza sin pasar por la base.
  const turnoHoyConserjeria = Object.keys(EQUIPO_CONSERJERIA).map((empleado) => ({
    empleado, turno: turnoConserjeriaDelDia(empleado, hoy),
  }));

  // Tendencia del % de fichaje completo en los ultimos periodos con datos
  // (para el sparkline debajo del medidor). El % de "bot activo" no tiene
  // equivalente historico -- whatsapp_map no guarda cuando se registro cada
  // numero, es solo el estado actual.
  const tendenciaFichaje = periodosRecientes(6).map((p) => {
    const s = saludFichajePeriodo(p);
    return { periodo: p, porcentaje: s.total > 0 ? Math.round((s.completos / s.total) * 100) : null };
  });

  // Alertas proactivas: quien esta con fichaje flojo este periodo, y quien
  // (estando registrado en el bot) no lo usa hace mas de una semana.
  const UMBRAL_FICHAJE = 90;
  const UMBRAL_INACTIVIDAD_DIAS = 7;
  const fichajeBajo = fichadasCompletasPorEmpleado(periodo)
    .map((f) => ({ ...f, porcentaje: f.diasTotal > 0 ? Math.round((f.diasCompletos / f.diasTotal) * 100) : null }))
    .filter((f) => f.porcentaje !== null && f.porcentaje < UMBRAL_FICHAJE)
    .sort((a, b) => a.porcentaje - b.porcentaje);

  const corteInactividad = new Date(hoy);
  corteInactividad.setDate(corteInactividad.getDate() - UMBRAL_INACTIVIDAD_DIAS);
  const actividadPorEmpleado = ultimaActividadPorEmpleado();
  const sinActividad = empleados
    .filter((e) => numeroDeEmpleado(e))
    .map((e) => {
      const act = actividadPorEmpleado.find((a) => a.empleado === e);
      return { empleado: e, ultimaVez: act ? act.actualizadoEn : null };
    })
    .filter((a) => !a.ultimaVez || new Date(a.ultimaVez) < corteInactividad);

  // Comparacion contra el mes calendario anterior (mismo criterio de
  // "periodo" que usa el resto del sistema).
  const [anioActual, mesActual] = periodo.split("-").map(Number);
  const fechaMesAnterior = new Date(anioActual, mesActual - 2, 1);
  const periodoAnterior = `${fechaMesAnterior.getFullYear()}-${String(fechaMesAnterior.getMonth() + 1).padStart(2, "0")}`;
  const totalesAnterior = resumenDelPeriodo(periodoAnterior).reduce(
    (acc, r) => ({ totalHs: acc.totalHs + r.totalHs, h50: acc.h50 + r.h50, h100: acc.h100 + r.h100 }),
    { totalHs: 0, h50: 0, h100: 0 }
  );

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
    turnoHoy,
    turnoHoyConserjeria,
    proximosLibres: proximosDiasLibres(),
    empleados: { total: empleados.length, conWhatsapp },
    horas: {
      total: Math.round(totales.totalHs * 100) / 100,
      h50: Math.round(totales.h50 * 100) / 100,
      h100: Math.round(totales.h100 * 100) / 100,
    },
    fichaje,
    tendenciaFichaje,
    alertas: { fichajeBajo, sinActividad },
    comparacion: {
      periodoAnterior,
      horas: {
        total: Math.round(totalesAnterior.totalHs * 100) / 100,
        h50: Math.round(totalesAnterior.h50 * 100) / 100,
        h100: Math.round(totalesAnterior.h100 * 100) / 100,
      },
    },
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

// Registra o cambia el numero de WhatsApp de un empleado del roster fijo
// (los nombres vienen de motorCalculo.js -- esto no da de alta un empleado
// nuevo que no exista ahi, solo gestiona su acceso al bot).
router.post("/api/empleados/whatsapp", requerirAuth, (req, res) => {
  const { empleado, numero } = req.body || {};
  if (!empleado || !todosLosEmpleados().includes(empleado)) {
    return res.status(400).json({ ok: false, error: "Empleado inválido" });
  }
  if (!/^\+\d{8,15}$/.test(numero || "")) {
    return res.status(400).json({ ok: false, error: "El número tiene que tener el formato +549XXXXXXXXXX" });
  }
  registrarNumero(numero, empleado);
  res.json({ ok: true });
});

router.delete("/api/empleados/whatsapp/:empleado", requerirAuth, (req, res) => {
  const { empleado } = req.params;
  if (!numeroDeEmpleado(empleado)) return res.status(404).json({ ok: false, error: "No tiene número registrado" });
  eliminarNumero(empleado);
  res.json({ ok: true });
});

// ── Cuentas de la app de empleado (usuario + contraseña) -- gestion exclusiva de admin ──

// Contraseña inicial predecible (usuario + "1") en vez de un PIN random: mas
// facil de dictar/anotar para el admin y el empleado. Justo por ser
// predecible, SIEMPRE queda marcada para cambiar en el proximo login
// (actualizarPinEmpleadoApp y crearEmpleadoApp ya fuerzan debe_cambiar_pin=1).
function generarPasswordInicial(usuario) {
  return `${usuario.toLowerCase()}1`;
}

router.get("/api/empleados-app", requerirAuth, (req, res) => {
  res.json({ empleados: listarEmpleadosApp() });
});

// La contraseña generada se devuelve en texto plano SOLO en esta respuesta
// (para que el admin se la pase al empleado) -- nunca se guarda ni se puede
// volver a consultar despues, solo su hash.
router.post("/api/empleados-app", requerirAuth, async (req, res) => {
  const { empleado, usuario } = req.body || {};
  if (!empleado || !todosLosEmpleados().includes(empleado)) {
    return res.status(400).json({ ok: false, error: "Empleado inválido" });
  }
  if (!usuario || !/^[a-z0-9_.]{3,30}$/i.test(usuario)) {
    return res.status(400).json({ ok: false, error: "Usuario inválido (letras, números, punto o guión bajo, 3-30 caracteres)" });
  }
  const pin = generarPasswordInicial(usuario);
  const pinHash = await bcrypt.hash(pin, 10);
  try {
    const id = crearEmpleadoApp({ nombre: empleado, sector: getSectorDeEmpleado(empleado), usuario, pinHash });
    res.json({ ok: true, id, usuario, pin });
  } catch (err) {
    const yaExiste = String(err.message || "").includes("UNIQUE");
    res.status(400).json({ ok: false, error: yaExiste ? "Ese usuario ya existe" : err.message });
  }
});

router.post("/api/empleados-app/:id/reset-pin", requerirAuth, async (req, res) => {
  const empleadoApp = empleadoAppPorId(Number(req.params.id));
  if (!empleadoApp) return res.status(404).json({ ok: false, error: "No encontrado" });
  const pin = generarPasswordInicial(empleadoApp.usuario);
  const pinHash = await bcrypt.hash(pin, 10);
  actualizarPinEmpleadoApp(empleadoApp.id, pinHash);
  res.json({ ok: true, pin });
});

router.delete("/api/empleados-app/:id", requerirAuth, (req, res) => {
  eliminarEmpleadoApp(Number(req.params.id));
  res.json({ ok: true });
});

router.post("/api/empleados-app/:id/rol", requerirAuth, (req, res) => {
  const { rol } = req.body || {};
  actualizarRolEmpleado(Number(req.params.id), rol === "jefe" ? "jefe" : "empleado");
  res.json({ ok: true });
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
  res.json(calcularAsistencia(empleado, periodo));
});

// Calendario de turnos del equipo de mantenimiento, un mes completo -- usa
// turnoRealDelDia (formula + excepciones de cambios ya aprobados), asi
// coincide exactamente con lo que ya se ve en WhatsApp y en el Google Calendar.
router.get("/api/turnos", requerirAuth, (req, res) => {
  const hoy = new Date();
  const mesParam = req.query.mes || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  const [anio, mes] = mesParam.split("-").map(Number);
  if (!anio || !mes || mes < 1 || mes > 12) return res.status(400).json({ ok: false, error: "Mes inválido" });

  const equipo = [...GRUPO_A, ...GRUPO_B];
  const cantidadDias = new Date(anio, mes, 0).getDate();
  const dias = [];
  for (let d = 1; d <= cantidadDias; d++) {
    const fecha = new Date(anio, mes - 1, d);
    const iso = fechaISO(fecha);
    const turnos = {};
    for (const empleado of equipo) turnos[empleado] = turnoRealDelDia(empleado, fecha);
    dias.push({ fecha: iso, diaSemana: fecha.getDay(), esFeriado: FERIADOS.has(iso), turnos });
  }
  res.json({ mes: mesParam, equipo, dias });
});

// Igual que /api/turnos pero de conserjeria -- sin excepciones de cambio de
// turno (ese sistema es solo para mantenimiento), directo de la formula fija.
router.get("/api/turnos-conserjeria", requerirAuth, (req, res) => {
  const hoy = new Date();
  const mesParam = req.query.mes || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  const [anio, mes] = mesParam.split("-").map(Number);
  if (!anio || !mes || mes < 1 || mes > 12) return res.status(400).json({ ok: false, error: "Mes inválido" });

  const equipo = Object.keys(EQUIPO_CONSERJERIA);
  const cantidadDias = new Date(anio, mes, 0).getDate();
  const dias = [];
  for (let d = 1; d <= cantidadDias; d++) {
    const fecha = new Date(anio, mes - 1, d);
    const iso = fechaISO(fecha);
    const turnos = {};
    for (const empleado of equipo) turnos[empleado] = turnoConserjeriaDelDia(empleado, fecha);
    dias.push({ fecha: iso, diaSemana: fecha.getDay(), esFeriado: FERIADOS.has(iso), turnos });
  }
  res.json({ mes: mesParam, equipo, dias });
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
  // Se suma el sector aca (resumen_mensual no lo tiene) para que el front
  // pueda separar la tabla en mantenimiento/conserjeria sin tener que pedir
  // /api/empleados aparte solo para cruzarlo.
  const resumen = resumenDelPeriodo(periodo).map((r) => ({ ...r, sector: getSectorDeEmpleado(r.empleado) }));
  res.json({ periodo, rango: rangoFechasDelPeriodo(periodo), resumen });
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
