# NewMe — Voice AI Partner

A real-time voice AI **partner**, not a chatbot. Built with Next.js, WebSocket, Groq, OpenClaw Agent, Edge TTS, and TiDB Mem9.

> **Demo:** [voice-companion.vercel.app/voice](https://voice-companion.vercel.app/voice)

---

## What Is NewMe

NewMe is an AI that works like a real partner:

- **Knows you deeply** — remembers preferences, goals, habits, context
- **Thinks before acting** — doesn't just answer, understands what you actually need
- **Proactively helps** — suggests next steps, tracks your goals, doesn't wait to be asked
- **Takes ownership** — breaks down complex tasks, follows through

Not a chatbot. A thinking companion.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser — Voice UI                        │
│   Mic → MediaRecorder → WebSocket → Audio playback         │
└───────────────────────────┬─────────────────────────────────┘
                            ↓
            ┌───────────────┴───────────────┐
            │      server.js (Node)         │
            ├───────────────────────────────┤
            │  1. Groq Whisper STT          │
            │  2. Intent detection          │
            │  3. Context injection          │
            │     (memory + profile)          │
            │  4a. Groq Llama → casual chat │
            │  4b. OpenClaw Agent → tasks   │
            │  5. Confirmation loops         │
            │  6. TTS chunking              │
            └───────────────────────────────┘
                      ↓                ↓
           ┌────────────┐        ┌─────────────────┐
           │ TiDB Mem9  │        │ OpenClaw Agent  │
           │ (memory +   │        │ (reasoning +   │
           │  profile)   │        │  tools)         │
           └────────────┘        └─────────────────┘
```

---

## What NewMe Can Do

### Partner Behaviors
| You say | What happens |
|---------|-------------|
| Tell her your name/preferences | Saved to profile, remembered forever |
| "Aku mau belajar coding" | Added as a tracked goal with steps |
| Ask about past conversations | Searches semantic memory, speaks results |
| Ask complex question | Thinks step-by-step, may search web or run code |

### Tasks
| Command | Action |
|---------|--------|
| "Cari berita AI hari ini" | 🔍 Web search → spoken summary |
| "Hitung ROI investasi 10 juta" | 💻 Runs JS → result spoken |
| "Ingatkan aku jam 3 sore" | ⏰ Schedules reminder |
| "Aku mau launch product bulan depan" | 🎯 Breaks into goal + steps, tracks progress |

### Proactive Behaviors
- Suggests next steps after tasks
- Remembers to follow up on things you mentioned
- Tracks goals and checks in
- Offers help before you ask

---

## Setup

### 1. Voice Companion (main)

```bash
cd voice-companion
npm install
pip install edge-tts
cp .env.example .env.local
# Fill: GROQ_API_KEY, TIDB_*

npm run dev
# → http://localhost:3456/voice
```

### 2. OpenClaw Agent (optional — for deep reasoning)

```bash
cd openclaw-agent
npm install
# Add OPENCLAW_URL to voice-companion/.env.local

node server.js
# → http://localhost:8080
```

### 3. TiDB Schema

Run `schema.sql` in TiDB Cloud Console → SQL Editor.

---

## Environment Variables

```
# voice-companion/.env.local
GROQ_API_KEY=...
GROQ_MODEL=llama-3.3-70b-versatile
OPENCLAW_API_URL=http://localhost:8080
TIDB_HOST=...
TIDB_PORT=4000
TIDB_USER=...
TIDB_PASSWORD=...
TIDB_DATABASE=...
```

---

## WebSocket Protocol

Connect: `wss://host/ws?userId=<session_id>`

| Type | Payload | Meaning |
|------|---------|---------|
| `transcript` | `{ text }` | User speech |
| `llm_word` | `{ text }` | Streaming word |
| `llm_done` | `{ text }` | Response done |
| `tts_audio` | `{ data, mimeType }` | MP3 chunk |
| `tts_chunk_start` | `{ index, total, text }` | New TTS chunk |
| `memory_recall` | `{ count, preview }` | Pulling memory |
| `memory_saved` | `{ count }` | Saving memory |
| `skill_status` | `{ name, status, tools }` | Active skill |
| `tool_calls` | `{ tools }` | Tools used |
| `proactive` | `{ text }` | NewMe proactive suggestion |
| `error` | `{ message }` | Error |

---

## File Structure

```
voice-companion/
├── server.js                    # Main voice server
├── openclaw-agent/
│   ├── server.js               # Agent API (:8080)
│   └── lib/
│       ├── agent.js            # Jarvis-style reasoning agent
│       ├── persona_core.js     # NewMe identity & values
│       ├── persona.js          # Persona engine + goal tracker
│       ├── user_profile.js     # User profile + habit detection
│       ├── groq.js
│       ├── functions/
│       │   ├── web_search.js
│       │   ├── code_executor.js
│       │   └── reminders.js
│       └── memory/
│           └── tidb_mem9.js
├── app/voice/page.tsx         # Voice UI
└── schema.sql
```

---

## Roadmap

- [ ] Multi-agent routing (different personas for different contexts)
- [ ] Real-time goal tracking dashboard
- [ ] Proactive notification delivery
- [ ] Session memory compression
- [ ] Voice command shortcuts
- [ ] Integration with external services (calendar, email, CRM)
