/** The kind of filesystem change that produced a diff. Mirrors the backend. */
export type DiffEventType = "add" | "change" | "unlink";

/** Metadata describing the nature of a single diff. */
export interface DiffMeta {
  linesAdded: number;
  linesRemoved: number;
  isGitTracked: boolean;
  gitRef: string | null;
}

/** A single recorded diff for a watched file. */
export interface DiffEntry {
  id: string;
  filepath: string;
  event: DiffEventType;
  patch: string;
  timestamp: number;
  meta: DiffMeta;
}

/** Summary of an active watch session, as returned by `GET /sessions`. */
export interface SessionSummary {
  id: string;
  rootPath: string;
  source: string;
  subscribers: number;
  trackedFiles: number;
}

/** Response from `POST /sessions`. */
export interface CreatedSession {
  id: string;
  rootPath: string;
  source: string;
  wsUrl: string;
}

/** A directory listing from `GET /sessions/browse`. */
export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
}

/** A node in the watched directory's file tree. */
export interface TreeNode {
  name: string;
  /** Path relative to the watch root, POSIX-style. */
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

/** Response from `GET /sessions/:id/tree`. */
export interface TreeResult {
  root: string;
  source: string;
  tree: TreeNode[];
}

/** Response from `GET /sessions/:id/file`. */
export interface FileContent {
  path: string;
  /** File text, or null when the file is too large to return. */
  content: string | null;
  tooLarge?: boolean;
  size?: number;
}

/** Messages pushed over the diff-stream WebSocket. */
export type ServerMessage =
  | { type: "connected"; sessionId: string }
  | { type: "diff"; entry: DiffEntry };
