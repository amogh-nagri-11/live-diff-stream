// Load .env before any other import, since db/auth/oauth read process.env at
// import time. Keep this first.
import "dotenv/config";

import http from "node:http";

import { WebSocketServer } from "ws";

import { app } from "./index.js";
import { verifyToken } from "./auth.js";
import { db, purgeDiffs } from "./db.js";
import { getSession, listSessions, stopSession } from "./sessions.js";

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

// Live diff stream. Clients connect to /ws?session=<id>&token=<jwt> and receive
// each recorded diff as JSON. Both the JWT and the session are validated during
// the HTTP upgrade handshake, so an unauthenticated or unknown request is
// rejected with a 4xx before any WebSocket is established. (Browsers can't set
// headers on a WebSocket, so the token travels as a query param.)
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (info, done) => {
    const token = queryParam(info.req, "token");
    if (!token || !verifyToken(token)) {
      done(false, 401, "missing or invalid token");
      return;
    }
    const sessionId = queryParam(info.req, "session");
    if (!sessionId) {
      done(false, 400, "missing 'session' query param");
      return;
    }
    if (!getSession(sessionId)) {
      done(false, 404, "unknown session");
      return;
    }
    done(true);
  },
});

wss.on("connection", (socket, req) => {
  // verifyClient already guaranteed the session exists; re-resolve it here and
  // bail gracefully on the rare chance it was deleted mid-handshake.
  const sessionId = queryParam(req, "session");
  const session = sessionId ? getSession(sessionId) : undefined;
  if (!session) {
    socket.close(1008, "session no longer exists");
    return;
  }

  session.subscribers.add(socket);
  socket.send(JSON.stringify({ type: "connected", sessionId: session.id }));

  socket.on("close", () => {
    session.subscribers.delete(socket);
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

  // Close every active watch session (also deregisters them).
  await Promise.all(listSessions().map((s) => stopSession(s.id)));

  db.close();
  console.log("shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
