// ─────────────────────────────────────────────────────────────
// Motor de calculo de horas — portado 1:1 desde final.html
// Toda esta logica es la misma que ya usás y validaste a mano.
// Si el dia de mañana cambian una regla de negocio (feriados,
// horas de contrato, etc), se edita ACA y se refleja tanto en
// el mail automatico como en lo que responde el bot de WhatsApp.
// ─────────────────────────────────────────────────────────────

const FERIADOS = new Set([
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-03-24", "2026-04-02", "2026-04-03",
  "2026-05-01", "2026-05-25", "2026-06-15", "2026-06-20", "2026-07-09", "2026-08-17",
  "2026-10-12", "2026-11-23", "2026-12-08", "2026-12-25"
]);
// TODO: cargar feriados de años siguientes (o consumir una API de feriados AR)

// Dias de evento puntual para un empleado especifico: las horas que superan
// su contrato normal de ese dia van directo a extra 100% (no a 50%), igual
// criterio que un domingo pero sin ser domingo. Se carga a mano caso por
// caso (clave "Empleado|YYYY-MM-DD") cuando el admin confirma que hubo un
// evento real, no es algo que se detecte solo.
const EVENTOS = new Set([
  "Lisa Rios|2026-07-15",
  "Angel Cabrera|2026-07-03",
  "Leonel Babino|2026-07-15",
]);

function esDiaDeEvento(empleado, fechaISO) {
  return EVENTOS.has(empleado + "|" + fechaISO);
}

const TURNOS_FIJOS_CONSERJERIA = {
  "Lisa Rios":              { turno: "Mañana", inMin: 7 * 60,  outMin: 15 * 60, horasDia: 9, horasSab: 0, horasViernes: 8 },
  "Martin Torres":          { turno: "Mañana", inMin: 7 * 60,  outMin: 15 * 60, horasDia: 8, horasSab: 4 },
  "Maria Benitez Morinigo": { turno: "Tarde",  inMin: 14 * 60, outMin: 22 * 60, horasDia: 8, horasSab: 4, horasContratoDomingo: 4 },
  "Sebastian Galeano":      { turno: "Tarde",  inMin: 14 * 60, outMin: 22 * 60, horasDia: 8, horasSab: 4, horasContratoDomingo: 4 },
  "Yesica Alcaraz":         { turno: "Tarde",  inMin: 14 * 60, outMin: 22 * 60, horasDia: 8, horasSab: 4 },
  "Veronica Montenegro":    { turno: "Mañana", inMin: 7 * 60,  outMin: 15 * 60, horasDia: 8, horasSab: 4 },
  "Aaron Garcen":           { turno: "Noche",  inMin: 22 * 60, outMin: 6 * 60,  horasDia: 8, horasSab: 4 },
};

const ROTATIVOS_A = ["Diego Lastra", "Victor Cartaman"];
const ROTATIVOS_B = ["Alberto Reynoso", "Angel Cabrera"];

// TODO: mover esto a la base de datos (tabla `empleados`) para poder
// agregar/quitar gente sin tocar codigo. Lo dejo hardcodeado por ahora
// para que el comportamiento sea identico al HTML actual.
const SECTORES = {
  mantenimiento: ["Emiliano Badaracco", "Leonel Babino", "Diego Lastra", "Victor Cartaman", "Alberto Reynoso", "Angel Cabrera"],
  conserjeria:   ["Lisa Rios", "Martin Torres", "Sebastian Galeano", "Maria Benitez Morinigo", "Aaron Garcen", "Yesica Alcaraz", "Veronica Montenegro"],
};

function normalizarNombre(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function getSectorDeEmpleado(nombre) {
  const n = normalizarNombre(nombre);
  for (const [sector, lista] of Object.entries(SECTORES)) {
    if (lista.some(e => normalizarNombre(e) === n)) return sector;
  }
  return null;
}

function todosLosEmpleados() {
  return Object.values(SECTORES).flat();
}

function dateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function detectarTurno(horaEntrada, cfgMIn, cfgTIn) {
  const h = horaEntrada.getHours() * 60 + horaEntrada.getMinutes();
  const umbral = (cfgMIn + cfgTIn) / 2;
  return h < umbral ? "Mañana" : "Tarde";
}

function calcularHoras(fecha, dtEntrada, dtSalida, cfg, esEvento = false) {
  const dateStr = dateKey(fecha);
  const esFeriado = FERIADOS.has(dateStr);
  const diaSem = fecha.getDay();
  const esDomingo = diaSem === 0;
  const esSabado = diaSem === 6;

  const redondear = dt => {
    const r = new Date(dt);
    if (r.getMinutes() >= 30) { r.setHours(r.getHours() + 1, 0, 0, 0); }
    else { r.setMinutes(0, 0, 0); }
    return r;
  };
  dtEntrada = redondear(dtEntrada);
  dtSalida  = redondear(dtSalida);

  const totalHs = Math.max(0, (dtSalida - dtEntrada) / 3600000);
  let h50 = 0, h100 = 0;

  const esViernes = diaSem === 5;
  const horasContratoHoy = cfg.horasContratoDomingo !== undefined && esDomingo
    ? cfg.horasContratoDomingo
    : esSabado ? cfg.horasSab
    : (cfg.horasViernes !== undefined && esViernes) ? cfg.horasViernes
    : cfg.horasDia;

  if (esFeriado) {
    h100 = totalHs;
  } else if (esDomingo) {
    const extra = Math.max(0, totalHs - horasContratoHoy);
    h100 = extra;
  } else if (esSabado) {
    const sobreContrato = Math.max(0, totalHs - horasContratoHoy);
    if (sobreContrato > 0) {
      const dt13 = new Date(fecha); dt13.setHours(13, 0, 0, 0);
      const dtInicioExtra = new Date(dtEntrada.getTime() + horasContratoHoy * 3600000);
      if (dtInicioExtra >= dt13)      h100 = sobreContrato;
      else if (dtSalida <= dt13)      h50  = sobreContrato;
      else {
        h50  = Math.max(0, (dt13 - dtInicioExtra) / 3600000);
        h100 = Math.max(0, (dtSalida - dt13) / 3600000);
      }
    }
  } else if (esEvento) {
    // Dia de evento puntual (ver EVENTOS mas arriba): las horas que superan
    // el contrato normal del dia van a extra 100% (igual criterio que un
    // domingo, sin serlo), pero con un piso de 8hs — un evento paga 8hs al
    // 100% como minimo aunque el calculo real de mas puntual, y si se
    // trabajaron mas horas de las que da ese piso, se respeta el numero real.
    h100 = Math.max(totalHs - horasContratoHoy, 8);
  } else {
    // Extra al 50% = horas totales del dia por encima de lo que le toca ese
    // dia — mismo criterio para todos (antes, a los de turno fijo se les
    // calculaba distinto: horas fuera de la ventana de su turno, sin restar
    // nada por haber llegado tarde. Eso podia darle horas extra a alguien
    // que en neto trabajo MENOS que su turno completo, si llegaba tarde y
    // se quedaba un rato despues — o directamente contarle todo el dia como
    // extra si trabajo un horario que no se solapa con su turno asignado).
    h50 = Math.max(0, totalHs - horasContratoHoy);
  }

  return {
    totalHs: Math.round(totalHs * 100) / 100,
    h50:     Math.round(h50  * 100) / 100,
    h100:    Math.round(h100 * 100) / 100,
    esFeriado, esDomingo, esSabado
  };
}

// Recibe registros crudos ya normalizados: [{ empleado, hora: Date }]
// (sea que vengan de un Excel de Hikvision o directo de la API OpenAPI)
// y devuelve las filas procesadas + el resumen por empleado, igual que
// hacia el boton "Generar fichero" del HTML.
function procesarRegistros(registros, rotacionInicialMañana = "A") {
  const cfg = {
    mañanaIn: 7 * 60, mañanaOut: 15 * 60,
    tardeIn: 13 * 60, tardeOut: 21 * 60,
    horasDia: 9, horasSab: 0, horasContratoDomingo: 0,
  };

  const mapa = {};
  const esNoche = (emp) => normalizarNombre(emp) === normalizarNombre("Aaron Garcen");
  const registrosAaron = registros.filter(r => esNoche(r.empleado));
  const registrosResto = registros.filter(r => !esNoche(r.empleado));

  if (registrosAaron.length > 0) {
    registrosAaron.sort((a, b) => a.hora - b.hora);
    let i = 0;
    while (i < registrosAaron.length) {
      const r = registrosAaron[i];
      const h = r.hora.getHours();
      if (h >= 19) {
        const fechaBase = new Date(r.hora); fechaBase.setHours(0, 0, 0, 0);
        const key = "Aaron Garcen|" + dateKey(fechaBase);
        if (!mapa[key]) mapa[key] = { empleado: "Aaron Garcen", fecha: fechaBase, horas: [] };
        mapa[key].horas.push(r.hora);
        if (i + 1 < registrosAaron.length) {
          const siguiente = registrosAaron[i + 1];
          if (siguiente.hora.getHours() < 10) {
            mapa[key].horas.push(siguiente.hora);
            i += 2; continue;
          }
        }
      } else if (h < 10) {
        const fechaBase = new Date(r.hora);
        fechaBase.setDate(fechaBase.getDate() - 1);
        fechaBase.setHours(0, 0, 0, 0);
        const key = "Aaron Garcen|" + dateKey(fechaBase);
        if (!mapa[key]) mapa[key] = { empleado: "Aaron Garcen", fecha: fechaBase, horas: [] };
        mapa[key].horas.push(r.hora);
      } else {
        const fechaBase = new Date(r.hora); fechaBase.setHours(0, 0, 0, 0);
        const key = "Aaron Garcen|" + dateKey(fechaBase);
        if (!mapa[key]) mapa[key] = { empleado: "Aaron Garcen", fecha: fechaBase, horas: [] };
        mapa[key].horas.push(r.hora);
      }
      i++;
    }
  }

  registrosResto.forEach(r => {
    const fecha = new Date(r.hora); fecha.setHours(0, 0, 0, 0);
    const key = r.empleado + "|" + dateKey(fecha);
    if (!mapa[key]) mapa[key] = { empleado: r.empleado, fecha, horas: [] };
    mapa[key].horas.push(r.hora);
  });

  // Fusiona un caso puntual que le puede pasar a cualquiera (no solo a
  // Aaron, que ya tiene turno nocturno fijo arriba): un dia con un unico
  // fichaje sin cerrar, seguido al dia siguiente de un unico fichaje de
  // madrugada — es la salida real de un turno que se extendio pasada la
  // medianoche (ej: un evento puntual), no dos dias sueltos sin datos.
  const UMBRAL_MADRUGADA = 5;
  const empleadosResto = [...new Set(registrosResto.map(r => r.empleado))];
  empleadosResto.forEach(emp => {
    const claves = Object.keys(mapa)
      .filter(k => mapa[k] && mapa[k].empleado === emp)
      .sort((a, b) => mapa[a].fecha - mapa[b].fecha);

    for (let i = 0; i < claves.length - 1; i++) {
      const grupoHoy = mapa[claves[i]];
      const grupoManana = mapa[claves[i + 1]];
      if (!grupoHoy || !grupoManana) continue;
      if (grupoManana.fecha - grupoHoy.fecha !== 86400000) continue;
      if (grupoHoy.horas.length !== 1 || grupoManana.horas.length !== 1) continue;
      if (grupoManana.horas[0].getHours() >= UMBRAL_MADRUGADA) continue;

      grupoHoy.horas.push(grupoManana.horas[0]);
      delete mapa[claves[i + 1]];
    }
  });

  let minDate = null;
  Object.values(mapa).forEach(grupo => { if (!minDate || grupo.fecha < minDate) minDate = grupo.fecha; });
  const semanaBase = minDate ? getISOWeek(minDate) : 0;

  const esRotativoA = (nombre) => ROTATIVOS_A.some(r => normalizarNombre(r) === normalizarNombre(nombre));
  const esRotativoB = (nombre) => ROTATIVOS_B.some(r => normalizarNombre(r) === normalizarNombre(nombre));

  const filas = [];
  let alertasTotal = 0;

  Object.values(mapa).forEach(grupo => {
    grupo.horas.sort((a, b) => a - b);
    const n = grupo.horas.length;
    const dtEntrada = grupo.horas[0];
    const dtSalida = grupo.horas[n - 1];

    let alerta = "";
    if (n === 1) alerta = "⚠ Solo 1 registro (sin egreso)";
    else if (n > 2) { alerta = "🔍 REVISAR MANUALMENTE"; alertasTotal++; }

    let turnoAsignadoStr = null;
    let cfgEmpleado = cfg;

    const turnoFijo = Object.keys(TURNOS_FIJOS_CONSERJERIA).find(
      nm => normalizarNombre(nm) === normalizarNombre(grupo.empleado)
    );
    if (turnoFijo) {
      const tf = TURNOS_FIJOS_CONSERJERIA[turnoFijo];
      turnoAsignadoStr = tf.turno;
      cfgEmpleado = {
        ...cfg,
        mañanaIn: tf.inMin, mañanaOut: tf.outMin,
        tardeIn: tf.inMin, tardeOut: tf.outMin,
        horasDia: tf.horasDia ?? cfg.horasDia,
        horasSab: tf.horasSab ?? cfg.horasSab,
        ...(tf.horasContratoDomingo !== undefined ? { horasContratoDomingo: tf.horasContratoDomingo } : {}),
        ...(tf.horasViernes !== undefined ? { horasViernes: tf.horasViernes } : {}),
      };
    } else {
      const empEsRotativoA = esRotativoA(grupo.empleado);
      const empEsRotativoB = esRotativoB(grupo.empleado);
      if ((empEsRotativoA || empEsRotativoB) && minDate) {
        const semActual = getISOWeek(grupo.fecha);
        const diff = semActual - semanaBase;
        const esPar = diff % 2 === 0;
        const grupoEmp = empEsRotativoA ? "A" : "B";
        let esMañanaAhora = esPar ? (grupoEmp === rotacionInicialMañana) : (grupoEmp !== rotacionInicialMañana);
        turnoAsignadoStr = esMañanaAhora ? "Mañana" : "Tarde";
      }
    }

    const turno = turnoAsignadoStr || detectarTurno(dtEntrada, cfgEmpleado.mañanaIn, cfgEmpleado.tardeIn);
    const calc = n >= 2 ? calcularHoras(grupo.fecha, dtEntrada, dtSalida, cfgEmpleado, esDiaDeEvento(grupo.empleado, dateKey(grupo.fecha))) : null;

    const d = grupo.fecha;
    const fechaStr = String(d.getDate()).padStart(2, "0") + "--" +
      String(d.getMonth() + 1).padStart(2, "0") + "--" + d.getFullYear();

    filas.push({
      empleado: grupo.empleado,
      fecha: fechaStr,
      _fechaReal: grupo.fecha,
      turno,
      ingreso: dtEntrada.toTimeString().slice(0, 5),
      egreso: n >= 2 ? dtSalida.toTimeString().slice(0, 5) : "—",
      totalHs: calc ? calc.totalHs : 0,
      h50: calc ? calc.h50 : 0,
      h100: calc ? calc.h100 : 0,
      esFeriado: calc ? calc.esFeriado : false,
      esDomingo: calc ? calc.esDomingo : (grupo.fecha.getDay() === 0),
      esSabado: calc ? calc.esSabado : (grupo.fecha.getDay() === 6),
      alerta,
    });
  });

  filas.sort((a, b) => a.empleado.localeCompare(b.empleado) || a._fechaReal - b._fechaReal);

  const resumen = todosLosEmpleados().map(emp => {
    const sub = filas.filter(f => normalizarNombre(f.empleado) === normalizarNombre(emp));
    return {
      empleado: emp,
      sector: getSectorDeEmpleado(emp),
      dias: sub.length,
      totalHs: Math.round(sub.reduce((a, f) => a + f.totalHs, 0) * 100) / 100,
      h50: Math.round(sub.reduce((a, f) => a + f.h50, 0) * 100) / 100,
      h100: Math.round(sub.reduce((a, f) => a + f.h100, 0) * 100) / 100,
      alertas: sub.filter(f => f.alerta).length,
    };
  });

  return { filas, resumen, alertasTotal };
}

module.exports = {
  normalizarNombre, getSectorDeEmpleado, todosLosEmpleados, dateKey, getISOWeek,
  calcularHoras, detectarTurno, procesarRegistros, SECTORES, FERIADOS, TURNOS_FIJOS_CONSERJERIA,
  esDiaDeEvento,
};
