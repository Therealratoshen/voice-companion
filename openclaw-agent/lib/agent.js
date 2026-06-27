/**
 * NewMe Agent v2 — Jarvis-style AI Partner
 *
 * Multi-step reasoning agent with:
 * - Deep persona (Jarvis-inspired)
 * - User profile + goal tracking
 * - Proactive suggestion engine
 * - Tool calling (Groq as reasoning engine)
 *
 * NOT a chatbot. A thinking partner who:
 * 1. Understands what user actually needs
 * 2. Plans before acting
 * 3. Remembers everything
 * 4. Proactively helps
 */

const { groqChat } = require('./groq');
const { webSearch, formatForLLM } = require('./functions/web_search');
const { executeCode, extractCode, detectLanguage } = require('./functions/code_executor');
const { createReminder, listReminders, cancelReminder } = require('./functions/reminders');
const { vectorSearch } = require('./memory/tidb_mem9');
const {
  buildSystemPrompt,
  buildReasoningPrompt,
  goalTracker,
  generateSuggestions,
} = require('./persona');
const {
  getProfile,
  extractProfileFacts,
  addGoal,
  getActiveGoals,
  updateGoalStep,
  completeGoal,
  detectHabits,
  buildProfileContext,
} = require('./user_profile');

const MAX_TOOL_CALLS = 6;
const REASONING_MODEL = 'llama-3.3-70b-versatile';

// ── Tool registry ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'web_search',
    description: 'Cari informasi di internet untuk berita, fakta terkini, cuaca, harga.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query pencarian spesifik' },
      },
      required: ['query'],
    },
  },
  {
    name: 'execute_code',
    description: 'Jalankan JavaScript untuk kalkulasi, generate code, atau data processing.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code' },
        language: { type: 'string', description: 'javascript atau python', default: 'javascript' },
      },
      required: ['code'],
    },
  },
  {
    name: 'create_reminder',
    description: 'Buat pengingat untuk masa depan.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        text: { type: 'string', description: 'Deskripsi: "Ingatkan aku jam 3 sore untuk..."' },
      },
      required: ['userId', 'text'],
    },
  },
  {
    name: 'list_reminders',
    description: 'Lihat semua pengingat aktif.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'cancel_reminder',
    description: 'Batalkan pengingat.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        reminderId: { type: 'string' },
      },
      required: ['userId', 'reminderId'],
    },
  },
  {
    name: 'search_memory',
    description: 'Cari info dari percakapan sebelumnya.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        query: { type: 'string', description: 'Keyword atau concept untuk dicari' },
        limit: { type: 'number', default: 5 },
      },
      required: ['userId', 'query'],
    },
  },
  {
    name: 'remember_fact',
    description: 'Simpan fakta penting tentang user.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        content: { type: 'string', description: 'Fakta yang akan diingat' },
        key: { type: 'string' },
      },
      required: ['userId', 'content'],
    },
  },
  {
    name: 'add_goal',
    description: 'Tambahkan goal baru untuk di-track progressnya.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        title: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
        deadline: { type: 'string' },
      },
      required: ['userId', 'title'],
    },
  },
  {
    name: 'continue_goal',
    description: 'Lanjut ke langkah berikutnya dari goal aktif.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        goalId: { type: 'string' },
      },
      required: ['userId', 'goalId'],
    },
  },
  {
    name: 'done',
    description: 'SELESAI. Panggil di akhir setiap conversation turn. WAJIB.',
    parameters: {
      type: 'object',
      properties: {
        response: { type: 'string', description: 'Jawaban final ke user dalam Bahasa Indonesia natural' },
        proactive: { type: 'string', description: 'Optional: proactive suggestion untuk next step' },
      },
      required: ['response'],
    },
  },
];

// ── Tool executor ──────────────────────────────────────────────────────────
async function executeTool(name, args) {
  console.log(`[Agent] Tool: ${name}`, JSON.stringify(args).substring(0, 120));

  try {
    switch (name) {
      case 'web_search': {
        const { query } = args;
        const result = await webSearch(query);
        if (!result.success) return `Pencarian gagal: ${result.error}`;
        return formatForLLM(result.results, query);
      }

      case 'execute_code': {
        const code = extractCode(args.code || '');
        const lang = args.language || detectLanguage(code);
        const result = await executeCode(code, lang);
        if (!result.success) return `Error: ${result.error}`;
        return `Hasil:\n${result.result}`;
      }

      case 'create_reminder': {
        const { userId, text } = args;
        const result = createReminder(userId, text);
        if (!result.success) return `Gagal: ${result.error}`;
        return `Pengingat dibuat! "${result.reminder.text}" — ${result.reminder.in}`;
      }

      case 'list_reminders': {
        const { userId } = args;
        const reminders = listReminders(userId);
        if (!reminders.length) return 'Tidak ada pengingat aktif.';
        return 'Pengingat aktif:\n' + reminders.map(r =>
          `${r.id}: "${r.text}" (${r.in})`
        ).join('\n');
      }

      case 'cancel_reminder': {
        const { userId, reminderId } = args;
        const result = cancelReminder(userId, reminderId);
        return result.success ? 'Pengingat dibatalkan.' : `Gagal: ${result.error}`;
      }

      case 'search_memory': {
        const { userId, query, limit = 5 } = args;
        const memories = await vectorSearch(userId, query, limit);
        if (!memories.length) return 'Tidak ada yang ingat untuk query ini.';
        return 'Yang aku ingat:\n' + memories.map(m =>
          `• ${m.content} (${(m.similarity * 100).toFixed(0)}% match)`
        ).join('\n');
      }

      case 'remember_fact': {
        const { userId, content, key } = args;
        // Use tidb_mem9 directly for embedding
        const { upsertMemoryWithEmbedding } = require('./memory/tidb_mem9');
        const result = await upsertMemoryWithEmbedding(userId, content, key);
        return result.success ? `Tersimpan! "${content}"` : `Gagal menyimpan: ${result.error}`;
      }

      case 'add_goal': {
        const { userId, title, steps = [], deadline } = args;
        const goal = await addGoal(userId, { title, steps, deadline });
        const stepsText = steps.length > 0
          ? `\nLangkah-langkah:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
          : '';
        return `Goal ditambahkan! 🎯 "${title}"${stepsText}`;
      }

      case 'continue_goal': {
        const { userId, goalId } = args;
        const goals = await getActiveGoals(userId);
        const goal = goals.find(g => g.id === goalId);
        if (!goal) return 'Goal tidak ditemukan.';
        const nextStep = goal.steps[goal.currentStep];
        if (!nextStep) {
          await completeGoal(userId, goalId);
          return `Semua langkah "${goal.title}" sudah selesai! 🎉`;
        }
        await updateGoalStep(userId, goalId, goal.currentStep + 1);
        return `Langkah ${goal.currentStep + 1}/${goal.steps.length} dari "${goal.title}":\n${nextStep}`;
      }

      case 'done': {
        return '__DONE__' + JSON.stringify({ response: args.response, proactive: args.proactive });
      }

      default:
        return `Tool tidak dikenal: ${name}`;
    }
  } catch (err) {
    console.error(`[Agent] Tool ${name} error:`, err.message);
    return `Error executing ${name}: ${err.message}`;
  }
}

// ── Parse tool calls ───────────────────────────────────────────────────────
function parseToolCalls(text) {
  const calls = [];
  const jsonBlocks = text.match(/```json\n?([\s\S]*?)```/g) || [];
  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block.replace(/```json\n?/, '').replace(/```/, ''));
      if (parsed.tool && parsed.args) calls.push(parsed);
      if (Array.isArray(parsed)) parsed.forEach(item => {
        if (item.tool && item.args) calls.push(item);
      });
    } catch {}
  }

  // Also try plain JSON objects
  if (calls.length === 0) {
    const matches = text.match(/\{[^{}]*"tool"[^{}]*"args"[^{}]*\}/g) || [];
    for (const match of matches) {
      try {
        const parsed = JSON.parse(match);
        if (parsed.tool && parsed.args) calls.push(parsed);
      } catch {}
    }
  }

  return calls;
}

// ── Main agent ─────────────────────────────────────────────────────────────
async function runAgent(userId, message, history = []) {
  const toolCalls = [];
  const profile = await getProfile(userId);
  const activeGoals = await getActiveGoals(userId);
  const profileContext = await buildProfileContext(userId);
  const memories = await vectorSearch(userId, message, 3);

  // Build memory context
  const memoryContext = memories.length > 0
    ? '\nMEMORI RELEVAN:\n' + memories.map(m => `• ${m.content}`).join('\n')
    : '';

  // Build system prompt with full context
  const systemPrompt = buildSystemPrompt(
    profile,
    history.slice(-10),
    activeGoals.map(g => `"${g.title}" — langkah ${g.currentStep + 1}/${g.steps.length}`)
  );

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-15).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  // Step 1: REASONING — understand before acting
  const reasoningPrompt = buildReasoningPrompt(
    `User message: ${message}\n\nProfile context:\n${profileContext}${memoryContext}\n\nActive goals: ${activeGoals.length > 0 ? activeGoals.map(g => `"${g.title}" (${g.currentStep + 1}/${g.steps.length}): ${g.steps[g.currentStep] || 'completed'}`).join('\n') : 'None'}`
  );

  const reasoningMessages = [
    { role: 'system', content: 'Kamu NewMe. PIKIR sebelum bertindak. Use tool calls untuk setiap action yang dibutuhkan.' },
    { role: 'user', content: reasoningPrompt },
  ];

  const reasoningRes = await groqChat(reasoningMessages, { model: REASONING_MODEL, temperature: 0.3 });
  const reasoning = reasoningRes.choices?.[0]?.message?.content || '';
  console.log(`[Agent] ${userId} reasoning: "${reasoning.substring(0, 80)}..."`);

  // Step 2: Tool calling loop
  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const llmRes = await groqChat(messages, { model: REASONING_MODEL, temperature: 0.6 });
    const content = llmRes.choices?.[0]?.message?.content || '';

    if (!content.trim()) break;

    messages.push({ role: 'assistant', content });

    const calls = parseToolCalls(content);
    if (calls.length === 0) {
      // No tool call — this might be a direct response. Check for done.
      if (content.toLowerCase().includes('__done__') || content.includes('done()')) {
        const doneMatch = content.match(/done\s*\(\s*\{[^}]*response\s*:\s*"([^"]+)"/);
        if (doneMatch) {
          return parseDoneResult(doneMatch[1], toolCalls);
        }
      }
      // Check if response is done without explicit tool call
      if (i > 0 || content.length > 20) {
        return { response: content.trim(), toolCalls, reasoning };
      }
      continue;
    }

    for (const call of calls) {
      toolCalls.push(call);
      const result = await executeTool(call.tool, call.args);

      if (call.tool === 'done') {
        return parseDoneResult(result, toolCalls);
      }

      messages.push({
        role: 'system',
        content: `[Tool Result: ${call.tool}]\n${result}\n\nContinue or call done().`,
      });
    }
  }

  // Max iterations — return what we have
  const lastMsg = messages[messages.length - 1];
  return {
    response: lastMsg?.content?.substring(0, 500) || 'Maaf, butuh waktu lebih lama. Bisa coba yang lebih spesifik?',
    toolCalls,
    reasoning,
  };
}

function parseDoneResult(result, toolCalls) {
  try {
    const json = result.replace(/^__DONE__/, '');
    const parsed = JSON.parse(json);
    return {
      response: parsed.response || '',
      proactive: parsed.proactive || null,
      toolCalls,
    };
  } catch {
    return {
      response: result.replace(/^__DONE__/, '').trim(),
      proactive: null,
      toolCalls,
    };
  }
}

// ── Post-processing: extract facts + update profile ─────────────────────────
async function postProcess(userId, message, response) {
  // Extract profile facts
  await extractProfileFacts(userId, message, response);

  // Detect habits every 20 messages
  const profile = await getProfile(userId);
  const messageCount = profile._messageCount || 0;
  if (messageCount > 0 && messageCount % 20 === 0) {
    await detectHabits(userId);
  }

  // Increment message count
  await require('./user_profile').updateProfile(userId, { _messageCount: messageCount + 1 });
}

// ── Streaming version ────────────────────────────────────────────────────────
async function* runAgentStream(userId, message, history = []) {
  const { response, proactive, toolCalls } = await runAgent(userId, message, history);
  yield { response, proactive, toolCalls, done: true };
}

module.exports = {
  runAgent,
  runAgentStream,
  executeTool,
  TOOLS,
  postProcess,
};
