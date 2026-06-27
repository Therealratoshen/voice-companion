/**
 * Groq LLM Client for OpenClaw Agent
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

/**
 * Non-streaming chat completion
 */
async function groqChat(messages, options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const temperature = options.temperature ?? 0.6;
  const maxTokens = options.maxTokens || 2048;

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err}`);
  }

  return res.json();
}

/**
 * Streaming chat completion (generator)
 */
async function* groqStream(messages, options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const temperature = options.temperature ?? 0.7;

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err}`);
  }

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
        const content = JSON.parse(data).choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {}
    }
  }
}

module.exports = { groqChat, groqStream, DEFAULT_MODEL };
