import { AccessToken } from "livekit-server-sdk";

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

const INSECURE_API_KEYS = new Set(["devkey"]);
const INSECURE_SECRETS = new Set([
  "secret",
  "local_dev_only_secret_do_not_use_in_prod",
]);

function isLocalLiveKitUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

/**
 * Blocks shipping documented local credentials against a non-local LiveKit URL
 * in production.
 */
export function assertLiveKitCredentialsSafe(
  config: LiveKitConfig,
  env: string | undefined = process.env.NODE_ENV,
): void {
  const insecure =
    INSECURE_API_KEYS.has(config.apiKey) ||
    INSECURE_SECRETS.has(config.apiSecret);

  if (!insecure) {
    return;
  }

  if (env === "production" && !isLocalLiveKitUrl(config.url)) {
    throw new Error(
      "Refusing to use default/local LiveKit credentials with a non-local LIVEKIT_URL in production. Set strong LIVEKIT_API_KEY and LIVEKIT_API_SECRET (secret ≥ 32 characters).",
    );
  }

  if (env === "production") {
    console.warn(
      "[meet] Using local/default LiveKit credentials. Fine for localhost only — change them before any real deployment.",
    );
  }
}

export function readLiveKitConfig(): LiveKitConfig {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      "Missing LiveKit configuration. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.",
    );
  }

  const config = { url, apiKey, apiSecret };
  assertLiveKitCredentialsSafe(config);
  return config;
}

export interface CreateJoinTokenOptions {
  apiKey: string;
  apiSecret: string;
  room: string;
  identity: string;
  name: string;
}

export async function createJoinToken({
  apiKey,
  apiSecret,
  room,
  identity,
  name,
}: CreateJoinTokenOptions): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
    ttl: "2h",
  });

  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  return token.toJwt();
}
