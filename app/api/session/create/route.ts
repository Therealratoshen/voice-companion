/**
 * POST /api/session/create
 *
 * Creates a new Agora voice agent session with full memory context.
 *
 * Flow:
 *  1. Build context from TiDB (memories + session history + profile)
 *  2. Inject context as extra system message
 *  3. Build + start Agora agent session
 *  4. Return channel + token for browser to join
 *
 * Body: { userId, channelName?, language? }
 * Response: { channel, userToken, userUid, agentId, appId, sessionId }
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

    // ── Build personality system message ──────────────────────────────
    const systemMessages: Array<{ role: "system"; content: string }> = [
      {
        role: "system",
        content:
          "Kamu adalah Rafiq — asisten suara yang hangat, empatik, dan alami.\n" +
          "Namamu Rafiq. Selalu jawab dalam Bahasa Indonesia.\n" +
          "Jawaban pendek — 1–3 kalimat. Jangan bilang kamu AI.\n" +
          "Gunakan nama pengguna jika kamu tahu.\n" +
          "Tunjukkan empati: \"Wah, pasti capek ya\", \"Aku ngerti perasaanmu\".\n" +
          "Jangan robotik — bicara seperti teman yang peduli.\n" +
          "Jika pengguna menyebut nama mereka, ingat itu.\n" +
          "Jika pengguna meminta sesuatu yang kamu tidak tahu, bilang jujur.",
      },
    ];

    // ── Inject memory context ──────────────────────────────────────
    let memoryUsed = false;
    let profileName: string | null = null;

    try {
      const { buildContext, formatContextForLLM } = await import("@/lib/memory");
      const ctx = await buildContext(userId, channelName, "", {
        memoryLimit: 8,
        historyLimit: 6,
        includeProfile: true,
      });

      if (ctx.memories.length > 0 || ctx.sessionSummary || ctx.userProfile?.name) {
        const contextBlock = formatContextForLLM(ctx);
        systemMessages.push({
          role: "system",
          content: `[KONTEKS MEMORY]\nIngat hal-hal ini tentang pengguna:\n${contextBlock}\n[/KONTEKS MEMORY]`,
        });
        memoryUsed = true;
        profileName = ctx.userProfile?.name || null;
      }
    } catch (err) {
      console.warn("[session/create] Memory injection failed:", err);
    }

    // ── Build + start Agora agent session ─────────────────────────
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
      `[session] Created — channel=${channel} agentId=${agentId} userId=${userId} memoryUsed=${memoryUsed}`
    );

    return NextResponse.json({
      channel,
      userToken,
      userUid,
      agentId,
      sessionId: channel,
      appId: process.env.AGORA_APP_ID,
      memoryUsed,
      profileName,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[session/create]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
