import { stat } from "node:fs/promises";
import path from "node:path";

import express from "express";
import type { Request, Response } from "express";
import { WebSocket } from "ws";

import { queryDiffs } from "./db.js";
import {
  getSession,
  listSessions,
  startSession,
  stopSession,
  type BroadcastFn,
} from "./sessions.js";
import type { DiffEntry } from "./types.js";

/**
 * Fan a diff out to every subscribed client of its session. Closed/closing
 * sockets are skipped silently.
 */
export const broadcast: BroadcastFn = (sessionId, entry) => {
  const session = getSession(sessionId);
  if (!session) return;
  const payload = JSON.stringify({ type: "diff", entry });
  for (const socket of session.subscribers) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
};

export const app = express();
app.use(express.json());

/** Liveness probe. */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/** Create a watch session for a directory. */
app.post("/sessions", async (req: Request, res: Response) => {
  const { path: rawPath } = req.body ?? {};
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    res.status(400).json({ error: "body must include a non-empty 'path'" });
    return;
  }

  const rootPath = path.resolve(rawPath);
  try {
    const info = await stat(rootPath);
    if (!info.isDirectory()) {
      res.status(400).json({ error: `not a directory: ${rootPath}` });
      return;
    }
  } catch {
    res.status(400).json({ error: `path does not exist: ${rootPath}` });
    return;
  }

  const session = await startSession(rootPath, broadcast);
  res.status(201).json({
    id: session.id,
    rootPath: session.rootPath,
    wsUrl: `ws://${req.get("host")}/ws?session=${session.id}`,
  });
});

/** List active sessions. */
app.get("/sessions", (_req: Request, res: Response) => {
  const sessions = listSessions().map((s) => ({
    id: s.id,
    rootPath: s.rootPath,
    subscribers: s.subscribers.size,
    trackedFiles: s.fileSnapshots.size,
  }));
  res.json({ sessions });
});

/** Fetch recorded diffs for a session, oldest first. */
app.get("/sessions/:id/diffs", (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!getSession(id)) {
    res.status(404).json({ error: `no such session: ${id}` });
    return;
  }

  const since = parseIntParam(req.query.since, 0);
  const limit = parseIntParam(req.query.limit, 100);
  const diffs: DiffEntry[] = queryDiffs(id, since, limit);
  res.json({ diffs });
});

/** Stop and remove a session. */
app.delete("/sessions/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const stopped = await stopSession(id);
  if (!stopped) {
    res.status(404).json({ error: `no such session: ${id}` });
    return;
  }
  res.status(204).end();
});

/** Parse a numeric query param, falling back to `fallback` when absent/invalid. */
function parseIntParam(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
