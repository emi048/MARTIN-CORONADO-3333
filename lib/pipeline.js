const { procesarRegistros } = require("./motorCalculo");
const { generarExcel } = require("./generarExcel");
const { enviarFichero } = require("./mailer");
const { guardarResumenMensual, guardarFilasDiarias } = require("./db");
const { obtenerEventosAcceso } = require("./hikcentral");

// rotacionInicialMañana: "A" o "B" — igual que el switch "Invertir Grupos"
// del HTML. Como ahora no hay UI, lo definimos por config o lo calculamos
// según una fecha de referencia fija que vos elijas al arrancar el sistema.
const ROTACION_INICIAL = process.env.ROTACION_INICIAL_MAÑANA || "A";

function fechaAISO(fechaReal) {
  const d = fechaReal;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function correrPipelineMensual({ fechaDesde, fechaHasta, registrosManuales = [] } = {}) {
  const hoy = new Date();
  fechaDesde = fechaDesde || new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  fechaHasta = fechaHasta || hoy;

  const registros = await obtenerEventosAcceso(fechaDesde, fechaHasta);
  registrosManuales.forEach(r => registros.push(r));

  const { filas, resumen, alertasTotal } = procesarRegistros(registros, ROTACION_INICIAL);

  const periodo = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  guardarResumenMensual(periodo, resumen);

  // Persistimos tambien el detalle dia-por-dia (no solo el agregado) para
  // que mas adelante se puedan aplicar correcciones puntuales por dia.
  guardarFilasDiarias(periodo, filas.map(f => ({
    empleado: f.empleado,
    fecha: fechaAISO(f._fechaReal),
    turno: f.turno,
    ingreso: f.ingreso,
    egreso: f.egreso,
    totalHs: f.totalHs,
    h50: f.h50,
    h100: f.h100,
    alerta: f.alerta,
  })));

  const buffer = generarExcel(filas, resumen);
  const nombreArchivo = `fichero_${String(hoy.getMonth() + 1).padStart(2, "0")}_${hoy.getFullYear()}.xlsx`;

  const totalH50 = resumen.reduce((a, r) => a + r.h50, 0).toFixed(2);
  const totalH100 = resumen.reduce((a, r) => a + r.h100, 0).toFixed(2);
  const resumenTexto =
    `Fichero generado automáticamente.\n\n` +
    `Período: ${periodo}\n` +
    `Días procesados: ${filas.length}\n` +
    `Horas extra 50%: ${totalH50}\n` +
    `Horas extra 100%: ${totalH100}\n` +
    (alertasTotal > 0 ? `\n⚠ ${alertasTotal} días requieren revisión manual (ver columna Observación).\n` : "");

  await enviarFichero({ buffer, nombreArchivo, resumenTexto });

  return { filas, resumen, alertasTotal, nombreArchivo };
}

module.exports = { correrPipelineMensual };
