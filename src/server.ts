// Load .env before any other import, since db/auth/oauth read process.env at
// import time. Keep this first.
import "dotenv/config";

import http from "node:http";

import { WebSocketServer } from "ws";

import { app } from "./index.js";
import { verifyToken } from "./auth.js";
import { db, purgeDiffs } from "./db.js";
import { getRoom, isMember } from "./rooms-store.js";
import {
  addSubscriber,
  isLive,
  removeSubscriber,
  stopAllRoomWatches,
  type ClientConn,
} from "./rooms.js";
import { findUserById } from "./users.js";

const PORT = Number(process.env.PORT ?? 4400);

/** How often to sweep stale diffs, and how old a diff may get before removal. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const MAX_DIFF_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const server = http.createServer(app);

/** Extract a named query param from an upgrade/connection request. */
function queryParam(
  req: { url?: string; headers: { host?: string } },
  name: string,
): string | null {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  return url.searchParams.get(name);
}

// Live room stream. Clients connect to /ws?room=<id>&token=<jwt> and receive
// presence, diff, chat, and comment messages as JSON. The JWT, the room, and
// the caller's membership are all validated during the HTTP upgrade handshake,
// so a request from a non-member is rejected with a 4xx before any WebSocket is
// established. (Browsers can't set headers on a WebSocket, so the token travels
// as a query param.)
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (info, done) => {
    const token = queryParam(info.req, "token");
    const payload = token ? verifyToken(token) : null;
    if (!payload) {
      done(false, 401, "missing or invalid token");
      return;
    }
    const roomId = queryParam(info.req, "room");
    if (!roomId) {
      done(false, 400, "missing 'room' query param");
      return;
    }
    const room = getRoom(roomId);
    if (!room) {
      done(false, 404, "unknown room");
      return;
    }
    if (!isMember(roomId, payload.sub)) {
      done(false, 403, "not a member of this room");
      return;
    }
    done(true);
  },
});

wss.on("connection", (socket, req) => {
  // verifyClient already validated token, room, and membership; re-resolve here
  // and bail gracefully on the rare chance the room was deleted mid-handshake.
  const token = queryParam(req, "token");
  const roomId = queryParam(req, "room");
  const payload = token ? verifyToken(token) : null;
  if (!roomId || !payload || !getRoom(roomId)) {
    socket.close(1008, "room no longer exists");
    return;
  }
  const user = findUserById(payload.sub);
  if (!user) {
    socket.close(1008, "account no longer exists");
    return;
  }

  const conn: ClientConn = {
    socket,
    userId: user.id,
    username: user.username,
    avatarUrl: user.avatar_url,
  };
  addSubscriber(roomId, conn);
  // Tell the newcomer the current watch state straight away (presence is
  // broadcast to everyone by addSubscriber).
  socket.send(JSON.stringify({ type: "watch", live: isLive(roomId) }));

  socket.on("close", () => {
    removeSubscriber(roomId, conn);
  });
});

// Periodically discard diffs older than the retention window.
const purgeTimer = setInterval(() => {
  const removed = purgeDiffs(Date.now() - MAX_DIFF_AGE_MS);
  if (removed > 0) console.log(`purged ${removed} stale diff(s)`);
}, PURGE_INTERVAL_MS);
purgeTimer.unref();

server.listen(PORT, () => {
  console.log(`live-diff-stream listening on http://localhost:${PORT}`);
});

let shuttingDown = false;

/**
 * Gracefully tear down on SIGINT: stop the purge timer, stop accepting new
 * connections, close every watcher, then close the database before exiting.
 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nshutting down...");

  clearInterval(purgeTimer);

  // Stop accepting new HTTP connections; drop live WebSocket clients.
  server.close();
  wss.close();

  // Close every active room watch (also removes any temp clones).
  await stopAllRoomWatches();

  db.close();
  console.log("shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
