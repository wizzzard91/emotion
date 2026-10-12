import type { AdminSeed } from '../config.ts';
import type { Stores } from '../db/types.ts';
import { createUser } from './users.ts';

/**
 * Creates the first administrator from ADMIN_LOGIN / ADMIN_PASSWORD.
 * An existing user with that login is left untouched, so changing the password
 * in the UI is not undone by a restart.
 */
export async function ensureAdmin(stores: Stores, seed: AdminSeed | null): Promise<'created' | 'exists' | 'skipped'> {
  if (!seed) return 'skipped';
  if (await stores.users.findByLogin(seed.login)) return 'exists';
  await createUser(stores, { ...seed, isAdmin: true });
  return 'created';
}
