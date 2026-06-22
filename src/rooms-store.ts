import { randomBytes, randomUUID } from "node:crypto";

import { db } from "./db.js";
import { findUserById, toPublicUser, type PublicUser } from "./users.js";

/**
 * Rooms turn a watch session into a shared, persistent space: a host owns a
 * room, invites reviewers (by share code or username), and reviewers watch the
 * live diff stream while chatting and leaving comments. The room (and its
 * membership, chat, and comments) persists in SQLite; the live file watcher
 * itself is ephemeral and only runs while the host is actively watching.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    source      TEXT NOT NULL,
    invite_code TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id   TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    role      TEXT NOT NULL DEFAULT 'reviewer',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS room_messages (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_comments (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    filepath   TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_members_user ON room_members (user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_room ON room_messages (room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_comments_room ON room_comments (room_id, filepath, created_at);
`);

export type RoomRole = "owner" | "reviewer";

export interface RoomRow {
  id: string;
  owner_id: string;
  name: string;
  source: string;
  invite_code: string;
  created_at: number;
}

export interface MemberRow {
  room_id: string;
  user_id: string;
  role: RoomRole;
  joined_at: number;
}

export interface MessageRow {
  id: string;
  room_id: string;
  user_id: string;
  body: string;
  created_at: number;
}

export interface CommentRow {
  id: string;
  room_id: string;
  user_id: string;
  filepath: string;
  body: string;
  created_at: number;
}

/** A chat message or comment with its author resolved for the client. */
export interface AuthoredMessage {
  id: string;
  roomId: string;
  body: string;
  createdAt: number;
  author: PublicUser | null;
}
export interface AuthoredComment extends AuthoredMessage {
  filepath: string;
}

// ---- prepared statements -------------------------------------------------

const insertRoomStmt = db.prepare(`
  INSERT INTO rooms (id, owner_id, name, source, invite_code, created_at)
  VALUES (@id, @owner_id, @name, @source, @invite_code, @created_at)
`);
const roomByIdStmt = db.prepare(`SELECT * FROM rooms WHERE id = ?`);
const roomByCodeStmt = db.prepare(`SELECT * FROM rooms WHERE invite_code = ?`);
const deleteRoomStmt = db.prepare(`DELETE FROM rooms WHERE id = ?`);
const updateSourceStmt = db.prepare(`UPDATE rooms SET source = @source WHERE id = @id`);

const upsertMemberStmt = db.prepare(`
  INSERT INTO room_members (room_id, user_id, role, joined_at)
  VALUES (@room_id, @user_id, @role, @joined_at)
  ON CONFLICT (room_id, user_id) DO NOTHING
`);
const memberStmt = db.prepare(
  `SELECT * FROM room_members WHERE room_id = ? AND user_id = ?`,
);
const membersStmt = db.prepare(
  `SELECT * FROM room_members WHERE room_id = ? ORDER BY joined_at ASC`,
);
const deleteMemberStmt = db.prepare(
  `DELETE FROM room_members WHERE room_id = ? AND user_id = ?`,
);
const roomsForUserStmt = db.prepare(`
  SELECT r.* FROM rooms r
  JOIN room_members m ON m.room_id = r.id
  WHERE m.user_id = ?
  ORDER BY r.created_at DESC
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO room_messages (id, room_id, user_id, body, created_at)
  VALUES (@id, @room_id, @user_id, @body, @created_at)
`);
const messagesStmt = db.prepare(
  `SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at ASC LIMIT ?`,
);

const insertCommentStmt = db.prepare(`
  INSERT INTO room_comments (id, room_id, user_id, filepath, body, created_at)
  VALUES (@id, @room_id, @user_id, @filepath, @body, @created_at)
`);
const commentsStmt = db.prepare(
  `SELECT * FROM room_comments WHERE room_id = ? ORDER BY created_at ASC LIMIT ?`,
);

const deleteRoomMessagesStmt = db.prepare(`DELETE FROM room_messages WHERE room_id = ?`);
const deleteRoomCommentsStmt = db.prepare(`DELETE FROM room_comments WHERE room_id = ?`);
const deleteRoomMembersStmt = db.prepare(`DELETE FROM room_members WHERE room_id = ?`);

// ---- rooms ---------------------------------------------------------------

/** A short, URL-safe invite code for share links. */
function makeInviteCode(): string {
  return randomBytes(6).toString("base64url"); // ~8 chars
}

/** Create a room owned by `ownerId`, recording the owner as its first member. */
export function createRoom(
  ownerId: string,
  name: string,
  source: string,
): RoomRow {
  const room: RoomRow = {
    id: randomUUID(),
    owner_id: ownerId,
    name,
    source,
    invite_code: makeInviteCode(),
    created_at: Date.now(),
  };
  insertRoomStmt.run(room);
  upsertMemberStmt.run({
    room_id: room.id,
    user_id: ownerId,
    role: "owner",
    joined_at: room.created_at,
  });
  return room;
}

export function getRoom(id: string): RoomRow | undefined {
  return roomByIdStmt.get(id) as RoomRow | undefined;
}

export function getRoomByCode(code: string): RoomRow | undefined {
  return roomByCodeStmt.get(code) as RoomRow | undefined;
}

export function setRoomSource(id: string, source: string): void {
  updateSourceStmt.run({ id, source });
}

/** Delete a room and all of its membership, chat, and comment rows. */
export function deleteRoom(id: string): void {
  const tx = db.transaction((roomId: string) => {
    deleteRoomMessagesStmt.run(roomId);
    deleteRoomCommentsStmt.run(roomId);
    deleteRoomMembersStmt.run(roomId);
    deleteRoomStmt.run(roomId);
  });
  tx(id);
}

export function listRoomsForUser(userId: string): RoomRow[] {
  return roomsForUserStmt.all(userId) as RoomRow[];
}

// ---- membership ----------------------------------------------------------

/** Add a member (idempotent). Returns the resulting membership row. */
export function addMember(
  roomId: string,
  userId: string,
  role: RoomRole = "reviewer",
): MemberRow {
  upsertMemberStmt.run({
    room_id: roomId,
    user_id: userId,
    role,
    joined_at: Date.now(),
  });
  return getMember(roomId, userId)!;
}

export function getMember(roomId: string, userId: string): MemberRow | undefined {
  return memberStmt.get(roomId, userId) as MemberRow | undefined;
}

export function isMember(roomId: string, userId: string): boolean {
  return !!getMember(roomId, userId);
}

export function removeMember(roomId: string, userId: string): void {
  deleteMemberStmt.run(roomId, userId);
}

/** Members of a room, each with their public profile resolved. */
export function listMembers(
  roomId: string,
): { role: RoomRole; joinedAt: number; user: PublicUser }[] {
  const rows = membersStmt.all(roomId) as MemberRow[];
  return rows.flatMap((m) => {
    const u = findUserById(m.user_id);
    return u
      ? [{ role: m.role, joinedAt: m.joined_at, user: toPublicUser(u) }]
      : [];
  });
}

// ---- chat & comments -----------------------------------------------------

function authorOf(userId: string): PublicUser | null {
  const u = findUserById(userId);
  return u ? toPublicUser(u) : null;
}

export function addMessage(
  roomId: string,
  userId: string,
  body: string,
): AuthoredMessage {
  const row: MessageRow = {
    id: randomUUID(),
    room_id: roomId,
    user_id: userId,
    body,
    created_at: Date.now(),
  };
  insertMessageStmt.run(row);
  return {
    id: row.id,
    roomId,
    body,
    createdAt: row.created_at,
    author: authorOf(userId),
  };
}

export function listMessages(roomId: string, limit = 200): AuthoredMessage[] {
  const rows = messagesStmt.all(roomId, limit) as MessageRow[];
  return rows.map((r) => ({
    id: r.id,
    roomId,
    body: r.body,
    createdAt: r.created_at,
    author: authorOf(r.user_id),
  }));
}

export function addComment(
  roomId: string,
  userId: string,
  filepath: string,
  body: string,
): AuthoredComment {
  const row: CommentRow = {
    id: randomUUID(),
    room_id: roomId,
    user_id: userId,
    filepath,
    body,
    created_at: Date.now(),
  };
  insertCommentStmt.run(row);
  return {
    id: row.id,
    roomId,
    filepath,
    body,
    createdAt: row.created_at,
    author: authorOf(userId),
  };
}

export function listComments(roomId: string, limit = 500): AuthoredComment[] {
  const rows = commentsStmt.all(roomId, limit) as CommentRow[];
  return rows.map((r) => ({
    id: r.id,
    roomId,
    filepath: r.filepath,
    body: r.body,
    createdAt: r.created_at,
    author: authorOf(r.user_id),
  }));
}
