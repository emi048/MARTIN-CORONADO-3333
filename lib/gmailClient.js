const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  const tokenPath = path.join(__dirname, "..", "config", "gmail_token.json");
  const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

function construirMensajeRaw({ from, to, subject, html }) {
  const asuntoCodificado = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const mensaje = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${asuntoCodificado}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
  ].join("\r\n");
  return Buffer.from(mensaje)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function enviarEmailGmail({ to, subject, html }) {
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const raw = construirMensajeRaw({ from, to, subject, html });
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

// text plano + un adjunto binario (ej. el excel del fichero). Multipart/mixed
// a mano porque nodemailer (que arma esto solo) quedó afuera al migrar de
// SMTP a la API de Gmail.
function construirMensajeConAdjuntoRaw({ from, to, subject, text, attachment }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const asuntoCodificado = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const partes = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${asuntoCodificado}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    text,
    "",
    `--${boundary}`,
    `Content-Type: application/octet-stream; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    attachment.content.toString("base64"),
    "",
    `--${boundary}--`,
  ].join("\r\n");
  return Buffer.from(partes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function enviarEmailGmailConAdjunto({ to, subject, text, attachment }) {
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: "v1", auth });
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const raw = construirMensajeConAdjuntoRaw({ from, to, subject, text, attachment });
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
}

module.exports = { enviarEmailGmail, enviarEmailGmailConAdjunto };
