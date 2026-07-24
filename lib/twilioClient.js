const twilio = require("twilio");
const { ventanaAbiertaPara } = require("./db");

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function enviarWhatsapp(numero, texto) {
  const to = numero.startsWith("whatsapp:") ? numero : `whatsapp:${numero}`;
  await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to, body: texto });
}

// Manda un archivo (ej: el excel) como documento adjunto de WhatsApp.
// mediaUrl tiene que ser una URL publica que Twilio pueda descargar — no
// soporta caption/nombre de archivo para documentos (Word/Excel/PPT) todavia,
// asi que el texto de contexto va aparte, en un mensaje de texto previo.
async function enviarDocumentoWhatsapp(numero, mediaUrl) {
  const to = numero.startsWith("whatsapp:") ? numero : `whatsapp:${numero}`;
  await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to, mediaUrl: [mediaUrl] });
}

// Manda un mensaje interactivo (botones o lista) usando una Content Template
// ya creada en la cuenta (ver README, seccion "Menu con botones"). A
// diferencia de enviarWhatsapp, esto NO se puede devolver como respuesta
// TwiML sincronica al webhook -- el <Message> de TwiML no soporta
// ContentSid, asi que siempre es un envio asincrono aparte via la API REST.
// No probado todavia contra un numero real (el Sandbox no renderiza
// Content Templates custom) -- verificar en cuanto haya numero de produccion.
async function enviarWhatsappInteractivo(numero, contentSid, variables) {
  const to = numero.startsWith("whatsapp:") ? numero : `whatsapp:${numero}`;
  const params = { from: process.env.TWILIO_WHATSAPP_FROM, to, contentSid };
  if (variables) params.contentVariables = JSON.stringify(variables);
  await twilioClient.messages.create(params);
}

// Manda texto libre si la ventana de 24hs de WhatsApp esta abierta (el
// numero le escribio al bot hace menos de un dia); si no, cae a una Content
// Template ya aprobada por Meta -- la unica forma de mandar un mensaje "en
// frio" (iniciado por el bot) en WhatsApp Business. Sin contentSid, intenta
// el texto libre igual (mismo comportamiento que antes de que existiera
// esta funcion -- por ahora solo hay templates para dos casos puntuales).
async function enviarWhatsappVentana(numero, textoLibre, contentSid, variables) {
  const numeroLimpio = numero.replace("whatsapp:", "");
  if (!contentSid || ventanaAbiertaPara(numeroLimpio)) {
    await enviarWhatsapp(numero, textoLibre);
  } else {
    await enviarWhatsappInteractivo(numero, contentSid, variables);
  }
}

module.exports = { twilioClient, enviarWhatsapp, enviarDocumentoWhatsapp, enviarWhatsappInteractivo, enviarWhatsappVentana };
