/**
 * Auth client. Talks to the backend's /auth endpoints, persists the issued JWT
 * plus the user in localStorage, and exposes the token for authenticated API
 * and WebSocket calls. Also handles the OAuth redirect handoff.
 */
const STORAGE_KEY = "lds.auth";
const API_BASE = "/api";

export type AuthProvider = "local" | "github" | "google";

export interface User {
  id: string;
  username: string;
  email: string | null;
  provider: AuthProvider;
  avatarUrl: string | null;
  createdAt: number;
}

export interface Session {
  token: string;
  user: User;
}

function load(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function save(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function getSession(): Session | null {
  return load();
}

export function getToken(): string | null {
  return load()?.token ?? null;
}

export function signOut(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Fetch the user for a token (used after OAuth and to validate on load). */
async function fetchUser(token: string): Promise<User> {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { user?: User; error?: string };
  if (!res.ok || !body.user) throw new Error(body.error || "Could not load profile.");
  return body.user;
}

/** POST to an /auth endpoint and persist the returned session. */
async function authRequest(
  endpoint: "login" | "register",
  payload: Record<string, string>,
): Promise<Session> {
  const res = await fetch(`${API_BASE}/auth/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let body: { user?: User; token?: string; error?: string };
  try {
    body = await res.json();
  } catch {
    throw new Error(`Request failed (${res.status}).`);
  }

  if (!res.ok || !body.token || !body.user) {
    throw new Error(body.error || `Request failed (${res.status}).`);
  }

  const session: Session = { token: body.token, user: body.user };
  save(session);
  return session;
}

export function signIn(email: string, password: string): Promise<Session> {
  return authRequest("login", { email, password });
}

export function signUp(
  username: string,
  email: string,
  password: string,
): Promise<Session> {
  return authRequest("register", { username, email, password });
}

/** Which OAuth providers the backend has configured. */
export async function fetchProviders(): Promise<{ github: boolean; google: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/auth/providers`);
    if (!res.ok) return { github: false, google: false };
    return (await res.json()) as { github: boolean; google: boolean };
  } catch {
    return { github: false, google: false };
  }
}

/** Top-level navigation to begin an OAuth flow. */
export function startOAuth(provider: "github" | "google"): void {
  window.location.href = `${API_BASE}/auth/${provider}`;
}

/**
 * If the page was loaded as an OAuth redirect (`?token=` or `?error=`), consume
 * it: exchange the token for a session and strip the query from the URL.
 * Returns a session on success, an error message on failure, or null if this
 * wasn't an OAuth redirect.
 */
export async function consumeOAuthRedirect(): Promise<
  { session: Session } | { error: string } | null
> {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const error = params.get("error");
  if (!token && !error) return null;

  // Clean the URL so a refresh doesn't reprocess the redirect.
  window.history.replaceState({}, "", window.location.pathname);

  if (error) return { error };
  try {
    const user = await fetchUser(token!);
    const session: Session = { token: token!, user };
    save(session);
    return { session };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Sign-in failed." };
  }
}
