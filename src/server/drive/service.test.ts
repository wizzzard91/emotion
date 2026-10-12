import type { Stores } from '../db/types.ts';
import { DriveError, type ErrorCode } from './errors.ts';
import { createDriveService, type DriveService } from './service.ts';
import { countNodes, MemoryStorage, MISSING_ID, nodeFactory, setup, type TestUser } from './testing.ts';

let stores: Stores;
let storage: MemoryStorage;
let service: DriveService;
let alice: TestUser;
let bob: TestUser;
let admin: TestUser;

beforeEach(async () => {
  ({ stores, storage, alice, bob, admin } = await setup());
  service = createDriveService({ stores, storage });
});

async function code(promise: Promise<unknown>): Promise<ErrorCode | 'no error'> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DriveError) return err.code;
    throw err;
  }
  return 'no error';
}

/** Puts an object into storage and registers the file, the way an upload does. */
function addFile(user: TestUser, parentId: string | null, name: string, content = 'data') {
  const key = `key-${storage.objects.size}-${name}`;
  storage.objects.set(key, Buffer.from(content));
  return service.addFile(user, parentId, { name, storageKey: key, size: Buffer.byteLength(content), mime: null });
}

const names = async (user: TestUser, id: string | null) => (await service.list(user, id)).entries.map((n) => n.name);

describe('list', () => {
  it('returns breadcrumbs and contents with owner names', async () => {
    const a = await service.createFolder(alice, null, 'A');
    const b = await service.createFolder(bob, a.id, 'B');
    await addFile(bob, b.id, 'f.txt');
    const listing = await service.list(alice, b.id);
    expect(listing.folder?.name).toBe('B');
    expect(listing.path.map((n) => n.name)).toEqual(['A', 'B']);
    expect(listing.entries).toMatchObject([{ name: 'f.txt', ownerName: 'Bob' }]);
    expect(await service.list(alice, null)).toMatchObject({ folder: null, path: [] });
  });

  it('not_found for a missing folder, an inaccessible one and a file', async () => {
    const p = await service.createFolder(alice, null, 'Private', true);
    const f = await addFile(alice, null, 'a.txt');
    expect(await code(service.list(bob, p.id))).toBe('not_found');
    expect(await code(service.list(admin, p.id))).toBe('not_found');
    expect(await code(service.list(alice, MISSING_ID))).toBe('not_found');
    expect(await code(service.list(alice, f.id))).toBe('not_found');
  });
});

describe('createFolder', () => {
  it('creates shared and private folders', async () => {
    const pub = await service.createFolder(alice, null, '  Проект  ');
    const priv = await service.createFolder(alice, pub.id, 'Черновики', true);
    expect(pub).toMatchObject({ name: 'Проект', kind: 'folder', isPrivate: false, ownerId: alice.id, parentId: null, ancestors: [] });
    expect(priv).toMatchObject({ isPrivate: true, parentId: pub.id, ancestors: [pub.id] });
    expect(await names(bob, pub.id)).toEqual([]);
    expect(await names(alice, pub.id)).toEqual(['Черновики']);
  });

  it('validates the name', async () => {
    expect(await code(service.createFolder(alice, null, 'a/b'))).toBe('bad_name');
    expect(await code(service.createFolder(alice, null, ''))).toBe('bad_name');
  });

  it('cannot create inside an inaccessible folder, a file or a missing folder', async () => {
    const p = await service.createFolder(alice, null, 'Private', true);
    const f = await addFile(alice, null, 'a.txt');
    expect(await code(service.createFolder(bob, p.id, 'x'))).toBe('not_found');
    expect(await code(service.createFolder(admin, p.id, 'x'))).toBe('not_found');
    expect(await code(service.createFolder(alice, f.id, 'x'))).toBe('not_found');
    expect(await code(service.createFolder(alice, MISSING_ID, 'x'))).toBe('not_found');
    expect(await countNodes(stores)).toBe(2);
  });

  it('a visible namesake is an error (case-insensitive, files count too)', async () => {
    await service.createFolder(alice, null, 'Отчёты');
    await addFile(alice, null, 'заметки');
    expect(await code(service.createFolder(bob, null, 'отчёты'))).toBe('name_taken');
    expect(await code(service.createFolder(bob, null, 'Заметки'))).toBe('name_taken');
  });

  it('an invisible namesake does not give itself away: the folder gets the requested name', async () => {
    await service.createFolder(alice, null, 'Секрет', true);
    const created = await service.createFolder(bob, null, 'Секрет');
    expect(created.name).toBe('Секрет');
    expect(await names(bob, null)).toEqual(['Секрет']);
    // The private folder's owner sees both.
    expect(await names(alice, null)).toEqual(['Секрет', 'Секрет']);
  });
});

describe('rename', () => {
  it('allowed for the owner and an administrator, not for others', async () => {
    const f = await addFile(alice, null, 'a.txt');
    expect(await code(service.rename(bob, f.id, 'b.txt'))).toBe('forbidden');
    expect((await service.rename(alice, f.id, 'b.txt')).name).toBe('b.txt');
    expect((await service.rename(admin, f.id, 'c.txt')).name).toBe('c.txt');
    expect(await names(bob, null)).toEqual(['c.txt']);
  });

  it('checks the name and visible namesakes but allows changing the case of its own name', async () => {
    const f = await addFile(alice, null, 'a.txt');
    await addFile(alice, null, 'b.txt');
    expect(await code(service.rename(alice, f.id, 'B.TXT'))).toBe('name_taken');
    expect(await code(service.rename(alice, f.id, '..'))).toBe('bad_name');
    expect((await service.rename(alice, f.id, 'A.txt')).name).toBe('A.txt');
  });

  it('an invisible namesake neither blocks nor gives itself away', async () => {
    await service.createFolder(alice, null, 'Секрет', true);
    const f = await service.createFolder(bob, null, 'Обычная');
    expect((await service.rename(bob, f.id, 'Секрет')).name).toBe('Секрет');
  });

  it("an administrator cannot rename what lies inside someone's private folder", async () => {
    const p = await service.createFolder(alice, null, 'Private', true);
    const f = await addFile(alice, p.id, 'a.txt');
    expect(await code(service.rename(admin, p.id, 'x'))).toBe('not_found');
    expect(await code(service.rename(admin, f.id, 'x'))).toBe('not_found');
    expect(await code(service.rename(bob, f.id, 'x'))).toBe('not_found');
  });
});

describe('setPrivate', () => {
  it('owner only; not an administrator', async () => {
    const f = await service.createFolder(alice, null, 'Папка');
    expect(await code(service.setPrivate(bob, f.id, true))).toBe('not_owner');
    expect(await code(service.setPrivate(admin, f.id, true))).toBe('not_owner');
    expect((await service.setPrivate(alice, f.id, true)).isPrivate).toBe(true);
    expect(await names(bob, null)).toEqual([]);
    // Someone else's private folder cannot be opened up, or even discovered.
    expect(await code(service.setPrivate(bob, f.id, false))).toBe('not_found');
    expect(await code(service.setPrivate(admin, f.id, false))).toBe('not_found');
    expect((await service.setPrivate(alice, f.id, false)).isPrivate).toBe(false);
    expect(await names(bob, null)).toEqual(['Папка']);
  });

  it('a file cannot be made private', async () => {
    const f = await addFile(alice, null, 'a.txt');
    expect(await code(service.setPrivate(alice, f.id, true))).toBe('not_folder');
  });

  it("closing the outer folder hides other people's contents, reopening brings them back", async () => {
    const outer = await service.createFolder(alice, null, 'Outer');
    const inner = await service.createFolder(bob, outer.id, "Bob's private", true);
    const leaf = await addFile(bob, inner.id, 'b.txt');
    await service.setPrivate(alice, outer.id, true);
    // Private inside another owner's private folder: nobody sees it.
    for (const user of [alice, bob, admin]) {
      expect(await code(service.get(user, inner.id))).toBe('not_found');
      expect(await code(service.get(user, leaf.id))).toBe('not_found');
    }
    expect(await names(alice, outer.id)).toEqual([]);
    expect(await code(service.setPrivate(bob, inner.id, false))).toBe('not_found');
    await service.setPrivate(alice, outer.id, false);
    expect((await service.get(bob, leaf.id)).node.name).toBe('b.txt');
    expect(await code(service.get(alice, leaf.id))).toBe('not_found');
  });
});

describe('remove', () => {
  it('deletes a file together with its storage object', async () => {
    const f = await addFile(alice, null, 'a.txt');
    expect(storage.objects.size).toBe(1);
    await service.remove(alice, f.id);
    expect(storage.objects.size).toBe(0);
    expect(await countNodes(stores)).toBe(0);
  });

  it('deletes a folder recursively and cleans up every object below it', async () => {
    const a = await service.createFolder(alice, null, 'A');
    const b = await service.createFolder(alice, a.id, 'B');
    const c = await service.createFolder(bob, b.id, 'C');
    await addFile(alice, a.id, '1.txt');
    await addFile(alice, b.id, '2.txt');
    await addFile(bob, c.id, '3.txt');
    const keep = await addFile(alice, null, 'keep.txt');
    expect(storage.objects.size).toBe(4);
    await service.remove(alice, a.id);
    expect([...storage.objects.keys()]).toEqual([keep.storageKey]);
    expect(await names(alice, null)).toEqual(['keep.txt']);
    expect(await countNodes(stores)).toBe(1);
  });

  it('owner or administrator; an outsider gets forbidden', async () => {
    const f = await addFile(alice, null, 'a.txt');
    const g = await addFile(alice, null, 'b.txt');
    expect(await code(service.remove(bob, f.id))).toBe('forbidden');
    expect(storage.objects.size).toBe(2);
    await service.remove(admin, f.id);
    await service.remove(alice, g.id);
    expect(await countNodes(stores)).toBe(0);
  });

  it("an administrator cannot delete someone's private folder or its contents", async () => {
    const p = await service.createFolder(alice, null, 'Private', true);
    const f = await addFile(alice, p.id, 'a.txt');
    expect(await code(service.remove(admin, p.id))).toBe('not_found');
    expect(await code(service.remove(admin, f.id))).toBe('not_found');
    expect(storage.objects.size).toBe(1);
    expect(await countNodes(stores)).toBe(2);
  });

  it("refuses entirely when someone else's private folder is inside (at any depth)", async () => {
    const pub = await service.createFolder(alice, null, 'Shared');
    const mid = await service.createFolder(alice, pub.id, 'Middle');
    const secret = await service.createFolder(bob, mid.id, "Bob's secret", true);
    await addFile(bob, secret.id, 's.txt');
    await addFile(alice, pub.id, 'a.txt');
    for (const user of [alice, admin]) {
      expect(await code(service.remove(user, pub.id))).toBe('has_hidden');
      expect(await code(service.remove(user, mid.id))).toBe('has_hidden');
    }
    expect(storage.objects.size).toBe(2);
    expect(await countNodes(stores)).toBe(5);
    // Once Bob removes his part, the folder can be deleted.
    await service.remove(bob, secret.id);
    await service.remove(alice, pub.id);
    expect(storage.objects.size).toBe(0);
    expect(await countNodes(stores)).toBe(0);
  });

  it('own private folder with contents can be deleted', async () => {
    const p = await service.createFolder(alice, null, 'Private', true);
    const inner = await service.createFolder(alice, p.id, 'more', true);
    await addFile(alice, inner.id, 'a.txt');
    await service.remove(alice, p.id);
    expect(storage.objects.size).toBe(0);
    expect(await countNodes(stores)).toBe(0);
  });

  it('a storage failure leaves no records behind', async () => {
    const f = await addFile(alice, null, 'a.txt');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    storage.delete = async () => {
      throw new Error('boom');
    };
    await service.remove(alice, f.id);
    expect(await countNodes(stores)).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('addFile', () => {
  it('a taken name gets a suffix', async () => {
    expect((await addFile(alice, null, 'отчёт.pdf')).name).toBe('отчёт.pdf');
    expect((await addFile(bob, null, 'отчёт.pdf')).name).toBe('отчёт (2).pdf');
    expect((await addFile(bob, null, 'Отчёт.pdf')).name).toBe('Отчёт (3).pdf');
  });

  it('an invisible private namesake folder causes no suffix', async () => {
    await service.createFolder(alice, null, 'архив', true);
    expect((await addFile(bob, null, 'архив')).name).toBe('архив');
    expect((await addFile(alice, null, 'архив')).name).toBe('архив (2)');
  });

  it('coerces an invalid name into a valid one', async () => {
    expect((await addFile(alice, null, 'a\\b\0.txt')).name).toBe('a_b_.txt');
  });

  it('not_found when the folder is inaccessible or gone', async () => {
    const p = await service.createFolder(alice, null, 'Private', true);
    const file = { name: 'a.txt', storageKey: 'k', size: 1, mime: null };
    expect(await code(service.addFile(bob, p.id, file))).toBe('not_found');
    expect(await code(service.addFile(bob, MISSING_ID, file))).toBe('not_found');
  });
});

describe('openFile', () => {
  it("returns the stream and size; other people's private files and folders are not_found", async () => {
    const p = await service.createFolder(alice, null, 'Private', true);
    const f = await addFile(alice, p.id, 'a.txt', 'привет');
    const opened = await service.openFile(alice, f.id);
    expect(opened.size).toBe(Buffer.byteLength('привет'));
    opened.body.destroy();
    expect(await code(service.openFile(bob, f.id))).toBe('not_found');
    expect(await code(service.openFile(admin, f.id))).toBe('not_found');
    expect(await code(service.openFile(alice, p.id))).toBe('not_found');
  });

  it('an object missing from storage is not_found', async () => {
    const lost = await nodeFactory(stores).file(alice, null, 'x');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await code(service.openFile(alice, lost.id))).toBe('not_found');
    spy.mockRestore();
  });
});
