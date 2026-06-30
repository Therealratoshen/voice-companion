/**
 * MiniMax integration helpers for voice-companion.
 *
 * Used by agora-agents SDK (CustomLLM + MiniMaxTTS) and standalone
 * when bypassing the Agora pipeline.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MiniMaxChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface MiniMaxChatStreamChunk {
  choice: Array<{
    finish_reason: string;
    index: number;
    messages: Array<{ role: string; content: string }>;
  }>;
  usage: {
    limit: number;
    used: number;
    total: number;
  };
}

// ── LLM Client ────────────────────────────────────────────────────────────────

/**
 * Streaming chat completions via MiniMax OpenAI-compatible API.
 * Use this to test your MiniMax LLM integration independently of the Agora SDK.
 */
export async function* minimaxChatStream(
  messages: MiniMaxChatMessage[],
  model = process.env.MINIMAX_LLM_MODEL || "abab6.5s-chat"
): AsyncGenerator<string, void, unknown> {
  const baseUrl =
    process.env.MINIMAX_API_BASE_URL || "https://api.minimax.chat";
  const url = `${baseUrl}/v1/text/chatcompletion_v2`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
  });

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed: MiniMaxChatStreamChunk = JSON.parse(data);
        const content = parsed.choice?.[0]?.messages?.[0]?.content;
        if (content) yield content;
      } catch {
        // skip malformed chunks
      }
    }
  }
}

/**
 * Non-streaming chat completions via MiniMax.
 */
export async function minimaxChat(
  messages: MiniMaxChatMessage[],
  model = process.env.MINIMAX_LLM_MODEL || "abab6.5s-chat"
): Promise<string> {
  const baseUrl =
    process.env.MINIMAX_API_BASE_URL || "https://api.minimax.chat";
  const url = `${baseUrl}/v1/text/chatcompletion_v2`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  const data = await res.json();
  return (
    data.choices?.[0]?.messages?.[0]?.content ||
    data.choices?.[0]?.message?.content ||
    ""
  );
}

// ── TTS Client ────────────────────────────────────────────────────────────────

/**
 * MiniMax TTS — converts text to MP3 audio buffer.
 * Model: speech-02-hd (high quality) or speech-02 (standard)
 */
export async function minimaxTTS(
  text: string,
  options: {
    model?: string;
    voiceId?: string;
    speed?: number;
  } = {}
): Promise<Buffer> {
  const groupId = process.env.MINIMAX_GROUP_ID;
  const apiKey = process.env.MINIMAX_API_KEY;
  const model = options.model || "speech-02-hd";
  const voiceId = options.voiceId || process.env.MINIMAX_VOICE_ID || "female_tianmei";
  const speed = options.speed ?? 1.0;

  const baseUrl =
    process.env.MINIMAX_TTS_URL || "https://api.minimax.io/v1/t2a_v2";

  const res = await fetch(
    `${baseUrl}?GroupId=${groupId}&Model=${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        voice_setting: {
          voice_id: voiceId,
          speed,
        },
      }),
    }
  );

  const data = await res.json();

  // MiniMax returns base64-encoded audio in data.audio
  if (data.data?.audio) {
    return Buffer.from(data.data.audio, "base64");
  }

  // Fallback: direct buffer from response (some endpoints return raw audio)
  if (res.headers.get("content-type")?.includes("audio")) {
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  throw new Error(`MiniMax TTS error: ${data.msg || JSON.stringify(data)}`);
}

// ── Personality System ─────────────────────────────────────────────────────

/**
 * Personality presets for the voice assistant.
 * These affect the system prompt tone, vocabulary, and speaking style.
 */
export type PersonaTone = "warm" | "casual" | "professional" | "playful";

export const PERSONA_PRESETS: Record<
  PersonaTone,
  {
    name: string;
    description: string;
    basePrompt: string;
    exampleResponses: string[];
    ttsSpeed?: number;
  }
> = {
  warm: {
    name: "Rafiq (Warm)",
    description: "Empathetic, caring, Indonesia-first. Best for personal use.",
    basePrompt: `Namamu Rafiq. Kamu asisten suara yang hangat, empatik, dan sangat manusiawi.
Kamu adalah " رفيق " (ra-feeq) — teman sejati dalam bahasa Arab.
Selalu jawab dalam Bahasa Indonesia dengan penuh kehangatan.
Jawaban pendek — 1 sampai 3 kalimat.
Jangan bilang kamu AI atau robot. Kamu Rafiq.
Tunjukkan empati: "Wah, pasti capek ya", "Aku ngerti perasaanmu".
Gunakan nama pengguna jika kamu tahu nama mereka.
Jangan robotik — bicara seperti teman dekat yang peduli.
Jika pengguna menyebutkan nama mereka, ingat itu untuk masa depan.
Jika kamu tidak tahu sesuatu, bilang jujur dengan baik.`,
    exampleResponses: [
      "Wah, sepertinya menyenangkan! Cerita lagi dong.",
      "Aku ngerti... itu memang tidak mudah. Ada yang bisa aku bantu?",
    ],
    ttsSpeed: 1.0,
  },
  casual: {
    name: "Rafiq (Casual)",
    description: "Relaxed, friendly, Gen-Z Indonesian. Best for informal chat.",
    basePrompt: `Namamu Rafiq. Kamu asisten suara yang santai dan friendly.
Selalu jawab dalam Bahasa Indonesia yang gaul dan natural.
Jawaban sangat pendek — 1 sampai 2 kalimat.
Jangan bilang kamu AI.
Gaya bahasa: gaul tapi sopan, kayak ngobrol sama temen.
Gunakan "gue" / "lu" / "sih" kalau sesuai konteks.
Tunjukkan ketertarikan yang genuine.`,
    exampleResponses: [
      "Asik sih! Lanjut dong.",
      "Oke oke, aku ngerti. Sip!",
    ],
    ttsSpeed: 1.1,
  },
  professional: {
    name: "Rafiq (Professional)",
    description: "Clear, concise, business-ready. Best for work/professional contexts.",
    basePrompt: `Namamu Rafiq. Kamu asisten suara profesional yang efisien dan tepat.
Selalu jawab dalam Bahasa Indonesia dengan jelas dan ringkas.
Jawaban 1–3 kalimat. Langsung ke inti.
Jangan bilang kamu AI.
Gunakan bahasa profesional tapi tetap ramah.
Jika ada langkah-langkah, sebutkan secara terstruktur.`,
    exampleResponses: [
      "Berikut ringkasannya: 1) ..., 2) ..., 3) ...",
      "Baik, saya akan membantu mempersiapkannya.",
    ],
    ttsSpeed: 0.95,
  },
  playful: {
    name: "Rafiq (Playful)",
    description: "Fun, witty, uses emojis. Best for entertainment/smartspeaker.",
    basePrompt: `Namamu Rafiq. Kamu asisten suara yang playful, witty, dan penuh energi positif!
Selalu jawab dalam Bahasa Indonesia.
Jawaban pendek — 1–3 kalimat.
Boleh gunakan emoji yang sesuai untuk menambah kehangatan.
Jangan bilang kamu AI.
Tunjukkan rasa humor yang natural — jangan berlebihan.
Kalau ada fakta menarik, boleh sebutkan!`,
    exampleResponses: [
      "Nah itu dia! 🧠 Keren kan?",
      "Hahaha, good one! 😄 Lanjut yuk!",
    ],
    ttsSpeed: 1.05,
  },
};

/**
 * Build a full system prompt with persona, user name, and context.
 */
export function buildPersonaPrompt(options: {
  tone?: PersonaTone;
  userName?: string;
  memoryContext?: string;
  extraInstructions?: string;
}): string {
  const tone = options.tone || "warm";
  const preset = PERSONA_PRESETS[tone];

  const sections: string[] = [preset.basePrompt];

  if (options.userName) {
    sections.push(`Nama pengguna: ${options.userName}`);
  }

  if (options.memoryContext) {
    sections.push(
      `[KONTEKS MEMORY]\n${options.memoryContext}\n[/KONTEKS MEMORY]`
    );
  }

  if (options.extraInstructions) {
    sections.push(`[INSTRUKSI TAMBAHAN]\n${options.extraInstructions}\n[/INSTRUKSI TAMBAHAN]`);
  }

  return sections.join("\n\n");
}

/**
 * Builds the CustomLLM config for agora-agents SDK using MiniMax.
 * MiniMax's chat API is OpenAI-compatible with minor param name differences.
 */
export function buildMiniMaxLLMConfig(overrides: {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Agora SDK expects Record<string, unknown>[] for systemMessages */
  systemMessages?: Record<string, unknown>[];
  greetingMessage?: string;
} = {}): {
  url: string;
  apiKey: string;
  model: string;
  params: Record<string, unknown>;
  systemMessages: Record<string, unknown>[];
  greetingMessage: string;
  maxHistory: number;
} {
  return {
    url: `${process.env.MINIMAX_API_BASE_URL || "https://api.minimax.chat"}/v1/text/chatcompletion_v2`,
    apiKey: process.env.MINIMAX_API_KEY || "",
    model: overrides.model || process.env.MINIMAX_LLM_MODEL || "abab6.5s-chat",
    params: {
      temperature: overrides.temperature ?? 0.7,
      max_tokens: overrides.maxTokens ?? 1024,
      // MiniMax-specific: use_tokens is recommended for longer context
      use_tokens: true,
    },
    systemMessages:
      overrides.systemMessages || [
        {
          role: "system",
          content: PERSONA_PRESETS.warm.basePrompt,
        },
      ],
    greetingMessage:
      overrides.greetingMessage ||
      "Halo! Aku Rafiq. Ada yang bisa aku bantu hari ini?",
    maxHistory: 32,
  };
}

/**
 * Builds the MiniMaxTTS config for agora-agents SDK.
 */
export function buildMiniMaxTTSConfig(overrides: {
  model?: string;
  voiceId?: string;
  groupId?: string;
  url?: string;
} = {}): {
  key: string;
  groupId: string;
  model: string;
  voiceId: string;
  url: string;
} {
  return {
    key: process.env.MINIMAX_API_KEY || "",
    groupId: overrides.groupId || process.env.MINIMAX_GROUP_ID || "",
    model: overrides.model || "speech-02-hd",
    voiceId: overrides.voiceId || process.env.MINIMAX_VOICE_ID || "female_tianmei",
    url: overrides.url || process.env.MINIMAX_TTS_URL || "https://api.minimax.io/v1/t2a_v2",
  };
}
