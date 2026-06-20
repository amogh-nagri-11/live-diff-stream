import { getToken } from "./auth";
import type {
  BrowseResult,
  CreatedSession,
  DiffEntry,
  FileContent,
  SessionSummary,
  TreeResult,
} from "../types";

// All requests go through the Vite dev proxy (see vite.config.ts), so the
// browser only ever talks to its own origin.
const API_BASE = "/api";

/** Build request headers, including the bearer token when signed in. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** Throw a useful error from a non-2xx response. */
async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string };
    detail = body.error ?? "";
  } catch {
    detail = await res.text().catch(() => "");
  }
  throw new Error(detail || `request failed (${res.status})`);
}

/**
 * Browse directories on the server's filesystem for the directory picker.
 * Pass no path to start at the server user's home directory.
 */
export async function browseDir(path?: string): Promise<BrowseResult> {
  const params = path ? `?${new URLSearchParams({ path })}` : "";
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/browse${params}`, {
      headers: authHeaders(),
    }),
  );
  return (await res.json()) as BrowseResult;
}

/** Create a watch session for an absolute directory path or a git repo URL. */
export async function createSession(path: string): Promise<CreatedSession> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path }),
    }),
  );
  return (await res.json()) as CreatedSession;
}

/** List currently active sessions. */
export async function listSessions(): Promise<SessionSummary[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions`, { headers: authHeaders() }),
  );
  const body = (await res.json()) as { sessions: SessionSummary[] };
  return body.sessions;
}

/** Fetch recorded diffs for a session, oldest first. */
export async function fetchDiffs(
  sessionId: string,
  since = 0,
  limit = 100,
): Promise<DiffEntry[]> {
  const params = new URLSearchParams({ since: String(since), limit: String(limit) });
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/diffs?${params}`, {
      headers: authHeaders(),
    }),
  );
  const body = (await res.json()) as { diffs: DiffEntry[] };
  return body.diffs;
}

/** Fetch the full file tree of a session's watched root. */
export async function fetchTree(sessionId: string): Promise<TreeResult> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/tree`, {
      headers: authHeaders(),
    }),
  );
  return (await res.json()) as TreeResult;
}

/** Fetch one file's contents from a session's watched root. */
export async function fetchFile(
  sessionId: string,
  filePath: string,
): Promise<FileContent> {
  const params = new URLSearchParams({ path: filePath });
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file?${params}`, {
      headers: authHeaders(),
    }),
  );
  return (await res.json()) as FileContent;
}

/** Stop and remove a session. */
export async function deleteSession(sessionId: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  );
}

/**
 * Build the WebSocket URL for a session. We construct it from the current
 * origin (proxied to the backend) rather than trusting the backend's `wsUrl`,
 * which is computed from its own host and would bypass the dev proxy. The JWT
 * travels as a query param because browsers can't set headers on a WebSocket.
 */
export function streamUrl(sessionId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const token = getToken() ?? "";
  const params = new URLSearchParams({ session: sessionId, token });
  return `${proto}://${window.location.host}/ws?${params}`;
}
