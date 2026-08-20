// Turnos de conserjeria: a diferencia de mantenimiento (turnosMantenimiento.js),
// ACA no hay rotacion -- cada persona tiene siempre el mismo turno fijo
// semana a semana, con un solo dia franco fijo. Lisa Rios queda afuera de
// esta formula a proposito: cubre fines de semana sin un patron fijo
// conocido, asi que su presencia esos dias se va a mostrar mas adelante a
// partir del estado real de HikCentral (ver README), no de una formula.
// Aaron Garcen tambien queda afuera por ahora (dia franco desconocido).

const HORARIO_MAÑANA = { in: "07:00", out: "15:00" };
const HORARIO_TARDE = { in: "14:00", out: "22:00" };

// francoSemanal usa el mismo indice que Date.getDay(): 0=domingo .. 6=sabado.
// El horario de sabado real de cada uno tiene menos horas que el de lunes a
// viernes (ver TURNOS_FIJOS_CONSERJERIA en motorCalculo.js para el calculo
// de horas exacto) -- ACA solo importa si trabaja ese dia o no, para mostrar
// "quien esta hoy", no el conteo de horas.
const EQUIPO = {
  "Martin Torres":          { turno: "mañana", horario: HORARIO_MAÑANA, francoSemanal: 0 },
  "Veronica Montenegro":    { turno: "mañana", horario: HORARIO_MAÑANA, francoSemanal: 0 },
  "Maria Benitez Morinigo": { turno: "tarde",  horario: HORARIO_TARDE,  francoSemanal: 0 },
  "Yesica Alcaraz":         { turno: "tarde",  horario: HORARIO_TARDE,  francoSemanal: 0 },
  "Sebastian Galeano":      { turno: "tarde",  horario: HORARIO_TARDE,  francoSemanal: 6 },
};

function esDelEquipo(empleado) {
  return Object.prototype.hasOwnProperty.call(EQUIPO, empleado);
}

// Devuelve el turno de un empleado de conserjeria en una fecha:
// { tipo: "mañana"|"tarde"|"franco", horario: {in,out}|null }
function turnoDelDia(empleado, fecha) {
  const datos = EQUIPO[empleado];
  if (!datos) return null;
  if (fecha.getDay() === datos.francoSemanal) return { tipo: "franco", horario: null };
  return { tipo: datos.turno, horario: datos.horario };
}

module.exports = { turnoDelDia, esDelEquipo, EQUIPO };
