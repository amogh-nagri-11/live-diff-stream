import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { DiffEntry, DiffEventType } from "./types.js";

/**
 * Path to the SQLite file; overridable for tests via env.
 *
 * The default lives in an OS temp directory rather than the current working
 * directory on purpose: the db (and its `-wal`/`-shm` sidecars) is a server
 * artifact, and if it sat inside a directory being watched it would trigger
 * diffs of its own writes — a self-amplifying feedback loop. Keeping it outside
 * any watchable tree avoids that entirely.
 */
const DB_PATH =
  process.env.LDS_DB_PATH ?? path.join(os.tmpdir(), "live-diff-stream", "diffs.db");

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db: DatabaseType = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS diffs (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    filepath      TEXT NOT NULL,
    event         TEXT NOT NULL,
    patch         TEXT NOT NULL,
    timestamp     INTEGER NOT NULL,
    lines_added   INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    is_git_tracked INTEGER NOT NULL DEFAULT 0,
    git_ref       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_diffs_session_ts
    ON diffs (session_id, timestamp);
`);

/** Shape of a row as stored in the diffs table. */
interface DiffRow {
  id: string;
  session_id: string;
  filepath: string;
  event: DiffEventType;
  patch: string;
  timestamp: number;
  lines_added: number;
  lines_removed: number;
  is_git_tracked: number;
  git_ref: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO diffs (
    id, session_id, filepath, event, patch, timestamp,
    lines_added, lines_removed, is_git_tracked, git_ref
  ) VALUES (
    @id, @session_id, @filepath, @event, @patch, @timestamp,
    @lines_added, @lines_removed, @is_git_tracked, @git_ref
  )
`);

const queryStmt = db.prepare(`
  SELECT * FROM diffs
  WHERE session_id = @session_id AND timestamp >= @since
  ORDER BY timestamp ASC
  LIMIT @limit
`);

const purgeStmt = db.prepare(`
  DELETE FROM diffs WHERE timestamp < @cutoff
`);

/** Convert a stored row back into a DiffEntry. */
function rowToEntry(row: DiffRow): DiffEntry {
  return {
    id: row.id,
    filepath: row.filepath,
    event: row.event,
    patch: row.patch,
    timestamp: row.timestamp,
    meta: {
      linesAdded: row.lines_added,
      linesRemoved: row.lines_removed,
      isGitTracked: row.is_git_tracked === 1,
      gitRef: row.git_ref,
    },
  };
}

/** Persist a diff for the given session. */
export function insertDiff(sessionId: string, entry: DiffEntry): void {
  insertStmt.run({
    id: entry.id,
    session_id: sessionId,
    filepath: entry.filepath,
    event: entry.event,
    patch: entry.patch,
    timestamp: entry.timestamp,
    lines_added: entry.meta.linesAdded,
    lines_removed: entry.meta.linesRemoved,
    is_git_tracked: entry.meta.isGitTracked ? 1 : 0,
    git_ref: entry.meta.gitRef,
  });
}

/**
 * Fetch diffs for a session in chronological order.
 * @param since  earliest timestamp (epoch ms) to include; defaults to 0.
 * @param limit  maximum rows to return; defaults to 100.
 */
export function queryDiffs(
  sessionId: string,
  since = 0,
  limit = 100,
): DiffEntry[] {
  const rows = queryStmt.all({
    session_id: sessionId,
    since,
    limit,
  }) as DiffRow[];
  return rows.map(rowToEntry);
}

/**
 * Delete diffs older than the given cutoff timestamp (epoch ms).
 * @returns number of rows removed.
 */
export function purgeDiffs(cutoff: number): number {
  return purgeStmt.run({ cutoff }).changes;
}
