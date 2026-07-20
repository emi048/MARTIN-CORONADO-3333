require("dotenv").config();
const db = require("better-sqlite3")("./data/fichero.sqlite");
const { FERIADOS, getSectorDeEmpleado } = require("./lib/motorCalculo");
const { enviarEmailGmail } = require("./lib/gmailClient");

const PERIODO = "2026-07";
const RANGO = "21/6 al 20/7";
const DESTINATARIOS = ["p.saini@bpcoronado.com", "mantenimiento@bpcoronado.com"];

// Ajustes manuales puntuales para un envio especifico - no tocan
// filas_diarias/resumen_mensual, solo se suman aca para el reporte.
// Se vacia despues de cada envio; completar solo si corresponde para el rango actual.
const AJUSTES_MANUALES = {};

const resumen = db.prepare("SELECT empleado, h50, h100 FROM resumen_mensual WHERE periodo=? ORDER BY empleado").all(PERIODO);

function feriadosDelEmpleado(empleado) {
  const filas = db.prepare("SELECT fecha, h100 FROM filas_diarias WHERE empleado=? AND periodo=?").all(empleado, PERIODO);
  return filas.filter((f) => FERIADOS.has(f.fecha));
}

function filaDatos(r) {
  const feriadosFilas = feriadosDelEmpleado(r.empleado);
  const horasFeriado = Math.round(feriadosFilas.reduce((acc, f) => acc + f.h100, 0) * 100) / 100;
  const fechasFeriado = feriadosFilas
    .map((f) => {
      const [, m, d] = f.fecha.split("-").map(Number);
      return `${d}/${m}`;
    })
    .join(", ");

  const ajuste = AJUSTES_MANUALES[r.empleado] || { h50: 0, h100: 0 };
  const h50 = Math.round((r.h50 + ajuste.h50) * 100) / 100;
  const h100Total = Math.round((r.h100 + ajuste.h100) * 100) / 100;
  const h100SinFeriado = Math.round((h100Total - horasFeriado) * 100) / 100;
  const feriadoTxt = horasFeriado > 0 ? `${horasFeriado}hs (${fechasFeriado})` : "-";

  return { empleado: r.empleado, h50, h100: h100SinFeriado, feriadoTxt };
}

function filaHtml(datos) {
  return `<tr>
    <td style="padding:4px 10px;border:1px solid #ccc;">${datos.empleado}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${datos.h50}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${datos.h100}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${datos.feriadoTxt}</td>
  </tr>`;
}

function tablaSector(sector, titulo) {
  const filas = resumen.filter((r) => getSectorDeEmpleado(r.empleado) === sector).map(filaDatos);
  return `
    <h3 style="margin-top:24px;">${titulo}</h3>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">
      <tr style="background:#f0f0f0;">
        <th style="padding:4px 10px;border:1px solid #ccc;">Nombre</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">50%</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">100%</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">Feriado</th>
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
  to: DESTINATARIOS.join(", "),
  subject: `Resumen de horas - ${RANGO}`,
  html,
})
  .then(() => {
    console.log("Email enviado a", DESTINATARIOS.join(", "));
  })
  .catch((err) => {
    console.error("Error enviando email:", err);
    process.exit(1);
  });
