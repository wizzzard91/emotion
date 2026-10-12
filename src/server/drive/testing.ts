// Helpers for drive tests.
import { createMemoryStores } from '../db/memory.ts';
import type { NodeRecord, Stores } from '../db/types.ts';
import { folderRecord, MemoryStorage } from '../testing.ts';
import type { User } from '../auth/users.ts';

export { MemoryStorage } from '../testing.ts';

export type TestUser = User;

export const MISSING_ID = 'f'.repeat(24);

export async function addUser(stores: Stores, login: string, isAdmin = false): Promise<TestUser> {
  const name = login[0]!.toUpperCase() + login.slice(1);
  const { passwordHash: _, ...user } = await stores.users.insert({ login, name, passwordHash: 'x', isAdmin });
  return user;
}

/** Inserts nodes straight into the store, bypassing the service and its checks. */
export function nodeFactory(stores: Stores) {
  const insert = (owner: TestUser, parent: NodeRecord | null, name: string, extra: Partial<NodeRecord>) =>
    stores.nodes.insert(
      folderRecord(owner.id, name, {
        parentId: parent?.id ?? null,
        ancestors: parent ? [...parent.ancestors, parent.id] : [],
        ...extra,
      }),
    );
  return {
    folder: (owner: TestUser, parent: NodeRecord | null, name: string, isPrivate = false) =>
      insert(owner, parent, name, { isPrivate }),
    file: (owner: TestUser, parent: NodeRecord | null, name: string) =>
      insert(owner, parent, name, { kind: 'file', size: 3, storageKey: `key-${name}` }),
  };
}

/** Every node in the store, in creation order. */
export async function allNodes(stores: Stores): Promise<NodeRecord[]> {
  const top = await stores.nodes.listChildren(null);
  const below = await Promise.all(top.map((n) => stores.nodes.listDescendants(n.id)));
  return [...top, ...below.flat()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function countNodes(stores: Stores): Promise<number> {
  return (await allNodes(stores)).length;
}

export async function setup() {
  const stores = createMemoryStores();
  const storage = new MemoryStorage();
  const alice = await addUser(stores, 'alice');
  const bob = await addUser(stores, 'bob');
  const admin = await addUser(stores, 'admin', true);
  return { stores, storage, alice, bob, admin };
}
