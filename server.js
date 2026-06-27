/**
 * Voice AI Companion Server — Rina v2
 *
 * Voice-first interface to OpenClaw + Groq.
 * Rina handles the conversational layer; OpenClaw handles agentic tasks.
 *
 * Stack:
 * - STT: Groq Whisper (fast, accurate)
 * - LLM: OpenClaw (agentic tasks) OR Groq Llama (casual chat)
 * - TTS: Edge TTS (Microsoft Neural, Indonesian)
 * - Memory: TiDB (FULLTEXT, persistent across sessions)
 * - Real-time: WebSocket
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
const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL || "http://localhost:8080";
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || "";
const MAX_SESSION_TURNS = 20; // cap session history to prevent memory bloat

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ── Memory layer (CommonJS) ─────────────────────────────────────────────────
const memory = require("./lib/memory.cjs");

// ── Session store (in-memory, reset on server restart) ──────────────────────
// In production: replace with Redis
const sessions = new Map(); // userId → { messages: [], lastActive, turnCount }

// ── Rina Persona ─────────────────────────────────────────────────────────────
// This is the conversational layer — warm, Indonesian, memory-aware.
const RINA_PROMPT = `Kamu "Rina" — asisten suara yang hangat dan teman bicara.
- Perempuan Indonesia, usia 25-30 tahun
- Bicara santai tapi nggak berlebihan
- Jawab 1-3 kalimat, jangan panjang-panjang
- Tunjukkan bahwa kamu ingat konteks dari percakapan sebelumnya
- Kalau pengguna terlihat frustrasi, tenangkan dan bantu dengan baik
- Jangan pernah bilang kamu AI atau robot
- Pakai bahasa yang natural, seolah-olah ngobrol sama teman
- Emoji boleh dipakai tapi wajar-wajar saja, nggak berlebihan`;

function systemPrompt(context = "") {
  return context
    ? `${RINA_PROMPT}\n\nYang kamu tahu tentang pengguna ini:\n${context}\n\nSelalu gunakan konteks di atas.`
    : RINA_PROMPT;
}

// ── OpenClaw Integration ────────────────────────────────────────────────────
/**
 * Route to OpenClaw if the message needs agentic action.
 * Falls back to Groq for casual chat.
 *
 * Returns { agentic: boolean, messages: [] }
 */
async function buildMessagesWithOpenClaw(userId, transcript, sessionMessages) {
  // Detect if this looks like a task/request (not small talk)
  const taskKeywords = [
    "buatkan", "tolong", "bisa nggak", "coba", "jelaskan", "hitung",
    "tulis", "kerjakan", "selesaikan", "analisa", "bantu", "apa itu",
    "how to", "build", "write", "make", "create", "help", "can you",
    "code", "script", "program", "app", "website"
  ];

  const isTaskIntent = taskKeywords.some(kw =>
    transcript.toLowerCase().includes(kw)
  );

  const memories = await memory.searchMemoryFulltext(userId, transcript, 3);
  const context = memories.length > 0
    ? memories.map(m => `• ${m.content}`).join("\n")
    : "";

  const systemMsg = {
    role: "system",
    content: context
      ? `${RINA_PROMPT}\n\nYang kamu tahu tentang pengguna ini:\n${context}`
      : RINA_PROMPT,
  };

  const recentHistory = sessionMessages.slice(-MAX_SESSION_TURNS);

  if (isTaskIntent && OPENCLAW_API_KEY) {
    // Forward to OpenClaw for agentic tasks
    try {
      const res = await fetch(`${OPENCLAW_API_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENCLAW_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [systemMsg, ...recentHistory, { role: "user", content: transcript }],
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (res.ok) {
        const data = await res.json();
        return { agentic: true, messages: data.messages || [], raw: data };
      }
    } catch (err) {
      console.warn("[OpenClaw] Failed, falling back to Groq:", err.message);
    }
  }

  // Fall back to Groq for casual chat or if OpenClaw unavailable
  return {
    agentic: false,
    messages: [systemMsg, ...recentHistory, { role: "user", content: transcript }],
  };
}

// ── Groq LLM (streaming) ───────────────────────────────────────────────────
async function* groqStream(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      stream: true,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq error ${res.status}: ${err}`);
  }

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
        const content = JSON.parse(data).choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {}
    }
  }
}

// ── Groq LLM (non-streaming) ────────────────────────────────────────────────
async function groqChat(messages, model = GROQ_MODEL) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, stream: false, temperature: 0.7 }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Edge TTS ────────────────────────────────────────────────────────────────
function edgeTTS(text, voice = "id-ID-ArdiNeural") {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const tmpMp3 = `/tmp/tts_${randomUUID()}.mp3`;
    const edge = spawn("edge-tts", [
      "--text", text,
      "--voice", voice,
      "--write-media", tmpMp3,
    ]);
    edge.on("close", (code) => {
      if (code !== 0) { reject(new Error(`edge-tts exited ${code}`)); return; }
      try {
        const { readFileSync, unlinkSync } = require("fs");
        const mp3Data = readFileSync(tmpMp3);
        unlinkSync(tmpMp3);
        resolve(mp3Data);
      } catch (e) { reject(e); }
    });
    edge.on("error", reject);
  });
}

// ── Groq Whisper STT ────────────────────────────────────────────────────────
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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`STT error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return { text: data.text || "", segments: data.segments || [] };
}

// ── Memory helpers ──────────────────────────────────────────────────────────
async function extractMemories(userId, userMsg, assistantMsg) {
  const messages = [
    {
      role: "system",
      content: `Ekstrak 0-2 fakta penting dari percakapan ini untuk diingat.
Wajib RETURN ONLY JSON array: [{"key": "...", "fact": "...", "confidence": 0.0-1.0}]
Kalau tidak ada fakta baru yang perlu diingat, return [].
Contoh: [{"key": "nama", "fact": "Nama pengguna adalah Budi", "confidence": 0.9}]`,
    },
    { role: "user", content: `Pengguna: ${userMsg}\nRina: ${assistantMsg}` },
  ];

  try {
    const res = await groqChat(messages);
    const text = (res.choices?.[0]?.message?.content || "[]")
      .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const facts = JSON.parse(text);
    let saved = 0;
    for (const f of facts) {
      await memory.upsertMemory(userId, f.fact, f.key, "both", f.confidence || 0.8);
      saved++;
    }
    return saved;
  } catch (err) {
    console.warn("[Memory] extractMemories failed:", err.message);
    return 0;
  }
}

// ── Voice Session Handler ───────────────────────────────────────────────────
async function handleVoiceSession(ws, audioBuffer, userId) {
  let session = sessions.get(userId);
  if (!session) {
    session = { messages: [], lastActive: new Date(), turnCount: 0 };
    sessions.set(userId, session);
  }
  session.lastActive = new Date();

  try {
    // 1. STT
    const { text: transcript } = await groqSTT(audioBuffer);
    console.log(`[${userId}] STT: "${transcript || "(empty)"}"`);

    if (!transcript || transcript.trim().length < 2) {
      ws.send(JSON.stringify({ type: "transcript", text: "" }));
      const fallback = "Hmm, coba lagi ngomong ya?";
      ws.send(JSON.stringify({ type: "llm_word", text: fallback }));
      ws.send(JSON.stringify({ type: "llm_done", text: fallback }));
      const tts = await edgeTTS(fallback);
      ws.send(JSON.stringify({ type: "tts_audio", data: tts.toString("base64"), mimeType: "audio/mpeg" }));
      return;
    }

    ws.send(JSON.stringify({ type: "transcript", text: transcript }));

    // 2. Build messages (OpenClaw or Groq)
    const { agentic, messages: llmMessages } = await buildMessagesWithOpenClaw(
      userId, transcript, session.messages
    );

    if (agentic) {
      console.log(`[${userId}] Routed to OpenClaw`);
      ws.send(JSON.stringify({ type: "agent_status", text: "Menghubungi OpenClaw..." }));
    }

    // 3. Memory: check for relevant context
    let memoryContext = "";
    try {
      const memories = await memory.searchMemoryFulltext(userId, transcript, 4);
      if (memories.length > 0) {
        memoryContext = memories.map(m => `• ${m.content}`).join("\n");
        ws.send(JSON.stringify({
          type: "memory_recall",
          count: memories.length,
          preview: memories.slice(0, 2).map(m => m.content.substring(0, 60)),
        }));
        console.log(`[${userId}] Memory recall: ${memories.length} facts`);
      }
    } catch (err) {
      console.warn(`[${userId}] Memory search failed:`, err.message);
    }

    // Inject memory context if not already handled by buildMessagesWithOpenClaw
    if (memoryContext && !agentic) {
      const systemMsg = {
        role: "system",
        content: `${RINA_PROMPT}\n\nYang kamu tahu tentang pengguna ini:\n${memoryContext}\n\nSelalu gunakan konteks di atas.`,
      };
      // Replace system message
      llmMessages[0] = systemMsg;
    }

    // 4. Stream LLM + TTS in parallel
    const ttsQueue = [];
    let ttsBusy = false;

    const processTTSQueue = async () => {
      if (ttsBusy || ttsQueue.length === 0) return;
      ttsBusy = true;
      const text = ttsQueue.shift();
      try {
        const mp3Data = await edgeTTS(text);
        ws.send(JSON.stringify({ type: "tts_audio", data: mp3Data.toString("base64"), mimeType: "audio/mpeg" }));
      } catch (e) {
        console.error("[TTS] chunk error:", e.message);
      }
      ttsBusy = false;
      if (ttsQueue.length > 0) processTTSQueue();
    };

    // 5. Stream response
    let fullResponse = "";
    let pendingWord = "";
    let ttsBuffer = "";

    for await (const chunk of groqStream(llmMessages)) {
      fullResponse += chunk;
      pendingWord += chunk;
      ttsBuffer += chunk;

      // Send word to UI
      if (chunk.match(/[\s.,!?\n]/)) {
        ws.send(JSON.stringify({ type: "llm_word", text: pendingWord.trim() }));
        pendingWord = "";
      }

      // TTS every ~30 accumulated chars
      while (ttsBuffer.length >= 30) {
        const cut = ttsBuffer.lastIndexOf(" ");
        if (cut <= 0) break;
        const toTTS = ttsBuffer.slice(0, cut);
        ttsBuffer = ttsBuffer.slice(cut + 1);
        if (toTTS.trim()) ttsQueue.push(toTTS.trim());
      }
      processTTSQueue();
    }

    if (pendingWord) {
      ws.send(JSON.stringify({ type: "llm_word", text: pendingWord.trim() }));
      ttsBuffer += pendingWord;
    }
    if (ttsBuffer.trim()) ttsQueue.push(ttsBuffer.trim());

    // Drain remaining TTS
    while (ttsQueue.length > 0) {
      await new Promise((r) => setTimeout(r, 100));
      await processTTSQueue();
    }

    const response = fullResponse.trim() || "Maaf, saya kurang menangkap itu.";
    ws.send(JSON.stringify({ type: "llm_done", text: response }));

    // 6. Update session
    session.messages.push({ role: "user", content: transcript });
    session.messages.push({ role: "assistant", content: response });
    session.turnCount++;

    // Cap session history
    if (session.messages.length > MAX_SESSION_TURNS * 2) {
      session.messages = session.messages.slice(-MAX_SESSION_TURNS * 2);
    }

    // 7. Log to TiDB
    await memory.logConversation(userId, "voice", "user", transcript);
    await memory.logConversation(userId, "voice", "assistant", response);

    // 8. Extract + save memories
    const savedCount = await extractMemories(userId, transcript, response);
    if (savedCount > 0) {
      ws.send(JSON.stringify({ type: "memory_saved", count: savedCount }));
    }

    // 9. Periodic summary every 15 turns
    if (session.turnCount > 0 && session.turnCount % 15 === 0) {
      summarizeSession(userId, session).catch(console.error);
    }

    console.log(`[${userId}] Turn ${session.turnCount} done. Memory saved: ${savedCount}`);

  } catch (err) {
    console.error(`[${userId}] Session error:`, err);
    const errorMsg = "Maaf, terjadi kesalahan. Coba lagi ya.";
    ws.send(JSON.stringify({ type: "error", message: err.message }));
    ws.send(JSON.stringify({ type: "llm_word", text: errorMsg }));
    ws.send(JSON.stringify({ type: "llm_done", text: errorMsg }));
    try {
      const tts = await edgeTTS(errorMsg);
      ws.send(JSON.stringify({ type: "tts_audio", data: tts.toString("base64"), mimeType: "audio/mpeg" }));
    } catch {}
  }
}

async function summarizeSession(userId, session) {
  try {
    const history = await memory.getConversationHistory(userId, "voice", 30);
    if (history.length < 4) return;

    const messages = [
      {
        role: "system",
        content: `Ringkas percakapan berikut menjadi 2-3 fakta penting tentang preferensi atau konteks pengguna.
Return ONLY JSON: [{"key": "...", "fact": "...", "confidence": 0.7}]
Contoh: [{"key": "tema_minat", "fact": "Pengguna tertarik dengan teknologi AI", "confidence": 0.8}]`,
      },
      { role: "user", content: JSON.stringify(history) },
    ];

    const res = await groqChat(messages);
    const text = (res.choices?.[0]?.message?.content || "[]")
      .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const facts = JSON.parse(text);
    for (const f of facts) {
      await memory.upsertMemory(userId, f.fact, f.key, "both", f.confidence || 0.7);
    }
    console.log(`[${userId}] Session summary: saved ${facts.length} facts`);
  } catch (err) {
    console.warn(`[${userId}] summarizeSession failed:`, err.message);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
app.prepare().then(async () => {
  // Test memory connection on startup
  const memPing = await memory.ping();
  if (memPing.ok) {
    console.log("> TiDB: connected");
  } else {
    console.warn("> TiDB: not connected —", memPing.error);
    console.warn("> Memory features will be disabled until TiDB is configured.");
  }

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);

      // GET /test_audio — test TTS
      if (parsedUrl.pathname === "/test_audio") {
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Access-Control-Allow-Origin": "*",
        });
        try {
          const mp3 = await edgeTTS("Halo! Aku Rina. Dengan siapa ya?", "id-ID-ArdiNeural");
          res.end(mp3);
        } catch (e) {
          res.writeHead(500);
          res.end("TTS error: " + e.message);
        }
        return;
      }

      // GET /health — health check
      if (parsedUrl.pathname === "/health") {
        const memPing = await memory.ping();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          memory: memPing,
          uptime: process.uptime(),
        }));
        return;
      }

      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("HTTP error:", err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const parsedUrl = parse(req.url, true);
    const userId = parsedUrl.query.userId || `guest_${randomUUID().slice(0, 8)}`;
    console.log(`[WS] + ${userId}`);

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio_chunk") {
          const audioBuffer = Buffer.from(msg.data, "base64");
          await handleVoiceSession(ws, audioBuffer, userId);
        }
      } catch (err) {
        console.error("[WS] message error:", err);
        ws.send(JSON.stringify({ type: "error", message: "Processing error" }));
      }
    });

    ws.on("close", () => console.log(`[WS] - ${userId}`));
    ws.on("error", (err) => console.error(`[WS] ${userId} error:`, err.message));
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
    console.log(`\n> Rina v2 ready on http://${hostname}:${port}/voice`);
    console.log(`> WebSocket: ws://${hostname}:${port}/ws`);
    console.log(`> Health: http://${hostname}:${port}/health`);
    console.log(`> TTS: Edge id-ID-ArdiNeural`);
    console.log(`> LLM: ${GROQ_MODEL} (Groq)`);
    console.log(`> OpenClaw: ${OPENCLAW_API_URL}${OPENCLAW_API_KEY ? " [connected]" : " [not configured]"}\n`);
  });
});
