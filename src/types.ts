import type { FSWatcher } from "chokidar";
import type { SimpleGit } from "simple-git";
import type { WebSocket } from "ws";

/** The kind of filesystem change that produced a diff. */
export type DiffEventType = "add" | "change" | "unlink";

/** Metadata describing the nature of a single diff. */
export interface DiffMeta {
  linesAdded: number;
  linesRemoved: number;
  isGitTracked: boolean;
  /** Git ref the file was compared against, if any (e.g. "HEAD"). */
  gitRef: string | null;
}

/** A single recorded diff for a watched file. */
export interface DiffEntry {
  id: string;
  filepath: string;
  event: DiffEventType;
  /** Unified-diff patch text describing the change. */
  patch: string;
  /** Epoch milliseconds when the diff was produced. */
  timestamp: number;
  meta: DiffMeta;
}

/**
 * An active watch over a directory tree. Holds the runtime resources
 * (watcher, git, subscribers) plus the last-seen contents of each file
 * so subsequent changes can be diffed against them.
 */
export interface WatchSession {
  id: string;
  rootPath: string;
  watcher: FSWatcher;
  git: SimpleGit;
  /** Connected clients receiving diff events for this session. */
  subscribers: Set<WebSocket>;
  /** filepath -> last-known file contents, keyed by absolute path. */
  fileSnapshots: Map<string, string>;
}

/** Messages a client may send to the server over the WebSocket. */
export type ClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "history"; sessionId: string; since?: number; limit?: number };
