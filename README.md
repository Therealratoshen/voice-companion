# Voice AI Companion

A real-time voice AI companion built with Next.js, WebSocket, Groq (LLM + STT), and MiniMax (TTS). Runs in the browser — open the URL, tap call, and talk naturally.

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
│   └── audio-test/      # Audio diagnostics page
├── lib/
│   ├── groq.ts          # Groq LLM + Whisper STT
│   ├── minimax.ts       # MiniMax TTS
│   ├── tidb.ts          # TiDB connection pool
│   └── memory.ts        # Memory search (FULLTEXT)
├── public/
│   ├── audio-test.html  # Standalone audio diagnostic
│   └── test-playback.html
└── schema.sql           # TiDB schema
```

---

## Key Architecture Decisions

### Why WebSocket instead of Agora?

This project uses raw WebSocket for maximum control over the audio pipeline. The mic captures PCM via `MediaRecorder`, chunks are sent to the server, and TTS audio flows back as base64 MP3 chunks.

**Downside:** The browser mic can't be shared with other tabs while the call is active.

### Why energy-based VAD?

Keeps the dependency footprint small — no Silero, no external VAD service. At 16kHz sample rate, a 20ms RMS energy threshold of `0.02` works well for speech vs silence in normal indoor environments.

### Why MiniMax TTS?

Low latency, good quality Mandarin voice support, and competitive pricing for Chinese-language voice companions.

### Why TiDB?

Serverless MySQL-compatible database. Works well on free tier, supports FULLTEXT indexes for naive memory search without needing a separate Mem9/vector service.

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

## TODO

- [ ] Replace naive FULLTEXT memory with proper reranking / Mem9
- [ ] MiniMax STT integration (currently uses Groq Whisper only)
- [ ] Multi-turn memory summarization to stay within context window
- [ ] Optional: Add actual Agora RTC for better multi-tab audio sharing
