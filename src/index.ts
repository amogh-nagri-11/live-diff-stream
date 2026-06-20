import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import express from "express";
import type { Request, Response } from "express";
import { WebSocket } from "ws";

import { queryDiffs } from "./db.js";
import {
  AuthError,
  login,
  register,
  requireAuth,
  type AuthedRequest,
} from "./auth.js";
import {
  appRedirect,
  authorizeUrl,
  configuredProviders,
  createState,
  handleCallback,
  isConfigured,
  type OAuthProvider,
} from "./oauth.js";
import {
  cloneRepo,
  getSession,
  isGitUrl,
  listSessions,
  readTree,
  resolveInRoot,
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

/** Register a new account and return a JWT. */
app.post("/auth/register", async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body ?? {};
    const result = await register(username, email, password);
    res.status(201).json(result);
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** Authenticate (by email) and return a JWT. */
app.post("/auth/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    const result = await login(email, password);
    res.json(result);
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** Return the currently authenticated user. */
app.get("/auth/me", requireAuth, (req: AuthedRequest, res: Response) => {
  res.json({ user: req.user });
});

/** Which OAuth providers are configured (so the UI can show only those). */
app.get("/auth/providers", (_req: Request, res: Response) => {
  res.json(configuredProviders());
});

/** Begin the OAuth flow: redirect the browser to the provider. */
app.get("/auth/:provider", (req: Request, res: Response, next) => {
  const provider = req.params.provider as OAuthProvider;
  if (provider !== "github" && provider !== "google") return next();
  if (!isConfigured(provider)) {
    res.status(503).json({ error: `${provider} login is not configured.` });
    return;
  }
  res.redirect(authorizeUrl(provider, createState()));
});

/** OAuth callback: complete login and bounce back to the app with a token. */
app.get("/auth/:provider/callback", async (req: Request, res: Response, next) => {
  const provider = req.params.provider as OAuthProvider;
  if (provider !== "github" && provider !== "google") return next();
  try {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const { token } = await handleCallback(provider, code, state);
    res.redirect(appRedirect({ token }));
  } catch (err) {
    console.error(`[oauth:${provider}]`, err);
    res.redirect(appRedirect({ error: "Sign-in failed. Please try again." }));
  }
});

/** Everything below requires a valid token. */
app.use("/sessions", requireAuth);

/**
 * Create a watch session. The `path` field may be either an absolute local
 * directory path or a remote git URL (https/ssh/git/scp-style). A URL is cloned
 * into a temp directory that is removed when the session is stopped.
 */
app.post("/sessions", async (req: Request, res: Response) => {
  const { path: rawPath } = req.body ?? {};
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    res.status(400).json({ error: "body must include a non-empty 'path'" });
    return;
  }
  const source = rawPath.trim();

  let rootPath: string;
  let cloneDir: string | undefined;

  if (isGitUrl(source)) {
    try {
      cloneDir = await cloneRepo(source);
      rootPath = cloneDir;
    } catch (err) {
      console.error("clone failed:", err);
      res.status(400).json({ error: `could not clone repository: ${source}` });
      return;
    }
  } else {
    rootPath = path.resolve(source);
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
  }

  const session = await startSession(rootPath, broadcast, { source, cloneDir });
  res.status(201).json({
    id: session.id,
    rootPath: session.rootPath,
    source: session.source,
    wsUrl: `ws://${req.get("host")}/ws?session=${session.id}`,
  });
});

/**
 * Browse the server's filesystem so the UI can offer a directory picker.
 * Browsers can't read absolute paths from a normal file input, so directory
 * selection is driven server-side. Returns the resolved directory, its parent
 * (null at the filesystem root), and its immediate sub-directories. Defaults to
 * the server user's home directory when no `path` is given.
 */
app.get("/sessions/browse", async (req: Request, res: Response) => {
  const raw = typeof req.query.path === "string" && req.query.path.trim() !== ""
    ? req.query.path
    : homedir();
  const dir = path.resolve(raw);

  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      res.status(400).json({ error: `not a directory: ${dir}` });
      return;
    }
    const items = await readdir(dir, { withFileTypes: true });
    const entries = items
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent === dir ? null : parent, entries });
  } catch {
    res.status(400).json({ error: `cannot read directory: ${dir}` });
  }
});

/** List active sessions. */
app.get("/sessions", (_req: Request, res: Response) => {
  const sessions = listSessions().map((s) => ({
    id: s.id,
    rootPath: s.rootPath,
    source: s.source,
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

/** The full file tree of a session's watched root (for the explorer sidebar). */
app.get("/sessions/:id/tree", async (req: Request, res: Response) => {
  const session = getSession(String(req.params.id));
  if (!session) {
    res.status(404).json({ error: `no such session: ${req.params.id}` });
    return;
  }
  const tree = await readTree(session.rootPath);
  res.json({ root: session.rootPath, source: session.source, tree });
});

/** Largest file we'll return whole to the viewer. */
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Read one file inside a session's root, for the "view whole file" panel. */
app.get("/sessions/:id/file", async (req: Request, res: Response) => {
  const session = getSession(String(req.params.id));
  if (!session) {
    res.status(404).json({ error: `no such session: ${req.params.id}` });
    return;
  }
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  if (rel.trim() === "") {
    res.status(400).json({ error: "missing 'path' query param" });
    return;
  }
  const abs = resolveInRoot(session.rootPath, rel);
  if (!abs) {
    res.status(400).json({ error: "path escapes the watched directory" });
    return;
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      res.status(400).json({ error: `not a file: ${rel}` });
      return;
    }
    if (info.size > MAX_FILE_BYTES) {
      res.json({ path: rel, content: null, tooLarge: true, size: info.size });
      return;
    }
    const content = await readFile(abs, "utf8");
    res.json({ path: rel, content, size: info.size });
  } catch {
    res.status(404).json({ error: `cannot read file: ${rel}` });
  }
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

/** Translate an AuthError (or unexpected error) into an HTTP response. */
function sendAuthError(res: Response, err: unknown): void {
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("auth error:", err);
  res.status(500).json({ error: "Internal error." });
}

/** Parse a numeric query param, falling back to `fallback` when absent/invalid. */
function parseIntParam(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
