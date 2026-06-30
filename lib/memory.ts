/**
 * Voice Companion Memory System v2
 *
 * Proactive context injection:
 *   Before each agent response → fetch relevant memories + session history
 *   → build context block → inject into LLM system prompt
 *
 * Memory categories:
 *   personal  — name, job, location, relationships (importance 5)
 *   preference — tone, language, habits (importance 4)
 *   contextual — current situation, recent events (importance 3)
 *   general   — general facts (importance 2)
 *   ephemeral — one-off facts, forgettable (importance 1)
 */

import pool from "./tidb";
import { minimaxChat } from "./minimax";

// ── Types ────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: number;
  user_id: string;
  memory_key: string | null;
  category: "personal" | "preference" | "contextual" | "general" | "ephemeral";
  content: string;
  importance: number;
  source: string;
  created_at: Date;
  updated_at: Date;
}

export interface SessionTurn {
  turn_number: number;
  role: "user" | "assistant";
  user_text: string | null;
  assistant_text: string | null;
  created_at: Date;
}

export interface ContextBundle {
  memories: MemoryEntry[];
  recentHistory: SessionTurn[];
  sessionSummary: string | null;
  userProfile: UserProfile | null;
}

export interface UserProfile {
  user_id: string;
  name: string | null;
  language: string;
  preferred_tone: "warm" | "casual" | "formal";
  timezone: string;
}

// ── Context builder ──────────────────────────────────────────────────────

/**
 * Fetch everything needed to give the LLM full context for this turn.
 * Call this BEFORE sending the user's message to the LLM.
 */
export async function buildContext(
  userId: string,
  sessionId: string,
  currentMessage: string,
  options: {
    memoryLimit?: number;
    historyLimit?: number;
    includeProfile?: boolean;
  } = {}
): Promise<ContextBundle> {
  const { memoryLimit = 8, historyLimit = 6, includeProfile = true } = options;

  const [memories, recentHistory, sessionSummary, userProfile] =
    await Promise.allSettled([
      fetchRelevantMemories(userId, currentMessage, memoryLimit),
      fetchRecentHistory(userId, sessionId, historyLimit),
      fetchSessionSummary(userId, sessionId),
      includeProfile ? fetchUserProfile(userId) : Promise.resolve(null),
    ]);

  return {
    memories: memories.status === "fulfilled" ? memories.value : [],
    recentHistory: recentHistory.status === "fulfilled" ? recentHistory.value : [],
    sessionSummary:
      sessionSummary.status === "fulfilled" ? sessionSummary.value : null,
    userProfile: userProfile.status === "fulfilled" ? userProfile.value : null,
  };
}

/**
 * Format context bundle into an LLM-ready system message block.
 */
export function formatContextForLLM(ctx: ContextBundle): string {
  const lines: string[] = [];

  if (ctx.userProfile?.name) {
    lines.push(`Nama pengguna: ${ctx.userProfile.name}`);
  }

  if (ctx.sessionSummary) {
    lines.push(`Ringkasan sesi sebelumnya: ${ctx.sessionSummary}`);
  }

  if (ctx.recentHistory.length > 0) {
    const historyLines = ctx.recentHistory
      .map((t) => {
        if (t.role === "user") return `Kamu: ${t.user_text}`;
        return `Asisten: ${t.assistant_text}`;
      })
      .join("\n");
    lines.push(`Percakapan baru saja:\n${historyLines}`);
  }

  if (ctx.memories.length > 0) {
    const memoryLines = ctx.memories
      .map((m) => `• ${m.content}`)
      .join("\n");
    lines.push(`Yang kamu tahu tentang pengguna:\n${memoryLines}`);
  }

  return lines.length > 0
    ? `\n[KONTEKS]\n${lines.join("\n\n")}\n[/KONTEKS]\n`
    : "";
}

// ── Memory fetching ──────────────────────────────────────────────────────

/**
 * Fetch memories relevant to the current message.
 * Uses FULLTEXT relevance for semantic matching.
 */
export async function fetchRelevantMemories(
  userId: string,
  query: string,
  limit = 8
): Promise<MemoryEntry[]> {
  try {
    // If query is short or empty, fall back to recency-based fetch
    if (!query || query.trim().length < 3) {
      const [rows] = await pool.execute<any[]>(
        `SELECT * FROM user_memory
         WHERE user_id = ?
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`,
        [userId, limit]
      );
      return rows as MemoryEntry[];
    }

    // FULLTEXT relevance search
    const [rows] = await pool.execute<any[]>(
      `SELECT *,
              MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) AS relevance
       FROM user_memory
       WHERE user_id = ?
         AND MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)
       ORDER BY relevance DESC, importance DESC
       LIMIT ?`,
      [query, userId, query, limit]
    );
    return rows as MemoryEntry[];
  } catch {
    // Fallback: simple recency fetch if FULLTEXT fails
    const [rows] = await pool.execute<any[]>(
      `SELECT * FROM user_memory
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit]
    );
    return rows as MemoryEntry[];
  }
}

/**
 * Fetch the last N turns from this session for short-term continuity.
 */
export async function fetchRecentHistory(
  userId: string,
  sessionId: string,
  limit = 6
): Promise<SessionTurn[]> {
  const [rows] = await pool.execute<any[]>(
    `SELECT turn_number, role, user_text, assistant_text, created_at
     FROM conversation_turns
     WHERE user_id = ? AND session_id = ?
     ORDER BY turn_number DESC
     LIMIT ?`,
    [userId, sessionId, limit]
  );
  return (rows as any[]).reverse(); // oldest first for context
}

/**
 * Get session summary if one was generated earlier.
 */
export async function fetchSessionSummary(
  userId: string,
  sessionId: string
): Promise<string | null> {
  const [rows] = await pool.execute<any[]>(
    `SELECT summary_text FROM session_summaries
     WHERE user_id = ? AND session_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [userId, sessionId]
  );
  return rows[0]?.summary_text || null;
}

/**
 * Get user profile (name, language, tone preference).
 */
export async function fetchUserProfile(
  userId: string
): Promise<UserProfile | null> {
  const [rows] = await pool.execute<any[]>(
    `SELECT * FROM user_profiles WHERE user_id = ?`,
    [userId]
  );
  return (rows[0] as UserProfile) || null;
}

// ── Memory writing ───────────────────────────────────────────────────────

/**
 * Save a memory with automatic category detection.
 */
export async function saveMemory(
  userId: string,
  content: string,
  options: {
    category?: MemoryEntry["category"];
    importance?: number;
    memoryKey?: string;
    source?: string;
    channel?: string;
  } = {}
): Promise<void> {
  const {
    category = "general",
    importance = 3,
    memoryKey,
    source = "conversation",
    channel = "voice",
  } = options;

  try {
    await pool.execute(
      `INSERT INTO user_memory
         (user_id, memory_key, category, content, importance, source, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         content = VALUES(content),
         category = IF(VALUES(importance) > importance, VALUES(category), category),
         importance = GREATEST(importance, VALUES(importance)),
         updated_at = NOW()`,
      [userId, memoryKey || null, category, content, importance, source, channel]
    );

    await pool.execute(
      `INSERT INTO memory_logs (user_id, action, memory_key, new_value, source)
       VALUES (?, 'upsert', ?, ?, ?)`,
      [userId, memoryKey || null, content, source]
    );
  } catch (err) {
    console.warn("[Memory] saveMemory failed:", err);
  }
}

/**
 * Extract facts from a conversation turn and save them proactively.
 * Called after each assistant response.
 *
 * Categories:
 *   personal   — name, family, job, city (importance 5)
 *   preference — likes, dislikes, habits, tone (importance 4)
 *   contextual — current situation, ongoing topics (importance 3)
 *   general    — casual facts (importance 2)
 *   ephemeral  — one-off mentions (importance 1)
 */
export async function extractAndSaveMemories(
  userId: string,
  userText: string,
  assistantText: string,
  sessionId: string
): Promise<void> {
  try {
    const prompt = `Analisis percakapan ini dan ekstrak FAKTA PENTING tentang pengguna.
Simpan sebagai JSON array dengan bentuk:
[{"content": "...", "category": "personal|preference|contextual|general|ephemeral", "importance": 1-5, "key": "..."}]
- importance 5 = fakta inti (nama, pekerjaan, kota, keluarga)
- importance 4 = preferensi (makanan favorit, kebiasaan, bahasa)
- importance 3 = konteks terkini (topik yang sedang dibahas)
- importance 2 = fakta umum yang berguna
- importance 1 = sebutan sekali, tidak penting
Kembalikan 0-3 fakta saja. Hanya JSON, tidak ada penjelasan lain.
Percakapan:
Pengguna: ${userText.slice(0, 500)}
Asisten: ${assistantText.slice(0, 500)}`;

    const result = await minimaxChat([
      { role: "system", content: prompt },
    ]);

    const facts = parseFactsFromLLM(result);

    for (const fact of facts) {
      await saveMemory(userId, fact.content, {
        category: fact.category,
        importance: fact.importance,
        memoryKey: fact.key,
        source: "extractor",
      });
    }
  } catch (err) {
    console.warn("[Memory] extractAndSaveMemories failed:", err);
  }
}

/**
 * Save a conversation turn (called after each exchange).
 */
export async function saveTurn(
  userId: string,
  sessionId: string,
  role: "user" | "assistant",
  text: string,
  options: {
    sttConfidence?: number;
    contextUsed?: string[];
    latencyMs?: number;
  } = {}
): Promise<void> {
  try {
    const { sttConfidence, contextUsed, latencyMs } = options;

    // Get next turn number
    const [countResult] = await pool.execute<any[]>(
      `SELECT COALESCE(MAX(turn_number), 0) + 1 AS next_num
       FROM conversation_turns
       WHERE user_id = ? AND session_id = ?`,
      [userId, sessionId]
    );
    const turnNumber = countResult[0]?.next_num || 1;

    if (role === "user") {
      await pool.execute(
        `INSERT INTO conversation_turns
           (user_id, session_id, turn_number, role, user_text, stt_confidence, context_used, latency_ms)
         VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`,
        [
          userId,
          sessionId,
          turnNumber,
          text,
          sttConfidence ?? null,
          JSON.stringify(contextUsed ?? []),
          latencyMs ?? null,
        ]
      );
    } else {
      await pool.execute(
        `UPDATE conversation_turns
         SET assistant_text = ?, tts_duration_ms = ?
         WHERE user_id = ? AND session_id = ? AND turn_number = ?`,
        [
          text,
          null, // TTS duration — fill in from TTS callback if available
          userId,
          sessionId,
          turnNumber,
        ]
      );
    }
  } catch (err) {
    console.warn("[Memory] saveTurn failed:", err);
  }
}

/**
 * Generate and save a session summary.
 * Call this when a session ends or every N turns for long sessions.
 */
export async function generateSessionSummary(
  userId: string,
  sessionId: string
): Promise<string> {
  try {
    const [turns] = await pool.execute<any[]>(
      `SELECT user_text, assistant_text
       FROM conversation_turns
       WHERE user_id = ? AND session_id = ?
       ORDER BY turn_number ASC`,
      [userId, sessionId]
    );

    const transcript = (turns as any[])
      .map(
        (t) =>
          `Pengguna: ${t.user_text || ""}\nAsisten: ${t.assistant_text || ""}`
      )
      .join("\n---\n");

    const prompt = `Buat ringkasan sesi percakapan voice assistant ini.
Format: {"summary": "...", "topics": ["topic1", "topic2"], "sentiment": "positive|neutral|negative", "follow_up_needed": true|false, "follow_up_note": "..."}
Bahasa Indonesia. Ringkasan max 3 kalimat. Topics max 4 kata kunci.`;

    const result = await minimaxChat([{ role: "system", content: prompt }]);
    const parsed = JSON.parse(extractJSON(result));

    await pool.execute(
      `INSERT INTO session_summaries
         (user_id, session_id, summary_text, key_topics, sentiment, follow_up_needed, follow_up_note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        sessionId,
        parsed.summary || result,
        JSON.stringify(parsed.topics || []),
        parsed.sentiment || "neutral",
        parsed.follow_up_needed || false,
        parsed.follow_up_note || null,
      ]
    );

    return parsed.summary || result;
  } catch (err) {
    console.warn("[Memory] generateSessionSummary failed:", err);
    return "";
  }
}

/**
 * Upsert user profile (e.g. after the agent learns their name).
 */
export async function upsertUserProfile(
  userId: string,
  updates: Partial<UserProfile>
): Promise<void> {
  const fields = Object.entries(updates)
    .filter(([k]) => k !== "user_id")
    .map(([k]) => `${k} = VALUES(${k})`)
    .join(", ");

  if (!fields) return;

  try {
    await pool.execute(
      `INSERT INTO user_profiles (user_id, ${Object.keys(updates).join(", ")})
       VALUES (?, ${Object.keys(updates)
         .map(() => "?")
         .join(", ")})
       ON DUPLICATE KEY UPDATE ${fields}`,
      [userId, ...Object.values(updates)]
    );
  } catch (err) {
    console.warn("[Memory] upsertUserProfile failed:", err);
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

function parseFactsFromLLM(raw: string): Array<{
  content: string;
  category: MemoryEntry["category"];
  importance: number;
  key: string;
}> {
  try {
    const json = extractJSON(raw);
    const facts = JSON.parse(json);
    return (Array.isArray(facts) ? facts : []).map((f: any) => ({
      content: f.content || f.fact || "",
      category:
        f.category === "personal"
          ? "personal"
          : f.category === "preference"
          ? "preference"
          : f.category === "contextual"
          ? "contextual"
          : f.category === "ephemeral"
          ? "ephemeral"
          : "general",
      importance: Math.min(5, Math.max(1, f.importance || 3)),
      key: f.key || `fact_${Date.now()}`,
    }));
  } catch {
    return [];
  }
}

function extractJSON(text: string): string {
  // Try to find JSON in markdown code blocks first
  const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) return codeMatch[1].trim();
  // Otherwise try to find first { to last }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}
