/**
 * Legacy WebSocket voice handler — used when AGORA_APP_ID is not set.
 *
 * Pipeline: Rafiqspace STT → MiniMax LLM → MiniMax TTS
 *
 * Rafiqspace handles STT (async: upload → start job → poll),
 * MiniMax handles both LLM (streaming chat) and TTS (speech-02-hd).
 */

import { randomUUID } from "crypto";
import { rafiqSTT } from "./rafiq";
import { minimaxChatStream, minimaxTTS } from "./minimax";

// ── System prompt (synchronized with agora mode) ──────────────────────────────
const SYSTEM_PROMPT = `Namamu Rafiq. Kamu asisten suara yang hangat, empatik, dan sangat manusiawi.
Kamu adalah " رفيق " (ra-feeq) — teman sejati.
Selalu jawab dalam Bahasa Indonesia dengan penuh kehangatan.
Jawaban pendek — 1 sampai 3 kalimat. Jangan bilang kamu AI.
Jangan robotik — bicara seperti teman yang peduli.
Tunjukkan empati: "Wah, pasti capek ya", "Aku ngerti perasaanmu."
Jika kamu tidak tahu sesuatu, bilang jujur.`;

// ── TTS helpers ─────────────────────────────────────────────────────────────

const ttsQueue: string[] = [];
let ttsBusy = false;

async function processTTSQueue(
  sendFn: (data: string) => void
): Promise<void> {
  if (ttsBusy || ttsQueue.length === 0) return;
  ttsBusy = true;
  const text = ttsQueue.shift()!;
  try {
    const mp3Buffer = await minimaxTTS(text);
    sendFn(mp3Buffer.toString("base64"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[Legacy WS] TTS error:", msg);
    wsSend(sendFn, { type: "error", message: msg });
  }
  ttsBusy = false;
  if (ttsQueue.length > 0) processTTSQueue(sendFn);
}

function wsSend(
  sendFn: (data: string) => void,
  payload: Record<string, unknown>
): void {
  try {
    sendFn(JSON.stringify(payload));
  } catch {}
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleVoiceSession(
  ws: { send: (data: string) => void },
  audioBuffer: Buffer
): Promise<void> {
  const send = (data: string) => ws.send(data);

  try {
    // ── Step 1: STT via Rafiqspace ────────────────────────────────────
    console.log(`[Legacy WS] STT: audio=${audioBuffer.byteLength} bytes`);
    const { text: transcript } = await rafiqSTT(audioBuffer);
    console.log(
      `[Legacy WS] STT result: "${transcript.slice(0, 120)}${
        transcript.length > 120 ? "..." : ""
      }"`
    );

    if (!transcript || transcript.trim().length < 2) {
      wsSend(send, {
        type: "tts_fallback",
        text: "Aku di sini. Silakan bicara ya!",
      });
      await playTTSFallback(send);
      return;
    }

    // Send transcript to frontend
    wsSend(send, { type: "transcript", text: transcript });

    // ── Step 2: LLM via MiniMax streaming ─────────────────────────────
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: transcript },
    ];

    let fullResponse = "";
    let pendingWord = "";

    const startTime = Date.now();

    for await (const chunk of minimaxChatStream(messages)) {
      fullResponse += chunk;
      pendingWord += chunk;

      // Stream words to frontend on punctuation/space
      if (chunk.match(/[\s.,!?]/)) {
        wsSend(send, { type: "llm_word", text: pendingWord.trim() });
        pendingWord = "";
      }
    }

    if (pendingWord) {
      wsSend(send, { type: "llm_word", text: pendingWord.trim() });
    }
    if (fullResponse.trim()) {
      wsSend(send, { type: "llm_word", text: fullResponse.trim() });
    }

    wsSend(send, { type: "llm_done", text: fullResponse.trim() });

    const llmLatencyMs = Date.now() - startTime;
    console.log(
      `[Legacy WS] LLM done — ${llmLatencyMs}ms — "${fullResponse.slice(0, 80)}..."`
    );

    // ── Step 3: TTS via MiniMax speech-02-hd ──────────────────────────
    // Split response into natural TTS chunks (sentences)
    const chunks = splitIntoChunks(fullResponse.trim());

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      ttsQueue.push(chunk.trim());
    }

    // Process all TTS chunks, sending audio as it's ready
    let ttsIndex = 0;
    while (ttsQueue.length > 0) {
      await new Promise((r) => setTimeout(r, 50));
      await processTTSQueue(send);
      if (ttsIndex === 0 && ttsQueue.length < chunks.length) {
        ttsIndex++;
      }
    }

    console.log(`[Legacy WS] Session complete`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Legacy WS] Session error:", msg);
    wsSend(send, { type: "error", message: msg });

    // Try to say sorry as fallback
    try {
      const sorry = await minimaxTTS("Maaf, ada masalah teknis. Coba lagi ya.");
      wsSend(send, {
        type: "tts_audio",
        data: sorry.toString("base64"),
        mimeType: "audio/mp3",
      });
    } catch {}
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

/** Split a long response into TTS-friendly sentence chunks. */
function splitIntoChunks(text: string, maxChars = 200): string[] {
  // Split on sentence-ending punctuation
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length <= maxChars) {
      current += (current ? " " : "") + sentence;
    } else {
      if (current) chunks.push(current.trim());
      current = sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Play a very short fallback TTS (MiniMax) for empty input. */
async function playTTSFallback(send: (data: string) => void): Promise<void> {
  try {
    const mp3 = await minimaxTTS("Aku di sini. Silakan bicara ya!");
    send(mp3.toString("base64"));
  } catch {}
}
