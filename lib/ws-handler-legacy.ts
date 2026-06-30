/**
 * Legacy WebSocket voice handler — used when AGORA_APP_ID is not set.
 *
 * Pipeline: Groq Whisper STT → Groq Llama LLM → Edge TTS (id-ID-ArdiNeural)
 *
 * Kept for local development / testing without Agora credentials.
 */

import { randomUUID } from "crypto";
import { groqStream } from "./groq";

// ── Groq Whisper STT (inline — only used in legacy mode) ────────────────────
async function groqSTT(audioBuffer: Buffer) {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)]), "audio.webm");
  formData.append("model", "whisper-large-v3");
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "word");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });
  const data = await res.json();
  return { text: data.text || "", segments: data.segments || [] };
}

const SYSTEM_PROMPT = `Kamu adalah asisten suara AI yang hangat dan ramah di telepon.
Selalu jawab dalam Bahasa Indonesia.
Jawaban singkat — 1 sampai 3 kalimat. Jangan bilang kamu AI.`;

// ── Edge TTS ────────────────────────────────────────────────────────────────

function edgeTTS(text: string, voice = "id-ID-ArdiNeural"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const tmpMp3 = `/tmp/tts_${randomUUID()}.mp3`;
    const edge = spawn("edge-tts", [
      "--text", text,
      "--voice", voice,
      "--write-media", tmpMp3,
    ]);
    edge.on("close", (code: number) => {
      if (code !== 0) { reject(new Error(`edge-tts exited ${code}`)); return; }
      try {
        const { readFileSync, unlinkSync } = require("fs");
        const mp3Data = readFileSync(tmpMp3);
        unlinkSync(tmpMp3);
        resolve(mp3Data);
      } catch (e) { reject(e); }
    });
    edge.on("error", reject);
  });
}

// ── Groq STT ───────────────────────────────────────────────────────────────

async function whisperSTT(audioBuffer: Buffer) {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)]), "audio.webm");
  formData.append("model", "whisper-large-v3");
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "word");

  const res = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: formData,
    }
  );
  const data = await res.json();
  return { text: data.text || "", segments: data.segments || [] };
}

// ── Handler ─────────────────────────────────────────────────────────────────

const ttsQueue: string[] = [];
let ttsBusy = false;

async function processTTSQueue(
  sendFn: (data: string) => void
): Promise<void> {
  if (ttsBusy || ttsQueue.length === 0) return;
  ttsBusy = true;
  const text = ttsQueue.shift()!;
  try {
    const mp3Data = await edgeTTS(text);
    sendFn(mp3Data.toString("base64"));
  } catch (e: any) {
    console.error("[Legacy WS] TTS error:", e.message);
  }
  ttsBusy = false;
  if (ttsQueue.length > 0) processTTSQueue(sendFn);
}

export async function handleVoiceSession(
  ws: { send: (data: string) => void },
  audioBuffer: Buffer
): Promise<void> {
  try {
    const { text: transcript } = await whisperSTT(audioBuffer);
    console.log("[Legacy WS] STT:", transcript ? `"${transcript}"` : "(empty)");

    if (!transcript || transcript.trim().length < 2) {
      ws.send(JSON.stringify({ type: "tts_fallback", text: "I'm here. Say something!" }));
      return;
    }

    ws.send(JSON.stringify({ type: "transcript", text: transcript }));

    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: transcript },
    ];

    let fullResponse = "";
    let pendingWord = "";

    for await (const chunk of groqStream(messages)) {
      fullResponse += chunk;
      pendingWord += chunk;

      if (chunk.match(/[\s.,!?]/)) {
        ws.send(JSON.stringify({ type: "llm_word", text: pendingWord.trim() }));
        pendingWord = "";
      }

      // Buffer for TTS every 30 chars
      while (ttsQueue.join("").length < 30) {
        const words = fullResponse.split(" ");
        if (words.length < 5) break;
        const cut = words.slice(0, -1).join(" ").length;
        const toTTS = fullResponse.slice(0, cut);
        fullResponse = fullResponse.slice(cut + 1);
        if (toTTS.trim()) ttsQueue.push(toTTS.trim());
      }

      processTTSQueue((data) =>
        ws.send(JSON.stringify({ type: "tts_audio", data, mimeType: "audio/mpeg" }))
      );
    }

    if (pendingWord) ws.send(JSON.stringify({ type: "llm_word", text: pendingWord.trim() }));
    if (fullResponse.trim()) ttsQueue.push(fullResponse.trim());

    while (ttsQueue.length > 0) {
      await new Promise((r) => setTimeout(r, 100));
      await processTTSQueue((data) =>
        ws.send(JSON.stringify({ type: "tts_audio", data, mimeType: "audio/mpeg" }))
      );
    }

    ws.send(JSON.stringify({ type: "llm_done", text: fullResponse.trim() }));
  } catch (err: any) {
    console.error("[Legacy WS] Session error:", err);
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }
}
