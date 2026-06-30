# Voice AI Companion

A real-time voice AI companion powered by **Agora Agents SDK** + **MiniMax** + **TiDB memory**.

Open the URL → tap call → talk naturally in Bahasa Indonesia. The agent remembers your conversation history.

---

## Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Audio Transport** | Agora RTC (via `agora-agents` SDK) | Real-time WebRTC, global edge, <200ms latency |
| **STT** | Deepgram (Agora managed) | Indonesian supported, VAD built-in |
| **LLM** | MiniMax (`abab6.5s-chat`) via CustomLLM | Your API key, OpenAI-compatible endpoint |
| **TTS** | MiniMax TTS (`speech-02-hd`) | Your API key, streamed back over RTC |
| **Memory** | TiDB (MySQL serverless) | FULLTEXT search, session context injection |
| **Frontend** | Next.js 14 (App Router) + Web Audio API | Browser mic → RTC channel |

---

## Architecture

```
Browser (mic on)
    │
    │ 1. POST /api/session/create
    │    ← { channel, userToken, userUid, agentId }
    │
    │ 2. Join Agora RTC channel
    ▼
Agora RTC Network ─── Agent (server-side, agora-agents SDK)
    │                     │
    │                     │ Deepgram STT (audio → text)
    │                     ▼
    │                  MiniMax LLM (text → response)
    │                     │
    │                     │ MiniMax TTS (response → audio)
    │                     ▼
    │                  Agent audio ──→ RTC channel ──→ Browser
    │
    │ 3. POST /api/session/stop (when call ends)
    ▼
```

**Memory flow:** Before each session, TiDB is queried for the user's past context. Memories are injected as a system message into the MiniMax LLM prompt.

---

## Quick Start

### 1. Clone & install

```bash
git clone git@github.com:Therealratoshen/voice-companion.git
cd voice-companion
npm install
```

### 2. Get API keys

| Variable | Where to get it |
|----------|----------------|
| `AGORA_APP_ID` | [console.agora.io](https://console.agora.io) → Conversational AI → Project Settings |
| `AGORA_APP_CERTIFICATE` | Same as above |
| `MINIMAX_API_KEY` | [platform.minimaxi.com](https://platform.minimaxi.com) |
| `MINIMAX_GROUP_ID` | MiniMax dashboard |
| `MINIMAX_LLM_MODEL` | e.g. `abab6.5s-chat` |
| `MINIMAX_VOICE_ID` | From MiniMax voice library |
| `TIDB_*` | [tidbcloud.com](https://tidbcloud.com) → Connection |

### 3. Configure

```bash
cp .env.example .env.production
# Fill in your keys in .env.production
```

### 4. Set up TiDB schema

Run `schema.sql` in the TiDB Cloud SQL Editor:

```sql
-- From schema.sql — creates:
--   user_memory   — FULLTEXT searchable conversation memory
--   conversations — raw transcript log
--   memory_logs   — memory audit trail
```

### 5. Deploy (Docker — recommended for VPS)

```bash
docker-compose up -d
```

Or without Docker:

```bash
npm run build
npm start
```

Open [http://localhost:3456/voice](http://localhost:3456/voice)

---

## API Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session/create` | POST | Create a voice agent session. Returns channel + RTC token for browser. |
| `/api/session/stop` | POST | Stop an active session. Body: `{ agentId }` |
| `/api/health` | GET | Health check for monitoring |

### Create Session

```bash
curl -X POST http://localhost:3456/api/session/create \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-123", "language": "id-ID"}'
```

```json
{
  "channel": "voice-1234567890-abc123",
  "userToken": "...",
  "userUid": 4821,
  "agentId": "agent-xyz",
  "appId": "your-app-id"
}
```

---

## Project Structure

```
voice-companion/
├── server.js                    # Custom Next.js server (Agora or legacy WS mode)
├── Dockerfile                   # Production container image
├── docker-compose.yml           # Docker Compose setup
│
├── lib/
│   ├── agora.ts                 # Agora Agents SDK setup + session management
│   ├── minimax.ts               # MiniMax LLM + TTS clients + SDK config builders
│   ├── memory.ts                # TiDB memory search + upsert
│   ├── groq.ts                  # Groq LLM (legacy mode)
│   └── token.ts                 # RTC token generator fallback
│
├── app/
│   ├── voice/page.tsx           # Browser UI (Agora RTC mode)
│   ├── audio-test/              # Audio diagnostics
│   └── api/
│       ├── session/create/      # POST — create Agora session
│       ├── session/stop/        # POST — stop session
│       └── health/              # GET — health check
│
├── types/
│   └── agora-rtc-sdk-ng.d.ts    # TypeScript declarations for CDN-loaded RTC SDK
│
└── schema.sql                   # TiDB schema (FULLTEXT indexes)
```

---

## Two Modes

The server auto-detects which mode to use based on your environment:

| Mode | Trigger | STT | LLM | TTS |
|------|---------|-----|-----|-----|
| **Agora (default)** | `AGORA_APP_ID` is set | Deepgram | MiniMax | MiniMax |
| **Legacy WebSocket** | `AGORA_APP_ID` is NOT set | Groq Whisper | Groq Llama | Edge TTS |

---

## Key Features

### 🎙️ Interrupt handling
Agora's VAD handles interruptions natively — users can cut the agent off mid-sentence by starting to speak.

### 💾 Memory injection
Before each session, the server fetches up to 5 recent memories from TiDB and injects them as a system message. The agent knows who it's talking to.

### 🌏 Indonesian-first
System prompt is in Bahasa Indonesia. Deepgram STT language set to `id`. TTS uses `id-ID` turn detection.

### 🔄 BYO everything
- **LLM**: swap MiniMax for any OpenAI-compatible endpoint via `CustomLLM`
- **TTS**: change voice ID in `MINIMAX_VOICE_ID`
- **STT**: Agora managed (Deepgram) — Indonesian supported out of the box

---

## Troubleshooting

**Session creation fails with 503?**
→ Check `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE` are set.

**Agent joins channel but doesn't respond?**
→ Check `MINIMAX_API_KEY` and `MINIMAX_GROUP_ID` are valid and have quota.

**TTS plays but sounds wrong?**
→ Try a different `MINIMAX_VOICE_ID`. The voice library is in the MiniMax dashboard.

**Memory not being recalled?**
→ Verify TiDB schema was created with the FULLTEXT index. Check `TIDB_*` env vars.

**Browser mic not working?**
→ Visit `/audio-test` for audio diagnostics.

---

## Roadmap

- [x] Agora Agents SDK integration
- [x] MiniMax LLM + TTS via CustomLLM
- [x] TiDB memory injection per session
- [x] Docker deployment
- [ ] Rafiqspace STT as Deepgram alternative
- [ ] Multi-language support (EN/ID toggle)
- [ ] Session history panel
- [ ] One-tap call from web (no install)
