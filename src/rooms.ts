import { WebSocket } from "ws";

import {
  closeWatchSession,
  createWatchSession,
} from "./sessions.js";
import type { DiffEntry, WatchSession } from "./types.js";
import type { AuthoredComment, AuthoredMessage } from "./rooms-store.js";

/**
 * The live runtime for a room: the set of connected clients (for presence and
 * fan-out) and, when the host is actively watching, the underlying file-watch
 * session. A runtime exists only while a room is "in use" — at least one client
 * is connected or a watch is running — and is torn down when it goes idle. All
 * persistent state (membership, chat, comments, diff history) lives in SQLite.
 */
export interface ClientConn {
  socket: WebSocket;
  userId: string;
  username: string;
  avatarUrl: string | null;
}

export interface RoomRuntime {
  roomId: string;
  subscribers: Set<ClientConn>;
  watch: WatchSession | null;
}

/** A distinct user currently connected to a room. */
export interface PresenceUser {
  userId: string;
  username: string;
  avatarUrl: string | null;
}

/** Messages pushed to room clients over the WebSocket. */
export type RoomMessage =
  | { type: "diff"; entry: DiffEntry }
  | { type: "chat"; message: AuthoredMessage }
  | { type: "comment"; comment: AuthoredComment }
  | { type: "presence"; online: PresenceUser[] }
  | { type: "watch"; live: boolean };

const runtimes = new Map<string, RoomRuntime>();

function ensureRuntime(roomId: string): RoomRuntime {
  let rt = runtimes.get(roomId);
  if (!rt) {
    rt = { roomId, subscribers: new Set(), watch: null };
    runtimes.set(roomId, rt);
  }
  return rt;
}

/** Drop a runtime once nobody is connected and nothing is being watched. */
function maybeCleanup(rt: RoomRuntime): void {
  if (rt.subscribers.size === 0 && !rt.watch) runtimes.delete(rt.roomId);
}

export function isLive(roomId: string): boolean {
  return !!runtimes.get(roomId)?.watch;
}

export function getWatch(roomId: string): WatchSession | undefined {
  return runtimes.get(roomId)?.watch ?? undefined;
}

/** The distinct users currently connected to a room (deduped across tabs). */
export function onlineUsers(roomId: string): PresenceUser[] {
  const rt = runtimes.get(roomId);
  if (!rt) return [];
  const byId = new Map<string, PresenceUser>();
  for (const c of rt.subscribers) {
    byId.set(c.userId, {
      userId: c.userId,
      username: c.username,
      avatarUrl: c.avatarUrl,
    });
  }
  return [...byId.values()];
}

/** Send a message to every connected client of a room. */
export function broadcast(roomId: string, msg: RoomMessage): void {
  const rt = runtimes.get(roomId);
  if (!rt) return;
  const payload = JSON.stringify(msg);
  for (const c of rt.subscribers) {
    if (c.socket.readyState === WebSocket.OPEN) c.socket.send(payload);
  }
}

/** Register a connected client and announce updated presence. */
export function addSubscriber(roomId: string, conn: ClientConn): void {
  const rt = ensureRuntime(roomId);
  rt.subscribers.add(conn);
  broadcast(roomId, { type: "presence", online: onlineUsers(roomId) });
}

/** Remove a connected client, announce presence, and clean up if idle. */
export function removeSubscriber(roomId: string, conn: ClientConn): void {
  const rt = runtimes.get(roomId);
  if (!rt) return;
  rt.subscribers.delete(conn);
  broadcast(roomId, { type: "presence", online: onlineUsers(roomId) });
  maybeCleanup(rt);
}

/**
 * Start watching `rootPath` for a room. Diffs are persisted (keyed by room id,
 * handled inside the watch session) and fanned out to connected clients. A
 * no-op returning the existing session if the room is already live.
 */
export async function startRoomWatch(
  roomId: string,
  rootPath: string,
  opts: { source?: string; cloneDir?: string } = {},
): Promise<WatchSession> {
  const rt = ensureRuntime(roomId);
  if (rt.watch) return rt.watch;
  const session = await createWatchSession(
    rootPath,
    (_sessionId, entry) => broadcast(roomId, { type: "diff", entry }),
    { id: roomId, source: opts.source, cloneDir: opts.cloneDir },
  );
  rt.watch = session;
  broadcast(roomId, { type: "watch", live: true });
  return session;
}

/** Stop a room's watch (closing the watcher and removing any clone). */
export async function stopRoomWatch(roomId: string): Promise<boolean> {
  const rt = runtimes.get(roomId);
  if (!rt?.watch) return false;
  await closeWatchSession(rt.watch);
  rt.watch = null;
  broadcast(roomId, { type: "watch", live: false });
  maybeCleanup(rt);
  return true;
}

/** Stop every active watch (used on graceful shutdown). */
export async function stopAllRoomWatches(): Promise<void> {
  await Promise.all(
    [...runtimes.values()]
      .filter((rt) => rt.watch)
      .map((rt) => stopRoomWatch(rt.roomId)),
  );
}
