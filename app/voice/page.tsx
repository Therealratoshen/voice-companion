"use client";

import { useState, useRef, useEffect } from "react";

type IAgoraRTCClient = any;
type ILocalAudioTrack = any;

export default function VoicePage() {
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "error">("idle");
  const [isMicOn, setIsMicOn] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const localTrackRef = useRef<ILocalAudioTrack | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const AgoraRTCRef = useRef<any>(null);

  const appId = process.env.NEXT_PUBLIC_AGORA_APP_ID || "";
  const userId = "user_001"; // Replace with actual user ID

  useEffect(() => {
    // Dynamically import Agora to avoid SSR window issues
    import("agora-rtc-sdk-ng").then((mod) => {
      AgoraRTCRef.current = mod.default ?? mod;
      const client = AgoraRTCRef.current.createClient({ mode: "rtc", codec: "vp8" });

      client.on("user-published", async (user: any, mediaType: string) => {
        await client.subscribe(user, mediaType);
        if (mediaType === "audio" && user.audioTrack) {
          user.audioTrack.play();
        }
      });

      client.on("user-unpublished", (user: any) => {
        if (user.audioTrack) user.audioTrack.stop();
      });

      clientRef.current = client;
    });

    return () => {
      clientRef.current?.removeAllListeners();
      localTrackRef.current?.close();
    };
  }, []);

  const handleGoLive = async () => {
    if (!clientRef.current || !AgoraRTCRef.current) return;
    setStatus("connecting");
    try {
      const uid = Math.floor(Math.random() * 100000);
      await clientRef.current.join(appId, "voice-room", null, uid);
      setStatus("live");
    } catch (err) {
      console.error("Join failed:", err);
      setStatus("error");
    }
  };

  const handleLeave = async () => {
    if (localTrackRef.current) {
      await clientRef.current?.unpublish(localTrackRef.current);
      localTrackRef.current.close();
      localTrackRef.current = null;
    }
    mediaRecorderRef.current?.stop();
    if (clientRef.current) await clientRef.current.leave();
    setIsMicOn(false);
    setStatus("idle");
  };

  const startRecording = () => {
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        await sendToAPI(audioBlob);
      };

      recorder.start();
    });
  };

  const sendToAPI = async (audioBlob: Blob) => {
    setIsProcessing(true);
    try {
      const formData = new FormData();
      formData.append("userId", userId);
      formData.append("audio", audioBlob);

      const res = await fetch("/api/voice", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const audioBuffer = await res.arrayBuffer();
        const audio = new Audio(URL.createObjectURL(new Blob([audioBuffer], { type: "audio/mpeg" })));
        audio.play();
      }
    } catch (err) {
      console.error("API error:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  const toggleMic = () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      startRecording();
      setIsMicOn(true);
    } else {
      mediaRecorderRef.current.stop();
      setIsMicOn(false);
    }
  };

  return (
    <main className="min-h-screen w-full bg-gradient-to-b from-[#1A1A2E] to-[#16213E] flex flex-col items-center justify-center text-white overflow-hidden p-6">
      <h1 className="text-4xl font-bold mb-2">🎙️ Voice Chat</h1>
      <p className="text-gray-400 text-lg mb-8">Talk with AI companion</p>

      {/* Status */}
      <div className="flex items-center gap-2 mb-8">
        <div
          className={`w-3 h-3 rounded-full ${
            status === "idle"
              ? "bg-gray-500"
              : status === "connecting"
              ? "bg-yellow-500 animate-pulse"
              : status === "live"
              ? "bg-green-500"
              : "bg-red-500"
          }`}
        />
        <span className="text-gray-300 font-medium">
          {status === "idle" && "Tap Go Live to start"}
          {status === "connecting" && "Connecting..."}
          {status === "live" && (isProcessing ? "Thinking..." : isMicOn ? "Listening..." : "Tap mic to talk")}
          {status === "error" && "Error connecting"}
        </span>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-3 w-full max-w-xs mb-8">
        {status !== "live" ? (
          <button
            onClick={handleGoLive}
            disabled={status === "connecting"}
            className="w-full px-6 py-2 rounded-lg bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-semibold"
          >
            {status === "connecting" ? "⏳ Connecting..." : "🔴 Go Live"}
          </button>
        ) : (
          <>
            <button
              disabled
              className="w-full px-6 py-2 rounded-lg bg-red-500 text-white font-semibold opacity-80 cursor-not-allowed"
            >
              🔴 Live
            </button>
            <button
              onClick={handleLeave}
              className="w-full px-6 py-2 rounded-lg bg-transparent border border-gray-600 text-gray-300 hover:bg-gray-800 font-semibold"
            >
              Leave Room
            </button>
          </>
        )}
      </div>

      {/* Mic */}
      <div className="flex flex-col items-center gap-4">
        <button
          onClick={toggleMic}
          disabled={status !== "live" || isProcessing}
          className={`w-28 h-28 rounded-full flex flex-col items-center justify-center shadow-2xl transition-all ${
            status !== "live"
              ? "bg-gray-800 opacity-50 cursor-not-allowed"
              : isMicOn
              ? "bg-red-500 hover:bg-red-600 animate-pulse"
              : "bg-gray-700 hover:bg-gray-600"
          }`}
        >
          <span className="text-4xl mb-1">🎤</span>
          <span className="text-xs font-semibold uppercase tracking-wider">
            {isMicOn ? "Stop" : "Talk"}
          </span>
        </button>
        <p className="text-gray-400 text-sm font-medium">
          {status !== "live"
            ? "Go live first"
            : isMicOn
            ? "Recording..."
            : isProcessing
            ? "Thinking..."
            : "Tap to talk"}
        </p>
      </div>
    </main>
  );
}
