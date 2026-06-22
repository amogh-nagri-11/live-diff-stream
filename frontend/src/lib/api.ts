import { getToken } from "./auth";
import type {
  BrowseResult,
  ChatMessage,
  DiffEntry,
  FileComment,
  FileContent,
  RoomDetail,
  RoomMember,
  RoomSummary,
  TreeResult,
} from "../types";

// All requests go through the Vite dev proxy (see vite.config.ts), so the
// browser only ever talks to its own origin.
const API_BASE = "/api";

/** An HTTP error carrying the response status, so callers can branch on it. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

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
  throw new ApiError(res.status, detail || `request failed (${res.status})`);
}

function jsonHeaders(): Record<string, string> {
  return authHeaders({ "Content-Type": "application/json" });
}

async function getJson<T>(url: string): Promise<T> {
  const res = await ensureOk(await fetch(url, { headers: authHeaders() }));
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await ensureOk(
    await fetch(url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(body ?? {}),
    }),
  );
  return (await res.json()) as T;
}

// ---- filesystem browse ---------------------------------------------------

/** Browse directories on the server's filesystem for the directory picker. */
export async function browseDir(path?: string): Promise<BrowseResult> {
  const params = path ? `?${new URLSearchParams({ path })}` : "";
  return getJson<BrowseResult>(`${API_BASE}/browse${params}`);
}

// ---- rooms ---------------------------------------------------------------

/** List rooms the current user owns or has been invited to. */
export async function listRooms(): Promise<RoomSummary[]> {
  const body = await getJson<{ rooms: RoomSummary[] }>(`${API_BASE}/rooms`);
  return body.rooms;
}

/** Create a room for a local directory path or git repo URL. */
export async function createRoom(
  source: string,
  name?: string,
): Promise<RoomDetail> {
  return postJson<RoomDetail>(`${API_BASE}/rooms`, { source, name });
}

/** Fetch full detail for a room. */
export async function fetchRoom(roomId: string): Promise<RoomDetail> {
  return getJson<RoomDetail>(`${API_BASE}/rooms/${roomId}`);
}

/** Join a room via its share code. Returns the room detail. */
export async function joinRoom(code: string): Promise<RoomDetail> {
  return postJson<RoomDetail>(`${API_BASE}/rooms/join`, { code });
}

/** Delete a room (host only). */
export async function deleteRoom(roomId: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/rooms/${roomId}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  );
}

/** Invite a registered user into a room by username (host only). */
export async function inviteMember(
  roomId: string,
  username: string,
): Promise<RoomMember> {
  const body = await postJson<{ member: RoomMember }>(
    `${API_BASE}/rooms/${roomId}/members`,
    { username },
  );
  return body.member;
}

/** Remove a member, or leave the room when removing yourself. */
export async function removeMember(
  roomId: string,
  userId: string,
): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/rooms/${roomId}/members/${userId}`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  );
}

/** Start watching for a room (host only). Optional source overrides the room's. */
export async function startWatch(
  roomId: string,
  source?: string,
): Promise<{ live: boolean; source: string }> {
  return postJson(`${API_BASE}/rooms/${roomId}/watch`, source ? { source } : {});
}

/** Stop watching for a room (host only). */
export async function stopWatch(roomId: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/rooms/${roomId}/watch`, {
      method: "DELETE",
      headers: authHeaders(),
    }),
  );
}

/** The watched file tree of a room (requires a live watch). */
export async function fetchTree(roomId: string): Promise<TreeResult> {
  return getJson<TreeResult>(`${API_BASE}/rooms/${roomId}/tree`);
}

/** One file's contents from a room's watched root. */
export async function fetchFile(
  roomId: string,
  filePath: string,
): Promise<FileContent> {
  const params = new URLSearchParams({ path: filePath });
  return getJson<FileContent>(`${API_BASE}/rooms/${roomId}/file?${params}`);
}

/** Recorded diff history for a room. */
export async function fetchDiffs(
  roomId: string,
  since = 0,
  limit = 200,
): Promise<DiffEntry[]> {
  const params = new URLSearchParams({ since: String(since), limit: String(limit) });
  const body = await getJson<{ diffs: DiffEntry[] }>(
    `${API_BASE}/rooms/${roomId}/diffs?${params}`,
  );
  return body.diffs;
}

// ---- chat & comments -----------------------------------------------------

export async function fetchMessages(roomId: string): Promise<ChatMessage[]> {
  const body = await getJson<{ messages: ChatMessage[] }>(
    `${API_BASE}/rooms/${roomId}/messages`,
  );
  return body.messages;
}

export async function postMessage(
  roomId: string,
  text: string,
): Promise<ChatMessage> {
  const body = await postJson<{ message: ChatMessage }>(
    `${API_BASE}/rooms/${roomId}/messages`,
    { body: text },
  );
  return body.message;
}

export async function fetchComments(roomId: string): Promise<FileComment[]> {
  const body = await getJson<{ comments: FileComment[] }>(
    `${API_BASE}/rooms/${roomId}/comments`,
  );
  return body.comments;
}

export async function postComment(
  roomId: string,
  filepath: string,
  text: string,
): Promise<FileComment> {
  const body = await postJson<{ comment: FileComment }>(
    `${API_BASE}/rooms/${roomId}/comments`,
    { filepath, body: text },
  );
  return body.comment;
}

// ---- websocket -----------------------------------------------------------

/**
 * Build the WebSocket URL for a room. Constructed from the current origin
 * (proxied to the backend) so the dev proxy applies. The JWT travels as a query
 * param because browsers can't set headers on a WebSocket.
 */
export function roomStreamUrl(roomId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const token = getToken() ?? "";
  const params = new URLSearchParams({ room: roomId, token });
  return `${proto}://${window.location.host}/ws?${params}`;
}
