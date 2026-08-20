require("dotenv").config();
const { correrPipelineMensual } = require("../services/pipeline");

correrPipelineMensual()
  .then(({ filas, alertasTotal, nombreArchivo }) => {
    console.log(`OK: ${nombreArchivo} — ${filas.length} días procesados, ${alertasTotal} alertas.`);
    process.exit(0);
  })
  .catch(err => {
    console.error("Error:", err);
    process.exit(1);
  });
