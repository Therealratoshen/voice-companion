/**
 * OpenClaw Function Calling Agent
 *
 * Orchestrates the full agentic loop:
 * 1. LLM decides if a tool is needed
 * 2. Execute tool, get result
 * 3. Continue with result, repeat if needed
 * 4. Return final response
 *
 * Uses Groq with tool-calling via structured prompting
 * (Groq doesn't support native function calling, so we use a
 *  structured output approach: LLM outputs JSON tool calls)
 */

const { webSearch, formatForLLM } = require("./functions/web_search");
const { executeCode, extractCode, detectLanguage } = require("./functions/code_executor");
const { createReminder, listReminders, cancelReminder } = require("./functions/reminders");
const { vectorSearch, upsertMemoryWithEmbedding } = require("./memory/tidb_mem9");
const { groqChat, groqStream } = require("./groq");

const MAX_TOOL_CALLS = 5;
const MAX_HISTORY = 20;

// ── Tool Definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "web_search",
    description: "Cari informasi di internet. Gunakan untuk pertanyaan tentang berita, fakta, harga, cuaca, atau topik yang membutuhkan informasi terkini.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Query pencarian dalam Bahasa Indonesia atau Inggris. Buat spesifik untuk hasil terbaik.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "execute_code",
    description: "Jalankan kode JavaScript atau Python. Gunakan untuk kalkulasi, manipulasi data, atau menghasilkan output berdasarkan logika.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Kode yang akan dijalankan. Untuk JavaScript atau Python.",
        },
        language: {
          type: "string",
          description: "Bahasa pemrograman: 'javascript' atau 'python'. Default: javascript.",
          enum: ["javascript", "python"],
        },
      },
      required: ["code"],
    },
  },
  {
    name: "create_reminder",
    description: "Buat pengingat untuk di masa depan. Parse waktu dari deskripsi natural language Indonesia.",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "ID pengguna untuk pengingat ini.",
        },
        text: {
          type: "string",
          description: "Deskripsi lengkap termasuk waktu dan isi pengingat. Contoh: 'Ingatkan saya jam 3 sore untuk meeting dengan Budi'",
        },
      },
      required: ["userId", "text"],
    },
  },
  {
    name: "list_reminders",
    description: "Lihat semua pengingat aktif milik pengguna.",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "ID pengguna",
        },
      },
      required: ["userId"],
    },
  },
  {
    name: "cancel_reminder",
    description: "Batalkan pengingat yang sudah ada.",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "ID pengguna",
        },
        reminderId: {
          type: "string",
          description: "ID pengingat yang akan dibatalkan",
        },
      },
      required: ["userId", "reminderId"],
    },
  },
  {
    name: "search_memory",
    description: "Cari memori pengguna di database. Gunakan untuk mengingat preferensi, fakta, atau konteks dari percakapan sebelumnya.",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "ID pengguna",
        },
        query: {
          type: "string",
          description: "Query untuk mencari memori yang relevan.",
        },
        limit: {
          type: "number",
          description: "Jumlah maksimal hasil. Default: 5.",
          default: 5,
        },
      },
      required: ["userId", "query"],
    },
  },
  {
    name: "remember_fact",
    description: "Simpan fakta baru ke memori pengguna. Panggil ini setelah percakapan mengandung informasi penting tentang pengguna.",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "ID pengguna",
        },
        content: {
          type: "string",
          description: "Fakta yang akan disimpan. Buat deskriptif dan actionable.",
        },
        key: {
          type: "string",
          description: "Kunci unik untuk fakta ini. Gunakan format 'category_name'.",
        },
      },
      required: ["userId", "content"],
    },
  },
  {
    name: "done",
    description: "Tandakan bahwa tugas sudah selesai dan berikan jawaban akhir ke pengguna. WAJIB dipanggil di akhir setiap percakapan.",
    parameters: {
      type: "object",
      properties: {
        response: {
          type: "string",
          description: "Jawaban akhir untuk pengguna dalam Bahasa Indonesia yang natural.",
        },
      },
      required: ["response"],
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────
const AGENT_SYSTEM_PROMPT = `Kamu adalah asisten AI yang sangat helpful. Kamu memiliki akses ke berbagai tools untuk membantu pengguna.

ALUR KERJA:
1. Pahami pertanyaan pengguna
2. Tentukan apakah perlu memanggil tool
3. Jika perlu, panggil tool yang sesuai
4. Baca hasil tool
5. Ulangi sampai kamu bisa menjawab
6. Selalu panggil tool "done" di akhir

PRINSIP:
- Bahasa Indonesia untuk semua output ke pengguna
- Bahasa Indonesia atau Inggris untuk tool calls (sesuai input pengguna)
- Kalau butuh informasi terkini → web_search
- Kalau butuh kalkulasi → execute_code
- Kalau pengguna minta diingatkan sesuatu → create_reminder
- Kalau pengguna tanya tentang preferensi/masa lalu → search_memory
- Selalu panggil done() di akhir

FORMAT TOOL CALL (JSON):
\`\`\`json
{"tool": "nama_tool", "args": {"param1": "nilai1", "param2": "nilai2"}}
\`\`\`

Contoh:
Pengguna: "Cari berita tentang AI hari ini"
Tool call:
\`\`\`json
{"tool": "web_search", "args": {"query": "artificial intelligence news today 2024"}}
\`\`\`

Pengguna: "Hitung 15% dari 2500000"
Tool call:
\`\`\`json
{"tool": "execute_code", "args": {"code": "const result = 2500000 * 0.15; console.log(result);", "language": "javascript"}}
\`\`\`

Pengguna: "Ingatkan saya jam 3 sore untuk meeting"
Tool call:
\`\`\`json
{"tool": "create_reminder", "args": {"userId": "user_001", "text": "Ingatkan saya jam 3 sore untuk meeting"}}
\`\`\``;

// ── Execute tools ──────────────────────────────────────────────────────────
async function executeTool(name, args) {
  console.log(`[Agent] Tool call: ${name}`, JSON.stringify(args).substring(0, 100));

  try {
    switch (name) {
      case "web_search": {
        const { query } = args;
        const { success, results, error } = await webSearch(query);
        if (!success || results.length === 0) {
          return `Pencarian gagal: ${error || "tidak ada hasil"}. Coba kata kunci yang berbeda.`;
        }
        return formatForLLM(results, query);
      }

      case "execute_code": {
        const code = extractCode(args.code || args.code_string || "");
        const language = args.language || detectLanguage(code);
        const result = await executeCode(code, language);
        if (!result.success) {
          return `Error: ${result.error}\n\nLogs:\n${result.logs?.join("\n") || "none"}`;
        }
        return `Hasil:\n${result.result}\n${result.logs?.length ? "\nLogs:\n" + result.logs.join("\n") : ""}`;
      }

      case "create_reminder": {
        const { userId, text } = args;
        const result = createReminder(userId, text);
        if (!result.success) return `Gagal: ${result.error}`;
        return `Pengingat dibuat! Saya akan mengingatkan Anda ${result.reminder.in} untuk: "${result.reminder.text}"`;
      }

      case "list_reminders": {
        const { userId } = args;
        const reminders = listReminders(userId);
        if (reminders.length === 0) return "Tidak ada pengingat aktif.";
        return "Pengingat aktif Anda:\n" + reminders.map(r =>
          `• ${r.text} (${r.in}) — ID: ${r.id}`
        ).join("\n");
      }

      case "cancel_reminder": {
        const { userId, reminderId } = args;
        const result = cancelReminder(userId, reminderId);
        return result.success ? "Pengingat dibatalkan." : `Gagal: ${result.error}`;
      }

      case "search_memory": {
        const { userId, query, limit = 5 } = args;
        const memories = await vectorSearch(userId, query, limit);
        if (memories.length === 0) return "Tidak ada memori yang ditemukan untuk query ini.";
        return "Yang saya ingat:\n" + memories.map(m =>
          `• ${m.content} (similarity: ${(m.similarity * 100).toFixed(0)}%)`
        ).join("\n");
      }

      case "remember_fact": {
        const { userId, content, key } = args;
        const result = await upsertMemoryWithEmbedding(userId, content, key);
        return result.success
          ? `Tersimpan! Saya akan mengingat: "${content}"`
          : `Gagal menyimpan: ${result.error}`;
      }

      case "done": {
        return "__DONE__" + (args.response || "");
      }

      default:
        return `Tool tidak dikenal: ${name}`;
    }
  } catch (err) {
    console.error(`[Agent] Tool error (${name}):`, err);
    return `Error executing ${name}: ${err.message}`;
  }
}

// ── Parse tool calls from LLM output ───────────────────────────────────────
function parseToolCalls(text) {
  const calls = [];
  // Match ```json blocks
  const jsonBlocks = text.match(/```json\n?([\s\S]*?)```/g) || [];
  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block.replace(/```json\n?/, "").replace(/```/, ""));
      if (parsed.tool && parsed.args) {
        calls.push(parsed);
      } else if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.tool && item.args) calls.push(item);
        }
      }
    } catch {}
  }
  return calls;
}

// ── Main agent loop ─────────────────────────────────────────────────────────
/**
 * Run the full agent loop for a user message.
 * @param {string} userId - User ID
 * @param {string} message - User message
 * @param {Array} history - Previous messages [{role, content}]
 * @returns {Promise<{response: string, toolCalls: Array}>}
 */
async function runAgent(userId, message, history = []) {
  const toolCalls = [];

  // Build messages
  const systemMsg = {
    role: "system",
    content: AGENT_SYSTEM_PROMPT + `\n\nUSER_ID: ${userId}\nSelalu gunakan userId ini untuk tool calls yang membutuhkan.`
  };

  // Add memory context first
  let memoryContext = "";
  try {
    const memories = await vectorSearch(userId, message, 3);
    if (memories.length > 0) {
      memoryContext = "\n\nMEMORI TENTANG PENGGUNA:\n" + memories.map(m =>
        `• ${m.content} (confidence: ${(m.confidence * 100).toFixed(0)}%)`
      ).join("\n");
    }
  } catch {}

  const contextMsg = memoryContext ? {
    role: "system",
    content: memoryContext,
  } : null;

  const messages = [
    systemMsg,
    ...(contextMsg ? [contextMsg] : []),
    ...history.slice(-MAX_HISTORY),
    { role: "user", content: message },
  ];

  // Main loop: LLM → tool calls → execute → repeat
  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const response = await groqChat(messages);

    const content = response.choices?.[0]?.message?.content || "";
    if (!content.trim()) {
      messages.push({ role: "assistant", content: "" });
      break;
    }

    messages.push({ role: "assistant", content });

    const calls = parseToolCalls(content);
    if (calls.length === 0) {
      // No tool call detected — assume this is the final response
      // Check if there's a natural done intent
      if (content.toLowerCase().includes("__done__")) {
        return { response: content.replace(/__done__/gi, "").trim(), toolCalls };
      }
      // Treat as final response
      return { response: content.trim(), toolCalls };
    }

    for (const call of calls) {
      toolCalls.push(call);
      const result = await executeTool(call.tool, call.args);

      // Check if done
      if (call.tool === "done") {
        return { response: result.replace(/^__DONE__/, "").trim(), toolCalls };
      }

      // Append result to messages for next iteration
      messages.push({
        role: "system",
        content: `[TOOL RESULT: ${call.tool}]\n${result}\n\nLanjutkan atau selesaikan dengan tool "done".`,
      });
    }
  }

  // Max iterations reached
  return {
    response: "Maaf, saya butuh waktu lebih lama dari biasanya. Bisa coba pertanyaan yang lebih spesifik?",
    toolCalls,
  };
}

// ── Streaming agent (for voice) ─────────────────────────────────────────────
/**
 * Streaming version — yields words as they come.
 * Note: For voice, we typically want the full response before TTS.
 * Use runAgent() and stream the result to TTS.
 */
async function* runAgentStream(userId, message, history = []) {
  const { response } = await runAgent(userId, message, history);
  // For streaming, yield word by word
  const words = response.split(" ");
  for (const word of words) {
    yield word + " ";
  }
}

module.exports = {
  runAgent,
  runAgentStream,
  executeTool,
  TOOLS,
};
