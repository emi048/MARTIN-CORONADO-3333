require("dotenv").config();
const { registrarNumero } = require("../lib/db");
const empleados = require("../data/empleados-whatsapp");

let cargados = 0;
empleados.forEach(({ numero, empleado }) => {
  registrarNumero(numero, empleado);
  console.log(`✓ ${empleado} -> ${numero}`);
  cargados++;
});

console.log(`\nListo: ${cargados} números cargados.`);
console.log("Recordá completar el de Aaron Garcen en data/empleados-whatsapp.js y volver a correr este script.");
