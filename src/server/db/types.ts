// Persistence contracts. Feature code depends on these interfaces only;
// MongoDB implements them in ./mongo.ts, unit tests use ./memory.ts.
// Ids are opaque strings (24 hex chars).

export interface UserRecord {
  id: string;
  login: string;
  name: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: Date;
}

export type NewUserRecord = Omit<UserRecord, 'id' | 'createdAt'>;

/** Thrown by UserStore.insert when the login (compared case-insensitively) is taken. */
export class DuplicateLoginError extends Error {
  override name = 'DuplicateLoginError';
}

export interface UserStore {
  insert(user: NewUserRecord): Promise<UserRecord>;
  findById(id: string): Promise<UserRecord | undefined>;
  /** Case-insensitive. */
  findByLogin(login: string): Promise<UserRecord | undefined>;
  /** Sorted by name. */
  list(): Promise<UserRecord[]>;
  setPasswordHash(id: string, passwordHash: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  countAdmins(): Promise<number>;
}

export interface SessionRecord {
  /** sha256 of the cookie token. */
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface SessionStore {
  insert(session: SessionRecord): Promise<void>;
  find(id: string): Promise<SessionRecord | undefined>;
  delete(id: string): Promise<void>;
  /** Returns the number of sessions removed. */
  deleteByUser(userId: string, exceptId?: string): Promise<number>;
}

export interface NodeRecord {
  id: string;
  /** null = top level of the disk. */
  parentId: string | null;
  /** Ids from the top level down to the parent. Nodes are never moved, so this never changes. */
  ancestors: string[];
  kind: 'folder' | 'file';
  name: string;
  ownerId: string;
  /** Folders only; applies to everything inside. */
  isPrivate: boolean;
  size: number;
  mime: string | null;
  /** Files only. */
  storageKey: string | null;
  createdAt: Date;
}

export type NewNodeRecord = Omit<NodeRecord, 'id' | 'createdAt'>;

/** Plain data access: no store method checks permissions. */
export interface NodeStore {
  insert(node: NewNodeRecord): Promise<NodeRecord>;
  findById(id: string): Promise<NodeRecord | undefined>;
  findByIds(ids: string[]): Promise<NodeRecord[]>;
  listChildren(parentId: string | null): Promise<NodeRecord[]>;
  listDescendants(id: string): Promise<NodeRecord[]>;
  rename(id: string, name: string): Promise<void>;
  setPrivate(id: string, isPrivate: boolean): Promise<void>;
  /** Removes the node and everything below it. */
  deleteSubtree(id: string): Promise<void>;
  existsOwnedBy(userId: string): Promise<boolean>;
}

export interface Stores {
  users: UserStore;
  sessions: SessionStore;
  nodes: NodeStore;
}
