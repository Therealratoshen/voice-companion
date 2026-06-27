const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

export async function groqChat(
  messages: { role: string; content: string }[],
  model = DEFAULT_MODEL
) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: false, temperature: 0.7 }),
  });
  if (!res.ok) {
    throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export { DEFAULT_MODEL };
