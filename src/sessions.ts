import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import chokidar from "chokidar";
import { createTwoFilesPatch } from "diff";
import { simpleGit } from "simple-git";

import { insertDiff } from "./db.js";
import type {
  DiffEntry,
  DiffEventType,
  WatchSession,
} from "./types.js";

/** Callback invoked with each newly recorded diff so it can be fanned out. */
export type BroadcastFn = (sessionId: string, entry: DiffEntry) => void;

/** Directory names that are never watched, at any depth. */
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git"]);

/**
 * Filenames that are never watched. SQLite databases (and their `-wal`/`-shm`
 * sidecars) are binary server artifacts; diffing them as text produces huge,
 * meaningless patches and — when the db lives inside the watched tree — a
 * self-amplifying feedback loop as the server's own writes trigger more diffs.
 */
const IGNORED_FILE_RE = /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i;

/**
 * Whether `absPath` should be excluded from watching. Any path segment
 * (relative to the watch root) that is a dotfile/dotdir or one of
 * {@link IGNORED_DIRS} is ignored, as is any file matching
 * {@link IGNORED_FILE_RE}. The root itself is never excluded, so a root that
 * happens to live under a hidden directory still works.
 */
function isIgnored(rootPath: string, absPath: string): boolean {
  const rel = path.relative(rootPath, absPath);
  if (rel === "") return false;
  if (IGNORED_FILE_RE.test(path.basename(absPath))) return true;
  for (const segment of rel.split(path.sep)) {
    if (segment === "" || segment === ".") continue;
    if (segment.startsWith(".")) return true;
    if (IGNORED_DIRS.has(segment)) return true;
  }
  return false;
}

/**
 * Recognise the input as a remote git URL we should clone rather than a local
 * directory path. Covers `https://`, `http://`, `git://`, `ssh://`, and the
 * scp-style `git@host:owner/repo` form that GitHub offers for SSH.
 */
export function isGitUrl(input: string): boolean {
  const s = input.trim();
  return (
    /^(https?|git|ssh):\/\//i.test(s) ||
    /^[^/\s]+@[^/\s]+:.+/.test(s) // scp-style: user@host:path
  );
}

/**
 * Clone `url` (shallow, default branch) into a fresh temp directory and return
 * its path. The caller owns the directory and must delete it when done — this
 * is recorded as the session's {@link WatchSession.cloneDir}.
 */
export async function cloneRepo(url: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "live-diff-clone-"));
  try {
    await simpleGit().clone(url, dir, ["--depth", "1"]);
    return dir;
  } catch (err) {
    // Don't leak the temp dir if the clone failed partway through.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** A node in the watched directory's file tree. */
export interface TreeNode {
  name: string;
  /** Path relative to the watch root, POSIX-style (`/` separators). */
  path: string;
  type: "file" | "dir";
  /** Present for directories; the sorted child nodes. */
  children?: TreeNode[];
}

/**
 * Recursively read `rootPath` into a tree, applying the same ignore rules as
 * the watcher (dotfiles, `node_modules`, `dist`, `.git`, db sidecars). Within
 * each directory, sub-directories sort before files, both alphabetically.
 */
export async function readTree(rootPath: string): Promise<TreeNode[]> {
  async function walk(dir: string): Promise<TreeNode[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (isIgnored(rootPath, abs)) continue;
      const rel = path.relative(rootPath, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: rel, type: "dir", children: await walk(abs) });
      } else if (e.isFile()) {
        nodes.push({ name: e.name, path: rel, type: "file" });
      }
    }
    nodes.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
    return nodes;
  }
  return walk(rootPath);
}

/**
 * Resolve `relPath` against `rootPath`, returning the absolute path only if it
 * stays inside the root. Returns null on any attempt to escape (`..`, absolute
 * paths, symlink-style tricks via `path.relative`).
 */
export function resolveInRoot(rootPath: string, relPath: string): string | null {
  const abs = path.resolve(rootPath, relPath);
  const rel = path.relative(rootPath, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

/** Read a file, treating any failure (e.g. it vanished) as empty content. */
async function readFileSafe(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

/** Whether `relPath` is tracked in the session's git working tree. */
async function isGitTracked(
  git: WatchSession["git"],
  relPath: string,
): Promise<boolean> {
  try {
    await git.raw(["ls-files", "--error-unmatch", "--", relPath]);
    return true;
  } catch {
    // Not tracked, or not a git repository at all.
    return false;
  }
}

/**
 * Largest patch (in bytes) we'll stream. A single oversized diff — e.g. a
 * generated bundle or an accidentally-watched binary — would otherwise exceed
 * the WebSocket max-payload limit and tear down the whole client connection.
 * Past this size we replace the patch with a short placeholder instead.
 */
const MAX_PATCH_BYTES = 1024 * 1024; // 1 MiB

/** Count added/removed lines in a unified-diff patch, ignoring its headers. */
function countLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

/**
 * Produce a diff for a single filesystem event.
 *
 * Strategy: if the file is git-tracked, diff the working tree against HEAD via
 * simple-git. Otherwise fall back to diffing the in-memory snapshot of the
 * last-known contents against the current contents using {@link createTwoFilesPatch}.
 * The snapshot map is updated as a side effect so the next change has a baseline.
 */
async function computeDiff(
  session: WatchSession,
  event: DiffEventType,
  absPath: string,
): Promise<DiffEntry> {
  const relPath = path.relative(session.rootPath, absPath);
  const current = event === "unlink" ? "" : await readFileSafe(absPath);

  let patch: string;
  let gitRef: string | null;
  const tracked = await isGitTracked(session.git, relPath);

  if (tracked) {
    // Working-tree changes relative to the last commit. For an unlink this
    // surfaces as a deletion; for add/change as the pending modification.
    patch = await session.git.diff(["HEAD", "--", relPath]);
    gitRef = "HEAD";
  } else {
    const previous = session.fileSnapshots.get(absPath) ?? "";
    patch = createTwoFilesPatch(relPath, relPath, previous, current);
    gitRef = null;
  }

  // Keep the snapshot baseline current for the fallback path.
  if (event === "unlink") session.fileSnapshots.delete(absPath);
  else session.fileSnapshots.set(absPath, current);

  const { added, removed } = countLines(patch);

  // Guard against a single huge diff blowing past the WebSocket payload limit
  // and dropping the client. Report the change without the full body.
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    patch =
      `Index: ${relPath}\n` +
      `=================================================================` +
      `\n# diff omitted: patch exceeds ${MAX_PATCH_BYTES} bytes ` +
      `(+${added} -${removed} lines)\n`;
  }
  return {
    id: randomUUID(),
    filepath: relPath,
    event,
    patch,
    timestamp: Date.now(),
    meta: {
      linesAdded: added,
      linesRemoved: removed,
      isGitTracked: tracked,
      gitRef,
    },
  };
}

/**
 * Compute, persist, and broadcast a diff for one filesystem event. Errors are
 * logged rather than thrown so a single bad file never tears down the watcher.
 */
async function handleEvent(
  session: WatchSession,
  event: DiffEventType,
  absPath: string,
  broadcast: BroadcastFn,
): Promise<void> {
  try {
    const entry = await computeDiff(session, event, absPath);
    insertDiff(session.id, entry);
    broadcast(session.id, entry);
  } catch (err) {
    console.error(
      `[session ${session.id}] failed to process ${event} for ${absPath}:`,
      err,
    );
  }
}

/**
 * Begin watching `rootPath` for file add/change/unlink events, recording a diff
 * for each and forwarding it to `broadcast`. Resolves once the initial scan has
 * completed and the watcher is ready.
 *
 * Dotfiles/dotdirs, `node_modules`, `dist`, and `.git` are excluded. Editors
 * that write in chunks are handled via chokidar's `awaitWriteFinish`.
 */
export async function createWatchSession(
  rootPath: string,
  broadcast: BroadcastFn,
  opts: { id?: string; source?: string; cloneDir?: string } = {},
): Promise<WatchSession> {
  const absRoot = path.resolve(rootPath);
  const watcher = chokidar.watch(absRoot, {
    ignored: (p) => isIgnored(absRoot, p),
    // Don't replay a diff for every pre-existing file on startup; only react
    // to changes from here on. Snapshots fill in lazily on first change.
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  const session: WatchSession = {
    id: opts.id ?? randomUUID(),
    rootPath: absRoot,
    watcher,
    git: simpleGit(absRoot),
    subscribers: new Set(),
    fileSnapshots: new Map(),
    cloneDir: opts.cloneDir,
    source: opts.source ?? absRoot,
  };

  const events: DiffEventType[] = ["add", "change", "unlink"];
  for (const event of events) {
    watcher.on(event, (filePath: string) => {
      void handleEvent(session, event, filePath, broadcast);
    });
  }

  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", resolve);
    watcher.once("error", reject);
  });

  return session;
}

/** Stop watching and release the session's resources. */
export async function closeWatchSession(session: WatchSession): Promise<void> {
  await session.watcher.close();
  session.subscribers.clear();
  session.fileSnapshots.clear();
  // If we cloned this repo ourselves, remove the temp checkout. Best-effort:
  // a failure here shouldn't keep the session registered.
  if (session.cloneDir) {
    await rm(session.cloneDir, { recursive: true, force: true }).catch((err) => {
      console.error(`[session ${session.id}] failed to remove clone dir:`, err);
    });
  }
}

/** In-memory registry of active sessions, keyed by id. */
const registry = new Map<string, WatchSession>();

/** Look up an active session by id. */
export function getSession(id: string): WatchSession | undefined {
  return registry.get(id);
}

/** All currently active sessions. */
export function listSessions(): WatchSession[] {
  return [...registry.values()];
}

/** Create a watch session and register it as active. */
export async function startSession(
  rootPath: string,
  broadcast: BroadcastFn,
  opts: { source?: string; cloneDir?: string } = {},
): Promise<WatchSession> {
  const session = await createWatchSession(rootPath, broadcast, opts);
  registry.set(session.id, session);
  return session;
}

/** Stop and deregister a session. Returns false if no such session existed. */
export async function stopSession(id: string): Promise<boolean> {
  const session = registry.get(id);
  if (!session) return false;
  await closeWatchSession(session);
  registry.delete(id);
  return true;
}
