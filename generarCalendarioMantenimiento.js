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
