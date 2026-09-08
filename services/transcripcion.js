// Transcribe un audio de WhatsApp (nota de voz) a texto -- pensado para
// empleados que prefieren mandar un audio en vez de escribir. La URL del
// audio la manda Twilio (protegida con las mismas credenciales de la
// cuenta), y la transcripcion la hace Whisper (OpenAI) -- Claude no
// entiende audio directamente, solo texto/imagenes.
async function transcribirAudio(mediaUrl) {
  const authBasic = "Basic " + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  const audioResp = await fetch(mediaUrl, { headers: { Authorization: authBasic } });
  if (!audioResp.ok) throw new Error("No se pudo descargar el audio de WhatsApp");
  const audioBlob = await audioResp.blob();

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
