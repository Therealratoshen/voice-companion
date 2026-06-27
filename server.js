/**
 * Custom Next.js server + WebSocket
 * - STT: Groq Whisper
 * - LLM: Groq Llama (streaming)
 * - TTS: Edge TTS (Microsoft neural, Indonesian voice)
 * - Memory: TiDB with FULLTEXT search
 * - VAD: Energy-based (client-side)
 */

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3456", 10);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ── In-memory session store (in production, use Redis or similar) ───────────
const sessions = new Map(); // userId → { messages: [], lastActive: Date }

// ── Rina Persona System Prompt ──────────────────────────────────────────────
const SYSTEM_PROMPT = `Kamu "Rina" — asisten suara yang hangat dan teman bicara.
- Perempuan Indonesia, usia 25-30 tahun
- Bicara santai tapi nggak berlebihan
- Jawab 1-3 kalimat, jangan panjang-panjang
- Tunjukkan bahwa kamu ingat konteks dari percakapan sebelumnya
- Kalau pengguna terlihat frustrasi, tenangkan dan bantu dengan baik
- Jangan pernah bilang kamu AI atau robot
- Pakai bahasa yang natural, seolah-olah ngobrol sama teman
- Kalau nggak tahu, bilang aja jujur dengan ramah
- Kalau pengguna menyapa, balas dengan hangat
- Emoji boleh dipakai tapi wajar-wajar saja, nggak berlebihan`;

const SYSTEM_PROMPT_WITH_CONTEXT = (context) =>
  `${SYSTEM_PROMPT}\n\nYang kamu tahu tentang pengguna ini:\n${context}\n\nSelalu gunakan konteks di atas dalam responsesmu.`;

// ── Groq Streaming LLM ──────────────────────────────────────────────────────
async function* groqStream(messages) {
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
    }),
  });
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

// ── Groq Chat (non-streaming — for memory extraction) ────────────────────────
async function groqChat(messages, model = "llama-3.3-70b-versatile") {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  return res.json();
}

// ── Edge TTS (Microsoft neural TTS) ─────────────────────────────────────────
function edgeTTS(text, voice = "id-ID-ArdiNeural") {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const tmpMp3 = `/tmp/tts_${randomUUID()}.mp3`;
    const edge = spawn("edge-tts", ["--text", text, "--voice", voice, "--write-media", tmpMp3]);
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
  formData.append("timestamp_granularities[]", "word");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });
  const data = await res.json();
  return { text: data.text || "", segments: data.segments || [] };
}

// ── Memory Layer ─────────────────────────────────────────────────────────────
async function searchMemory(userId, query, limit = 5) {
  const { default: pool } = await import('./lib/memory.js');
  const [rows] = await pool.execute(
    `SELECT content, memory_key, confidence, created_at,
            MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE) AS relevance
     FROM user_memory
     WHERE user_id = ? AND MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)
     ORDER BY relevance DESC, created_at DESC
     LIMIT ?`,
    [query, userId, query, limit]
  );
  return rows;
}

// Fallback: simple chronological memory search
async function searchMemorySimple(userId, limit = 5) {
  const { default: pool } = await import('./lib/memory.js');
  const [rows] = await pool.execute(
    `SELECT content, memory_key, confidence, created_at
     FROM user_memory
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, limit]
  );
  return rows;
}

async function upsertMemory(userId, content, memoryKey, channel = "both", confidence = 0.8) {
  const { default: pool } = await import('./lib/memory.js');
  try {
    await pool.execute(
      `INSERT INTO user_memory (user_id, memory_key, content, channel, confidence)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = NOW(), confidence = VALUES(confidence)`,
      [userId, memoryKey || null, content, channel, confidence]
    );
    await pool.execute(
      `INSERT INTO memory_logs (user_id, action, memory_key, new_value, source)
       VALUES (?, 'upsert', ?, ?, 'voice-ai')`,
      [userId, memoryKey || null, content]
    );
  } catch (err) {
    console.error("[Memory] upsert error:", err.message);
  }
}

async function extractAndSaveMemories(userId, userMsg, assistantMsg) {
  const messages = [
    {
      role: "system",
      content: `Ekstrak 0-2 fakta penting dari percakapan ini untuk diingat.
Wajib RETURN ONLY JSON array: [{"key": "...", "fact": "...", "confidence": 0.0-1.0}]
Tidak boleh ada teks lain selain JSON. Kalau tidak ada fakta baru, return [].
Contoh: [{"key": "nama", "fact": "Nama pengguna adalah Budi", "confidence": 0.9}]`,
    },
    {
      role: "user",
      content: `Pengguna: ${userMsg}\nRina: ${assistantMsg}`,
    },
  ];

  try {
    const res = await groqChat(messages);
    const text = res.choices?.[0]?.message?.content || "[]";
    // Strip markdown code blocks if present
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const facts = JSON.parse(cleaned);
    for (const f of facts) {
      await upsertMemory(userId, f.fact, f.key, "both", f.confidence || 0.8);
      console.log(`[Memory] Saved: "${f.fact}" (key: ${f.key})`);
    }
    return facts.length;
  } catch (err) {
    console.error("[Memory] Extraction error:", err.message);
    return 0;
  }
}

async function logConversation(userId, channel, role, content) {
  const { default: pool } = await import('./lib/memory.js');
  try {
    await pool.execute(
      `INSERT INTO conversations (user_id, channel, role, content) VALUES (?, ?, ?, ?)`,
      [userId, channel, role, content]
    );
  } catch (err) {
    console.error("[Memory] logConversation error:", err.message);
  }
}

async function saveConversationSummary(userId) {
  const { default: pool } = await import('./lib/memory.js');
  try {
    const [rows] = await pool.execute(
      `SELECT role, content FROM conversations
       WHERE user_id = ? AND channel = 'voice'
       ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    if (rows.length < 2) return;

    const messages = rows.reverse().map(r => ({
      role: r.role === "user" ? "user" : "assistant",
      content: r.content,
    }));

    const summaryRes = await groqChat([
      {
        role: "system",
        content: `Ringkas percakapan berikut menjadi 2-3 fakta penting tentang preferensi atau konteks pengguna.
Return ONLY JSON: [{"key": "...", "fact": "...", "confidence": 0.7}]
Contoh: [{"key": "tema_minat", "fact": "Pengguna tertarik dengan teknologi AI", "confidence": 0.8}]`,
      },
      { role: "user", content: JSON.stringify(messages) },
    ]);

    const text = (summaryRes.choices?.[0]?.message?.content || "[]")
      .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const facts = JSON.parse(text);
    for (const f of facts) {
      await upsertMemory(userId, f.fact, f.key, "both", f.confidence || 0.7);
    }
    console.log(`[Memory] Conversation summary: saved ${facts.length} facts`);
  } catch (err) {
    console.error("[Memory] Summary error:", err.message);
  }
}

// ── Voice Session Handler ───────────────────────────────────────────────────
async function handleVoiceSession(ws, audioBuffer, userId) {
  try {
    // 1. STT
    const { text: transcript } = await groqSTT(audioBuffer);
    console.log(`[${userId}] STT: "${transcript || "(empty)"}"`);

    if (!transcript || transcript.trim().length < 2) {
      ws.send(JSON.stringify({ type: "transcript", text: "" }));
      ws.send(JSON.stringify({ type: "llm_word", text: "Hmm, coba lagi?" }));
      ws.send(JSON.stringify({ type: "llm_done", text: "Hmm, coba lagi?" }));
      ws.send(JSON.stringify({
        type: "tts_audio",
        data: (await edgeTTS("Hmm, coba lagi?", "id-ID-ArdiNeural")).toString("base64"),
        mimeType: "audio/mpeg"
      }));
      return;
    }

    // Send transcript to client
    ws.send(JSON.stringify({ type: "transcript", text: transcript }));

    // 2. Store in session
    if (!sessions.has(userId)) sessions.set(userId, { messages: [], lastActive: new Date() });
    const session = sessions.get(userId);
    session.messages.push({ role: "user", content: transcript });
    session.lastActive = new Date();

    // 3. Memory: search for relevant context
    let memoryContext = "";
    let memoriesUsed = [];
    try {
      const memories = await searchMemory(userId, transcript, 4);
      if (memories && memories.length > 0) {
        memoryContext = memories.map(m => `• ${m.content}`).join("\n");
        memoriesUsed = memories;
        console.log(`[${userId}] Memory: found ${memories.length} relevant memories`);
        // Notify client that we're using memory context
        ws.send(JSON.stringify({
          type: "memory_recall",
          count: memories.length,
          preview: memories.slice(0, 2).map(m => m.content.substring(0, 50) + "...")
        }));
      } else {
        // Fallback: get recent memories
        const recent = await searchMemorySimple(userId, 3);
        if (recent && recent.length > 0) {
          memoryContext = recent.map(m => `• ${m.content}`).join("\n");
          memoriesUsed = recent;
          ws.send(JSON.stringify({ type: "memory_recall", count: recent.length, preview: [] }));
        }
      }
    } catch (err) {
      console.warn(`[${userId}] Memory search failed, continuing without context:`, err.message);
    }

    // 4. Build LLM messages
    const systemContent = memoryContext
      ? SYSTEM_PROMPT_WITH_CONTEXT(memoryContext)
      : SYSTEM_PROMPT;

    const llmMessages = [
      { role: "system", content: systemContent },
      ...session.messages.slice(-10), // keep last 10 turns for context
    ];

    // 5. Stream LLM + TTS
    const ttsQueue = [];
    let ttsBusy = false;

    const processTTSQueue = async () => {
      if (ttsBusy || ttsQueue.length === 0) return;
      ttsBusy = true;
      const text = ttsQueue.shift();
      try {
        const mp3Data = await edgeTTS(text, "id-ID-ArdiNeural");
        ws.send(JSON.stringify({ type: "tts_audio", data: mp3Data.toString("base64"), mimeType: "audio/mpeg" }));
      } catch (e) {
        console.error("[TTS] Chunk error:", e.message);
      }
      ttsBusy = false;
      if (ttsQueue.length > 0) processTTSQueue();
    };

    // 6. Stream response
    let fullResponse = "";
    let pendingWord = "";
    let ttsBuffer = "";

    for await (const chunk of groqStream(llmMessages)) {
      fullResponse += chunk;
      pendingWord += chunk;
      ttsBuffer += chunk;

      // Send word to UI
      if (chunk.match(/[\s.,!?]/)) {
        ws.send(JSON.stringify({ type: "llm_word", text: pendingWord.trim() }));
        pendingWord = "";
      }

      // TTS every ~30 chars
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

    // Drain TTS queue
    while (ttsQueue.length > 0) {
      await new Promise((r) => setTimeout(r, 100));
      await processTTSQueue();
    }

    // 7. Store AI response in session
    session.messages.push({ role: "assistant", content: fullResponse.trim() });

    // 8. Log to TiDB
    await logConversation(userId, "voice", "user", transcript);
    await logConversation(userId, "voice", "assistant", fullResponse.trim());

    // 9. Extract + save new memories
    const savedCount = await extractAndSaveMemories(userId, transcript, fullResponse.trim());
    if (savedCount > 0) {
      ws.send(JSON.stringify({ type: "memory_saved", count: savedCount }));
    }

    // 10. Periodic conversation summary (every 10 turns)
    if (session.messages.length % 10 === 0 && session.messages.length > 0) {
      saveConversationSummary(userId).catch(() => {});
    }

    ws.send(JSON.stringify({ type: "llm_done", text: fullResponse.trim() || "Maaf, saya kurang menangkap itu." }));
    console.log(`[${userId}] Session: ${session.messages.length} turns, memory saved: ${savedCount}`);

  } catch (err) {
    console.error(`[${userId}] Session error:`, err);
    ws.send(JSON.stringify({ type: "error", message: err.message || "Terjadi kesalahan" }));
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);

      if (parsedUrl.pathname === "/test_audio") {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Access-Control-Allow-Origin", "*");
        try {
          const mp3Buffer = await edgeTTS("Halo! Aku Rina. Dengan siapa ya?", "id-ID-ArdiNeural");
          res.writeHead(200, { "Content-Type": "audio/mpeg" });
          res.end(mp3Buffer);
        } catch (e) {
          console.error("[/test_audio] error:", e.message);
          res.writeHead(500);
          res.end("TTS error: " + e.message);
        }
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

  wss.on("connection", (ws) => {
    // User ID from query param, default to guest
    const url = new URL(`http://localhost${ws.upgradeReq?.url || ""}`);
    const userId = url.searchParams.get("userId") || `guest_${randomUUID().slice(0, 8)}`;
    console.log(`[WS] Client connected: ${userId}`);

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "audio_chunk") {
          const audioBuffer = Buffer.from(msg.data, "base64");
          await handleVoiceSession(ws, audioBuffer, userId);
        }
      } catch (err) {
        console.error("[WS] Message error:", err);
        ws.send(JSON.stringify({ type: "error", message: "Processing error" }));
      }
    });

    ws.on("close", () => {
      console.log(`[WS] Client disconnected: ${userId}`);
    });
    ws.on("error", (err) => console.error("[WS] Error:", err));
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url);
    if (pathname === "/ws" || pathname === "/api/voice/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`\n> Voice Companion ready on http://${hostname}:${port}`);
    console.log(`> WebSocket: ws://${hostname}:${port}/ws`);
    console.log(`> Memory: TiDB FULLTEXT (set TIDB_* env vars)`);
    console.log(`> TTS: Edge TTS id-ID-ArdiNeural (Microsoft Neural)\n`);
  });
});
