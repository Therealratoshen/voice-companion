// Groq Whisper STT
export async function groqSTT(audioBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)]), "audio.webm");
  formData.append("model", "whisper-large-v3");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });
  const data = await res.json();
  return data.text || "";
}

// MiniMax TTS
export async function minimaxTTS(text: string, voiceId?: string): Promise<Buffer> {
  const res = await fetch(
    `https://api.minimax.io/v1/t2a_v2?GroupId=${process.env.MINIMAX_GROUP_ID}&Model=speech-02-hd`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MINIMAX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "speech-02-hd",
        text,
        stream: false,
        voice_setting: {
          voice_id: voiceId || process.env.MINIMAX_VOICE_ID || "male-qn-qingse",
        },
      }),
    }
  );
  const data = await res.json();
  return Buffer.from(data.data.audio, "base64");
}
