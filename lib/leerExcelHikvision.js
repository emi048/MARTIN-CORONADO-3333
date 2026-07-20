const XLSX = require("xlsx");
const { normalizarNombre, todosLosEmpleados } = require("./motorCalculo");

// Respaldo: si algún mes la API de HikCentral falla o preferís subir el
// Excel exportado a mano (como hacías hasta ahora), esta función lo lee
// igual que el HTML original y devuelve [{ empleado, hora: Date }].
function leerExcelHikvision(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });

  let headerRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some(c => String(c).trim() === "Nombre")) { headerRow = i; break; }
  }
  if (headerRow < 0) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].some(c => String(c).trim().toLowerCase() === "nombre")) { headerRow = i; break; }
    }
  }
  if (headerRow < 0) return null;

  const headers = rows[headerRow].map(c => String(c).trim());
  const idxNombre = headers.findIndex(h => h === "Nombre");
  const idxApellido = headers.findIndex(h => h === "Apellido");
  const idxHora = headers.findIndex(h => h === "Hora");
  if (idxNombre < 0 || idxApellido < 0 || idxHora < 0) return null;

  const registros = [];
  const todos = todosLosEmpleados();

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    const nombre = String(row[idxNombre] || "").trim();
    const apellido = String(row[idxApellido] || "").trim();
    const horaRaw = row[idxHora];
    if (!nombre || !apellido || !horaRaw || nombre === "None") continue;

    const nombreCompleto = nombre + " " + apellido;
    const empMatch = todos.find(e => normalizarNombre(e) === normalizarNombre(nombreCompleto));
    if (!empMatch) continue;

    let hora;
    const horaStr = String(horaRaw).trim();
    if (typeof horaRaw === "number") {
      hora = new Date(Math.round((horaRaw - 25569) * 86400 * 1000));
    } else if (horaStr.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) {
      const [datePart, timePart] = horaStr.split(" ");
      hora = new Date(datePart + "T" + timePart);
    } else {
      hora = new Date(horaStr);
    }
    if (isNaN(hora.getTime())) continue;
    registros.push({ empleado: empMatch, hora });
  }
  return registros;
}

module.exports = { leerExcelHikvision };
