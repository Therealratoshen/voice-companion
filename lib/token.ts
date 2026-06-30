/**
 * Local RTC token generator — fallback if the agora-agents SDK is unavailable.
 *
 * Uses agora-access-token v2 (namespace-based API, not class-based).
 */

import { RtcTokenBuilder, RtcRole } from "agora-access-token";

const ROLE = RtcRole.PUBLISHER; // Publishers can publish + receive audio

export interface GenerateTokenOptions {
  appId: string;
  appCertificate: string;
  channelName: string;
  uid: number | string;
  expirationTimeInSeconds?: number;
}

/**
 * Generate an RTC token for a user to join a channel.
 */
export function generateToken(options: GenerateTokenOptions): string {
  const {
    appId,
    appCertificate,
    channelName,
    uid,
    expirationTimeInSeconds = 3600,
  } = options;

  const expirationTs = Math.floor(Date.now() / 1000) + expirationTimeInSeconds;

  // uid must be a number for buildTokenWithUid
  const numericUid = typeof uid === "string" ? parseInt(uid, 10) || 0 : uid;

  return RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    numericUid,
    ROLE,
    expirationTs
  );
}
