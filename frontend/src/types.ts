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

/** A directory listing from `GET /browse`. */
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

/** Response from `GET /rooms/:id/tree`. */
export interface TreeResult {
  root: string;
  source: string;
  tree: TreeNode[];
}

/** Response from `GET /rooms/:id/file`. */
export interface FileContent {
  path: string;
  /** File text, or null when the file is too large to return. */
  content: string | null;
  tooLarge?: boolean;
  size?: number;
}

// ---- rooms ---------------------------------------------------------------

export type RoomRole = "owner" | "reviewer";

/** A room as it appears in the lobby list. */
export interface RoomSummary {
  id: string;
  name: string;
  source: string;
  ownerId: string;
  role: RoomRole;
  live: boolean;
  memberCount: number;
  createdAt: number;
}

/** A member of a room (public profile + role + live presence). */
export interface RoomMember {
  id: string;
  username: string;
  email: string | null;
  provider: string;
  avatarUrl: string | null;
  createdAt: number;
  role: RoomRole;
  online: boolean;
}

/** Full room detail, including members and (for the host) the invite code. */
export interface RoomDetail extends RoomSummary {
  inviteCode?: string;
  members: RoomMember[];
}

/** The author of a chat message or comment. */
export interface Author {
  id: string;
  username: string;
  avatarUrl: string | null;
}

/** A room chat message. */
export interface ChatMessage {
  id: string;
  roomId: string;
  body: string;
  createdAt: number;
  author: Author | null;
}

/** A comment left on a specific file. */
export interface FileComment extends ChatMessage {
  filepath: string;
}

/** A user currently connected to a room. */
export interface PresenceUser {
  userId: string;
  username: string;
  avatarUrl: string | null;
}

/** Messages pushed over the room WebSocket. */
export type RoomServerMessage =
  | { type: "diff"; entry: DiffEntry }
  | { type: "chat"; message: ChatMessage }
  | { type: "comment"; comment: FileComment }
  | { type: "presence"; online: PresenceUser[] }
  | { type: "watch"; live: boolean };
