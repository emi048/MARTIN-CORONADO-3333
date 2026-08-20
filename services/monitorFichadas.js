// ─────────────────────────────────────────────────────────────
// Monitoreo en tiempo real de fichadas (HikCentral) + recordatorios
// de salida olvidada.
//
// OJO: obtenerEventosAcceso (lib/hikcentral.js) todavia es un stub sin
// verificar contra una instalacion real de HikCentral — antes de confiar
// en este archivo hay que validar el mapeo de campos ahi (ver el TODO
// en hikcentral.js). Esta capa no agrega ninguna suposicion nueva sobre
// el formato de los eventos, solo consume lo que ya devuelve esa funcion.
// ─────────────────────────────────────────────────────────────

const { obtenerEventosAcceso } = require("./hikcentral");
const {
  obtenerFichadaHoy, marcarIngresoDetectado, marcarEgresoDetectado,
  marcarIngresoNotificado, marcarEgresoNotificado,
  fichadasPendientesDeNotificar, fichadasSinEgresoDeHoy,
  registrarRecordatorio, numeroDeEmpleado,
} = require("./db");
const { normalizarNombre, getSectorDeEmpleado, TURNOS_FIJOS_CONSERJERIA } = require("./motorCalculo");
const { enviarWhatsapp, enviarWhatsappVentana } = require("./twilioClient");

function fechaISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Revisa los ultimos minutos de eventos de HikCentral: registra
// ingreso/egreso nuevos (primer swipe del dia = ingreso, segundo = egreso,
// swipes de mas se ignoran para este seguimiento en vivo) y manda
// "fichada exitosa" / "salida exitosa" una vez pasado CONFIRMACION_DELAY_MIN
// desde la hora REAL del evento (no desde cuando lo detectamos — asi el
// resultado es el mismo aunque el poller se haya atrasado).
async function revisarFichadasRecientes() {
  const ahora = new Date();
  const desde = new Date(ahora.getTime() - 15 * 60000);
  const eventos = await obtenerEventosAcceso(desde, ahora);
  eventos.sort((a, b) => a.hora - b.hora);

  for (const ev of eventos) {
    const fecha = fechaISO(ev.hora);
    const horaDisplay = ev.hora.toTimeString().slice(0, 5);
    const detectadoEnISO = ev.hora.toISOString();
    const existente = obtenerFichadaHoy(ev.empleado, fecha);

    if (!existente || !existente.ingreso_hora) {
      marcarIngresoDetectado(ev.empleado, fecha, horaDisplay, detectadoEnISO);
    } else if (!existente.egreso_hora) {
      marcarEgresoDetectado(ev.empleado, fecha, horaDisplay, detectadoEnISO);
    }
  }

  const delayMs = (Number(process.env.CONFIRMACION_DELAY_MIN) || 2) * 60000;
  for (const f of fichadasPendientesDeNotificar()) {
    const numero = numeroDeEmpleado(f.empleado);
    if (!numero) continue;

    if (f.ingreso_hora && !f.ingreso_notificado) {
      const detectadoEn = new Date(f.ingreso_detectado_en).getTime();
      if (Date.now() - detectadoEn >= delayMs) {
        await enviarWhatsapp(numero, `✅ Fichada de entrada registrada a las ${f.ingreso_hora}.`);
        marcarIngresoNotificado(f.id);
      }
    }

    if (f.egreso_hora && !f.egreso_notificado) {
      const detectadoEn = new Date(f.egreso_detectado_en).getTime();
      if (Date.now() - detectadoEn >= delayMs) {
        await enviarWhatsapp(numero, `✅ Fichada de salida registrada a las ${f.egreso_hora}.`);
        marcarEgresoNotificado(f.id);
      }
    }
  }
}

// A partir de que hora consideramos que a este empleado "le toca" haber
// fichado la salida. Conserjeria: fin de su turno fijo + margen de gracia.
// Cualquier otro sector (mantenimiento, sin horario fijo): N horas desde
// que fichó entrada.
function calcularUmbralSalida(empleado, fichada) {
  const [y, m, d] = fichada.fecha.split("-").map(Number);
  const sector = getSectorDeEmpleado(empleado);

  if (sector === "conserjeria") {
    const nombreFijo = Object.keys(TURNOS_FIJOS_CONSERJERIA).find(
      (nm) => normalizarNombre(nm) === normalizarNombre(empleado)
    );
    if (nombreFijo) {
      const tf = TURNOS_FIJOS_CONSERJERIA[nombreFijo];
      const finTurno = new Date(y, m - 1, d, Math.floor(tf.outMin / 60), tf.outMin % 60);
      if (tf.outMin < tf.inMin) finTurno.setDate(finTurno.getDate() + 1); // turno noche cruza medianoche
      const graciaMin = Number(process.env.RECORDATORIO_GRACIA_CONSERJERIA_MIN) || 30;
      return new Date(finTurno.getTime() + graciaMin * 60000);
    }
  }

  const [hIn, minIn] = fichada.ingreso_hora.split(":").map(Number);
  const ingresoDt = new Date(y, m - 1, d, hIn, minIn);
  const horas = Number(process.env.RECORDATORIO_UMBRAL_MANTENIMIENTO_HORAS) || 10;
  return new Date(ingresoDt.getTime() + horas * 3600000);
}

// Recorre a los empleados que fichraron entrada hoy pero no salida, y les
// manda un recordatorio si ya paso su umbral (segun sector) y no se les
// aviso en la ultima hora. No manda nada de madrugada (entre RECORDATORIO_
// CORTE_HORA y las 6am) para no molestar a nadie mientras duerme.
async function revisarPendientesDeSalida() {
  const ahora = new Date();
  const corteHora = Number(process.env.RECORDATORIO_CORTE_HORA) || 0;
  if (ahora.getHours() >= corteHora && ahora.getHours() < 6) return;

  const pendientes = fichadasSinEgresoDeHoy(fechaISO(ahora));
  for (const f of pendientes) {
    const umbral = calcularUmbralSalida(f.empleado, f);
    if (ahora < umbral) continue;

    const ultimoAviso = f.ultimo_recordatorio_en ? new Date(f.ultimo_recordatorio_en).getTime() : null;
    if (ultimoAviso && ahora.getTime() - ultimoAviso < 55 * 60000) continue; // no repetir antes de ~1h

    const numero = numeroDeEmpleado(f.empleado);
    if (!numero) continue;

    // enviarWhatsappVentana (no enviarWhatsapp): este aviso lo inicia el bot,
    // no responde a un mensaje del empleado -- si hace mas de 24hs que no le
    // escribe al bot, WhatsApp no deja mandarlo como texto libre y hay que
    // usar la Content Template ya aprobada para este caso puntual. Envuelto
    // en try/catch para que un fallo con UN empleado (numero invalido, hipo
    // de Twilio) no corte el recordatorio del resto de la lista.
    try {
      await enviarWhatsappVentana(
        numero,
        `⏰ ${f.empleado.split(" ")[0]}, todavía no vemos que hayas fichado la salida de hoy. ` +
          `Si seguís trabajando, ignorá este mensaje — te lo recuerdo cada 1h hasta que fiches.`,
        process.env.CONTENT_SID_RECORDATORIO_SALIDA,
        { "1": f.empleado.split(" ")[0] }
      );
    } catch (err) {
      console.error(`No se pudo mandar el recordatorio de salida a ${f.empleado}:`, err.message);
      continue;
    }
    registrarRecordatorio(f.id, ahora.toISOString());
  }
}

module.exports = { revisarFichadasRecientes, revisarPendientesDeSalida };
