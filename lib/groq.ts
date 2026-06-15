const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export async function groqChat(
  messages: { role: string; content: string }[],
  model = process.env.GROQ_MODEL || 'llama-3.1-70b-versatile'
) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });
  return res.json();
}
