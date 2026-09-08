// Transcribe un audio de WhatsApp (nota de voz) a texto -- pensado para
// empleados que prefieren mandar un audio en vez de escribir. La URL del
// audio la manda Twilio (protegida con las mismas credenciales de la
// cuenta), y la transcripcion la hace Whisper (OpenAI) -- Claude no
// entiende audio directamente, solo texto/imagenes.

// El audio de WhatsApp a veces todavia no esta listo para descargar en el
// mismo instante en que Twilio avisa del mensaje (justo lo que se ve al
// contestar el webhook rapido y procesar el audio en paralelo) -- un 403/404
// que se resuelve solo un segundo despues. Reintentamos un par de veces
// antes de darnos por vencidos.
async function descargarAudioConReintento(mediaUrl, authBasic, intentos = 3) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    try {
      const resp = await fetch(mediaUrl, { headers: { Authorization: authBasic } });
      if (resp.ok) return await resp.blob();
      ultimoError = new Error(`Twilio devolvió ${resp.status} al bajar el audio`);
    } catch (err) {
      ultimoError = err;
    }
    if (i < intentos - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  throw ultimoError;
}

async function transcribirAudio(mediaUrl) {
  const authBasic = "Basic " + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  const audioBlob = await descargarAudioConReintento(mediaUrl, authBasic);

  const form = new FormData();
  form.append("file", audioBlob, "audio.ogg");
  form.append("model", "whisper-1");
  form.append("language", "es");

  const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!whisperResp.ok) {
    const detalle = await whisperResp.text().catch(() => "");
    throw new Error(`Whisper devolvió ${whisperResp.status}: ${detalle.slice(0, 200)}`);
  }
  const data = await whisperResp.json();
  return (data.text || "").trim();
}

module.exports = { transcribirAudio };
