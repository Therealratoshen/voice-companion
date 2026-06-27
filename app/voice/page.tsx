"use client";

import { useState, useRef, useEffect, useCallback } from "react";

type CallState = "idle" | "calling" | "connected" | "ending";
type AiState = "idle" | "listening" | "thinking" | "speaking";

interface TranscriptEntry {
  role: "user" | "ai";
  text: string;
}

interface MemoryEvent {
  type: "recall" | "saved";
  count: number;
  preview?: string[];
}

const SESSION_KEY = "rina_session_id";

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "guest";
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) return stored;
  const id = `user_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(SESSION_KEY, id);
  return id;
}

export default function VoicePage() {
  const [callState, setCallState] = useState<CallState>("idle");
  const [aiState, setAiState] = useState<AiState>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveText, setLiveText] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ringCount, setRingCount] = useState(0);
  const [vadEnergy, setVadEnergy] = useState(0); // 0-1 normalized energy
  const [memoryEvents, setMemoryEvents] = useState<MemoryEvent[]>([]);
  const [sessionId] = useState(getOrCreateSessionId);
  const [waveAmplitude, setWaveAmplitude] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const callStartTimeRef = useRef<number>(0);
  const ringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const lastSpeechRef = useRef<number>(0);
  const isSpeakingRef = useRef<boolean>(false);
  const isAiSpeakingRef = useRef<boolean>(false);
  const isTTSPlayingRef = useRef<boolean>(false);
  const ttsChunkCountRef = useRef<number>(0);
  const waveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Energy-based VAD ─────────────────────────────────────────────────────
  const getEnergy = useCallback(async (analyser: AnalyserNode, data: Uint8Array): Promise<number> => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const val = (data[i] - 128) / 128;
      sum += val * val;
    }
    return Math.sqrt(sum / data.length);
  }, []);

  // ── Wave animation for AI speaking ──────────────────────────────────────
  const startWaveAnimation = useCallback(() => {
    if (waveIntervalRef.current) return;
    waveIntervalRef.current = setInterval(() => {
      setWaveAmplitude((a) => {
        const target = isAiSpeakingRef.current ? Math.random() * 0.4 + 0.3 : 0;
        return a + (target - a) * 0.3;
      });
    }, 100);
  }, []);

  const stopWaveAnimation = useCallback(() => {
    if (waveIntervalRef.current) {
      clearInterval(waveIntervalRef.current);
      waveIntervalRef.current = null;
    }
    setWaveAmplitude(0);
  }, []);

  // ── Connect WebSocket ────────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    const WS_URL = `wss://${window.location.host}/ws?userId=${sessionId}`;
    const ws = new WebSocket(WS_URL);
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
      else if (msg.type === "llm_word") {
        setLiveText((prev) => (prev ? prev + " " : "") + msg.text);
      }
      else if (msg.type === "llm_done") {
        setTranscript((prev) => [...prev, { role: "ai", text: msg.text }]);
        setLiveText("");
        setAiState("listening");
      }
      else if (msg.type === "tts_audio" && msg.data) {
        isTTSPlayingRef.current = true;
        isAiSpeakingRef.current = true;
        setAiState("speaking");
        ttsChunkCountRef.current++;
        // Mute mic while AI speaks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.enabled = false);
        }
        playMp3Data(msg.data);
      }
      else if (msg.type === "tts_fallback" && msg.text) {
        isTTSPlayingRef.current = true;
        isAiSpeakingRef.current = true;
        setAiState("speaking");
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = false);
        const utterance = new SpeechSynthesisUtterance(msg.text);
        utterance.rate = 1.1;
        utterance.onend = () => finishTTSTurn();
        utterance.onerror = () => finishTTSTurn();
        speechSynthesis.speak(utterance);
      }
      else if (msg.type === "memory_recall") {
        setMemoryEvents((prev) => [
          ...prev.slice(-4),
          { type: "recall", count: msg.count, preview: msg.preview || [] }
        ]);
        setTimeout(() => {
          setMemoryEvents((prev) => prev.filter(e => !(e.type === "recall" && e.count === msg.count)));
        }, 3000);
      }
      else if (msg.type === "memory_saved") {
        setMemoryEvents((prev) => [
          ...prev.slice(-4),
          { type: "saved", count: msg.count }
        ]);
        setTimeout(() => {
          setMemoryEvents((prev) => prev.filter(e => !(e.type === "saved" && e.count === msg.count)));
        }, 3000);
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
  }, [sessionId, startWaveAnimation, stopWaveAnimation, callState]);

  // ── MP3 playback ──────────────────────────────────────────────────────────
  const finishTTSTurn = () => {
    ttsChunkCountRef.current = Math.max(0, ttsChunkCountRef.current - 1);
    isTTSPlayingRef.current = ttsChunkCountRef.current > 0;
    if (!isTTSPlayingRef.current) {
      isAiSpeakingRef.current = false;
      isTTSPlayingRef.current = false;
      setAiState("listening");
      // Wait for OS audio buffer to drain
      setTimeout(() => {
        if (!isTTSPlayingRef.current && streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.enabled = true);
        }
      }, 400);
    }
  };

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
      console.error("[playMp3Data]", e);
      finishTTSTurn();
    }
  }, []);

  // ── Continuous audio + VAD ────────────────────────────────────────────────
  const startContinuousAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
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
      const SILENCE_THRESHOLD = 8;

      vadIntervalRef.current = setInterval(async () => {
        if (isMuted) return;
        if (isTTSPlayingRef.current || isAiSpeakingRef.current) return;
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;

        const energy = await getEnergy(analyser, buffer);
        setVadEnergy(Math.min(1, energy / 0.1)); // normalize to 0-1

        const isSilent = energy < 0.02;

        if (!isSilent) {
          isSpeakingRef.current = true;
          lastSpeechRef.current = Date.now();
          silenceFrames = 0;
        } else {
          if (isSpeakingRef.current) {
            silenceFrames++;
            if (silenceFrames >= SILENCE_THRESHOLD) {
              isSpeakingRef.current = false;
              silenceFrames = 0;
              if (recorder.state === "recording") {
                recorder.stop();
                setTimeout(() => recorder.start(100), 150);
              }
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

  // ── Start / End call ─────────────────────────────────────────────────────
  const startCall = () => {
    setCallState("calling");
    setTranscript([]);
    setLiveText("");
    setError(null);
    setMemoryEvents([]);
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
    }, 600);
  };

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
      if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
      if (waveIntervalRef.current) clearInterval(waveIntervalRef.current);
      stopContinuousAudio();
      wsRef.current?.close();
    };
  }, [stopContinuousAudio, stopWaveAnimation]);

  // ── Call duration ─────────────────────────────────────────────────────────
  const [callDuration, setCallDuration] = useState("00:00");
  useEffect(() => {
    if (callState !== "connected") return;
    const interval = setInterval(() => {
      const secs = Math.floor((Date.now() - callStartTimeRef.current) / 1000);
      setCallDuration(`${Math.floor(secs / 60).toString().padStart(2, "0")}:${(secs % 60).toString().padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [callState]);

  // ── AI state display ─────────────────────────────────────────────────────
  const aiStateLabel = {
    idle: "",
    listening: "🎤 Listening...",
    thinking: "💭 Thinking...",
    speaking: "🔊 Speaking...",
  }[aiState];

  // ── UI ─────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-[#0a0a14] flex flex-col text-white overflow-hidden select-none font-sans">

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div>
          <h1 className="text-base font-semibold text-white/90">Rina</h1>
          <p className="text-xs text-white/40 mt-0.5">
            {callState === "idle" && "Tap to start a call"}
            {callState === "calling" && `Dialing${".".repeat((ringCount % 3) + 1)}`}
            {callState === "connected" && `Connected · ${callDuration}`}
            {callState === "ending" && "Call ended"}
          </p>
        </div>
        {callState === "connected" && (
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${aiState === "speaking" ? "bg-violet-400" : "bg-green-400"} animate-pulse`} />
            <span className={`text-xs ${aiState === "speaking" ? "text-violet-400" : "text-green-400"}`}>
              {aiState === "speaking" ? "Rina speaking" : "Live"}
            </span>
          </div>
        )}
      </div>

      {/* Memory events (floating toast) */}
      <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 flex flex-col gap-1.5 pointer-events-none">
        {memoryEvents.map((e, i) => (
          <div
            key={i}
            className={`text-xs px-3 py-1.5 rounded-full backdrop-blur-sm border animate-fade-in ${
              e.type === "recall"
                ? "bg-violet-900/60 border-violet-500/30 text-violet-200"
                : "bg-green-900/60 border-green-500/30 text-green-200"
            }`}
          >
            {e.type === "recall" ? `🧠 Memory recall (${e.count})` : `💾 Saved to memory (${e.count})`}
          </div>
        ))}
      </div>

      {/* Transcript area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 max-h-[55vh]">
        {transcript.length === 0 && callState === "idle" && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="relative mb-5">
              {/* VAD ring preview — subtle pulse on idle */}
              <div className={`w-16 h-16 rounded-full bg-white/5 flex items-center justify-center ${callState === "idle" ? "animate-pulse" : ""}`}>
                <span className="text-3xl">👋</span>
              </div>
            </div>
            <p className="text-white/30 text-sm">Your conversation with Rina will appear here</p>
            <p className="text-white/15 text-xs mt-1">Rina remembers things between calls</p>
          </div>
        )}

        {transcript.map((entry, i) => (
          <div key={i} className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                entry.role === "user"
                  ? "bg-violet-600 text-white rounded-br-md"
                  : "bg-white/8 text-white/90 rounded-bl-md"
              }`}
            >
              <span className="text-[10px] opacity-50 uppercase tracking-wider block mb-1">
                {entry.role === "user" ? "You" : "Rina"}
              </span>
              {entry.text}
            </div>
          </div>
        ))}

        {liveText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white/8 px-4 py-3 text-sm text-white/90">
              <span className="text-[10px] opacity-50 uppercase tracking-wider block mb-1">Rina</span>
              {liveText}<span className="animate-pulse opacity-70"> ▋</span>
            </div>
          </div>
        )}

        {/* Thinking indicator */}
        {aiState === "thinking" && !liveText && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-white/8 px-4 py-3 text-sm text-white/50">
              <span className="text-xs">Rina is thinking...</span>
              <div className="flex gap-1 mt-2">
                {[0, 1, 2].map(i => (
                  <div key={i} className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* VAD Energy Bar */}
      {callState === "connected" && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/20 uppercase tracking-wider">Voice</span>
            <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-green-400 to-violet-500 transition-all duration-100"
                style={{ width: `${vadEnergy * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mx-4 mb-2 bg-red-900/40 border border-red-800/50 rounded-xl px-4 py-2.5 text-red-300 text-xs">
          {error}
        </div>
      )}

      {/* Bottom controls */}
      <div className="px-5 pb-8 pt-2 flex flex-col items-center gap-5">

        {/* Session ID (subtle) */}
        {callState === "idle" && (
          <p className="text-[10px] text-white/15">Session: {sessionId}</p>
        )}

        {/* AI state label */}
        {callState === "connected" && aiStateLabel && (
          <p className="text-xs text-white/40">{aiStateLabel}</p>
        )}

        {/* Call button */}
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
                  const audio = new Audio(url);
                  audio.play();
                  audio.onended = () => URL.revokeObjectURL(url);
                } catch (e: any) { alert("Audio test failed: " + e.message); }
              }}
              className="text-xs text-white/30 hover:text-white/60 transition-colors"
            >
              🔊 Test voice
            </button>
          </div>
        )}

        {callState === "calling" && (
          <div className="w-20 h-20 rounded-full bg-neutral-800 flex items-center justify-center animate-pulse">
            <span className="text-3xl">📡</span>
          </div>
        )}

        {/* Connected — main interaction area */}
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

            {/* Central mic with wave animation */}
            <div className="relative flex flex-col items-center">
              {/* Wave rings (visible when AI is speaking) */}
              {waveAmplitude > 0 && (
                <>
                  <div className="absolute inset-0 rounded-full border border-violet-400/20 animate-ping" style={{ transform: `scale(${1 + waveAmplitude * 1.5})`, opacity: waveAmplitude * 0.5 }} />
                  <div className="absolute inset-0 rounded-full border border-violet-400/30" style={{ transform: `scale(${1 + waveAmplitude * 1.2})`, opacity: waveAmplitude * 0.3 }} />
                </>
              )}

              <div
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-xl ${
                  isMuted
                    ? "bg-gray-700"
                    : aiState === "speaking"
                    ? "bg-violet-700"
                    : aiState === "thinking"
                    ? "bg-violet-600"
                    : "bg-violet-600"
                }`}
              >
                <span className="text-2xl">🎤</span>
              </div>

              {/* Wave bars (animated when AI speaks) */}
              {waveAmplitude > 0 && (
                <div className="flex items-end gap-0.5 h-3 mt-1">
                  {[0.3, 0.7, 1, 0.5, 0.8, 0.4, 0.9].map((h, i) => (
                    <div
                      key={i}
                      className="w-1 bg-violet-400/60 rounded-full"
                      style={{ height: `${h * 16 * waveAmplitude + 4}px`, animationDelay: `${i * 50}ms` }}
                    />
                  ))}
                </div>
              )}
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

        {callState === "ending" && (
          <div className="w-20 h-20 rounded-full bg-neutral-800 flex items-center justify-center">
            <span className="text-3xl">✓</span>
          </div>
        )}

        <p className="text-white/20 text-[11px] text-center min-h-[16px]">
          {callState === "idle" && "Tap to call Rina"}
          {callState === "calling" && "Connecting..."}
          {callState === "connected" && (
            isMuted
              ? "Unmute to speak"
              : aiState === "speaking"
              ? "Rina is talking — she'll listen after"
              : aiState === "thinking"
              ? "Processing..."
              : "Speak naturally"
          )}
          {callState === "ending" && "Call ended"}
        </p>
      </div>
    </div>
  );
}
