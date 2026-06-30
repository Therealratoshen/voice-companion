/**
 * GET /api/session/context?userId=...&sessionId=...&message=...
 *
 * Fetch memory context for a user's upcoming message.
 * Frontend calls this before sending a message to show "remembering..." indicator.
 * The context is also sent to the session/create or used for real-time injection.
 */
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId") || "";
    const sessionId = searchParams.get("sessionId") || "";
    const message = searchParams.get("message") || "";

    if (!userId) {
      return NextResponse.json({ error: "userId required" }, { status: 400 });
    }

    const { buildContext, formatContextForLLM } = await import("@/lib/memory");

    const ctx = await buildContext(userId, sessionId, message);
    const contextBlock = formatContextForLLM(ctx);

    return NextResponse.json({
      contextUsed: ctx.memories.length,
      sessionSummary: ctx.sessionSummary,
      profileName: ctx.userProfile?.name,
      contextBlock,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[session/context]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
