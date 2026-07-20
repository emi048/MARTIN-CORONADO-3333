const twilio = require("twilio");

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

module.exports = { twilioClient, enviarWhatsapp, enviarDocumentoWhatsapp };
