/**
 * Agora Agents SDK — voice agent infrastructure.
 *
 * Stack:
 *   STT → Deepgram (Agora managed, default — Indonesian supported)
 *   LLM → MiniMax via CustomLLM (your BYO)
 *   TTS → MiniMax TTS (speech-02-hd, your BYO)
 *   Transport → Agora RTC + Conversational AI (Agora managed)
 *   Memory → TiDB (your own, injected as context before each session)
 */

import {
  AgoraClient,
  Agent,
  AgentSession,
  Area,
  DeepgramSTT,
  ExpiresIn,
  ExpiresInSeconds,
} from "agora-agents";
import * as crypto from "crypto";
import { buildMiniMaxLLMConfig, buildMiniMaxTTSConfig } from "./minimax";
import { searchMemory } from "./memory";

// ── Agora Client ─────────────────────────────────────────────────────────────

function createClient(): AgoraClient {
  const appId = process.env.AGORA_APP_ID;
  const certificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !certificate) {
    throw new Error(
      "Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE in environment"
    );
  }

  const area = process.env.AGORA_AREA === "CN" ? Area.CN : Area.GLOBAL;

  return new AgoraClient({
    area,
    appId,
    appCertificate: certificate,
  });
}

// ── Session Registry ─────────────────────────────────────────────────────────

export interface ActiveSession {
  session: AgentSession;
  client: AgoraClient;
  channel: string;
  userId: string;
  agentId: string;
}

/** In-memory registry: agentId → ActiveSession */
export const activeSessions = new Map<string, ActiveSession>();

// ── Agent Builder ────────────────────────────────────────────────────────────

export interface AgentConfig {
  turnDetectionLanguage?: string;
  asrLanguage?: string;
  systemMessages?: Array<{ role: "system"; content: string }>;
  greetingMessage?: string;
  speechThreshold?: number;
  silenceDurationMs?: number;
  temperature?: number;
  maxTokens?: number;
}

/** Cached agent + client (built once, reused) */
let _cachedBuild: {
  agent: Agent;
  client: AgoraClient;
} | null = null;

export async function buildAgent(
  config: AgentConfig = {}
): Promise<{ agent: Agent; client: AgoraClient }> {
  if (_cachedBuild) return _cachedBuild;

  const client = createClient();

  const llmConfig = buildMiniMaxLLMConfig({
    systemMessages: config.systemMessages,
    greetingMessage: config.greetingMessage,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });

  const ttsConfig = buildMiniMaxTTSConfig();

  // Lazy import vendor classes
  const { CustomLLM, MiniMaxTTS } = await import("agora-agents");

  const agent = new Agent({
    client,
    turnDetection: {
      language: config.turnDetectionLanguage || "id-ID",
      config: {
        start_of_speech: {
          mode: "vad",
          vad_config: {
            interrupt_duration_ms: 160,
            prefix_padding_ms: 300,
          },
        },
        end_of_speech: {
          mode: "vad",
          vad_config: {
            silence_duration_ms: config.silenceDurationMs ?? 480,
          },
        },
        speech_threshold: config.speechThreshold ?? 0.5,
      },
    },
    advancedFeatures: {
      enable_rtm: true,
      enable_tools: false,
    },
  })
    .withStt(
      new DeepgramSTT({
        model: "nova-3",
        language: config.asrLanguage || "id",
      })
    )
    .withLlm(new CustomLLM(llmConfig))
    .withTts(new MiniMaxTTS(ttsConfig));

  _cachedBuild = { agent, client };
  console.log("[Agora] Agent built and cached");
  return _cachedBuild;
}

// ── Session Management ───────────────────────────────────────────────────────

export interface CreateSessionOptions {
  userId: string;
  channelName?: string;
  expiresIn?: ExpiresInSeconds;
  /** Pre-built system messages (including memory if enabled) */
  systemMessages?: Array<{ role: "system"; content: string }>;
}

export interface SessionInfo {
  session: AgentSession;
  agentId: string;
  channel: string;
  userToken: string;
  userUid: number;
}

export async function createSession(
  agent: Agent,
  client: AgoraClient,
  options: CreateSessionOptions
): Promise<SessionInfo> {
  const appId = process.env.AGORA_APP_ID!;
  const certificate = process.env.AGORA_APP_CERTIFICATE!;

  const channel =
    options.channelName ||
    `voice-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const agentUid = 1001;
  const userUid = Math.floor(Math.random() * 9000) + 1000;
  const tokenExpires = options.expiresIn || ExpiresIn.hours(1);

  // Generate tokens
  const { generateRtcToken } = await import("agora-agents");
  const { generateToken } = await import("./token");

  const userToken = await generateRtcToken({
    appId,
    appCertificate: certificate,
    channel,
    uid: userUid,
    expirationSeconds: tokenExpires,
  }).catch(() =>
    generateToken({
      appId,
      appCertificate: certificate,
      channelName: channel,
      uid: userUid,
      expirationTimeInSeconds: tokenExpires,
    })
  );

  const session = agent.createSession({
    name: `voice-${options.userId}-${Date.now()}`,
    channel,
    agentUid: String(agentUid),
    remoteUids: [String(userUid), "*"],
    idleTimeout: 1800,
    expiresIn: tokenExpires,
    debug: process.env.NODE_ENV !== "production",
  });

  return { session, agentId: "", channel, userToken, userUid };
}

/** Start session + register it */
export async function startAndRegisterSession(
  session: AgentSession,
  client: AgoraClient,
  channel: string,
  userId: string
): Promise<string> {
  const agentId: string = await session.start();
  activeSessions.set(agentId, { session, client, channel, userId, agentId });
  console.log(`[Agora] Session registered — agentId=${agentId} channel=${channel}`);
  return agentId;
}

// ── Session Control ─────────────────────────────────────────────────────────

/** Stop + deregister an active session */
export async function stopSession(agentId: string): Promise<void> {
  const entry = activeSessions.get(agentId);
  if (!entry) {
    console.warn(`[Agora] No active session for agentId=${agentId}`);
    return;
  }
  try {
    await entry.client.agents.stop({ appid: process.env.AGORA_APP_ID!, agentId });
  } finally {
    activeSessions.delete(agentId);
    console.log(`[Agora] Session stopped — agentId=${agentId}`);
  }
}

/** Interrupt the agent mid-speech */
export async function interruptAgent(agentId: string): Promise<void> {
  const entry = activeSessions.get(agentId);
  if (!entry) return;
  await entry.client.agents.interrupt({
    appid: process.env.AGORA_APP_ID!,
    agentId,
  });
}

/** Inject a text event into the agent (e.g. button click) */
export async function agentThink(
  agentId: string,
  text: string
): Promise<void> {
  const entry = activeSessions.get(agentId);
  if (!entry) return;
  await entry.client.agentManagement.agentThink({
    appid: process.env.AGORA_APP_ID!,
    agentId,
    text,
    on_listening_action: "inject",
    on_thinking_action: "interrupt",
    on_speaking_action: "ignore",
    interruptable: true,
  });
}

/** Update agent's system messages at runtime (e.g. after memory fetch) */
export async function updateAgentContext(
  agentId: string,
  systemMessages: Array<{ role: "system"; content: string }>
): Promise<void> {
  const entry = activeSessions.get(agentId);
  if (!entry) return;
  await entry.client.agents.update({
    appid: process.env.AGORA_APP_ID!,
    agentId,
    properties: { llm: { system_messages: systemMessages } },
  });
}
