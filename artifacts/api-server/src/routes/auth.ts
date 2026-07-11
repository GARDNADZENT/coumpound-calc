import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import {
  oauthConfig,
  generatePkce,
  randomState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  encryptSession,
  decryptSession,
  type Session,
} from "../lib/oauth";

const router: IRouter = Router();

const OAUTH_COOKIE = "tgt_oauth";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — persists until explicit logout
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

const isProd = process.env.NODE_ENV === "production";

function cookieOpts(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProd,
    path: "/",
    maxAge: maxAgeMs,
  };
}

function readSession(req: { cookies?: Record<string, string> }): Session | null {
  const cfg = oauthConfig();
  const raw = req.cookies?.[cfg.sessionCookieName];
  if (!raw) return null;
  try {
    return decryptSession(raw);
  } catch {
    return null;
  }
}

async function ensureFresh(session: Session, setCookie: (s: Session) => void): Promise<Session> {
  if (session.expires_at - Date.now() > REFRESH_SKEW_MS) {
    return session;
  }
  if (!session.refresh_token) {
    throw new Error("session_expired_no_refresh");
  }
  const tokens = await refreshAccessToken(session.refresh_token);
  const updated: Session = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? session.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    app_id: session.app_id,
  };
  setCookie(updated);
  return updated;
}

// Public config — safe to expose (no secrets).
router.get("/config", (_req, res) => {
  const cfg = oauthConfig();
  res.json({
    app_id: cfg.appId || null,
    redirect_uri: cfg.redirectUri,
    configured: Boolean(cfg.appId),
  });
});

router.get("/login", (req, res) => {
  const cfg = oauthConfig();
  if (!cfg.appId) {
    return res.status(400).json({ error: "oauth_not_configured" });
  }
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  res.cookie(OAUTH_COOKIE, JSON.stringify({ state, verifier }), cookieOpts(10 * 60 * 1000));
  return res.redirect(buildAuthorizeUrl(state, challenge, cfg));
});

export async function handleCallback(req: Request, res: Response) {
  const cfg = oauthConfig();
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const oauthRaw = req.cookies?.[OAUTH_COOKIE];
  res.clearCookie(OAUTH_COOKIE, { path: "/" });

  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state || !oauthRaw) {
    return res.redirect("/?auth_error=missing_params");
  }

  let oauthData: { state: string; verifier: string };
  try {
    oauthData = JSON.parse(oauthRaw);
  } catch {
    return res.redirect("/?auth_error=bad_state");
  }
  if (oauthData.state !== state) {
    return res.redirect("/?auth_error=state_mismatch");
  }

  try {
    const tokens = await exchangeCodeForToken(code, oauthData.verifier, cfg);
    const session: Session = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      app_id: cfg.appId,
    };
    res.cookie(cfg.sessionCookieName, encryptSession(session), cookieOpts(SESSION_MAX_AGE_MS));
    return res.redirect("/");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "token_exchange_failed";
    return res.redirect(`/?auth_error=${encodeURIComponent(msg)}`);
  }
}

router.get("/me", (req, res) => {
  const session = readSession(req);
  res.json({ authenticated: Boolean(session), app_id: session?.app_id ?? null });
});

router.get("/token", async (req, res) => {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  try {
    const fresh = await ensureFresh(session, (s) =>
      res.cookie(oauthConfig().sessionCookieName, encryptSession(s), cookieOpts(SESSION_MAX_AGE_MS)),
    );
    return res.json({
      access_token: fresh.access_token,
      app_id: fresh.app_id,
      expires_at: fresh.expires_at,
    });
  } catch (err) {
    res.clearCookie(oauthConfig().sessionCookieName, { path: "/" });
    const msg = err instanceof Error ? err.message : "refresh_failed";
    return res.status(401).json({ error: msg });
  }
});

router.post("/refresh", async (req, res) => {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  try {
    const fresh = await ensureFresh(session, (s) =>
      res.cookie(oauthConfig().sessionCookieName, encryptSession(s), cookieOpts(SESSION_MAX_AGE_MS)),
    );
    return res.json({ access_token: fresh.access_token, app_id: fresh.app_id });
  } catch (err) {
    res.clearCookie(oauthConfig().sessionCookieName, { path: "/" });
    const msg = err instanceof Error ? err.message : "refresh_failed";
    return res.status(401).json({ error: msg });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie(oauthConfig().sessionCookieName, { path: "/" });
  res.json({ ok: true });
});

export default router;
