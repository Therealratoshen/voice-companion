import pool from './tidb';
import { groqChat } from './groq';

const SYSTEM_PROMPT = `You are a warm, natural voice AI companion.
Keep responses short and conversational (1-3 sentences).
Be empathetic. Never say you are an AI unless asked.
Remember previous context from memory.`;

// Search memory using FULLTEXT (no Mem9 on serverless tier)
export async function searchMemory(userId: string, query: string, limit = 5) {
  const [rows] = await pool.execute<any[]>(
    `SELECT content, channel, confidence, created_at
     FROM user_memory
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, limit]
  );
  return rows;
}

// Search memory by FULLTEXT relevance
export async function searchMemoryFulltext(userId: string, query: string, limit = 5) {
  const [rows] = await pool.execute<any[]>(
    `SELECT content, channel, confidence, created_at,
            MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) AS relevance
     FROM user_memory
     WHERE user_id = ? AND MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)
     ORDER BY relevance DESC
     LIMIT ?`,
    [query, userId, query, limit]
  );
  return rows;
}

// Upsert memory
export async function upsertMemory(
  userId: string,
  content: string,
  memoryKey?: string,
  channel: 'text' | 'voice' | 'both' = 'both'
) {
  await pool.execute(
    `INSERT INTO user_memory (user_id, memory_key, content, channel)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = NOW()`,
    [userId, memoryKey || null, content, channel]
  );

  await pool.execute(
    `INSERT INTO memory_logs (user_id, action, memory_key, new_value, source)
     VALUES (?, 'upsert', ?, ?, ?)`,
    [userId, memoryKey || null, content, 'voice-ai']
  );
}

// Extract and save new facts
export async function extractAndSaveMemories(userId: string, userMsg: string, assistantMsg: string) {
  const messages = [
    {
      role: 'system',
      content: `Extract 0-2 key facts from this conversation to remember.
Return ONLY a JSON array: [{"key": "...", "fact": "..."}]
Nothing else. Be concise.`,
    },
    { role: 'user', content: `User: ${userMsg}\nAssistant: ${assistantMsg}` },
  ];

  const res = await groqChat(messages);
  const text = res.choices?.[0]?.message?.content || '[]';

  try {
    const facts = JSON.parse(text);
    for (const f of facts) {
      await upsertMemory(userId, f.fact, f.key);
    }
  } catch {
    // silently ignore parse errors
  }
}

// Log conversation
export async function logConversation(
  userId: string,
  channel: 'text' | 'voice',
  role: 'user' | 'assistant',
  content: string
) {
  await pool.execute(
    `INSERT INTO conversations (user_id, channel, role, content) VALUES (?, ?, ?, ?)`,
    [userId, channel, role, content]
  );
}

export { SYSTEM_PROMPT };
