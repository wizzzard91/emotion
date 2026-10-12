import { DuplicateLoginError, type Stores, type UserRecord } from '../db/types.ts';
import { hashPassword } from './passwords.ts';

export interface User {
  id: string;
  login: string;
  name: string;
  isAdmin: boolean;
  createdAt: Date;
}

export interface NewUser {
  login: string;
  name: string;
  password: string;
  isAdmin?: boolean;
}

/** Invalid input; `message` is ready to be shown to the user. */
export class ValidationError extends Error {
  override name = 'ValidationError';
}

export const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;
const NAME_MAX_LENGTH = 64;
const LOGIN_RE = /^[a-zA-Z0-9._-]{3,32}$/;

/** Strips the password hash: this is the shape the rest of the app works with. */
export function toUser(record: UserRecord): User {
  const { id, login, name, isAdmin, createdAt } = record;
  return { id, login, name, isAdmin, createdAt };
}

export function validateLogin(login: string): string {
  const value = login.trim();
  if (!LOGIN_RE.test(value)) {
    throw new ValidationError('Логин: от 3 до 32 символов — латинские буквы, цифры, точка, дефис, подчёркивание');
  }
  return value;
}

export function validateName(name: string): string {
  const value = name.trim().replace(/\s+/g, ' ');
  if (value.length === 0) throw new ValidationError('Укажите имя');
  if (value.length > NAME_MAX_LENGTH) throw new ValidationError(`Имя не длиннее ${NAME_MAX_LENGTH} символов`);
  return value;
}

export function validatePassword(password: string): string {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`Пароль не короче ${PASSWORD_MIN_LENGTH} символов`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError(`Пароль не длиннее ${PASSWORD_MAX_LENGTH} символов`);
  }
  return password;
}

export async function createUser(stores: Stores, input: NewUser): Promise<User> {
  const login = validateLogin(input.login);
  const name = validateName(input.name);
  const passwordHash = await hashPassword(validatePassword(input.password));
  try {
    return toUser(await stores.users.insert({ login, name, passwordHash, isAdmin: input.isAdmin ?? false }));
  } catch (err) {
    if (err instanceof DuplicateLoginError) throw new ValidationError('Пользователь с таким логином уже есть');
    throw err;
  }
}

export async function listUsers(stores: Stores): Promise<User[]> {
  return (await stores.users.list()).map(toUser);
}

/** Returns false when there is no such user. Sessions are left alone: that is the caller's call. */
export async function setPassword(stores: Stores, userId: string, password: string): Promise<boolean> {
  const hash = await hashPassword(validatePassword(password));
  return stores.users.setPasswordHash(userId, hash);
}

/** Returns false when there is no such user. */
export async function deleteUser(stores: Stores, userId: string): Promise<boolean> {
  const user = await stores.users.findById(userId);
  if (!user) return false;
  if (user.isAdmin && (await stores.users.countAdmins()) <= 1) {
    throw new ValidationError('Нельзя удалить единственного администратора');
  }
  // Never silently drop or orphan somebody's files.
  if (await stores.nodes.existsOwnedBy(userId)) {
    throw new ValidationError(
      'У пользователя остались файлы или папки на диске — сначала удалите их или передайте другому',
    );
  }
  await stores.sessions.deleteByUser(userId);
  return stores.users.delete(userId);
}
