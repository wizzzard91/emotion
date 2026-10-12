import { createMemoryStores } from '../db/memory.ts';
import type { Stores } from '../db/types.ts';
import { folderRecord } from '../testing.ts';
import { ensureAdmin } from './bootstrap.ts';
import { verifyPassword } from './passwords.ts';
import { createSession, getSessionUser } from './sessions.ts';
import { createUser, deleteUser, listUsers, setPassword, ValidationError } from './users.ts';

const MISSING_ID = 'f'.repeat(24);

let stores: Stores;
beforeEach(() => {
  stores = createMemoryStores();
});

const anna = { login: 'anna', name: 'Анна', password: 'password-1', isAdmin: true };
const boris = { login: 'boris', name: 'Борис', password: 'password-1', isAdmin: false };

test('createUser returns the user without the password hash', async () => {
  const user = await createUser(stores, anna);
  expect(user).toEqual({ id: user.id, login: 'anna', name: 'Анна', isAdmin: true, createdAt: expect.any(Date) });
  expect(await stores.users.findById(user.id)).toMatchObject({ login: 'anna' });
});

test('logins are case-insensitive and the stored hash verifies', async () => {
  await createUser(stores, anna);
  const found = await stores.users.findByLogin('ANNA');
  expect(found?.login).toBe('anna');
  expect(found!.passwordHash).not.toContain('password-1');
  expect(await verifyPassword('password-1', found!.passwordHash)).toBe(true);
  expect(await stores.users.findByLogin('nobody')).toBeUndefined();
});

test('validates login, name and password', async () => {
  for (const login of ['ab', 'a'.repeat(33), 'аня', 'a b', 'a/b', '']) {
    await expect(createUser(stores, { ...anna, login })).rejects.toThrow(ValidationError);
  }
  await expect(createUser(stores, { ...anna, password: '1234567' })).rejects.toThrow(/не короче 8/);
  await expect(createUser(stores, { ...anna, name: '   ' })).rejects.toThrow(/имя/i);
  expect(await listUsers(stores)).toEqual([]);
  await expect(createUser(stores, { ...anna, login: 'a.b_c-1' })).resolves.toMatchObject({ login: 'a.b_c-1' });
});

test('a duplicate login is a validation error, even when two requests race', async () => {
  await createUser(stores, anna);
  await expect(createUser(stores, { ...anna, login: 'Anna' })).rejects.toThrow(/уже есть/);
  const results = await Promise.allSettled([createUser(stores, boris), createUser(stores, boris)]);
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
});

test('listUsers sorts by name', async () => {
  await createUser(stores, { ...anna, login: 'vera', name: 'Вера' });
  await createUser(stores, anna);
  expect((await listUsers(stores)).map((u) => u.login)).toEqual(['anna', 'vera']);
});

test('setPassword changes the password and enforces the minimum length', async () => {
  const user = await createUser(stores, anna);
  await expect(setPassword(stores, user.id, 'short')).rejects.toThrow(ValidationError);
  expect(await setPassword(stores, user.id, 'password-2')).toBe(true);
  const hash = (await stores.users.findByLogin('anna'))!.passwordHash;
  expect(await verifyPassword('password-2', hash)).toBe(true);
  expect(await verifyPassword('password-1', hash)).toBe(false);
  expect(await setPassword(stores, MISSING_ID, 'password-2')).toBe(false);
});

describe('deleteUser', () => {
  test('removes the user together with their sessions', async () => {
    await createUser(stores, anna);
    const user = await createUser(stores, boris);
    const token = await createSession(stores, user.id);
    expect(await deleteUser(stores, user.id)).toBe(true);
    expect(await stores.users.findById(user.id)).toBeUndefined();
    expect(await getSessionUser(stores, token)).toBeUndefined();
    expect(await deleteUser(stores, user.id)).toBe(false);
  });

  test('refuses to delete the only administrator', async () => {
    const admin = await createUser(stores, anna);
    await expect(deleteUser(stores, admin.id)).rejects.toThrow(/единственного администратора/);
    const second = await createUser(stores, { ...anna, login: 'vera', name: 'Вера' });
    expect(await deleteUser(stores, second.id)).toBe(true);
    await expect(deleteUser(stores, admin.id)).rejects.toThrow(ValidationError);
  });

  test('refuses to delete a user who still owns files', async () => {
    await createUser(stores, anna);
    const user = await createUser(stores, boris);
    await stores.nodes.insert(folderRecord(user.id, 'Отчёты'));
    await expect(deleteUser(stores, user.id)).rejects.toThrow(/остались файлы/);
    expect(await stores.users.findById(user.id)).toBeDefined();
  });
});

describe('ensureAdmin', () => {
  const seed = { login: 'boss', name: 'Boss', password: 'boss-password' };

  test('creates the administrator once', async () => {
    expect(await ensureAdmin(stores, seed)).toBe('created');
    expect(await stores.users.findByLogin('boss')).toMatchObject({ name: 'Boss', isAdmin: true });
    expect(await ensureAdmin(stores, seed)).toBe('exists');
    expect(await listUsers(stores)).toHaveLength(1);
  });

  test('does not overwrite an existing user or their password', async () => {
    await createUser(stores, { ...boris, login: 'boss' });
    expect(await ensureAdmin(stores, seed)).toBe('exists');
    const user = (await stores.users.findByLogin('boss'))!;
    expect(user.isAdmin).toBe(false);
    expect(await verifyPassword(boris.password, user.passwordHash)).toBe(true);
  });

  test('does nothing without a seed', async () => {
    expect(await ensureAdmin(stores, null)).toBe('skipped');
    expect(await listUsers(stores)).toEqual([]);
  });
});
