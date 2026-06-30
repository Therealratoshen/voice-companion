/**
 * POST /api/session/summarize
 *
 * Called when a session ends — generates a session summary and saves it to TiDB.
 * Then deletes the session from the in-memory registry.
 */
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { userId, sessionId } = await req.json().catch(() => ({}));

    if (!userId || !sessionId) {
      return NextResponse.json({ error: "userId and sessionId required" }, { status: 400 });
    }

    // Generate session summary (TiDB write)
    const { generateSessionSummary } = await import("@/lib/memory");
    const { stopSession } = await import("@/lib/agora");

    const summary = await generateSessionSummary(userId, sessionId);

    // Stop the Agora session (uses agentId as key)
    try {
      await stopSession(sessionId);
    } catch {}

    return NextResponse.json({ ok: true, sessionId, summary });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[session/summarize]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
