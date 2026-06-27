/**
 * Custom Next.js server + WebSocket on same port
 * Next.js handles HTTP, WS upgrades on /ws path
 */
const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

// Strip LIST/INFO metadata chunks from a WAV buffer to produce a clean audio-only WAV
function stripListChunk(wavBuf) {
  const bytes = wavBuf;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return bytes;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45) return bytes;

  let fmtOffset = 0, fmtSize = 0;
  let dataOffset = 0, dataSize = 0;
  let offset = 12;
  while (offset < bytes.length - 8) {
    const id = bytes.slice(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") { fmtOffset = offset; fmtSize = size; }
    else if (id === "data") { dataOffset = offset; dataSize = size; }
    offset += 8 + size + (size % 2);
  }
  if (!fmtOffset || !dataOffset) return bytes;

  const headerSize = 44;
  const cleanSize = headerSize + dataSize;
  const clean = Buffer.alloc(cleanSize);
  bytes.copy(clean, 0, 0, 12);
  bytes.copy(clean, 12, fmtOffset, fmtOffset + 8 + fmtSize);
  bytes.copy(clean, headerSize, dataOffset + 8, dataOffset + 8 + dataSize);
  clean.writeUInt32LE(36 + dataSize, 4);
  clean.write("data", 36);
  clean.writeUInt32LE(dataSize, 40);
  return clean;
}

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3456", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

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

// ── Edge TTS (Microsoft neural TTS - high quality) ───────────────────────
// Sends raw MP3 — browser decodes it via decodeAudioData()
function edgeTTS(text, voice = "id-ID-ArdiNeural") {
  return new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const tmpMp3 = `/tmp/tts_${randomUUID()}.mp3`;
    const edge = spawn("edge-tts", ["--text", text, "--voice", voice, "--write-media", tmpMp3]);
    edge.on("close", code => {
      if (code !== 0) { reject(new Error(`edge-tts exited ${code}`)); return; }
      try {
        const { readFileSync, unlinkSync } = require("fs");
        const mp3Data = readFileSync(tmpMp3);
        unlinkSync(tmpMp3);
        resolve(mp3Data); // raw MP3 buffer
      } catch (e) { reject(e); }
    });
    edge.on("error", reject);
  });
}

// ── Groq Whisper STT ───────────────────────────────────────────────────────
// Returns { text, segments } where segments have start/end timing
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

const SYSTEM_PROMPT = `Kamu adalah asisten suara AI yang hangat dan ramah di telepon.
Selalu jawab dalam Bahasa Indonesia.
Jawaban singkat — 1 sampai 3 kalimat. Jangan bilang kamu AI.`;

async function handleVoiceSession(ws, audioBuffer) {
  try {
    const { text: transcript, segments } = await groqSTT(audioBuffer);
    console.log("[WS] STT transcript:", transcript ? `"${transcript}"` : '(empty)');
    if (!transcript || transcript.trim().length < 2) {
      ws.send(JSON.stringify({ type: "llm_done", text: "I'm here — say something!" }));
      ws.send(JSON.stringify({ type: "tts_fallback", text: "I'm here. Say something!" }));
      return;
    }
    ws.send(JSON.stringify({ type: "transcript", text: transcript }));

    const llmMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ];

    // Start LLM streaming + TTS in parallel
    const ttsQueue = [];
    let ttsReady = null;

    // TTS generator: collects text and starts TTS ASAP
    const ttsGen = (async function* () {
      let buffer = "";
      for await (const chunk of groqStream(llmMessages)) {
        buffer += chunk;
        yield chunk; // pass through to LLM word handler
        // Try to TTS every 50 chars of accumulated text
        while (buffer.length >= 30) {
          const cut = buffer.lastIndexOf(' ');
          if (cut <= 0) break;
          const toTTS = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          if (toTTS.trim()) ttsQueue.push(toTTS.trim());
        }
      }
      // TTS remaining
      if (buffer.trim()) ttsQueue.push(buffer.trim());
    })();

    // Start TTS worker: processes queue as voices become available
    let ttsBusy = false;
    const processTTSQueue = async () => {
      if (ttsBusy || ttsQueue.length === 0) return;
      ttsBusy = true;
      const text = ttsQueue.shift();
      try {
        const mp3Data = await edgeTTS(text, "id-ID-ArdiNeural");
        ws.send(JSON.stringify({ type: "tts_audio", data: mp3Data.toString("base64"), mimeType: "audio/mpeg" }));
      } catch (e) {
        console.error("[WS] TTS chunk error:", e.message);
      }
      ttsBusy = false;
      if (ttsQueue.length > 0) processTTSQueue();
    };

    // Stream LLM words + kick off TTS
    let fullResponse = "";
    let pendingWord = "";
    for await (const chunk of ttsGen) {
      fullResponse += chunk;
      pendingWord += chunk;
      // Send word to UI
      if (chunk.match(/[\s.,!?]/)) {
        ws.send(JSON.stringify({ type: "llm_word", text: pendingWord.trim() }));
        pendingWord = "";
      }
      // Kick off TTS for accumulated text
      processTTSQueue();
    }
    if (pendingWord) ws.send(JSON.stringify({ type: "llm_word", text: pendingWord.trim() }));

    // Drain remaining TTS queue
    while (ttsQueue.length > 0) {
      await new Promise(r => setTimeout(r, 100));
      await processTTSQueue();
    }

    ws.send(JSON.stringify({ type: "llm_done", text: fullResponse.trim() || "Sorry, I missed that." }));

  } catch (err) {
    console.error("Session error:", err);
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      // Test audio endpoint — generates TTS and streams back as WAV
      if (parsedUrl.pathname === "/test_audio") {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Access-Control-Allow-Origin", "*");
        try {
          // Use Edge TTS (neural voice) — send raw MP3, browser decodes via Web Audio
          const mp3Buffer = await edgeTTS("Halo Filbert, ini tes suara. Katakan sesuatu!", "id-ID-ArdiNeural");
          res.writeHead(200, { "Content-Type": "audio/mpeg" });
          res.end(mp3Buffer);
        } catch (e) {
          console.error("[/test_audio] error:", e.message);
          res.writeHead(500, { "Content-Type": "text/plain" });
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
    console.log("[WS] Client connected");
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log("[WS] Message type:", msg.type, "data length:", msg.data?.length || 'N/A');
        if (msg.type === "audio_chunk") {
          const audioBuffer = Buffer.from(msg.data, "base64");
          console.log("[WS] Audio buffer size:", audioBuffer.length, "bytes");
          await handleVoiceSession(ws, audioBuffer);
        }
      } catch (err) {
        console.error("WS message error:", err);
        ws.send(JSON.stringify({ type: "error", message: "Processing error" }));
      }
    });
    ws.on("close", () => console.log("[WS] Client disconnected"));
    ws.on("error", (err) => console.error("WS error:", err));
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url);
    console.log("[HTTP] Upgrade request for:", pathname);
    if (pathname === "/ws" || pathname === "/api/voice/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      console.log("[HTTP] Unknown upgrade path, destroying socket:", pathname);
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> WebSocket on ws://${hostname}:${port}/ws`);
  });
});
