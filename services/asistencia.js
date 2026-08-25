// Calculo compartido de "como le fue a un empleado en un periodo": dias
// trabajados (con llegadas tarde marcadas), ausencias (con el compensado de
// sabado), y el deficit de sabado -- usado tanto por el panel de admin
// (GET /panel/api/dias) como por la app de empleado (GET /app/api/mis-fichadas),
// para no duplicar esta logica (ya tuvo varios bugs encontrados y corregidos
// en un solo lugar -- duplicarla arriesga que se corrija en uno y no en el otro).
const { filasDelPeriodoDeEmpleado, rangoFechasDelPeriodo, esEventoRegistrado } = require("./db");
const { FERIADOS, calcularDeficitSabadoSemanal } = require("./motorCalculo");
const { turnoRealDelDia, esDelEquipo: esDelEquipoMantenimiento } = require("./turnosMantenimiento");
const { turnoDelDia: turnoConserjeriaDelDia, EQUIPO: EQUIPO_CONSERJERIA } = require("./turnosConserjeria");

function fechaISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const ETIQUETA_TURNO = {
  mañana: "Mañana", tarde: "Tarde", sabado_corto: "Sábado corto", sabado_largo: "Sábado largo",
  domingo: "Domingo", franco: "Franco", descanso: "Descanso",
};
const TOLERANCIA_TARDE_MIN = 30;

function minutosDesdeMedianoche(horaStr) {
  if (!horaStr) return null;
  const [h, m] = horaStr.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function calcularAsistencia(empleado, periodo) {
  const rango = rangoFechasDelPeriodo(periodo);
  const diasCrudos = filasDelPeriodoDeEmpleado(empleado, periodo);

  const esMantenimiento = esDelEquipoMantenimiento(empleado);
  const esConserjeria = Object.prototype.hasOwnProperty.call(EQUIPO_CONSERJERIA, empleado);

  // Martin Torres: el dia siguiente a un evento/poker entra a las 9 en vez
  // de las 7 (se queda hasta tarde la noche anterior) -- no se lo marca
  // como llegada tarde, se corre el horario esperado ese dia puntual. Solo
  // el aplica esta excepcion, nadie mas.
  const turnoEsperadoDelDia = (fecha) => {
    const turno = esMantenimiento ? turnoRealDelDia(empleado, fecha) : turnoConserjeriaDelDia(empleado, fecha);
    if (empleado === "Martin Torres" && turno && turno.horario) {
      const ayerDeFecha = new Date(fecha);
      ayerDeFecha.setDate(ayerDeFecha.getDate() - 1);
      if (esEventoRegistrado(empleado, fechaISO(ayerDeFecha))) {
        return { ...turno, horario: { ...turno.horario, in: "09:00" } };
      }
    }
    return turno;
  };

  // Mantenimiento con horario conocido + Lisa Rios: quien no cubrio, de
  // lunes a viernes, las 4hs de contrato del sabado (ver
  // calcularDeficitSabadoSemanal en motorCalculo.js para la regla completa).
  // Se calcula antes que las ausencias para poder distinguir, en el sabado
  // que falta la fila, si fue compensado durante la semana (deficit=0 esa
  // semana) o si realmente falto sin cubrir.
  const enReglaSabado = esMantenimiento || empleado === "Lisa Rios";
  const deficitSabado = enReglaSabado
    ? calcularDeficitSabadoSemanal(diasCrudos.map((d) => ({ empleado: d.empleado, fecha: d.fecha, totalHs: d.total_hs })))
    : [];
  const semanasConDeficit = new Set(deficitSabado.map((d) => d.semanaLunes));

  // Dias en que le tocaba trabajar (segun la formula de su equipo) pero no
  // hay ninguna fila cargada -- se mandan aparte como "ausencias" para que
  // el front los resalte sin confundirlos con un fichaje incompleto (eso ya
  // lo indica la alerta de la fila). Solo se puede calcular para los
  // equipos con formula de turno conocida (mantenimiento y conserjeria);
  // gente sin horario fijo (ej. Aaron Garcen) no tiene con que comparar,
  // asi que no se le marca nada.
  const ausencias = [];
  if (rango && (esMantenimiento || esConserjeria)) {
    const fechasConFila = new Set(diasCrudos.map((d) => d.fecha));
    const desde = new Date(rango.desde + "T00:00:00");
    // El chequeo de ausencias llega solo hasta rango.hasta (la ULTIMA fecha
    // con datos cargados, ver rangoFechasDelPeriodo) -- no se extiende mas
    // alla aunque haya pasado mas tiempo real, para no marcar como ausente
    // dias de los que todavia no se cargo ningun excel.
    //
    // CIERRE MANUAL DEL CICLO 2026-08: el admin definio que este fichero
    // cierra el 20/8 (el rango real es 21/7 al 20/8) -- si a alguien le
    // entra un dato suelto de una fecha posterior (ej: una correccion
    // cargada de mas), rango.hasta se corre solo para TODO el periodo
    // (es un MAX global, no por empleado) y arrastra falsas ausencias para
    // el resto. Se tapa con este techo hasta que arranque el proximo ciclo
    // -- borrar este bloque cuando eso pase.
    const CIERRE_CICLO_2026_08 = new Date("2026-08-20T00:00:00");
    let hasta = new Date(rango.hasta + "T00:00:00");
    if (periodo === "2026-08" && hasta > CIERRE_CICLO_2026_08) hasta = CIERRE_CICLO_2026_08;
    for (let f = new Date(desde); f <= hasta; f.setDate(f.getDate() + 1)) {
      const iso = fechaISO(f);
      if (fechasConFila.has(iso)) continue;
      if (FERIADOS.has(iso)) continue; // feriado: no se espera que venga, no es ausencia
      const turno = turnoEsperadoDelDia(f);
      const esDiaLibre = turno && (turno.tipo === "franco" || turno.tipo === "descanso");
      if (!turno || esDiaLibre) continue;

      // Sabado sin fichada, pero esa semana ya cubrio las 4hs de contrato
      // trabajando de mas lunes a viernes -- no es una falta real, se
      // marca compensado en vez de ausente.
      if (f.getDay() === 6 && enReglaSabado) {
        const lunesDeEstaSemana = new Date(f);
        lunesDeEstaSemana.setDate(lunesDeEstaSemana.getDate() - 5);
        if (!semanasConDeficit.has(fechaISO(lunesDeEstaSemana))) {
          ausencias.push({ fecha: iso, turno: turno.tipo, compensado: true });
          continue;
        }
      }
      ausencias.push({ fecha: iso, turno: turno.tipo });
    }
  }

  // Llegadas tarde: entrada mas de 30 min despues del horario de inicio del
  // turno que le tocaba ese dia especifico. El campo "turno" de la fila
  // (filas_diarias) se completa por deteccion automatica a partir del
  // horario de entrada/salida (motorCalculo.js, detectarTurno) y puede
  // confundirse -- para mantenimiento/conserjeria hay una fuente mas
  // confiable (turnoRealDelDia/turnoConserjeriaDelDia), que ya usamos para
  // ausencias y llegadas tarde -- se pisa el turno mostrado con esa, sin
  // tocar las horas ya calculadas (total_hs/h50/h100 siguen siendo las que
  // ya estaban).
  const dias = (esMantenimiento || esConserjeria)
    ? diasCrudos.map((d) => {
      const [y, m, day] = d.fecha.split("-").map(Number);
      const turno = turnoEsperadoDelDia(new Date(y, m - 1, day));
      const turnoCorregido = turno ? (ETIQUETA_TURNO[turno.tipo] || turno.tipo) : d.turno;

      if (!d.ingreso) return { ...d, turno: turnoCorregido };
      const minEsperado = turno && turno.horario ? minutosDesdeMedianoche(turno.horario.in) : null;
      const minReal = minutosDesdeMedianoche(d.ingreso);
      if (minEsperado == null || minReal == null || minReal <= minEsperado + TOLERANCIA_TARDE_MIN) {
        return { ...d, turno: turnoCorregido };
      }
      return { ...d, turno: turnoCorregido, llegadaTarde: true, minutosTarde: minReal - minEsperado, horarioEsperado: turno.horario.in };
    })
    : diasCrudos;

  return { periodo, rango, dias, ausencias, deficitSabado };
}

module.exports = { calcularAsistencia };
