/**
 * TiDB Mem9 — Vector Memory Layer
 *
 * Uses TiDB's built-in Mem9 (vector) feature for semantic memory search.
 * Falls back to FULLTEXT if Mem9 is not enabled.
 *
 * Schema requires Mem9 enabled in TiDB Cloud Console → AI Features.
 */

const mysql = require('mysql2/promise');

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
    });
  }
  return _pool;
}

// ── Embedding generation ─────────────────────────────────────────────────────
// Use OpenAI embeddings (or Groq if they have an embeddings endpoint)
// Falls back to a simple hash-based pseudo-embedding for demo

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1536');

async function getEmbedding(text) {
  if (!text || text.trim().length === 0) {
    return new Array(EMBEDDING_DIM).fill(0);
  }

  // Try OpenAI embeddings
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: text.substring(0, 8000), // token limit
        }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.data[0].embedding;
      }
    } catch (err) {
      console.warn('[Mem9] OpenAI embedding failed:', err.message);
    }
  }

  // Try Groq embeddings
  if (process.env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile', // Groq doesn't have embeddings endpoint yet
          // Fall back to OpenAI-compatible proxy if available
        }),
      });
    } catch {}
  }

  // Fallback: pseudo-embedding (hash-based, not semantically meaningful)
  // Only used when no embedding API is available
  return pseudoEmbedding(text);
}

function pseudoEmbedding(text) {
  // Simple hash-based vector — not semantically accurate
  // but at least consistent and fixed-dimension
  const hash = require('crypto').createHash('sha256');
  hash.update(text);
  const seed = parseInt(hash.digest('hex').substring(0, 8), 16);
  const rng = seededRandom(seed);
  return Array.from({ length: EMBEDDING_DIM }, () => rng());
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

// ── Mem9 vector search ─────────────────────────────────────────────────────
async function vectorSearch(userId, query, limit = 5) {
  const pool = getPool();
  const embedding = await getEmbedding(query);

  try {
    // Try TiDB Mem9 native search
    const [rows] = await pool.query(
      `SELECT id, memory_key, content, channel, confidence, created_at,
              VEC_DOT_PRODUCT(embedding, ?) AS similarity
       FROM user_memory
       WHERE user_id = ? AND embedding IS NOT NULL
       ORDER BY similarity DESC
       LIMIT ?`,
      [JSON.stringify(embedding), userId, limit]
    );
    return rows.map(r => ({
      ...r,
      similarity: Number(r.similarity),
    }));
  } catch (err) {
    // Mem9 not available — fall back to FULLTEXT
    console.warn('[Mem9] Vector search failed, falling back to FULLTEXT:', err.message);
    return fulltextSearch(userId, query, limit);
  }
}

// ── FULLTEXT fallback ──────────────────────────────────────────────────────
async function fulltextSearch(userId, query, limit = 5) {
  const pool = getPool();
  try {
    const [rows] = await pool.execute(
      `SELECT id, memory_key, content, channel, confidence, created_at,
              MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) AS relevance
       FROM user_memory
       WHERE user_id = ? AND MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)
       ORDER BY relevance DESC, created_at DESC
       LIMIT ?`,
      [query, userId, query, limit]
    );
    return rows.map(r => ({ ...r, similarity: r.relevance || 0 }));
  } catch (err) {
    console.warn('[Mem9] FULLTEXT search also failed:', err.message);
    // Final fallback: chronological
    const [rows] = await pool.execute(
      `SELECT * FROM user_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit]
    );
    return rows;
  }
}

// ── Upsert with embedding ──────────────────────────────────────────────────
async function upsertMemoryWithEmbedding(userId, content, memoryKey, channel = 'both', confidence = 0.8) {
  const pool = getPool();
  const embedding = await getEmbedding(content);

  try {
    await pool.query(
      `INSERT INTO user_memory (user_id, memory_key, content, embedding, channel, confidence)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         content = VALUES(content),
         embedding = VALUES(embedding),
         updated_at = NOW(),
         confidence = GREATEST(confidence, VALUES(confidence))`,
      [userId, memoryKey || null, content, JSON.stringify(embedding), channel, confidence]
    );
    return { success: true };
  } catch (err) {
    // If embedding column doesn't exist, upsert without it
    console.warn('[Mem9] Embedding upsert failed:', err.message);
    try {
      await pool.query(
        `INSERT INTO user_memory (user_id, memory_key, content, channel, confidence)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = NOW()`,
        [userId, memoryKey || null, content, channel, confidence]
      );
      return { success: true };
    } catch (err2) {
      return { success: false, error: err2.message };
    }
  }
}

// ── Health check ───────────────────────────────────────────────────────────
async function ping() {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    return { ok: true, mem9: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Batch embed memories (for initial population) ──────────────────────────
async function embedAllMemories(userId) {
  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, content FROM user_memory WHERE user_id = ? AND embedding IS NULL LIMIT 100`,
      [userId]
    );
    let updated = 0;
    for (const row of rows) {
      const embedding = await getEmbedding(row.content);
      await pool.query(
        `UPDATE user_memory SET embedding = ? WHERE id = ?`,
        [JSON.stringify(embedding), row.id]
      );
      updated++;
    }
    return { updated, total: rows.length };
  } catch (err) {
    return { updated: 0, error: err.message };
  }
}

module.exports = {
  getPool,
  getEmbedding,
  vectorSearch,
  fulltextSearch,
  upsertMemoryWithEmbedding,
  embedAllMemories,
  ping,
};
