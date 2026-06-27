/**
 * Voice AI Companion Server — NewMe v3 (Agentic)
 *
 * Voice-first AI companion with:
 * - OpenClaw agent (function calling: search, code, reminders)
 * - TiDB Mem9 (deep semantic memory)
 * - Edge TTS (Microsoft Neural, Indonesian)
 * - Voice UX (confirmation, chunking, repair patterns)
 */

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

// ── Config ─────────────────────────────────────────────────────────────────
const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3456", 10);
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const OPENCLAW_URL = process.env.OPENCLAW_API_URL || "http://localhost:8080";
const MAX_SESSION_TURNS = 20;
const LONG_RESPONSE_THRESHOLD = 300; // chars before we start chunking

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ── Memory layer ──────────────────────────────────────────────────────────
const memory = require("./lib/memory.cjs");

// ── Session store ─────────────────────────────────────────────────────────
const sessions = new Map(); // userId → { messages, turnCount, lastActive, pendingConfirm }

const getSession = (userId) => {
  if (!sessions.has(userId)) {
    sessions.set(userId, { messages: [], turnCount: 0, lastActive: new Date(), pendingConfirm: null });
  }
  const s = sessions.get(userId);
  s.lastActive = new Date();
  return s;
};

// ── NewMe Persona ──────────────────────────────────────────────────────────
const NEWME_SYSTEM = `Kamu "NewMe" — asisten suara AI yang helpful dan natural.
- Bisa ngobrol dalam Bahasa Indonesia atau English, sesuai preferensi pengguna
- Jawab singkat dan tepat — 1-3 kalimat untuk hal sederhana, potong jawaban panjang jadi bagian kecil
- Tunjukkan kamu ingat konteks percakapan sebelumnya
- Kalau pengguna frustrasi, tenangkan dulu, baru bantu
- Jangan bilang kamu AI atau robot
- Bicara natural, nggak kaku, seolah ngobrol sama teman
- Kalau perlu ambil tindakan, konfirmasi dulu ("lanjutkan?")
- Tool yang kamu punya: cari di internet, jalanin kode, bikin pengingat, ingat fakta tentang pengguna
- Kalau hasil panjang (>3 kalimat), pecah jadi bagian-bagian kecil`;

// ── OpenClaw Agent (function calling) ─────────────────────────────────────
const AGENT_TOOLS = [
  "web_search", "execute_code", "create_reminder",
  "list_reminders", "cancel_reminder", "search_memory",
  "remember_fact", "done"
];

const TASK_KEYWORDS = [
  "buatkan", "tolong", "bisa nggak", "coba", "jelaskan", "hitung",
  "tulis", "kerjakan", "selesaikan", "analisa", "bantu", "apa itu",
  "carikan", "cari", "search", "build", "write", "make", "create",
  "help", "can you", "remind", "ingatkan", "jadwalkan", "kode", "code",
  "script", "program", "app", "website", "kalkulasi", "calculate"
];

const CONFIRM_KEYWORDS = ["ya", "iya", "benar", "同意", "ok", "oke", "good", " lanjut", " lanjutkan", "do it", "go ahead", "yes"];

// ── Groq LLM ─────────────────────────────────────────────────────────────
async function groqStream(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: GROQ_MODEL, messages, stream: true, temperature: 0.7 }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
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

async function groqChat(messages, temperature = 0.6) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: GROQ_MODEL, messages, stream: false, temperature }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Edge TTS ───────────────────────────────────────────────────────────────
function edgeTTS(text, voice = "id-ID-ArdiNeural") {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const tmpMp3 = `/tmp/tts_${randomUUID()}.mp3`;
    const edge = spawn("edge-tts", ["--text", text, "--voice", voice, "--write-media", tmpMp3]);
    edge.on("close", (code) => {
      if (code !== 0) { reject(new Error(`edge-tts ${code}`)); return; }
      try {
        const { readFileSync, unlinkSync } = require("fs");
        const mp3 = readFileSync(tmpMp3);
        unlinkSync(tmpMp3);
        resolve(mp3);
      } catch (e) { reject(e); }
    });
    edge.on("error", reject);
  });
}

// ── Groq Whisper STT ──────────────────────────────────────────────────────
async function groqSTT(audioBuffer) {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)]), "audio.webm");
  formData.append("model", "whisper-large-v3");
  formData.append("response_format", "verbose_json");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`STT ${res.status}`);
  const data = await res.json();
  return { text: data.text || "", segments: data.segments || [] };
}

// ── OpenClaw Agent Router ─────────────────────────────────────────────────
async function callOpenClaw(userId, message, history = []) {
  try {
    const res = await fetch(`${OPENCLAW_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        message,
        history: history.slice(-10),
        stream: false,
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) throw new Error(`OpenClaw ${res.status}`);
    const data = await res.json();
    return {
      response: data.response,
      toolCalls: data.toolCalls || [],
      routed: "openclaw",
    };
  } catch (err) {
    console.warn(`[OpenClaw] Failed: ${err.message} — falling back to Groq`);
    return null;
  }
}

// ── Memory helpers ────────────────────────────────────────────────────────
async function getMemoryContext(userId, query) {
  try {
    const memories = await memory.searchMemoryFulltext(userId, query, 4);
    if (memories.length === 0) return "";
    return memories.map(m => `• ${m.content}`).join("\n");
  } catch {
    return "";
  }
}

async function extractAndSave(userId, userMsg, assistantMsg) {
  const messages = [
    {
      role: "system",
      content: `Ekstrak 0-2 fakta penting. JSON only: [{"key":"...","fact":"...","confidence":0.8}]`,
    },
    { role: "user", content: `User: ${userMsg}\nNewMe: ${assistantMsg}` },
  ];
  try {
    const res = await groqChat(messages);
    const text = (res.choices?.[0]?.message?.content || "[]")
      .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const facts = JSON.parse(text);
    for (const f of facts) {
      await memory.upsertMemory(userId, f.fact, f.key, "both", f.confidence || 0.8);
    }
    return facts.length;
  } catch { return 0; }
}

async function summarizeSession(userId) {
  try {
    const history = await memory.getConversationHistory(userId, "voice", 30);
    if (history.length < 4) return;
    const res = await groqChat([
      {
        role: "system",
        content: `Ringkas jadi 2-3 fakta. JSON only: [{"key":"...","fact":"...","confidence":0.7}]`,
      },
      { role: "user", content: JSON.stringify(history) },
    ]);
    const text = (res.choices?.[0]?.message?.content || "[]")
      .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const facts = JSON.parse(text);
    for (const f of facts) {
      await memory.upsertMemory(userId, f.fact, f.key, "both", f.confidence || 0.7);
    }
  } catch {}
}

// ── Response chunking for voice ────────────────────────────────────────────
/**
 * Split long text into voice-friendly chunks (1-3 sentences each).
 */
function chunkText(text, maxChunk = 200) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let current = "";

  for (const s of sentences) {
    if ((current + s).length > maxChunk && current.length > 0) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Build response with confirmation pattern ──────────────────────────────
/**
 * Check if response needs confirmation before taking action.
 */
function needsConfirmation(text) {
  const confirmPatterns = [
    /aku akan/i, /saya akan/i, /aku buatkan/i, /saya cari/i,
    /ingatkan kamu/i, /kirim/i, /buat/i, /jalankan/i,
    /setel alarm/i, /schedule/i, /order/i, /buy/i, /purchase/i
  ];
  return confirmPatterns.some(p => p.test(text));
}

/**
 * Add confirmation prompt to action text.
 */
function addConfirmationPrompt(text) {
  return text + " — lanjutkan?";
}

// ── Send TTS with chunking ────────────────────────────────────────────────
async function sendTTSChunks(ws, text) {
  const chunks = chunkText(text);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Send word marker for each chunk
    ws.send(JSON.stringify({
      type: "tts_chunk_start",
      index: i,
      total: chunks.length,
      text: chunk,
    }));

    try {
      const mp3 = await edgeTTS(chunk);
      ws.send(JSON.stringify({
        type: "tts_audio",
        data: mp3.toString("base64"),
        mimeType: "audio/mpeg",
      }));
    } catch (err) {
      console.error("[TTS] chunk error:", err.message);
    }

    // Small pause between chunks (250ms)
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

// ── Voice Session Handler ───────────────────────────────────────────────────
async function handleVoiceSession(ws, audioBuffer, userId) {
  const session = getSession(userId);

  try {
    // 1. STT
    const { text: transcript } = await groqSTT(audioBuffer);
    console.log(`[${userId}] STT: "${transcript || "(empty)"}"`);

    if (!transcript || transcript.trim().length < 2) {
      ws.send(JSON.stringify({ type: "transcript", text: "" }));
      const msg = "Hmm, aku nggak dengar dengan jelas. Coba lagi ya?";
      ws.send(JSON.stringify({ type: "llm_word", text: msg }));
      ws.send(JSON.stringify({ type: "llm_done", text: msg }));
      const mp3 = await edgeTTS(msg);
      ws.send(JSON.stringify({ type: "tts_audio", data: mp3.toString("base64"), mimeType: "audio/mpeg" }));
      return;
    }

    ws.send(JSON.stringify({ type: "transcript", text: transcript }));

    // 2. Handle pending confirmation
    if (session.pendingConfirm) {
      const confirmed = CONFIRM_KEYWORDS.some(k => transcript.toLowerCase().includes(k));
      if (confirmed) {
        ws.send(JSON.stringify({ type: "skill_status", name: session.pendingConfirm.tool, status: "executing" }));
        const result = await executeConfirmedAction(session.pendingConfirm);
        session.pendingConfirm = null;
        await handleResponse(ws, result, userId, session);
      } else {
        const msg = "Oke, dibatalkan. Ada yang lain yang bisa aku bantu?";
        session.pendingConfirm = null;
        await handleResponse(ws, msg, userId, session);
      }
      return;
    }

    // 3. Memory: recall
    let memoryContext = "";
    try {
      const memories = await memory.searchMemoryFulltext(userId, transcript, 3);
      if (memories.length > 0) {
        memoryContext = memories.map(m => `• ${m.content}`).join("\n");
        ws.send(JSON.stringify({
          type: "memory_recall",
          count: memories.length,
          preview: memories.slice(0, 2).map(m => m.content.substring(0, 60)),
        }));
      }
    } catch {}

    // 4. Intent detection + routing
    const isTaskIntent = TASK_KEYWORDS.some(k =>
      transcript.toLowerCase().includes(k)
    );

    let response, toolCalls = [];

    if (isTaskIntent && process.env.OPENCLAW_API_URL) {
      // Try OpenClaw agent
      ws.send(JSON.stringify({ type: "skill_status", name: "openclaw", status: "routing" }));
      const agentResult = await callOpenClaw(userId, transcript, session.messages);
      if (agentResult) {
        response = agentResult.response;
        toolCalls = agentResult.toolCalls;
        ws.send(JSON.stringify({ type: "skill_status", name: "openclaw", status: "done", tools: toolCalls.map(t => t.tool) }));
      } else {
        // Fallback to Groq
        response = await groqWithContext(transcript, session.messages, memoryContext);
      }
    } else {
      // Casual chat on Groq
      response = await groqWithContext(transcript, session.messages, memoryContext);
    }

    // 5. Check if confirmation needed
    if (needsConfirmation(response)) {
      session.pendingConfirm = { response, toolCalls, transcript };
      const confirmMsg = addConfirmationPrompt(response.split("\n")[0]);
      await handleResponse(ws, confirmMsg, userId, session);
      return;
    }

    await handleResponse(ws, response, userId, session, toolCalls);

  } catch (err) {
    console.error(`[${userId}] Error:`, err);
    const msg = "Maaf, terjadi kesalahan. Coba lagi ya?";
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
  const systemContent = memoryContext
    ? `${NEWME_SYSTEM}\n\nYang kamu tahu:\n${memoryContext}`
    : NEWME_SYSTEM;

  const messages = [
    { role: "system", content: systemContent },
    ...history.slice(-MAX_SESSION_TURNS).filter(m => m.content),
    { role: "user", content: transcript },
  ];

  const chunks = [];
  for await (const chunk of groqStream(messages)) {
    chunks.push(chunk);
  }
  return chunks.join("").trim() || "Maaf, aku kurang menangkap itu.";
}

async function handleResponse(ws, response, userId, session, toolCalls = []) {
  // Stream words
  const words = response.split(/(\s)/);
  let liveText = "";
  for (const word of words) {
    if (word.trim()) {
      liveText += word;
      ws.send(JSON.stringify({ type: "llm_word", text: word }));
    }
    if (word.match(/[.!?\n]/)) {
      ws.send(JSON.stringify({ type: "llm_word", text: "" }));
      liveText = "";
    }
  }
  ws.send(JSON.stringify({ type: "llm_done", text: response }));

  // TTS with chunking
  await sendTTSChunks(ws, response);

  // Update session
  session.messages.push({ role: "user", content: "..." });
  session.messages.push({ role: "assistant", content: response });
  session.turnCount++;

  if (session.messages.length > MAX_SESSION_TURNS * 2) {
    session.messages = session.messages.slice(-MAX_SESSION_TURNS * 2);
  }

  // Log to TiDB
  await memory.logConversation(userId, "voice", "user", "...");
  await memory.logConversation(userId, "voice", "assistant", response);

  // Save memory
  const saved = await extractAndSave(userId, "...", response);
  if (saved > 0) {
    ws.send(JSON.stringify({ type: "memory_saved", count: saved }));
  }

  // Periodic summary
  if (session.turnCount % 15 === 0) {
    summarizeSession(userId).catch(console.error);
  }

  console.log(`[${userId}] Turn ${session.turnCount}. Saved ${saved} memories.`);
}

// ── Execute confirmed action ────────────────────────────────────────────────
async function executeConfirmedAction(pending) {
  if (!pending.toolCalls || pending.toolCalls.length === 0) {
    return pending.response;
  }
  // For now, just return the response (OpenClaw already executed the tool)
  return pending.response + " Selesai!";
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
          const mp3 = await edgeTTS("Halo! Aku NewMe. Ada yang bisa aku bantu?");
          res.end(mp3);
        } catch (e) {
          res.writeHead(500);
          res.end("TTS error: " + e.message);
        }
        return;
      }

      if (p.pathname === "/health") {
        const memPing = await memory.ping();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          memory: memPing,
          openclaw: OPENCLAW_URL,
          uptime: process.uptime(),
        }));
        return;
      }

      await handle(req, res, p);
    } catch (err) {
      console.error("HTTP error:", err);
      res.statusCode = 500;
      res.end("internal server error");
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
          const buf = Buffer.from(msg.data, "base64");
          await handleVoiceSession(ws, buf, userId);
        }
      } catch (err) {
        console.error("[WS] Error:", err);
        ws.send(JSON.stringify({ type: "error", message: "Processing error" }));
      }
    });

    ws.on("close", () => console.log(`[WS] - ${userId}`));
    ws.on("error", (err) => console.error(`[WS] ${userId}:`, err.message));
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
    console.log(`\n> NewMe v3 (Agentic) ready on http://${hostname}:${port}/voice`);
    console.log(`> WebSocket: ws://${hostname}:${port}/ws`);
    console.log(`> OpenClaw: ${OPENCLAW_URL}${process.env.OPENCLAW_API_KEY ? " [connected]" : " [not configured]"}\n`);
  });
});
