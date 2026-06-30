---
---
name: voice-companion
description: |
  Voice AI companion built with Agora Agents SDK + MiniMax + TiDB.
  Load this skill when the user wants to: work on the voice-companion repo,
  add features, fix bugs, change the STT/LLM/TTS pipeline, or deploy it.
  Triggers on: "voice companion", "agora voice agent", "voice AI", "speech to text pipeline",
  "MiniMax TTS", "Edge TTS", "real-time voice agent", or any work on
  github.com/Therealratoshen/voice-companion.
  Do NOT use for Shortcutsistem, AI Agent School, or general chat — those are separate projects.
version: 2.0.0
permissions:
  - file.read
  - file.write
  - exec
---

# Voice Companion

Real-time voice AI companion: browser mic → Agora RTC → Deepgram STT → MiniMax LLM → MiniMax TTS → browser audio.
Indonesian-first (Bahasa Indonesia). TiDB memory layer. Two transport modes.

## Architecture at a glance

```
Browser mic → [Agora RTC] → Agent (server)
                                   ├── Deepgram STT (audio → text)
                                   ├── MiniMax LLM (text → response)  [BYO]
                                   └── MiniMax TTS (response → audio) [BYO]
                          Agent audio → [Agora RTC] → Browser
```

**Dual mode**: `AGORA_APP_ID` set → Agora SDK mode. NOT set → legacy WebSocket mode (Groq Whisper + Edge TTS).

## Key files

| File | Purpose |
|------|---------|
| `lib/agora.ts` | Agora Agents SDK setup, session registry, buildAgent, startAndRegisterSession, stopSession, interruptAgent |
| `lib/minimax.ts` | MiniMax LLM + TTS clients; buildMiniMaxLLMConfig(), buildMiniMaxTTSConfig() |
| `lib/memory.ts` | TiDB memory: buildContext, extractAndSaveMemories, generateSessionSummary, saveTurn, upsertUserProfile |
| `lib/token.ts` | RTC token generator (fallback for agora-access-token) |
| `app/api/session/context/route.ts` | `GET /api/session/context?userId=...&message=...` |
| `app/api/session/react/route.ts` | `POST /api/session/react` — quick reaction injection |
| `app/api/session/summarize/route.ts` | `POST /api/session/summarize` — session end memory extraction |
| `server.js` | Custom Next.js server — auto-detects Agora vs legacy mode |
| `app/voice/page.tsx` | Browser UI (Agora RTC Web SDK loaded via CDN) |
| `app/api/session/create/route.ts` | `POST /api/session/create` — creates session, returns channel + token |
| `app/api/session/stop/route.ts` | `POST /api/session/stop` — stops session by agentId |
| `Dockerfile` | Production container image |
| `docker-compose.yml` | One-command deploy |
| `schema.sql` | TiDB schema (run in SQL Editor) |

## Environment variables

```
# Required for Agora mode
AGORA_APP_ID
AGORA_APP_CERTIFICATE
AGORA_AREA          # CN or leave unset (defaults to US)

# Required for MiniMax pipeline
MINIMAX_API_KEY
MINIMAX_GROUP_ID
MINIMAX_LLM_MODEL   # e.g. abab6.5s-chat
MINIMAX_VOICE_ID    # voice ID from MiniMax dashboard
MINIMAX_API_BASE_URL # https://api.minimax.chat (global) or CN endpoint
MINIMAX_TTS_URL     # https://api.minimax.io/v1/t2a_v2

# Optional — legacy mode (when AGORA_APP_ID unset)
GROQ_API_KEY         # Groq Whisper + Llama (legacy STT + LLM)

# TiDB memory (optional — degrades gracefully if missing)
TIDB_HOST
TIDB_PORT
TIDB_USER
TIDB_PASSWORD
TIDB_DATABASE
```

## Memory system (v2)

Memory context is built before each session via `buildContext(userId, sessionId, query)` → `formatContextForLLM()` → injected as `[KONTEKS MEMORY]` block in the system prompt.

Post-session: `generateSessionSummary()` + `extractAndSaveMemories()` run in the `session.on('stopped')` handler in `lib/agora.ts`.

Memory degrades gracefully — if TiDB is unavailable, all memory functions return empty results.

## How to make changes

### 1. Change the LLM
Edit `lib/minimax.ts` → `buildMiniMaxLLMConfig()`. The URL, model, and params all come from there. No other file touches the LLM.

### 2. Change the TTS voice
Change `MINIMAX_VOICE_ID` in `.env.production`, or edit `buildMiniMaxTTSConfig()` in `lib/minimax.ts`.

### 3. Add a new session API route
Add a file under `app/api/<resource>/<action>/route.ts`. Next.js App Router convention: `page.tsx` → GET, `route.ts` → HTTP method handlers.

### 4. Change the system prompt / personality
Edit `lib/minimax.ts`:
- `PERSONA_PRESETS` — 4 tones: warm (default), casual, professional, playful
- `buildPersonaPrompt()` — assembles persona + userName + memory context
- `buildMiniMaxLLMConfig()` → `systemMessages` (Agora mode, uses warm preset by default)
- `lib/ws-handler-legacy.ts` → `SYSTEM_PROMPT` (legacy mode, separate)
Both should stay in sync for consistent behavior.

### 5. Modify VAD / turn detection
Edit the `turnDetection` block in `lib/agora.ts` → `buildAgent()`:
- `speech_threshold`: 0.0–1.0, default 0.5
- `silence_duration_ms`: ms of silence to trigger end-of-speech, default 480

## Gotchas

- **No Vercel**: Uses `server.js` (custom Node server), not the Next.js serverless functions adapter. Deploy via Docker or VPS.
- **Agora SDK is CJS**: `esModuleInterop: true` required in `tsconfig.json`. Do not change it.
- **Area values**: SDK uses `Area.US`, `Area.EU`, `Area.AP`, `Area.CN` — NOT `Area.GLOBAL`.
- **expiresIn**: SDK exports `ExpiresIn.hours(n)` and `ExpiresIn.seconds(n)` (returns number), NOT `ExpiresInSeconds`.
- **CustomLLM systemMessages**: Must be `Record<string, unknown>[]`, not `MiniMaxChatMessage[]`. Use `Record<string, unknown>` cast.
- **generateRtcToken**: Sync function, do NOT await it.
- **agora-access-token**: Namespace-based API (`RtcTokenBuilder.buildTokenWithUid`), NOT class-based.
- **Memory degrades gracefully**: If TiDB env vars are missing, sessions still work — memory just doesn't load.
- **Do NOT set AGORA_APP_ID for legacy mode**: Leave it unset to use Groq + Edge TTS.

## Test locally

```bash
cp .env.example .env.local
# Fill in: AGORA_APP_ID, AGORA_APP_CERTIFICATE, MINIMAX_*, TIDB_*
npm run dev
# Open http://localhost:3456/voice
```

## Build and check

```bash
npm run build   # must pass — no TS errors
# Test health endpoint
curl http://localhost:3456/api/health
# Test session create (will 503 without Agora creds — expected)
curl -X POST http://localhost:3456/api/session/create \
  -H "Content-Type: application/json" \
  -d '{"userId": "test"}'
```

## Deploy

```bash
cp .env.example .env.production
# Fill in real keys
docker-compose up -d
```

## Common failure patterns to avoid

- **Do not** swap STT provider in Agora mode — STT is Agora-managed (Deepgram). Rafiqspace STT is a separate integration project.
- **Do not** use `clean_*.jpg` as pipeline input — see workspace watermark rules.
- **Do not** commit `.env`, `.env.local`, or `.env.production` — all are gitignored.
