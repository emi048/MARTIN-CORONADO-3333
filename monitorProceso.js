// Watchdog externo del proceso principal -- corre por cron, aparte del
// server. Si estuviera adentro del server no serviria de nada: si el server
// se cae, un monitor que vive adentro se cae con el.
// Avisa por WhatsApp si: (a) el proceso no esta "online", o (b) el contador
// de "unstable_restarts" de pm2 subio desde la ultima revision -- ese
// contador especificamente sube cuando pm2 detecta reinicios en loop (caidas
// reales), no con un reinicio manual o del auto-deploy.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { enviarWhatsapp } = require("./lib/twilioClient");

const ESTADO_PATH = path.join(__dirname, ".monitor-estado.json");
const NOMBRE_APP = "fichero-automatico";

function leerEstadoAnterior() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO_PATH, "utf8"));
  } catch {
    return { unstableRestarts: 0, avisadoCaido: false };
  }
}

function guardarEstado(estado) {
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado));
}

async function chequear() {
  const admin = process.env.ADMIN_WHATSAPP_NUMBER;
  const anterior = leerEstadoAnterior();

  let proceso;
  try {
    const salida = execSync("pm2 jlist", { encoding: "utf8" });
    const lista = JSON.parse(salida);
    proceso = lista.find((p) => p.name === NOMBRE_APP);
  } catch (err) {
    if (admin) await enviarWhatsapp(admin, `⚠️ El watchdog no pudo consultar pm2: ${err.message}`);
    return;
  }

  if (!proceso) {
    if (admin && !anterior.avisadoCaido) {
      await enviarWhatsapp(admin, `🔴 El proceso "${NOMBRE_APP}" no aparece en pm2 -- puede estar completamente caido.`);
    }
    guardarEstado({ ...anterior, avisadoCaido: true });
    return;
  }

  const status = proceso.pm2_env.status;
  const unstableRestarts = proceso.pm2_env.unstable_restarts || 0;

  if (status !== "online") {
    if (admin && !anterior.avisadoCaido) {
      await enviarWhatsapp(admin, `🔴 El proceso "${NOMBRE_APP}" esta en estado "${status}" (no online).`);
    }
    guardarEstado({ unstableRestarts, avisadoCaido: true });
    return;
  }

  if (unstableRestarts > anterior.unstableRestarts) {
    if (admin) {
      await enviarWhatsapp(
        admin,
        `⚠️ El proceso "${NOMBRE_APP}" se esta reiniciando solo repetidamente (se cayo ${unstableRestarts - anterior.unstableRestarts} vez/veces mas desde el ultimo chequeo). Revisá los logs.`
      );
    }
  }

  guardarEstado({ unstableRestarts, avisadoCaido: false });
}

chequear().catch((err) => {
  console.error("Error en monitorProceso:", err);
  process.exit(1);
});
