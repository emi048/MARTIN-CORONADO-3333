const { filasRecientes } = require("./db");
const { getSectorDeEmpleado } = require("./motorCalculo");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatoFechaLarga(fechaISO) {
  const [y, m, d] = fechaISO.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${dias[dt.getDay()]} ${d} de ${meses[m - 1]}`;
}

// Agrupa filas -> [{ fecha, porSector: { mantenimiento: [fila...], conserjeria: [fila...] } }]
// ordenado con la fecha mas reciente primero (ya vienen asi de filasRecientes).
function agruparPorDiaYSector(filas) {
  const porFecha = new Map();
  for (const f of filas) {
    if (!porFecha.has(f.fecha)) porFecha.set(f.fecha, { mantenimiento: [], conserjeria: [] });
    const sector = getSectorDeEmpleado(f.empleado);
    if (sector) porFecha.get(f.fecha)[sector].push(f);
  }
  return [...porFecha.entries()].map(([fecha, porSector]) => ({ fecha, porSector }));
}

function renderEmpleadoRow(f) {
  const tieneAlerta = !!f.alerta;
  const claseAlerta = tieneAlerta ? " fila--alerta" : "";
  return `
    <div class="fila${claseAlerta}">
      <span class="fila__nombre">${escapeHtml(f.empleado)}</span>
      <span class="fila__turno">${escapeHtml(f.turno || "—")}</span>
      <span class="fila__horas">${escapeHtml(f.ingreso || "—")} – ${escapeHtml(f.egreso || "—")}</span>
      <span class="fila__total">${f.total_hs ?? 0}h</span>
      ${tieneAlerta ? `<span class="fila__badge" title="${escapeHtml(f.alerta)}">⚠</span>` : ""}
    </div>`;
}

function renderColumna(titulo, dias, sectorKey, colorClase) {
  const bloques = dias.map(({ fecha, porSector }) => {
    const filas = porSector[sectorKey];
    if (filas.length === 0) return "";
    return `
      <div class="dia">
        <div class="dia__fecha">${formatoFechaLarga(fecha)}</div>
        <div class="dia__filas">
          ${filas.map(renderEmpleadoRow).join("")}
        </div>
      </div>`;
  }).join("");

  return `
    <section class="columna ${colorClase}">
      <h2 class="columna__titulo">${escapeHtml(titulo)}</h2>
      <div class="columna__cuerpo">
        ${bloques || `<p class="vacio">Sin datos todavía.</p>`}
      </div>
    </section>`;
}

function generarPaginaTurnos(limiteDias = 14) {
  const filas = filasRecientes(limiteDias);
  const dias = agruparPorDiaYSector(filas);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Turnos</title>
<style>
  :root {
    --bg: #f4f5f7;
    --panel: #ffffff;
    --texto: #1a1d23;
    --texto-sec: #6b7280;
    --borde: #e5e7eb;
    --mant: #1f4e79;
    --mant-bg: #eaf2fa;
    --cons: #7f6000;
    --cons-bg: #fdf6e3;
    --alerta: #d64545;
    --alerta-bg: #fdecec;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--texto);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    padding: 24px 16px 60px;
  }
  h1 {
    text-align: center;
    font-size: 22px;
    margin: 0 0 4px;
  }
  .subtitulo {
    text-align: center;
    color: var(--texto-sec);
    font-size: 13px;
    margin: 0 0 28px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    max-width: 1100px;
    margin: 0 auto;
  }
  @media (max-width: 760px) {
    .grid { grid-template-columns: 1fr; }
  }
  .columna {
    background: var(--panel);
    border-radius: 14px;
    border: 1px solid var(--borde);
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .columna__titulo {
    margin: 0;
    padding: 16px 18px;
    font-size: 15px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: #fff;
  }
  .columna--mant .columna__titulo { background: var(--mant); }
  .columna--cons .columna__titulo { background: var(--cons); }
  .columna__cuerpo {
    padding: 10px 14px 18px;
  }
  .dia {
    margin-top: 16px;
  }
  .dia:first-child { margin-top: 12px; }
  .dia__fecha {
    font-size: 12px;
    font-weight: 700;
    text-transform: capitalize;
    color: var(--texto-sec);
    padding: 4px 6px;
    border-bottom: 1px solid var(--borde);
    margin-bottom: 6px;
  }
  .columna--mant .dia__fecha { color: var(--mant); }
  .columna--cons .dia__fecha { color: var(--cons); }
  .fila {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 6px;
    border-radius: 8px;
  }
  .fila:nth-child(even) { background: rgba(0,0,0,0.02); }
  .columna--mant .fila:nth-child(even) { background: var(--mant-bg); }
  .columna--cons .fila:nth-child(even) { background: var(--cons-bg); }
  .fila--alerta { background: var(--alerta-bg) !important; }
  .fila__nombre {
    font-weight: 700;
    font-size: 14px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fila__turno {
    font-size: 11px;
    color: var(--texto-sec);
    background: rgba(0,0,0,0.06);
    padding: 2px 8px;
    border-radius: 999px;
    flex: 0 0 auto;
  }
  .fila__horas {
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    color: var(--texto-sec);
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .fila__total {
    font-weight: 700;
    font-size: 13px;
    flex: 0 0 auto;
    min-width: 32px;
    text-align: right;
  }
  .fila__badge {
    flex: 0 0 auto;
    color: var(--alerta);
    font-weight: 700;
    cursor: help;
  }
  .vacio {
    color: var(--texto-sec);
    font-size: 13px;
    padding: 12px 6px;
  }
</style>
</head>
<body>
  <h1>Turnos</h1>
  <p class="subtitulo">Últimos ${dias.length} días con fichadas — más reciente arriba</p>
  <div class="grid">
    ${renderColumna("Mantenimiento", dias, "mantenimiento", "columna--mant")}
    ${renderColumna("Conserjería", dias, "conserjeria", "columna--cons")}
  </div>
</body>
</html>`;
}

module.exports = { generarPaginaTurnos };
