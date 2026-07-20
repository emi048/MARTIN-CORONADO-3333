const nodemailer = require("nodemailer");

function crearTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // El puerto SMTP puede estar bloqueado (ej. por el proveedor del servidor).
    // Sin esto, nodemailer tarda varios minutos en tirar error, lo que hace
    // que cualquier accion que dependa del mail (aprobar una correccion,
    // correr el pipeline) se sienta "colgada" para quien espera la respuesta
    // por WhatsApp. Preferimos fallar rapido y que el resto del flujo siga.
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
  });
}

async function enviarFichero({ buffer, nombreArchivo, resumenTexto }) {
  const transporter = crearTransporter();
  const destinatarios = (process.env.MAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
  if (destinatarios.length === 0) throw new Error("MAIL_TO no está configurado en .env");

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: destinatarios,
    subject: `Fichero de asistencia generado — ${nombreArchivo}`,
    text: resumenTexto,
    attachments: [{ filename: nombreArchivo, content: buffer }],
  });
}

module.exports = { enviarFichero };
