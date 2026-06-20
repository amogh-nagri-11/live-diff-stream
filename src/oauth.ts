import { randomBytes } from "node:crypto";

import { signToken } from "./auth.js";
import {
  createOAuthUser,
  findUserByEmail,
  findUserByProvider,
  toPublicUser,
  uniqueUsername,
  type AuthProvider,
} from "./users.js";

/**
 * OAuth (authorization-code) login for GitHub and Google. Credentials come
 * from the environment; a provider with no client id/secret is simply reported
 * as unconfigured so the UI can hide its button.
 *
 * The browser-facing origin is PUBLIC_URL (the frontend). OAuth callbacks are
 * routed back through the dev proxy at `${PUBLIC_URL}/api/auth/<provider>/callback`.
 */
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:5173").replace(/\/$/, "");

export type OAuthProvider = Exclude<AuthProvider, "local">;

interface ProviderConfig {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
};

/** Whether a provider has both a client id and secret configured. */
export function isConfigured(provider: OAuthProvider): boolean {
  const cfg = PROVIDERS[provider];
  return Boolean(cfg.clientId && cfg.clientSecret);
}

/** Map of which providers are usable, for the frontend to render buttons. */
export function configuredProviders(): Record<OAuthProvider, boolean> {
  return { github: isConfigured("github"), google: isConfigured("google") };
}

function redirectUri(provider: OAuthProvider): string {
  return `${PUBLIC_URL}/api/auth/${provider}/callback`;
}

/** Where the backend sends the browser once login succeeds or fails. */
export function appRedirect(params: Record<string, string>): string {
  const url = new URL(PUBLIC_URL + "/");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// Short-lived CSRF state store: state -> expiry (epoch ms). In-memory is fine
// for a single-process dev server; back this with a shared store if you scale out.
const stateStore = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function createState(): string {
  const state = randomBytes(16).toString("hex");
  stateStore.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state: string | null): boolean {
  if (!state) return false;
  const expiry = stateStore.get(state);
  stateStore.delete(state);
  return expiry !== undefined && expiry > Date.now();
}

/** Build the provider's authorize URL for the start of the flow. */
export function authorizeUrl(provider: OAuthProvider, state: string): string {
  const cfg = PROVIDERS[provider];
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId!);
  url.searchParams.set("redirect_uri", redirectUri(provider));
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (provider === "google") url.searchParams.set("access_type", "online");
  return url.toString();
}

interface NormalizedProfile {
  providerId: string;
  email: string | null;
  username: string;
  avatarUrl: string | null;
}

/** Exchange an authorization code for an access token. */
async function exchangeCode(provider: OAuthProvider, code: string): Promise<string> {
  const cfg = PROVIDERS[provider];
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: cfg.clientId!,
      client_secret: cfg.clientSecret!,
      code,
      redirect_uri: redirectUri(provider),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`token exchange failed: ${data.error ?? res.status}`);
  }
  return data.access_token;
}

/** Fetch and normalize the user profile from a provider. */
async function fetchProfile(
  provider: OAuthProvider,
  accessToken: string,
): Promise<NormalizedProfile> {
  const auth = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  if (provider === "github") {
    const user = (await (await fetch("https://api.github.com/user", { headers: auth })).json()) as {
      id: number;
      login: string;
      email: string | null;
      avatar_url: string | null;
    };
    let email = user.email;
    if (!email) {
      // Primary email may be private; the emails endpoint requires user:email.
      const emails = (await (
        await fetch("https://api.github.com/user/emails", { headers: auth })
      ).json()) as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    }
    return {
      providerId: String(user.id),
      email: email?.toLowerCase() ?? null,
      username: user.login,
      avatarUrl: user.avatar_url,
    };
  }

  // Google
  const info = (await (
    await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: auth })
  ).json()) as { sub: string; email?: string; name?: string; picture?: string };
  return {
    providerId: info.sub,
    email: info.email?.toLowerCase() ?? null,
    username: info.name ?? info.email?.split("@")[0] ?? "user",
    avatarUrl: info.picture ?? null,
  };
}

/**
 * Complete the callback: verify state, exchange the code, resolve the profile,
 * find-or-create the user, and return a signed JWT plus the public user.
 */
export async function handleCallback(
  provider: OAuthProvider,
  code: string | null,
  state: string | null,
): Promise<{ token: string }> {
  if (!isConfigured(provider)) throw new Error(`${provider} login is not configured`);
  if (!consumeState(state)) throw new Error("invalid or expired state");
  if (!code) throw new Error("missing authorization code");

  const accessToken = await exchangeCode(provider, code);
  const profile = await fetchProfile(provider, accessToken);

  // 1) Returning OAuth user.
  let row = findUserByProvider(provider, profile.providerId);
  // 2) Link to an existing account with the same (provider-verified) email.
  if (!row && profile.email) row = findUserByEmail(profile.email);
  // 3) Otherwise create a fresh account.
  if (!row) {
    row = createOAuthUser({
      provider,
      providerId: profile.providerId,
      username: uniqueUsername(profile.username),
      email: profile.email,
      avatarUrl: profile.avatarUrl,
    });
  }

  const user = toPublicUser(row);
  return { token: signToken(user.id, user.username) };
}
