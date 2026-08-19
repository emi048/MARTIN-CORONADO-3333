require("dotenv").config();
const db = require("better-sqlite3")("./data/fichero.sqlite");
const { FERIADOS, getSectorDeEmpleado } = require("./lib/motorCalculo");
const { enviarEmailGmail } = require("./lib/gmailClient");

const PERIODO = "2026-08";
const RANGO = "20/7 al 20/8";
const DESTINATARIOS = ["p.saini@bpcoronado.com", "mantenimiento@bpcoronado.com"];

// Ajustes manuales puntuales para un envio especifico - no tocan
// filas_diarias/resumen_mensual, solo se suman aca para el reporte.
// Se vacia despues de cada envio; completar solo si corresponde para el rango actual.
const AJUSTES_MANUALES = {};

// Dias de poker de Martin: se pagan como hora extra normal al 50% (no como
// evento con piso de 100%), pero igual conviene mostrarlas separadas del
// resto de sus horas al 50% en el reporte -- mismo criterio que ya se usa
// para separar los feriados de las horas al 100%.
const FECHAS_POKER = {
  "Martin Torres": ["2026-07-22", "2026-07-29", "2026-08-03"],
};

const resumen = db.prepare("SELECT empleado, h50, h100 FROM resumen_mensual WHERE periodo=? ORDER BY empleado").all(PERIODO);

function feriadosDelEmpleado(empleado) {
  const filas = db.prepare("SELECT fecha, h100 FROM filas_diarias WHERE empleado=? AND periodo=?").all(empleado, PERIODO);
  return filas.filter((f) => FERIADOS.has(f.fecha));
}

function eventosDelEmpleado(empleado) {
  const fechas = db.prepare("SELECT fecha FROM eventos WHERE empleado=?").all(empleado).map((r) => r.fecha);
  if (fechas.length === 0) return [];
  const filas = db.prepare("SELECT fecha, h100 FROM filas_diarias WHERE empleado=? AND periodo=?").all(empleado, PERIODO);
  return filas.filter((f) => fechas.includes(f.fecha));
}

function pokerDelEmpleado(empleado) {
  const fechas = FECHAS_POKER[empleado] || [];
  if (fechas.length === 0) return [];
  const filas = db.prepare("SELECT fecha, h50 FROM filas_diarias WHERE empleado=? AND periodo=?").all(empleado, PERIODO);
  return filas.filter((f) => fechas.includes(f.fecha));
}

function fechaCorta(fecha) {
  const [, m, d] = fecha.split("-").map(Number);
  return `${d}/${m}`;
}

function sumarHoras(filas, campo) {
  return Math.round(filas.reduce((acc, f) => acc + f[campo], 0) * 100) / 100;
}

function textoHoras(horas, filas) {
  if (horas <= 0) return "-";
  const fechas = filas.map((f) => fechaCorta(f.fecha)).join(", ");
  return `${horas}hs (${fechas})`;
}

function filaDatos(r) {
  const feriadosFilas = feriadosDelEmpleado(r.empleado);
  const horasFeriado = sumarHoras(feriadosFilas, "h100");

  const eventoFilas = eventosDelEmpleado(r.empleado);
  const horasEvento = sumarHoras(eventoFilas, "h100");

  const pokerFilas = pokerDelEmpleado(r.empleado);
  const horasPoker = sumarHoras(pokerFilas, "h50");

  const ajuste = AJUSTES_MANUALES[r.empleado] || { h50: 0, h100: 0 };
  const h50Total = Math.round((r.h50 + ajuste.h50) * 100) / 100;
  const h100Total = Math.round((r.h100 + ajuste.h100) * 100) / 100;

  const h50 = Math.round((h50Total - horasPoker) * 100) / 100;
  const h100 = Math.round((h100Total - horasFeriado - horasEvento) * 100) / 100;

  return {
    empleado: r.empleado,
    h50,
    h100,
    feriadoTxt: textoHoras(horasFeriado, feriadosFilas),
    eventoTxt: textoHoras(horasEvento, eventoFilas),
    pokerTxt: textoHoras(horasPoker, pokerFilas),
    horasEvento,
    eventoFilas,
  };
}

function filaHtml(datos, mostrarPoker) {
  return `<tr>
    <td style="padding:4px 10px;border:1px solid #ccc;">${datos.empleado}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${datos.h50}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${datos.h100}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${datos.feriadoTxt}</td>
    <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${datos.eventoTxt}</td>
    ${mostrarPoker ? `<td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${datos.pokerTxt}</td>` : ""}
  </tr>`;
}

// El poker lo cubre solo Martin (conserjeria) -- la columna Poker no tiene
// sentido en la tabla de Mantenimiento, nunca va a tener datos ahi.
function tablaSector(sector, titulo, todosDatos) {
  const datos = todosDatos.filter((d) => getSectorDeEmpleado(d.empleado) === sector);
  const mostrarPoker = sector === "conserjeria";
  return `
    <h3 style="margin-top:24px;">${titulo}</h3>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">
      <tr style="background:#f0f0f0;">
        <th style="padding:4px 10px;border:1px solid #ccc;">Nombre</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">50%</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">100%</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">Feriado</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">Evento</th>
        ${mostrarPoker ? `<th style="padding:4px 10px;border:1px solid #ccc;">Poker</th>` : ""}
      </tr>
      ${datos.map((d) => filaHtml(d, mostrarPoker)).join("\n")}
    </table>`;
}

function tablaEventos(todosDatos) {
  const conEvento = todosDatos.filter((d) => d.horasEvento > 0);
  if (conEvento.length === 0) return "";
  return `
    <h3 style="margin-top:24px;">📌 Eventos</h3>
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">
      <tr style="background:#fff3cd;">
        <th style="padding:4px 10px;border:1px solid #ccc;">Nombre</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">Horas</th>
        <th style="padding:4px 10px;border:1px solid #ccc;">Fechas</th>
      </tr>
      ${conEvento
        .map(
          (d) => `<tr>
        <td style="padding:4px 10px;border:1px solid #ccc;">${d.empleado}</td>
        <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${d.horasEvento}</td>
        <td style="padding:4px 10px;border:1px solid #ccc;text-align:center;">${d.eventoFilas.map((f) => fechaCorta(f.fecha)).join(", ")}</td>
      </tr>`
        )
        .join("\n")}
    </table>`;
}

const todosDatos = resumen.map(filaDatos);

const html = `
  <div style="font-family:Arial,sans-serif;">
    <p>Resumen de horas extra - ${RANGO}</p>
    ${tablaSector("mantenimiento", "Mantenimiento", todosDatos)}
    ${tablaSector("conserjeria", "Conserjería", todosDatos)}
    ${tablaEventos(todosDatos)}
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
