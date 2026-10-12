import type { Readable } from 'node:stream';
import type { Stores } from '../db/types.ts';
import { StorageNotFoundError, type Storage } from '../storage/types.ts';
import { DriveError } from './errors.ts';
import { nameKey, sanitizeFileName, uniqueName, validateName } from './names.ts';
import {
  findAccessible,
  findFolder,
  hides,
  visibleChildren,
  type DriveNode,
  type Located,
  type Viewer,
} from './nodes.ts';

export type ListedNode = DriveNode & { ownerName: string };

export interface Listing {
  /** null = top level of the disk. */
  folder: DriveNode | null;
  /** Breadcrumbs: from the top level down to the current folder, inclusive. */
  path: DriveNode[];
  entries: ListedNode[];
}

export interface StoredFile {
  name: string;
  storageKey: string;
  size: number;
  mime: string | null;
}

export type DriveService = ReturnType<typeof createDriveService>;

export function canManage(node: DriveNode, viewer: Viewer): boolean {
  return node.ownerId === viewer.id || viewer.isAdmin;
}

function ancestorsFor(parent: Located | null): string[] {
  return parent ? [...parent.node.ancestors, parent.node.id] : [];
}

export function createDriveService(deps: { stores: Stores; storage: Storage }) {
  const { stores, storage } = deps;
  const { nodes } = stores;

  async function get(viewer: Viewer, id: string): Promise<Located> {
    const found = await findAccessible(nodes, viewer, id);
    if (!found) throw new DriveError('not_found');
    return found;
  }

  /** Throws not_found when the folder is missing or inaccessible; returns null for the top level. */
  async function requireFolder(viewer: Viewer, id: string | null): Promise<Located | null> {
    const found = await findFolder(nodes, viewer, id);
    if (!found) throw new DriveError('not_found');
    return found === 'root' ? null : found;
  }

  // Only names the user can see count as taken: otherwise a "name taken" error or an
  // unexpected "(2)" suffix would reveal somebody else's private folder.
  async function takenNames(viewer: Viewer, parentId: string | null, exceptId?: string): Promise<Set<string>> {
    const siblings = await visibleChildren(nodes, viewer, parentId);
    return new Set(siblings.filter((n) => n.id !== exceptId).map((n) => nameKey(n.name)));
  }

  async function list(viewer: Viewer, folderId: string | null): Promise<Listing> {
    const located = await requireFolder(viewer, folderId);
    const [children, users] = await Promise.all([visibleChildren(nodes, viewer, folderId), stores.users.list()]);
    const names = new Map(users.map((u) => [u.id, u.name]));
    const entries = children.map((n) => ({ ...n, ownerName: names.get(n.ownerId) ?? '—' }));
    return { folder: located?.node ?? null, path: located?.path ?? [], entries };
  }

  async function createFolder(viewer: Viewer, parentId: string | null, rawName: unknown, isPrivate = false): Promise<DriveNode> {
    const parent = await requireFolder(viewer, parentId);
    const name = validateName(rawName);
    if ((await takenNames(viewer, parentId)).has(nameKey(name))) throw new DriveError('name_taken');
    return nodes.insert({
      parentId,
      ancestors: ancestorsFor(parent),
      kind: 'folder',
      name,
      ownerId: viewer.id,
      isPrivate,
      size: 0,
      mime: null,
      storageKey: null,
    });
  }

  async function rename(viewer: Viewer, id: string, rawName: unknown): Promise<DriveNode> {
    const { node } = await get(viewer, id);
    if (!canManage(node, viewer)) throw new DriveError('forbidden');
    const name = validateName(rawName);
    if ((await takenNames(viewer, node.parentId, id)).has(nameKey(name))) throw new DriveError('name_taken');
    await nodes.rename(id, name);
    return { ...node, name };
  }

  /** Only the folder's owner changes privacy; an administrator may not either. */
  async function setPrivate(viewer: Viewer, id: string, isPrivate: boolean): Promise<DriveNode> {
    const { node } = await get(viewer, id);
    if (node.kind !== 'folder') throw new DriveError('not_folder');
    if (node.ownerId !== viewer.id) throw new DriveError('not_owner');
    await nodes.setPrivate(id, isPrivate);
    return { ...node, isPrivate };
  }

  /**
   * Deletes a file, or a folder with everything in it. If the subtree holds anything hidden
   * from the deleter (somebody else's private folder) the whole operation is refused:
   * silently wiping another person's private data is not acceptable, and neither is
   * leaving it dangling without a parent.
   */
  async function remove(viewer: Viewer, id: string): Promise<DriveNode> {
    const { node } = await get(viewer, id);
    if (!canManage(node, viewer)) throw new DriveError('forbidden');
    const descendants = await nodes.listDescendants(id);
    if (descendants.some((n) => hides(n, viewer))) throw new DriveError('has_hidden');
    // Records first, objects second: a stray object in storage is more benign than a file without content.
    await nodes.deleteSubtree(id);
    for (const n of [node, ...descendants]) {
      if (!n.storageKey) continue;
      try {
        await storage.delete(n.storageKey);
      } catch (err) {
        console.error(`Failed to delete object ${n.storageKey}:`, err);
      }
    }
    return node;
  }

  /**
   * Registers an object already saved in storage as a file in a folder.
   * Access to the folder is re-checked: it may have been deleted or made private during the upload.
   * A taken name gets a "(2)" suffix. On error the caller deletes the object.
   */
  async function addFile(viewer: Viewer, parentId: string | null, file: StoredFile): Promise<DriveNode> {
    const parent = await requireFolder(viewer, parentId);
    const name = uniqueName(sanitizeFileName(file.name), await takenNames(viewer, parentId));
    return nodes.insert({
      parentId,
      ancestors: ancestorsFor(parent),
      kind: 'file',
      name,
      ownerId: viewer.id,
      isPrivate: false,
      size: file.size,
      mime: file.mime,
      storageKey: file.storageKey,
    });
  }

  async function openFile(viewer: Viewer, id: string): Promise<{ node: DriveNode; body: Readable; size: number }> {
    const { node } = await get(viewer, id);
    if (node.kind !== 'file' || !node.storageKey) throw new DriveError('not_found');
    try {
      const { body, size } = await storage.get(node.storageKey);
      return { node, body, size };
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        console.error(`File ${node.id} is in the database but object ${node.storageKey} is missing from storage`);
        throw new DriveError('not_found');
      }
      throw err;
    }
  }

  return { get, requireFolder, list, createFolder, rename, setPrivate, remove, addFile, openFile };
}
