require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { turnoDelDia, GRUPO_A, GRUPO_B } = require("./lib/turnosMantenimiento");
const { FERIADOS } = require("./lib/motorCalculo");

const NOMBRE_CALENDARIO = "Turnos Mantenimiento — Martín Coronado 3333";
const TIMEZONE = process.env.TIMEZONE || "America/Argentina/Buenos_Aires";

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, "config", "gmail_token.json"), "utf8"));
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

async function getOrCrearCalendario(calendar) {
  const lista = await calendar.calendarList.list();
  const existente = lista.data.items.find((c) => c.summary === NOMBRE_CALENDARIO);
  if (existente) return existente.id;
  const creado = await calendar.calendars.insert({ requestBody: { summary: NOMBRE_CALENDARIO, timeZone: TIMEZONE } });
  return creado.data.id;
}

function fechaISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function tituloYColor(empleado, turno, esFeriado) {
  const nombreCorto = empleado.split(" ")[0];
  const feriadoTag = esFeriado ? " 🔴 FERIADO" : "";
  switch (turno.tipo) {
    case "mañana": return { titulo: `${nombreCorto} — Mañana${feriadoTag}`, colorId: "9" };
    case "tarde": return { titulo: `${nombreCorto} — Tarde${feriadoTag}`, colorId: "7" };
    case "sabado_corto": return { titulo: `${nombreCorto} — Sáb 8-12hs${feriadoTag}`, colorId: "5" };
    case "sabado_largo": return { titulo: `${nombreCorto} — Sáb 9-17hs${feriadoTag}`, colorId: "5" };
    case "domingo": return { titulo: `${nombreCorto} — Dom 9-17hs${feriadoTag}`, colorId: "6" };
    case "franco": return { titulo: `${nombreCorto} — FRANCO`, colorId: "11" };
    case "descanso": return { titulo: `${nombreCorto} — descanso`, colorId: "8" };
    default: return { titulo: `${nombreCorto} — ${turno.tipo}`, colorId: "1" };
  }
}

async function generarMes(anio, mesIndex0) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = await getOrCrearCalendario(calendar);

  const empleados = [...GRUPO_A, ...GRUPO_B];
  const dias = new Date(anio, mesIndex0 + 1, 0).getDate();

  let creados = 0;
  for (let d = 1; d <= dias; d++) {
    const fecha = new Date(anio, mesIndex0, d);
    const iso = fechaISO(fecha);
    const esFeriado = FERIADOS.has(iso);

    for (const empleado of empleados) {
      const turno = turnoDelDia(empleado, fecha);
      if (!turno) continue;
      const { titulo, colorId } = tituloYColor(empleado, turno, esFeriado);

      const evento = { summary: titulo, colorId };
      if (turno.horario) {
        evento.start = { dateTime: `${iso}T${turno.horario.in}:00`, timeZone: TIMEZONE };
        evento.end = { dateTime: `${iso}T${turno.horario.out}:00`, timeZone: TIMEZONE };
      } else {
        evento.start = { date: iso };
        evento.end = { date: iso };
      }

      await calendar.events.insert({ calendarId, requestBody: evento });
      creados++;
    }
  }
  return { calendarId, creados };
}

// Busca el evento de un empleado en una fecha puntual y lo actualiza (o lo
// crea si no existia, ej. porque el mes todavia no se habia generado) para
// que refleje un cambio de turno recien aprobado. Usa un rango de +-1 dia
// para el filtro de la API y despues compara la fecha exacta en el cliente,
// asi no hay que pelear con el offset de zona horaria en la consulta.
async function actualizarEventoDia(empleado, fechaISO, nuevoTurno, esFeriado = false) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = await getOrCrearCalendario(calendar);
  const nombreCorto = empleado.split(" ")[0];

  const [y, m, d] = fechaISO.split("-").map(Number);
  const desde = new Date(y, m - 1, d - 1).toISOString();
  const hasta = new Date(y, m - 1, d + 2).toISOString();

  const lista = await calendar.events.list({ calendarId, timeMin: desde, timeMax: hasta, singleEvents: true });
  const existente = (lista.data.items || []).find((ev) => {
    const evFecha = ev.start.date || (ev.start.dateTime || "").slice(0, 10);
    return evFecha === fechaISO && (ev.summary || "").startsWith(nombreCorto);
  });

  const { titulo, colorId } = tituloYColor(empleado, nuevoTurno, esFeriado);
  const evento = { summary: titulo, colorId };
  // Al pasar de un evento con horario a uno de dia completo (o viceversa),
  // hay que limpiar explicitamente el campo que no corresponde -- un patch
  // parcial que deja restos del tipo anterior tira "Invalid start time".
  if (nuevoTurno.horario) {
    evento.start = { dateTime: `${fechaISO}T${nuevoTurno.horario.in}:00`, timeZone: TIMEZONE, date: null };
    evento.end = { dateTime: `${fechaISO}T${nuevoTurno.horario.out}:00`, timeZone: TIMEZONE, date: null };
  } else {
    evento.start = { date: fechaISO, dateTime: null, timeZone: null };
    evento.end = { date: fechaISO, dateTime: null, timeZone: null };
  }

  if (existente) {
    await calendar.events.patch({ calendarId, eventId: existente.id, requestBody: evento });
  } else {
    await calendar.events.insert({ calendarId, requestBody: evento });
  }
}

module.exports = { generarMes, actualizarEventoDia };

// Uso manual: node generarCalendarioMantenimiento.js 2026 8
if (require.main === module) {
  const [, , anioArg, mesArg] = process.argv;
  const anio = Number(anioArg);
  const mesIndex0 = Number(mesArg) - 1;

  generarMes(anio, mesIndex0)
    .then(({ calendarId, creados }) => {
      console.log(`Listo. Calendario: ${calendarId}`);
      console.log(`Eventos creados: ${creados}`);
    })
    .catch((err) => {
      console.error("ERROR:", err.message);
      process.exit(1);
    });
}
