# Voice AI Companion — Rina v2

A real-time voice AI companion with persistent memory. Built with Next.js, WebSocket, Groq, OpenClaw (for agentic tasks), Edge TTS, and TiDB. Runs in the browser.

> **Demo:** [voice-companion.vercel.app/voice](https://voice-companion.vercel.app/voice)

---

## What's New in v2

- **OpenClaw integration** — task-oriented messages routed to OpenClaw for agentic work (coding, analysis, creation)
- **Persistent memory** — Rina remembers facts across sessions via TiDB FULLTEXT search
- **Memory extraction** — automatically saves key facts after each conversation turn
- **Memory recall feedback** — visual indicator when Rina pulls from memory
- **Session caps** — history limited to 20 turns to prevent context bloat
- **Health endpoint** — `/health` for monitoring
- **Rina persona** — warm Indonesian AI companion, not a generic bot

---

## Architecture

```
Browser mic (MediaRecorder)
        ↓ WebSocket /ws?userId=xxx
        ↓
server.js
  ├─ Groq Whisper STT → transcript
  │
  ├─ [Intent detection]
  │     ├─ Task intent → OpenClaw API → agentic response
  │     └─ Chat intent → Groq Llama
  │
  ├─ TiDB memory search (FULLTEXT) → context injected into prompt
  │
  └─ Edge TTS (Microsoft Neural) → MP3 chunks → WebSocket
        ↓
Browser plays audio via decodeAudioData()
Mic auto-mutes while Rina speaks

After every turn:
  ├─ Log to TiDB conversations table
  ├─ Extract facts → TiDB user_memory table
  └─ Every 15 turns → session summary
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), Tailwind CSS |
| Realtime | WebSocket (native, no Socket.io) |
| Speech → Text | Groq Whisper (`whisper-large-v3`) |
| LLM (chat) | Groq (`llama-3.3-70b-versatile`) |
| LLM (tasks) | OpenClaw (agentic, set `OPENCLAW_API_KEY`) |
| Text → Speech | Edge TTS (Microsoft Neural, `id-ID-ArdiNeural`) |
| Memory | TiDB (MySQL serverless, FULLTEXT index) |
| VAD | Energy-based silence detection (no external SDK) |

---

## Setup

### 1. Install

```bash
npm install
pip install edge-tts
```

### 2. Configure

```bash
cp .env.example .env.local
# Fill in .env.local with your keys
```

| Variable | Where |
|----------|-------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `OPENCLAW_API_KEY` | Your OpenClaw instance (optional — Groq used if not set) |
| `TIDB_HOST/PORT/USER/PASSWORD` | TiDB Cloud → Connection |

### 3. TiDB Schema

Run `schema.sql` in TiDB Cloud Console → SQL Editor.

### 4. Run

```bash
npm run dev
```

Open [http://localhost:3456/voice](http://localhost:3456/voice)

---

## OpenClaw Integration

Rina has two modes:

**Casual chat** (default, Groq Llama)
- Small talk, questions, general conversation
- Fast, cheap, works without OpenClaw

**Agentic tasks** (when OpenClaw is configured)
- "Buatkan script Python untuk..."
- "Analisa data ini dan jelaskan..."
- "Write me a React component..."
- OpenClaw handles the actual work; Rina delivers the result by voice

Intent detection is keyword-based (see `server.js` `taskKeywords` array). To tune it, adjust the keywords to match your use case.

---

## Rina Persona

Warm Indonesian female companion (age 25-30):
- Casual Indonesian, short responses (1-3 sentences)
- Remembers context between calls
- Never reveals she's an AI
- Emoji naturally, not excessively
- Steers frustrated users calmly

Edit `RINA_PROMPT` in `server.js` to change personality.

---

## WebSocket Protocol

Connect: `wss://host/ws?userId=<session_id>`

### Client → Server

```jsonc
{ "type": "audio_chunk", "data": "<base64 webm>" }
```

### Server → Client

| Type | Payload | When |
|------|---------|------|
| `transcript` | `{ text }` | User speech as text |
| `llm_word` | `{ text }` | Streaming word from LLM |
| `llm_done` | `{ text }` | Response complete |
| `tts_audio` | `{ data, mimeType }` | MP3 chunk (base64) |
| `memory_recall` | `{ count, preview }` | Rina using memory context |
| `memory_saved` | `{ count }` | New facts saved |
| `agent_status` | `{ text }` | Routed to OpenClaw |
| `error` | `{ message }` | Something failed |

---

## File Structure

```
├── server.js           # Custom server: WS + STT + LLM routing + TTS + memory
├── app/
│   ├── voice/page.tsx  # Voice call UI
│   └── audio-test/     # Audio diagnostics
├── lib/
│   ├── groq.ts         # Groq LLM client
│   ├── memory.cjs      # TiDB memory (CommonJS, for server.js)
│   ├── memory.ts       # TiDB memory (ESM, for API routes)
│   ├── minimax.ts      # MiniMax TTS/STT (optional)
│   └── tidb.ts        # TiDB pool
├── schema.sql         # TiDB schema
└── .env.example       # Environment template
```

---

## Testing Memory

1. Start a call — tell Rina something memorable (e.g., "Nama saya Budi")
2. End the call
3. Start a new call
4. Ask "Siapa nama saya?" — Rina should remember

## Testing OpenClaw Routing

1. Set `OPENCLAW_API_URL` and `OPENCLAW_API_KEY` in `.env.local`
2. Say "Buatkan script Python sederhana" — you should see "Menghubungi OpenClaw..." in the UI

---

## Troubleshooting

**Mic denied**
→ Use HTTPS or localhost. Browser requires secure context.

**Memory not working**
→ Verify TiDB schema created. Check `TIDB_*` env vars. Run `GET /health` to check.

**TTS silent**
→ Run `edge-tts --text "test" --voice id-ID-ArdiNeural --write-media /tmp/test.mp3` to verify installation.

**Use `npm run dev` not `next dev`**
→ The custom server handles WebSocket upgrades.

---

## Roadmap

- [ ] Mem9 vector search (replaces FULLTEXT)
- [ ] OpenClaw streaming response over WebSocket
- [ ] Multi-turn memory summarization with compression
- [ ] Session history page
- [ ] Indonesian ↔ English persona toggle
- [ ] Voice command shortcuts ("call mom", "remind me...")
