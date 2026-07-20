const fs = require("fs");
const path = require("path");
const express = require("express");
const { MessagingResponse } = require("twilio").twiml;
const {
  empleadoPorNumero, ultimoResumen,
  filaDelDia, filaDelDiaPorFecha, filasDelPeriodoDeEmpleado, actualizarFilaDiaria, filasDelPeriodo, resumenDelPeriodo, recalcularResumenEmpleado,
  crearSolicitud, obtenerSolicitud, resolverSolicitud, solicitudesPendientes, solicitudesDeEmpleado,
  obtenerConversacion, guardarConversacion, limpiarConversacion,
  obtenerFichadaHoy, registrarNumero,
} = require("./db");
const { calcularHoras, getSectorDeEmpleado, normalizarNombre, FERIADOS, TURNOS_FIJOS_CONSERJERIA, esDiaDeEvento } = require("./motorCalculo");
const { generarExcel } = require("./generarExcel");
const { enviarFichero } = require("./mailer");
const { enviarWhatsapp, enviarDocumentoWhatsapp } = require("./twilioClient");
const { respuestaFueraDeMenu, chatConOlivia } = require("./asistente");

const router = express.Router();

const MENU_TEXT =
  "¡Hola! Soy el asistente de fichaje. ¿Qué necesitás?\n\n" +
  "1️⃣ Consultar mis horas\n" +
  "2️⃣ Solicitar corrección de fichaje\n" +
  "3️⃣ ¿Fiché hoy?\n" +
  "4️⃣ Mis solicitudes\n\n" +
  'Respondé con el número de la opción (o escribí "menu" en cualquier momento para volver acá).';

// Mensaje para cualquier numero que no sea un empleado registrado (ni Oli):
// se les muestra el menu para no delatar nada, pero al elegir una opcion se
// les corta ahi, nunca llegan a ver datos de nadie.
const MENSAJE_NO_REGISTRADO =
  "🚫 No estás en el registro de empleados de Martín Coronado 3333. " +
  "Contactate con el administrador si creés que es un error.";

// Twilio manda el número como "whatsapp:+549...". Normalizamos a "+549...".
function limpiarNumero(from) {
  return (from || "").replace("whatsapp:", "").trim();
}

// El año es opcional — si no lo mandan, asumimos el año actual (asi se
// puede escribir "26/6" en vez de forzar "26/06/2026" cada vez).
function parsearFecha(texto) {
  const m = texto.trim().match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  const y = m[3] ? Number(m[3]) : new Date().getFullYear();
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const fecha = new Date(y, mo - 1, d);
  if (fecha.getFullYear() !== y || fecha.getMonth() !== mo - 1 || fecha.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parsearHora(texto) {
  const m = texto.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// Para cuando se corrige entrada y salida juntas: las dos horas en un solo
// mensaje, separadas por espacio o coma (ej: "08:00 17:00").
function parsearDosHoras(texto) {
  const partes = texto.trim().split(/[\s,]+/).filter(Boolean);
  if (partes.length !== 2) return null;
  const ingreso = parsearHora(partes[0]);
  const egreso = parsearHora(partes[1]);
  if (!ingreso || !egreso) return null;
  return { ingreso, egreso };
}

// Acepta tres formatos para cargar uno o varios dias de una sola vez:
//  - Un dia:      "15/07/2026"
//  - Un rango:    "10/07/2026 al 14/07/2026" (tambien sirve "... - ...")
//  - Dias sueltos: "26/06/2026, 29/06/2026, 07/07/2026"
// Tope de 31 fechas para evitar un typo cargando algo gigante por error.
function parsearFechas(texto) {
  const t = texto.trim();

  const unica = parsearFecha(t);
  if (unica) return [unica];

  if (t.includes(",")) {
    const partes = t.split(",").map((p) => p.trim()).filter(Boolean);
    if (partes.length === 0 || partes.length > 31) return null;
    const fechas = partes.map(parsearFecha);
    if (fechas.some((f) => !f)) return null;
    return fechas;
  }

  const m = t.match(/^(.+?)\s+(?:al|a|-)\s+(.+)$/i);
  if (!m) return null;
  const desde = parsearFecha(m[1]);
  const hasta = parsearFecha(m[2]);
  if (!desde || !hasta) return null;

  const dDesde = new Date(desde + "T00:00:00");
  const dHasta = new Date(hasta + "T00:00:00");
  if (dHasta < dDesde) return null;
  const dias = Math.round((dHasta - dDesde) / 86400000) + 1;
  if (dias > 31) return null;

  const fechas = [];
  for (let i = 0; i < dias; i++) {
    const d = new Date(dDesde);
    d.setDate(d.getDate() + i);
    fechas.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return fechas;
}

function hoyISO() {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
}

// "2026-06-21" -> "21/6" (sin año — el periodo de pago no coincide con el
// mes calendario, asi que mostramos el rango real de dias que se estan
// contando en vez de la etiqueta interna del periodo, ej "2026-07").
function formatoDiaMes(fechaISO) {
  const [, m, d] = fechaISO.split("-").map(Number);
  return `${d}/${m}`;
}

// Una linea por dia, misma forma siempre (entrada - salida) para que sea
// facil de escanear de arriba a abajo — si falta un dato dice "sin dato" en
// su lugar en vez de cambiar toda la frase. "REVISAR MANUALMENTE" (mas de 2
// fichajes ese dia) NO es un caso especial aca: las horas ya estan bien
// calculadas (primer y ultimo fichaje), asi que se muestran igual que
// cualquier otro dia — esconderlas detras de un cartel no ayudaba a nadie,
// solo el excel del admin sigue marcando esos dias aparte para que los
// pueda revisar si quiere.
function lineaDia(fila) {
  const fechaDisplay = formatoDiaMes(fila.fecha);

  const ingresoOk = fila.ingreso && parsearHora(fila.ingreso);
  const egresoOk = fila.egreso && parsearHora(fila.egreso);
  const ingresoTxt = ingresoOk ? fila.ingreso : "sin dato";
  const egresoTxt = egresoOk ? fila.egreso : "sin dato";

  if (!ingresoOk || !egresoOk) {
    return `° ${fechaDisplay} ${ingresoTxt} - ${egresoTxt}`;
  }

  const extras = [];
  if (fila.h50 > 0) extras.push(`${fila.h50}hs 50%`);
  if (fila.h100 > 0) extras.push(`${fila.h100}hs 100%`);
  const extraTexto = extras.length > 0 ? ` - ${extras.join(" - ")}` : "";

  return `° ${fechaDisplay} ${ingresoTxt} - ${egresoTxt} (${fila.total_hs}hs${extraTexto})`;
}

function mensajeHoras(empleado) {
  const resumen = ultimoResumen(empleado);
  if (!resumen) return `Hola ${empleado.split(" ")[0]}, todavía no hay datos procesados para vos.`;

  const filas = filasDelPeriodoDeEmpleado(empleado, resumen.periodo);
  const desde = filas.length > 0 ? filas[0].fecha : null; // ya viene ordenado por fecha
  const rangoPeriodo = desde ? `${formatoDiaMes(desde)} a ${formatoDiaMes(hoyISO())}` : resumen.periodo;

  const detalle = filas.map(lineaDia).join("\n");
  const hayFaltantes = filas.some((f) => f.alerta && !f.alerta.includes("REVISAR MANUALMENTE"));

  let notas = "";
  if (hayFaltantes) notas += "\n\"sin dato\": falta ese horario. Pedí la corrección con la opción 2 si corresponde.";

  return (
    `Hola ${empleado.split(" ")[0]}\n` +
    `Período: ${rangoPeriodo}\n\n` +
    detalle +
    `\n\nTotales\n` +
    `Días trabajados: *${resumen.dias}*\n` +
    `Horas totales: *${resumen.total_hs}*\n` +
    `Extra 50%: *${resumen.h50}*\n` +
    `Extra 100%: *${resumen.h100}*` +
    notas
  );
}

// Se basa en fichadas_estado, que alimenta el poller de HikCentral
// (lib/monitorFichadas.js) — sin esa conexion activa esto siempre va a
// decir "todavia no fichaste", aunque hayas fichado de verdad.
function mensajeFichadaHoy(empleado) {
  const f = obtenerFichadaHoy(empleado, hoyISO());

  if (!f || !f.ingreso_hora) {
    return "Todavía no vemos que hayas fichado la entrada hoy.";
  }
  if (!f.egreso_hora) {
    return `Hoy fichaste entrada a las ${f.ingreso_hora}. Todavía no vemos la salida.`;
  }
  return `Hoy fichaste entrada a las ${f.ingreso_hora} y salida a las ${f.egreso_hora}.`;
}

const ICONO_ESTADO = { pendiente: "🕓", aprobada: "✅", rechazada: "❌" };

function mensajeMisSolicitudes(empleado) {
  const solicitudes = solicitudesDeEmpleado(empleado, 10);
  if (solicitudes.length === 0) return "Todavía no hiciste ninguna solicitud de corrección.";

  const listado = solicitudes
    .map((s) => {
      const fechaDisplay = s.fecha.split("-").reverse().join("/");
      const partes = [];
      if (s.ingreso_propuesto) partes.push(`Entrada: ${s.ingreso_propuesto}`);
      if (s.egreso_propuesto) partes.push(`Salida: ${s.egreso_propuesto}`);
      const icono = ICONO_ESTADO[s.estado] || "•";
      return `${icono} #${s.id} — ${fechaDisplay} (${partes.join(", ")}) — ${s.estado}`;
    })
    .join("\n");

  return `📋 Tus últimas solicitudes:\n\n${listado}`;
}

// correcciones: [{ fecha, ingreso, egreso }, ...] — una entrada por dia
// (ingreso y/o egreso, lo que se haya pedido corregir ese dia puntual).
async function crearSolicitudesYNotificar(empleado, numero, correcciones, mensajeOriginal) {
  const ids = correcciones.map(({ fecha, ingreso, egreso }) => {
    // Si ya existe una fila real para esta fecha (aunque haya quedado
    // etiquetada bajo un periodo distinto por una importacion manual vieja),
    // usamos ESE periodo — asi la correccion cae sobre el dato real en vez
    // de crear una fila duplicada en un periodo que nunca existio.
    const filaExistente = filaDelDiaPorFecha(empleado, fecha);
    const periodo = filaExistente ? filaExistente.periodo : fecha.slice(0, 7);
    return crearSolicitud({
      empleado, numeroWhatsapp: numero, periodo,
      fecha, ingresoPropuesto: ingreso, egresoPropuesto: egreso, mensajeOriginal,
    });
  });

  const listado = correcciones
    .map((c, i) => {
      const fechaDisplay = c.fecha.split("-").reverse().join("/");
      const partes = [];
      if (c.ingreso) partes.push(`Entrada: ${c.ingreso}`);
      if (c.egreso) partes.push(`Salida: ${c.egreso}`);
      return `#${ids[i]} — ${fechaDisplay} ${partes.join(", ")}`;
    })
    .join("\n");

  if (process.env.ADMIN_WHATSAPP_NUMBER) {
    const comandoRapido = ids.length > 1 ? `aprobar ${ids[0]}-${ids[ids.length - 1]}` : `aprobar ${ids[0]}`;
    await enviarWhatsapp(
      process.env.ADMIN_WHATSAPP_NUMBER,
      `📋 Nueva solicitud de corrección\n` +
        `Empleado: ${empleado}\n\n` +
        `${listado}\n\n` +
        `Respondé "${comandoRapido}" para aprobar todo junto, o "aprobar N"/"rechazar N" una por una.`
    );
  }

  return ids;
}

// ── Menu paso a paso (sin IA) ─────────────────────────────────────────────
// Cada numero de WhatsApp tiene, en la base, en que paso del menu esta
// (conversaciones_whatsapp). Cada mensaje entrante avanza un paso.
// Importante: al terminar un flujo (consulta u solicitud) dejamos el estado
// en "menu" en vez de borrarlo — asi el proximo mensaje ("1"/"2") se procesa
// directo, sin tener que mandarlo dos veces.
async function procesarMensajeEmpleado(empleado, numero, textoOriginal) {
  const texto = textoOriginal.trim();
  const textoLower = texto.toLowerCase();

  if (["menu", "menú", "cancelar", "salir", "0"].includes(textoLower)) {
    guardarConversacion(numero, "menu");
    return MENU_TEXT;
  }

  const conv = obtenerConversacion(numero);
  if (!conv) {
    guardarConversacion(numero, "menu");
    return MENU_TEXT;
  }

  switch (conv.estado) {
    case "menu": {
      if (texto === "1") {
        guardarConversacion(numero, "menu");
        return mensajeHoras(empleado);
      }
      if (texto === "2") {
        guardarConversacion(numero, "correccion:tipo-fecha", {});
        return (
          "¿Cuántos días vas a corregir?\n\n" +
          "1️⃣ Un solo día\n" +
          "2️⃣ Varios días seguidos\n" +
          "3️⃣ Días salteados (no seguidos)\n" +
          "0️⃣ Salir"
        );
      }
      if (texto === "3") {
        guardarConversacion(numero, "menu");
        return mensajeFichadaHoy(empleado);
      }
      if (texto === "4") {
        guardarConversacion(numero, "menu");
        return mensajeMisSolicitudes(empleado);
      }
      // No matcheo "1"/"2"/"3"/"4" — puede ser una consulta real o una
      // boludez, respuestaFueraDeMenu distingue y responde acorde (si
      // Anthropic falla/tarda, devuelve null y caemos al mensaje generico,
      // nunca se pierde la respuesta). El recordatorio de "menu" del
      // fallback generico no va en CADA respuesta — solo la primera vez que
      // se va del menu y despues cada 3 mensajes, para no ser pesado (la
      // respuesta de la IA ya invita a volver al menu por su cuenta).
      const contador = ((conv.datos && conv.datos.mensajesSinMenu) || 0) + 1;
      const mostrarHint = contador % 3 === 1;
      guardarConversacion(numero, "menu", { mensajesSinMenu: contador });

      const conRespuesta = await respuestaFueraDeMenu(texto);
      if (conRespuesta) return conRespuesta;
      const hint = '\n\n(Escribí "menu" para volver a las opciones)';
      return mostrarHint ? "No entendí esa opción.\n\n" + MENU_TEXT : "No entendí esa opción." + hint;
    }

    case "correccion:tipo-fecha": {
      if (!["1", "2", "3"].includes(texto)) {
        return "Elegí una opción válida: 1 (Un día), 2 (Varios seguidos), 3 (Salteados) o 0 (Salir).";
      }
      guardarConversacion(numero, "correccion:fecha", {});
      const pieSalir = '\n\n(Escribí "salir" para cancelar)';
      if (texto === "1") return "Mandá la fecha en formato DD/MM (el año se asume el actual).\nEj: 15/7" + pieSalir;
      if (texto === "2") return "Mandá el rango así: DD/MM al DD/MM.\nEj: 10/7 al 14/7" + pieSalir;
      return "Mandá las fechas separadas por coma.\nEj: 26/6, 29/6, 7/7" + pieSalir;
    }

    case "correccion:fecha": {
      const fechas = parsearFechas(texto);
      if (!fechas) {
        return "Ese formato no lo pude leer. Fijate el ejemplo de arriba y probá de nuevo (o escribí \"salir\" para cancelar).";
      }
      guardarConversacion(numero, "correccion:campo", { fechas });
      const plural = fechas.length > 1 ? "esos días" : "ese día";
      return `¿Qué querés corregir de ${plural}?\n\n1️⃣ Entrada\n2️⃣ Salida\n3️⃣ Ambas\n0️⃣ Salir`;
    }

    case "correccion:campo": {
      if (!["1", "2", "3"].includes(texto)) {
        return "Elegí una opción válida: 1 (Entrada), 2 (Salida), 3 (Ambas) o 0 (Salir).";
      }
      const datos = conv.datos;
      const plural = datos.fechas.length > 1 ? "esos días" : "ese día";

      const pieSalir = '\n\n(Escribí "salir" para cancelar)';
      const multiDia = datos.fechas.length > 1;

      if (texto === "3") {
        guardarConversacion(numero, "correccion:horas-ambas", datos);
        const ejemploMulti = multiDia
          ? `\n\nSi cada día tuvo un horario distinto, mandá un renglón por día (en el mismo orden que las fechas), ej:\n08:00 17:00\n09:00 19:00`
          : "";
        return `Mandá las dos horas juntas, separadas por un espacio: entrada y salida.\nEj: 08:00 17:00 (mismo horario para ${plural})` + ejemploMulti + pieSalir;
      }

      const campo = texto === "1" ? "ingreso" : "egreso";
      guardarConversacion(numero, "correccion:hora", { ...datos, campo });
      const verbo = campo === "ingreso" ? "ingresaste" : "saliste";
      const ejemploMulti = multiDia
        ? `\n\nSi cada día fue distinto, mandá un renglón por día (en el mismo orden que las fechas), ej:\n08:00\n09:00`
        : "";
      return `¿A qué hora ${verbo} ${plural}? Formato HH:MM (ej: 08:00, mismo horario para ${plural}).` + ejemploMulti + pieSalir;
    }

    case "correccion:hora": {
      const datos = conv.datos;
      const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);

      let horasPorFecha;
      if (lineas.length === 1) {
        const hora = parsearHora(lineas[0]);
        if (!hora) return "Formato inválido. Mandá la hora como HH:MM (ej: 18:30), o escribí \"salir\" para cancelar.";
        horasPorFecha = datos.fechas.map(() => hora);
      } else if (lineas.length === datos.fechas.length) {
        horasPorFecha = lineas.map(parsearHora);
        if (horasPorFecha.some((h) => !h)) return "Algún renglón no lo pude leer. Cada uno tiene que ser una hora HH:MM.";
      } else {
        return `Mandá una sola hora (para todos los días) o ${datos.fechas.length} horas, un renglón por día en el mismo orden que las fechas.`;
      }

      const correcciones = datos.fechas.map((fecha, i) => ({
        fecha,
        ingreso: datos.campo === "ingreso" ? horasPorFecha[i] : null,
        egreso: datos.campo === "egreso" ? horasPorFecha[i] : null,
      }));
      return await finalizarSolicitud(empleado, numero, datos.fechas, correcciones, textoOriginal);
    }

    case "correccion:horas-ambas": {
      const datos = conv.datos;
      const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);

      let horasPorFecha;
      if (lineas.length === 1) {
        const horas = parsearDosHoras(lineas[0]);
        if (!horas) return "Formato inválido. Mandá las dos horas separadas por un espacio (ej: 08:00 17:00), o escribí \"salir\" para cancelar.";
        horasPorFecha = datos.fechas.map(() => horas);
      } else if (lineas.length === datos.fechas.length) {
        horasPorFecha = lineas.map(parsearDosHoras);
        if (horasPorFecha.some((h) => !h)) return "Algún renglón no lo pude leer. Cada uno tiene que ser \"HH:MM HH:MM\" (entrada y salida).";
      } else {
        return `Mandá un solo renglón (mismo horario para todos los días) o ${datos.fechas.length} renglones, uno por día en el mismo orden que las fechas.`;
      }

      const correcciones = datos.fechas.map((fecha, i) => ({
        fecha, ingreso: horasPorFecha[i].ingreso, egreso: horasPorFecha[i].egreso,
      }));
      return await finalizarSolicitud(empleado, numero, datos.fechas, correcciones, textoOriginal);
    }

    default: {
      guardarConversacion(numero, "menu");
      return MENU_TEXT;
    }
  }

  async function finalizarSolicitud(empleado, numero, fechas, correcciones, textoOriginal) {
    const ids = await crearSolicitudesYNotificar(empleado, numero, correcciones, textoOriginal);
    guardarConversacion(numero, "menu");
    const cantidadDias = fechas.length > 1 ? ` (${fechas.length} días)` : "";
    const listadoIds = ids.length > 1 ? `#${ids[0]} a #${ids[ids.length - 1]}` : `#${ids[0]}`;
    return `📋 Solicitud pendiente de confirmación${cantidadDias} (${listadoIds}). Te aviso apenas el administrador la revise.`;
  }
}

// ── Recalculo de horas de un solo dia corregido ──────────────────────────
// Reusa la misma logica de calculo que motorCalculo.procesarRegistros, pero
// aislada a un unico dia: no depende del resto del mes ni de la rotacion de
// turnos (para mantenimiento/rotativos calcularHoras no usa el turno como
// input, solo lo usa para conserjeria via turnoAsignado, y ese turno ya
// esta guardado en la fila desde el procesamiento original).
const CFG_DEFAULT = {
  mañanaIn: 7 * 60, mañanaOut: 15 * 60,
  tardeIn: 13 * 60, tardeOut: 21 * 60,
  horasDia: 9, horasSab: 0, horasContratoDomingo: 0,
};

function construirCfgEmpleado(empleado) {
  const turnoFijo = Object.keys(TURNOS_FIJOS_CONSERJERIA).find(
    (nm) => normalizarNombre(nm) === normalizarNombre(empleado)
  );
  if (turnoFijo) {
    const tf = TURNOS_FIJOS_CONSERJERIA[turnoFijo];
    return {
      ...CFG_DEFAULT,
      mañanaIn: tf.inMin, mañanaOut: tf.outMin,
      tardeIn: tf.inMin, tardeOut: tf.outMin,
      horasDia: tf.horasDia ?? CFG_DEFAULT.horasDia,
      horasSab: tf.horasSab ?? CFG_DEFAULT.horasSab,
      ...(tf.horasContratoDomingo !== undefined ? { horasContratoDomingo: tf.horasContratoDomingo } : {}),
      ...(tf.horasViernes !== undefined ? { horasViernes: tf.horasViernes } : {}),
    };
  }
  return CFG_DEFAULT;
}

function recalcularHorasDia({ empleado, fecha, ingreso, egreso }) {
  const cfg = construirCfgEmpleado(empleado);
  const [y, m, d] = fecha.split("-").map(Number);
  const fechaObj = new Date(y, m - 1, d);
  const [hIn, minIn] = ingreso.split(":").map(Number);
  const dtEntrada = new Date(y, m - 1, d, hIn, minIn);
  const [hOut, minOut] = egreso.split(":").map(Number);
  const dtSalida = new Date(y, m - 1, d, hOut, minOut);
  if (dtSalida <= dtEntrada) dtSalida.setDate(dtSalida.getDate() + 1); // turno noche cruza medianoche

  return calcularHoras(fechaObj, dtEntrada, dtSalida, cfg, esDiaDeEvento(empleado, fecha));
}

function filaParaExcel(row) {
  const [y, m, d] = row.fecha.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d);
  return {
    empleado: row.empleado,
    fecha: `${String(d).padStart(2, "0")}--${String(m).padStart(2, "0")}--${y}`,
    turno: row.turno,
    ingreso: row.ingreso,
    egreso: row.egreso,
    totalHs: row.total_hs,
    h50: row.h50,
    h100: row.h100,
    esFeriado: FERIADOS.has(row.fecha),
    esDomingo: dateObj.getDay() === 0,
    esSabado: dateObj.getDay() === 6,
    alerta: row.alerta || "",
  };
}

// Por default SOLO regenera y guarda el excel en el servidor — no lo manda
// a ningun lado. El envio (mail + WhatsApp) es opt-in con { enviar: true },
// reservado para cuando el admin lo pide explicitamente (comando "excel").
// Una aprobacion normal deja el archivo actualizado en disco nomas, sin
// avisar cada vez — si no, cada aprobacion (que puede ser varias por dia)
// le manda un excel entero al admin sin que lo haya pedido.
async function regenerarYEnviarExcel(periodo, { enviar = false, resumenTexto } = {}) {
  const filas = filasDelPeriodo(periodo).map(filaParaExcel);
  const resumen = resumenDelPeriodo(periodo).map((r) => ({ ...r, sector: getSectorDeEmpleado(r.empleado) }));

  const buffer = generarExcel(filas, resumen);
  const nombreArchivo = `fichero_actual_${periodo}.xlsx`;
  fs.writeFileSync(path.join(__dirname, "..", "data", nombreArchivo), buffer);

  if (!enviar) return { mailEnviado: false, whatsappEnviado: false };

  let mailEnviado = false;
  try {
    await enviarFichero({
      buffer,
      nombreArchivo,
      resumenTexto: resumenTexto || `Fichero actualizado tras una corrección aprobada (período ${periodo}).`,
    });
    mailEnviado = true;
  } catch (err) {
    // No bloquea nada: el excel ya quedó actualizado en disco y en la base,
    // el mail puede fallar por separado (ej. puerto SMTP bloqueado).
    console.error("No se pudo reenviar el excel por mail:", err.message);
  }

  // Mientras el mail este bloqueado, este es el canal que realmente le
  // llega al admin: el mismo excel, como documento de WhatsApp.
  let whatsappEnviado = false;
  if (process.env.ADMIN_WHATSAPP_NUMBER && process.env.PUBLIC_BASE_URL && process.env.ADMIN_API_KEY) {
    try {
      const mediaUrl = `${process.env.PUBLIC_BASE_URL}/files/${nombreArchivo}?key=${process.env.ADMIN_API_KEY}`;
      await enviarWhatsapp(process.env.ADMIN_WHATSAPP_NUMBER, `📎 Excel actualizado (período ${periodo}):`);
      await enviarDocumentoWhatsapp(process.env.ADMIN_WHATSAPP_NUMBER, mediaUrl);
      whatsappEnviado = true;
    } catch (err) {
      console.error("No se pudo mandar el excel por WhatsApp:", err.message);
    }
  }

  return { mailEnviado, whatsappEnviado };
}

// Aplica la correccion a filas_diarias + resumen_mensual. Devuelve el
// periodo tocado (el que llama decide cuando regenerar el excel — asi una
// aprobacion en lote de varias solicitudes solo regenera/reenvia una vez).
async function aplicarCorreccion(solicitud) {
  const { empleado, periodo, fecha, ingreso_propuesto, egreso_propuesto } = solicitud;
  const filaExistente = filaDelDia(empleado, periodo, fecha);
  // El excel viejo usa "—" para marcar un horario sin dato — no es una hora
  // real, así que no sirve como valor "existente" para el cálculo (sino
  // termina calculando horas contra un valor no parseable).
  const horaExistenteValida = (valor) => (valor && parsearHora(valor) ? valor : null);
  let ingresoBase = filaExistente && horaExistenteValida(filaExistente.ingreso);
  let egresoBase = filaExistente && horaExistenteValida(filaExistente.egreso);

  const cambios = {};
  // Cuando un dia tuvo un unico fichaje suelto, el pipeline lo guarda como
  // "entrada" por default (podria haber sido cualquiera de los dos). Si
  // despues se corrige justo la entrada con OTRO valor y todavia no hay
  // salida cargada, lo mas probable es que ese fichaje viejo en realidad
  // fuera la salida real — lo pasamos ahi en vez de perderlo. Mismo
  // criterio al reves si se corrige la salida.
  if (ingreso_propuesto && ingresoBase && ingreso_propuesto !== ingresoBase && !egresoBase) {
    cambios.egreso = ingresoBase;
    egresoBase = ingresoBase;
  } else if (egreso_propuesto && egresoBase && egreso_propuesto !== egresoBase && !ingresoBase) {
    cambios.ingreso = egresoBase;
    ingresoBase = egresoBase;
  }

  if (ingreso_propuesto) cambios.ingreso = ingreso_propuesto;
  if (egreso_propuesto) cambios.egreso = egreso_propuesto;
  const ingreso = ingreso_propuesto || ingresoBase;
  const egreso = egreso_propuesto || egresoBase;

  if (!ingreso || !egreso) {
    // Todavia falta el otro extremo del dia (ej: nunca hubo ningun registro).
    actualizarFilaDiaria(empleado, periodo, fecha, {
      ...cambios, totalHs: 0, h50: 0, h100: 0, alerta: "⚠ Falta el otro horario",
    });
  } else {
    const calc = recalcularHorasDia({ empleado, fecha, ingreso, egreso });
    actualizarFilaDiaria(empleado, periodo, fecha, {
      ...cambios, totalHs: calc.totalHs, h50: calc.h50, h100: calc.h100, alerta: "",
    });
  }

  recalcularResumenEmpleado(empleado, periodo);
  return periodo;
}

async function resolverUnaSolicitud(accion, id, periodosTocados) {
  const solicitud = obtenerSolicitud(id);
  if (!solicitud) return `#${id}: no encontrada.`;
  if (solicitud.estado !== "pendiente") return `#${id}: ya estaba ${solicitud.estado}.`;

  if (accion === "rechazar") {
    resolverSolicitud(id, "rechazada");
    await enviarWhatsapp(solicitud.numero_whatsapp, `Tu solicitud de corrección (#${id}) fue rechazada. Hablá con el administrador si tenés dudas.`);
    return `#${id}: rechazada.`;
  }

  try {
    const periodo = await aplicarCorreccion(solicitud);
    periodosTocados.add(periodo);
    resolverSolicitud(id, "aprobada");
    await enviarWhatsapp(solicitud.numero_whatsapp, `✅ Solicitud confirmada (#${id}). Tus horas ya están actualizadas.`);
    return `#${id}: confirmada.`;
  } catch (err) {
    console.error(`Error aplicando corrección #${id}:`, err);
    return `#${id}: error (${err.message}).`;
  }
}

function mensajePendientesAdmin() {
  const pendientes = solicitudesPendientes();
  if (pendientes.length === 0) return "No hay solicitudes pendientes. 👍";

  const listado = pendientes
    .map((s) => {
      const fechaDisplay = s.fecha.split("-").reverse().join("/");
      const partes = [];
      if (s.ingreso_propuesto) partes.push(`Entrada: ${s.ingreso_propuesto}`);
      if (s.egreso_propuesto) partes.push(`Salida: ${s.egreso_propuesto}`);
      return `#${s.id} — ${s.empleado} — ${fechaDisplay} (${partes.join(", ")})`;
    })
    .join("\n");

  return (
    `📋 Solicitudes pendientes (${pendientes.length}):\n\n${listado}\n\n` +
    `Respondé "aprobar N" / "rechazar N" (o un rango "N-M").`
  );
}

// Regenera y manda por mail el excel del mes en curso, a pedido del admin
// (no espera al cron del dia 21). El periodo se calcula igual que en
// pipeline.js: el mes calendario de "ahora".
async function enviarExcelActualAdmin() {
  const hoy = new Date();
  const periodo = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  const filas = filasDelPeriodo(periodo);
  if (filas.length === 0) return `Todavía no hay datos procesados para el período ${periodo}.`;

  const { mailEnviado, whatsappEnviado } = await regenerarYEnviarExcel(periodo, {
    enviar: true,
    resumenTexto: `Fichero del período ${periodo}, pedido manualmente por el administrador.`,
  });

  if (whatsappEnviado) return `Dale, ya te mando el excel del período ${periodo} en el próximo mensaje.`;
  if (mailEnviado) return `📎 Generé el excel del período ${periodo} y te lo mandé por mail.`;
  return `📎 Generé el excel del período ${periodo}, pero no se pudo mandar ni por mail ni por WhatsApp (revisá el servidor). Quedó guardado ahí igual.`;
}

// Alta de empleado por WhatsApp: "alta +549XXXXXXXXXX Nombre Apellido".
// Reusa la misma registrarNumero que usaba el endpoint /admin/registrar-numero
// (upsert por numero: si el numero ya estaba, actualiza el nombre).
function manejarAltaEmpleado(texto) {
  const m = texto.trim().match(/^alta\s+(\+\d{8,15})\s+(.+)$/i);
  if (!m) return 'Formato: "alta +549XXXXXXXXXX Nombre Apellido"';
  const numero = m[1];
  const empleado = m[2].trim();
  registrarNumero(numero, empleado);
  return `✅ Alta registrada: ${empleado} (${numero}). Ya puede escribirle al bot para consultar sus horas.`;
}

async function manejarMensajeAdmin(texto) {
  const t = texto.trim();
  const matchRango = t.match(/^(aprobar|rechazar)\s+(\d+)\s*-\s*(\d+)$/i);
  const matchUno = t.match(/^(aprobar|rechazar)\s+(\d+)$/i);

  if (!matchRango && !matchUno) {
    return 'Comandos disponibles: "aprobar N" / "rechazar N", o un rango: "aprobar N-M".';
  }

  const periodosTocados = new Set();
  let resultado;

  if (matchRango) {
    const accion = matchRango[1].toLowerCase();
    const desde = Number(matchRango[2]);
    const hasta = Number(matchRango[3]);
    if (hasta < desde || hasta - desde > 100) {
      return "Ese rango no es válido (o es demasiado grande).";
    }
    const mensajes = [];
    for (let id = desde; id <= hasta; id++) {
      mensajes.push(await resolverUnaSolicitud(accion, id, periodosTocados));
    }
    resultado = `Procesadas ${mensajes.length} solicitudes:\n` + mensajes.join("\n");
  } else {
    const accion = matchUno[1].toLowerCase();
    const id = Number(matchUno[2]);
    resultado = await resolverUnaSolicitud(accion, id, periodosTocados);
  }

  for (const periodo of periodosTocados) {
    // Solo actualiza el archivo en el servidor — no lo manda. El admin lo
    // pide cuando quiere con el comando "excel".
    await regenerarYEnviarExcel(periodo);
  }

  return resultado;
}

// ── Rama especial para Oli ────────────────────────────────────────────────
// No es parte del negocio: es un numero aparte (fuera de whatsapp_map) que
// Emi armo como gesto para su novia. Primer mensaje: menu normal, como
// cualquier otro numero. Cuando responde algo en ese paso, se revela la
// joda y pasa a un chat libre con IA (con memoria de la conversacion). Si
// durante el chat escribe "menu" (curiosidad por las otras opciones), se le
// muestra el menu de nuevo pero al elegir algo se corta con el mismo cartel
// de "no registrada" que ve cualquier numero ajeno — nunca llega a datos
// de empleados — y vuelve al chat libre sin perder la memoria.
async function procesarMensajeOlivia(numero, textoOriginal) {
  const texto = textoOriginal.trim();
  const conv = obtenerConversacion(numero);

  if (!conv) {
    guardarConversacion(numero, "oli:menu");
    return MENU_TEXT;
  }

  if (conv.estado === "oli:menu") {
    guardarConversacion(numero, "oli:chat", { historial: [] });
    return "Vos no trabajás en el edificio... vos sos la novia de Emi 😏\n¿Cómo andás, Oli?";
  }

  const historial = (conv.datos && conv.datos.historial) || [];

  if (conv.estado === "oli:menu-select") {
    guardarConversacion(numero, "oli:chat", { historial });
    return MENSAJE_NO_REGISTRADO;
  }

  if (texto.toLowerCase() === "menu") {
    guardarConversacion(numero, "oli:menu-select", { historial });
    return MENU_TEXT;
  }

  // "oli:chat": charla libre, con memoria de los ultimos mensajes.
  const respuesta = await chatConOlivia(texto, historial);
  if (!respuesta) return "Uy, se me trabó la cabeza un toque. Mandame de nuevo?";

  const nuevoHistorial = [...historial, { role: "user", content: texto }, { role: "assistant", content: respuesta }].slice(-20);
  guardarConversacion(numero, "oli:chat", { historial: nuevoHistorial });
  return respuesta;
}

// ── Numeros no registrados (ni empleado, ni Oli) ──────────────────────────
// Se les muestra el menu igual que a cualquiera (para no delatar que el
// numero esta o no en la lista), pero apenas responden algo (eligiendo una
// opcion) se les corta con el cartel de "no registrado" y se reinicia el
// estado, asi el ciclo (menu -> corte -> menu -> corte...) se repite en
// cada intento sin dejarlos avanzar ni un paso.
function procesarMensajeNoRegistrado(numero) {
  const conv = obtenerConversacion(numero);
  if (!conv) {
    guardarConversacion(numero, "menu");
    return MENU_TEXT;
  }
  limpiarConversacion(numero);
  return MENSAJE_NO_REGISTRADO;
}

router.post("/webhook", express.urlencoded({ extended: false }), async (req, res) => {
  const numero = limpiarNumero(req.body.From);
  const texto = (req.body.Body || "").trim();
  const twiml = new MessagingResponse();

  try {
    // Solo tratamos el mensaje como comando de admin si matchea alguno de los
    // comandos reservados — así el admin (que también puede ser empleado,
    // como en este caso) sigue pudiendo consultar sus propias horas con
    // cualquier otro mensaje.
    const textoLowerAdmin = texto.trim().toLowerCase();
    const esAprobarRechazar = /^(aprobar|rechazar)\s+\d+(\s*-\s*\d+)?$/i.test(texto);
    const esPendientes = textoLowerAdmin === "pendientes";
    const esExcel = textoLowerAdmin === "excel";
    const esAlta = /^alta\s+\+\d{8,15}\s+.+$/i.test(texto);
    const esComandoAdmin = esAprobarRechazar || esPendientes || esExcel || esAlta;

    if (process.env.ADMIN_WHATSAPP_NUMBER && numero === process.env.ADMIN_WHATSAPP_NUMBER && esComandoAdmin) {
      let respuesta;
      if (esAprobarRechazar) respuesta = await manejarMensajeAdmin(texto);
      else if (esPendientes) respuesta = mensajePendientesAdmin();
      else if (esAlta) respuesta = manejarAltaEmpleado(texto);
      else respuesta = await enviarExcelActualAdmin();
      twiml.message(respuesta);
      res.type("text/xml").send(twiml.toString());
      return;
    }

    if (process.env.OLIVIA_WHATSAPP_NUMBER && numero === process.env.OLIVIA_WHATSAPP_NUMBER) {
      twiml.message(await procesarMensajeOlivia(numero, texto));
      res.type("text/xml").send(twiml.toString());
      return;
    }

    const empleado = empleadoPorNumero(numero);

    if (!empleado) {
      // Numero no registrado -> ve el menu igual que cualquiera, pero al
      // elegir una opcion se corta ahi. Nunca devolvemos datos de nadie.
      twiml.message(procesarMensajeNoRegistrado(numero));
      res.type("text/xml").send(twiml.toString());
      return;
    }

    twiml.message(await procesarMensajeEmpleado(empleado, numero, texto));
  } catch (err) {
    console.error("Error en webhook de WhatsApp:", err);
    twiml.message("Hubo un error procesando tu mensaje. Probá de nuevo en unos minutos.");
  }

  res.type("text/xml").send(twiml.toString());
});

module.exports = router;
