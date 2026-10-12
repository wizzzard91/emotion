import { createHash } from 'node:crypto';
import { createMemoryStores } from '../db/memory.ts';
import type { Stores } from '../db/types.ts';
import { createSession, deleteSession, deleteUserSessions, getSessionUser, SESSION_TTL_SECONDS } from './sessions.ts';

let stores: Stores;
let userId: string;
beforeEach(async () => {
  stores = createMemoryStores();
  userId = (await stores.users.insert({ login: 'anna', name: 'Анна', passwordHash: 'x', isAdmin: false })).id;
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

test('only the sha256 of the token is stored, with a 30-day lifetime', async () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const token = await createSession(stores, userId, now);
  expect(token).toMatch(/^[\w-]{43}$/);
  const session = await stores.sessions.find(sha256(token));
  expect(session).toEqual({
    id: sha256(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
  });
  expect(await stores.sessions.find(token)).toBeUndefined();
});

test('getSessionUser resolves the user by token', async () => {
  const token = await createSession(stores, userId);
  const user = await getSessionUser(stores, token);
  expect(user).toMatchObject({ id: userId, login: 'anna', name: 'Анна', isAdmin: false });
  expect(user).not.toHaveProperty('passwordHash');
  expect(await createSession(stores, userId)).not.toBe(token);
});

test('garbage, a foreign token and the hash itself are rejected', async () => {
  const token = await createSession(stores, userId);
  for (const bad of [undefined, '', 'nope', token.slice(0, -1), token + 'A', 'A'.repeat(43), sha256(token)]) {
    expect(await getSessionUser(stores, bad)).toBeUndefined();
  }
});

test('an expired session stops working', async () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const token = await createSession(stores, userId, now);
  const justBefore = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000 - 1);
  const deadline = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  expect(await getSessionUser(stores, token, justBefore)).toBeDefined();
  expect(await getSessionUser(stores, token, deadline)).toBeUndefined();
});

test('a session of a deleted user resolves to nothing', async () => {
  const token = await createSession(stores, userId);
  await stores.users.delete(userId);
  expect(await getSessionUser(stores, token)).toBeUndefined();
});

test('deleteSession and deleteUserSessions', async () => {
  const a = await createSession(stores, userId);
  const b = await createSession(stores, userId);
  const c = await createSession(stores, userId);
  await deleteSession(stores, a);
  await deleteSession(stores, 'garbage');
  expect(await getSessionUser(stores, a)).toBeUndefined();
  expect(await deleteUserSessions(stores, userId, b)).toBe(1);
  expect(await getSessionUser(stores, b)).toBeDefined();
  expect(await getSessionUser(stores, c)).toBeUndefined();
  expect(await deleteUserSessions(stores, userId)).toBe(1);
  expect(await getSessionUser(stores, b)).toBeUndefined();
});
