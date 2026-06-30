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

// ── Agora Agents SDK Config Builders ────────────────────────────────────────

/**
 * Builds the CustomLLM config for agora-agents SDK using MiniMax.
 * MiniMax's chat API is OpenAI-compatible with minor param name differences.
 */
export function buildMiniMaxLLMConfig(overrides: {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemMessages?: MiniMaxChatMessage[];
  greetingMessage?: string;
} = {}): {
  url: string;
  apiKey: string;
  model: string;
  params: Record<string, unknown>;
  systemMessages: MiniMaxChatMessage[];
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
      overrides.systemMessages ||
      [
        {
          role: "system",
          content:
            "Kamu adalah asisten suara AI yang hangat dan ramah.\n" +
            "Selalu jawab dalam Bahasa Indonesia.\n" +
            "Jawaban singkat — 1 sampai 3 kalimat.\n" +
            "Jangan bilang kamu AI.",
        },
      ],
    greetingMessage:
      overrides.greetingMessage || "Halo! Saya asisten suara Anda. Ada yang bisa saya bantu?",
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
