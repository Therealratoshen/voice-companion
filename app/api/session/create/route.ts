/**
 * POST /api/session/create
 *
 * Creates a new Agora voice agent session.
 * Returns channel + RTC token for the browser to join.
 *
 * Body: { userId, channelName?, withMemory?, language? }
 * Response: { channel, userToken, userUid, agentId, appId }
 */
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    if (!process.env.AGORA_APP_ID || !process.env.AGORA_APP_CERTIFICATE) {
      return NextResponse.json(
        { error: "Agora not configured. Set AGORA_APP_ID and AGORA_APP_CERTIFICATE." },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const userId: string = body.userId || `anon-${Date.now()}`;
    const channelName: string =
      body.channelName ||
      `voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const language: string = body.language || "id-ID";
    const withMemory: boolean = body.withMemory !== false;

    // Build system messages (optionally with memory)
    let systemMessages: Array<{ role: "system"; content: string }> = [
      {
        role: "system",
        content:
          "Kamu adalah asisten suara AI yang hangat dan ramah.\n" +
          "Selalu jawab dalam Bahasa Indonesia.\n" +
          "Jawaban singkat — 1 sampai 3 kalimat.\n" +
          "Jangan bilang kamu AI.",
      },
    ];

    if (withMemory) {
      try {
        const { searchMemory } = await import("@/lib/memory");
        const memories = await searchMemory(userId, "", 5);
        if (memories.length > 0) {
          const memoryContext = memories
            .map((m: { content: string }) => `- ${m.content}`)
            .join("\n");
          systemMessages.push({
            role: "system",
            content: `Konteks percakapan sebelumnya:\n${memoryContext}`,
          });
        }
      } catch (err) {
        console.warn("[session/create] Memory failed:", err);
      }
    }

    const { buildAgent, createSession, startAndRegisterSession } = await import(
      "@/lib/agora"
    );
    const { ExpiresIn } = await import("agora-agents");

    const { agent, client } = await buildAgent({ systemMessages });

    const { session, userToken, userUid, channel } = await createSession(
      agent,
      client,
      {
        userId,
        channelName,
        expiresIn: ExpiresIn.hours(1),
      }
    );

    const agentId = await startAndRegisterSession(
      session,
      client,
      channel,
      userId
    );

    console.log(
      `[session] Created — channel=${channel} agentId=${agentId} userId=${userId}`
    );

    return NextResponse.json({
      channel,
      userToken,
      userUid,
      agentId,
      appId: process.env.AGORA_APP_ID,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[session/create]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
