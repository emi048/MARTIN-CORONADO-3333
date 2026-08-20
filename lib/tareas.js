const fs = require("fs");
const path = require("path");
const {
  crearTarea, obtenerTarea, tareasPendientesPara, marcarTareaHecha, marcarTareasVencidas, tareasEnRango,
} = require("./db");
const { numeroDeEmpleado } = require("./db");
const { todosLosEmpleados } = require("./motorCalculo");
const { enviarWhatsapp, enviarDocumentoWhatsapp } = require("./twilioClient");

const DIR_FOTOS = path.join(__dirname, "..", "data", "tareas_fotos");

function formatoFechaHora(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: process.env.TIMEZONE || "America/Argentina/Buenos_Aires",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(d).replace(",", "");
}

// Manda la lista de tareas pendientes (abiertas al equipo + las asignadas a
// este empleado puntual) en el mismo formato que usa el bot para "mis horas".
function mensajeListaTareas(empleado) {
  const tareas = tareasPendientesPara(empleado);
  if (tareas.length === 0) return "✅ No tenés tareas pendientes por ahora.";

  const bloques = tareas.map((t) => {
    const venceTag = t.estado === "vencida" ? "🔴 *VENCIDA*" : `⏰ Vence: ${formatoFechaHora(t.vence_en)}`;
    const asignacion = t.asignado_a ? "" : " _(equipo)_";
    const desc = t.descripcion ? `\n${t.descripcion}` : "";
    return `*#${t.id}* — ${t.titulo}${asignacion}${desc}\n${venceTag}`;
  });

  return (
    `📋 *Tareas pendientes*\n\n${bloques.join("\n\n")}\n\n` +
    `Para cerrar una: "tarea N finalizada" (podés mandar una foto con esa leyenda como texto del mensaje).`
  );
}

// asignadoA: null = abierta a todo el equipo. Devuelve tambien a quien no se
// le pudo avisar (sin numero de WhatsApp cargado) para que el que la creo lo sepa.
async function crearTareaYNotificar({ titulo, descripcion, plazoHoras, asignadoA, creadoPor }) {
  const { id, venceEn } = crearTarea({ titulo, descripcion, plazoHoras, asignadoA, creadoPor });

  const destinatarios = asignadoA ? [asignadoA] : todosLosEmpleados();
  const avisados = [];
  const sinNumero = [];

  const asignacionTxt = asignadoA ? "" : " (para todo el equipo)";
  const texto =
    `📌 *Nueva tarea*${asignacionTxt}\n\n*${titulo}*\n${descripcion || ""}\n\n` +
    `⏰ Plazo: ${plazoHoras}hs (vence ${formatoFechaHora(venceEn)})\n\n` +
    `Escribí *Lista* para ver todas tus tareas pendientes.`;

  for (const empleado of destinatarios) {
    const numero = numeroDeEmpleado(empleado);
    if (!numero) { sinNumero.push(empleado); continue; }
    try {
      await enviarWhatsapp(numero, texto);
      avisados.push(empleado);
    } catch (err) {
      console.error(`No se pudo avisar la tarea #${id} a ${empleado}:`, err.message);
      sinNumero.push(empleado);
    }
  }

  return { id, venceEn, avisados, sinNumero };
}

const EXT_POR_CONTENT_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

// Descarga la foto que Twilio adjunto al mensaje (la URL de Twilio requiere
// Basic Auth con el mismo Account SID / Auth Token de la cuenta) y la guarda
// en disco -- Twilio no la retiene de forma indefinida, asi que conviene
// bajarla apenas llega en vez de solo guardar el link.
async function descargarFotoTarea(idTarea, mediaUrl, mediaContentType) {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const resp = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!resp.ok) throw new Error(`Twilio media respondio ${resp.status}`);

  const ext = EXT_POR_CONTENT_TYPE[mediaContentType] || "jpg";
  fs.mkdirSync(DIR_FOTOS, { recursive: true });
  const nombreArchivo = `tarea_${idTarea}_${Date.now()}.${ext}`;
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(path.join(DIR_FOTOS, nombreArchivo), buffer);
  return nombreArchivo;
}

// empleado ya viene validado (es el que escribio el mensaje). mediaUrl/
// mediaContentType son opcionales -- solo vienen si el mensaje traia una foto.
async function marcarTareaHechaYNotificar({ id, empleado, mediaUrl, mediaContentType }) {
  const tarea = obtenerTarea(id);
  if (!tarea) return { error: `No encontré la tarea #${id}.` };
  if (tarea.estado === "hecha") {
    return { error: `La tarea #${id} ya estaba marcada como finalizada por ${tarea.completado_por}.` };
  }
  if (tarea.asignado_a && tarea.asignado_a !== empleado) {
    return { error: `La tarea #${id} está asignada a otra persona.` };
  }

  let fotoPath = null;
  if (mediaUrl) {
    try {
      fotoPath = await descargarFotoTarea(id, mediaUrl, mediaContentType);
    } catch (err) {
      console.error(`No se pudo descargar la foto de la tarea #${id}:`, err.message);
    }
  }

  const fueraDePlazo = tarea.estado === "vencida";
  marcarTareaHecha(id, empleado, fotoPath);

  const notaPlazo = fueraDePlazo ? " (fuera de plazo)" : "";
  const notaFoto = mediaUrl && !fotoPath ? "\n⚠️ No se pudo guardar la foto adjunta." : "";
  const textoAdmin = `✅ Tarea #${id} finalizada${notaPlazo}\n"${tarea.titulo}"\nPor: ${empleado}${notaFoto}`;

  if (process.env.ADMIN_WHATSAPP_NUMBER) {
    try {
      await enviarWhatsapp(process.env.ADMIN_WHATSAPP_NUMBER, textoAdmin);
      if (fotoPath && process.env.PUBLIC_BASE_URL && process.env.ADMIN_API_KEY) {
        const url = `${process.env.PUBLIC_BASE_URL}/files/tareas/${fotoPath}?key=${process.env.ADMIN_API_KEY}`;
        await enviarDocumentoWhatsapp(process.env.ADMIN_WHATSAPP_NUMBER, url);
      }
    } catch (err) {
      console.error(`No se pudo avisar al admin del cierre de la tarea #${id}:`, err.message);
    }
  }

  return { ok: true, fueraDePlazo, tieneFoto: !!fotoPath };
}

// Llamado por el cron: pasa a "vencida" lo que corresponda y avisa al admin
// una sola vez por tarea (admin_avisado_vencimiento evita duplicados).
async function revisarVencimientos() {
  const vencidas = marcarTareasVencidas();
  for (const t of vencidas) {
    if (!process.env.ADMIN_WHATSAPP_NUMBER) continue;
    try {
      await enviarWhatsapp(
        process.env.ADMIN_WHATSAPP_NUMBER,
        `⏰ La tarea #${t.id} venció sin marcarse como finalizada.\n"${t.titulo}"` +
          (t.asignado_a ? `\nAsignada a: ${t.asignado_a}` : "\n(abierta a todo el equipo)")
      );
    } catch (err) {
      console.error(`No se pudo avisar el vencimiento de la tarea #${t.id}:`, err.message);
    }
  }
  return vencidas;
}

function reporteMensual(desde, hasta) {
  const tareas = tareasEnRango(desde, hasta);
  const resumen = {
    total: tareas.length,
    hechas: tareas.filter((t) => t.estado === "hecha").length,
    vencidas: tareas.filter((t) => t.estado === "vencida").length,
    pendientes: tareas.filter((t) => t.estado === "pendiente").length,
  };
  return { tareas, resumen };
}

module.exports = {
  mensajeListaTareas, crearTareaYNotificar, marcarTareaHechaYNotificar, revisarVencimientos, reporteMensual,
  formatoFechaHora, DIR_FOTOS,
};
