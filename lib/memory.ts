import mysql from 'mysql2/promise';

// Lazy singleton pool — don't connect until first query
let _pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!_pool) {
    _pool = mysql.createPool({
      host: process.env.TIDB_HOST,
      port: Number(process.env.TIDB_PORT) || 4000,
      user: process.env.TIDB_USER,
      password: process.env.TIDB_PASSWORD,
      database: process.env.TIDB_DATABASE,
      ssl: { minVersion: 'TLSv1.2' },
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return _pool;
}

export default getPool;

// ── Helper: serialize BigInt in objects (TiDB returns BigInt for AUTO_RANDOM PKs) ──
function serialize<T>(rows: T[]): T {
  return JSON.parse(JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? Number(v) : v));
}

// ── Search memory (FULLTEXT) ────────────────────────────────────────────────
export async function searchMemoryFulltext(
  userId: string,
  query: string,
  limit = 5
): Promise<any[]> {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT id, user_id, memory_key, content, channel, confidence, created_at,
            MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) AS relevance
     FROM user_memory
     WHERE user_id = ? AND MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)
     ORDER BY relevance DESC, created_at DESC
     LIMIT ?`,
    [query, userId, query, limit]
  );
  return serialize(rows);
}

// ── Search memory (chronological fallback) ─────────────────────────────────
export async function searchMemoryRecent(
  userId: string,
  limit = 5
): Promise<any[]> {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT id, user_id, memory_key, content, channel, confidence, created_at
     FROM user_memory
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, limit]
  );
  return serialize(rows);
}

// Alias for backwards compatibility
export const searchMemory = searchMemoryRecent;

// ── Upsert memory ───────────────────────────────────────────────────────────
export async function upsertMemory(
  userId: string,
  content: string,
  memoryKey?: string,
  channel: 'text' | 'voice' | 'both' = 'both',
  confidence = 0.8
): Promise<void> {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO user_memory (user_id, memory_key, content, channel, confidence)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       content = VALUES(content),
       updated_at = NOW(),
       confidence = GREATEST(confidence, VALUES(confidence))`,
    [userId, memoryKey || null, content, channel, confidence]
  );

  await pool.execute(
    `INSERT INTO memory_logs (user_id, action, memory_key, new_value, source)
     VALUES (?, 'upsert', ?, ?, 'voice-ai')`,
    [userId, memoryKey || null, content]
  );
}

// ── Log conversation ────────────────────────────────────────────────────────
export async function logConversation(
  userId: string,
  channel: 'text' | 'voice',
  role: 'user' | 'assistant',
  content: string,
  metadata?: Record<string, any>
): Promise<void> {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO conversations (user_id, channel, role, content, metadata)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, channel, role, content, metadata ? JSON.stringify(metadata) : null]
  );
}

// ── Get conversation history ────────────────────────────────────────────────
export async function getConversationHistory(
  userId: string,
  channel: 'text' | 'voice' = 'voice',
  limit = 20
): Promise<any[]> {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT role, content, created_at
     FROM conversations
     WHERE user_id = ? AND channel = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, channel, limit]
  );
  return serialize(rows);
}

// ── Health check ───────────────────────────────────────────────────────────
export async function ping(): Promise<{ ok: boolean; error?: string }> {
  try {
    const pool = getPool();
    await pool.execute('SELECT 1');
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
