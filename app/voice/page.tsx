"use client";

import { useState, useRef, useEffect, useCallback } from "react";

type CallState = "idle" | "calling" | "connected" | "ending";
type AiState = "idle" | "listening" | "thinking" | "speaking";
type SkillStatus = {
  name: string;
  status: "routing" | "executing" | "done";
  tools?: string[];
} | null;

interface TranscriptEntry {
  role: "user" | "ai";
  text: string;
  toolCalls?: { tool: string; args: Record<string, string> }[];
}

interface MemoryEvent {
  type: "recall" | "saved";
  count: number;
  preview?: string[];
}

const SESSION_KEY = "newme_session_id_v3";

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "guest";
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) return stored;
  const id = `user_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(SESSION_KEY, id);
  return id;
}

// ── Skill display names ──────────────────────────────────────────────────────
const SKILL_LABELS: Record<string, string> = {
  openclaw: "🧠 NewMe Brain",
  web_search: "🔍 Web Search",
  execute_code: "💻 Run Code",
  create_reminder: "⏰ Reminder",
  search_memory: "🧠 Memory",
  remember_fact: "💾 Save Memory",
  list_reminders: "📋 My Reminders",
};

const SKILL_COLORS: Record<string, string> = {
  openclaw: "from-violet-600 to-purple-600",
  web_search: "from-blue-600 to-cyan-600",
  execute_code: "from-green-600 to-emerald-600",
  create_reminder: "from-amber-500 to-orange-500",
  search_memory: "from-pink-500 to-rose-500",
  remember_fact: "from-teal-500 to-cyan-500",
  list_reminders: "from-yellow-500 to-amber-500",
};

export default function VoicePage() {
  const [callState, setCallState] = useState<CallState>("idle");
  const [aiState, setAiState] = useState<AiState>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveText, setLiveText] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ringCount, setRingCount] = useState(0);
  const [vadEnergy, setVadEnergy] = useState(0);
  const [memoryEvents, setMemoryEvents] = useState<MemoryEvent[]>([]);
  const [sessionId] = useState(getOrCreateSessionId);
  const [waveAmplitude, setWaveAmplitude] = useState(0);
  const [skillStatus, setSkillStatus] = useState<SkillStatus>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [proactiveSuggestion, setProactiveSuggestion] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const callStartTimeRef = useRef<number>(0);
  const ringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const isSpeakingRef = useRef<boolean>(false);
  const isAiSpeakingRef = useRef<boolean>(false);
  const isTTSPlayingRef = useRef<boolean>(false);
  const ttsChunkCountRef = useRef<number>(0);
  const waveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const waveBarsRef = useRef<HTMLDivElement>(null);

  // ── VAD Energy ─────────────────────────────────────────────────────────
  const getEnergy = useCallback(async (analyser: AnalyserNode, data: Uint8Array): Promise<number> => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const val = (data[i] - 128) / 128;
      sum += val * val;
    }
    return Math.sqrt(sum / data.length);
  }, []);

  // ── Wave animation ─────────────────────────────────────────────────────
  const startWaveAnimation = useCallback(() => {
    if (waveIntervalRef.current) return;
    waveIntervalRef.current = setInterval(() => {
      setWaveAmplitude((a) => {
        const target = isAiSpeakingRef.current ? Math.random() * 0.4 + 0.3 : 0;
        return a + (target - a) * 0.25;
      });
    }, 80);
  }, []);

  const stopWaveAnimation = useCallback(() => {
    if (waveIntervalRef.current) {
      clearInterval(waveIntervalRef.current);
      waveIntervalRef.current = null;
    }
    setWaveAmplitude(0);
  }, []);

  // ── WebSocket ─────────────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    const ws = new WebSocket(`wss://${window.location.host}/ws?userId=${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setCallState("connected");
      setError(null);
      callStartTimeRef.current = Date.now();
      startWaveAnimation();
      startContinuousAudio();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "transcript" && msg.text) {
        setTranscript((prev) => [...prev, { role: "user", text: msg.text }]);
      }
      else if (msg.type === "llm_word" && msg.text) {
        setLiveText((prev) => (prev ? prev + " " : "") + msg.text);
      }
      else if (msg.type === "llm_done") {
        // Append final message to transcript
        const finalText = msg.text || liveText;
        if (finalText) {
          setTranscript((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "ai" && !last.text) {
              return [...prev.slice(0, -1), { ...last, text: finalText }];
            }
            return [...prev, { role: "ai", text: finalText }];
          });
        }
        setLiveText("");
        setIsConfirming(msg.text?.includes("?") && !msg.text?.includes("lanjutkan"));
        setAiState("listening");
      }
      else if (msg.type === "tts_audio" && msg.data) {
        isTTSPlayingRef.current = true;
        isAiSpeakingRef.current = true;
        setAiState("speaking");
        ttsChunkCountRef.current++;
        if (streamRef.current) streamRef.current.getTracks().forEach((t) => (t.enabled = false));
        playMp3Data(msg.data).catch(console.error);
      }
      else if (msg.type === "tts_chunk_start") {
        // Chunk boundary indicator
        console.log(`[TTS] chunk ${msg.index + 1}/${msg.total}: "${msg.text.substring(0, 30)}..."`);
      }
      else if (msg.type === "memory_recall") {
        setMemoryEvents((prev) => [
          ...prev.slice(-4),
          { type: "recall", count: msg.count, preview: msg.preview || [] }
        ]);
        setTimeout(() => setMemoryEvents((prev) => prev.filter((e) => !(e.type === "recall" && e.count === msg.count))), 3500);
      }
      else if (msg.type === "memory_saved") {
        setMemoryEvents((prev) => [
          ...prev.slice(-4),
          { type: "saved", count: msg.count }
        ]);
        setTimeout(() => setMemoryEvents((prev) => prev.filter((e) => !(e.type === "saved" && e.count === msg.count))), 3500);
      }
      else if (msg.type === "proactive" && msg.text) {
        setProactiveSuggestion(msg.text);
        setTimeout(() => setProactiveSuggestion(null), 6000);
      }
      else if (msg.type === "skill_status") {
        setSkillStatus({ name: msg.name, status: msg.status, tools: msg.tools });
        setTimeout(() => setSkillStatus(null), 4000);
      }
      else if (msg.type === "error") {
        setError(msg.message);
        setAiState("listening");
      }
    };

    ws.onerror = () => setError("Connection error");
    ws.onclose = () => {
      if (callState !== "ending") setCallState("idle");
      stopContinuousAudio();
      stopWaveAnimation();
    };
  }, [sessionId, startWaveAnimation, stopWaveAnimation, callState, liveText]);

  // ── TTS playback ──────────────────────────────────────────────────────
  const finishTTSTurn = useCallback(() => {
    ttsChunkCountRef.current = Math.max(0, ttsChunkCountRef.current - 1);
    isTTSPlayingRef.current = ttsChunkCountRef.current > 0;
    if (!isTTSPlayingRef.current) {
      isAiSpeakingRef.current = false;
      isTTSPlayingRef.current = false;
      setAiState("listening");
      setTimeout(() => {
        if (!isTTSPlayingRef.current && streamRef.current) {
          streamRef.current.getTracks().forEach((t) => (t.enabled = true));
        }
      }, 400);
    }
  }, []);

  const playMp3Data = useCallback(async (base64Data: string) => {
    try {
      const binary = atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      let audioCtx = audioContextRef.current;
      if (!audioCtx) {
        audioCtx = new AudioContext();
        audioContextRef.current = audioCtx;
      }
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.onended = () => finishTTSTurn();
      source.onerror = () => finishTTSTurn();
      source.start(0);
    } catch (e) {
      console.error("[TTS]", e);
      finishTTSTurn();
    }
  }, [finishTTSTurn]);

  // ── Audio + VAD ────────────────────────────────────────────────────────
  const startContinuousAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
      streamRef.current = stream;
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        audioChunksRef.current = [];
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        wsRef.current?.send(JSON.stringify({ type: "audio_chunk", data: btoa(binary) }));
        setAiState("thinking");
      };

      recorder.start(100);

      const buffer = new Uint8Array(analyser.fftSize);
      let silenceFrames = 0;

      vadIntervalRef.current = setInterval(async () => {
        if (isMuted) return;
        if (isTTSPlayingRef.current || isAiSpeakingRef.current) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;

        const energy = await getEnergy(analyser, buffer);
        setVadEnergy(Math.min(1, energy / 0.1));

        if (energy >= 0.02) {
          isSpeakingRef.current = true;
          silenceFrames = 0;
        } else if (isSpeakingRef.current) {
          silenceFrames++;
          if (silenceFrames >= 8) {
            isSpeakingRef.current = false;
            silenceFrames = 0;
            if (recorder.state === "recording") {
              recorder.stop();
              setTimeout(() => recorder.start(100), 150);
            }
          }
        }
      }, 100);
    } catch (err: any) {
      setError("Microphone access denied. Please allow microphone access.");
    }
  }, [isMuted, getEnergy]);

  const stopContinuousAudio = useCallback(() => {
    if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
    try {
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      audioContextRef.current?.close();
    } catch {}
    setVadEnergy(0);
  }, []);

  // ── Call controls ─────────────────────────────────────────────────────
  const startCall = () => {
    setCallState("calling");
    setTranscript([]);
    setLiveText("");
    setError(null);
    setMemoryEvents([]);
    setSkillStatus(null);
    setRingCount(0);
    ringIntervalRef.current = setInterval(() => setRingCount((r) => r + 1), 1000);
    setTimeout(() => {
      if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
      connectWS();
    }, 2200);
  };

  const endCall = () => {
    setCallState("ending");
    if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
    wsRef.current?.close();
    stopContinuousAudio();
    stopWaveAnimation();
    setTimeout(() => {
      setCallState("idle");
      setAiState("idle");
      setTranscript([]);
      setSkillStatus(null);
    }, 600);
  };

  // ── Cleanup ───────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearInterval(ringIntervalRef.current!);
      clearInterval(vadIntervalRef.current!);
      clearInterval(waveIntervalRef.current!);
      stopContinuousAudio();
      wsRef.current?.close();
    };
  }, [stopContinuousAudio, stopWaveAnimation]);

  // ── Duration ───────────────────────────────────────────────────────────
  const [callDuration, setCallDuration] = useState("00:00");
  useEffect(() => {
    if (callState !== "connected") return;
    const iv = setInterval(() => {
      const secs = Math.floor((Date.now() - callStartTimeRef.current) / 1000);
      setCallDuration(`${Math.floor(secs / 60).toString().padStart(2, "0")}:${(secs % 60).toString().padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(iv);
  }, [callState]);

  // ── Wave bars animation ───────────────────────────────────────────────
  const waveBars = [0.3, 0.7, 1, 0.5, 0.8, 0.4, 0.9, 0.6, 1, 0.5];

  return (
    <div className="min-h-screen w-full bg-[#0a0a14] flex flex-col text-white overflow-hidden select-none font-sans">

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div>
          <h1 className="text-base font-semibold text-white/90 flex items-center gap-2">
            NewMe
            {skillStatus && (
              <span className={`text-xs px-2 py-0.5 rounded-full bg-gradient-to-r ${SKILL_COLORS[skillStatus.name] || "from-gray-600 to-gray-600"} font-medium`}>
                {SKILL_LABELS[skillStatus.name] || skillStatus.name}
              </span>
            )}
          </h1>
          <p className="text-xs text-white/40 mt-0.5">
            {callState === "idle" && "Tap to start"}
            {callState === "calling" && `Dialing${".".repeat((ringCount % 3) + 1)}`}
            {callState === "connected" && `Connected · ${callDuration}`}
            {callState === "ending" && "Call ended"}
          </p>
        </div>

        {/* Live indicator */}
        {callState === "connected" && (
          <div className="flex items-center gap-2">
            {skillStatus?.status === "routing" && (
              <span className="text-xs text-blue-400 animate-pulse">Routing...</span>
            )}
            {skillStatus?.status === "executing" && (
              <span className="text-xs text-amber-400 animate-pulse">Running...</span>
            )}
            <div className={`w-2 h-2 rounded-full ${aiState === "speaking" ? "bg-violet-400" : "bg-green-400"} ${aiState === "speaking" ? "animate-pulse" : ""}`} />
          </div>
        )}
      </div>

      {/* Skill status bar */}
      {skillStatus && (
        <div className={`px-5 py-2 bg-gradient-to-r ${SKILL_COLORS[skillStatus.name] || "from-gray-700 to-gray-700"} text-xs flex items-center gap-3`}>
          <span className="font-semibold">{SKILL_LABELS[skillStatus.name] || skillStatus.name}</span>
          {skillStatus.status === "routing" && <span className="opacity-80">Menghubungi...</span>}
          {skillStatus.status === "executing" && <span className="opacity-80">Mengeksekusi skill...</span>}
          {skillStatus.status === "done" && skillStatus.tools && (
            <span className="opacity-80">Tools used: {skillStatus.tools.join(", ")}</span>
          )}
          {skillStatus.status === "done" && !skillStatus.tools && <span className="opacity-80">Selesai</span>}
        </div>
      )}

      {/* Memory events */}
      <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 flex flex-col gap-1.5 pointer-events-none w-full max-w-sm px-4">
        {memoryEvents.map((e, i) => (
          <div
            key={i}
            className={`text-xs px-3 py-1.5 rounded-full backdrop-blur-sm border text-center ${
              e.type === "recall"
                ? "bg-violet-900/60 border-violet-500/30 text-violet-200"
                : "bg-green-900/60 border-green-500/30 text-green-200"
            }`}
          >
            {e.type === "recall" ? `🧠 Remembering (${e.count} facts)` : `💾 Saved to memory (${e.count})`}
          </div>
        ))}
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 max-h-[55vh]">
        {transcript.length === 0 && callState === "idle" && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4 animate-pulse">
              <span className="text-3xl">👋</span>
            </div>
            <p className="text-white/30 text-sm">NewMe is ready to help</p>
            <p className="text-white/15 text-xs mt-1">She remembers things between calls</p>
          </div>
        )}

        {transcript.map((entry, i) => (
          <div key={i} className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
              entry.role === "user"
                ? "bg-violet-600 text-white rounded-br-md"
                : "bg-white/8 text-white/90 rounded-bl-md"
            }`}>
              <span className="text-[10px] opacity-50 uppercase tracking-wider block mb-1">
                {entry.role === "user" ? "You" : "NewMe"}
              </span>
              {entry.text}
              {entry.toolCalls && entry.toolCalls.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {entry.toolCalls.map((tc, j) => (
                    <span key={j} className={`text-[9px] px-1.5 py-0.5 rounded-full bg-gradient-to-r ${SKILL_COLORS[tc.tool] || "from-gray-600 to-gray-600"} font-medium`}>
                      {SKILL_LABELS[tc.tool] || tc.tool}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {liveText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white/8 px-4 py-3 text-sm text-white/90">
              <span className="text-[10px] opacity-50 uppercase tracking-wider block mb-1">NewMe</span>
              {liveText}<span className="animate-pulse opacity-70"> ▋</span>
            </div>
          </div>
        )}

        {/* Thinking dots */}
        {aiState === "thinking" && !liveText && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-white/8 px-4 py-3">
              <span className="text-xs text-white/50">NewMe is thinking...</span>
              <div className="flex gap-1 mt-2">
                {[0, 1, 2].map((k) => (
                  <div key={k} className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: `${k * 150}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* VAD bar */}
      {callState === "connected" && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/20 uppercase tracking-wider">Voice</span>
            <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-green-400 to-violet-500 transition-all duration-75"
                style={{ width: `${vadEnergy * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-4 mb-2 bg-red-900/40 border border-red-800/50 rounded-xl px-4 py-2.5 text-red-300 text-xs">
          {error}
        </div>
      )}

      {/* Proactive suggestion */}
      {proactiveSuggestion && (
        <div className="mx-4 mb-2 bg-violet-900/40 border border-violet-600/40 rounded-xl px-4 py-2.5 text-violet-200 text-xs flex items-start gap-2">
          <span className="text-base">💡</span>
          <div>
            <span className="font-semibold block mb-0.5">NewMe</span>
            <span>{proactiveSuggestion}</span>
          </div>
        </div>
      )}

      {/* Confirmation hint */}
      {isConfirming && callState === "connected" && (
        <div className="mx-4 mb-2 bg-amber-900/30 border border-amber-700/40 rounded-xl px-4 py-2 text-amber-300 text-xs flex items-center gap-2">
          <span>🤔</span>
          <span>NewMe is asking for confirmation. Say "ya" or " lanjutkan" to proceed.</span>
        </div>
      )}

      {/* Controls */}
      <div className="px-5 pb-8 pt-2 flex flex-col items-center gap-4">

        {/* Status label */}
        {callState === "idle" && (
          <p className="text-[10px] text-white/15">Session: {sessionId}</p>
        )}

        {callState === "connected" && (
          <p className="text-xs text-white/40 text-center min-h-[20px]">
            {isMuted ? "🎤 Unmute to speak" :
             aiState === "speaking" ? "🔊 NewMe is talking..." :
             aiState === "thinking" ? "💭 Processing..." :
             "Speak naturally"}
          </p>
        )}

        {/* Idle — call button */}
        {callState === "idle" && (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={startCall}
              className="w-20 h-20 rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all flex items-center justify-center shadow-2xl shadow-violet-900/30"
            >
              <span className="text-3xl">📞</span>
            </button>
            <button
              onClick={async () => {
                try {
                  const res = await fetch("/test_audio");
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  new Audio(url).play();
                } catch (e: any) { alert("Audio test failed: " + e.message); }
              }}
              className="text-xs text-white/30 hover:text-white/60 transition-colors"
            >
              🔊 Test voice
            </button>
          </div>
        )}

        {/* Calling */}
        {callState === "calling" && (
          <div className="w-20 h-20 rounded-full bg-neutral-800 flex items-center justify-center animate-pulse">
            <span className="text-3xl">📡</span>
          </div>
        )}

        {/* Connected */}
        {callState === "connected" && (
          <div className="flex items-center gap-10">

            {/* Mute */}
            <button
              onClick={() => setIsMuted(!isMuted)}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                isMuted ? "bg-red-900/40 text-red-300" : "bg-white/10 text-white/60"
              }`}
            >
              <span className="text-xl">{isMuted ? "🔇" : "🎤"}</span>
            </button>

            {/* Central button with wave */}
            <div className="relative flex flex-col items-center">
              {/* Wave rings */}
              {waveAmplitude > 0 && (
                <>
                  <div className="absolute inset-0 rounded-full border border-violet-400/20" style={{ transform: `scale(${1 + waveAmplitude * 1.5})`, opacity: waveAmplitude * 0.4 }} />
                  <div className="absolute inset-0 rounded-full border border-violet-400/25" style={{ transform: `scale(${1 + waveAmplitude * 1.2})`, opacity: waveAmplitude * 0.25 }} />
                </>
              )}

              {/* Animated wave bars */}
              {waveAmplitude > 0 && (
                <div className="flex items-end gap-0.5 h-4 mb-1" ref={waveBarsRef}>
                  {waveBars.map((baseH, k) => (
                    <div
                      key={k}
                      className="w-1 rounded-full bg-violet-400/60"
                      style={{
                        height: `${Math.max(4, baseH * 16 * waveAmplitude + 4)}px`,
                        animation: `wave-bounce ${0.3 + k * 0.05}s ease-in-out infinite alternate`,
                        animationDelay: `${k * 50}ms`,
                      }}
                    />
                  ))}
                </div>
              )}

              <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-xl ${
                isMuted ? "bg-gray-700" :
                aiState === "speaking" ? "bg-violet-700" :
                "bg-violet-600"
              }`}>
                <span className="text-2xl">🎤</span>
              </div>
            </div>

            {/* End call */}
            <button
              onClick={endCall}
              className="w-12 h-12 rounded-full flex items-center justify-center transition-all bg-white/10 hover:bg-white/20"
            >
              <span className="text-xl">📴</span>
            </button>
          </div>
        )}

        {/* Ending */}
        {callState === "ending" && (
          <div className="w-20 h-20 rounded-full bg-neutral-800 flex items-center justify-center">
            <span className="text-3xl">✓</span>
          </div>
        )}
      </div>

      {/* Wave animation keyframes */}
      <style>{`
        @keyframes wave-bounce {
          from { transform: scaleY(0.5); }
          to { transform: scaleY(1.2); }
        }
      `}</style>
    </div>
  );
}
