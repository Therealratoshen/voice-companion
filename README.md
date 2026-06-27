# Voice AI Companion — Rina v3 (Agentic)

A real-time voice AI companion with persistent memory, web search, code execution, reminders, and smart task routing. Built with Next.js, WebSocket, Groq, OpenClaw agent, Edge TTS, and TiDB Mem9.

> **Demo:** [voice-companion.vercel.app/voice](https://voice-companion.vercel.app/voice)

---

## What's New in v3

- **OpenClaw Agent** — function calling for real tasks: web search, code execution, reminders
- **Confirmation patterns** — Rina asks before taking action ("lanjutkan?")
- **Response chunking** — long answers broken into voice-friendly pieces
- **Skill indicators** — UI shows which skill is active (🔍 Searching, 💻 Running code...)
- **TiDB Mem9 ready** — semantic memory search (falls back to FULLTEXT)
- **Tool history** — transcript shows which tools were used per response

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Browser (Next.js)                          │
│   Mic → MediaRecorder → WebSocket /ws?userId=xxx → Audio UI      │
└───────────────────────────────┬──────────────────────────────────┘
                                ↓
                    ┌───────────────────────┐
                    │   server.js (Node)   │
                    ├───────────────────────┤
                    │  1. Groq Whisper STT  │
                    │  2. Intent Detection  │
                    │  3a. Groq Llama ───────────→ casual chat
                    │  3b. OpenClaw Agent ─────────→ task routing
                    │       ├─ web_search              │
                    │       ├─ execute_code            │
                    │       ├─ create_reminder         │
                    │       ├─ search_memory (Mem9)     │
                    │       └─ remember_fact            │
                    │  4. Edge TTS → chunks → WS      │
                    │  5. Response chunking            │
                    │  6. Confirmation loops            │
                    └───────────────────────┘
                                ↓
              ┌─────────────────┼─────────────────┐
              ↓                 ↓                 ↓
         TiDB Cloud        OpenClaw         Groq API
     (Mem9 memory)     (agent server)      (LLM/STT)
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), Tailwind CSS |
| Realtime | WebSocket (native) |
| Speech → Text | Groq Whisper (`whisper-large-v3`) |
| LLM (chat) | Groq (`llama-3.3-70b-versatile`) |
| LLM (tasks) | OpenClaw Agent (function calling) |
| Text → Speech | Edge TTS (Microsoft Neural, `id-ID-ArdiNeural`) |
| Memory | TiDB Mem9 (vector) + FULLTEXT fallback |
| Web Search | DuckDuckGo (free) + SerpAPI fallback |
| Code Execution | vm2 sandbox (JavaScript) |
| Reminders | In-memory scheduler |

---

## Setup

### 1. Voice Companion (main server)

```bash
cd voice-companion
npm install
pip install edge-tts
cp .env.example .env.local
# Fill in GROQ_API_KEY and TIDB_* vars

npm run dev
# → http://localhost:3456/voice
```

### 2. OpenClaw Agent (optional — for function calling)

```bash
cd openclaw-agent
npm install
# Add OPENCLAW_API_URL=http://localhost:8080 to voice-companion/.env.local

node server.js
# → http://localhost:8080
# → Health: http://localhost:8080/health
```

### 3. TiDB Schema

Run `schema.sql` in TiDB Cloud Console → SQL Editor.

### 4. Mem9 (optional — for semantic memory)

In TiDB Cloud Console → AI Features → Enable Mem9, then add embedding column:

```sql
ALTER TABLE user_memory ADD COLUMN embedding MEM9(768);
CREATE VECTOR INDEX embedding_idx ON user_memory (embedding);
```

---

## Environment Variables

### voice-companion

```env
GROQ_API_KEY=your_key
GROQ_MODEL=llama-3.3-70b-versatile
OPENCLAW_API_URL=http://localhost:8080
OPENCLAW_API_KEY=your_openclaw_key   # optional
TIDB_HOST=xxx.tidbcloud.com
TIDB_PORT=4000
TIDB_USER=xxx
TIDB_PASSWORD=xxx
TIDB_DATABASE=voice_companion
```

### openclaw-agent

```env
GROQ_API_KEY=your_key
OPENAI_API_KEY=your_key  # for embeddings
SERPAPI_KEY=your_key      # optional, for better search
```

---

## What Rina Can Do

### Casual Chat (Groq Llama)
- Ngobrol santai
- Jawab pertanyaan umum
- Remember things between calls

### Tasks (OpenClaw Agent)
| Command | What happens |
|---------|--------------|
| "Cari berita AI hari ini" | 🔍 Web search → speaks results |
| "Hitung ROI 10 juta dengan return 20%" | 💻 Runs JS → speaks result |
| "Ingatkan aku jam 3 sore untuk meeting" | ⏰ Schedules reminder |
| "Siapa nama saya?" (after telling her) | 🧠 Memory recall → speaks it |
| "Aku suka response pendek" | 💾 Saves preference |

### Voice UX Patterns
- **Confirmation**: Before actions, asks "lanjutkan?" → user says "ya"
- **Chunking**: Long answers split into 1-3 sentence chunks
- **Skill indicators**: UI shows active skill (searching, running code...)
- **Memory recall**: Badge appears when pulling from memory

---

## WebSocket Protocol

Connect: `wss://host/ws?userId=<session_id>`

### Server → Client Events

| Type | Payload | Meaning |
|------|---------|---------|
| `transcript` | `{ text }` | User speech |
| `llm_word` | `{ text }` | Streaming word |
| `llm_done` | `{ text }` | Response complete |
| `tts_audio` | `{ data, mimeType }` | MP3 chunk |
| `tts_chunk_start` | `{ index, total, text }` | New TTS chunk |
| `memory_recall` | `{ count, preview }` | Pulling memory |
| `memory_saved` | `{ count }` | Saving memory |
| `skill_status` | `{ name, status, tools }` | Skill active |
| `error` | `{ message }` | Error |

---

## File Structure

```
voice-companion/
├── server.js               # Voice WS server (STT → LLM → TTS)
├── openclaw-agent/         # Agent server (function calling)
│   ├── server.js           # Express API
│   └── lib/
│       ├── agent.js        # Function-calling agent loop
│       ├── groq.js         # Groq client
│       ├── functions/
│       │   ├── web_search.js
│       │   ├── code_executor.js
│       │   └── reminders.js
│       └── memory/
│           └── tidb_mem9.js  # Mem9 vector operations
├── lib/
│   ├── memory.cjs          # Memory layer (CJS)
│   └── groq.ts
├── app/voice/page.tsx     # Voice UI
└── schema.sql
```

---

## Testing

**Memory:**
1. Tell Rina your name
2. End call
3. New call — ask "Siapa nama saya?"

**OpenClaw:**
1. Start `openclaw-agent/server.js`
2. Say "Cari berita teknologi hari ini"
3. Watch 🔍 skill indicator → web search → spoken results

**Code execution:**
1. Say "Hitung 15% dari 2 juta"
2. Watch 💻 skill indicator → code runs → result spoken

**Reminders:**
1. Say "Ingatkan aku jam 3 sore untuk meeting"
2. Watch ⏰ indicator → confirmation → scheduled

---

## Roadmap

- [ ] OpenClaw streaming response over WebSocket
- [ ] Redis for reminders (production)
- [ ] Multi-turn memory summarization with compression
- [ ] Session history page
- [ ] Indonesian ↔ English toggle
- [ ] Voice command shortcuts ("call mom", "remind me...")
- [ ] Pyodide for real Python execution
