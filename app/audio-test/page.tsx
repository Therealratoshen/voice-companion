"use client";
import { useState } from "react";

export default function AudioTest() {
  const [status, setStatus] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const testPlay = async () => {
    setStatus("Testing fetch...");
    try {
      const res = await fetch("/test_audio");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(`✅ Fetch OK - ${res.headers.get("content-type")} (${res.headers.get("content-length")} bytes)`);
      
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      
      const audio = new Audio(url);
      setStatus("Playing audio... listen!");
      audio.play().catch(e => setStatus(`❌ Play error: ${e.message}`));
      audio.onended = () => setStatus("✅ Playback finished");
    } catch (e: any) {
      setStatus(`❌ Error: ${e.message}`);
    }
  };

  const testSpeechSynthesis = () => {
    if (!window.speechSynthesis) {
      setStatus("❌ SpeechSynthesis not available");
      return;
    }
    const utterance = new SpeechSynthesisUtterance("Hello, this is a test.");
    utterance.onend = () => setStatus("✅ SpeechSynthesis finished");
    utterance.onerror = (e) => setStatus(`❌ SpeechSynthesis error: ${e.error}`);
    speechSynthesis.speak(utterance);
    setStatus("Playing via SpeechSynthesis...");
  };

  return (
    <div style={{ padding: 40, fontFamily: "system-ui", background: "#111", color: "#fff", minHeight: "100vh" }}>
      <h1>🔊 Audio Test</h1>
      <p>This page tests if audio works in your browser.</p>
      
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 30 }}>
        <button 
          onClick={testPlay}
          style={{ padding: "16px 32px", fontSize: 18, background: "#7c3aed", color: "#fff", border: "none", borderRadius: 12, cursor: "pointer" }}
        >
          🔊 Test TTS Audio (Edge TTS via server)
        </button>
        
        <button 
          onClick={testSpeechSynthesis}
          style={{ padding: "16px 32px", fontSize: 18, background: "#059669", color: "#fff", border: "none", borderRadius: 12, cursor: "pointer" }}
        >
          🗣️ Test SpeechSynthesis (browser fallback)
        </button>
      </div>
      
      <p style={{ marginTop: 30, fontSize: 18, color: "#a78bfa" }}>{status}</p>
      
      <div style={{ marginTop: 40, padding: 20, background: "#1a1a1a", borderRadius: 12 }}>
        <h3>Troubleshooting:</h3>
        <ul>
          <li>If TTS button fails → server TTS is broken</li>
          <li>If SpeechSynthesis works → browser can play audio</li>
          <li>If TTS works but no sound → browser blocking autoplay</li>
          <li>If both fail → check browser audio permissions</li>
        </ul>
      </div>
    </div>
  );
}
