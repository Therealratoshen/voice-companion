# CLAUDE.md — Voice Companion

**Stack:** Next.js 14 (App Router) · TypeScript · Agora Agents SDK · MiniMax LLM + TTS · TiDB (MySQL)

## Architecture

### Two modes

#### Agora Agents (full pipeline)
- **STT:** Deepgram (Agora-managed, `nova-3`, Indonesian supported)
- **LLM:** MiniMax via `CustomLLM` in agora-agents SDK
- **TTS:** MiniMax `speech-02-hd` via `MiniMaxTTS` in SDK
- **Transport:** Agora RTC (browser joins channel) + Conversational AI (agent pipeline)
- **Session control:** `lib/agora.ts` — agent builder, session registry, stop/interrupt/think
- **Agent config:** `lib/minimax.ts` — `buildMiniMaxLLMConfig` + `buildMiniMaxTTSConfig`
- **Memory:** `lib/memory.ts` — context injected as system message at session start, extracted at session end

#### Legacy WebSocket (Groq + Edge TTS)
- **STT:** Groq Whisper (browser → WebSocket → Groq)
- **LLM:** MiniMax (`lib/ws-handler-legacy.ts`)
- **TTS:** Edge TTS (server-side synthesis)
- **Transport:** `server.js` WebSocket server
- Active when `AGORA_APP_ID` is unset

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Custom Next.js server — auto-detects mode |
| `lib/agora.ts` | Agora agent builder, session registry, control methods |
| `lib/minimax.ts` | MiniMax LLM + TTS + personality system |
| `lib/memory.ts` | TiDB memory: context injection, fact extraction, session summaries |
| `lib/ws-handler-legacy.ts` | Legacy WebSocket pipeline (Groq + Edge TTS) |
| `lib/token.ts` | RTC token generator (agora-access-token v2 namespace API) |
| `app/voice/page.tsx` | Browser UI (Agora RTC + Web Audio) |
| `app/api/session/create/route.ts` | Session create — builds agent, injects memory, starts |
| `app/api/session/context/route.ts` | GET — fetch memory context for a message |
| `app/api/session/react/route.ts` | POST — quick reactions → agentThink |
| `app/api/session/summarize/route.ts` | POST — session end: extract memories + save summary |
| `app/api/session/stop/route.ts` | POST — stop active session |
| `app/api/health/route.ts` | GET — returns `{status, env}` |
| `schema.sql` | TiDB schema: memory, sessions, turns, transcripts, profiles |

## Environment Variables

```env
# Required for Agora mode
AGORA_APP_ID=           # From console.agora.io
AGORA_APP_CERTIFICATE=   # From console.agora.io

# Required for both modes
MINIMAX_API_KEY=         # From console.minimax.io
MINIMAX_GROUP_ID=        # MiniMax group/account ID
MINIMAX_VOICE_ID=        # TTS voice ID (e.g. "male-qn-qingse")

# Optional
MINIMAX_API_BASE_URL=    # Default: https://api.minimax.chat
MINIMAX_LLM_MODEL=       # Default: abab6.5s-chat
AGORA_AREA=              # Default: US. Options: US | EU | AP | CN

# Required for memory (TiDB serverless)
TIDB_HOST=
TIDB_PORT=3306
TIDB_USER=
TIDB_PASSWORD=
TIDB_DATABASE=voice_companion
```

## Session Flow (Agora)

```
Browser                    Server                      TiDB
  |                           |                           |
  |-- POST /session/create -->|                           |
  |   {userId}               |-- buildContext(userId) --> |
  |                           |<-- memories + profile ----|
  |                           |-- inject as system msg     |
  |                           |                           |
  |<-- {channel, token} -----|                           |
  |                           |                           |
  |-- joins RTC channel ---->|                           |
  |   (audio starts)          |                           |
  |                           |                           |
  |        [conversation via RTC]                        |
  |                           |                           |
  |                           |<-- session ends -----------| session.on('stopped')
  |                           |-- fetchRecentHistory -->   |
  |                           |-- extractAndSaveMemories ->|
  |                           |-- generateSessionSummary ->|
```

## Memory Context Block

When memory is available, the agent receives this at session start:

```
[KONTEKS MEMORY]
Nama: [from user_profiles]
Bahasa: id-ID

Ingat:
- [fact 1]
- [fact 2]

Riwayat percakapan sebelumnya:
- [session summary]
[/KONTEKS MEMORY]
```

## SDK Quirks (agora-agents@2.4.0)

- `Area.GLOBAL` does NOT exist — use `Area.US`
- `generateRtcToken` is **sync** (returns string)
- `ExpiresIn.hours(n)` returns `number`
- `CustomLLM.systemMessages` = `Record<string, unknown>[]` (not typed `MiniMaxChatMessage[]`)
- Deepgram STT only — no custom STT option
- Session events: `started | stopped | error` only
- `agentThink()` → `on_speaking_action: "ignore"` when injecting reactions

## MiniMax TTS Voices

```typescript
"male-qn-qingse"  // default, warm male
"female-shaonv"   // youthful female
"male-bada"       // lower, confident male
```

## Personality Presets (`lib/minimax.ts`)

| Tone | Best for | Style |
|------|---------|-------|
| `warm` | Personal use | Empathetic, Bahasa Indonesia, uses name |
| `casual` | Informal chat | Gen-Z slang, short responses |
| `professional` | Work contexts | Clear, structured, efficient |
| `playful` | Entertainment | Witty, emoji-friendly |

## Quick Reactions

Tapping a reaction in the UI calls `POST /api/session/react` → `agentThink()` → injected as user message to agent.

## TiDB Schema (run once)

```bash
mysql -h $TIDB_HOST -P $TIDB_PORT -u $TIDB_USER -p$TIDB_PASSWORD $TIDB_DATABASE < schema.sql
```
