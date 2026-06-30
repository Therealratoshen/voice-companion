/**
 * POST /api/session/stop
 *
 * Stops an active Agora voice agent session.
 *
 * Body: { agentId }
 */
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { agentId } = await req.json().catch(() => ({}));

    if (!agentId) {
      return NextResponse.json({ error: "agentId required" }, { status: 400 });
    }

    const { stopSession } = await import("@/lib/agora");
    await stopSession(agentId);

    return NextResponse.json({ ok: true, agentId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[session/stop]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
