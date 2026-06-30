/**
 * Local RTC token generator — fallback if agora-agents doesn't export one.
 * Uses the agora-token package (a dependency of agora-agents).
 *
 * Based on: https://docs.agora.io/en/video-calling/reference/core-principles
 */

import { AccessToken, Role } from "agora-access-token";

const ROLE = Role.RolePublisher; // Publishers can publish audio (and receive)

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
    expirationTimeInSeconds = 3600, // 1 hour default
  } = options;

  const expirationTimeInSeconds2 =
    typeof expirationTimeInSeconds === "number"
      ? expirationTimeInSeconds
      : expirationTimeInSeconds.seconds ?? 3600;

  const token = new AccessToken(appId, appCertificate, channelName, uid);
  token.addExpiration(expirationTimeInSeconds2);
  token.addPrivilage(ROLE, expirationTimeInSeconds2);

  return token.build();
}
