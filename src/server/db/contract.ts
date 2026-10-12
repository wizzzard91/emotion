// The behaviour every Stores implementation must share. Run against the in-memory
// stores always, and against MongoDB when MONGODB_TEST_URI is set.
import { folderRecord } from '../testing.ts';
import { DuplicateLoginError, type Stores } from './types.ts';

const MISSING_ID = 'f'.repeat(24);

export function describeStores(name: string, create: () => Promise<Stores>): void {
  describe(`${name} stores`, () => {
    let stores: Stores;
    beforeEach(async () => {
      stores = await create();
    });

    const anna = { login: 'Anna', name: 'Анна', passwordHash: 'hash-1', isAdmin: true };
    const boris = { login: 'boris', name: 'Борис', passwordHash: 'hash-2', isAdmin: false };

    describe('users', () => {
      it('inserts and finds by id and by login, case-insensitively', async () => {
        const user = await stores.users.insert(anna);
        expect(user).toEqual({ ...anna, id: expect.stringMatching(/^[0-9a-f]{24}$/), createdAt: expect.any(Date) });
        expect(await stores.users.findById(user.id)).toEqual(user);
        expect(await stores.users.findByLogin('aNNa')).toEqual(user);
        expect(await stores.users.findByLogin('nobody')).toBeUndefined();
        expect(await stores.users.findById(MISSING_ID)).toBeUndefined();
        expect(await stores.users.findById('not-an-id')).toBeUndefined();
      });

      it('rejects a duplicate login regardless of case', async () => {
        await stores.users.insert(anna);
        await expect(stores.users.insert({ ...boris, login: 'ANNA' })).rejects.toThrow(DuplicateLoginError);
        expect(await stores.users.list()).toHaveLength(1);
      });

      it('lists by name, counts administrators, updates and deletes', async () => {
        const b = await stores.users.insert(boris);
        const a = await stores.users.insert(anna);
        expect((await stores.users.list()).map((u) => u.id)).toEqual([a.id, b.id]);
        expect(await stores.users.countAdmins()).toBe(1);

        expect(await stores.users.setPasswordHash(b.id, 'hash-3')).toBe(true);
        expect((await stores.users.findById(b.id))?.passwordHash).toBe('hash-3');
        expect(await stores.users.setPasswordHash(MISSING_ID, 'x')).toBe(false);

        expect(await stores.users.delete(a.id)).toBe(true);
        expect(await stores.users.delete(a.id)).toBe(false);
        expect(await stores.users.countAdmins()).toBe(0);
      });
    });

    describe('sessions', () => {
      it('inserts, finds and deletes', async () => {
        const user = await stores.users.insert(anna);
        const session = { id: 'a'.repeat(64), userId: user.id, expiresAt: new Date('2030-01-01T00:00:00Z') };
        await stores.sessions.insert(session);
        expect(await stores.sessions.find(session.id)).toEqual(session);
        await stores.sessions.delete(session.id);
        expect(await stores.sessions.find(session.id)).toBeUndefined();
      });

      it('deletes all sessions of a user except one', async () => {
        const a = await stores.users.insert(anna);
        const b = await stores.users.insert(boris);
        const expiresAt = new Date('2030-01-01T00:00:00Z');
        for (const [id, userId] of [['s1', a.id], ['s2', a.id], ['s3', a.id], ['s4', b.id]] as const) {
          await stores.sessions.insert({ id, userId, expiresAt });
        }
        expect(await stores.sessions.deleteByUser(a.id, 's2')).toBe(2);
        expect(await stores.sessions.find('s2')).toBeDefined();
        expect(await stores.sessions.find('s4')).toBeDefined();
        expect(await stores.sessions.deleteByUser(a.id)).toBe(1);
        expect(await stores.sessions.deleteByUser(MISSING_ID)).toBe(0);
      });
    });

    describe('nodes', () => {
      it('stores a tree and reads it back', async () => {
        const owner = await stores.users.insert(anna);
        const a = await stores.nodes.insert(folderRecord(owner.id, 'A', { isPrivate: true }));
        const b = await stores.nodes.insert(folderRecord(owner.id, 'B', { parentId: a.id, ancestors: [a.id] }));
        const c = await stores.nodes.insert(
          folderRecord(owner.id, 'c.txt', {
            parentId: b.id,
            ancestors: [a.id, b.id],
            kind: 'file',
            size: 5,
            mime: 'text/plain',
            storageKey: 'key-c',
          }),
        );
        const other = await stores.nodes.insert(folderRecord(owner.id, 'Other'));

        expect(c).toEqual({
          id: expect.stringMatching(/^[0-9a-f]{24}$/),
          parentId: b.id,
          ancestors: [a.id, b.id],
          kind: 'file',
          name: 'c.txt',
          ownerId: owner.id,
          isPrivate: false,
          size: 5,
          mime: 'text/plain',
          storageKey: 'key-c',
          createdAt: expect.any(Date),
        });
        expect(await stores.nodes.findById(c.id)).toEqual(c);
        expect(await stores.nodes.findById(MISSING_ID)).toBeUndefined();
        expect(await stores.nodes.findById('not-an-id')).toBeUndefined();

        const ids = async (list: Promise<{ id: string }[]>) => (await list).map((n) => n.id).sort();
        expect(await ids(stores.nodes.findByIds([a.id, c.id, MISSING_ID]))).toEqual([a.id, c.id].sort());
        expect(await stores.nodes.findByIds([])).toEqual([]);
        expect(await ids(stores.nodes.listChildren(null))).toEqual([a.id, other.id].sort());
        expect(await ids(stores.nodes.listChildren(a.id))).toEqual([b.id]);
        expect(await ids(stores.nodes.listDescendants(a.id))).toEqual([b.id, c.id].sort());
        expect(await stores.nodes.listDescendants(c.id)).toEqual([]);
      });

      it('renames, toggles privacy and deletes a subtree', async () => {
        const owner = await stores.users.insert(anna);
        const a = await stores.nodes.insert(folderRecord(owner.id, 'A'));
        const b = await stores.nodes.insert(folderRecord(owner.id, 'B', { parentId: a.id, ancestors: [a.id] }));
        const keep = await stores.nodes.insert(folderRecord(owner.id, 'Keep'));

        await stores.nodes.rename(a.id, 'Renamed');
        await stores.nodes.setPrivate(a.id, true);
        expect(await stores.nodes.findById(a.id)).toMatchObject({ name: 'Renamed', isPrivate: true });
        expect(await stores.nodes.existsOwnedBy(owner.id)).toBe(true);
        expect(await stores.nodes.existsOwnedBy(MISSING_ID)).toBe(false);

        await stores.nodes.deleteSubtree(a.id);
        expect(await stores.nodes.findById(a.id)).toBeUndefined();
        expect(await stores.nodes.findById(b.id)).toBeUndefined();
        expect(await stores.nodes.findById(keep.id)).toBeDefined();
      });
    });
  });
}
