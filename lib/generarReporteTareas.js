const XLSX = require("xlsx");

const ETIQUETA_ESTADO = { pendiente: "Pendiente", hecha: "Hecha", vencida: "Vencida" };

function generarReporteTareas(tareas) {
  const sH = {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Arial" },
    fill: { fgColor: { rgb: "1F4E79" } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
  };
  const sB = {
    font: { sz: 10, name: "Arial" },
    alignment: { horizontal: "left", vertical: "center", wrapText: true },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } },
  };
  const C_HECHA = "E2EFDA", C_VENCIDA = "FCE4D6", C_PENDIENTE = "FFF2CC";
  const bgPorEstado = { hecha: C_HECHA, vencida: C_VENCIDA, pendiente: C_PENDIENTE };

  const headers = ["ID", "Título", "Descripción", "Asignada a", "Estado", "Creada", "Vence", "Completada por", "Completada el", "Con foto"]
    .map((h) => ({ v: h, s: sH }));
  const cols = [6, 28, 34, 18, 12, 14, 14, 18, 14, 10].map((w) => ({ wch: w }));

  const data = [headers];
  tareas.forEach((t) => {
    const bg = bgPorEstado[t.estado] || "FFFFFF";
    const c = (v, centrado) => ({ v: v ?? "", s: { ...sB, fill: { fgColor: { rgb: bg } }, alignment: { ...sB.alignment, horizontal: centrado ? "center" : "left" } } });
    data.push([
      c(t.id, true), c(t.titulo), c(t.descripcion),
      c(t.asignado_a || "Equipo"), c(ETIQUETA_ESTADO[t.estado] || t.estado, true),
      c(t.creado_en ? t.creado_en.slice(0, 16).replace("T", " ") : "", true),
      c(t.vence_en ? t.vence_en.slice(0, 16).replace("T", " ") : "", true),
      c(t.completado_por, true),
      c(t.completado_en ? t.completado_en.slice(0, 16).replace("T", " ") : "", true),
      c(t.foto_path ? "Sí" : "No", true),
    ]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = cols;
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws, "Tareas");

  return XLSX.write(wb, { bookType: "xlsx", type: "buffer", cellStyles: true });
}

module.exports = { generarReporteTareas };
