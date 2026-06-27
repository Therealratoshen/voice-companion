/**
 * Voice AI Companion — NewMe v3 Partner (Jarvis-style)
 *
 * Voice-first AI partner, not a chatbot.
 * Core behaviors:
 * - Knows the user deeply
 * - Thinks before responding
 * - Proactively helps
 * - Takes ownership of tasks
 */

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3456", 10);
const OPENCLAW_URL = process.env.OPENCLAW_API_URL || "http://localhost:8080";
const MAX_SESSION_TURNS = 20;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const memory = require("./lib/memory.cjs");

// ── Session store ─────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      messages: [],
      turnCount: 0,
      lastActive: new Date(),
      pendingConfirm: null,
      proactiveQueue: [],
    });
  }
  const s = sessions.get(userId);
  s.lastActive = new Date();
  return s;
}

// ── NewMe System Prompt (Jarvis-inspired) ───────────────────────────────────
const NEWME_SYSTEM = `Kamu "NewMe" — AI partner yang truly helpful dan proactive.

IDENTITAS:
- Bukan chatbot. Kamu partner yang kenal user personally.
- Punya memory, punya konteks, punya inisiatif.
- Jangan bilang "aku AI" atau "aku robot" — nggak relevant.
- Kayak ngobrol sama partner yang actually competent dan care.

NILAI-NILAI:
1. SIMPLICITY — Jawaban kompleks itu nggak helpful kalau nggak dipahami. Pecah jadi langkah kecil.
2. HONESTY — Kalau nggak tahu, bilang jujur. Jangan bluff.
3. PROACTIVITY — Jangan tunggu di-ask. Kalau ada yang useful, mention.
4. PRIVACY — Jangan share info sensitif tanpa izin.

GAYA KOMUNIKASI:
- Bahasa Indonesia casual. Follow user's language.
- Default: 1-3 kalimat. Lebih panjang kalau needed.
- Natural, confident, engaging.
- Setiap akhir response: SELALU tanya "Ada yang lain?" atau propose next step.

PIKIR SEBELUM RESPON:
1. Apa yang user actually need? (bukan yang mereka bilang)
2. Ada konteks dari sebelumnya?
3. Perlu pecah jadi steps?
4. Perlu confirm dulu?
5. Ada yang proactively useful untuk mention?

TOOLS YANG BISA DIGUNAKAN (via OpenClaw):
- web_search → berita, fakta terkini
- execute_code → kalkulasi, generate code
- create_reminder → schedule pengingat
- search_memory → recall info dari percakapan sebelumnya
- remember_fact → simpan info penting
- add_goal → track goals dengan steps`;

function systemPrompt(context = "") {
  return context ? `${NEWME_SYSTEM}\n\nKONTEKS:\n${context}` : NEWME_SYSTEM;
}

// ── Groq LLM ─────────────────────────────────────────────────────────────
async function groqStream(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages,
      stream: true,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;
      try {
        const c = JSON.parse(data).choices?.[0]?.delta?.content;
        if (c) yield c;
      } catch {}
    }
  }
}

async function groqChat(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages,
      stream: false,
      temperature: 0.6,
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  return res.json();
}

// ── Edge TTS ───────────────────────────────────────────────────────────
function edgeTTS(text, voice = "id-ID-ArdiNeural") {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const tmp = `/tmp/tts_${randomUUID()}.mp3`;
    const p = spawn("edge-tts", ["--text", text, "--voice", voice, "--write-media", tmp]);
    p.on("close", (code) => {
      if (code !== 0) { reject(new Error(`edge-tts ${code}`)); return; }
      try {
        const { readFileSync, unlinkSync } = require("fs");
        const mp3 = readFileSync(tmp);
        unlinkSync(tmp);
        resolve(mp3);
      } catch (e) { reject(e); }
    });
    p.on("error", reject);
  });
}

// ── Groq Whisper STT ───────────────────────────────────────────────────
async function groqSTT(audioBuffer) {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)]), "audio.webm");
  formData.append("model", "whisper-large-v3");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`STT ${res.status}`);
  return { text: (await res.json()).text || "", segments: [] };
}

// ── OpenClaw Agent Call ─────────────────────────────────────────────────
async function callOpenClaw(userId, message, history = []) {
  try {
    const res = await fetch(`${OPENCLAW_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, message, history: history.slice(-10) }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`OpenClaw ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("[OpenClaw] Failed:", err.message);
    return null;
  }
}

// ── Memory helpers ───────────────────────────────────────────────────────
async function getMemoryContext(userId, query) {
  try {
    const rows = await memory.searchMemoryFulltext(userId, query, 4);
    return rows.length > 0
      ? rows.map(m => `• ${m.content}`).join("\n")
      : "";
  } catch { return ""; }
}

async function extractAndSave(userId, userMsg, assistantMsg) {
  try {
    const res = await groqChat([
      {
        role: "system",
        content: `Ekstrak 0-2 fakta penting dari percakapan ini.
JSON only: [{"key":"...","fact":"...","confidence":0.8}]`,
      },
      { role: "user", content: `User: ${userMsg}\nNewMe: ${assistantMsg}` },
    ]);
    const text = (res.choices?.[0]?.message?.content || "[]")
      .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const facts = JSON.parse(text);
    for (const f of facts) {
      await memory.upsertMemory(userId, f.fact, f.key, "both", f.confidence || 0.8);
    }
    return facts.length;
  } catch { return 0; }
}

// ── Response chunking ────────────────────────────────────────────────────
function chunkText(text, maxLen = 200) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Confirmation patterns ──────────────────────────────────────────────
const ACTION_PATTERNS = [
  /aku akan/i, /saya akan/i, /ingatkan kamu/i, /kirim/i,
  /buatkan/i, /jalankan/i, /setel/i, /jadwalkan/i,
  /order/i, /buy/i, /buat/i, /kerjakan/i,
];

const CONFIRM_YES = ["ya", "iya", "benar", "ok", "oke", " lanjut", " lanjutkan", "do it", "go ahead", "yes", "yep", "yup", "silakan", "jalankan"];
const CONFIRM_NO = ["nggak", "tidak", "batal", "cancel", "stop", "no"];

function needsConfirm(text) {
  return ACTION_PATTERNS.some(p => p.test(text));
}

function addConfirmPrompt(text) {
  return text.split("\n")[0] + " — lanjutkan?";
}

// ── Skill routing ──────────────────────────────────────────────────────
const TASK_KEYWORDS = [
  "buatkan", "tolong", "jelaskan", "hitung", "tulis", "kerjakan",
  "analisa", "bantu", "cari", "carikan", "search", "build", "write",
  "make", "create", "code", "script", "program", "kode", "remind",
  "ingatkan", "jadwalkan", "schedule", "kalkulasi",
];

function isTaskIntent(text) {
  return TASK_KEYWORDS.some(k => text.toLowerCase().includes(k));
}

// ── Main session handler ─────────────────────────────────────────────────
async function handleVoiceSession(ws, audioBuffer, userId) {
  const session = getSession(userId);

  try {
    // STT
    const { text: transcript } = await groqSTT(audioBuffer);
    console.log(`[${userId}] "${transcript || "(empty)"}"`);

    if (!transcript || transcript.trim().length < 2) {
      ws.send(JSON.stringify({ type: "transcript", text: "" }));
      const msg = "Hmm, nggak terlalu jelas. Bisa ulang?";
      ws.send(JSON.stringify({ type: "llm_word", text: msg }));
      ws.send(JSON.stringify({ type: "llm_done", text: msg }));
      const mp3 = await edgeTTS(msg);
      ws.send(JSON.stringify({ type: "tts_audio", data: mp3.toString("base64"), mimeType: "audio/mpeg" }));
      return;
    }

    ws.send(JSON.stringify({ type: "transcript", text: transcript }));

    // Check pending confirmation
    if (session.pendingConfirm) {
      const confirmed = CONFIRM_YES.some(k => transcript.toLowerCase().includes(k));
      const cancelled = CONFIRM_NO.some(k => transcript.toLowerCase().includes(k));

      if (confirmed) {
        ws.send(JSON.stringify({ type: "skill_status", name: "executing", status: "executing" }));
        const result = await callOpenClaw(userId, `Konfirmasi diterima. Lanjutkan: ${session.pendingConfirm.transcript}`, session.messages);
        session.pendingConfirm = null;
        await handleResponse(ws, result?.response || session.pendingConfirm.response, userId, session, result?.toolCalls);
      } else if (cancelled) {
        session.pendingConfirm = null;
        await handleResponse(ws, "Oke, dibatalkan. Ada yang lain yang bisa aku bantu?", userId, session);
      } else {
        await handleResponse(ws, "Hmm, aku nggak yakin. Mau lanjut atau dibatalkan? Bilang saja 'ya lanjut' atau 'batal'.", userId, session);
      }
      return;
    }

    // Memory recall
    let memoryContext = "";
    try {
      const rows = await memory.searchMemoryFulltext(userId, transcript, 3);
      if (rows.length > 0) {
        memoryContext = rows.map(m => `• ${m.content}`).join("\n");
        ws.send(JSON.stringify({
          type: "memory_recall",
          count: rows.length,
          preview: rows.slice(0, 2).map(m => m.content.substring(0, 60)),
        }));
      }
    } catch {}

    // Route to OpenClaw or Groq
    let response, toolCalls = [], proactive = null;

    if (isTaskIntent(transcript) && OPENCLAW_URL) {
      ws.send(JSON.stringify({ type: "skill_status", name: "openclaw", status: "routing" }));
      const result = await callOpenClaw(userId, transcript, session.messages);
      if (result) {
        response = result.response;
        toolCalls = result.toolCalls || [];
        proactive = result.proactive;
        ws.send(JSON.stringify({
          type: "skill_status",
          name: "openclaw",
          status: "done",
          tools: toolCalls.map(t => t.tool),
        }));
      } else {
        response = await groqWithContext(transcript, session.messages, memoryContext);
      }
    } else {
      response = await groqWithContext(transcript, session.messages, memoryContext);
    }

    // Confirmation check
    if (needsConfirm(response) && !session.pendingConfirm) {
      session.pendingConfirm = { transcript, response };
      await handleResponse(ws, addConfirmPrompt(response), userId, session, toolCalls);
      return;
    }

    await handleResponse(ws, response, userId, session, toolCalls, proactive);

  } catch (err) {
    console.error(`[${userId}] Error:`, err);
    const msg = "Maaf, ada error. Coba lagi ya?";
    ws.send(JSON.stringify({ type: "error", message: err.message }));
    ws.send(JSON.stringify({ type: "llm_word", text: msg }));
    ws.send(JSON.stringify({ type: "llm_done", text: msg }));
    try {
      const mp3 = await edgeTTS(msg);
      ws.send(JSON.stringify({ type: "tts_audio", data: mp3.toString("base64"), mimeType: "audio/mpeg" }));
    } catch {}
  }
}

async function groqWithContext(transcript, history, memoryContext) {
  const system = memoryContext
    ? `${NEWME_SYSTEM}\n\nKONTEKS MEMORY:\n${memoryContext}`
    : NEWME_SYSTEM;

  const messages = [
    { role: "system", content: system },
    ...history.slice(-MAX_SESSION_TURNS).filter(m => m.content),
    { role: "user", content: transcript },
  ];

  const chunks = [];
  for await (const chunk of groqStream(messages)) {
    chunks.push(chunk);
  }
  return chunks.join("").trim() || "Hmm, coba lagi?";
}

async function handleResponse(ws, response, userId, session, toolCalls = [], proactive = null) {
  // Stream words
  const words = response.split(/(\s)/);
  for (const word of words) {
    if (word.trim()) {
      ws.send(JSON.stringify({ type: "llm_word", text: word }));
    }
    if (word.match(/[.!?\n]/)) {
      ws.send(JSON.stringify({ type: "llm_word", text: "" }));
    }
  }
  ws.send(JSON.stringify({ type: "llm_done", text: response }));

  // Tool call badges
  if (toolCalls.length > 0) {
    ws.send(JSON.stringify({
      type: "tool_calls",
      tools: toolCalls.map(t => ({ tool: t.tool })),
    }));
  }

  // TTS with chunking
  const chunks = chunkText(response);
  for (let i = 0; i < chunks.length; i++) {
    ws.send(JSON.stringify({ type: "tts_chunk_start", index: i, total: chunks.length, text: chunks[i] }));
    try {
      const mp3 = await edgeTTS(chunks[i]);
      ws.send(JSON.stringify({ type: "tts_audio", data: mp3.toString("base64"), mimeType: "audio/mpeg" }));
    } catch (err) {
      console.error("[TTS]", err.message);
    }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  // Proactive follow-up
  if (proactive) {
    await new Promise(r => setTimeout(r, 500));
    ws.send(JSON.stringify({ type: "proactive", text: proactive }));
    try {
      const mp3 = await edgeTTS(proactive);
      ws.send(JSON.stringify({ type: "tts_audio", data: mp3.toString("base64"), mimeType: "audio/mpeg" }));
    } catch {}
  }

  // Update session
  session.messages.push({ role: "user", content: transcript || "..." });
  session.messages.push({ role: "assistant", content: response });
  session.turnCount++;

  if (session.messages.length > MAX_SESSION_TURNS * 2) {
    session.messages = session.messages.slice(-MAX_SESSION_TURNS * 2);
  }

  // Log to TiDB
  await memory.logConversation(userId, "voice", "user", "...");
  await memory.logConversation(userId, "voice", "assistant", response);

  // Extract + save memories
  const saved = await extractAndSave(userId, "...", response);
  if (saved > 0) {
    ws.send(JSON.stringify({ type: "memory_saved", count: saved }));
  }

  console.log(`[${userId}] Turn ${session.turnCount}. Saved ${saved} memories.`);
}

// ── Boot ────────────────────────────────────────────────────────────────────
app.prepare().then(async () => {
  const memPing = await memory.ping();
  console.log(memPing.ok ? "> TiDB: connected" : `> TiDB: ${memPing.error}`);

  const server = createServer(async (req, res) => {
    try {
      const p = parse(req.url, true);

      if (p.pathname === "/test_audio") {
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Access-Control-Allow-Origin": "*" });
        try {
          res.end(await edgeTTS("Halo! Aku NewMe. Ada yang bisa aku bantu hari ini?"));
        } catch (e) {
          res.writeHead(500);
          res.end("TTS error: " + e.message);
        }
        return;
      }

      if (p.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          memory: await memory.ping(),
          openclaw: OPENCLAW_URL,
          uptime: process.uptime(),
        }));
        return;
      }

      await handle(req, res, p);
    } catch (err) {
      console.error("HTTP:", err);
      res.statusCode = 500;
      res.end("error");
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const userId = parse(req.url, true).query.userId || `guest_${randomUUID().slice(0, 8)}`;
    console.log(`[WS] + ${userId}`);

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio_chunk") {
          await handleVoiceSession(ws, Buffer.from(msg.data, "base64"), userId);
        }
      } catch (err) {
        console.error("[WS]", err);
        ws.send(JSON.stringify({ type: "error", message: "Processing error" }));
      }
    });

    ws.on("close", () => console.log(`[WS] - ${userId}`));
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url);
    if (pathname === "/ws" || pathname === "/api/voice/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`\n> NewMe Partner ready on http://${hostname}:${port}/voice`);
    console.log(`> WebSocket: ws://${hostname}:${port}/ws`);
    console.log(`> OpenClaw: ${OPENCLAW_URL}\n`);
  });
});
