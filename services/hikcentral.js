// ─────────────────────────────────────────────────────────────
// Cliente OpenAPI de HikCentral (gateway "Artemis")
//
// IMPORTANTE — ESTO ES UN PUNTO DE PARTIDA, NO UN CLIENTE TERMINADO:
// HikCentral firma cada request con AppKey/AppSecret via HMAC-SHA256,
// pero el detalle exacto de headers/formato varia segun la version
// de HikCentral instalada. Antes de usar esto en producción:
//
//   1. Entrá a HikCentral > Configuración del sistema > Cuenta OpenAPI
//      y generá un AppKey/AppSecret si todavía no existen.
//   2. Hikvision te da (o se descarga desde el portal de partners) una
//      colección de Postman "HikCentral OpenAPI" — probá ahí primero
//      el endpoint que lista eventos de acceso (normalmente algo como
//      POST /artemis/api/acs/v2/door/events) para confirmar el formato
//      real de firma y de respuesta en tu instalación.
//   3. Ajustá `firmarRequest` y `obtenerEventosAcceso` de acuerdo a eso.
//
// Te dejo armada la estructura para que solo haya que ajustar el detalle
// de la firma, no reescribir el resto del pipeline.
// ─────────────────────────────────────────────────────────────

const crypto = require("crypto");

function firmarRequest({ method, path, appSecret, contentType = "application/json;charset=UTF-8" }) {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  // Cadena a firmar tipica del esquema Artemis: METHOD\nAccept\nContent-Type\nheaders-x-ca-*\npath
  const stringToSign =
    `${method.toUpperCase()}\n` +
    `application/json\n` +
    `${contentType}\n` +
    `x-ca-key:${process.env.HIKCENTRAL_APP_KEY}\n` +
    `x-ca-nonce:${nonce}\n` +
    `x-ca-timestamp:${timestamp}\n` +
    `${path}`;

  const signature = crypto.createHmac("sha256", appSecret).update(stringToSign).digest("base64");

  return {
    "Accept": "application/json",
    "Content-Type": contentType,
    "x-ca-key": process.env.HIKCENTRAL_APP_KEY,
    "x-ca-nonce": nonce,
    "x-ca-timestamp": timestamp,
    "x-ca-signature": signature,
  };
}

// Trae eventos de acceso (fichadas) entre dos fechas y los devuelve ya
// normalizados como [{ empleado, hora: Date }], listos para
// motorCalculo.procesarRegistros(). El mapeo empleado<->evento depende
// de qué campo devuelva tu instalación (personName, personId, etc) —
// ajustá `mapearEventoAEmpleado` una vez que veas una respuesta real.
async function obtenerEventosAcceso(fechaDesde, fechaHasta) {
  const path = "/artemis/api/acs/v2/door/events";
  const headers = firmarRequest({ method: "POST", path, appSecret: process.env.HIKCENTRAL_APP_SECRET });

  const body = {
    pageNo: 1,
    pageSize: 1000,
    startTime: fechaDesde.toISOString(),
    endTime: fechaHasta.toISOString(),
  };

  const res = await fetch(process.env.HIKCENTRAL_HOST + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HikCentral OpenAPI respondió ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const eventos = data?.data?.list || [];
  return eventos.map(mapearEventoAEmpleado).filter(Boolean);
}

function mapearEventoAEmpleado(evento) {
  // TODO: confirmar nombres de campo reales contra la respuesta de tu instalación.
  const nombre = evento.personName || evento.name;
  const horaStr = evento.eventTime || evento.time;
  if (!nombre || !horaStr) return null;
  const hora = new Date(horaStr);
  if (isNaN(hora.getTime())) return null;
  return { empleado: nombre.trim(), hora };
}

module.exports = { obtenerEventosAcceso };
