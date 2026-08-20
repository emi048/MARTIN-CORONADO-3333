const XLSX = require("xlsx");
const { getSectorDeEmpleado } = require("./motorCalculo");

function generarExcel(filas, resumen) {
  const wb = XLSX.utils.book_new();

  const sH = {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Arial" },
    fill: { fgColor: { rgb: "1F4E79" } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } }
  };
  const sHv = { ...sH, fill: { fgColor: { rgb: "375623" } } };
  const sB = {
    font: { sz: 10, name: "Arial" },
    alignment: { horizontal: "center", vertical: "center" },
    border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } }
  };

  const C_FER = "FFF2CC", C_FD = "FFD966", C_SAB = "DEEAF1", C_REV = "FCE4D6", C_ALT = "F2F2F2", C_BL = "FFFFFF";

  const headers1 = ["Empleado", "Fecha", "Turno", "Ingreso", "Egreso", "Hs. Trabajadas", "Hs. Extra 50%", "Hs. Extra 100%", "Observación"]
    .map(h => ({ v: h, s: sH }));
  const cols1 = [28, 14, 10, 10, 10, 14, 13, 14, 30].map(w => ({ wch: w }));

  const buildSheetData = (filasSector) => {
    const data = [headers1];
    filasSector.forEach((f, idx) => {
      const bgBase = f.esFeriado || f.esDomingo ? C_FER : f.esSabado ? C_SAB
        : f.alerta.includes("REVISAR") ? C_REV
          : idx % 2 === 0 ? C_BL : C_ALT;
      const c = (v, bg, bold, left) => ({
        v, s: {
          ...sB,
          fill: { fgColor: { rgb: bg || bgBase } },
          alignment: { horizontal: left ? "left" : "center", vertical: "center" },
          font: { ...sB.font, bold: !!bold, color: { rgb: bg === C_FD ? "7F4C00" : "000000" } }
        }
      });
      data.push([
        c(f.empleado, bgBase, true, true),
        c(f.fecha, f.esFeriado ? C_FD : bgBase, f.esFeriado, false),
        c(f.turno), c(f.ingreso), c(f.egreso),
        c(f.totalHs), c(f.h50), c(f.h100),
        c(f.alerta, f.alerta ? C_REV : bgBase, !!f.alerta, true),
      ]);
    });
    return data;
  };

  const filasMantenimiento = filas.filter(f => getSectorDeEmpleado(f.empleado) === "mantenimiento");
  const filasConserjeria   = filas.filter(f => getSectorDeEmpleado(f.empleado) === "conserjeria");

  const wsM = XLSX.utils.aoa_to_sheet(buildSheetData(filasMantenimiento));
  wsM["!cols"] = cols1; wsM["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsM, "Mantenimiento");

  const wsC = XLSX.utils.aoa_to_sheet(buildSheetData(filasConserjeria));
  wsC["!cols"] = cols1; wsC["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsC, "Conserjería");

  const ws2Data = [];
  ws2Data.push(["Sector", "Empleado", "Días Trabajados", "Total Hs. Trabajadas", "Total Hs. Extra 50%", "Total Hs. Extra 100%"]
    .map(h => ({ v: h, s: sHv })));

  const sectorLabels = { mantenimiento: "MANTENIMIENTO", conserjeria: "CONSERJERÍA" };
  const sectorColors = { mantenimiento: "1F4E79", conserjeria: "7F6000" };
  const sectorBgLight = { mantenimiento: "DEEAF1", conserjeria: "FFF2CC" };

  for (const [sectorKey, sectorNombre] of Object.entries(sectorLabels)) {
    const miembros = resumen.filter(r => r.sector === sectorKey);
    if (miembros.length === 0) continue;

    const sColorBg = sectorColors[sectorKey];
    const sH2 = {
      font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10, name: "Arial" },
      fill: { fgColor: { rgb: sColorBg } },
      alignment: { horizontal: "left", vertical: "center" },
      border: { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } }
    };
    ws2Data.push([{ v: sectorNombre, s: sH2 }, { v: "", s: sH2 }, { v: "", s: sH2 }, { v: "", s: sH2 }, { v: "", s: sH2 }, { v: "", s: sH2 }]);

    miembros.forEach((r, idx) => {
      const bg = sectorBgLight[sectorKey];
      const bgAlt = idx % 2 === 0 ? C_BL : bg;
      ws2Data.push([
        { v: "", s: { ...sB, fill: { fgColor: { rgb: bgAlt } } } },
        { v: r.empleado, s: { ...sB, fill: { fgColor: { rgb: bgAlt } }, alignment: { horizontal: "left" }, font: { ...sB.font, bold: true } } },
        { v: r.dias, s: { ...sB, fill: { fgColor: { rgb: bgAlt } } } },
        { v: r.totalHs, s: { ...sB, fill: { fgColor: { rgb: bgAlt } } } },
        { v: r.h50, s: { ...sB, fill: { fgColor: { rgb: bgAlt } } } },
        { v: r.h100, s: { ...sB, fill: { fgColor: { rgb: bgAlt } } } },
      ]);
    });

    const totFnS = k => miembros.reduce((a, r) => a + r[k], 0);
    ws2Data.push([
      { v: `Subtotal ${sectorNombre}`, s: { ...sH, fill: { fgColor: { rgb: sColorBg } }, font: { ...sH.font, sz: 9 } } },
      { v: "", s: { ...sH, fill: { fgColor: { rgb: sColorBg } } } },
      { v: totFnS("dias"), s: { ...sH, fill: { fgColor: { rgb: sColorBg } } } },
      { v: Math.round(totFnS("totalHs") * 100) / 100, s: { ...sH, fill: { fgColor: { rgb: sColorBg } } } },
      { v: Math.round(totFnS("h50") * 100) / 100, s: { ...sH, fill: { fgColor: { rgb: sColorBg } } } },
      { v: Math.round(totFnS("h100") * 100) / 100, s: { ...sH, fill: { fgColor: { rgb: sColorBg } } } },
    ]);
  }

  const totFn = k => resumen.reduce((a, r) => a + r[k], 0);
  ws2Data.push([
    { v: "TOTALES GENERALES", s: { ...sH } }, { v: "", s: { ...sH } },
    { v: totFn("dias"), s: { ...sH } },
    { v: Math.round(totFn("totalHs") * 100) / 100, s: { ...sH } },
    { v: Math.round(totFn("h50") * 100) / 100, s: { ...sH } },
    { v: Math.round(totFn("h100") * 100) / 100, s: { ...sH } },
  ]);

  const ws2 = XLSX.utils.aoa_to_sheet(ws2Data);
  ws2["!cols"] = [18, 28, 16, 20, 18, 18].map(w => ({ wch: w }));
  ws2["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws2, "Resumen por Sector");

  return XLSX.write(wb, { bookType: "xlsx", type: "buffer", cellStyles: true });
}

module.exports = { generarExcel };
