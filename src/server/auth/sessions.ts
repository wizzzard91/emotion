import { createHash, randomBytes } from 'node:crypto';
import type { Stores } from '../db/types.ts';
import { toUser, type User } from './users.ts';

export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url

// Only the hash is stored: a leaked database does not hand out ready-made cookies.
function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Returns the token for the cookie; the token itself is never stored. */
export async function createSession(stores: Stores, userId: string, now: Date = new Date()): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await stores.sessions.insert({ id: tokenId(token), userId, expiresAt });
  return token;
}

export async function getSessionUser(
  stores: Stores,
  token: string | undefined,
  now: Date = new Date(),
): Promise<User | undefined> {
  if (!token || !TOKEN_RE.test(token)) return undefined;
  const session = await stores.sessions.find(tokenId(token));
  // The store expires sessions lazily, so the deadline is checked here as well.
  if (!session || session.expiresAt <= now) return undefined;
  const user = await stores.users.findById(session.userId);
  return user && toUser(user);
}

export async function deleteSession(stores: Stores, token: string | undefined): Promise<void> {
  if (!token || !TOKEN_RE.test(token)) return;
  await stores.sessions.delete(tokenId(token));
}

/** Logs the user out everywhere; `exceptToken` is the session to keep. */
export async function deleteUserSessions(stores: Stores, userId: string, exceptToken?: string): Promise<number> {
  const keep = exceptToken && TOKEN_RE.test(exceptToken) ? tokenId(exceptToken) : undefined;
  return stores.sessions.deleteByUser(userId, keep);
}
