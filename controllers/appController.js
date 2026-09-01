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
  filaDelDiaPorFecha,
  crearPostMural, listarPostsMuralParaEmpleado, reclamarPostMural, finalizarPostMural, postMuralPorId,
  crearComentarioMural,
  listarNotificacionesApp, contarNotificacionesNoLeidasApp, marcarNotificacionesLeidasApp,
  actualizarPerfilEmpleadoApp,
  TIPOS_LICENCIA, crearSolicitudLicencia, solicitudesLicenciaDeEmpleado,
  PUNTOS_RECORRIDO, recorridoDeHoy, recorridoDeHoyEnCurso, crearRecorrido, recorridoPorId,
  agregarPuntoRecorrido, finalizarRecorrido,
} = require("../services/db");
const { turnoRealDelDia, GRUPO_A, GRUPO_B } = require("../services/turnosMantenimiento");
const { turnoDelDia: turnoConserjeriaDelDia } = require("../services/turnosConserjeria");
const { calcularAsistencia } = require("../services/asistencia");
const { enviarPushATodoElPanel } = require("../services/pushNotifications");

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

// Perfil del empleado (usuario/foto) -- el nombre NO se puede cambiar
// aca, es la clave que lo une con su propio historial de fichadas y
// turnos (ver nota en services/db.js).
router.get("/api/perfil", requerirAuthEmpleado, (req, res) => {
  const { pin_hash, ...perfil } = req.empleadoApp;
  res.json({ ok: true, perfil });
});

router.post("/api/perfil", requerirAuthEmpleado, (req, res) => {
  const { usuario, foto } = req.body || {};
  if (foto && !String(foto).startsWith("data:image/")) {
    return res.status(400).json({ ok: false, error: "La foto tiene que ser una imagen" });
  }
  if (!usuario || !String(usuario).trim()) {
    return res.status(400).json({ ok: false, error: "El usuario no puede estar vacío" });
  }
  try {
    actualizarPerfilEmpleadoApp(req.empleadoApp.id, {
      usuario: String(usuario).trim().slice(0, 60),
      foto: foto || null,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: "Ese usuario ya está en uso" });
  }
  const actualizado = empleadoAppPorId(req.empleadoApp.id);
  const { pin_hash, ...perfil } = actualizado;
  res.json({ ok: true, perfil });
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
  enviarPushATodoElPanel({
    titulo: "Nueva solicitud de corrección",
    cuerpo: `${nombre} pidió corregir el ${fecha}`,
    url: "/panel/",
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
  enviarPushATodoElPanel({
    titulo: "Nueva solicitud de cambio de turno",
    cuerpo: `${nombre} pidió cambiar el ${fechaA} por el ${fechaB} de ${empleadoB}`,
    url: "/panel/",
  });
  res.json({ ok: true, id });
});

// Pide licencia/vacaciones -- a diferencia de la carga del panel (que ya
// queda aplicada), esto queda "pendiente" hasta que el admin la aprueba
// (mismo circuito que solicitar-correccion). Al aprobarse, el panel llama a
// crearLicencia con estos mismos datos.
router.post("/api/solicitar-licencia", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  const { fechaDesde, fechaHasta, tipo, mensaje } = req.body || {};
  if (!fechaDesde || !RE_FECHA.test(fechaDesde) || !fechaHasta || !RE_FECHA.test(fechaHasta)) {
    return res.status(400).json({ ok: false, error: "Elegí las dos fechas" });
  }
  if (fechaHasta < fechaDesde) {
    return res.status(400).json({ ok: false, error: "La fecha hasta no puede ser anterior a la fecha desde" });
  }
  const dias = Math.round((new Date(fechaHasta + "T00:00:00") - new Date(fechaDesde + "T00:00:00")) / 86400000) + 1;
  if (dias > 90) {
    return res.status(400).json({ ok: false, error: "El rango no puede superar los 90 días" });
  }
  if (!tipo || !TIPOS_LICENCIA.includes(tipo)) {
    return res.status(400).json({ ok: false, error: "Elegí un tipo válido" });
  }
  const id = crearSolicitudLicencia({
    empleado: nombre,
    numeroWhatsapp: numeroDeEmpleado(nombre) || "",
    fechaDesde, fechaHasta, tipo,
    mensaje: mensaje ? String(mensaje).trim().slice(0, 300) : "",
  });
  enviarPushATodoElPanel({
    titulo: "Nuevo pedido de licencia",
    cuerpo: `${nombre} pidió licencia del ${fechaDesde} al ${fechaHasta}`,
    url: "/panel/",
  });
  res.json({ ok: true, id });
});

// Historial de pedidos propios (correcciones + cambios de turno + licencia),
// con su estado -- para que el empleado pueda ver si ya se lo resolvieron
// sin tener que preguntarle al admin.
router.get("/api/mis-solicitudes", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  // "antes": como estaba ese dia antes de esta correccion, para que el
  // empleado vea el cambio completo (no solo lo que propuso). Si ya se
  // aprobo, el dato real quedo pisado en filas_diarias -- ahi se usa el
  // snapshot que se guardo en el momento de aplicarla. Si todavia esta
  // pendiente o fue rechazada, filas_diarias sigue siendo el "antes" (no se
  // aplico nada), asi que se consulta tal cual esta hoy.
  const correcciones = solicitudesDeEmpleado(nombre, 20).map((s) => {
    let antes = null;
    if (s.estado === "aprobada") {
      if (s.snapshot_existia !== 0) antes = { ingreso: s.snapshot_ingreso, egreso: s.snapshot_egreso };
    } else {
      const filaActual = filaDelDiaPorFecha(nombre, s.fecha);
      if (filaActual) antes = { ingreso: filaActual.ingreso, egreso: filaActual.egreso };
    }
    return { ...s, antes };
  });
  res.json({
    ok: true,
    correcciones,
    cambios: solicitudesCambioDeEmpleado(nombre, 20),
    licencias: solicitudesLicenciaDeEmpleado(nombre, 20),
  });
});

// ── Recorrido diario (mantenimiento, con QR por punto) -- el checklist y
// las observaciones ya son reales (quedan guardadas en cuanto se confirma
// cada punto); lo unico simulado por ahora es la lectura del QR en si. ──
router.get("/api/recorrido/puntos", requerirAuthEmpleado, (req, res) => {
  res.json({ ok: true, puntos: PUNTOS_RECORRIDO });
});

// Recorrido de hoy (si lo hay) -- para que la tarjeta de Inicio sepa si
// mostrar "sin empezar", "en curso" o "completado, terminó en X".
router.get("/api/recorrido/hoy", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  res.json({ ok: true, recorrido: recorridoDeHoy(nombre) || null });
});

// Si ya habia uno de hoy sin terminar lo retoma (mismo empleado no puede
// pisar el de otro: se valida el dueño en cada endpoint de abajo tambien).
router.post("/api/recorrido/iniciar", requerirAuthEmpleado, (req, res) => {
  const { nombre } = req.empleadoApp;
  const enCurso = recorridoDeHoyEnCurso(nombre);
  if (enCurso) return res.json({ ok: true, id: enCurso.id, puntosHechos: JSON.parse(enCurso.puntos_json || "[]").length });
  const id = crearRecorrido(nombre);
  res.json({ ok: true, id, puntosHechos: 0 });
});

function recorridoPropio(req, res) {
  const recorrido = recorridoPorId(Number(req.params.id));
  if (!recorrido || recorrido.empleado !== req.empleadoApp.nombre) {
    res.status(404).json({ ok: false, error: "No encontrado" });
    return null;
  }
  if (recorrido.finalizado_en) {
    res.status(409).json({ ok: false, error: "Ese recorrido ya está cerrado" });
    return null;
  }
  return recorrido;
}

router.post("/api/recorrido/:id/punto", requerirAuthEmpleado, (req, res) => {
  const recorrido = recorridoPropio(req, res);
  if (!recorrido) return;
  const { nombre, checklist, observaciones, fotos } = req.body || {};
  if (!nombre) return res.status(400).json({ ok: false, error: "Falta el nombre del punto" });
  const total = agregarPuntoRecorrido(recorrido.id, { nombre, checklist, observaciones, fotos });
  res.json({ ok: true, puntosHechos: total });
});

router.post("/api/recorrido/:id/finalizar", requerirAuthEmpleado, (req, res) => {
  const recorrido = recorridoPropio(req, res);
  if (!recorrido) return;
  const { duracionSeg } = req.body || {};
  finalizarRecorrido(recorrido.id, Number(duracionSeg) || 0);
  enviarPushATodoElPanel({
    titulo: "Recorrido diario completado",
    cuerpo: `${req.empleadoApp.nombre} terminó el recorrido de hoy`,
    url: "/panel/",
  });
  res.json({ ok: true });
});

// ── Mural de tareas -- ve solo lo que le corresponde segun su sector, si
// es jefe/coordinador, o si fue elegido individualmente (ver
// listarPostsMuralParaEmpleado en services/db.js). ──
router.get("/api/mural", requerirAuthEmpleado, (req, res) => {
  const { id, sector, rol } = req.empleadoApp;
  res.json({ ok: true, posts: listarPostsMuralParaEmpleado(id, sector, rol || "empleado") });
});

router.post("/api/mural/:id/reclamar", requerirAuthEmpleado, (req, res) => {
  const post = postMuralPorId(Number(req.params.id));
  if (!post) return res.status(404).json({ ok: false, error: "No encontrada" });
  const { id, sector, rol, nombre } = req.empleadoApp;
  const visibles = listarPostsMuralParaEmpleado(id, sector, rol || "empleado").map((p) => p.id);
  if (!visibles.includes(post.id)) return res.status(403).json({ ok: false, error: "Esta tarea no es para vos" });
  const ok = reclamarPostMural(post.id, { tipo: "empleado", id, nombre });
  if (!ok) return res.status(409).json({ ok: false, error: "Ya fue reclamada por otra persona" });
  res.json({ ok: true });
});

router.post("/api/mural/:id/finalizar", requerirAuthEmpleado, (req, res) => {
  const post = postMuralPorId(Number(req.params.id));
  if (!post) return res.status(404).json({ ok: false, error: "No encontrada" });
  if (post.reclamado_por_tipo !== "empleado" || post.reclamado_por_id !== req.empleadoApp.id) {
    return res.status(403).json({ ok: false, error: "Esta tarea no la reclamaste vos" });
  }
  if (post.estado !== "en_proceso") {
    return res.status(409).json({ ok: false, error: "Esta tarea no está en proceso" });
  }
  const { fotos } = req.body || {};
  finalizarPostMural(post.id, Array.isArray(fotos) ? fotos : []);
  res.json({ ok: true });
});

// Comentar una tarea del Mural -- solo si el empleado la puede ver (mismo
// chequeo de visibilidad que el resto de los endpoints del Mural).
router.post("/api/mural/:id/comentarios", requerirAuthEmpleado, (req, res) => {
  const postId = Number(req.params.id);
  const texto = String((req.body || {}).texto || "").trim().slice(0, 500);
  if (!postId || !texto) return res.status(400).json({ ok: false, error: "Escribí un comentario" });
  const { id, sector, rol, nombre } = req.empleadoApp;
  const visibles = listarPostsMuralParaEmpleado(id, sector, rol || "empleado").map((p) => p.id);
  if (!visibles.includes(postId)) return res.status(403).json({ ok: false, error: "Esta tarea no es para vos" });
  crearComentarioMural({ postId, autorTipo: "empleado", autorNombre: nombre, texto });
  res.json({ ok: true });
});

// ── Historial de notificaciones (campanita del header) ──
router.get("/api/notificaciones", requerirAuthEmpleado, (req, res) => {
  const { id } = req.empleadoApp;
  res.json({ ok: true, notificaciones: listarNotificacionesApp(id), noLeidas: contarNotificacionesNoLeidasApp(id) });
});

router.post("/api/notificaciones/leidas", requerirAuthEmpleado, (req, res) => {
  marcarNotificacionesLeidasApp(req.empleadoApp.id);
  res.json({ ok: true });
});

router.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "app", "index.html"));
});

module.exports = router;
