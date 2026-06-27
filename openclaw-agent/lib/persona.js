/**
 * NewMe Persona Engine
 *
 * Jarvis-like AI partner. Not a chatbot — a thinking companion.
 * Core principles:
 * 1. Know the user deeply (memory + profile)
 * 2. Think before responding (reasoning)
 * 3. Proactively help (don't just wait)
 * 4. Take ownership of tasks (not just answer questions)
 * 5. Be honest about limitations
 */

const {
  NEWME_IDENTITY,
  NEWME_VALUES,
  NEWME_REASONING,
  NEWME_CONVERSATION,
  NEWME_PROACTIVITY,
  NEWME_TOOLS_AWARENESS,
} = require("./persona_core");

// ── Build system prompt for any LLM ────────────────────────────────────────
function buildSystemPrompt(userProfile = {}, recentContext = [], activeGoals = []) {
  const identity = NEWME_IDENTITY();
  const values = NEWME_VALUES();
  const reasoning = NEWME_REASONING();
  const conversation = NEWME_CONVERSATION();
  const proactivity = NEWME_PROACTIVITY();
  const toolsAwareness = NEWME_TOOLS_AWARENESS();

  // Build user context summary
  const userContext = buildUserContext(userProfile);

  return `${identity}

${values}

${userContext}

---

## HOW YOU THINK
${reasoning}

---

## HOW YOU COMMUNICATE
${conversation}

---

## WHEN TO PROACTIVELY HELP
${proactivity}

---

## YOUR TOOLS
${toolsAwareness}

---

## ACTIVE GOALS (work on these passively)
${activeGoals.length > 0 ? activeGoals.map(g => `- ${g}`).join("\n") : "- None right now. Stay alert."}`;
}

function buildUserContext(profile = {}) {
  const sections = [];

  if (profile.name) sections.push(`- Nama: ${profile.name}`);
  if (profile.language) sections.push(`- Bahasa: ${profile.language}`);
  if (profile.talkStyle) sections.push(`- Gaya bicara: ${profile.talkStyle}`);
  if (profile.responseLength) sections.push(`- Preferensi jawaban: ${profile.responseLength}`);
  if (profile.interests?.length) sections.push(`- Minat: ${profile.interests.join(", ")}`);
  if (profile.goals?.length) sections.push(`- Goals aktif: ${profile.goals.map(g => `${g.title} (${g.status})`).join(", ")}`);
  if (profile.habits?.length) sections.push(`- Kebiasaan: ${profile.habits.join("; ")}`);
  if (profile.lastConversation) sections.push(`- Percakapan terakhir: ${profile.lastConversation}`);

  return sections.length > 0
    ? `\n## YANG KAUKETAHUI TENTANG PENGGUNA\n${sections.join("\n")}`
    : "\n## YANG KAUKETAHUI TENTANG PENGGUNA\n- (belum ada info — kenali seiring waktu)";
}

// ── Build response style based on user preferences ───────────────────────────
function buildResponseStyle(profile = {}) {
  const length = profile.responseLength || "short";
  const language = profile.language || "indonesian";

  const lengthMap = {
    short: "1-3 kalimat. Langsung ke inti.",
    medium: "3-5 kalimat. Cukup detail tapi nggak bertele-tele.",
    detailed: "7-10 kalimat. Penjelasan lengkap tapi tetap rapi.",
  };

  const langMap = {
    indonesian: "Selalu gunakan Bahasa Indonesia.",
    english: "Respond in English.",
    bilingual: "Follow the user's language — mix if they do.",
  };

  return `${lengthMap[length] || lengthMap.short}\n${langMap[language] || langMap.indonesian}`;
}

// ── Reasoning framework ─────────────────────────────────────────────────────
const REASONING_STEPS = [
  "1. APA yang sebenarnya pengguna butuhkan? (bukan cuma yang mereka bilang)",
  "2. APAKAH ada konteks dari percakapan sebelumnya yang relevan?",
  "3. APAKAH ini tugas yang perlu dipecah jadi langkah-langkah?",
  "4. APAKAH ada tool yang tepat untuk ini?",
  "5. APAKAH aku perlu konfirmasi sebelum bertindak?",
  "6. APAKAH aku bisa memproactively offer sesuatu yang berguna?",
];

function buildReasoningPrompt(context = "") {
  return `
Pikirkan sebelum menjawab. Gunakan reasoning step ini:

${REASONING_STEPS.join("\n")}

${context ? `KONTEKS PENTING:\n${context}` : ""}

Jawaban akhir:`;
}

// ── Goal tracking ──────────────────────────────────────────────────────────
class GoalTracker {
  constructor() {
    this.goals = new Map(); // userId → Goal[]
  }

  add(userId, goal) {
    if (!this.goals.has(userId)) this.goals.set(userId, []);
    this.goals.get(userId).push({
      id: `goal_${Date.now()}`,
      title: goal.title,
      steps: goal.steps || [],
      currentStep: 0,
      status: "active", // active, completed, abandoned
      createdAt: new Date(),
      context: goal.context || "",
    });
    return this.get(userId).slice(-1)[0];
  }

  get(userId) {
    return (this.goals.get(userId) || []).filter(g => g.status === "active");
  }

  update(userId, goalId, update) {
    const goals = this.goals.get(userId) || [];
    const goal = goals.find(g => g.id === goalId);
    if (goal) Object.assign(goal, update);
    return goal;
  }

  complete(userId, goalId) {
    return this.update(userId, goalId, { status: "completed" });
  }

  getActiveGoalContext(userId) {
    const active = this.get(userId);
    if (active.length === 0) return [];
    return active.map(g => ({
      title: g.title,
      progress: `${g.currentStep + 1}/${g.steps.length}`,
      nextStep: g.steps[g.currentStep] || null,
      context: g.context,
    }));
  }
}

const goalTracker = new GoalTracker();

// ── Suggestion engine ──────────────────────────────────────────────────────
function generateSuggestions(userProfile, conversationHistory, timeContext = {}) {
  const suggestions = [];

  // Based on goals
  const activeGoals = goalTracker.get(userProfile.userId || "default");
  for (const goal of activeGoals.slice(0, 2)) {
    suggestions.push({
      type: "goal",
      priority: "high",
      text: `Lanjut ke langkah ${goal.currentStep + 1} dari "${goal.title}"?`,
      action: `continue_goal:${goal.id}`,
    });
  }

  // Based on time
  const hour = timeContext.hour || new Date().getHours();
  if (hour >= 6 && hour < 9 && !userProfile.goodMorning) {
    suggestions.push({
      type: "routine",
      priority: "medium",
      text: "Selamat pagi! Ada yang mau dicapai hari ini?",
      action: "check_goals",
    });
  }
  if (hour >= 21 && hour < 24 && !userProfile.goodNight) {
    suggestions.push({
      type: "routine",
      priority: "low",
      text: "Malam! Mau回顾 hari ini sebelum istirahat?",
      action: "daily_review",
    });
  }

  // Based on patterns
  if (conversationHistory.length > 5) {
    suggestions.push({
      type: "memory",
      priority: "low",
      text: "Kayaknya kita udah ngobrol banyak — aku simpen yang penting ya?",
      action: "save_context",
    });
  }

  return suggestions;
}

module.exports = {
  buildSystemPrompt,
  buildUserContext,
  buildResponseStyle,
  buildReasoningPrompt,
  goalTracker,
  generateSuggestions,
  REASONING_STEPS,
};
