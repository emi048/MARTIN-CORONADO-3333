require("dotenv").config();
const path = require("path");
const express = require("express");
const { iniciarCron } = require("./cron");
const whatsappRouter = require("./routes/whatsapp");
const panelRouter = require("./routes/panel");
const { correrPipelineMensual } = require("./services/pipeline");
const { registrarNumero } = require("./services/db");

const app = express();
app.use(express.json());

app.use("/whatsapp", whatsappRouter);
app.use("/panel", panelRouter);

// Los endpoints /admin/* mutan datos o exponen informacion sensible
// (registrar-numero decide quien puede consultar las horas de quien).
// Exigimos un header x-admin-key que solo el administrador conoce.
function requireAdminKey(req, res, next) {
  const key = req.get("x-admin-key");
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ ok: false, error: "No autorizado" });
  }
  next();
}

// Endpoint manual para probar el pipeline sin esperar al cron.
app.post("/admin/generar-ahora", requireAdminKey, async (req, res) => {
  try {
    const resultado = await correrPipelineMensual();
    res.json({ ok: true, ...resultado, filas: undefined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint para dar de alta el numero de whatsapp de un empleado.
app.post("/admin/registrar-numero", requireAdminKey, (req, res) => {
  const { numero, empleado } = req.body;
  if (!numero || !empleado) return res.status(400).json({ ok: false, error: "Faltan numero o empleado" });
  registrarNumero(numero, empleado);
  res.json({ ok: true });
});

// Sirve el excel generado para que Twilio lo pueda descargar y mandarlo
// como documento de WhatsApp (mediaUrl tiene que ser una URL publica).
// Protegido con la misma ADMIN_API_KEY, pero por query param en vez de
// header porque Twilio hace un GET simple sin headers custom.
app.get("/files/:nombre", (req, res) => {
  if (!process.env.ADMIN_API_KEY || req.query.key !== process.env.ADMIN_API_KEY) {
    return res.status(401).send("No autorizado");
  }
  const nombre = path.basename(req.params.nombre);
  if (!nombre.endsWith(".xlsx")) return res.status(400).send("Nombre invalido");
  res.sendFile(path.join(__dirname, "data", nombre), (err) => {
    if (err && !res.headersSent) res.status(404).send("No encontrado");
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  iniciarCron();
});
