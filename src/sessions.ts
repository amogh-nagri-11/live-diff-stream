import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
 * Whether `absPath` should be excluded from watching. Any path segment
 * (relative to the watch root) that is a dotfile/dotdir or one of
 * {@link IGNORED_DIRS} is ignored. The root itself is never excluded, so a
 * root that happens to live under a hidden directory still works.
 */
function isIgnored(rootPath: string, absPath: string): boolean {
  const rel = path.relative(rootPath, absPath);
  if (rel === "") return false;
  for (const segment of rel.split(path.sep)) {
    if (segment === "" || segment === ".") continue;
    if (segment.startsWith(".")) return true;
    if (IGNORED_DIRS.has(segment)) return true;
  }
  return false;
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
    id: randomUUID(),
    rootPath: absRoot,
    watcher,
    git: simpleGit(absRoot),
    subscribers: new Set(),
    fileSnapshots: new Map(),
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
): Promise<WatchSession> {
  const session = await createWatchSession(rootPath, broadcast);
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
