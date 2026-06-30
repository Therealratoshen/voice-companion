# Voice Companion — Agent Rules

## Stack
- **Audio**: Agora Agents SDK (WebRTC) — auto-switches to legacy WebSocket if `AGORA_APP_ID` unset
- **STT**: Deepgram (Agora managed, Indonesian supported)
- **LLM**: MiniMax via `CustomLLM` (OpenAI-compatible endpoint)
- **TTS**: MiniMax TTS `speech-02-hd` model
- **Memory**: TiDB with FULLTEXT indexes

## File map
```
lib/agora.ts          → Agent setup, session registry, start/stop/interrupt
lib/minimax.ts        → MiniMax LLM + TTS clients, SDK config builders
lib/memory.ts         → TiDB search + upsert + fact extraction
lib/token.ts          → RTC token generator fallback
lib/ws-handler-legacy.ts → Legacy Groq+EdgeTTS pipeline (no Agora)
app/voice/page.tsx    → Browser UI (Agora RTC)
app/api/session/      → Session create/stop REST API
server.js             → Custom Node server (auto-detects Agora vs legacy)
```

## Key decisions
- Agent is built once, cached in `lib/agora.ts` `_cachedBuild`. Sessions are the unit of work.
- Active sessions stored in `activeSessions` Map keyed by `agentId`.
- Memory injected as extra system message before `session.start()` — not updated mid-session.
- Legacy mode requires `edge-tts` CLI on the server (`npm install edge-tts`).

## Env vars
See `.env.example` — all required keys documented there.

## Docker
`docker-compose up -d` is the recommended production path. Does NOT work on Vercel (custom server).
