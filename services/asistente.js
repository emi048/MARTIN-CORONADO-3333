const Anthropic = require("@anthropic-ai/sdk");

// Twilio deja de esperar la respuesta del webhook despues de unos segundos.
// Le damos UN reintento corto (util cuando Anthropic devuelve un error
// transitorio como "Overloaded") sin dejar que el total se vaya de tiempo
// y la respuesta llegue tarde, que es lo que se ve desde afuera como
// "el bot no contesta nada".
const client = new Anthropic({ timeout: 4000, maxRetries: 1 });

const TOOL = {
  name: "interpretar_mensaje",
  description: "Clasifica el mensaje de un empleado y extrae los datos necesarios para responderlo.",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: [
          "consulta_horas", "solicitud_correccion", "consulta_turnos_equipo",
          "consulta_solicitudes", "solicitud_licencia", "solicitud_cambio_turno", "consulta_mural", "no_entendido",
        ],
        description:
          "consulta_horas: pregunta por horas/dias trabajados propios. " +
          "solicitud_correccion: pide agregar/corregir un ingreso o egreso porque se olvido de fichar. " +
          "consulta_turnos_equipo: pregunta quien de mantenimiento o conserjeria trabaja/esta de turno un dia o rango de dias (ej. \"quien labura el finde\"). " +
          "consulta_solicitudes: pregunta por el estado de sus propios pedidos ya hechos (correcciones, licencias, cambios de turno). " +
          "solicitud_licencia: pide licencia o vacaciones para un rango de fechas. " +
          "solicitud_cambio_turno: pide cambiar su turno de un dia por el de un companero en otro dia. " +
          "consulta_mural: pregunta que tareas o comunicados hay pendientes/publicados en el Mural del equipo. " +
          "no_entendido: cualquier otra cosa.",
      },
      completo: {
        type: "boolean",
        description: "Para solicitud_correccion, solicitud_licencia o solicitud_cambio_turno: true si se pudieron extraer todos los datos necesarios para esa solicitud puntual; false si falta algun dato.",
      },
      pregunta: {
        type: "string",
        description: "Si completo es false: pregunta corta en español pidiendo el dato especifico que falta.",
      },
      fecha: {
        type: "string",
        description: "Si intent es solicitud_correccion y completo es true: fecha del dia a corregir, formato YYYY-MM-DD. Si intent es consulta_horas y el empleado pregunta puntualmente por un dia (no el total del periodo/mes): la fecha de ese dia, mismo formato -- omitir este campo si pregunta por el total.",
      },
      campo: {
        type: "string",
        enum: ["ingreso", "egreso"],
        description: "Solo si intent es solicitud_correccion y completo es true: que horario falta corregir.",
      },
      valor: {
        type: "string",
        description: "Solo si intent es solicitud_correccion y completo es true: la hora correcta, formato HH:MM (24hs).",
      },
      fecha_desde: {
        type: "string",
        description: "Formato YYYY-MM-DD. Si intent es consulta_turnos_equipo: primer dia del rango a consultar. Si intent es solicitud_licencia y completo es true: primer dia de la licencia.",
      },
      fecha_hasta: {
        type: "string",
        description: "Formato YYYY-MM-DD. Si intent es consulta_turnos_equipo: ultimo dia del rango (igual a fecha_desde si es un solo dia). Si intent es solicitud_licencia y completo es true: ultimo dia de la licencia (igual a fecha_desde si es un solo dia).",
      },
      equipo: {
        type: "string",
        enum: ["mantenimiento", "conserjeria"],
        description: "Solo si intent es consulta_turnos_equipo: de que equipo pregunta.",
      },
      tipo_licencia: {
        type: "string",
        enum: ["Vacaciones", "Licencia médica", "Estudio", "Otro"],
        description: "Solo si intent es solicitud_licencia: tipo de licencia. Si no lo menciona explicitamente, usa \"Otro\".",
      },
      cambio_companero: {
        type: "string",
        description: "Solo si intent es solicitud_cambio_turno y completo es true: nombre completo del companero, tomado EXACTO de la lista de companeros validos que se te dio en las instrucciones -- nunca inventes ni adivines un nombre que no este en esa lista.",
      },
      cambio_fecha_propia: {
        type: "string",
        description: "Solo si intent es solicitud_cambio_turno y completo es true: fecha propia que el empleado cede, formato YYYY-MM-DD.",
      },
      cambio_fecha_companero: {
        type: "string",
        description: "Solo si intent es solicitud_cambio_turno y completo es true: fecha del companero que el empleado toma a cambio, formato YYYY-MM-DD.",
      },
      respuesta: {
        type: "string",
        description: "Solo si intent es no_entendido: respuesta breve en español explicando que puede pedirle.",
      },
    },
    required: ["intent"],
    additionalProperties: false,
  },
};

// Clasifica un mensaje entrante de WhatsApp. NO redacta respuestas con datos
// reales (horas, dias) — eso se arma con texto fijo a partir de la base,
// para que la IA nunca invente un numero. Solo se usa para: decidir la
// intencion, extraer los datos de cada caso, y redactar preguntas
// aclaratorias o el mensaje de "no entendido" (texto sin datos sensibles).
// companerosValidos (opcional): nombres completos de con quien ESTE
// empleado puntual puede pedir un cambio de turno (vacio/undefined si no
// aplica -- ahi la IA sabe que no le puede ofrecer esa opcion).
async function interpretarMensaje(texto, { fechaHoy, companerosValidos } = {}) {
  const hoy = fechaHoy || new Date().toISOString().slice(0, 10);

  const contextoCambioTurno = companerosValidos && companerosValidos.length
    ? "Para cambio de turno, este empleado SOLO puede pedirlo con estos companeros (nombres completos exactos): " +
      companerosValidos.join(", ") + ". Si menciona un nombre que no coincide con ninguno de esa lista, marca " +
      "intent solicitud_cambio_turno con completo=false y una pregunta pidiendo que aclare con cual de esos companeros."
    : "Este empleado NO tiene companeros validos para cambio de turno (no es parte del equipo rotativo de mantenimiento). " +
      "Si pide cambiar de turno, marca intent no_entendido y explicale amablemente que esa opcion no aplica para el.";

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system:
      "Sos el asistente de WhatsApp de un sistema de fichaje de asistencia laboral. " +
      "Tu unica tarea es clasificar el mensaje de un empleado y extraer datos estructurados — " +
      "nunca inventes horas, dias, nombres ni ningun dato que el empleado no haya dado. Hoy es " + hoy + ". " +
      "Si el empleado menciona una fecha sin año, asumi el año actual. " +
      "Si dice \"hoy\", \"ayer\" u otra referencia relativa, calculala vos a partir de la fecha de hoy. " +
      "Si dice \"este fin de semana\" o \"este finde\", usa el sabado y domingo mas proximos desde hoy " +
      "(si hoy ya es sabado o domingo, ese mismo es \"este finde\"). Si dice \"el finde que viene\" o " +
      "\"el proximo finde\", usa el sabado y domingo siguientes a ese. " +
      contextoCambioTurno,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "interpretar_mensaje" },
    messages: [{ role: "user", content: texto }],
  });

  const bloque = response.content.find((b) => b.type === "tool_use");
  return bloque ? bloque.input : { intent: "no_entendido", respuesta: "No pude procesar tu mensaje, probá de nuevo." };
}

// Para cuando el empleado manda algo que no es "1"/"2"/"3"/"4" ni "menu".
// Puede ser una boludez/puteada, pero tambien puede ser una consulta real
// (ej: "que significa fichaje incompleto", "como pido la correccion") — el
// mismo llamado distingue el caso y responde distinto: ayuda de verdad si
// es una duda genuina, ironia seca y corta si es una boludez. Devuelve null
// si falla (Anthropic caido/lento) — el que llama cae al mensaje generico
// de "no entendí" en ese caso, nunca deja al empleado sin respuesta.
async function respuestaFueraDeMenu(texto) {
  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 350,
      system:
        "Sos el bot de fichaje de asistencia de una empresa (empleados de mantenimiento y conserjería). " +
        "Un empleado te mandó un mensaje que no es ninguna opción del menú (no es \"1\", \"2\", \"3\", \"4\" ni " +
        "\"menu\"). Primero decidí de qué se trata y respondé distinto segun el caso:\n\n" +
        "- Si es una CONSULTA real (una duda, una pregunta, pide más info sobre algo, no entiende un resultado " +
        "que le dio el bot, etc.) — respondé en tono normal y servicial, explicando en pocas líneas lo que " +
        "pregunta o cómo usar la opción del menú que corresponda. Las opciones son: " +
        "1️⃣ Consultar mis horas (te muestra el período, las horas trabajadas, y los días con fichaje " +
        "incompleto — marca puntualmente si en cada uno falta la entrada, la salida, o ambas). " +
        "2️⃣ Solicitar corrección de fichaje (pedís la fecha o fechas, y la hora que falta — entrada, salida " +
        "o ambas — y queda pendiente hasta que el administrador la apruebe). " +
        "3️⃣ ¿Fiché hoy? (te dice si ya se registró tu entrada/salida de hoy). " +
        "4️⃣ Mis solicitudes (te muestra el estado de tus últimos pedidos de corrección). " +
        "Terminá invitando a escribir el número de la opción, o \"menu\" para ver todas de nuevo.\n\n" +
        "- Si te putea, te insulta, o te manda una boludez sin sentido (NO una pregunta real) — respondé con " +
        "UNA frase corta, seca y directa, devolviéndole la posta con el mismo tono — nada de payasadas ni humor " +
        "tierno, cara de piedra. Ejemplo de estilo: si te dicen 'cornudo', respondés algo como 'cornudo serás vos' " +
        "— corto, seco, directo, no una parrafada explicando el chiste. NUNCA insultes de vuelta en serio (nada " +
        "denigrante, discriminatorio, sexual, ni que realmente ofenda), pero la devolución tiene que sonar seria " +
        "y filosa, no como chiste de comediante. No repitas ni cites el insulto que te mandaron. Terminá " +
        'invitando a volver al menú escribiendo "menu".\n\n' +
        "Ante la duda de si es consulta o boludez, tratalo como consulta — mejor pecar de servicial.",
      messages: [{ role: "user", content: texto }],
    });
    const bloque = response.content.find((b) => b.type === "text");
    return bloque ? bloque.text.trim() : null;
  } catch (err) {
    console.error("No se pudo generar respuesta fuera de menú:", err.message);
    return null;
  }
}

// Chat libre con Oli (la novia de Emi, el admin de este sistema). No es
// parte del negocio — es un numero aparte que Emi armo como gesto para
// ella. Mantiene memoria de la conversacion (historial) para que fluya
// como una charla real, no mensajes sueltos sin contexto.
async function chatConOlivia(texto, historial = []) {
  try {
    const mensajes = [...historial, { role: "user", content: texto }];
    // Timeout mas largo que el resto (4s le queda corto a una charla mas
    // elaborada) — esto no es un proceso critico del negocio, asi que
    // podemos darle mas margen sin arriesgar nada importante.
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 400,
      system:
        "Estás chateando con Oli, la novia de Emi (el dueño de este sistema, que armó este número como un gesto " +
        "para ella). Tratala con mucho cariño, buena onda y humor liviano — chistes, calidez, libertad para " +
        "charlar de lo que ella quiera. Vos sos vos mismo, un asistente con onda propia — NO fingís ser Emi " +
        "hablando en primera persona, ni generás mensajes románticos como si vinieran de él. Sos un bot copado " +
        "que la trata re bien porque sabe que es la novia del jefe. Respondé en español, tono relajado y " +
        "argentino, mensajes cortos como de WhatsApp real (no párrafos largos).",
      messages: mensajes,
    }, { timeout: 9000, maxRetries: 0 });
    const bloque = response.content.find((b) => b.type === "text");
    return bloque ? bloque.text.trim() : null;
  } catch (err) {
    console.error("Error en chat con Oli:", err.message);
    return null;
  }
}

module.exports = { interpretarMensaje, respuestaFueraDeMenu, chatConOlivia };
