// Rotación del personal de mantenimiento (Diego Lastra, Victor Cartaman,
// Alberto Reynoso, Angel Cabrera). Todo se calcula a partir de dos fechas
// ancla reales fijas -- nunca depende de que lote de datos se este
// procesando, asi no se puede desincronizar entre corridas.
//
// Ancla semanal: lunes 01/06/2026, grupo A (Diego y Victor) = mañana.
// Cada semana el grupo que hace mañana y el que hace tarde se invierten.
//
// Ancla de fin de semana: sabado 06/06/2026, a Angel Cabrera le toca el
// primer franco completo del ciclo. El ciclo tiene 4 fines de semana:
// cada persona pasa por sabado 8-12hs -> sabado 9-17hs -> domingo 9-17hs
// -> franco completo (sabado y domingo), y vuelve a empezar. Quien tiene
// el franco completo avanza en el orden Angel -> Alberto -> Victor -> Diego.

const ANCLA_SEMANA = new Date(2026, 5, 1); // lunes 01/06/2026
const ANCLA_FINDE = new Date(2026, 5, 6); // sabado 06/06/2026

const GRUPO_A = ["Diego Lastra", "Victor Cartaman"];
const GRUPO_B = ["Alberto Reynoso", "Angel Cabrera"];
const ORDEN_FRANCOS = ["Angel Cabrera", "Alberto Reynoso", "Victor Cartaman", "Diego Lastra"];

const HORARIO_MAÑANA = { in: "06:00", out: "14:00" };
const HORARIO_TARDE = { in: "13:00", out: "21:00" };
const HORARIO_SAB_CORTO = { in: "08:00", out: "12:00" };
const HORARIO_SAB_LARGO = { in: "09:00", out: "17:00" };
const HORARIO_DOM = { in: "09:00", out: "17:00" };

function diffDias(a, b) {
  const aMedianoche = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bMedianoche = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bMedianoche - aMedianoche) / 86400000);
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function esDelEquipo(empleado) {
  return GRUPO_A.includes(empleado) || GRUPO_B.includes(empleado);
}

// Semana (lunes 00:00) a la que pertenece una fecha cualquiera.
function lunesDeLaSemana(fecha) {
  const d = new Date(fecha);
  const dow = d.getDay(); // 0=domingo..6=sabado
  const offset = dow === 0 ? -6 : 1 - dow; // retrocede hasta el lunes
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Sabado de la semana a la que pertenece una fecha (para ubicar el finde).
function sabadoDeLaSemana(fecha) {
  const lunes = lunesDeLaSemana(fecha);
  const sab = new Date(lunes);
  sab.setDate(sab.getDate() + 5);
  return sab;
}

function grupoDeLunesAViernes(fecha) {
  const lunes = lunesDeLaSemana(fecha);
  const semIdx = Math.floor(diffDias(new Date(ANCLA_SEMANA), new Date(lunes)) / 7);
  const esPar = mod(semIdx, 2) === 0;
  return { mañana: esPar ? GRUPO_A : GRUPO_B, tarde: esPar ? GRUPO_B : GRUPO_A };
}

function rolesDelFinde(fecha) {
  const sabado = sabadoDeLaSemana(fecha);
  const findeIdx = Math.floor(diffDias(new Date(ANCLA_FINDE), new Date(sabado)) / 7);
  const francoIdx = mod(findeIdx, 4);
  const rol = (r) => ORDEN_FRANCOS[mod(francoIdx - 1 - r, 4)];
  return {
    franco: ORDEN_FRANCOS[francoIdx],
    sabado_8_12: rol(0),
    sabado_9_17: rol(1),
    domingo_9_17: rol(2),
  };
}

// Devuelve el turno de un empleado del equipo de mantenimiento en una fecha:
// { tipo: "mañana"|"tarde"|"sabado_corto"|"sabado_largo"|"domingo"|"franco", horario: {in,out}|null }
function turnoDelDia(empleado, fecha) {
  if (!esDelEquipo(empleado)) return null;
  const dow = fecha.getDay(); // 0=domingo..6=sabado

  if (dow >= 1 && dow <= 5) {
    const { mañana, tarde } = grupoDeLunesAViernes(fecha);
    if (mañana.includes(empleado)) return { tipo: "mañana", horario: HORARIO_MAÑANA };
    return { tipo: "tarde", horario: HORARIO_TARDE };
  }

  const roles = rolesDelFinde(fecha);
  if (dow === 6) {
    if (roles.franco === empleado) return { tipo: "franco", horario: null };
    if (roles.sabado_8_12 === empleado) return { tipo: "sabado_corto", horario: HORARIO_SAB_CORTO };
    if (roles.sabado_9_17 === empleado) return { tipo: "sabado_largo", horario: HORARIO_SAB_LARGO };
    // unico que queda es quien trabaja el domingo: libre el sabado nomas,
    // no es su franco completo (ese es un descanso de un solo dia).
    return { tipo: "descanso", horario: null };
  }
  // domingo
  if (roles.domingo_9_17 === empleado) return { tipo: "domingo", horario: HORARIO_DOM };
  if (roles.franco === empleado) return { tipo: "franco", horario: null };
  // trabajo el sabado (corto o largo): domingo libre, descanso de un solo dia.
  return { tipo: "descanso", horario: null };
}

// Igual que turnoDelDia, pero primero chequea si hay un cambio de turno
// aprobado para ese dia puntual (tabla excepciones_turno) — la formula de
// base nunca se toca, esto solo la tapa para ese empleado+fecha especifico.
function turnoRealDelDia(empleado, fecha) {
  if (!esDelEquipo(empleado)) return null;
  const { obtenerExcepcionTurno } = require("./db");
  const iso = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(fecha.getDate()).padStart(2, "0")}`;
  const excepcion = obtenerExcepcionTurno(empleado, iso);
  if (excepcion) return excepcion;
  return turnoDelDia(empleado, fecha);
}

module.exports = { turnoDelDia, turnoRealDelDia, esDelEquipo, GRUPO_A, GRUPO_B, ORDEN_FRANCOS };
