"use client";

import { useState, useRef, useEffect, useCallback } from "react";

type CallState = "idle" | "calling" | "connected" | "ending";

interface TranscriptEntry {
  role: "user" | "ai";
  text: string;
}

export default function VoicePage() {
  const [callState, setCallState] = useState<CallState>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [liveText, setLiveText] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ringCount, setRingCount] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioReady, setAudioReady] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const callStartTimeRef = useRef<number>(0);
  const ringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const lastSpeechRef = useRef<number>(0);
  const isSpeakingRef = useRef<boolean>(false);
  const isTTSPlayingRef = useRef<boolean>(false);
  const isAiSpeakingRef = useRef<boolean>(false);
  const ttsChunkCountRef = useRef<number>(0); // tracks in-flight TTS chunks
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Energy-based VAD ─────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getEnergy = useCallback(async (analyser: AnalyserNode, data: any): Promise<number> => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const val = (data[i] - 128) / 128;
      sum += val * val;
    }
    return Math.sqrt(sum / data.length);
  }, []);

  // ── Connect WebSocket ────────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    const WS_URL = `wss://${window.location.host}/ws`;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setCallState("connected");
      setError(null);
      callStartTimeRef.current = Date.now();
      setAudioReady(false);
      startContinuousAudio();
      // Unlock Web Audio API by playing silence once (required by browser autoplay policy)
      setTimeout(() => unlockAudioContext(), 500);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "transcript" && msg.text) {
        setTranscript((prev) => [...prev, { role: "user", text: msg.text }]);
      } else if (msg.type === "llm_word") {
        setLiveText((prev) => (prev ? prev + " " : "") + msg.text);
      } else if (msg.type === "llm_done") {
        setTranscript((prev) => [...prev, { role: "ai", text: msg.text }]);
        setLiveText("");
        setIsProcessing(false);
        // Don't unmute yet — wait for TTS to finish (isTTSPlayingRef handles this)
      } else if (msg.type === "tts_audio" && msg.data) {
        isTTSPlayingRef.current = true;
        isAiSpeakingRef.current = true;
        ttsChunkCountRef.current++;
        // Mute our mic while AI is speaking to prevent feedback
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.enabled = false);
        }
        try {
          if (msg.mimeType === "audio/mpeg") {
            playMp3Data(msg.data);
          } else {
            playAudioData(msg.data);
          }
        } catch (e: any) {
          console.error("TTS audio play error:", e);
          isTTSPlayingRef.current = false;
          isAiSpeakingRef.current = false;
          ttsChunkCountRef.current = 0;
          if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = true);
        }
      } else if (msg.type === "tts_fallback" && msg.text) {
        isTTSPlayingRef.current = true;
        isAiSpeakingRef.current = true;
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.enabled = false);
        }
        const utterance = new SpeechSynthesisUtterance(msg.text);
        utterance.rate = 1.1;
        utterance.onend = () => {
          isTTSPlayingRef.current = false;
          isAiSpeakingRef.current = false;
          setTimeout(() => {
            if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = true);
          }, 300);
        };
        utterance.onerror = () => {
          isTTSPlayingRef.current = false;
          isAiSpeakingRef.current = false;
          if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = true);
        };
        speechSynthesis.speak(utterance);
      } else if (msg.type === "error") {
        setError(msg.message);
        setIsProcessing(false);
      }
    };

    ws.onerror = () => {
      setError("Connection error");
      setIsProcessing(false);
    };
    ws.onclose = () => {
      if (callState !== "ending") setCallState("idle");
      stopContinuousAudio();
    };
  }, [callState]);


  // ── MP3 playback via browser decodeAudioData ──────────────────────────
  const playMp3Data = useCallback(async (base64Data: string) => {
    console.log("[playMp3Data] START, data length:", base64Data.length);
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
      console.log("[playMp3Data] decoded OK, duration:", audioBuffer.duration.toFixed(2));
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.onended = () => {
        console.log("[playMp3Data] done, remaining chunks:", ttsChunkCountRef.current - 1);
        ttsChunkCountRef.current = Math.max(0, ttsChunkCountRef.current - 1);
        isTTSPlayingRef.current = ttsChunkCountRef.current > 0;
        if (ttsChunkCountRef.current === 0) {
          isAiSpeakingRef.current = false;
          isTTSPlayingRef.current = false;
          // Wait 400ms after last chunk ends — ensures OS audio buffer drains before mic unmuted
          setTimeout(() => {
            if (ttsChunkCountRef.current === 0) {
              isAiSpeakingRef.current = false;
              isTTSPlayingRef.current = false;
              if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = true);
            }
          }, 400);
        }
      };
      // @ts-ignore — AudioBufferSourceNode has no onerror in TS but fires error events at runtime
      source.onerror = (e: Event) => {
        console.error("[playMp3Data] source error:", e);
        ttsChunkCountRef.current = Math.max(0, ttsChunkCountRef.current - 1);
        if (ttsChunkCountRef.current === 0) {
          isTTSPlayingRef.current = false;
          isAiSpeakingRef.current = false;
          if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = true);
        }
      };
      source.start(0);
    } catch (e: any) {
      console.error("[playMp3Data] ERROR:", e?.message || e, "name:", e?.name, "code:", e?.code);
      ttsChunkCountRef.current = Math.max(0, ttsChunkCountRef.current - 1);
      if (ttsChunkCountRef.current === 0) {
        isTTSPlayingRef.current = false;
        isAiSpeakingRef.current = false;
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = true);
      }
    }
  }, []);

  // ── Web Audio API playback (WAV format) ──────────────────────────────
  const playAudioData = useCallback(async (base64Data: string) => {
    console.log("[playAudioData] called, data length:", base64Data.length);
    try {
      const binary = atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // Server sends clean WAV (LIST chunks stripped) — pass directly to decoder
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      console.log("[playAudioData] arrayBuffer size:", arrayBuffer.byteLength);
      console.log("[playAudioData] WAV header:", (bytes.slice(0,4) as unknown as {toString:(s:string)=>string}).toString('hex'), (bytes.slice(8,12) as unknown as {toString:(s:string)=>string}).toString('hex'));

      let audioCtx = audioContextRef.current;
      if (!audioCtx) {
        audioCtx = new AudioContext();
        audioContextRef.current = audioCtx;
        console.log("[playAudioData] created new AudioContext, sr:", audioCtx.sampleRate);
      }
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
        console.log("[playAudioData] resumed AudioContext");
      }

      // Server sends raw PCM (s16le 32kHz mono, WAV header stripped)
      // Manually construct AudioBuffer to bypass decodeAudioData limitations
      const SR = 32000;
      const CH = 1;
      const BPS = 2;
      const numSamples = bytes.length / BPS;
      const audioBuffer = audioCtx.createBuffer(CH, numSamples / CH, SR);
      const channelData = audioBuffer.getChannelData(0);
      // s16le little-endian: even index = low byte, odd index = high byte
      for (let i = 0; i < numSamples; i++) {
        const lo = bytes[i * 2];
        const hi = bytes[i * 2 + 1];
        const sample = (hi << 8) | lo;
        channelData[i] = sample >= 32768 ? (sample - 65536) / 32768 : sample / 32768;
      }
      console.log("[playAudioData] manual decode OK, duration:", audioBuffer.duration.toFixed(3), "sr:", audioBuffer.sampleRate, "ch:", audioBuffer.numberOfChannels);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.onended = () => {
        console.log("[playAudioData] done, remaining chunks:", ttsChunkCountRef.current - 1);
        ttsChunkCountRef.current = Math.max(0, ttsChunkCountRef.current - 1);
        isTTSPlayingRef.current = ttsChunkCountRef.current > 0;
        if (ttsChunkCountRef.current === 0) {
          isAiSpeakingRef.current = false;
          isTTSPlayingRef.current = false;
          setTimeout(() => {
            if (ttsChunkCountRef.current === 0) {
              isAiSpeakingRef.current = false;
              isTTSPlayingRef.current = false;
              if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = true);
            }
          }, 400);
        }
      };
      source.start(0);
      console.log("[playAudioData] started playback");
    } catch (e: any) {
      console.error("Web Audio playback error:", e?.message || e, e?.name);
      ttsChunkCountRef.current = Math.max(0, ttsChunkCountRef.current - 1);
      if (ttsChunkCountRef.current === 0) {
        isTTSPlayingRef.current = false;
        isAiSpeakingRef.current = false;
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.enabled = true);
      }
    }
  }, []);

  // Unlock audio context (browser autoplay policy)
  const unlockAudioContext = useCallback(async () => {
    try {
      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;
      if (audioCtx.state === "suspended") await audioCtx.resume();
      // Play 100ms of silence to unlock
      const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate / 10, audioCtx.sampleRate);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(0);
      setAudioReady(true);
      console.log("Audio context unlocked");
    } catch (e: any) {
      console.warn("Audio unlock failed:", e);
      setAudioReady(true); // Try anyway
    }
  }, []);

  // ── Continuous audio + VAD ───────────────────────────────────────────────
  const startContinuousAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
      streamRef.current = stream;

      // Audio context for VAD analysis
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyserRef.current = analyser;
      source.connect(analyser);

      // MediaRecorder for chunk capture
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
        const base64 = btoa(binary);
        wsRef.current?.send(JSON.stringify({ type: "audio_chunk", data: base64 }));
        setIsProcessing(true);
      };

      recorder.start(100);

      // VAD: check energy every 100ms
      const buffer = new ArrayBuffer(analyser.fftSize);
      // @ts-ignore -- TypeScript strict Uint8Array variant mismatch
      const data = new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
      let silenceFrames = 0;
      const SILENCE_FRAMES_THRESHOLD = 8; // ~0.8s of silence to trigger send

      vadIntervalRef.current = setInterval(async () => {
        if (isMuted) return;
        if (isTTSPlayingRef.current) return;  // Pause VAD while AI is speaking
        if (isAiSpeakingRef.current) return; // Extra guard: AI voice playing
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        if (isProcessing) return;

        const energy = await getEnergy(analyser, data);
        const isSilent = energy < 0.02;

        if (!isSilent) {
          isSpeakingRef.current = true;
          lastSpeechRef.current = Date.now();
          silenceFrames = 0;
        } else {
          if (isSpeakingRef.current) {
            silenceFrames++;
            if (silenceFrames >= SILENCE_FRAMES_THRESHOLD) {
              // User stopped speaking — send accumulated audio
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
      setError("Microphone access denied");
    }
  }, [isMuted, isProcessing, getEnergy]);

  const stopContinuousAudio = useCallback(() => {
    if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    try {
      if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      audioContextRef.current?.close();
    } catch {}
  }, []);

  // ── Start call ───────────────────────────────────────────────────────────
  const startCall = () => {
    setCallState("calling");
    setTranscript([]);
    setLiveText("");
    setError(null);
    setRingCount(0);

    ringIntervalRef.current = setInterval(() => setRingCount((r) => r + 1), 1000);
    setTimeout(() => {
      if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
      connectWS();
    }, 2500);
  };

  // ── End call ─────────────────────────────────────────────────────────────
  const endCall = () => {
    setCallState("ending");
    if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
    wsRef.current?.close();
    stopContinuousAudio();
    setTimeout(() => { setCallState("idle"); setTranscript([]); }, 800);
  };

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
      if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
      stopContinuousAudio();
      wsRef.current?.close();
    };
  }, [stopContinuousAudio]);

  // ── Call duration ───────────────────────────────────────────────────────
  const [callDuration, setCallDuration] = useState("00:00");
  useEffect(() => {
    if (callState !== "connected") return;
    const interval = setInterval(() => {
      const secs = Math.floor((Date.now() - callStartTimeRef.current) / 1000);
      setCallDuration(`${Math.floor(secs / 60).toString().padStart(2, "0")}:${(secs % 60).toString().padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [callState]);

  // ── UI ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-[#0a0a14] flex flex-col text-white overflow-hidden select-none">

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-white/5">
        <div>
          <h1 className="text-base font-semibold text-white/90">Voice AI</h1>
          <p className="text-xs text-white/40 mt-0.5">
            {callState === "idle" && "Tap to start a call"}
            {callState === "calling" && `Ringing${".".repeat((ringCount % 3) + 1)}`}
            {callState === "connected" && `Call active · ${callDuration}`}
            {callState === "ending" && "Call ended"}
          </p>
        </div>
        {callState === "connected" && (
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-green-400">Live</span>
          </div>
        )}
      </div>

      {/* Transcript area */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 max-h-[55vh]">
        {transcript.length === 0 && callState === "idle" && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
              <span className="text-3xl">📞</span>
            </div>
            <p className="text-white/30 text-sm">Your conversation will appear here</p>
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
                {entry.role === "user" ? "You" : "AI"}
              </span>
              {entry.text}
            </div>
          </div>
        ))}

        {liveText && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white/8 px-4 py-3 text-sm text-white/90">
              <span className="text-[10px] opacity-50 uppercase tracking-wider block mb-1">AI</span>
              {liveText}<span className="animate-pulse"> ▋</span>
            </div>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-5 mb-3 bg-red-900/40 border border-red-800/50 rounded-xl px-4 py-2.5 text-red-300 text-xs">
          {error}
        </div>
      )}

      {/* Bottom controls */}
      <div className="px-5 pb-8 pt-2 flex flex-col items-center gap-5">

        {/* Call button */}
        {callState === "idle" && (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={startCall}
              className="w-20 h-20 rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all flex items-center justify-center shadow-2xl shadow-violet-900/40"
            >
              <span className="text-3xl">📞</span>
            </button>
            {/* Direct audio test button */}
            <button
              onClick={async () => {
                try {
                  const res = await fetch('/test_audio');
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const audio = new Audio(url);
                  audio.play();
                  audio.onended = () => URL.revokeObjectURL(url);
                } catch(e: any) { alert('Audio test failed: ' + e.message); }
              }}
              className="text-xs text-white/40 hover:text-white/70 transition-colors"
            >
              🔊 Test Audio
            </button>
          </div>
        )}

        {callState === "calling" && (
          <div className="w-20 h-20 rounded-full bg-neutral-800 flex items-center justify-center animate-pulse">
            <span className="text-3xl">📡</span>
          </div>
        )}

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

            {/* Active mic indicator */}
            <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${
              isMuted ? "bg-gray-700" : isProcessing ? "bg-violet-700 animate-pulse" : "bg-violet-600"
            }`}>
              <span className="text-2xl">🎤</span>
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

        <p className="text-white/25 text-[11px] text-center">
          {callState === "idle" && "Tap to call"}
          {callState === "calling" && "Connecting..."}
          {callState === "connected" && (isMuted ? "Unmute to speak" : isProcessing ? "Thinking..." : "Speak naturally — AI is listening")}
          {callState === "ending" && "Call ended"}
        </p>
      </div>
    </div>
  );
}
