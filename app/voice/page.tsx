"use client";

/**
 * Voice Companion UI v2 — feels like Alexa/Siri
 *
 * Key UX improvements:
 * - Persistent listening after connection (mic auto-stays open)
 * - Visual states: idle → listening → thinking → speaking
 * - Animated waveform for the assistant
 * - Ambient sounds: listening beep, thinking tone, confirmation ding
 * - Memory indicator (shows when context is injected)
 * - Conversation continuity (recent turns shown below)
 * - Quick reactions
 */

import { useState, useRef, useCallback, useEffect } from "react";

type VoiceState =
  | "idle"
  | "connecting"
  | "listening"    // mic open, waiting for speech
  | "thinking"     // processing, agent is "thinking"
  | "speaking"     // agent is talking
  | "ending";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: Date;
  memoryUsed?: boolean;
}

interface QuickReaction {
  emoji: string;
  label: string;
}

const QUICK_REACTIONS: QuickReaction[] = [
  { emoji: "👍", label: "Great!" },
  { emoji: "❓", label: "More detail" },
  { emoji: "🔄", label: "Say again" },
  { emoji: "📝", label: "Remember it" },
];

// ── Ambient sound generators (Web Audio API — no files needed) ──────────

function playTone(
  audioCtx: AudioContext,
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.15
) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + duration);
}

function playListeningBeep(audioCtx: AudioContext) {
  playTone(audioCtx, 880, 0.12, "sine", 0.12); // A5
}

function playThinkingTone(audioCtx: AudioContext) {
  // Rising two-tone: "hmm?"
  playTone(audioCtx, 330, 0.2, "triangle", 0.08);
  setTimeout(() => playTone(audioCtx, 440, 0.25, "triangle", 0.08), 200);
}

function playConfirmDing(audioCtx: AudioContext) {
  playTone(audioCtx, 1047, 0.15, "sine", 0.1); // C6
  setTimeout(() => playTone(audioCtx, 1319, 0.2, "sine", 0.08), 120); // E6
}

function playErrorTone(audioCtx: AudioContext) {
  playTone(audioCtx, 220, 0.3, "sawtooth", 0.08);
  setTimeout(() => playTone(audioCtx, 196, 0.4, "sawtooth", 0.08), 300);
}

// ── Animated waveform component ────────────────────────────────────────

function Waveform({ active, color = "violet-400" }: { active: boolean; color?: string }) {
  const bars = 5;
  return (
    <div className="flex items-center gap-1 h-6">
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          className={`w-1 rounded-full transition-all duration-200 ${
            active ? `bg-${color} animate-pulse` : "bg-white/20"
          }`}
          style={{
            height: active
              ? `${30 + Math.sin(Date.now() / 200 + i) * 20 + (i % 2 === 0 ? 10 : -5)}%`
              : "20%",
            animationDelay: `${i * 80}ms`,
            minHeight: active ? "30%" : "20%",
            maxHeight: active ? "100%" : "20%",
          }}
        />
      ))}
    </div>
  );
}

// ── Pulsing ring animation ──────────────────────────────────────────────

function PulsingRing({ color = "violet-500" }: { color?: string }) {
  return (
    <div className="relative flex items-center justify-center">
      <div
        className={`absolute w-24 h-24 rounded-full bg-${color} opacity-20 animate-ping`}
        style={{ animationDuration: "2s" }}
      />
      <div
        className={`absolute w-20 h-20 rounded-full bg-${color} opacity-30 animate-ping`}
        style={{ animationDuration: "1.5s", animationDelay: "0.5s" }}
      />
      <div className={`w-16 h-16 rounded-full bg-${color} flex items-center justify-center z-10`}>
        <Waveform active={true} color={color} />
      </div>
    </div>
  );
}

// ── Memory indicator dot ─────────────────────────────────────────────────

function MemoryIndicator({ visible }: { visible: boolean }) {
  return (
    <div
      className={`flex items-center gap-1.5 transition-opacity duration-500 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
      <span className="text-[10px] text-amber-400/80">remembering</span>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

export default function VoicePage() {
  const [state, setState] = useState<VoiceState>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveText, setLiveText] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callDuration, setCallDuration] = useState("00:00");
  const [turnCount, setTurnCount] = useState(0);
  const [memoryActive, setMemoryActive] = useState(false);
  const [lastReaction, setLastReaction] = useState<QuickReaction | null>(null);

  const userId = useRef(`user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const sessionIdRef = useRef("");
  const agentIdRef = useRef("");
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Agora refs
  const agoraEngineRef = useRef<any>(null);
  const localAudioTrackRef = useRef<any>(null);
  const remoteAudioTrackRef = useRef<any>(null);
  const callStartTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Transcript scroll ref
  const transcriptBottomRef = useRef<HTMLDivElement>(null);

  // ── Init AudioContext (lazy, on first interaction) ────────────────────
  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }, []);

  // ── Sound helpers ────────────────────────────────────────────────────
  const sound = useCallback((type: "beep" | "think" | "confirm" | "error") => {
    try {
      const ctx = getAudioCtx();
      if (type === "beep") playListeningBeep(ctx);
      else if (type === "think") playThinkingTone(ctx);
      else if (type === "confirm") playConfirmDing(ctx);
      else if (type === "error") playErrorTone(ctx);
    } catch {}
  }, [getAudioCtx]);

  // ── Auto-scroll transcript ──────────────────────────────────────────
  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, liveText]);

  // ── Join Agora channel ──────────────────────────────────────────────
  const joinChannel = useCallback(
    async (channel: string, token: string, uid: number, appId: string) => {
      if (!(window as any).AgoraRTC) {
        await new Promise<void>((resolve, reject) => {
          if (document.querySelector('script[src*="agora-rtc-sdk-ng"]')) {
            resolve();
            return;
          }
          const script = document.createElement("script");
          script.src = "https://download.agora.io/sdk/web/agora-rtc-sdk-ng.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Failed to load Agora RTC SDK"));
          document.head.appendChild(script);
        });
      }

      const AgoraRTC = (window as any).AgoraRTC;
      const client = AgoraRTC.createClient({ mode: "rtc", codec: "opus" });
      agoraEngineRef.current = client;

      // Remote audio: agent's voice
      client.on("user-published", async (user: any, mediaType: "audio") => {
        if (mediaType === "audio") {
          const track = await client.subscribe(user, "audio");
          remoteAudioTrackRef.current = track;

          // Route to Web Audio for visualization
          const ctx = getAudioCtx();
          const source = ctx.createMediaStreamSource(
            new MediaStream([track.getMediaStreamTrack()])
          );
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          source.connect(ctx.destination);
          track.play(); // plays agent audio to user
        }
      });

      client.on("user-unpublished", () => {
        remoteAudioTrackRef.current = null;
        setState("listening"); // agent stopped speaking, resume listening
      });

      await client.join(appId, channel, token, uid);

      // Local mic track — published immediately, stays open
      const localAudio = await AgoraRTC.createMicrophoneAudioTrack({
        AEC: true,  // Acoustic Echo Cancellation
        ANS: true,   // Automatic Noise Suppression
        AGC: true,   // Auto Gain Control
      });
      localAudioTrackRef.current = localAudio;
      await client.publish(localAudio);

      console.log(`[Voice] Connected — channel=${channel} uid=${uid}`);
    },
    [getAudioCtx]
  );

  // ── Start call ─────────────────────────────────────────────────────
  const startCall = useCallback(async () => {
    setState("connecting");
    setMessages([]);
    setLiveText("");
    setError(null);
    setTurnCount(0);

    // Unlock audio context on first interaction
    getAudioCtx();

    try {
      const res = await fetch("/api/session/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: userId.current }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create session");
      }

      const { channel, userToken, userUid, appId, agentId, sessionId, memoryUsed } =
        await res.json();

      sessionIdRef.current = sessionId || channel;
      agentIdRef.current = agentId;

      await joinChannel(channel, userToken, userUid, appId);

      setMemoryActive(!!memoryUsed);
      callStartTimeRef.current = Date.now();
      setState("listening");
      sound("beep");

      durationIntervalRef.current = setInterval(() => {
        const secs = Math.floor((Date.now() - callStartTimeRef.current) / 1000);
        setCallDuration(
          `${Math.floor(secs / 60).toString().padStart(2, "0")}:${(secs % 60)
            .toString()
            .padStart(2, "0")}`
        );
      }, 1000);
    } catch (err: any) {
      console.error("[Voice] Call error:", err);
      sound("error");
      setError(err.message || "Connection failed");
      setState("idle");
    }
  }, [joinChannel, getAudioCtx, sound]);

  // ── End call ───────────────────────────────────────────────────────
  const endCall = useCallback(async () => {
    setState("ending");

    if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);

    try {
      // Generate session summary before ending
      if (sessionIdRef.current) {
        fetch("/api/session/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: userId.current,
            sessionId: sessionIdRef.current,
          }),
        }).catch(() => {});
      }

      localAudioTrackRef.current?.stop();
      localAudioTrackRef.current?.close();
      await agoraEngineRef.current?.leave();
    } catch {}

    localAudioTrackRef.current = null;
    agoraEngineRef.current = null;
    remoteAudioTrackRef.current = null;

    sound("confirm");

    setTimeout(() => {
      setState("idle");
      setMessages([]);
      setLiveText("");
      setCallDuration("00:00");
      setTurnCount(0);
    }, 800);
  }, [sound]);

  // ── Quick reaction ───────────────────────────────────────────────────
  const sendReaction = useCallback(
    async (reaction: QuickReaction) => {
      setLastReaction(reaction);
      setTimeout(() => setLastReaction(null), 1500);

      // Send as agentThink to the server
      await fetch("/api/session/react", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agentIdRef.current,
          text:
            reaction.label === "Remember it"
              ? "Tolong ingatkan hal ini untuk masa depan."
              : reaction.label === "Say again"
              ? "Tolong ulangi刚才说的."
              : undefined,
        }),
      }).catch(() => {});
    },
    []
  );

  // ── Mute toggle ──────────────────────────────────────────────────────

  const toggleMute = useCallback(() => {
    if (localAudioTrackRef.current) {
      const nextMuted = !isMuted;
      localAudioTrackRef.current.setEnabled(!nextMuted);
      setIsMuted(nextMuted);
    }
  }, [isMuted]);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      localAudioTrackRef.current?.stop();
      agoraEngineRef.current?.leave();
      audioCtxRef.current?.close();
    };
  }, []);

  // ── State labels ────────────────────────────────────────────────────
  const stateLabel: Record<VoiceState, string> = {
    idle: "Tap to talk",
    connecting: "Connecting...",
    listening: "I'm listening...",
    thinking: "Hmm, let me think...",
    speaking: "Speaking...",
    ending: "Ending call...",
  };

  const stateEmoji: Record<VoiceState, string> = {
    idle: "🎙️",
    connecting: "📡",
    listening: "👂",
    thinking: "💭",
    speaking: "💬",
    ending: "✓",
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-[#080810] flex flex-col text-white overflow-hidden select-none">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div>
          <h1 className="text-sm font-semibold text-white/80 tracking-wide">
            Rafiq
          </h1>
          <p className="text-xs text-white/30 mt-0.5">
            {state === "idle" && "Always here for you"}
            {state === "connecting" && "Connecting..."}
            {state !== "idle" && state !== "connecting" && state !== "ending" && (
              <span className="flex items-center gap-1">
                <span className="text-green-400/60">●</span>
                {callDuration} · {turnCount} turns
              </span>
            )}
            {state === "ending" && "Call ended"}
          </p>
        </div>

        {state !== "idle" && state !== "ending" && (
          <button
            onClick={endCall}
            className="text-xs text-white/30 hover:text-white/60 transition-colors"
          >
            End
          </button>
        )}
      </header>

      {/* ── Conversation area ────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-3 max-h-[48vh]">

        {/* Empty state */}
        {messages.length === 0 && state === "idle" && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 pt-12">
            <div className="w-20 h-20 rounded-full bg-violet-500/10 flex items-center justify-center mb-2">
              <span className="text-4xl">🤖</span>
            </div>
            <p className="text-white/40 text-sm">Ready when you are</p>
            <p className="text-white/20 text-xs max-w-[240px]">
              Tap the button below and just talk — no buttons to press
            </p>
          </div>
        )}

        {/* Messages */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-in fade-in slide-in-from-bottom-2 duration-300`}
          >
            <div
              className={`max-w-[82%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-violet-600 text-white rounded-br-sm"
                  : "bg-white/8 text-white/90 rounded-bl-sm"
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[9px] opacity-40 uppercase tracking-widest font-medium">
                  {msg.role === "user" ? "You" : "Rafiq"}
                </span>
                {msg.memoryUsed && msg.role === "assistant" && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400/70">
                    context
                  </span>
                )}
              </div>
              <p className="text-sm leading-relaxed">{msg.text}</p>
              <p className="text-[9px] opacity-30 mt-1">
                {msg.timestamp.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
          </div>
        ))}

        {/* Live/typing indicator */}
        {liveText && (
          <div className="flex justify-start animate-in fade-in duration-200">
            <div className="max-w-[82%] rounded-2xl rounded-bl-sm bg-white/8 px-4 py-3">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[9px] opacity-40 uppercase tracking-widest font-medium">Rafiq</span>
                <Waveform active={true} color="violet-400" />
              </div>
              <p className="text-sm leading-relaxed text-white/80">
                {liveText}
                <span className="animate-pulse ml-0.5">▋</span>
              </p>
            </div>
          </div>
        )}

        <div ref={transcriptBottomRef} />
      </div>

      {/* ── Memory indicator ─────────────────────────────────────────── */}
      <div className="px-4">
        <MemoryIndicator visible={memoryActive} />
      </div>

      {/* ── Quick reactions (show after first response) ───────────────── */}
      {messages.length >= 2 && state === "listening" && (
        <div className="px-4 pb-2 flex gap-2 flex-wrap">
          {QUICK_REACTIONS.map((r) => (
            <button
              key={r.label}
              onClick={() => sendReaction(r)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/8 text-white/60 text-xs hover:bg-white/15 hover:text-white/80 transition-all active:scale-95"
            >
              <span>{r.emoji}</span>
              <span>{r.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Main interaction area ────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-4 pb-8 pt-3 px-4">

        {/* State label */}
        <p className="text-xs text-white/40 text-center min-h-[16px]">
          {stateLabel[state]}
        </p>

        {/* Last reaction */}
        {lastReaction && (
          <div className="text-xs text-white/50 animate-in fade-in duration-200">
            {lastReaction.emoji} {lastReaction.label}
          </div>
        )}

        {/* Main button — changes appearance based on state */}
        <button
          onClick={state === "idle" ? startCall : state === "listening" ? endCall : undefined}
          disabled={state === "connecting" || state === "thinking" || state === "speaking" || state === "ending"}
          className={`
            relative flex items-center justify-center rounded-full
            transition-all duration-300 active:scale-95
            ${state === "idle" ? "w-20 h-20 bg-violet-600 hover:bg-violet-500 shadow-2xl shadow-violet-900/40" : ""}
            ${state === "connecting" ? "w-20 h-20 bg-neutral-700 animate-pulse" : ""}
            ${state === "listening" ? "w-24 h-24 bg-violet-600 shadow-2xl shadow-violet-500/30" : ""}
            ${state === "thinking" || state === "speaking" ? "w-24 h-24 bg-violet-800" : ""}
            ${state === "ending" ? "w-20 h-20 bg-neutral-800" : ""}
          `}
        >
          {state === "idle" && (
            <span className="text-3xl">🎙️</span>
          )}
          {state === "connecting" && (
            <span className="text-3xl">📡</span>
          )}
          {(state === "listening" || state === "thinking" || state === "speaking") && (
            <div className="flex flex-col items-center justify-center">
              <Waveform active={true} />
              {state === "thinking" && (
                <span className="text-[9px] text-white/40 mt-1">thinking</span>
              )}
              {state === "speaking" && (
                <span className="text-[9px] text-white/40 mt-1">speaking</span>
              )}
            </div>
          )}
          {state === "ending" && (
            <span className="text-2xl text-white/50">✓</span>
          )}
        </button>

        {/* Sub-label */}
        <p className="text-[10px] text-white/20 text-center max-w-[200px]">
          {state === "idle" && "Hold to talk · Release to send"}
          {state === "listening" && "Tap end or just wait for silence"}
          {state === "thinking" && "Processing your request..."}
          {state === "speaking" && "Tap me anytime to interrupt"}
          {state === "connecting" && "Setting up your session"}
          {state === "ending" && ""}
        </p>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────── */}
      {error && (
        <div className="mx-4 mb-2 bg-red-900/40 border border-red-800/40 rounded-xl px-4 py-2.5 text-red-300 text-xs">
          {error}
        </div>
      )}
    </div>
  );
}
