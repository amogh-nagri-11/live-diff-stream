import { randomUUID } from "node:crypto";

import { db } from "./db.js";

/**
 * User accounts live in the same SQLite database as diffs. Local accounts store
 * a bcrypt password hash; OAuth accounts (github/google) store an unusable
 * sentinel instead, since they authenticate through their provider.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email         TEXT,
    password_hash TEXT NOT NULL,
    provider      TEXT NOT NULL DEFAULT 'local',
    provider_id   TEXT,
    avatar_url    TEXT,
    created_at    INTEGER NOT NULL
  );
`);

// Migrate older databases that predate the email / OAuth columns.
const existingColumns = new Set(
  (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
for (const [column, ddl] of [
  ["email", "ALTER TABLE users ADD COLUMN email TEXT"],
  ["provider", "ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'"],
  ["provider_id", "ALTER TABLE users ADD COLUMN provider_id TEXT"],
  ["avatar_url", "ALTER TABLE users ADD COLUMN avatar_url TEXT"],
] as const) {
  if (!existingColumns.has(column)) db.exec(ddl);
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON users (email COLLATE NOCASE) WHERE email IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider
    ON users (provider, provider_id) WHERE provider_id IS NOT NULL;
`);

/** Sentinel password hash for OAuth accounts; never matches a real password. */
export const OAUTH_SENTINEL = "oauth:no-password";

export type AuthProvider = "local" | "github" | "google";

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  provider: AuthProvider;
  provider_id: string | null;
  avatar_url: string | null;
  created_at: number;
}

/** A user safe to expose to clients (no password hash). */
export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  provider: AuthProvider;
  avatarUrl: string | null;
  createdAt: number;
}

const insertStmt = db.prepare(`
  INSERT INTO users (
    id, username, email, password_hash, provider, provider_id, avatar_url, created_at
  ) VALUES (
    @id, @username, @email, @password_hash, @provider, @provider_id, @avatar_url, @created_at
  )
`);

const byUsernameStmt = db.prepare(
  `SELECT * FROM users WHERE username = ? COLLATE NOCASE`,
);
const byEmailStmt = db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`);
const byIdStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
const byProviderStmt = db.prepare(
  `SELECT * FROM users WHERE provider = ? AND provider_id = ?`,
);

/** Strip sensitive fields before sending a user to a client. */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    provider: row.provider,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  };
}

export function findUserByUsername(username: string): UserRow | undefined {
  return byUsernameStmt.get(username) as UserRow | undefined;
}

export function findUserByEmail(email: string): UserRow | undefined {
  return byEmailStmt.get(email) as UserRow | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return byIdStmt.get(id) as UserRow | undefined;
}

export function findUserByProvider(
  provider: AuthProvider,
  providerId: string,
): UserRow | undefined {
  return byProviderStmt.get(provider, providerId) as UserRow | undefined;
}

/** Pick a username that isn't taken, derived from `base`. */
export function uniqueUsername(base: string): string {
  const cleaned = base.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 28) || "user";
  if (!findUserByUsername(cleaned)) return cleaned;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${cleaned}${i}`;
    if (!findUserByUsername(candidate)) return candidate;
  }
  return `${cleaned}-${randomUUID().slice(0, 6)}`;
}

/** Create a local (password) account. */
export function createLocalUser(
  username: string,
  email: string,
  passwordHash: string,
): UserRow {
  const row: UserRow = {
    id: randomUUID(),
    username,
    email,
    password_hash: passwordHash,
    provider: "local",
    provider_id: null,
    avatar_url: null,
    created_at: Date.now(),
  };
  insertStmt.run(row);
  return row;
}

/** Create an account linked to an external OAuth identity. */
export function createOAuthUser(params: {
  provider: AuthProvider;
  providerId: string;
  username: string;
  email: string | null;
  avatarUrl: string | null;
}): UserRow {
  const row: UserRow = {
    id: randomUUID(),
    username: params.username,
    email: params.email,
    password_hash: OAUTH_SENTINEL,
    provider: params.provider,
    provider_id: params.providerId,
    avatar_url: params.avatarUrl,
    created_at: Date.now(),
  };
  insertStmt.run(row);
  return row;
}
