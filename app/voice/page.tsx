"use client";

/**
 * Voice Companion UI — Agora RTC mode
 *
 * Flow:
 *  1. User taps "Call" → POST /api/session/create → gets channel + token
 *  2. Browser joins Agora RTC channel with token + appId
 *  3. The server-side Agora Agent (via agora-agents SDK) is already in the channel
 *  4. Browser mic audio is sent to the channel; agent's TTS audio comes back
 *  5. Browser plays incoming audio via Web Audio API
 */

import { useState, useRef, useCallback, useEffect } from "react";

type CallState = "idle" | "creating" | "connected" | "ending" | "error";

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
  const [callDuration, setCallDuration] = useState("00:00");
  const [userId] = useState(() => `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  // Agora RTC refs
  const agoraEngineRef = useRef<any>(null);
  const localAudioTrackRef = useRef<any>(null);
  const remoteAudioTrackRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const callStartTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingAudioRef = useRef<Int8Array[]>([]);

  // ── Agora RTC join ─────────────────────────────────────────────────────
  const joinChannel = useCallback(
    async (channel: string, token: string, uid: number, appId: string) => {
      // Dynamic import of Agora RTC Web SDK (loaded from CDN)
      if (!(window as any).AgoraRTC) {
        // Load the Agora RTC SDK script if not already loaded
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

      // Handle remote audio
      client.on("user-published", async (user: any, mediaType: "audio") => {
        if (mediaType === "audio") {
          const track = await client.subscribe(user, "audio");
          remoteAudioTrackRef.current = track;
          track.play(); // plays incoming agent audio

          // Route to Web Audio for visual waveform (optional)
          const audioCtx = new AudioContext();
          audioContextRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(
            new MediaStream([track.getMediaStreamTrack()])
          );
          source.connect(audioCtx.destination);
        }
      });

      client.on("user-unpublished", () => {
        remoteAudioTrackRef.current = null;
      });

      // Join the channel — the agent is already there waiting
      await client.join(appId, channel, token, uid);

      // Create + publish local mic track
      const localAudio = await AgoraRTC.createMicrophoneAudioTrack({
        AEC: true,
        ANS: true,
        AG: true,
      });
      localAudioTrackRef.current = localAudio;
      await client.publish(localAudio);

      console.log(`[Voice] Joined channel=${channel} uid=${uid}`);
    },
    []
  );

  // ── Start call ─────────────────────────────────────────────────────────
  const startCall = useCallback(async () => {
    setCallState("creating");
    setTranscript([]);
    setLiveText("");
    setError(null);

    try {
      const res = await fetch("/api/session/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create session");
      }

      const { channel, userToken, userUid, appId, agentId } = await res.json();
      console.log(
        `[Voice] Session created — agentId=${agentId} channel=${channel}`
      );

      await joinChannel(channel, userToken, userUid, appId);

      callStartTimeRef.current = Date.now();
      setCallState("connected");

      // Duration ticker
      durationIntervalRef.current = setInterval(() => {
        const secs = Math.floor((Date.now() - callStartTimeRef.current) / 1000);
        setCallDuration(
          `${Math.floor(secs / 60).toString().padStart(2, "0")}:${(
            secs % 60
          )
            .toString()
            .padStart(2, "0")}`
        );
      }, 1000);
    } catch (err: any) {
      console.error("[Voice] Call error:", err);
      setError(err.message || "Connection failed");
      setCallState("error");
    }
  }, [userId, joinChannel]);

  // ── End call ───────────────────────────────────────────────────────────
  const endCall = useCallback(async () => {
    setCallState("ending");

    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
    }

    try {
      localAudioTrackRef.current?.stop();
      localAudioTrackRef.current?.close();
      await agoraEngineRef.current?.leave();
    } catch {}

    localAudioTrackRef.current = null;
    agoraEngineRef.current = null;
    remoteAudioTrackRef.current = null;

    setTimeout(() => {
      setCallState("idle");
      setTranscript([]);
      setLiveText("");
      setCallDuration("00:00");
    }, 500);
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      localAudioTrackRef.current?.stop();
      agoraEngineRef.current?.leave();
    };
  }, []);

  // ── Mute toggle ────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (localAudioTrackRef.current) {
      const muted = !isMuted;
      localAudioTrackRef.current.setEnabled(!muted);
      setIsMuted(muted);
    }
  }, [isMuted]);

  // ── UI ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen w-full bg-[#0a0a14] flex flex-col text-white overflow-hidden select-none">

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-white/5">
        <div>
          <h1 className="text-base font-semibold text-white/90">Voice AI</h1>
          <p className="text-xs text-white/40 mt-0.5">
            {callState === "idle" && "Tap to start a call"}
            {callState === "creating" && "Creating session..."}
            {callState === "connected" && `Call active · ${callDuration}`}
            {callState === "ending" && "Call ended"}
            {callState === "error" && "Connection failed"}
          </p>
        </div>
        {callState === "connected" && (
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-green-400">Live</span>
          </div>
        )}
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 max-h-[55vh]">
        {transcript.length === 0 && callState === "idle" && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
              <span className="text-3xl">🎙️</span>
            </div>
            <p className="text-white/30 text-sm">Your conversation will appear here</p>
            <p className="text-white/15 text-xs mt-1">Powered by Agora + MiniMax</p>
          </div>
        )}

        {transcript.map((entry, i) => (
          <div
            key={i}
            className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}
          >
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
              {liveText}
              <span className="animate-pulse"> ▋</span>
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-5 mb-3 bg-red-900/40 border border-red-800/50 rounded-xl px-4 py-2.5 text-red-300 text-xs">
          {error}
        </div>
      )}

      {/* Controls */}
      <div className="px-5 pb-8 pt-2 flex flex-col items-center gap-5">

        {/* Idle → Start call */}
        {callState === "idle" && (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={startCall}
              className="w-20 h-20 rounded-full bg-violet-600 hover:bg-violet-500 active:scale-95 transition-all flex items-center justify-center shadow-2xl shadow-violet-900/40"
            >
              <span className="text-3xl">📞</span>
            </button>
            <p className="text-white/25 text-[11px]">Powered by Agora + MiniMax</p>
          </div>
        )}

        {/* Creating session */}
        {(callState === "creating" || callState === "error") && (
          <div className="w-20 h-20 rounded-full bg-neutral-800 flex items-center justify-center animate-pulse">
            <span className="text-3xl">📡</span>
          </div>
        )}

        {/* Connected */}
        {callState === "connected" && (
          <div className="flex items-center gap-10">
            {/* Mute */}
            <button
              onClick={toggleMute}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-all ${
                isMuted ? "bg-red-900/40 text-red-300" : "bg-white/10 text-white/60"
              }`}
            >
              <span className="text-xl">{isMuted ? "🔇" : "🎤"}</span>
            </button>

            {/* Active mic */}
            <div
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${
                isMuted ? "bg-gray-700" : "bg-violet-600"
              }`}
            >
              <span className="text-2xl">🎤</span>
            </div>

            {/* End */}
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

        <p className="text-white/25 text-[11px] text-center">
          {callState === "idle" && "Tap to call"}
          {callState === "creating" && "Creating session..."}
          {callState === "connected" && (isMuted ? "Unmute to speak" : "Speak naturally — AI is listening")}
          {callState === "ending" && "Call ended"}
          {callState === "error" && "Tap to retry"}
        </p>
      </div>
    </div>
  );
}
