/**
 * NewMe User Profile System
 *
 * Tracks user preferences, goals, habits, and conversation patterns.
 * Stored in TiDB alongside existing memory tables.
 *
 * Profile schema:
 * - basic: name, language, timezone, created_at
 * - preferences: response_length, tone, topics, communication_style
 * - goals: active goals with steps and progress
 * - habits: detected patterns from conversation
 * - summary: last conversation context for quick recall
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
      connectionLimit: 5,
    });
  }
  return _pool;
}

// ── Schema helpers ───────────────────────────────────────────────────────────
async function ensureProfileTable() {
  const pool = getPool();
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_profile (
        user_id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128),
        language VARCHAR(16) DEFAULT 'indonesian',
        timezone VARCHAR(32) DEFAULT 'Asia/Jakarta',
        response_length VARCHAR(16) DEFAULT 'short',
        tone VARCHAR(32) DEFAULT 'friendly',
        interests JSON,
        goals JSON,
        habits JSON,
        last_conversation TEXT,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (err) {
    console.warn('[Profile] Table creation skipped:', err.message);
  }
}

// ── Get profile ──────────────────────────────────────────────────────────────
async function getProfile(userId) {
  const pool = getPool();
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM user_profile WHERE user_id = ?',
      [userId]
    );
    if (rows.length === 0) return createDefaultProfile(userId);
    return deserializeProfile(rows[0]);
  } catch (err) {
    console.warn('[Profile] get failed:', err.message);
    return createDefaultProfile(userId);
  }
}

function createDefaultProfile(userId) {
  return {
    userId,
    name: null,
    language: 'indonesian',
    timezone: 'Asia/Jakarta',
    responseLength: 'short',
    tone: 'friendly',
    interests: [],
    goals: [],
    habits: [],
    lastConversation: null,
    lastSeen: null,
  };
}

function deserializeProfile(row) {
  return {
    userId: row.user_id,
    name: row.name,
    language: row.language || 'indonesian',
    timezone: row.timezone || 'Asia/Jakarta',
    responseLength: row.response_length || 'short',
    tone: row.tone || 'friendly',
    interests: safeParseJSON(row.interests) || [],
    goals: safeParseJSON(row.goals) || [],
    habits: safeParseJSON(row.habits) || [],
    lastConversation: row.last_conversation,
    lastSeen: row.last_seen,
  };
}

function safeParseJSON(val) {
  if (!val) return null;
  try { return typeof val === 'object' ? val : JSON.parse(val); }
  catch { return null; }
}

// ── Upsert profile ───────────────────────────────────────────────────────────
async function updateProfile(userId, updates) {
  const pool = getPool();
  const allowed = ['name', 'language', 'timezone', 'response_length', 'tone'];
  const fields = [];
  const values = [];

  for (const [key, val] of Object.entries(updates)) {
    const dbKey = camelToSnake(key);
    if (allowed.includes(dbKey) || ['interests', 'goals', 'habits', 'last_conversation'].includes(dbKey)) {
      fields.push(`${dbKey} = VALUES(${dbKey})`);
      values.push(dbKey === 'user_id' ? userId : (typeof val === 'object' ? JSON.stringify(val) : val));
    }
  }

  if (fields.length === 0) return;

  // Always set user_id
  const allFields = ['user_id', ...fields];
  const allValues = [userId, ...values];
  const placeholders = allFields.map(() => '?').join(', ');

  try {
    await pool.execute(
      `INSERT INTO user_profile (${allFields.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${fields.join(', ')}`,
      allValues
    );
  } catch (err) {
    console.warn('[Profile] update failed:', err.message);
  }
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

// ── Extract profile facts from conversation ─────────────────────────────────
/**
 * Analyze conversation and extract/update profile facts.
 * Called after every conversation turn.
 */
async function extractProfileFacts(userId, userMessage, assistantMessage) {
  const profile = await getProfile(userId);
  const updates = {};

  // Extract name
  const namePatterns = [
    /(?:nama(?:ku|saya) (?:adalah )?(?:aku )?(?:adalah )?)([A-Z][a-z]+)/i,
    /(?:call me|I'm|i'm|panggil )(me )?([A-Z][a-z]+)/i,
    /(?:aku |saya )([A-Z][a-z]+)/,
  ];
  for (const p of namePatterns) {
    const m = userMessage.match(p);
    if (m && m[1] && m[1].length < 30) {
      if (!profile.name || profile.name !== m[1]) {
        updates.name = m[1];
      }
      break;
    }
  }

  // Extract language preference
  if (/\b(english|speak english|in english)\b/i.test(userMessage)) {
    updates.language = 'english';
  } else if (/\b(Indonesia|bahasa)\b/i.test(userMessage)) {
    updates.language = 'indonesian';
  }

  // Extract response length preference
  if (/\b(pendek|singkat|tapi satu|two sentences|tapi satu|one line)\b/i.test(userMessage)) {
    updates.response_length = 'short';
  } else if (/\b(detail|explain|lengkap|panjang|more detail)\b/i.test(userMessage)) {
    updates.response_length = 'detailed';
  }

  // Extract interests
  const interestPatterns = [
    /(?:lagi|tengah|sering) (?:belajar|kerja|ngembangin) ([\w\s]+)/i,
    /(?:minat|tertarik|passionate) (?:dengan|di|pada) ([\w\s]+)/i,
    /(?:lagi|sedang) fokus (?:di|pada) ([\w\s]+)/i,
  ];
  const newInterests = [...(profile.interests || [])];
  for (const p of interestPatterns) {
    const m = userMessage.match(p);
    if (m && m[1] && !newInterests.includes(m[1].trim())) {
      newInterests.push(m[1].trim());
      if (newInterests.length > 10) newInterests.shift(); // keep last 10
    }
  }
  if (newInterests.length !== (profile.interests || []).length) {
    updates.interests = newInterests;
  }

  // Update last conversation summary (last 200 chars)
  updates.last_conversation = userMessage.substring(0, 200);

  // Save updates
  if (Object.keys(updates).length > 0) {
    await updateProfile(userId, updates);
  }

  return { profile: await getProfile(userId), updates };
}

// ── Goal management ─────────────────────────────────────────────────────────
async function addGoal(userId, goal) {
  const profile = await getProfile(userId);
  const goals = [...(profile.goals || [])];
  const newGoal = {
    id: `goal_${Date.now()}`,
    title: goal.title,
    steps: goal.steps || [],
    currentStep: 0,
    status: 'active',
    createdAt: new Date().toISOString(),
    deadline: goal.deadline || null,
  };
  goals.push(newGoal);
  await updateProfile(userId, { goals });
  return newGoal;
}

async function getActiveGoals(userId) {
  const profile = await getProfile(userId);
  return (profile.goals || []).filter(g => g.status === 'active');
}

async function updateGoalStep(userId, goalId, step) {
  const profile = await getProfile(userId);
  const goals = profile.goals || [];
  const goal = goals.find(g => g.id === goalId);
  if (goal) {
    goal.currentStep = step;
    await updateProfile(userId, { goals });
  }
  return goal;
}

async function completeGoal(userId, goalId) {
  const profile = await getProfile(userId);
  const goals = profile.goals || [];
  const goal = goals.find(g => g.id === goalId);
  if (goal) {
    goal.status = 'completed';
    goal.completedAt = new Date().toISOString();
    await updateProfile(userId, { goals });
  }
  return goal;
}

// ── Habit detection ────────────────────────────────────────────────────────
/**
 * Detect patterns from conversation history.
 * Returns detected habits and suggestions for profile updates.
 */
async function detectHabits(userId) {
  const pool = getPool();
  try {
    const [rows] = await pool.execute(
      `SELECT content, created_at FROM conversations
       WHERE user_id = ? AND channel = 'voice'
       ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );

    const messages = rows.map(r => r.content);
    const habits = [];

    // Time patterns
    const hours = rows.map(r => new Date(r.created_at).getHours());
    const avgHour = hours.reduce((a, b) => a + b, 0) / hours.length;
    if (avgHour >= 6 && avgHour < 12) habits.push('morning_person');
    if (avgHour >= 21 || avgHour < 3) habits.push('night_owl');
    if (avgHour >= 12 && avgHour < 17) habits.push('afternoon_active');

    // Length patterns
    const avgLength = messages.reduce((a, b) => a + b.length, 0) / messages.length;
    if (avgLength < 30) habits.push('short_messages');
    if (avgLength > 200) habits.push('detailed_messages');

    // Topic patterns (keyword detection)
    const allText = messages.join(' ').toLowerCase();
    const topics = {
      coding: ['code', 'programming', 'javascript', 'python', 'react', 'build', 'app'],
      business: ['business', 'startup', 'revenue', 'customer', 'sales', 'marketing'],
      health: ['health', 'workout', 'gym', 'sleep', 'mental', 'stress'],
      learning: ['learn', 'course', 'study', 'course', 'tutorial', 'belajar'],
      finance: ['invest', 'money', 'crypto', 'saving', 'budget', 'passive income'],
    };
    for (const [topic, keywords] of Object.entries(topics)) {
      const count = keywords.filter(k => allText.includes(k)).length;
      if (count >= 3) habits.push(`interested_in_${topic}`);
    }

    // Save habits
    if (habits.length > 0) {
      await updateProfile(userId, { habits });
    }

    return habits;
  } catch (err) {
    console.warn('[Profile] habit detection failed:', err.message);
    return [];
  }
}

// ── Build profile context for LLM ─────────────────────────────────────────
async function buildProfileContext(userId) {
  const profile = await getProfile(userId);
  const goals = await getActiveGoals(userId);

  let context = '';

  if (profile.name) context += `Nama: ${profile.name}\n`;
  if (profile.interests?.length) context += `Minat: ${profile.interests.join(', ')}\n`;
  if (profile.goals?.length) {
    context += `Goals aktif:\n`;
    for (const g of goals) {
      context += `  - "${g.title}" [${g.currentStep + 1}/${g.steps.length}]\n`;
    }
  }
  if (profile.habits?.length) {
    context += `Pola: ${profile.habits.join(', ')}\n`;
  }
  if (profile.lastConversation) {
    context += `Terakhir ngobrol soal: ${profile.lastConversation.substring(0, 100)}\n`;
  }

  return context || 'No profile data yet.';
}

module.exports = {
  getProfile,
  updateProfile,
  extractProfileFacts,
  addGoal,
  getActiveGoals,
  updateGoalStep,
  completeGoal,
  detectHabits,
  buildProfileContext,
  ensureProfileTable,
};
