const cron = require("node-cron");
const { correrPipelineMensual } = require("../lib/pipeline");
const { revisarFichadasRecientes, revisarPendientesDeSalida } = require("../lib/monitorFichadas");
const { enviarWhatsapp } = require("../lib/twilioClient");

function iniciarCron() {
  const expresion = process.env.CRON_SCHEDULE || "0 8 21 * *";
  const timezone = process.env.TIMEZONE || "America/Argentina/Buenos_Aires";

  console.log(`[cron] Programado: "${expresion}" (${timezone})`);

  cron.schedule(expresion, async () => {
    console.log("[cron] Iniciando generación automática del fichero...");
    try {
      const { filas, alertasTotal, nombreArchivo } = await correrPipelineMensual();
      console.log(`[cron] Listo: ${nombreArchivo} — ${filas.length} días, ${alertasTotal} alertas.`);
    } catch (err) {
      console.error("[cron] Error generando el fichero:", err);
      if (process.env.ADMIN_WHATSAPP_NUMBER) {
        try {
          await enviarWhatsapp(
            process.env.ADMIN_WHATSAPP_NUMBER,
            `⚠️ Falló la generación automática del fichero mensual: ${err.message}`
          );
        } catch (errAviso) {
          console.error("[cron] Encima no se pudo avisar por WhatsApp:", errAviso.message);
        }
      }
    }
  }, { timezone });

  // Poller de fichadas en tiempo real (confirma por WhatsApp "fichada exitosa" /
  // "salida exitosa" a los pocos minutos de fichar).
  const expresionPoll = process.env.CRON_POLL_FICHADAS || "*/2 * * * *";
  console.log(`[cron] Poll de fichadas: "${expresionPoll}" (${timezone})`);
  cron.schedule(expresionPoll, async () => {
    try {
      await revisarFichadasRecientes();
    } catch (err) {
      console.error("[cron] Error revisando fichadas recientes:", err);
    }
  }, { timezone });

  // Recordatorios de salida olvidada (cada hora por defecto).
  const expresionRecordatorios = process.env.CRON_RECORDATORIOS || "0 * * * *";
  console.log(`[cron] Recordatorios de salida: "${expresionRecordatorios}" (${timezone})`);
  cron.schedule(expresionRecordatorios, async () => {
    try {
      await revisarPendientesDeSalida();
    } catch (err) {
      console.error("[cron] Error revisando pendientes de salida:", err);
    }
  }, { timezone });
}

module.exports = { iniciarCron };
