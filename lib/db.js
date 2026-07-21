const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "data", "fichero.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS resumen_mensual (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    periodo TEXT NOT NULL,        -- ej "2026-07"
    dias INTEGER NOT NULL,
    total_hs REAL NOT NULL,
    h50 REAL NOT NULL,
    h100 REAL NOT NULL,
    generado_en TEXT NOT NULL,
    UNIQUE(empleado, periodo)
  );

  CREATE TABLE IF NOT EXISTS whatsapp_map (
    numero TEXT PRIMARY KEY,      -- ej "+5491122334455"
    empleado TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS filas_diarias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    periodo TEXT NOT NULL,
    fecha TEXT NOT NULL,          -- "YYYY-MM-DD"
    turno TEXT,
    ingreso TEXT,
    egreso TEXT,
    total_hs REAL NOT NULL,
    h50 REAL NOT NULL,
    h100 REAL NOT NULL,
    alerta TEXT DEFAULT '',
    UNIQUE(empleado, periodo, fecha)
  );

  CREATE TABLE IF NOT EXISTS solicitudes_correccion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    numero_whatsapp TEXT NOT NULL,
    periodo TEXT NOT NULL,
    fecha TEXT NOT NULL,           -- dia a corregir, "YYYY-MM-DD"
    ingreso_propuesto TEXT,        -- "HH:MM" o NULL si no se pide cambiar la entrada
    egreso_propuesto TEXT,         -- "HH:MM" o NULL si no se pide cambiar la salida
    mensaje_original TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | aprobada | rechazada
    creado_en TEXT NOT NULL,
    resuelto_en TEXT
  );

  CREATE TABLE IF NOT EXISTS conversaciones_whatsapp (
    numero TEXT PRIMARY KEY,
    estado TEXT NOT NULL,      -- en que paso del menu esta ese numero
    datos TEXT NOT NULL DEFAULT '{}', -- JSON con lo que ya contesto (fecha, campo, etc)
    actualizado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS solicitudes_cambio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado_a TEXT NOT NULL,       -- quien pide el cambio
    numero_whatsapp_a TEXT NOT NULL,
    empleado_b TEXT NOT NULL,       -- compañero de equipo
    fecha_a TEXT NOT NULL,          -- turno de A que se cede, "YYYY-MM-DD"
    fecha_b TEXT NOT NULL,          -- turno de B que A toma a cambio
    estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | aprobada | rechazada
    creado_en TEXT NOT NULL,
    resuelto_en TEXT
  );

  -- Anula puntualmente lo que diria la formula de rotacion de mantenimiento
  -- (turnosMantenimiento.turnoDelDia) para un empleado en una fecha concreta.
  -- Se usa para reflejar cambios de turno ya aprobados, sin tocar la formula
  -- de base (que sigue calculando el resto del calendario como si nada).
  CREATE TABLE IF NOT EXISTS excepciones_turno (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    fecha TEXT NOT NULL,
    tipo TEXT NOT NULL,
    horario_in TEXT,
    horario_out TEXT,
    creado_en TEXT NOT NULL,
    UNIQUE(empleado, fecha)
  );

  -- Dias de evento puntual por empleado (antes vivian hardcodeados en
  -- motorCalculo.js). Las horas que superan el contrato normal ese dia van
  -- a extra 100% en vez de 50%, igual criterio que un domingo.
  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    fecha TEXT NOT NULL,
    creado_en TEXT NOT NULL,
    UNIQUE(empleado, fecha)
  );

  -- Log de interacciones del bot, para estadisticas (panel web). Arranca a
  -- contar desde que se agrego esto -- no hay forma de reconstruir historial
  -- de antes, porque antes solo se guardaba el paso actual de la conversacion.
  CREATE TABLE IF NOT EXISTS mensajes_whatsapp (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    empleado TEXT,
    tipo TEXT NOT NULL,   -- consulta_horas | correccion | fichada_hoy | mis_solicitudes | cambio_turno | otro
    fecha TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fichadas_estado (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    fecha TEXT NOT NULL,                -- "YYYY-MM-DD"
    ingreso_hora TEXT,                  -- "HH:MM"
    ingreso_detectado_en TEXT,          -- timestamp ISO del evento real (no de cuando lo vimos)
    ingreso_notificado INTEGER NOT NULL DEFAULT 0,
    egreso_hora TEXT,
    egreso_detectado_en TEXT,
    egreso_notificado INTEGER NOT NULL DEFAULT 0,
    ultimo_recordatorio_en TEXT,
    UNIQUE(empleado, fecha)
  );

  -- Licencias/vacaciones cargadas desde el panel de admin. Cada fila es un
  -- rango [fecha_desde, fecha_hasta] para un empleado. Al registrarla se
  -- materializan filas "placeholder" en filas_diarias (ver
  -- materializarDiasLicencia) para los dias que todavia no tenian datos, asi
  -- se ven marcados en "mis horas" (WhatsApp) y en el Excel sin esperar a
  -- que corra el pipeline mensual.
  CREATE TABLE IF NOT EXISTS licencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    fecha_desde TEXT NOT NULL,
    fecha_hasta TEXT NOT NULL,
    tipo TEXT NOT NULL,
    cargado_por TEXT,
    creado_en TEXT NOT NULL
  );
`);

// Migracion idempotente: agrega la columna solo si todavia no existe (la
// tabla filas_diarias ya tenia datos en produccion antes de esta feature).
// NULL = dia normal; con valor = dia dentro de una licencia registrada, y
// las horas de ese dia no cuentan como "dia trabajado" en el resumen.
const columnasFilasDiarias = db.prepare("PRAGMA table_info(filas_diarias)").all();
if (!columnasFilasDiarias.some((c) => c.name === "licencia_tipo")) {
  db.exec("ALTER TABLE filas_diarias ADD COLUMN licencia_tipo TEXT");
}

function guardarResumenMensual(periodo, resumen) {
  const stmt = db.prepare(`
    INSERT INTO resumen_mensual (empleado, periodo, dias, total_hs, h50, h100, generado_en)
    VALUES (@empleado, @periodo, @dias, @totalHs, @h50, @h100, @generadoEn)
    ON CONFLICT(empleado, periodo) DO UPDATE SET
      dias=excluded.dias, total_hs=excluded.total_hs, h50=excluded.h50,
      h100=excluded.h100, generado_en=excluded.generado_en
  `);
  const ahora = new Date().toISOString();
  const insertar = db.transaction((filas) => {
    for (const r of filas) {
      stmt.run({ ...r, periodo, generadoEn: ahora });
    }
  });
  insertar(resumen);
}

function resumenDelPeriodo(periodo) {
  return db.prepare(`
    SELECT empleado, dias, total_hs as totalHs, h50, h100
    FROM resumen_mensual WHERE periodo = ?
  `).all(periodo);
}

function empleadoPorNumero(numero) {
  const row = db.prepare("SELECT empleado FROM whatsapp_map WHERE numero = ?").get(numero);
  return row ? row.empleado : null;
}

function numeroDeEmpleado(empleado) {
  const row = db.prepare("SELECT numero FROM whatsapp_map WHERE empleado = ?").get(empleado);
  return row ? row.numero : null;
}

function registrarNumero(numero, empleado) {
  db.prepare(`
    INSERT INTO whatsapp_map (numero, empleado) VALUES (?, ?)
    ON CONFLICT(numero) DO UPDATE SET empleado = excluded.empleado
  `).run(numero, empleado);
}

// Suma acumulada del empleado en un rango de periodos "2026-01".."2026-07"
function horasAcumuladas(empleado, periodoDesde, periodoHasta) {
  return db.prepare(`
    SELECT SUM(dias) as dias, SUM(total_hs) as totalHs, SUM(h50) as h50, SUM(h100) as h100
    FROM resumen_mensual
    WHERE empleado = ? AND periodo BETWEEN ? AND ?
  `).get(empleado, periodoDesde, periodoHasta);
}

function ultimoResumen(empleado) {
  return db.prepare(`
    SELECT * FROM resumen_mensual WHERE empleado = ? ORDER BY periodo DESC LIMIT 1
  `).get(empleado);
}

// ── Filas diarias (dia-por-dia, necesario para poder corregir un dia puntual) ──

function guardarFilasDiarias(periodo, filas) {
  // Este camino siempre representa datos reales de fichaje (pipeline o una
  // correccion aprobada) -- si el dia estaba marcado como licencia
  // (placeholder de materializarDiasLicencia) y ahora llega un dato real,
  // se limpia licencia_tipo: ya no es un dia "sin trabajar", paso a ser un
  // dia trabajado normal.
  const stmt = db.prepare(`
    INSERT INTO filas_diarias (empleado, periodo, fecha, turno, ingreso, egreso, total_hs, h50, h100, alerta)
    VALUES (@empleado, @periodo, @fecha, @turno, @ingreso, @egreso, @totalHs, @h50, @h100, @alerta)
    ON CONFLICT(empleado, periodo, fecha) DO UPDATE SET
      turno=excluded.turno, ingreso=excluded.ingreso, egreso=excluded.egreso,
      total_hs=excluded.total_hs, h50=excluded.h50, h100=excluded.h100, alerta=excluded.alerta,
      licencia_tipo=NULL
  `);
  const insertar = db.transaction((lista) => {
    for (const f of lista) {
      stmt.run({ ...f, periodo, alerta: f.alerta || "" });
    }
  });
  insertar(filas);
}

function filaDelDia(empleado, periodo, fecha) {
  return db.prepare(`
    SELECT * FROM filas_diarias WHERE empleado = ? AND periodo = ? AND fecha = ?
  `).get(empleado, periodo, fecha);
}

function filasDelPeriodo(periodo) {
  return db.prepare(`
    SELECT * FROM filas_diarias WHERE periodo = ? ORDER BY empleado, fecha
  `).all(periodo);
}

function filasDelPeriodoDeEmpleado(empleado, periodo) {
  return db.prepare(`
    SELECT * FROM filas_diarias WHERE empleado = ? AND periodo = ? ORDER BY fecha
  `).all(empleado, periodo);
}

// Busca la fila de un dia por su fecha real, sin depender del periodo que
// se le haya asignado. Existe porque una importacion manual puede haber
// etiquetado un rango de fechas bajo un periodo que no coincide con el mes
// calendario de esas fechas (ej: dias de fines de junio guardados bajo
// periodo "2026-07") — si no se busca asi, una solicitud de correccion para
// esa fecha calcularia el periodo por "fecha.slice(0,7)" y no encontraria
// la fila real, generando una fila duplicada en el periodo equivocado.
function filaDelDiaPorFecha(empleado, fecha) {
  return db.prepare(`
    SELECT * FROM filas_diarias WHERE empleado = ? AND fecha = ? LIMIT 1
  `).get(empleado, fecha);
}

// Upsert de una sola fila (crea si no existia el dia, actualiza si ya existia)
function actualizarFilaDiaria(empleado, periodo, fecha, cambios) {
  const existente = filaDelDia(empleado, periodo, fecha);
  const base = existente || {
    turno: null, ingreso: null, egreso: null, totalHs: 0, h50: 0, h100: 0, alerta: "",
  };
  const fila = {
    empleado,
    fecha,
    turno: cambios.turno ?? base.turno,
    ingreso: cambios.ingreso ?? base.ingreso,
    egreso: cambios.egreso ?? base.egreso,
    totalHs: cambios.totalHs ?? base.total_hs ?? base.totalHs ?? 0,
    h50: cambios.h50 ?? base.h50 ?? 0,
    h100: cambios.h100 ?? base.h100 ?? 0,
    alerta: cambios.alerta ?? base.alerta ?? "",
  };
  guardarFilasDiarias(periodo, [fila]);
  return fila;
}

// Recalcula el agregado mensual de UN empleado a partir de filas_diarias
// (no toca el resumen de los demas empleados)
function recalcularResumenEmpleado(empleado, periodo) {
  // Los dias de licencia (licencia_tipo IS NOT NULL) no cuentan como "dia
  // trabajado" -- quedan fuera del conteo de dias y horas del resumen
  // mensual, aunque sigan visibles en el detalle dia a dia.
  const agregados = db.prepare(`
    SELECT COUNT(*) as dias,
           COALESCE(SUM(total_hs), 0) as totalHs,
           COALESCE(SUM(h50), 0) as h50,
           COALESCE(SUM(h100), 0) as h100
    FROM filas_diarias WHERE empleado = ? AND periodo = ? AND licencia_tipo IS NULL
  `).get(empleado, periodo);
  guardarResumenMensual(periodo, [{
    empleado,
    dias: agregados.dias,
    totalHs: Math.round(agregados.totalHs * 100) / 100,
    h50: Math.round(agregados.h50 * 100) / 100,
    h100: Math.round(agregados.h100 * 100) / 100,
  }]);
}

// ── Solicitudes de correccion (pedido del empleado -> aprobacion del admin) ──

function crearSolicitud({ empleado, numeroWhatsapp, periodo, fecha, ingresoPropuesto, egresoPropuesto, mensajeOriginal }) {
  const info = db.prepare(`
    INSERT INTO solicitudes_correccion
      (empleado, numero_whatsapp, periodo, fecha, ingreso_propuesto, egreso_propuesto, mensaje_original, estado, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)
  `).run(empleado, numeroWhatsapp, periodo, fecha, ingresoPropuesto || null, egresoPropuesto || null, mensajeOriginal || "", new Date().toISOString());
  return info.lastInsertRowid;
}

function obtenerSolicitud(id) {
  return db.prepare("SELECT * FROM solicitudes_correccion WHERE id = ?").get(id);
}

function resolverSolicitud(id, estado) {
  db.prepare(`
    UPDATE solicitudes_correccion SET estado = ?, resuelto_en = ? WHERE id = ?
  `).run(estado, new Date().toISOString(), id);
}

function solicitudesPendientes() {
  return db.prepare(`
    SELECT * FROM solicitudes_correccion WHERE estado = 'pendiente' ORDER BY id ASC
  `).all();
}

function solicitudesDeEmpleado(empleado, limite = 10) {
  return db.prepare(`
    SELECT * FROM solicitudes_correccion WHERE empleado = ? ORDER BY id DESC LIMIT ?
  `).all(empleado, limite);
}

// ── Cambios de turno entre compañeros de mantenimiento ──

function crearSolicitudCambio({ empleadoA, numeroWhatsappA, empleadoB, fechaA, fechaB }) {
  const info = db.prepare(`
    INSERT INTO solicitudes_cambio (empleado_a, numero_whatsapp_a, empleado_b, fecha_a, fecha_b, estado, creado_en)
    VALUES (?, ?, ?, ?, ?, 'pendiente', ?)
  `).run(empleadoA, numeroWhatsappA, empleadoB, fechaA, fechaB, new Date().toISOString());
  return info.lastInsertRowid;
}

function obtenerSolicitudCambio(id) {
  return db.prepare("SELECT * FROM solicitudes_cambio WHERE id = ?").get(id);
}

function resolverSolicitudCambio(id, estado) {
  db.prepare(`UPDATE solicitudes_cambio SET estado = ?, resuelto_en = ? WHERE id = ?`)
    .run(estado, new Date().toISOString(), id);
}

function solicitudesCambioPendientes() {
  return db.prepare(`SELECT * FROM solicitudes_cambio WHERE estado = 'pendiente' ORDER BY id ASC`).all();
}

function guardarExcepcionTurno(empleado, fecha, turno) {
  db.prepare(`
    INSERT INTO excepciones_turno (empleado, fecha, tipo, horario_in, horario_out, creado_en)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(empleado, fecha) DO UPDATE SET
      tipo=excluded.tipo, horario_in=excluded.horario_in, horario_out=excluded.horario_out, creado_en=excluded.creado_en
  `).run(empleado, fecha, turno.tipo, turno.horario ? turno.horario.in : null, turno.horario ? turno.horario.out : null, new Date().toISOString());
}

function obtenerExcepcionTurno(empleado, fecha) {
  const row = db.prepare("SELECT * FROM excepciones_turno WHERE empleado = ? AND fecha = ?").get(empleado, fecha);
  if (!row) return null;
  return { tipo: row.tipo, horario: row.horario_in ? { in: row.horario_in, out: row.horario_out } : null };
}

// ── Dias de evento (carga manual, mientras no haya conexion con Simple Solutions) ──

function agregarEvento(empleado, fecha) {
  db.prepare(`
    INSERT INTO eventos (empleado, fecha, creado_en) VALUES (?, ?, ?)
    ON CONFLICT(empleado, fecha) DO NOTHING
  `).run(empleado, fecha, new Date().toISOString());
}

function esEventoRegistrado(empleado, fecha) {
  return !!db.prepare("SELECT 1 FROM eventos WHERE empleado = ? AND fecha = ?").get(empleado, fecha);
}

// ── Estadisticas para el panel web ──

function registrarMensaje(numero, empleado, tipo) {
  db.prepare(`INSERT INTO mensajes_whatsapp (numero, empleado, tipo, fecha) VALUES (?, ?, ?, ?)`)
    .run(numero, empleado, tipo, new Date().toISOString());
}

function estadisticasInteracciones() {
  return db.prepare(`
    SELECT empleado, tipo, COUNT(*) as cantidad
    FROM mensajes_whatsapp
    WHERE empleado IS NOT NULL
    GROUP BY empleado, tipo
  `).all();
}

function primerMensajeRegistrado() {
  const row = db.prepare(`SELECT MIN(fecha) as fecha FROM mensajes_whatsapp`).get();
  return row ? row.fecha : null;
}

function correccionesPorEmpleado() {
  return db.prepare(`
    SELECT empleado, COUNT(*) as cantidad
    FROM solicitudes_correccion
    GROUP BY empleado
    ORDER BY cantidad DESC
  `).all();
}

function ultimaActividadPorEmpleado() {
  return db.prepare(`
    SELECT wm.empleado as empleado, cw.numero as numero, cw.actualizado_en as actualizadoEn
    FROM conversaciones_whatsapp cw
    LEFT JOIN whatsapp_map wm ON wm.numero = cw.numero
  `).all();
}

function fichadasCompletasPorEmpleado(periodo) {
  return db.prepare(`
    SELECT empleado,
      COUNT(*) as diasTotal,
      SUM(CASE WHEN ingreso IS NOT NULL AND egreso IS NOT NULL THEN 1 ELSE 0 END) as diasCompletos
    FROM filas_diarias
    WHERE periodo = ? AND licencia_tipo IS NULL
    GROUP BY empleado
  `).all(periodo);
}

// ── Estado de conversacion del bot de WhatsApp (menu paso a paso) ──

function obtenerConversacion(numero) {
  const row = db.prepare("SELECT * FROM conversaciones_whatsapp WHERE numero = ?").get(numero);
  if (!row) return null;
  return { estado: row.estado, datos: JSON.parse(row.datos) };
}

function guardarConversacion(numero, estado, datos = {}) {
  db.prepare(`
    INSERT INTO conversaciones_whatsapp (numero, estado, datos, actualizado_en)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(numero) DO UPDATE SET estado=excluded.estado, datos=excluded.datos, actualizado_en=excluded.actualizado_en
  `).run(numero, estado, JSON.stringify(datos), new Date().toISOString());
}

function limpiarConversacion(numero) {
  db.prepare("DELETE FROM conversaciones_whatsapp WHERE numero = ?").run(numero);
}

// ── Fichadas en tiempo real (detectadas por el poller de HikCentral) ──
// Tabla independiente de filas_diarias: esta se alimenta en vivo durante el
// dia (para poder avisar "fichada exitosa" y detectar salidas olvidadas),
// mientras que filas_diarias solo se actualiza una vez por corrida del
// pipeline mensual o por una correccion aprobada.

function obtenerFichadaHoy(empleado, fecha) {
  return db.prepare("SELECT * FROM fichadas_estado WHERE empleado = ? AND fecha = ?").get(empleado, fecha);
}

// Solo escribe si todavia no habia ingreso registrado ese dia (el primer
// swipe del dia "gana" — swipes posteriores se tratan como egreso).
function marcarIngresoDetectado(empleado, fecha, horaDisplay, detectadoEnISO) {
  const existente = obtenerFichadaHoy(empleado, fecha);
  if (existente) {
    if (existente.ingreso_hora) return;
    db.prepare("UPDATE fichadas_estado SET ingreso_hora = ?, ingreso_detectado_en = ? WHERE id = ?")
      .run(horaDisplay, detectadoEnISO, existente.id);
  } else {
    db.prepare(`
      INSERT INTO fichadas_estado (empleado, fecha, ingreso_hora, ingreso_detectado_en)
      VALUES (?, ?, ?, ?)
    `).run(empleado, fecha, horaDisplay, detectadoEnISO);
  }
}

// Solo escribe si ya habia un ingreso y todavia no habia egreso (el segundo
// swipe del dia "gana" — swipes de mas se ignoran para este seguimiento en
// vivo; el pipeline mensual los sigue marcando "REVISAR MANUALMENTE" como ya
// hacia antes).
function marcarEgresoDetectado(empleado, fecha, horaDisplay, detectadoEnISO) {
  const existente = obtenerFichadaHoy(empleado, fecha);
  if (!existente || existente.egreso_hora) return;
  db.prepare("UPDATE fichadas_estado SET egreso_hora = ?, egreso_detectado_en = ? WHERE id = ?")
    .run(horaDisplay, detectadoEnISO, existente.id);
}

function marcarIngresoNotificado(id) {
  db.prepare("UPDATE fichadas_estado SET ingreso_notificado = 1 WHERE id = ?").run(id);
}

function marcarEgresoNotificado(id) {
  db.prepare("UPDATE fichadas_estado SET egreso_notificado = 1 WHERE id = ?").run(id);
}

function registrarRecordatorio(id, whenISO) {
  db.prepare("UPDATE fichadas_estado SET ultimo_recordatorio_en = ? WHERE id = ?").run(whenISO, id);
}

// Fichadas con un ingreso/egreso detectado pero todavia sin avisarle al empleado.
function fichadasPendientesDeNotificar() {
  return db.prepare(`
    SELECT * FROM fichadas_estado
    WHERE (ingreso_hora IS NOT NULL AND ingreso_notificado = 0)
       OR (egreso_hora IS NOT NULL AND egreso_notificado = 0)
  `).all();
}

// Empleados que fichraron entrada hoy pero todavia no salida (para el job de recordatorios).
function fichadasSinEgresoDeHoy(fecha) {
  return db.prepare(`
    SELECT * FROM fichadas_estado
    WHERE fecha = ? AND ingreso_hora IS NOT NULL AND egreso_hora IS NULL
  `).all(fecha);
}

// ── Licencias / vacaciones (cargadas desde el panel de admin) ──

function fechaISOMasDias(fechaISO, dias) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  const dt = new Date(y, m - 1, d + dias);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// Crea una fila "placeholder" (sin ingreso/egreso, 0 horas) para cada dia
// del rango que todavia no tenga una fila real -- si ya habia datos ese dia
// (alguien fichó antes de que se cargara la licencia), se deja intacto y se
// informa en "omitidos" para que el admin lo revise a mano.
function materializarDiasLicencia(empleado, fechaDesde, fechaHasta, tipo) {
  const omitidos = [];
  const periodos = new Set();
  const dias = Math.round((new Date(fechaHasta + "T00:00:00") - new Date(fechaDesde + "T00:00:00")) / 86400000) + 1;

  const insertar = db.prepare(`
    INSERT INTO filas_diarias (empleado, periodo, fecha, turno, ingreso, egreso, total_hs, h50, h100, alerta, licencia_tipo)
    VALUES (?, ?, ?, 'Licencia', NULL, NULL, 0, 0, 0, '', ?)
  `);

  for (let i = 0; i < dias; i++) {
    const fecha = fechaISOMasDias(fechaDesde, i);
    const periodo = fecha.slice(0, 7);
    if (filaDelDiaPorFecha(empleado, fecha)) { omitidos.push(fecha); continue; }
    insertar.run(empleado, periodo, fecha, tipo);
    periodos.add(periodo);
  }
  return { omitidos, periodos: [...periodos] };
}

function crearLicencia({ empleado, fechaDesde, fechaHasta, tipo, cargadoPor }) {
  const info = db.prepare(`
    INSERT INTO licencias (empleado, fecha_desde, fecha_hasta, tipo, cargado_por, creado_en)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(empleado, fechaDesde, fechaHasta, tipo, cargadoPor || null, new Date().toISOString());

  const { omitidos, periodos } = materializarDiasLicencia(empleado, fechaDesde, fechaHasta, tipo);
  periodos.forEach((periodo) => recalcularResumenEmpleado(empleado, periodo));

  return { id: info.lastInsertRowid, omitidos, periodos };
}

function listarLicencias() {
  return db.prepare(`
    SELECT id, empleado, fecha_desde as fechaDesde, fecha_hasta as fechaHasta, tipo, cargado_por as cargadoPor, creado_en as creadoEn
    FROM licencias ORDER BY fecha_desde DESC
  `).all();
}

function licenciasActivasEnFecha(fechaISO) {
  return db.prepare(`
    SELECT id, empleado, fecha_desde as fechaDesde, fecha_hasta as fechaHasta, tipo
    FROM licencias WHERE fecha_desde <= ? AND fecha_hasta >= ? ORDER BY empleado
  `).all(fechaISO, fechaISO);
}

// Borra la licencia y, junto con ella, unicamente los placeholders puros que
// genero (licencia_tipo IS NOT NULL) -- si alguno de esos dias ya tiene un
// dato real cargado despues (guardarFilasDiarias limpia licencia_tipo al
// llegar un dato real), esa fila ya no entra en el filtro y no se toca.
function eliminarLicencia(id) {
  const lic = db.prepare("SELECT * FROM licencias WHERE id = ?").get(id);
  if (!lic) return { periodos: [] };

  const periodosAfectados = db.prepare(`
    SELECT DISTINCT periodo FROM filas_diarias
    WHERE empleado = ? AND fecha BETWEEN ? AND ? AND licencia_tipo IS NOT NULL
  `).all(lic.empleado, lic.fecha_desde, lic.fecha_hasta).map((r) => r.periodo);

  db.prepare(`
    DELETE FROM filas_diarias WHERE empleado = ? AND fecha BETWEEN ? AND ? AND licencia_tipo IS NOT NULL
  `).run(lic.empleado, lic.fecha_desde, lic.fecha_hasta);

  db.prepare("DELETE FROM licencias WHERE id = ?").run(id);
  periodosAfectados.forEach((periodo) => recalcularResumenEmpleado(lic.empleado, periodo));

  return { periodos: periodosAfectados };
}

module.exports = {
  db,
  guardarResumenMensual, resumenDelPeriodo,
  empleadoPorNumero, numeroDeEmpleado, registrarNumero,
  horasAcumuladas, ultimoResumen,
  guardarFilasDiarias, filaDelDia, filaDelDiaPorFecha, filasDelPeriodo, filasDelPeriodoDeEmpleado, actualizarFilaDiaria, recalcularResumenEmpleado,
  crearSolicitud, obtenerSolicitud, resolverSolicitud, solicitudesPendientes, solicitudesDeEmpleado,
  crearSolicitudCambio, obtenerSolicitudCambio, resolverSolicitudCambio, solicitudesCambioPendientes,
  guardarExcepcionTurno, obtenerExcepcionTurno,
  agregarEvento, esEventoRegistrado,
  registrarMensaje, estadisticasInteracciones, primerMensajeRegistrado,
  correccionesPorEmpleado, ultimaActividadPorEmpleado, fichadasCompletasPorEmpleado,
  obtenerConversacion, guardarConversacion, limpiarConversacion,
  obtenerFichadaHoy, marcarIngresoDetectado, marcarEgresoDetectado,
  marcarIngresoNotificado, marcarEgresoNotificado, registrarRecordatorio,
  fichadasPendientesDeNotificar, fichadasSinEgresoDeHoy,
  crearLicencia, listarLicencias, licenciasActivasEnFecha, eliminarLicencia,
};
