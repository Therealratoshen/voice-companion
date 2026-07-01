/**
 * Rafiqspace STT — async transcription via Rafiqspace API.
 *
 * Flow:
 *   1. POST /upload-url     → { upload_url, audio_token }
 *   2. PUT  {upload_url}    → upload the raw audio file
 *   3. POST /transcripts    → { id: audio_token }  (start async job)
 *   4. GET  /transcripts/{id}  → poll until status === "completed"
 *
 * Ref: github.com/Therealratoshen/rafiqspace-api
 */

const RAFIQ_BASE =
  process.env.RAFIQ_BASE_URL || "https://api.rafiqspace.ai/api/v1";

const RAFIQ_KEY = process.env.RAFIQ_API_KEY || "";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RafiqTranscriptResult {
  text: string;
  segments?: Array<{
    text: string;
    start: number;
    end: number;
    confidence?: number;
  }>;
  language?: string;
  duration?: number;
}

export interface RafiqSTTOptions {
  language?: "id" | "en";
  /** Polling interval in ms (default 800) */
  pollIntervalMs?: number;
  /** Max poll attempts before giving up (default 30 = ~24s) */
  maxPollAttempts?: number;
}

// ── Core STT ────────────────────────────────────────────────────────────────

/**
 * Transcribe an audio buffer using Rafiqspace async API.
 *
 * Accepts: webm (from browser MediaRecorder), wav, mp3, ogg
 * Returns: transcribed text + optional word-level segments
 */
export async function rafiqSTT(
  audioBuffer: Buffer,
  options: RafiqSTTOptions = {}
): Promise<RafiqTranscriptResult> {
  if (!RAFIQ_KEY) {
    throw new Error(
      "RAFIQ_API_KEY not set. Get one at https://api.rafiqspace.ai/"
    );
  }

  const lang = options.language || "id";
  const pollInterval = options.pollIntervalMs ?? 800;
  const maxAttempts = options.maxPollAttempts ?? 30;

  // ── Step 1: Get upload URL ─────────────────────────────────────────────
  const uploadRes = await fetch(`${RAFIQ_BASE}/upload-url`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RAFIQ_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ language: lang }),
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`[Rafiqspace] /upload-url failed (${uploadRes.status}): ${err}`);
  }

  const { upload_url, audio_token } = await uploadRes.json() as {
    upload_url: string;
    audio_token: string;
  };

  console.log(`[Rafiqspace] Got upload URL — token=${audio_token.slice(0, 12)}...`);

  // ── Step 2: Upload audio to the presigned URL ───────────────────────────
  const audioExt = detectAudioExt(audioBuffer);
  const uploadRes2 = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": getMimeType(audioExt) },
    body: new Uint8Array(audioBuffer),
  });

  if (!uploadRes2.ok) {
    const err = await uploadRes2.text();
    throw new Error(`[Rafiqspace] PUT audio failed (${uploadRes2.status}): ${err}`);
  }

  console.log(`[Rafiqspace] Audio uploaded (${audioBuffer.byteLength} bytes)`);

  // ── Step 3: Start async transcription job ───────────────────────────────
  const startRes = await fetch(`${RAFIQ_BASE}/transcripts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RAFIQ_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: audio_token }),
  });

  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(`[Rafiqspace] /transcripts POST failed (${startRes.status}): ${err}`);
  }

  const { id: jobId } = await startRes.json() as { id: string };
  console.log(`[Rafiqspace] Job started — id=${jobId}`);

  // ── Step 4: Poll until completed ─────────────────────────────────────
  const result = await pollForResult(jobId, pollInterval, maxAttempts);

  console.log(
    `[Rafiqspace] Done — text="${result.text.slice(0, 80)}${
      result.text.length > 80 ? "..." : ""
    }"`
  );

  return result;
}

// ── Polling ────────────────────────────────────────────────────────────────

interface RafiqPollingResponse {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  text?: string;
  segments?: RafiqTranscriptResult["segments"];
  language?: string;
  duration?: number;
  error?: string;
}

async function pollForResult(
  jobId: string,
  intervalMs: number,
  maxAttempts: number
): Promise<RafiqTranscriptResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Wait before polling (skip on first attempt)
    if (attempt > 1) {
      await sleep(intervalMs);
    }

    const res = await fetch(`${RAFIQ_BASE}/transcripts/${jobId}`, {
      headers: { Authorization: `Bearer ${RAFIQ_KEY}` },
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`[Rafiqspace] Poll #${attempt} failed (${res.status}): ${err}`);
      continue;
    }

    const data = (await res.json()) as RafiqPollingResponse;
    console.log(
      `[Rafiqspace] Poll #${attempt}/${maxAttempts} — status=${data.status}`
    );

    if (data.status === "completed") {
      if (!data.text) {
        throw new Error("[Rafiqspace] Job completed but no text returned");
      }
      return {
        text: data.text,
        segments: data.segments,
        language: data.language,
        duration: data.duration,
      };
    }

    if (data.status === "failed") {
      throw new Error(`[Rafiqspace] Job failed: ${data.error || "unknown"}`);
    }

    // "pending" or "processing" — keep polling
  }

  throw new Error(
    `[Rafiqspace] Transcription timed out after ${maxAttempts} polls (~${(
      (maxAttempts * intervalMs) /
      1000
    ).toFixed(1)}s)`
  );
}

// ── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Detect audio extension from magic bytes (webm/wav/mp3/ogg). */
function detectAudioExt(buffer: Buffer): string {
  const b = buffer;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "wav"; // RIFF
  if (
    b[0] === 0x1a && b[1] === 0x45 && b[2] === 0x93 && b[3] === 0x11
  )
    return "webm"; // WebM
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3"; // MP3 sync word
  if (
    b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53
  )
    return "ogg"; // Ogg
  return "webm"; // default — browsers usually record as webm
}

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    webm: "audio/webm",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
  };
  return map[ext] ?? "audio/webm";
}
