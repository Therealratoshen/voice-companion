# AGENTS.md — Voice Companion Agent Memory

## Project Identity

**Voice Companion** — A production-grade Indonesian-first AI voice agent, running on Rafiqspace infrastructure.
"AI That Understands Humanity" — built by PT. Rafiq Space Intelligence.

**Repository:** github.com/Therealratoshen/voice-companion

## What This Project Does

A real-time voice AI companion for Indonesian users that:
- Listens to natural speech (Bahasa Indonesia, English)
- Responds with warmth and empathy using MiniMax LLM + TTS
- Remembers user preferences, facts, and conversation history via TiDB
- Operates in two modes: **Agora Agents** (Agora RTC + Deepgram STT + MiniMax) or **Legacy WebSocket** (Rafiqspace STT + MiniMax LLM + MiniMax TTS)

## Tech Stack

- **Frontend:** Next.js 14 App Router, TypeScript, Tailwind CSS
- **Agent SDK:** agora-agents 2.4.0 (Agora RTC + Conversational AI)
- **LLM:** MiniMax (`abab6.5s-chat` via OpenAI-compatible API)
- **TTS:** MiniMax `speech-02-hd`
- **STT (Agora):** Deepgram `nova-3` (managed by Agora)
- **STT (Legacy):** Rafiqspace async API (upload → poll → transcript)
- **Memory:** TiDB Serverless (MySQL-compatible, FULLTEXT search)
- **Deployment:** VPS / Docker

## Key Agents / Sessions

| Session | Purpose | Key files |
|---------|---------|-----------|
| `voice` | Main voice UI + RTC connection | `app/voice/page.tsx` |
| `agora` | Agent lifecycle + memory injection | `lib/agora.ts` |
| `memory` | Context building + fact extraction | `lib/memory.ts` |
| `minimax` | LLM config + personality system | `lib/minimax.ts` |

## Critical Implementation Notes

### MiniMax TTS Format
MiniMax TTS returns audio in MiniMax-specific format (not raw PCM/WAV). Use the `audio_file` param or parse `data.data.audio` from response. **Do NOT assume WAV/MP3 output** unless `response_format=wav` is set.

### Memory extraction happens AFTER session ends
The Agora Agents SDK doesn't provide per-turn event callbacks (only `started | stopped | error`). Memory extraction runs in the `session.on('stopped')` handler, using `fetchRecentHistory()` from TiDB.

### `buildContext()` is the single entry point for memory
All memory retrieval flows through `buildContext()` → `formatContextForLLM()` → injected as `[KONTEKS MEMORY]` system message block at session start.

### No custom STT in SDK
The agora-agents SDK only supports Deepgram for STT. Rafiqspace STT is NOT integrated into the SDK pipeline — it's a separate product.

### Vercel env vars are NOT available at runtime in custom server.js
`server.js` runs as a standalone Node.js server, not inside Next.js Vercel runtime. All secrets must be set as `process.env.*` in the environment, not in Vercel dashboard.

## Memory Categories

Priority for fact extraction:
1. `personal` (5) — name, job, family, health, location
2. `preference` (4) — language, tone, interests
3. `contextual` (3) — current project, recent event
4. `general` (2) — opinions, preferences
5. `ephemeral` (1) — temporary context (should be ignored)

## Personality Tone

Default: **warm** (Bahasa Indonesia, empathetic, uses name). Configurable via `TIKITONE` env var or per-user profile in `user_profiles` table.

## For Future Sessions

When working on this project:
1. Read `CLAUDE.md` for full technical details
2. Check `schema.sql` for TiDB schema (run migrations after schema changes)
3. Test Agora mode requires `AGORA_APP_ID` + `AGORA_APP_CERTIFICATE` in env
4. Legacy WebSocket mode activates automatically when `AGORA_APP_ID` is unset
5. MiniMax API has NO quota — use `AI_TEACHER_PROVIDER=openai` in other projects
6. The `AGORA_AREA` env var defaults to `Area.US` — set to `CN` for China region
