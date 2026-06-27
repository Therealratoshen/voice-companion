# Voice AI Companion

A real-time voice AI companion built with Next.js, WebSocket, Groq (LLM + STT), and MiniMax (TTS). Runs in the browser — open the URL, tap call, and talk naturally.

> **Also relevant:** This project is part of a broader voice AI R&D effort that includes an [Agora AI Phone Agent](#-agora-ai-phone-agent) for Indonesian SMEs. See the [Agora projects →](#-agora-ai-agent-stack) below.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), Tailwind CSS |
| Realtime | WebSocket (native, no Socket.io) |
| Speech → Text | Groq Whisper (`whisper-large-v3`) |
| LLM | Groq (`llama-3.3-70b-versatile`), streaming |
| Text → Speech | MiniMax (`speech-02-hd`) |
| Memory | TiDB (MySQL serverless, FULLTEXT search) |
| Audio I/O | Web Audio API + MediaRecorder |
| VAD | Energy-based silence detection (no external SDK) |

---

## How It Works

```
Browser mic → MediaRecorder (webm) → WS → server.js
                                           │
                                           ├─ Groq Whisper → transcript
                                           │                      │
                                           ├─ Groq Llama (streaming)
                                           │                      │
                                           └─ MiniMax TTS ───────┘
                                                       │
                                              TTS chunks → WS → browser
                                                              │
                                                   Web Audio API playMp3Data()
```

1. User presses call → WebSocket connects → mic stream starts
2. Energy-based VAD detects silence after speech → sends audio chunk via WS
3. Server transcribes with Groq Whisper → gets text
4. Text sent to Groq Llama with conversation memory from TiDB → streaming response
5. Each LLM word is forwarded to MiniMax TTS → MP3 chunks sent back over WS
6. Browser plays chunks via `playMp3Data()` using `decodeAudioData()` — mic is auto-muted while AI speaks to prevent feedback
7. After TTS finishes, mic unmutes automatically

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in your keys:

| Variable | Where to get it |
|----------|----------------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `MINIMAX_API_KEY` | [platform.minimaxi.com](https://platform.minimaxi.com) |
| `MINIMAX_GROUP_ID` | MiniMax dashboard |
| `MINIMAX_VOICE_ID` | Voice ID from MiniMax (default: `male-qn-qingse`) |
| `TIDB_HOST` | TiDB Cloud console → Connection → Standard Connection |
| `TIDB_PORT` | Usually `4000` |
| `TIDB_USER` | TiDB username |
| `TIDB_PASSWORD` | TiDB password |
| `TIDB_DATABASE` | Database name |

### 3. Set up TiDB schema

Run `schema.sql` in the TiDB Cloud SQL Editor:

```sql
-- From schema.sql — creates:
--   user_memory   — FULLTEXT searchable conversation memory
--   conversations — raw transcript log
--   memory_logs   — memory audit trail
```

### 4. Start the server

```bash
npm run dev
# or production:
npm start
```

Open [http://localhost:3456/voice](http://localhost:3456/voice)

---

## Project Structure

```
voice-companion/
├── server.js           # Custom Next.js server + WebSocket handler
├── app/
│   ├── voice/page.tsx  # Voice call UI (main page)
│   └── audio-test/     # Audio diagnostics page
├── lib/
│   ├── groq.ts         # Groq LLM + Whisper STT
│   ├── minimax.ts     # MiniMax TTS
│   ├── tidb.ts         # TiDB connection pool
│   └── memory.ts       # Memory search (FULLTEXT)
├── public/
│   ├── audio-test.html # Standalone audio diagnostic
│   └── test-playback.html
└── schema.sql          # TiDB schema
```

---

## Key Architecture Decisions

### Why WebSocket instead of Agora?

This project uses raw WebSocket for maximum control over the audio pipeline. The mic captures PCM via `MediaRecorder`, chunks are sent to the server, and TTS audio flows back as base64 MP3 chunks.

**Trade-off:** The browser mic can't be shared with other tabs during a call.

### Why energy-based VAD?

Keeps the dependency footprint small — no Silero, no external VAD service. At 16kHz sample rate, a 20ms RMS energy threshold of `0.02` works well for speech vs silence in normal indoor environments.

### Why MiniMax TTS?

Low latency, good quality Mandarin voice support, and competitive pricing for Chinese-language voice companions.

### Why TiDB?

Serverless MySQL-compatible database. Works well on free tier, supports FULLTEXT indexes for naive memory search without needing a separate Mem9/vector service.

---

## 🤖 Agora AI Agent Stack

This voice-companion project is one half of a broader voice AI R&D effort. The other half is an **Agora-powered AI Phone Agent** targeting Indonesian SMEs — a different architecture optimized for phone calls rather than browser-based voice chat.

### Project A: AI Phone Agent for Indonesian SMEs

**Location:** `ai-phone-agent/`

A landing-page + server setup for a phone-based AI agent targeting Indonesian small businesses. The agent handles inbound business calls 24/7 — answering common questions like hours, pricing, availability — reducing call volume for business owners.

> "Jawab pertanyaan yang sama 50 kali sehari itu capek banget. Terutama kalau Anda juga harus handle WA, chat, marketplace — telephon lagi. Waktu Anda hilang untuk hal yang seharusnya AI bisa handle."

Key features:
- 24/7 AI telephone agent
- Indonesian language support (ASR + TTS)
- Multi-persona support (different agent personalities)
- Integration with Agora RTC for voice

### Project B: Agora Conversational AI — Custom LLM Recipe

**Location:** `agora-quickstart/recipe-custom-llm/`

The official Agora reference implementation for building a custom LLM TTS pipeline into Agora's Conversational AI cloud. This is the bridge between a custom LLM/TTS backend and Agora's RTC network.

```
Browser (Next.js)
  │ fetch /api/*
  ▼
Next.js ──rewrite──▶ Agent backend (:8000)
                          │ CustomLLM(output_modalities=["audio"])
                          ▼
                       Agora ConvoAI Cloud
                          │ POST <CUSTOM_LLM_URL> (your audio endpoint)
                          ▼
                       Custom audio endpoint → PCM audio → RTC
```

Key files:
- `server/` — Python FastAPI backend with mounted `/audio` endpoint
- `web/` — Next.js frontend
- `AGENTS.md` / `ARCHITECTURE.md` — full design docs

Setup:
```bash
bun run setup          # install deps + create venv
ngrok http 8000        # expose backend publicly
# Add ngrok URL to CUSTOM_LLM_URL in server/.env.local
bun run dev            # start all services
```

---

## Related Projects

| Project | Description |
|---------|-------------|
| `voice-companion/` | Browser-based voice AI companion (WebSocket + Groq + MiniMax) |
| `ai-phone-agent/` | Landing page for Indonesian SME phone AI agent |
| `agora-quickstart/recipe-custom-llm/` | Agora Custom LLM TTS recipe (Python + Next.js) |
| `band-agent/` | Band protocol agent (separate, experimental) |
| `whatsapp-booking-agent/` | WhatsApp booking automation agent |

---

## Troubleshooting

**Microphone not working?**
→ Visit `/audio-test` in the browser to run audio diagnostics

**AI not responding?**
→ Check `GROQ_API_KEY` is set and has quota remaining

**TTS playing but cutting out?**
→ Check `MINIMAX_API_KEY` and `MINIMAX_GROUP_ID` are correct

**Memory not being recalled?**
→ Verify TiDB schema was created and FULLTEXT index exists

---

## Roadmap

- [ ] Replace naive FULLTEXT memory with proper reranking / Mem9
- [ ] MiniMax STT integration (currently uses Groq Whisper only)
- [ ] Multi-turn memory summarization to stay within context window
- [ ] Align AI Phone Agent backend with voice-companion memory layer
- [ ] Add Indonesian language persona support to voice-companion
