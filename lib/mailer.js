const { enviarEmailGmailConAdjunto } = require("./gmailClient");

// El puerto SMTP salido está bloqueado por el proveedor del VPS (confirmado:
// 25, 465 y 587 dan timeout), así que el envío va por la API de Gmail
// (HTTPS/443, que sí está abierto) en vez de nodemailer/SMTP.
async function enviarFichero({ buffer, nombreArchivo, resumenTexto }) {
  const destinatarios = (process.env.MAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
  if (destinatarios.length === 0) throw new Error("MAIL_TO no está configurado en .env");

  await enviarEmailGmailConAdjunto({
    to: destinatarios.join(", "),
    subject: `Fichero de asistencia generado — ${nombreArchivo}`,
    text: resumenTexto,
    attachment: { filename: nombreArchivo, content: buffer },
  });
}

module.exports = { enviarFichero };
