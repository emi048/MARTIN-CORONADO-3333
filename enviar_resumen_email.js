require("dotenv").config();
const db = require("better-sqlite3")("./data/fichero.sqlite");
const { getSectorDeEmpleado } = require("./lib/motorCalculo");
const { enviarEmailGmail } = require("./lib/gmailClient");

const PERIODO = "2026-07";
const RANGO = "21/6 al 20/7";
const DESTINATARIO = "p.saini@bpcoronado.com";

const resumen = db.prepare("SELECT empleado, h50, h100 FROM resumen_mensual WHERE periodo=? ORDER BY empleado").all(PERIODO);

function filaHtml(r) {
  return `<tr>
    <td style="padding:4px 10px;border:1px solid #ccc;">${r.empleado}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${r.h50}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${r.h100}</td>
  </tr>`;
}

function tablaSector(sector, titulo) {
  const filas = resumen.filter((r) => getSectorDeEmpleado(r.empleado) === sector);
  return `
    <h3 style="margin-top:24px;">${titulo}</h3>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">
      <tr style="background:#f0f0f0;">
        <th style="padding:4px 10px;border:1px solid #ccc;">Nombre</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">50%</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">100%</th>
      </tr>
      ${filas.map(filaHtml).join("\n")}
    </table>`;
}

const html = `
  <div style="font-family:Arial,sans-serif;">
    <p>Resumen de horas extra - ${RANGO}</p>
    ${tablaSector("mantenimiento", "Mantenimiento")}
    ${tablaSector("conserjeria", "Conserjería")}
  </div>
`;

enviarEmailGmail({
  to: DESTINATARIO,
  subject: `Resumen de horas - ${RANGO}`,
  html,
})
  .then(() => {
    console.log("Email enviado a", DESTINATARIO);
  })
  .catch((err) => {
    console.error("Error enviando email:", err);
    process.exit(1);
  });
