import type { NodeRecord, NodeStore } from '../db/types.ts';
import { compareNames } from './names.ts';

export interface Viewer {
  id: string;
  isAdmin: boolean;
}

export type DriveNode = NodeRecord;

export interface Located {
  node: DriveNode;
  /** Chain from the top level of the disk down to the node itself, inclusive. */
  path: DriveNode[];
}

// ---------------------------------------------------------------------------
// The access rule. The ONLY place that decides who sees what: a node hides
// itself and everything below it when it is private and belongs to someone
// else. Administrators are no exception. Every read below goes through hides().
// ---------------------------------------------------------------------------
export function hides(node: Pick<DriveNode, 'isPrivate' | 'ownerId'>, viewer: Viewer): boolean {
  return node.isPrivate && node.ownerId !== viewer.id;
}

/** The node with its path from the top level, or null when it is missing or inaccessible (indistinguishable from outside). */
export async function findAccessible(nodes: NodeStore, viewer: Viewer, id: string): Promise<Located | null> {
  const node = await nodes.findById(id);
  if (!node) return null;
  const found = new Map((await nodes.findByIds(node.ancestors)).map((n) => [n.id, n]));
  const path: DriveNode[] = [];
  for (const ancestorId of node.ancestors) {
    const ancestor = found.get(ancestorId);
    // A missing ancestor means the subtree is being deleted right now.
    if (!ancestor) return null;
    path.push(ancestor);
  }
  path.push(node);
  return path.some((n) => hides(n, viewer)) ? null : { node, path };
}

/** An accessible folder; id === null is the top level of the disk (open to everyone). */
export async function findFolder(nodes: NodeStore, viewer: Viewer, id: string | null): Promise<Located | null | 'root'> {
  if (id === null) return 'root';
  const found = await findAccessible(nodes, viewer, id);
  return found && found.node.kind === 'folder' ? found : null;
}

/**
 * Visible children: folders first, then files, by name.
 * Does NOT check access to the parent itself; the caller must have located it via findFolder().
 */
export async function visibleChildren(nodes: NodeStore, viewer: Viewer, parentId: string | null): Promise<DriveNode[]> {
  return (await nodes.listChildren(parentId))
    .filter((n) => !hides(n, viewer))
    .sort((a, b) =>
      a.kind === b.kind ? compareNames(a.name, b.name) || a.id.localeCompare(b.id) : a.kind === 'folder' ? -1 : 1,
    );
}

/** Visible contents of a folder, or null when the folder is missing or inaccessible. */
export async function listChildren(nodes: NodeStore, viewer: Viewer, parentId: string | null): Promise<DriveNode[] | null> {
  if (!(await findFolder(nodes, viewer, parentId))) return null;
  return visibleChildren(nodes, viewer, parentId);
}
