// Google OAuth 2.0 (authorization code) helper. Credentials live only in env vars:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, (optional) GOOGLE_REDIRECT_URI
// The client secret is never sent to the browser.
//
// CSRF protection: the OAuth `state` parameter is an HMAC-signed nonce that is
// also stored in a short-lived HttpOnly cookie. The callback only accepts a
// state whose signature is valid AND whose nonce matches the cookie, so the
// authorization response must originate from a flow started by this site.
import crypto from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export const STATE_COOKIE = "yans_g_state";

function stateSecret() {
  // GOOGLE_STATE_SECRET is optional; the client secret is an acceptable fallback
  // because the state cookie and the state parameter never leave this origin.
  return process.env.GOOGLE_STATE_SECRET || process.env.GOOGLE_CLIENT_SECRET || "";
}

function sign(value) {
  return crypto.createHmac("sha256", stateSecret()).update(value).digest("base64url");
}

function parseCookies(req) {
  const header = req.headers.get("cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
    }
  });
  return out;
}

export function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(req, context) {
  const explicit = process.env.GOOGLE_REDIRECT_URI;
  if (explicit) return explicit;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("host") || req.headers.get("x-forwarded-host");
  const origin = host ? `${proto.split(",")[0].trim()}://${host}` : (context && context.site && context.site.url) || process.env.URL;
  return `${origin}/api/auth/google/callback`;
}

export function createState(req) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const secure = String(req.headers.get("x-forwarded-proto") || "https").includes("https") ? "; Secure" : "";
  return {
    value: `${nonce}.${sign(nonce)}`,
    cookie: `${STATE_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  };
}

export function verifyState(req, stateParam) {
  const cookieNonce = parseCookies(req)[STATE_COOKIE];
  if (!cookieNonce || !stateParam) return false;
  const state = String(stateParam);
  const dot = state.indexOf(".");
  if (dot <= 0) return false;
  const nonce = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (nonce !== cookieNonce) return false;
  const expected = sign(nonce);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function clearStateCookie() {
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function buildAuthUrl(req, context, stateValue) {
  if (!isGoogleConfigured()) return null;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req, context),
    response_type: "code",
    scope: "openid email profile",
    state: stateValue,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// Exchange the one-time authorization code for tokens (server-to-server).
export async function exchangeCode(code, req, context) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req, context),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error("google_token_exchange_failed");
  return res.json();
}

export async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("google_userinfo_failed");
  return res.json();
}
