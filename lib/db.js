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
`);

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
  const stmt = db.prepare(`
    INSERT INTO filas_diarias (empleado, periodo, fecha, turno, ingreso, egreso, total_hs, h50, h100, alerta)
    VALUES (@empleado, @periodo, @fecha, @turno, @ingreso, @egreso, @totalHs, @h50, @h100, @alerta)
    ON CONFLICT(empleado, periodo, fecha) DO UPDATE SET
      turno=excluded.turno, ingreso=excluded.ingreso, egreso=excluded.egreso,
      total_hs=excluded.total_hs, h50=excluded.h50, h100=excluded.h100, alerta=excluded.alerta
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
  // Los dias "REVISAR MANUALMENTE" (mas de 2 fichajes, no se sabe cual par
  // es el real) cuentan como dia trabajado, pero sus horas NO se suman al
  // total hasta que alguien confirme cual es el horario real — sumarlas
  // igual seria darle por buena una hora que el sistema no puede garantizar.
  const agregados = db.prepare(`
    SELECT COUNT(*) as dias,
           COALESCE(SUM(CASE WHEN alerta LIKE '%REVISAR MANUALMENTE%' THEN 0 ELSE total_hs END), 0) as totalHs,
           COALESCE(SUM(CASE WHEN alerta LIKE '%REVISAR MANUALMENTE%' THEN 0 ELSE h50 END), 0) as h50,
           COALESCE(SUM(CASE WHEN alerta LIKE '%REVISAR MANUALMENTE%' THEN 0 ELSE h100 END), 0) as h100
    FROM filas_diarias WHERE empleado = ? AND periodo = ?
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

module.exports = {
  db,
  guardarResumenMensual, resumenDelPeriodo,
  empleadoPorNumero, numeroDeEmpleado, registrarNumero,
  horasAcumuladas, ultimoResumen,
  guardarFilasDiarias, filaDelDia, filaDelDiaPorFecha, filasDelPeriodo, filasDelPeriodoDeEmpleado, actualizarFilaDiaria, recalcularResumenEmpleado,
  crearSolicitud, obtenerSolicitud, resolverSolicitud, solicitudesPendientes, solicitudesDeEmpleado,
  obtenerConversacion, guardarConversacion, limpiarConversacion,
  obtenerFichadaHoy, marcarIngresoDetectado, marcarEgresoDetectado,
  marcarIngresoNotificado, marcarEgresoNotificado, registrarRecordatorio,
  fichadasPendientesDeNotificar, fichadasSinEgresoDeHoy,
};
