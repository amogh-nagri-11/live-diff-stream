import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import express from "express";
import type { Request, Response } from "express";

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
  isGitUrl,
  readTree,
  resolveInRoot,
} from "./sessions.js";
import {
  addComment,
  addMember,
  addMessage,
  createRoom,
  deleteRoom,
  getMember,
  getRoom,
  getRoomByCode,
  isMember,
  listComments,
  listMembers,
  listMessages,
  listRoomsForUser,
  removeMember,
  setRoomSource,
  type RoomRow,
} from "./rooms-store.js";
import {
  broadcast as broadcastRoom,
  getWatch,
  isLive,
  onlineUsers,
  startRoomWatch,
  stopRoomWatch,
} from "./rooms.js";
import { findUserByUsername, toPublicUser } from "./users.js";
import { rateLimit } from "./rate-limit.js";
import type { DiffEntry } from "./types.js";

export const app = express();
app.use(express.json());

/** Liveness probe. */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/**
 * Throttle credential endpoints to blunt brute-force / credential-stuffing.
 * Shared across login + register so an attacker can't dodge it by alternating.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please wait a few minutes and try again.",
});

/** Register a new account and return a JWT. */
app.post("/auth/register", authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body ?? {};
    const result = await register(username, email, password);
    res.status(201).json(result);
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** Authenticate (by email) and return a JWT. */
app.post("/auth/login", authLimiter, async (req: Request, res: Response) => {
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
app.use("/rooms", requireAuth);
app.use("/browse", requireAuth);

/** Largest file we'll return whole to the viewer. */
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Derive a friendly default room name from a path or git URL. */
function deriveRoomName(source: string): string {
  const trimmed = source.trim().replace(/\.git$/i, "").replace(/[/\\]+$/, "");
  const last = trimmed.split(/[/\\:]/).filter(Boolean).pop();
  return last || "Untitled room";
}

/** Public shape of a room for list views. */
function roomSummary(room: RoomRow, userId: string) {
  const member = getMember(room.id, userId);
  return {
    id: room.id,
    name: room.name,
    source: room.source,
    ownerId: room.owner_id,
    role: member?.role ?? "reviewer",
    live: isLive(room.id),
    memberCount: listMembers(room.id).length,
    createdAt: room.created_at,
  };
}

/** Full room detail, including members and (for the owner) the invite code. */
function roomDetail(room: RoomRow, userId: string) {
  const isOwner = room.owner_id === userId;
  const online = new Set(onlineUsers(room.id).map((u) => u.userId));
  return {
    ...roomSummary(room, userId),
    inviteCode: isOwner ? room.invite_code : undefined,
    members: listMembers(room.id).map((m) => ({
      ...m.user,
      role: m.role,
      online: online.has(m.user.id),
    })),
  };
}

/**
 * Resolve the room named by `:id` and enforce access. With `{ owner: true }`
 * the caller must be the host; otherwise any member suffices. Writes the error
 * response and returns null when access is denied.
 */
function requireRoom(
  req: AuthedRequest,
  res: Response,
  opts: { owner?: boolean } = {},
): RoomRow | null {
  const room = getRoom(String(req.params.id));
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return null;
  }
  const userId = req.user!.id;
  if (opts.owner) {
    if (room.owner_id !== userId) {
      res.status(403).json({ error: "only the host can do that" });
      return null;
    }
  } else if (!isMember(room.id, userId)) {
    res.status(403).json({ error: "you are not a member of this room" });
    return null;
  }
  return room;
}

/** Create a room. Watching starts later, on demand, via POST /rooms/:id/watch. */
app.post("/rooms", (req: AuthedRequest, res: Response) => {
  const { name, source } = req.body ?? {};
  if (typeof source !== "string" || source.trim() === "") {
    res.status(400).json({ error: "body must include a non-empty 'source'" });
    return;
  }
  const roomName =
    typeof name === "string" && name.trim() ? name.trim() : deriveRoomName(source);
  const room = createRoom(req.user!.id, roomName, source.trim());
  res.status(201).json(roomDetail(room, req.user!.id));
});

/** List the rooms the caller owns or has been invited to. */
app.get("/rooms", (req: AuthedRequest, res: Response) => {
  const rooms = listRoomsForUser(req.user!.id).map((r) =>
    roomSummary(r, req.user!.id),
  );
  res.json({ rooms });
});

/** Join a room via its share code, as a reviewer. */
app.post("/rooms/join", (req: AuthedRequest, res: Response) => {
  const { code } = req.body ?? {};
  if (typeof code !== "string" || code.trim() === "") {
    res.status(400).json({ error: "body must include a 'code'" });
    return;
  }
  const room = getRoomByCode(code.trim());
  if (!room) {
    res.status(404).json({ error: "invalid or expired invite code" });
    return;
  }
  if (room.owner_id !== req.user!.id) addMember(room.id, req.user!.id, "reviewer");
  res.status(200).json(roomDetail(room, req.user!.id));
});

/** Room detail (members only). */
app.get("/rooms/:id", (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res);
  if (!room) return;
  res.json(roomDetail(room, req.user!.id));
});

/** Delete a room and all its data (host only). Stops any live watch first. */
app.delete("/rooms/:id", async (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res, { owner: true });
  if (!room) return;
  await stopRoomWatch(room.id);
  deleteRoom(room.id);
  res.status(204).end();
});

/** Invite a registered user into a room by username (host only). */
app.post("/rooms/:id/members", (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res, { owner: true });
  if (!room) return;
  const { username } = req.body ?? {};
  if (typeof username !== "string" || username.trim() === "") {
    res.status(400).json({ error: "body must include a 'username'" });
    return;
  }
  const user = findUserByUsername(username.trim());
  if (!user) {
    res.status(404).json({ error: `no user named '${username.trim()}'` });
    return;
  }
  addMember(room.id, user.id, "reviewer");
  res.status(201).json({ member: toPublicUser(user) });
});

/** Leave a room, or (for the host) remove another member. */
app.delete("/rooms/:id/members/:userId", (req: AuthedRequest, res: Response) => {
  const room = getRoom(String(req.params.id));
  if (!room) {
    res.status(404).json({ error: "no such room" });
    return;
  }
  const me = req.user!.id;
  const target = String(req.params.userId);
  const isOwner = room.owner_id === me;
  if (!isOwner && target !== me) {
    res.status(403).json({ error: "you can only remove yourself" });
    return;
  }
  if (target === room.owner_id) {
    res.status(400).json({ error: "the host cannot leave their own room" });
    return;
  }
  removeMember(room.id, target);
  res.status(204).end();
});

/** Start watching for a room (host only). Clones a git URL if needed. */
app.post("/rooms/:id/watch", async (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res, { owner: true });
  if (!room) return;

  const override =
    typeof req.body?.source === "string" && req.body.source.trim()
      ? req.body.source.trim()
      : room.source;
  if (override !== room.source) setRoomSource(room.id, override);
  const source = override;

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

  await startRoomWatch(room.id, rootPath, { source, cloneDir });
  res.status(200).json({ live: true, source });
});

/** Stop watching for a room (host only). */
app.delete("/rooms/:id/watch", async (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res, { owner: true });
  if (!room) return;
  await stopRoomWatch(room.id);
  res.status(200).json({ live: false });
});

/** Recorded diff history for a room (members). */
app.get("/rooms/:id/diffs", (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res);
  if (!room) return;
  const since = parseIntParam(req.query.since, 0);
  const limit = parseIntParam(req.query.limit, 100);
  const diffs: DiffEntry[] = queryDiffs(room.id, since, limit);
  res.json({ diffs });
});

/** The watched file tree of a room (members). Requires a live watch. */
app.get("/rooms/:id/tree", async (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res);
  if (!room) return;
  const watch = getWatch(room.id);
  if (!watch) {
    res.status(409).json({ error: "the host is not watching right now", live: false });
    return;
  }
  const tree = await readTree(watch.rootPath);
  res.json({ root: watch.rootPath, source: watch.source, tree });
});

/** Read one file inside a room's watched root (members). */
app.get("/rooms/:id/file", async (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res);
  if (!room) return;
  const watch = getWatch(room.id);
  if (!watch) {
    res.status(409).json({ error: "the host is not watching right now", live: false });
    return;
  }
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  if (rel.trim() === "") {
    res.status(400).json({ error: "missing 'path' query param" });
    return;
  }
  const abs = resolveInRoot(watch.rootPath, rel);
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

/** Room chat history (members). */
app.get("/rooms/:id/messages", (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res);
  if (!room) return;
  res.json({ messages: listMessages(room.id) });
});

/** Post a chat message; persist and fan out over the room socket (members). */
app.post("/rooms/:id/messages", (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res);
  if (!room) return;
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) {
    res.status(400).json({ error: "body must include a non-empty 'body'" });
    return;
  }
  const message = addMessage(room.id, req.user!.id, body.slice(0, 4000));
  broadcastRoom(room.id, { type: "chat", message });
  res.status(201).json({ message });
});

/** File comments for a room, optionally filtered to one path (members). */
app.get("/rooms/:id/comments", (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res);
  if (!room) return;
  const path = typeof req.query.path === "string" ? req.query.path : null;
  const comments = listComments(room.id).filter(
    (c) => !path || c.filepath === path,
  );
  res.json({ comments });
});

/** Add a comment on a file; persist and fan out over the room socket. */
app.post("/rooms/:id/comments", (req: AuthedRequest, res: Response) => {
  const room = requireRoom(req, res);
  if (!room) return;
  const filepath = typeof req.body?.filepath === "string" ? req.body.filepath.trim() : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!filepath || !body) {
    res.status(400).json({ error: "body must include 'filepath' and 'body'" });
    return;
  }
  const comment = addComment(room.id, req.user!.id, filepath, body.slice(0, 4000));
  broadcastRoom(room.id, { type: "comment", comment });
  res.status(201).json({ comment });
});

/**
 * Browse the server's filesystem so the UI can offer a directory picker.
 * Returns the resolved directory, its parent (null at the filesystem root), and
 * its immediate sub-directories. Defaults to the server user's home directory.
 */
app.get("/browse", async (req: Request, res: Response) => {
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
