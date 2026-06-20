import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import {
  createLocalUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  toPublicUser,
  type PublicUser,
} from "./users.js";

const BCRYPT_ROUNDS = 12;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * JWT signing secret. Provide JWT_SECRET in any real deployment — without it we
 * fall back to a random per-process secret, which is safe but invalidates all
 * tokens whenever the server restarts.
 */
const JWT_SECRET: string = process.env.JWT_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn(
    "[auth] JWT_SECRET not set — using an ephemeral secret; tokens won't survive a restart.",
  );
}

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";

/** An application-level auth failure carrying an HTTP status code. */
export class AuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

interface TokenPayload {
  sub: string;
  username: string;
}

/** Express request augmented with the authenticated user. */
export interface AuthedRequest extends Request {
  user?: PublicUser;
}

/** Sign a JWT for a user. Exported so the OAuth flow can issue tokens too. */
export function signToken(userId: string, username: string): string {
  const payload: TokenPayload = { sub: userId, username };
  // Cast keeps TS happy with the string-literal expiry option.
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

/** Verify a JWT and return its payload, or null if invalid/expired. */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "string") return null;
    const { sub, username } = decoded as jwt.JwtPayload & Partial<TokenPayload>;
    if (typeof sub !== "string" || typeof username !== "string") return null;
    return { sub, username };
  } catch {
    return null;
  }
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

/** Validate input, hash the password, and create a new account. */
export async function register(
  rawUsername: unknown,
  rawEmail: unknown,
  rawPassword: unknown,
): Promise<AuthResult> {
  const username = typeof rawUsername === "string" ? rawUsername.trim() : "";
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";

  if (!USERNAME_RE.test(username)) {
    throw new AuthError(
      400,
      "Username must be 3-32 characters: letters, numbers, dot, dash, underscore.",
    );
  }
  if (!EMAIL_RE.test(email)) {
    throw new AuthError(400, "Enter a valid email address.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      400,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (findUserByUsername(username)) {
    throw new AuthError(409, "That username is already taken.");
  }
  if (findUserByEmail(email)) {
    throw new AuthError(409, "An account with that email already exists.");
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const row = createLocalUser(username, email, hash);
  const user = toPublicUser(row);
  return { user, token: signToken(user.id, user.username) };
}

/** Verify credentials (by email) and issue a token. */
export async function login(
  rawEmail: unknown,
  rawPassword: unknown,
): Promise<AuthResult> {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";

  const row = findUserByEmail(email);
  // Always run a hash comparison to keep timing roughly constant whether or
  // not the user exists, so the endpoint doesn't leak which emails are real.
  const hash = row?.password_hash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
  const ok = await bcrypt.compare(password, hash);

  if (!row || !ok) {
    throw new AuthError(401, "Invalid email or password.");
  }
  const user = toPublicUser(row);
  return { user, token: signToken(user.id, user.username) };
}

/** Extract a bearer token from the Authorization header, if present. */
function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

/**
 * Express middleware: require a valid JWT. On success, attaches the public user
 * to `req.user`; otherwise responds 401.
 */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const token = bearerToken(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const row = findUserById(payload.sub);
  if (!row) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  req.user = toPublicUser(row);
  next();
}
