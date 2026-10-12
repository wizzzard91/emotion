import type { NodeRecord, Stores } from '../db/types.ts';
import { findAccessible, findFolder, hides, listChildren } from './nodes.ts';
import { MISSING_ID, nodeFactory, setup, type TestUser } from './testing.ts';

let stores: Stores;
let alice: TestUser;
let bob: TestUser;
let admin: TestUser;
let folder: ReturnType<typeof nodeFactory>['folder'];
let file: ReturnType<typeof nodeFactory>['file'];

const sees = async (user: TestUser, node: NodeRecord) => (await findAccessible(stores.nodes, user, node.id)) !== null;
const names = async (user: TestUser, parent: NodeRecord | null) =>
  (await listChildren(stores.nodes, user, parent?.id ?? null))?.map((n) => n.name);

beforeEach(async () => {
  ({ stores, alice, bob, admin } = await setup());
  ({ folder, file } = nodeFactory(stores));
});

describe('hides', () => {
  it('hides only private nodes that belong to someone else', () => {
    expect(hides({ isPrivate: true, ownerId: alice.id }, alice)).toBe(false);
    expect(hides({ isPrivate: true, ownerId: alice.id }, bob)).toBe(true);
    expect(hides({ isPrivate: true, ownerId: alice.id }, admin)).toBe(true);
    expect(hides({ isPrivate: false, ownerId: alice.id }, bob)).toBe(false);
  });
});

describe('findAccessible', () => {
  it('shared nodes are visible to everyone', async () => {
    const f = await folder(alice, null, 'Shared');
    const inner = await file(alice, f, 'a.txt');
    for (const user of [alice, bob, admin]) {
      expect(await sees(user, f)).toBe(true);
      expect(await sees(user, inner)).toBe(true);
    }
  });

  it('returns the path from the top level', async () => {
    const a = await folder(alice, null, 'A');
    const b = await folder(bob, a, 'B');
    const c = await file(bob, b, 'c.txt');
    const found = (await findAccessible(stores.nodes, alice, c.id))!;
    expect(found.path.map((n) => n.name)).toEqual(['A', 'B', 'c.txt']);
    expect(found.node).toMatchObject({ id: c.id, parentId: b.id, kind: 'file', ownerId: bob.id, isPrivate: false, size: 3 });
  });

  it('a missing or malformed id is null', async () => {
    expect(await findAccessible(stores.nodes, alice, MISSING_ID)).toBeNull();
    expect(await findAccessible(stores.nodes, alice, 'not-an-id')).toBeNull();
  });

  it('a node whose ancestor is gone is null', async () => {
    const a = await folder(alice, null, 'A');
    const b = await file(alice, a, 'b.txt');
    await stores.nodes.deleteSubtree(a.id);
    const orphan = await stores.nodes.insert({ ...b, name: 'orphan.txt' });
    expect(await sees(alice, orphan)).toBe(false);
  });

  it('a private folder is visible to its owner only, not even to an administrator', async () => {
    const p = await folder(alice, null, 'Private', true);
    expect(await sees(alice, p)).toBe(true);
    expect(await sees(bob, p)).toBe(false);
    expect(await sees(admin, p)).toBe(false);
  });

  it('privacy applies at any depth', async () => {
    const p = await folder(alice, null, 'Private', true);
    const l1 = await folder(alice, p, 'l1');
    const l2 = await folder(alice, l1, 'l2');
    const deep = await file(alice, l2, 'deep.txt');
    for (const node of [l1, l2, deep]) {
      expect(await sees(alice, node)).toBe(true);
      expect(await sees(bob, node)).toBe(false);
      expect(await sees(admin, node)).toBe(false);
    }
  });

  it("someone's shared node inside a private folder is hidden even from its own owner", async () => {
    // Bob put a folder and a file into Alice's shared folder, then Alice made it private.
    const p = await folder(alice, null, 'Was shared', true);
    const bobs = await folder(bob, p, "Bob's folder");
    const bobsFile = await file(bob, bobs, 'b.txt');
    expect(await sees(bob, bobs)).toBe(false);
    expect(await sees(bob, bobsFile)).toBe(false);
    expect(await sees(alice, bobs)).toBe(true);
    expect(await sees(alice, bobsFile)).toBe(true);
  });

  it("one person's private folder inside another's private folder is visible to nobody", async () => {
    const outer = await folder(alice, null, 'Outer', true);
    const inner = await folder(bob, outer, 'Inner', true);
    const leaf = await file(bob, inner, 'x.txt');
    for (const user of [alice, bob, admin]) {
      expect(await sees(user, inner)).toBe(false);
      expect(await sees(user, leaf)).toBe(false);
    }
    expect(await sees(alice, outer)).toBe(true);
  });

  it('private inside shared: only the private branch is hidden', async () => {
    const pub = await folder(alice, null, 'Shared');
    const priv = await folder(bob, pub, "Bob's secret", true);
    const leaf = await file(bob, priv, 's.txt');
    const sibling = await file(bob, pub, 'open.txt');
    expect(await sees(alice, pub)).toBe(true);
    expect(await sees(alice, sibling)).toBe(true);
    expect(await sees(alice, priv)).toBe(false);
    expect(await sees(alice, leaf)).toBe(false);
    expect(await sees(bob, leaf)).toBe(true);
  });

  it('own private folder inside own private folder', async () => {
    const outer = await folder(alice, null, 'o', true);
    const inner = await folder(alice, outer, 'i', true);
    expect(await sees(alice, inner)).toBe(true);
    expect(await sees(bob, inner)).toBe(false);
  });
});

describe('findFolder', () => {
  it('the top level is open to everyone; a file is not a folder', async () => {
    const f = await file(alice, null, 'a.txt');
    expect(await findFolder(stores.nodes, bob, null)).toBe('root');
    expect(await findFolder(stores.nodes, bob, f.id)).toBeNull();
    expect(await findFolder(stores.nodes, bob, MISSING_ID)).toBeNull();
  });

  it("someone else's private folder is indistinguishable from a missing one", async () => {
    const p = await folder(alice, null, 'p', true);
    expect(await findFolder(stores.nodes, bob, p.id)).toBeNull();
    expect(await findFolder(stores.nodes, alice, p.id)).not.toBeNull();
  });
});

describe('listChildren', () => {
  it('folders first, then files, natural case-insensitive order', async () => {
    await file(alice, null, 'файл 10.txt');
    await file(alice, null, 'Файл 2.txt');
    await folder(alice, null, 'яблоки');
    await folder(alice, null, 'Арбузы');
    await file(alice, null, 'abc.txt');
    expect(await names(alice, null)).toEqual(['Арбузы', 'яблоки', 'Файл 2.txt', 'файл 10.txt', 'abc.txt']);
  });

  it("does not list other people's private folders", async () => {
    await folder(alice, null, 'Общая');
    await folder(alice, null, 'Личное Алисы', true);
    await folder(bob, null, 'Личное Боба', true);
    expect(await names(alice, null)).toEqual(['Личное Алисы', 'Общая']);
    expect(await names(bob, null)).toEqual(['Личное Боба', 'Общая']);
    expect(await names(admin, null)).toEqual(['Общая']);
  });

  it('contents of an inaccessible folder are withheld (null, not an empty list)', async () => {
    const p = await folder(alice, null, 'Private', true);
    const inner = await folder(alice, p, 'inside');
    await file(alice, inner, 'a.txt');
    expect(await names(alice, inner)).toEqual(['a.txt']);
    expect(await names(bob, p)).toBeUndefined();
    expect(await names(bob, inner)).toBeUndefined();
    expect(await names(admin, inner)).toBeUndefined();
    expect(await listChildren(stores.nodes, alice, MISSING_ID)).toBeNull();
  });

  it('a file has no contents', async () => {
    const f = await file(alice, null, 'a.txt');
    expect(await listChildren(stores.nodes, alice, f.id)).toBeNull();
  });
});
