/**
 * Custom Next.js server + WebSocket + Agora Agents SDK
 *
 * Runs on port 3456 (or PORT env var).
 *
 * Two modes:
 *  1. Legacy WebSocket mode — Rafiqspace STT + MiniMax LLM + MiniMax TTS
 *     (activated when AGORA_APP_ID is not set)
 *  2. Agora mode — Agora Agents SDK (Deepgram STT + MiniMax LLM + MiniMax TTS)
 *     (activated when AGORA_APP_ID is set)
 *
 * API routes (Next.js App Router):
 *   POST /api/session/create  — create an Agora voice agent session
 *   GET  /api/session/:id      — get session status
 *   DELETE /api/session/:id    — stop session
 */

require("dotenv").config();
const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");

const dev = process.env.NODE_ENV !== "production";
const USE_AGORA = !!process.env.AGORA_APP_ID;
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3456", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("HTTP error:", err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  // ── Agora Agents SDK — lazy init ────────────────────────────
  let agoraClient = null;
  let agoraAgent = null;

  async function getAgoraAgent() {
    if (agoraAgent) return { agent: agoraAgent, client: agoraClient };

    // Dynamic import to avoid crashing when SDK isn't installed
    const {
      AgoraClient,
      Agent,
      Area,
      DeepgramSTT,
      CustomLLM,
      MiniMaxTTS,
      ExpiresIn,
    } = await import("agora-agents");

    const { buildMiniMaxLLMConfig, buildMiniMaxTTSConfig } = await import(
      "./lib/minimax"
    );

    agoraClient = new AgoraClient({
      area:
        process.env.AGORA_AREA === "CN" ? Area.CN : Area.US,
      appId: process.env.AGORA_APP_ID,
      appCertificate: process.env.AGORA_APP_CERTIFICATE,
    });

    const llmConfig = buildMiniMaxLLMConfig();
    const ttsConfig = buildMiniMaxTTSConfig();

    agoraAgent = new Agent({
      client: agoraClient,
      turnDetection: {
        language: "id-ID",
        config: {
          start_of_speech: {
            mode: "vad",
            vad_config: {
              interrupt_duration_ms: 160,
              prefix_padding_ms: 300,
            },
          },
          end_of_speech: {
            mode: "vad",
            vad_config: {
              silence_duration_ms: 480,
            },
          },
          speech_threshold: 0.5,
        },
      },
      advancedFeatures: {
        enable_rtm: true,
        enable_tools: false,
      },
    })
      .withStt(
        new DeepgramSTT({
          model: "nova-3",
          language: "id",
        })
      )
      .withLlm(
        new CustomLLM(llmConfig)
      )
      .withTts(
        new MiniMaxTTS(ttsConfig)
      );

    console.log("[Agora] Agent built successfully");
    return { agent: agoraAgent, client: agoraClient };
  }

  // ── Legacy WebSocket (non-Agora mode) ───────────────────────
  if (!USE_AGORA) {
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", async (ws) => {
      const { handleVoiceSession } = await import("./lib/ws-handler-legacy");
      ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "audio_chunk") {
            const audioBuffer = Buffer.from(msg.data, "base64");
            await handleVoiceSession(ws, audioBuffer);
          }
        } catch (err) {
          console.error("WS message error:", err);
          ws.send(JSON.stringify({ type: "error", message: "Processing error" }));
        }
      });
    });

    server.on("upgrade", (req, socket, head) => {
      const { pathname } = parse(req.url);
      if (pathname === "/ws") {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });
  }

  // ── Boot ────────────────────────────────────────────────────
  server.listen(port, hostname, () => {
    if (USE_AGORA) {
      console.log(`> Voice Agent (Agora) on http://${hostname}:${port}`);
      console.log(`> POST /api/session/create to start a voice session`);
    } else {
      console.log(`> Voice Companion (Legacy WS) on http://${hostname}:${port}`);
      console.log(`> WebSocket on ws://${hostname}:${port}/ws`);
    }
  });
});
