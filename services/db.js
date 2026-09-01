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

  -- Pedido de un empleado de deshacer una correccion o un cambio de turno
  -- YA APROBADO (tipo='correccion'|'cambio', solicitud_id apunta a la fila
  -- original en solicitudes_correccion o solicitudes_cambio). Pasa por la
  -- misma aprobacion del admin que cualquier otro pedido -- al aprobarla se
  -- restaura el snapshot guardado en la solicitud original.
  CREATE TABLE IF NOT EXISTS solicitudes_cancelacion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    solicitud_id INTEGER NOT NULL,
    empleado TEXT NOT NULL,
    numero_whatsapp TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    creado_en TEXT NOT NULL,
    resuelto_en TEXT
  );

  -- Sesiones del panel web, persistidas (antes vivian solo en memoria del
  -- proceso -- se perdian cada vez que el server se reiniciaba, que pasa
  -- seguido por el auto-deploy). expira_en se renueva en cada request
  -- autenticado (sesion "deslizante": se cierra sola por inactividad, no
  -- por un limite fijo desde el login).
  CREATE TABLE IF NOT EXISTS sesiones_panel (
    token TEXT PRIMARY KEY,
    creado_en TEXT NOT NULL,
    expira_en TEXT NOT NULL
  );

  -- Login de cada empleado para la app propia (separada del panel de admin).
  -- nombre tiene que matchear un nombre de SECTORES en motorCalculo.js --
  -- esta tabla es solo para credenciales/rol, no reemplaza ese roster.
  CREATE TABLE IF NOT EXISTS empleados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    sector TEXT NOT NULL,
    usuario TEXT NOT NULL UNIQUE,
    pin_hash TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT NOT NULL
  );

  -- Sesiones de la app de empleado -- separada a proposito de sesiones_panel
  -- para que nunca se puedan confundir los dos niveles de acceso (admin vs
  -- empleado). Mismo esquema deslizante que las del panel.
  CREATE TABLE IF NOT EXISTS sesiones_app (
    token TEXT PRIMARY KEY,
    empleado_id INTEGER NOT NULL,
    creado_en TEXT NOT NULL,
    expira_en TEXT NOT NULL
  );

  -- Freno de fuerza bruta contra el login de la app de empleado (PIN de 6
  -- digitos, sin este freno se podria probar por script). Persistido para
  -- que el bloqueo sobreviva a un reinicio del server (pasa seguido por el
  -- auto-deploy), igual criterio que las sesiones.
  CREATE TABLE IF NOT EXISTS intentos_login_app (
    usuario TEXT PRIMARY KEY,
    intentos INTEGER NOT NULL DEFAULT 0,
    bloqueado_hasta TEXT
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

// Snapshot del estado ANTES de aplicar la correccion (se completa recien al
// aprobarla) -- necesario para poder restaurarlo si despues se pide
// cancelar esa correccion.
const columnasSolicitudCorreccion = db.prepare("PRAGMA table_info(solicitudes_correccion)").all();
if (!columnasSolicitudCorreccion.some((c) => c.name === "snapshot_ingreso")) {
  db.exec(`
    ALTER TABLE solicitudes_correccion ADD COLUMN snapshot_ingreso TEXT;
    ALTER TABLE solicitudes_correccion ADD COLUMN snapshot_egreso TEXT;
    ALTER TABLE solicitudes_correccion ADD COLUMN snapshot_total_hs REAL;
    ALTER TABLE solicitudes_correccion ADD COLUMN snapshot_h50 REAL;
    ALTER TABLE solicitudes_correccion ADD COLUMN snapshot_h100 REAL;
    ALTER TABLE solicitudes_correccion ADD COLUMN snapshot_alerta TEXT;
  `);
}
// Aparte del bloque de arriba (guard separado a proposito): si no habia
// fila del todo antes de la correccion, cancelarla tiene que BORRAR la fila
// (no dejarla en 0/null) -- si no, cuenta de mas en "dias trabajados".
if (!db.prepare("PRAGMA table_info(solicitudes_correccion)").all().some((c) => c.name === "snapshot_existia")) {
  db.exec("ALTER TABLE solicitudes_correccion ADD COLUMN snapshot_existia INTEGER DEFAULT 1");
}

// Snapshot (JSON) de las excepciones de turno que habia -- para cada uno de
// los 4 pares (empleado, fecha) que toca el cambio -- justo antes de
// aplicarlo. null en un par significa "no habia excepcion, iba por la
// formula base".
const columnasSolicitudCambio = db.prepare("PRAGMA table_info(solicitudes_cambio)").all();
if (!columnasSolicitudCambio.some((c) => c.name === "snapshot_excepciones")) {
  db.exec("ALTER TABLE solicitudes_cambio ADD COLUMN snapshot_excepciones TEXT");
}

// Fuerza el cambio de contraseña la primera vez que el empleado entra a su
// app (o despues de que el admin se la resetee) -- la credencial inicial es
// predecible (usuario + "1"), asi que no puede quedar como definitiva.
// Default 1 para que las cuentas ya existentes (creadas con PIN random,
// nunca cambiado) tambien queden marcadas a cambiar.
const columnasEmpleados = db.prepare("PRAGMA table_info(empleados)").all();
if (!columnasEmpleados.some((c) => c.name === "debe_cambiar_pin")) {
  db.exec("ALTER TABLE empleados ADD COLUMN debe_cambiar_pin INTEGER NOT NULL DEFAULT 1");
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

// El "periodo" (ej "2026-07") es solo una etiqueta interna -- el rango real
// de dias cargados no coincide con el mes calendario (ej hoy: 21/6 al 20/7).
// Esto da las fechas reales para mostrar en vez de la etiqueta.
function rangoFechasDelPeriodo(periodo) {
  const row = db.prepare(`SELECT MIN(fecha) as desde, MAX(fecha) as hasta FROM filas_diarias WHERE periodo = ?`).get(periodo);
  return row && row.desde ? { desde: row.desde, hasta: row.hasta } : null;
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
  // Si el empleado ya tenia OTRO numero cargado, lo saca primero -- si no,
  // registrar un numero nuevo dejaria el viejo huerfano apuntando al mismo
  // empleado (dos filas para la misma persona, numeroDeEmpleado devolveria
  // cualquiera de las dos sin orden definido).
  db.prepare("DELETE FROM whatsapp_map WHERE empleado = ? AND numero != ?").run(empleado, numero);
  db.prepare(`
    INSERT INTO whatsapp_map (numero, empleado) VALUES (?, ?)
    ON CONFLICT(numero) DO UPDATE SET empleado = excluded.empleado
  `).run(numero, empleado);
}

function eliminarNumero(empleado) {
  db.prepare("DELETE FROM whatsapp_map WHERE empleado = ?").run(empleado);
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

// Borra directamente la fila de un dia -- a diferencia de actualizarFilaDiaria
// (que solo pisa campos puntuales), esto se usa cuando el dia no debe
// existir mas (ej: al cancelar una correccion que habia creado la fila
// desde cero, cuando antes no habia ningun dato ese dia).
function borrarFilaDiaria(empleado, periodo, fecha) {
  db.prepare("DELETE FROM filas_diarias WHERE empleado = ? AND periodo = ? AND fecha = ?").run(empleado, periodo, fecha);
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

// Para el historial del panel -- todos los estados, no solo pendientes.
function todasLasSolicitudes(limite = 200) {
  return db.prepare(`SELECT * FROM solicitudes_correccion ORDER BY id DESC LIMIT ?`).all(limite);
}

function solicitudesDeEmpleado(empleado, limite = 10) {
  return db.prepare(`
    SELECT * FROM solicitudes_correccion WHERE empleado = ? ORDER BY id DESC LIMIT ?
  `).all(empleado, limite);
}

// Guarda como quedaba el dia ANTES de aplicar esta correccion -- se llama
// justo antes de pisar filas_diarias, para poder restaurarlo si mas
// adelante se aprueba un pedido de cancelacion sobre esta misma solicitud.
function guardarSnapshotCorreccion(id, snap) {
  db.prepare(`
    UPDATE solicitudes_correccion SET
      snapshot_ingreso = @ingreso, snapshot_egreso = @egreso, snapshot_total_hs = @totalHs,
      snapshot_h50 = @h50, snapshot_h100 = @h100, snapshot_alerta = @alerta, snapshot_existia = @existia
    WHERE id = @id
  `).run({ id, ...snap });
}

// Solo se puede cancelar la correccion MAS RECIENTE aprobada sobre ese
// mismo dia -- si hay otra mas nueva encima, se bloquea (evita pisar un
// dato mas reciente y valido).
function esUltimaCorreccionAprobada(solicitud) {
  const masReciente = db.prepare(`
    SELECT id FROM solicitudes_correccion
    WHERE empleado = ? AND fecha = ? AND estado = 'aprobada'
    ORDER BY id DESC LIMIT 1
  `).get(solicitud.empleado, solicitud.fecha);
  return !masReciente || masReciente.id === solicitud.id;
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

function todosLosCambiosDeTurno(limite = 200) {
  return db.prepare(`SELECT * FROM solicitudes_cambio ORDER BY id DESC LIMIT ?`).all(limite);
}

function solicitudesCambioDeEmpleado(empleado, limite = 10) {
  return db.prepare(`
    SELECT * FROM solicitudes_cambio WHERE empleado_a = ? OR empleado_b = ? ORDER BY id DESC LIMIT ?
  `).all(empleado, empleado, limite);
}

// Guarda (como JSON) la excepcion de turno que habia -- o null si no habia
// ninguna -- para cada uno de los 4 pares (empleado, fecha) que toca este
// cambio, justo antes de aplicarlo. Necesario para poder restaurar el
// estado exacto de antes si mas adelante se cancela este cambio.
function guardarSnapshotCambio(id, snapshotExcepciones) {
  db.prepare(`UPDATE solicitudes_cambio SET snapshot_excepciones = ? WHERE id = ?`)
    .run(JSON.stringify(snapshotExcepciones), id);
}

// Solo se puede cancelar el cambio MAS RECIENTE aprobado que haya tocado
// alguno de estos 4 pares (empleado, fecha) -- si hay uno mas nuevo encima
// (ej: alguno de los 4 dias ya se volvio a cambiar), se bloquea.
function esUltimoCambioAprobado(solicitud) {
  const pares = new Set([
    `${solicitud.empleado_a}|${solicitud.fecha_a}`, `${solicitud.empleado_b}|${solicitud.fecha_a}`,
    `${solicitud.empleado_a}|${solicitud.fecha_b}`, `${solicitud.empleado_b}|${solicitud.fecha_b}`,
  ]);
  const posteriores = db.prepare(`SELECT * FROM solicitudes_cambio WHERE estado = 'aprobada' AND id > ?`).all(solicitud.id);
  return !posteriores.some((s) => {
    const paresS = [`${s.empleado_a}|${s.fecha_a}`, `${s.empleado_b}|${s.fecha_a}`, `${s.empleado_a}|${s.fecha_b}`, `${s.empleado_b}|${s.fecha_b}`];
    return paresS.some((p) => pares.has(p));
  });
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

function eliminarExcepcionTurno(empleado, fecha) {
  db.prepare("DELETE FROM excepciones_turno WHERE empleado = ? AND fecha = ?").run(empleado, fecha);
}

// ── Solicitudes de cancelacion (deshacer una correccion o un cambio ya aprobado) ──

// ── Sesiones del panel web (persistidas -- sobreviven a un reinicio del server) ──

function crearSesionPanel(token, expiraEnISO) {
  limpiarSesionesVencidas();
  db.prepare(`INSERT INTO sesiones_panel (token, creado_en, expira_en) VALUES (?, ?, ?)`)
    .run(token, new Date().toISOString(), expiraEnISO);
}

// Renueva el vencimiento SOLO si el token es valido y no vencio todavia
// (sesion deslizante). Devuelve false si hay que pedir login de nuevo.
function renovarSesionPanel(token, expiraEnISO) {
  const info = db.prepare(`UPDATE sesiones_panel SET expira_en = ? WHERE token = ? AND expira_en > ?`)
    .run(expiraEnISO, token, new Date().toISOString());
  return info.changes > 0;
}

function eliminarSesionPanel(token) {
  db.prepare(`DELETE FROM sesiones_panel WHERE token = ?`).run(token);
}

function limpiarSesionesVencidas() {
  db.prepare(`DELETE FROM sesiones_panel WHERE expira_en <= ?`).run(new Date().toISOString());
}

function crearSolicitudCancelacion({ tipo, solicitudId, empleado, numeroWhatsapp }) {
  const info = db.prepare(`
    INSERT INTO solicitudes_cancelacion (tipo, solicitud_id, empleado, numero_whatsapp, estado, creado_en)
    VALUES (?, ?, ?, ?, 'pendiente', ?)
  `).run(tipo, solicitudId, empleado, numeroWhatsapp, new Date().toISOString());
  return info.lastInsertRowid;
}

function obtenerSolicitudCancelacion(id) {
  return db.prepare("SELECT * FROM solicitudes_cancelacion WHERE id = ?").get(id);
}

function resolverSolicitudCancelacion(id, estado) {
  db.prepare(`UPDATE solicitudes_cancelacion SET estado = ?, resuelto_en = ? WHERE id = ?`)
    .run(estado, new Date().toISOString(), id);
}

function solicitudesCancelacionPendientes() {
  return db.prepare(`SELECT * FROM solicitudes_cancelacion WHERE estado = 'pendiente' ORDER BY id ASC`).all();
}

function todasLasCancelaciones(limite = 200) {
  return db.prepare(`SELECT * FROM solicitudes_cancelacion ORDER BY id DESC LIMIT ?`).all(limite);
}

// Evita pedir cancelar dos veces la misma solicitud mientras la primera
// sigue pendiente de que el admin la revise.
function existeCancelacionPendiente(tipo, solicitudId) {
  return !!db.prepare(`
    SELECT 1 FROM solicitudes_cancelacion WHERE tipo = ? AND solicitud_id = ? AND estado = 'pendiente'
  `).get(tipo, solicitudId);
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

// Suma correcciones + cambios de turno (cuenta para los dos involucrados) +
// cancelaciones -- a diferencia de correccionesPorEmpleado, que solo mira
// un tipo de pedido.
function pedidosTotalesPorEmpleado() {
  const filas = [
    ...db.prepare(`SELECT empleado, COUNT(*) as n FROM solicitudes_correccion GROUP BY empleado`).all(),
    ...db.prepare(`SELECT empleado_a as empleado, COUNT(*) as n FROM solicitudes_cambio GROUP BY empleado_a`).all(),
    ...db.prepare(`SELECT empleado_b as empleado, COUNT(*) as n FROM solicitudes_cambio GROUP BY empleado_b`).all(),
    ...db.prepare(`SELECT empleado, COUNT(*) as n FROM solicitudes_cancelacion GROUP BY empleado`).all(),
  ];
  const totales = {};
  filas.forEach((f) => { totales[f.empleado] = (totales[f.empleado] || 0) + f.n; });
  return Object.entries(totales)
    .map(([empleado, cantidad]) => ({ empleado, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad);
}

// Los ultimos N periodos que tienen datos en resumen_mensual, en orden
// cronologico (mas viejo primero) -- para armar un grafico de tendencia.
function periodosRecientes(cantidad = 6) {
  return db.prepare(`SELECT DISTINCT periodo FROM resumen_mensual ORDER BY periodo DESC LIMIT ?`)
    .all(cantidad)
    .map((r) => r.periodo)
    .reverse();
}

function ultimaActividadPorEmpleado() {
  return db.prepare(`
    SELECT wm.empleado as empleado, cw.numero as numero, cw.actualizado_en as actualizadoEn
    FROM conversaciones_whatsapp cw
    LEFT JOIN whatsapp_map wm ON wm.numero = cw.numero
  `).all();
}

// Si el numero le escribio al bot hace menos de 24hs, WhatsApp deja mandar
// un mensaje de texto libre; pasado ese plazo, solo se puede mandar una
// Content Template ya aprobada por Meta (mensaje "en frio", iniciado por el
// bot). numero va sin el prefijo "whatsapp:", igual que en whatsapp_map.
function ventanaAbiertaPara(numero) {
  const row = db.prepare("SELECT actualizado_en FROM conversaciones_whatsapp WHERE numero = ?").get(numero);
  if (!row) return false;
  return Date.now() - new Date(row.actualizado_en).getTime() < 24 * 60 * 60 * 1000;
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

// Licencias que se solapan con [fechaDesde, fechaHasta] (aunque hayan
// empezado antes o terminen despues del rango) -- para el "proximos dias
// libres" del dashboard.
function licenciasEnRango(fechaDesde, fechaHasta) {
  return db.prepare(`
    SELECT id, empleado, fecha_desde as fechaDesde, fecha_hasta as fechaHasta, tipo
    FROM licencias WHERE fecha_desde <= ? AND fecha_hasta >= ? ORDER BY fecha_desde
  `).all(fechaHasta, fechaDesde);
}

// Agregado de "dias con fichaje completo" contra el total, para TODOS los
// empleados juntos en un periodo -- usado para el medidor de salud de
// fichaje del dashboard (vs fichadasCompletasPorEmpleado, que es por persona).
function saludFichajePeriodo(periodo) {
  const row = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN ingreso IS NOT NULL AND egreso IS NOT NULL THEN 1 ELSE 0 END) as completos
    FROM filas_diarias WHERE periodo = ?
  `).get(periodo);
  return { completos: row.completos || 0, total: row.total || 0 };
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

// ── Login de empleado para la app propia (separado del panel de admin) ──

function crearEmpleadoApp({ nombre, sector, usuario, pinHash }) {
  const info = db.prepare(`
    INSERT INTO empleados (nombre, sector, usuario, pin_hash, activo, creado_en)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(nombre, sector, usuario, pinHash, new Date().toISOString());
  return info.lastInsertRowid;
}

function listarEmpleadosApp() {
  return db.prepare(`
    SELECT id, nombre, sector, usuario, activo, creado_en as creadoEn, debe_cambiar_pin as debeCambiarPin
    FROM empleados ORDER BY nombre
  `).all();
}

function buscarEmpleadoAppPorUsuario(usuario) {
  return db.prepare(`SELECT * FROM empleados WHERE usuario = ? AND activo = 1`).get(usuario);
}

function empleadoAppPorId(id) {
  return db.prepare(`SELECT * FROM empleados WHERE id = ?`).get(id);
}

// La usa el ADMIN para (re)emitir una credencial (alta o reset) -- siempre
// vuelve a marcar debe_cambiar_pin=1, porque lo que se le entrega al
// empleado en ese momento es predecible (usuario + "1"), nunca definitivo.
function actualizarPinEmpleadoApp(id, pinHash) {
  db.prepare(`UPDATE empleados SET pin_hash = ?, debe_cambiar_pin = 1 WHERE id = ?`).run(pinHash, id);
}

// La usa el EMPLEADO mismo para cambiar su propia contraseña (ya logueado,
// confirmando la actual) -- limpia la bandera de "debe cambiar" al hacerlo.
function cambiarPasswordEmpleadoApp(id, pinHash) {
  db.prepare(`UPDATE empleados SET pin_hash = ?, debe_cambiar_pin = 0 WHERE id = ?`).run(pinHash, id);
}

function eliminarEmpleadoApp(id) {
  db.prepare(`DELETE FROM empleados WHERE id = ?`).run(id);
}

// ── Sesiones de la app de empleado (separadas de sesiones_panel) ──

function crearSesionApp(token, empleadoId, expiraEnISO) {
  limpiarSesionesAppVencidas();
  db.prepare(`INSERT INTO sesiones_app (token, empleado_id, creado_en, expira_en) VALUES (?, ?, ?, ?)`)
    .run(token, empleadoId, new Date().toISOString(), expiraEnISO);
}

function renovarSesionApp(token, expiraEnISO) {
  const info = db.prepare(`UPDATE sesiones_app SET expira_en = ? WHERE token = ? AND expira_en > ?`)
    .run(expiraEnISO, token, new Date().toISOString());
  return info.changes > 0;
}

function empleadoIdDeSesionApp(token) {
  const row = db.prepare(`SELECT empleado_id FROM sesiones_app WHERE token = ?`).get(token);
  return row ? row.empleado_id : null;
}

function eliminarSesionApp(token) {
  db.prepare(`DELETE FROM sesiones_app WHERE token = ?`).run(token);
}

function limpiarSesionesAppVencidas() {
  db.prepare(`DELETE FROM sesiones_app WHERE expira_en <= ?`).run(new Date().toISOString());
}

// ── Freno de fuerza bruta del login de la app de empleado ──

const MAX_INTENTOS_LOGIN_APP = 5;
const BLOQUEO_LOGIN_APP_MS = 15 * 60 * 1000;

function estaBloqueadoLoginApp(usuario) {
  const row = db.prepare(`SELECT bloqueado_hasta FROM intentos_login_app WHERE usuario = ?`).get(usuario);
  return !!(row && row.bloqueado_hasta && row.bloqueado_hasta > new Date().toISOString());
}

// Se llama en cada intento fallido -- a partir del intento MAX_INTENTOS_LOGIN_APP
// bloquea ese usuario por BLOQUEO_LOGIN_APP_MS (sigue contando intentos
// mientras este bloqueado, asi que insistir no acorta la espera).
function registrarIntentoFallidoLoginApp(usuario) {
  const row = db.prepare(`SELECT intentos FROM intentos_login_app WHERE usuario = ?`).get(usuario);
  const intentos = (row ? row.intentos : 0) + 1;
  const bloqueadoHasta = intentos >= MAX_INTENTOS_LOGIN_APP ? new Date(Date.now() + BLOQUEO_LOGIN_APP_MS).toISOString() : null;
  db.prepare(`
    INSERT INTO intentos_login_app (usuario, intentos, bloqueado_hasta) VALUES (?, ?, ?)
    ON CONFLICT(usuario) DO UPDATE SET intentos = excluded.intentos, bloqueado_hasta = excluded.bloqueado_hasta
  `).run(usuario, intentos, bloqueadoHasta);
}

function limpiarIntentosLoginApp(usuario) {
  db.prepare(`DELETE FROM intentos_login_app WHERE usuario = ?`).run(usuario);
}

module.exports = {
  db,
  guardarResumenMensual, resumenDelPeriodo, rangoFechasDelPeriodo,
  empleadoPorNumero, numeroDeEmpleado, registrarNumero, eliminarNumero,
  horasAcumuladas, ultimoResumen,
  guardarFilasDiarias, filaDelDia, filaDelDiaPorFecha, filasDelPeriodo, filasDelPeriodoDeEmpleado, actualizarFilaDiaria, borrarFilaDiaria, recalcularResumenEmpleado,
  crearSolicitud, obtenerSolicitud, resolverSolicitud, solicitudesPendientes, solicitudesDeEmpleado,
  guardarSnapshotCorreccion, esUltimaCorreccionAprobada,
  crearSolicitudCambio, obtenerSolicitudCambio, resolverSolicitudCambio, solicitudesCambioPendientes,
  solicitudesCambioDeEmpleado, guardarSnapshotCambio, esUltimoCambioAprobado,
  guardarExcepcionTurno, obtenerExcepcionTurno, eliminarExcepcionTurno,
  crearSesionPanel, renovarSesionPanel, eliminarSesionPanel, limpiarSesionesVencidas,
  crearSolicitudCancelacion, obtenerSolicitudCancelacion, resolverSolicitudCancelacion,
  solicitudesCancelacionPendientes, existeCancelacionPendiente,
  agregarEvento, esEventoRegistrado,
  registrarMensaje, estadisticasInteracciones, primerMensajeRegistrado,
  correccionesPorEmpleado, ultimaActividadPorEmpleado, ventanaAbiertaPara, fichadasCompletasPorEmpleado,
  pedidosTotalesPorEmpleado, periodosRecientes,
  obtenerConversacion, guardarConversacion, limpiarConversacion,
  obtenerFichadaHoy, marcarIngresoDetectado, marcarEgresoDetectado,
  marcarIngresoNotificado, marcarEgresoNotificado, registrarRecordatorio,
  fichadasPendientesDeNotificar, fichadasSinEgresoDeHoy,
  crearLicencia, listarLicencias, licenciasActivasEnFecha, licenciasEnRango, eliminarLicencia,
  saludFichajePeriodo,
  todasLasSolicitudes, todosLosCambiosDeTurno, todasLasCancelaciones,
  crearEmpleadoApp, listarEmpleadosApp, buscarEmpleadoAppPorUsuario, empleadoAppPorId,
  actualizarPinEmpleadoApp, cambiarPasswordEmpleadoApp, eliminarEmpleadoApp,
  crearSesionApp, renovarSesionApp, empleadoIdDeSesionApp, eliminarSesionApp, limpiarSesionesAppVencidas,
  estaBloqueadoLoginApp, registrarIntentoFallidoLoginApp, limpiarIntentosLoginApp,
};

// Contraseña del panel de admin -- migrada de un simple string en .env
// (ADMIN_PANEL_PASSWORD, comparado en texto plano) a un hash guardado en
// la base, para poder cambiarla desde adentro del panel sin tocar el .env
// ni reiniciar el servidor. Fila unica (id=1, forzado por el CHECK).
db.exec(`
  CREATE TABLE IF NOT EXISTS panel_password (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pass_hash TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  )
`);

function passwordPanelHash() {
  const row = db.prepare("SELECT pass_hash FROM panel_password WHERE id = 1").get();
  return row ? row.pass_hash : null;
}

function establecerPasswordPanel(hash) {
  db.prepare(`
    INSERT INTO panel_password (id, pass_hash, actualizado_en) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET pass_hash = excluded.pass_hash, actualizado_en = excluded.actualizado_en
  `).run(hash, new Date().toISOString());
}

module.exports.passwordPanelHash = passwordPanelHash;
module.exports.establecerPasswordPanel = establecerPasswordPanel;

// Perfil del admin (nombre/apellido/usuario/foto) -- puramente informativo,
// no forma parte del login (que sigue siendo una sola contraseña
// compartida via panel_password). Fila unica (id=1).
db.exec(`
  CREATE TABLE IF NOT EXISTS perfil_admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    nombre TEXT,
    apellido TEXT,
    usuario TEXT,
    foto TEXT,
    actualizado_en TEXT NOT NULL
  )
`);

function perfilAdmin() {
  return db.prepare("SELECT * FROM perfil_admin WHERE id = 1").get() || null;
}

function guardarPerfilAdmin({ nombre, apellido, usuario, foto }) {
  db.prepare(`
    INSERT INTO perfil_admin (id, nombre, apellido, usuario, foto, actualizado_en) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      nombre = excluded.nombre, apellido = excluded.apellido, usuario = excluded.usuario,
      foto = COALESCE(excluded.foto, perfil_admin.foto), actualizado_en = excluded.actualizado_en
  `).run(nombre || null, apellido || null, usuario || null, foto || null, new Date().toISOString());
}

// Suscripciones Web Push del panel -- separadas de las de la app de
// empleado (push_subscripciones_app) porque el panel no tiene un
// empleado_app_id: es un login compartido, no individual.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscripciones_panel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    creado_en TEXT NOT NULL
  )
`);

function guardarPushSubscripcionPanel({ endpoint, p256dh, auth }) {
  db.prepare(`
    INSERT INTO push_subscripciones_panel (endpoint, p256dh, auth, creado_en)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
  `).run(endpoint, p256dh, auth, new Date().toISOString());
}

function eliminarPushSubscripcionPanel(endpoint) {
  db.prepare(`DELETE FROM push_subscripciones_panel WHERE endpoint = ?`).run(endpoint);
}

function todasLasSuscripcionesPanel() {
  return db.prepare(`SELECT * FROM push_subscripciones_panel`).all();
}

module.exports.perfilAdmin = perfilAdmin;
module.exports.guardarPerfilAdmin = guardarPerfilAdmin;
module.exports.guardarPushSubscripcionPanel = guardarPushSubscripcionPanel;
module.exports.eliminarPushSubscripcionPanel = eliminarPushSubscripcionPanel;
module.exports.todasLasSuscripcionesPanel = todasLasSuscripcionesPanel;
// Admins del panel -- reemplaza la contraseña compartida (panel_password)
// por cuentas individuales, cada una con su propio login (usuario +
// contraseña), nombre/puesto/sector/foto y un campo de permisos (por
// ahora solo se guarda/muestra, no se aplica ninguna restriccion real
// todavia -- eso queda para cuando se definan que acciones hay que
// limitar por rol).
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT,
    apellido TEXT,
    puesto TEXT,
    usuario TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    permisos TEXT NOT NULL DEFAULT 'admin',
    sector TEXT,
    foto TEXT,
    activo INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT NOT NULL
  )
`);

// sesiones_panel necesita saber A QUE admin pertenece cada sesion (antes
// una sola contraseña compartida no distinguia quien era quien).
if (!db.prepare("PRAGMA table_info(sesiones_panel)").all().some((c) => c.name === "admin_id")) {
  db.exec("ALTER TABLE sesiones_panel ADD COLUMN admin_id INTEGER");
}

// Migracion unica: si todavia no hay ningun admin cargado pero ya existia
// la contraseña compartida de siempre (panel_password) y el perfil viejo
// (perfil_admin), se crea el primer admin a partir de esos datos --
// copiando el HASH de la contraseña tal cual (no hace falta saber la
// contraseña en texto plano), asi el login de siempre sigue funcionando
// igual, ahora pidiendo tambien el usuario.
const yaHayAdmins = db.prepare("SELECT COUNT(*) as n FROM admins").get().n;
if (yaHayAdmins === 0) {
  const perfilViejo = db.prepare("SELECT * FROM perfil_admin WHERE id = 1").get();
  const passwordViejo = db.prepare("SELECT pass_hash FROM panel_password WHERE id = 1").get();
  if (passwordViejo) {
    db.prepare(`
      INSERT INTO admins (nombre, apellido, puesto, usuario, pass_hash, permisos, sector, foto, activo, creado_en)
      VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, 1, ?)
    `).run(
      perfilViejo?.nombre || "Admin", perfilViejo?.apellido || "", "",
      perfilViejo?.usuario || "admin", passwordViejo.pass_hash,
      perfilViejo?.sector || null, perfilViejo?.foto || null,
      new Date().toISOString()
    );
  }
}

function crearAdmin({ nombre, apellido, puesto, usuario, passHash, permisos, sector }) {
  const info = db.prepare(`
    INSERT INTO admins (nombre, apellido, puesto, usuario, pass_hash, permisos, sector, activo, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(nombre || null, apellido || null, puesto || null, usuario, passHash, permisos || "admin", sector || null, new Date().toISOString());
  return info.lastInsertRowid;
}

function listarAdmins() {
  return db.prepare(`
    SELECT id, nombre, apellido, puesto, usuario, permisos, sector, foto, activo, creado_en FROM admins ORDER BY id ASC
  `).all();
}

function adminPorUsuario(usuario) {
  return db.prepare(`SELECT * FROM admins WHERE usuario = ? AND activo = 1`).get(usuario);
}

function adminPorId(id) {
  return db.prepare(`SELECT * FROM admins WHERE id = ?`).get(id);
}

// foto: COALESCE con la que ya habia -- si no se manda una nueva (no se
// toco "Cambiar foto" esta vez), no se borra la que ya tenia.
function actualizarPerfilAdminPorId(id, { nombre, apellido, usuario, sector, foto }) {
  db.prepare(`
    UPDATE admins SET nombre = ?, apellido = ?, usuario = ?, sector = ?, foto = COALESCE(?, foto) WHERE id = ?
  `).run(nombre || null, apellido || null, usuario, sector || null, foto || null, id);
}

function actualizarPasswordAdmin(id, passHash) {
  db.prepare(`UPDATE admins SET pass_hash = ? WHERE id = ?`).run(passHash, id);
}

function actualizarDatosAdmin(id, { nombre, apellido, puesto, permisos, activo }) {
  db.prepare(`
    UPDATE admins SET nombre = ?, apellido = ?, puesto = ?, permisos = ?, activo = ? WHERE id = ?
  `).run(nombre || null, apellido || null, puesto || null, permisos || "admin", activo === false ? 0 : 1, id);
}

function adminIdDeSesionPanel(token) {
  const row = db.prepare(`SELECT admin_id FROM sesiones_panel WHERE token = ?`).get(token);
  return row ? row.admin_id : null;
}

// Redefine crearSesionPanel para que tambien guarde a que admin pertenece
// la sesion (parametro nuevo, opcional -- por hoisting de function
// declarations, esta version pisa a la original en todo el archivo, sin
// tener que tocar la definicion vieja).
function crearSesionPanel(token, expiraEnISO, adminId) {
  limpiarSesionesVencidas();
  db.prepare(`INSERT INTO sesiones_panel (token, creado_en, expira_en, admin_id) VALUES (?, ?, ?, ?)`)
    .run(token, new Date().toISOString(), expiraEnISO, adminId || null);
}

module.exports.crearAdmin = crearAdmin;
module.exports.listarAdmins = listarAdmins;
module.exports.adminPorUsuario = adminPorUsuario;
module.exports.adminPorId = adminPorId;
module.exports.actualizarPerfilAdminPorId = actualizarPerfilAdminPorId;
module.exports.actualizarPasswordAdmin = actualizarPasswordAdmin;
module.exports.actualizarDatosAdmin = actualizarDatosAdmin;
module.exports.adminIdDeSesionPanel = adminIdDeSesionPanel;
module.exports.crearSesionPanel = crearSesionPanel;

// ── Mural de tareas (posts de un admin dirigidos a una audiencia, que un
// empleado o admin puede reclamar y despues un admin aprobar/rechazar) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS mural_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    autor_nombre TEXT NOT NULL,
    texto TEXT NOT NULL,
    foto TEXT,
    audiencia TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'publicada',
    reclamado_por_tipo TEXT,
    reclamado_por_id INTEGER,
    reclamado_por_nombre TEXT,
    reclamado_en TEXT,
    aprobado_en TEXT,
    finalizada_en TEXT,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mural_post_destinatarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    empleado_id INTEGER NOT NULL
  );
`);

// Migracion aditiva: rol del empleado (para poder targetear "jefes/coordinadores").
const columnasEmpleadosMural = db.prepare("PRAGMA table_info(empleados)").all();
if (!columnasEmpleadosMural.some((c) => c.name === "rol")) {
  db.exec("ALTER TABLE empleados ADD COLUMN rol TEXT NOT NULL DEFAULT 'empleado'");
}

function crearPostMural({ adminId, autorNombre, texto, foto, audiencia, empleadoIds }) {
  const info = db.prepare(`
    INSERT INTO mural_posts (admin_id, autor_nombre, texto, foto, audiencia, estado, creado_en)
    VALUES (?, ?, ?, ?, ?, 'publicada', ?)
  `).run(adminId, autorNombre, texto, foto || null, audiencia, new Date().toISOString());
  const postId = info.lastInsertRowid;
  if (audiencia === "individual" && Array.isArray(empleadoIds)) {
    const insertDest = db.prepare(`INSERT INTO mural_post_destinatarios (post_id, empleado_id) VALUES (?, ?)`);
    for (const empleadoId of empleadoIds) insertDest.run(postId, empleadoId);
  }
  return postId;
}

function destinatariosDePostMural(postId) {
  return db.prepare(`
    SELECT e.id, e.nombre FROM mural_post_destinatarios d
    JOIN empleados e ON e.id = d.empleado_id WHERE d.post_id = ?
  `).all(postId);
}

// Vista de gestion (panel) -- todos los posts, mas reciente primero, con
// los destinatarios resueltos para los de audiencia "individual".
function listarPostsMural() {
  const posts = db.prepare(`SELECT * FROM mural_posts ORDER BY id DESC`).all();
  return posts.map((p) => ({
    ...p,
    destinatarios: p.audiencia === "individual" ? destinatariosDePostMural(p.id) : [],
  }));
}

// Vista del empleado -- solo lo que le corresponde ver segun su sector, si
// es jefe/coordinador, o si fue elegido individualmente. Nunca ve los
// posts de audiencia "admins" (coordinacion interna entre admins).
function listarPostsMuralParaEmpleado(empleadoId, sector, rol) {
  return db.prepare(`
    SELECT * FROM mural_posts
    WHERE audiencia = ?
       OR (audiencia = 'jefes' AND ? = 'jefe')
       OR (audiencia = 'individual' AND id IN (SELECT post_id FROM mural_post_destinatarios WHERE empleado_id = ?))
    ORDER BY id DESC
  `).all(sector, rol, empleadoId);
}

// Atomico: solo reclama si todavia estaba "publicada" -- evita que dos
// personas reclamen la misma tarea a la vez (si ya la reclamo otro, el
// UPDATE no afecta ninguna fila y se avisa que ya fue tomada).
function reclamarPostMural(postId, { tipo, id, nombre }) {
  const info = db.prepare(`
    UPDATE mural_posts SET estado = 'reclamada_pendiente', reclamado_por_tipo = ?, reclamado_por_id = ?,
      reclamado_por_nombre = ?, reclamado_en = ? WHERE id = ? AND estado = 'publicada'
  `).run(tipo, id, nombre, new Date().toISOString(), postId);
  return info.changes > 0;
}

function aprobarReclamoMural(postId) {
  db.prepare(`UPDATE mural_posts SET estado = 'en_proceso', aprobado_en = ? WHERE id = ? AND estado = 'reclamada_pendiente'`)
    .run(new Date().toISOString(), postId);
}

// Vuelve a dejar la tarea disponible para que otro la reclame.
function rechazarReclamoMural(postId) {
  db.prepare(`
    UPDATE mural_posts SET estado = 'publicada', reclamado_por_tipo = NULL, reclamado_por_id = NULL,
      reclamado_por_nombre = NULL, reclamado_en = NULL WHERE id = ? AND estado = 'reclamada_pendiente'
  `).run(postId);
}

function finalizarPostMural(postId) {
  db.prepare(`UPDATE mural_posts SET estado = 'finalizada', finalizada_en = ? WHERE id = ?`)
    .run(new Date().toISOString(), postId);
}

function postMuralPorId(postId) {
  return db.prepare(`SELECT * FROM mural_posts WHERE id = ?`).get(postId);
}

function actualizarRolEmpleado(id, rol) {
  db.prepare(`UPDATE empleados SET rol = ? WHERE id = ?`).run(rol === "jefe" ? "jefe" : "empleado", id);
}

// Redefine listarEmpleadosApp para sumar el rol (jefe/coordinador o
// empleado) -- por hoisting, esta version pisa a la definida mas arriba en
// el archivo sin tener que tocarla.
function listarEmpleadosApp() {
  return db.prepare(`
    SELECT id, nombre, sector, usuario, rol, activo, creado_en as creadoEn, debe_cambiar_pin as debeCambiarPin
    FROM empleados ORDER BY nombre
  `).all();
}

module.exports.crearPostMural = crearPostMural;
module.exports.listarPostsMural = listarPostsMural;
module.exports.listarPostsMuralParaEmpleado = listarPostsMuralParaEmpleado;
module.exports.reclamarPostMural = reclamarPostMural;
module.exports.aprobarReclamoMural = aprobarReclamoMural;
module.exports.rechazarReclamoMural = rechazarReclamoMural;
module.exports.finalizarPostMural = finalizarPostMural;
module.exports.postMuralPorId = postMuralPorId;
module.exports.actualizarRolEmpleado = actualizarRolEmpleado;
module.exports.listarEmpleadosApp = listarEmpleadosApp;

// ── Mural v2: sin aprobacion de reclamo (reclamar = quedar asignado
// directo), el admin tambien puede asignar/desasignar a mano, comentarios
// una vez en proceso, vencimiento opcional, y fotos de cierre. ──

// Migraciones aditivas.
const columnasMuralPosts = db.prepare("PRAGMA table_info(mural_posts)").all();
if (!columnasMuralPosts.some((c) => c.name === "vence_en")) {
  db.exec("ALTER TABLE mural_posts ADD COLUMN vence_en TEXT");
}
if (!columnasMuralPosts.some((c) => c.name === "fotos_cierre")) {
  db.exec("ALTER TABLE mural_posts ADD COLUMN fotos_cierre TEXT");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS mural_post_comentarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    autor_tipo TEXT NOT NULL,
    autor_nombre TEXT NOT NULL,
    texto TEXT NOT NULL,
    creado_en TEXT NOT NULL
  );
`);

// Redefine crearPostMural para sumar vencimiento opcional (por hoisting,
// esta version pisa a la definida mas arriba en el archivo).
function crearPostMural({ adminId, autorNombre, texto, foto, audiencia, empleadoIds, vence }) {
  const info = db.prepare(`
    INSERT INTO mural_posts (admin_id, autor_nombre, texto, foto, audiencia, estado, vence_en, creado_en)
    VALUES (?, ?, ?, ?, ?, 'publicada', ?, ?)
  `).run(adminId, autorNombre, texto, foto || null, audiencia, vence || null, new Date().toISOString());
  const postId = info.lastInsertRowid;
  if (audiencia === "individual" && Array.isArray(empleadoIds)) {
    const insertDest = db.prepare(`INSERT INTO mural_post_destinatarios (post_id, empleado_id) VALUES (?, ?)`);
    for (const empleadoId of empleadoIds) insertDest.run(postId, empleadoId);
  }
  return postId;
}

function comentariosDeMuralPosts(idsPosts) {
  if (!idsPosts.length) return [];
  const placeholders = idsPosts.map(() => "?").join(",");
  return db.prepare(`
    SELECT * FROM mural_post_comentarios WHERE post_id IN (${placeholders}) ORDER BY id ASC
  `).all(...idsPosts);
}

function crearComentarioMural({ postId, autorTipo, autorNombre, texto }) {
  db.prepare(`
    INSERT INTO mural_post_comentarios (post_id, autor_tipo, autor_nombre, texto, creado_en)
    VALUES (?, ?, ?, ?, ?)
  `).run(postId, autorTipo, autorNombre, texto, new Date().toISOString());
}

// Redefine listarPostsMural (panel) para sumar comentarios por post.
function listarPostsMural() {
  const posts = db.prepare(`SELECT * FROM mural_posts ORDER BY id DESC`).all();
  const comentarios = comentariosDeMuralPosts(posts.map((p) => p.id));
  return posts.map((p) => ({
    ...p,
    destinatarios: p.audiencia === "individual" ? destinatariosDePostMural(p.id) : [],
    comentarios: comentarios.filter((c) => c.post_id === p.id),
  }));
}

// Redefine listarPostsMuralParaEmpleado (app) para sumar comentarios.
function listarPostsMuralParaEmpleado(empleadoId, sector, rol) {
  const posts = db.prepare(`
    SELECT * FROM mural_posts
    WHERE audiencia = ?
       OR (audiencia = 'jefes' AND ? = 'jefe')
       OR (audiencia = 'individual' AND id IN (SELECT post_id FROM mural_post_destinatarios WHERE empleado_id = ?))
    ORDER BY id DESC
  `).all(sector, rol, empleadoId);
  const comentarios = comentariosDeMuralPosts(posts.map((p) => p.id));
  return posts.map((p) => ({ ...p, comentarios: comentarios.filter((c) => c.post_id === p.id) }));
}

// Redefine reclamarPostMural -- ya NO pasa por un estado intermedio de
// aprobacion: reclamar deja a esa persona asignada directo (en_proceso).
// Sigue siendo atomico (WHERE estado = 'publicada') para que dos personas
// no puedan reclamar la misma tarea a la vez.
function reclamarPostMural(postId, { tipo, id, nombre }) {
  const info = db.prepare(`
    UPDATE mural_posts SET estado = 'en_proceso', reclamado_por_tipo = ?, reclamado_por_id = ?,
      reclamado_por_nombre = ?, reclamado_en = ?, aprobado_en = ? WHERE id = ? AND estado = 'publicada'
  `).run(tipo, id, nombre, new Date().toISOString(), new Date().toISOString(), postId);
  return info.changes > 0;
}

// El admin asigna (o reasigna) la tarea a mano, sin depender de que la
// persona la reclame ella misma -- funciona en cualquier estado excepto
// finalizada.
function asignarPostMural(postId, { tipo, id, nombre }) {
  const info = db.prepare(`
    UPDATE mural_posts SET estado = 'en_proceso', reclamado_por_tipo = ?, reclamado_por_id = ?,
      reclamado_por_nombre = ?, reclamado_en = ?, aprobado_en = ? WHERE id = ? AND estado != 'finalizada'
  `).run(tipo, id, nombre, new Date().toISOString(), new Date().toISOString(), postId);
  return info.changes > 0;
}

// Quita la asignacion actual -- vuelve la tarea a "publicada" para que se
// pueda reclamar o asignar de nuevo.
function desasignarPostMural(postId) {
  db.prepare(`
    UPDATE mural_posts SET estado = 'publicada', reclamado_por_tipo = NULL, reclamado_por_id = NULL,
      reclamado_por_nombre = NULL, reclamado_en = NULL, aprobado_en = NULL WHERE id = ? AND estado != 'finalizada'
  `).run(postId);
}

// Redefine finalizarPostMural para sumar hasta 5 fotos de cierre
// (evidencia de que la tarea quedo terminada).
function finalizarPostMural(postId, fotos) {
  const fotosLimpias = Array.isArray(fotos)
    ? fotos.filter((f) => typeof f === "string" && f.startsWith("data:image/")).slice(0, 5)
    : [];
  db.prepare(`
    UPDATE mural_posts SET estado = 'finalizada', finalizada_en = ?, fotos_cierre = ? WHERE id = ?
  `).run(new Date().toISOString(), fotosLimpias.length ? JSON.stringify(fotosLimpias) : null, postId);
}

module.exports.asignarPostMural = asignarPostMural;
module.exports.desasignarPostMural = desasignarPostMural;
module.exports.crearComentarioMural = crearComentarioMural;

// ── Historial de notificaciones -- registro persistente de cada push que
// se manda (independiente de si el push en si tuvo exito o de si el
// destinatario tiene la suscripcion activada), para poder mostrar un
// historial + contador de no leidas en la campanita del header. ──
db.exec(`
  CREATE TABLE IF NOT EXISTS notificaciones_app (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado_app_id INTEGER NOT NULL,
    titulo TEXT NOT NULL,
    cuerpo TEXT,
    url TEXT,
    leida INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notificaciones_panel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    cuerpo TEXT,
    url TEXT,
    leida INTEGER NOT NULL DEFAULT 0,
    creado_en TEXT NOT NULL
  );
`);

function registrarNotificacionApp(empleadoAppId, { titulo, cuerpo, url }) {
  db.prepare(`
    INSERT INTO notificaciones_app (empleado_app_id, titulo, cuerpo, url, leida, creado_en) VALUES (?, ?, ?, ?, 0, ?)
  `).run(empleadoAppId, titulo, cuerpo || null, url || null, new Date().toISOString());
}

function listarNotificacionesApp(empleadoAppId, limite = 50) {
  return db.prepare(`SELECT * FROM notificaciones_app WHERE empleado_app_id = ? ORDER BY id DESC LIMIT ?`).all(empleadoAppId, limite);
}

function contarNotificacionesNoLeidasApp(empleadoAppId) {
  return db.prepare(`SELECT COUNT(*) as n FROM notificaciones_app WHERE empleado_app_id = ? AND leida = 0`).get(empleadoAppId).n;
}

function marcarNotificacionesLeidasApp(empleadoAppId) {
  db.prepare(`UPDATE notificaciones_app SET leida = 1 WHERE empleado_app_id = ? AND leida = 0`).run(empleadoAppId);
}

// El panel tiene login compartido entre admins (las suscripciones push no
// distinguen quien es quien) -- el historial es igual de compartido, a
// proposito, mismo criterio que enviarPushATodoElPanel.
function registrarNotificacionPanel({ titulo, cuerpo, url }) {
  db.prepare(`
    INSERT INTO notificaciones_panel (titulo, cuerpo, url, leida, creado_en) VALUES (?, ?, ?, 0, ?)
  `).run(titulo, cuerpo || null, url || null, new Date().toISOString());
}

function listarNotificacionesPanel(limite = 50) {
  return db.prepare(`SELECT * FROM notificaciones_panel ORDER BY id DESC LIMIT ?`).all(limite);
}

function contarNotificacionesNoLeidasPanel() {
  return db.prepare(`SELECT COUNT(*) as n FROM notificaciones_panel WHERE leida = 0`).get().n;
}

function marcarNotificacionesLeidasPanel() {
  db.prepare(`UPDATE notificaciones_panel SET leida = 1 WHERE leida = 0`).run();
}

module.exports.registrarNotificacionApp = registrarNotificacionApp;
module.exports.listarNotificacionesApp = listarNotificacionesApp;
module.exports.contarNotificacionesNoLeidasApp = contarNotificacionesNoLeidasApp;
module.exports.marcarNotificacionesLeidasApp = marcarNotificacionesLeidasApp;
module.exports.registrarNotificacionPanel = registrarNotificacionPanel;
module.exports.listarNotificacionesPanel = listarNotificacionesPanel;
module.exports.contarNotificacionesNoLeidasPanel = contarNotificacionesNoLeidasPanel;
module.exports.marcarNotificacionesLeidasPanel = marcarNotificacionesLeidasPanel;

// ── Perfil del empleado (foto + usuario) -- misma idea que el perfil de
// admin, pero sin "apellido" (empleados.nombre ya es el nombre completo,
// ej. "Diego Lastra" -- separarlo en dos campos solo crearia un segundo
// apellido suelto que no se usa en ningun lado) y sin poder tocar
// "nombre": es la clave que une empleados.nombre con filas_diarias.empleado
// y los diccionarios de turnos/sectores de motorCalculo.js, cambiarlo
// desde el perfil rompería el enlace con su propio historial de fichadas.
const columnasEmpleadosPerfil = db.prepare("PRAGMA table_info(empleados)").all();
if (!columnasEmpleadosPerfil.some((c) => c.name === "foto")) {
  db.exec("ALTER TABLE empleados ADD COLUMN foto TEXT");
}

// foto: COALESCE con la que ya habia -- si no se manda una nueva, no se
// borra la que ya tenia (mismo criterio que actualizarPerfilAdminPorId).
function actualizarPerfilEmpleadoApp(id, { usuario, foto }) {
  db.prepare(`
    UPDATE empleados SET usuario = ?, foto = COALESCE(?, foto) WHERE id = ?
  `).run(usuario, foto || null, id);
}

module.exports.actualizarPerfilEmpleadoApp = actualizarPerfilEmpleadoApp;

// ── Pedidos de licencia hechos por el empleado desde la app (a diferencia
// de "licencias", que el admin carga directo y ya queda aplicada, esto pasa
// primero por aprobacion -- mismo circuito que solicitudes_correccion). Al
// aprobarse, el panel llama a crearLicencia con estos mismos datos. ──
db.exec(`
  CREATE TABLE IF NOT EXISTS solicitudes_licencia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    numero_whatsapp TEXT,
    fecha_desde TEXT NOT NULL,
    fecha_hasta TEXT NOT NULL,
    tipo TEXT NOT NULL,
    mensaje TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    motivo_rechazo TEXT,
    creado_en TEXT NOT NULL,
    resuelto_en TEXT
  );
`);

// Compartido entre el panel (que la carga directo) y la app (que la pide) --
// una sola lista para que no se desincronicen.
const TIPOS_LICENCIA = ["Vacaciones", "Licencia médica", "Estudio", "Otro"];

function crearSolicitudLicencia({ empleado, numeroWhatsapp, fechaDesde, fechaHasta, tipo, mensaje }) {
  const info = db.prepare(`
    INSERT INTO solicitudes_licencia (empleado, numero_whatsapp, fecha_desde, fecha_hasta, tipo, mensaje, estado, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?)
  `).run(empleado, numeroWhatsapp || null, fechaDesde, fechaHasta, tipo, mensaje || "", new Date().toISOString());
  return info.lastInsertRowid;
}

function obtenerSolicitudLicencia(id) {
  return db.prepare("SELECT * FROM solicitudes_licencia WHERE id = ?").get(id);
}

function resolverSolicitudLicencia(id, estado, motivoRechazo) {
  db.prepare(`
    UPDATE solicitudes_licencia SET estado = ?, motivo_rechazo = ?, resuelto_en = ? WHERE id = ?
  `).run(estado, motivoRechazo || null, new Date().toISOString(), id);
}

function solicitudesLicenciaPendientes() {
  return db.prepare(`SELECT * FROM solicitudes_licencia WHERE estado = 'pendiente' ORDER BY id ASC`).all();
}

function todasLasSolicitudesLicencia(limite = 200) {
  return db.prepare(`SELECT * FROM solicitudes_licencia ORDER BY id DESC LIMIT ?`).all(limite);
}

function solicitudesLicenciaDeEmpleado(empleado, limite = 10) {
  return db.prepare(`SELECT * FROM solicitudes_licencia WHERE empleado = ? ORDER BY id DESC LIMIT ?`).all(empleado, limite);
}

module.exports.TIPOS_LICENCIA = TIPOS_LICENCIA;
module.exports.crearSolicitudLicencia = crearSolicitudLicencia;
module.exports.obtenerSolicitudLicencia = obtenerSolicitudLicencia;
module.exports.resolverSolicitudLicencia = resolverSolicitudLicencia;
module.exports.solicitudesLicenciaPendientes = solicitudesLicenciaPendientes;
module.exports.todasLasSolicitudesLicencia = todasLasSolicitudesLicencia;
module.exports.solicitudesLicenciaDeEmpleado = solicitudesLicenciaDeEmpleado;

// ── Recorrido diario (mantenimiento, con QR por punto) -- registra el
// intento real del empleado: hora de inicio/fin y, por cada punto
// confirmado, que items del checklist tildo, la observacion que escribio y
// hasta 3 fotos. puntos_json es un array que se va completando punto por
// punto (ver agregarPuntoRecorrido) en vez de mandarse entero al final, asi
// no se pierde nada si el celular se queda sin batería a mitad de recorrido. ──
db.exec(`
  CREATE TABLE IF NOT EXISTS recorridos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empleado TEXT NOT NULL,
    fecha TEXT NOT NULL,
    iniciado_en TEXT NOT NULL,
    finalizado_en TEXT,
    duracion_seg INTEGER,
    puntos_json TEXT NOT NULL DEFAULT '[]'
  );
`);

// Definicion de los puntos de control -- PLACEHOLDER: solo el primero tiene
// nombre/checklist reales (el que dio el admin de ejemplo). Cuando pase la
// lista completa de los 15 puntos, esto es lo unico que hay que completar.
const PUNTOS_RECORRIDO = [
  { nombre: "SALA DE MAQUINAS -1", checklist: ["Tablero eléctrico encendido", "Sin pérdidas de agua", "Bomba presurizadora sin ruido", "Puerta cerrada al salir"] },
  { nombre: "Punto 2 (a definir)", checklist: [] },
  { nombre: "Punto 3 (a definir)", checklist: [] },
  { nombre: "Punto 4 (a definir)", checklist: [] },
  { nombre: "Punto 5 (a definir)", checklist: [] },
  { nombre: "Punto 6 (a definir)", checklist: [] },
  { nombre: "Punto 7 (a definir)", checklist: [] },
  { nombre: "Punto 8 (a definir)", checklist: [] },
  { nombre: "Punto 9 (a definir)", checklist: [] },
  { nombre: "Punto 10 (a definir)", checklist: [] },
  { nombre: "Punto 11 (a definir)", checklist: [] },
  { nombre: "Punto 12 (a definir)", checklist: [] },
  { nombre: "Punto 13 (a definir)", checklist: [] },
  { nombre: "Punto 14 (a definir)", checklist: [] },
  { nombre: "Punto 15 (a definir)", checklist: [] },
];

function fechaISOHoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Si ya hay un recorrido de hoy sin terminar, lo retoma en vez de crear uno
// nuevo -- si el empleado cierra la app a mitad de camino y vuelve a entrar
// a "Recorrido diario", sigue donde lo dejo en vez de perder los puntos ya
// confirmados.
function recorridoDeHoyEnCurso(empleado) {
  return db.prepare(`
    SELECT * FROM recorridos WHERE empleado = ? AND fecha = ? AND finalizado_en IS NULL ORDER BY id DESC LIMIT 1
  `).get(empleado, fechaISOHoy());
}

// Ultimo recorrido de hoy (terminado o no) -- para la tarjeta de Inicio,
// que necesita saber si mostrar "sin empezar", "en curso" o "completado".
function recorridoDeHoy(empleado) {
  return db.prepare(`
    SELECT * FROM recorridos WHERE empleado = ? AND fecha = ? ORDER BY id DESC LIMIT 1
  `).get(empleado, fechaISOHoy());
}

function crearRecorrido(empleado) {
  const info = db.prepare(`
    INSERT INTO recorridos (empleado, fecha, iniciado_en, puntos_json) VALUES (?, ?, ?, '[]')
  `).run(empleado, fechaISOHoy(), new Date().toISOString());
  return info.lastInsertRowid;
}

function recorridoPorId(id) {
  return db.prepare("SELECT * FROM recorridos WHERE id = ?").get(id);
}

// Agrega la confirmacion de un punto -- checklist como array de {item, ok},
// fotos limitado a 3 (mismo criterio de fotos_cierre del Mural).
function agregarPuntoRecorrido(id, { nombre, checklist, observaciones, fotos }) {
  const recorrido = recorridoPorId(id);
  if (!recorrido) return null;
  const fotosLimpias = Array.isArray(fotos)
    ? fotos.filter((f) => typeof f === "string" && f.startsWith("data:image/")).slice(0, 3)
    : [];
  const puntos = JSON.parse(recorrido.puntos_json || "[]");
  puntos.push({
    nombre,
    checklist: Array.isArray(checklist) ? checklist.slice(0, 20) : [],
    observaciones: observaciones ? String(observaciones).trim().slice(0, 500) : "",
    fotos: fotosLimpias,
    confirmadoEn: new Date().toISOString(),
  });
  db.prepare("UPDATE recorridos SET puntos_json = ? WHERE id = ?").run(JSON.stringify(puntos), id);
  return puntos.length;
}

function finalizarRecorrido(id, duracionSeg) {
  db.prepare(`
    UPDATE recorridos SET finalizado_en = ?, duracion_seg = ? WHERE id = ?
  `).run(new Date().toISOString(), Math.max(0, Math.round(duracionSeg || 0)), id);
}

module.exports.PUNTOS_RECORRIDO = PUNTOS_RECORRIDO;
module.exports.recorridoDeHoyEnCurso = recorridoDeHoyEnCurso;
module.exports.recorridoDeHoy = recorridoDeHoy;
module.exports.crearRecorrido = crearRecorrido;
module.exports.recorridoPorId = recorridoPorId;
module.exports.agregarPuntoRecorrido = agregarPuntoRecorrido;
module.exports.finalizarRecorrido = finalizarRecorrido;
