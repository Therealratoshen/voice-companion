/**
 * TiDB Memory Layer — CommonJS version for server.js
 * Compatible with Node.js require() (no ESM imports)
 */
const mysql = require('mysql2/promise');

// Lazy singleton pool
let _pool = null;

function getPool() {
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

// Serialize BigInt → Number (TiDB returns BigInt for AUTO_RANDOM PKs)
function serialize(rows) {
  return JSON.parse(JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? Number(v) : v));
}

// ── Search memory (FULLTEXT relevance) ─────────────────────────────────────
async function searchMemoryFulltext(userId, query, limit = 5) {
  const pool = getPool();
  try {
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
  } catch (err) {
    console.error('[Memory] FULLTEXT search failed:', err.message);
    return [];
  }
}

// ── Search memory (chronological fallback) ─────────────────────────────────
async function searchMemoryRecent(userId, limit = 5) {
  const pool = getPool();
  try {
    const [rows] = await pool.execute(
      `SELECT id, user_id, memory_key, content, channel, confidence, created_at
       FROM user_memory
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit]
    );
    return serialize(rows);
  } catch (err) {
    console.error('[Memory] Recent search failed:', err.message);
    return [];
  }
}

// Alias
const searchMemory = searchMemoryRecent;

// ── Upsert memory fact ──────────────────────────────────────────────────────
async function upsertMemory(userId, content, memoryKey, channel = 'both', confidence = 0.8) {
  const pool = getPool();
  try {
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
  } catch (err) {
    console.error('[Memory] upsert failed:', err.message);
  }
}

// ── Log conversation turn ───────────────────────────────────────────────────
async function logConversation(userId, channel, role, content, metadata) {
  const pool = getPool();
  try {
    await pool.execute(
      `INSERT INTO conversations (user_id, channel, role, content, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, channel, role, content, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    console.error('[Memory] logConversation failed:', err.message);
  }
}

// ── Get conversation history ───────────────────────────────────────────────
async function getConversationHistory(userId, channel = 'voice', limit = 20) {
  const pool = getPool();
  try {
    const [rows] = await pool.execute(
      `SELECT role, content, created_at
       FROM conversations
       WHERE user_id = ? AND channel = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, channel, limit]
    );
    return serialize(rows).reverse();
  } catch (err) {
    console.error('[Memory] getHistory failed:', err.message);
    return [];
  }
}

// ── Health check ───────────────────────────────────────────────────────────
async function ping() {
  try {
    const pool = getPool();
    await pool.execute('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getPool,
  searchMemoryFulltext,
  searchMemoryRecent,
  searchMemory,
  upsertMemory,
  logConversation,
  getConversationHistory,
  ping,
};
