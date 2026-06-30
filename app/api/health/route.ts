/**
 * GET /api/health
 *
 * Health check endpoint for Docker healthcheck and monitoring.
 */
import { NextResponse } from "next/server";

export async function GET() {
  const checks: Record<string, string> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    node: process.version,
    env: process.env.AGORA_APP_ID ? "agora" : "legacy-ws",
  };

  return NextResponse.json(checks);
}
