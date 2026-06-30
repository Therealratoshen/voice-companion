/**
 * POST /api/session/react
 *
 * Handle quick reactions from the UI.
 * Maps emoji reactions → text commands injected into the agent via agentThink.
 *
 * Body: { agentId, text }
 */
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { agentId, text } = await req.json().catch(() => ({}));

    if (!agentId) {
      return NextResponse.json({ error: "agentId required" }, { status: 400 });
    }

    if (!text) {
      return NextResponse.json({ ok: true }); // no-op for reactions without text
    }

    const { agentThink } = await import("@/lib/agora");
    await agentThink(agentId, text);

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[session/react]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
