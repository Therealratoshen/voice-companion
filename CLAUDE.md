# Development Guide

## Setup

```bash
cp .env.example .env.local
# Fill in: AGORA_APP_ID, AGORA_APP_CERTIFICATE, MINIMAX_*, TIDB_*
npm install
npm run dev
```

Open http://localhost:3456/voice

## Mode Detection

- `AGORA_APP_ID` set → Agora Agents SDK mode
- `AGORA_APP_ID` unset → Legacy WebSocket mode (Groq STT + Edge TTS)

## Key Files

| File | Purpose |
|------|---------|
| `lib/agora.ts` | Agora SDK setup, session registry |
| `lib/minimax.ts` | MiniMax LLM + TTS clients |
| `lib/memory.ts` | TiDB FULLTEXT memory |
| `server.js` | Custom Next.js server |
| `app/voice/page.tsx` | Browser voice UI |
| `app/api/session/create/route.ts` | Session creation REST API |

## Testing without Agora credentials

Leave `AGORA_APP_ID` unset → falls back to legacy WebSocket mode (uses Groq + Edge TTS). Requires `GROQ_API_KEY` and `edge-tts` CLI installed.

## Docker

```bash
cp .env.example .env.production
# Edit .env.production with real keys
docker-compose up -d
```

## TypeScript

- Browser SDK types: `types/agora-rtc-sdk-ng.d.ts`
- The `agora-agents` package is CommonJS — `esModuleInterop: true` is set in tsconfig.json
