import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";

const AUTHORIZE_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";

export interface OAuthConfig {
  appId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  sessionCookieName: string;
  sessionSecret: string;
}

export function oauthConfig(): OAuthConfig {
  return {
    appId: process.env.DERIV_OAUTH_APP_ID ?? "",
    clientSecret: process.env.DERIV_OAUTH_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.DERIV_OAUTH_REDIRECT_URI ??
      "https://traderspulse.site/callback",
    scope: process.env.DERIV_OAUTH_SCOPE ?? "trade account_manage",
    sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "tgt_session",
    sessionSecret:
      process.env.SESSION_SECRET ?? "traderspulse-dev-secret-change-me",
  };
}

export interface DerivTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface Session {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  app_id: string;
}

export interface OauthState {
  state: string;
  verifier: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizeUrl(
  state: string,
  challenge: string,
  cfg: OAuthConfig = oauthConfig(),
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.appId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function postToken(body: URLSearchParams): Promise<DerivTokenResponse> {
  const cfg = oauthConfig();
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  let json: DerivTokenResponse;
  try {
    json = (await res.json()) as DerivTokenResponse;
  } catch {
    throw new Error(`Deriv token endpoint returned HTTP ${res.status}`);
  }

  if (!res.ok) {
    throw new Error(
      json.error_description || json.error || `token_exchange_failed (${res.status})`,
    );
  }
  return json;
}

export function exchangeCodeForToken(
  code: string,
  verifier: string,
  cfg: OAuthConfig = oauthConfig(),
): Promise<DerivTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.appId,
  });
  return postToken(body);
}

export function refreshAccessToken(
  refreshTokenValue: string,
  cfg: OAuthConfig = oauthConfig(),
): Promise<DerivTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.appId,
  });
  return postToken(body);
}

// ─── Session cookie crypto (AES-256-GCM) ──────────────────────────────────────

function sessionKey(): Buffer {
  return createHash("sha256").update(oauthConfig().sessionSecret).digest();
}

export function encryptSession(session: Session): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptSession(value: string): Session {
  const buf = Buffer.from(value, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", sessionKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as Session;
}
