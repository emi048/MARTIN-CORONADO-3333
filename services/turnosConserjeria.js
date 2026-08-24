// Turnos de conserjeria: a diferencia de mantenimiento (turnosMantenimiento.js),
// ACA no hay rotacion -- cada persona tiene siempre el mismo turno fijo
// semana a semana, con un solo dia franco fijo. Aaron Garcen queda afuera
// por ahora (dia franco desconocido).

const HORARIO_MAÑANA = { in: "07:00", out: "15:00" };
const HORARIO_TARDE = { in: "14:00", out: "22:00" };
const HORARIO_SAB_VERONICA = { in: "09:00", out: "13:00" };
const HORARIO_SAB_LISA = { in: "13:00", out: "22:00" };

// francoSemanal usa el mismo indice que Date.getDay(): 0=domingo .. 6=sabado.
// horarioSabado (opcional): cuando el sabado tiene un horario propio,
// distinto al de lunes a viernes -- si no esta definido, el sabado se
// calcula con el horario normal (turno/horario de mas arriba). El calculo
// de horas exacto sigue viviendo en TURNOS_FIJOS_CONSERJERIA (motorCalculo.js);
// ACA solo importa el horario esperado, para mostrar "quien esta hoy" y
// para detectar ausencias/llegadas tarde en el panel.
const EQUIPO = {
  "Martin Torres":          { turno: "mañana", horario: HORARIO_MAÑANA, francoSemanal: 0 },
  "Veronica Montenegro":    { turno: "mañana", horario: HORARIO_MAÑANA, francoSemanal: 0, horarioSabado: HORARIO_SAB_VERONICA },
  "Maria Benitez Morinigo": { turno: "tarde",  horario: HORARIO_TARDE,  francoSemanal: 0 },
  "Yesica Alcaraz":         { turno: "tarde",  horario: HORARIO_TARDE,  francoSemanal: 0 },
  "Sebastian Galeano":      { turno: "tarde",  horario: HORARIO_TARDE,  francoSemanal: 6 },
  "Lisa Rios":              { turno: "mañana", horario: HORARIO_MAÑANA, francoSemanal: 0, horarioSabado: HORARIO_SAB_LISA },
};

function esDelEquipo(empleado) {
  return Object.prototype.hasOwnProperty.call(EQUIPO, empleado);
}

// Devuelve el turno de un empleado de conserjeria en una fecha:
// { tipo: "mañana"|"tarde"|"franco"|"sabado", horario: {in,out}|null }
function turnoDelDia(empleado, fecha) {
  const datos = EQUIPO[empleado];
  if (!datos) return null;
  if (fecha.getDay() === datos.francoSemanal) return { tipo: "franco", horario: null };
  if (fecha.getDay() === 6 && datos.horarioSabado) return { tipo: "sabado", horario: datos.horarioSabado };
  return { tipo: datos.turno, horario: datos.horario };
}

module.exports = { turnoDelDia, esDelEquipo, EQUIPO };
