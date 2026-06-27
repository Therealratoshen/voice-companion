# Voice AI Companion — Rina

A real-time voice AI companion with persistent memory. Built with Next.js, WebSocket, Groq, Edge TTS, and TiDB. Runs in the browser — open, tap call, talk naturally.

> **Live demo:** [voice-companion.vercel.app/voice](https://voice-companion.vercel.app/voice)

---

## What's New (v2)

- **Persistent memory** — Rina remembers things between calls using TiDB FULLTEXT search
- **Memory extraction** — automatically saves key facts after each conversation turn
- **Memory recall feedback** — visual indicator when Rina pulls from memory
- **Session continuity** — session ID stored in localStorage, memory persists across page refreshes
- **Better real-time feel** — VAD energy bar, AI speaking waves, thinking indicator
- **Rina persona** — warm Indonesian AI companion, not a generic bot

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), Tailwind CSS |
| Realtime | WebSocket (native, no Socket.io) |
| Speech → Text | Groq Whisper (`whisper-large-v3`) |
| LLM | Groq (`llama-3.3-70b-versatile`), streaming |
| Text → Speech | Edge TTS (Microsoft Neural, `id-ID-ArdiNeural`) |
| Memory | TiDB (MySQL serverless, FULLTEXT index) |
| Audio I/O | Web Audio API + MediaRecorder |
| VAD | Energy-based silence detection (no external SDK) |

---

## How It Works

```
User taps call
       ↓
  Browser mic on
  WebSocket connects with userId
       ↓
  Energy VAD detects speech
  → sends audio chunk via WS
       ↓
  Server: Groq Whisper STT → transcript
       ↓
  Server: TiDB FULLTEXT search → memory context
       ↓
  Server: Groq Llama (streaming) + memory context
       ↓
  Each word → Edge TTS → MP3 chunk → WS → browser
       ↓
  Browser plays audio via decodeAudioData()
  Mic auto-mutes while Rina speaks
       ↓
  After response: extract facts → TiDB memory
```

**Memory flow:**
1. Before LLM call → search TiDB for relevant memories (FULLTEXT)
2. Inject memories into system prompt as context
3. After LLM response → extract 0-2 key facts
4. Upsert facts into `user_memory` table
5. Notify client with memory recall/saved events

---

## Setup

### 1. Install dependencies

```bash
npm install
```

You'll also need **edge-tts** installed system-wide (for the TTS):

```bash
pip install edge-tts
# or
npx edge-tts-install  # if available
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in your keys:

| Variable | Where to get it |
|----------|----------------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `TIDB_HOST` | TiDB Cloud → Connection → Standard Connection |
| `TIDB_PORT` | Usually `4000` |
| `TIDB_USER` | TiDB username |
| `TIDB_PASSWORD` | TiDB password |
| `TIDB_DATABASE` | Database name (create one) |

### 3. Set up TiDB schema

Run `schema.sql` in TiDB Cloud Console → SQL Editor:

```sql
-- Creates:
--   user_memory   — FULLTEXT searchable conversation memory
--   conversations — raw transcript log
--   memory_logs   — memory audit trail
```

### 4. Start

```bash
npm run dev
```

Open [http://localhost:3456/voice](http://localhost:3456/voice)

---

## File Structure

```
voice-companion/
├── server.js           # Custom server: WebSocket + STT + LLM + TTS + Memory
├── app/
│   ├── voice/
│   │   └── page.tsx    # Voice call UI (Rina persona)
│   └── audio-test/
│       └── page.tsx    # Audio diagnostics
├── lib/
│   ├── groq.ts         # Groq LLM + Whisper STT client
│   ├── minimax.ts       # MiniMax TTS (optional, not used by default)
│   ├── memory.ts        # TiDB memory layer (search, upsert, log)
│   └── tidb.ts         # TiDB connection pool
├── schema.sql          # TiDB schema
└── .env.example        # Environment template
```

---

## Rina — AI Persona

Rina is a warm Indonesian female AI companion (age 25-30). Key traits:

- Speaks casual Indonesian naturally
- Keeps responses short (1-3 sentences)
- Remembers context from previous conversations
- Shows empathy when user seems frustrated
- Never reveals she's an AI
- Uses emoji naturally, not excessively

The persona is defined in `server.js` via `SYSTEM_PROMPT`. Edit it to change how Rina sounds.

---

## WebSocket Protocol

Connect to `ws://host/ws?userId=<session_id>`.

### Client → Server

```jsonc
// Start call
{ "type": "audio_chunk", "data": "<base64 webm audio>" }
```

### Server → Client

| Type | Payload | Description |
|------|---------|-------------|
| `transcript` | `{ text: string }` | User's speech as text |
| `llm_word` | `{ text: string }` | Streaming word from LLM |
| `llm_done` | `{ text: string }` | LLM response complete |
| `tts_audio` | `{ data: string, mimeType: string }` | MP3 audio chunk (base64) |
| `tts_fallback` | `{ text: string }` | TTS failed, use SpeechSynthesis |
| `memory_recall` | `{ count, preview? }` | Rina is using memory context |
| `memory_saved` | `{ count }` | New facts saved to memory |
| `error` | `{ message: string }` | Something went wrong |

---

## Memory Layer

TiDB stores two types of memory:

1. **Facts** — extracted from conversation turns, stored in `user_memory`
2. **Raw transcripts** — logged in `conversations` for audit and summary

Memory is searched via FULLTEXT index before every LLM call. The most relevant memories are injected into Rina's system prompt as context.

### Testing memory

1. Start a call and tell Rina something memorable (e.g., "Nama saya Budi")
2. End the call
3. Start a new call
4. Ask "Siapa nama saya?" — Rina should remember

---

## Audio Quality Notes

- **Microphone**: WebRTC `getUserMedia` with echo cancellation and noise suppression
- **VAD threshold**: 0.02 RMS energy at 16kHz — tweak for your environment
- **TTS latency**: Edge TTS streams chunks as they're generated (~200-400ms first audio)
- **Mic auto-mute**: Mic is disabled while Rina speaks to prevent feedback
- **Fallback**: If Edge TTS fails, uses browser `SpeechSynthesis` API

---

## Troubleshooting

**"Microphone access denied"**
→ Visit the page over HTTPS or localhost. Browser requires secure context for mic.

**Rina not remembering**
→ Check TiDB schema was created and FULLTEXT index exists. Check `TIDB_*` env vars.

**TTS not working**
→ Run `edge-tts --text "test" --voice id-ID-ArdiNeural --write-media /tmp/test.mp3` from terminal to verify edge-tts is installed.

**WebSocket fails to connect**
→ Make sure you're running `npm run dev` (not `next dev`) — the custom server handles WS upgrades.

---

## Roadmap

- [ ] Replace FULLTEXT with Mem9 vector search
- [ ] MiniMax STT integration (as alternative to Whisper)
- [ ] Multi-turn memory summarization
- [ ] Session history page
- [ ] Indonesian + English bilingual persona toggle
