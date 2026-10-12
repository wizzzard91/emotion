// In-memory stores for unit tests. Behaviour mirrors ./mongo.ts.
import {
  DuplicateLoginError,
  type NodeRecord,
  type NodeStore,
  type SessionRecord,
  type SessionStore,
  type Stores,
  type UserRecord,
  type UserStore,
} from './types.ts';

function idGenerator(): () => string {
  let counter = 0;
  return () => (++counter).toString(16).padStart(24, '0');
}

function createUserStore(nextId: () => string): UserStore {
  const users = new Map<string, UserRecord>();
  const byLogin = (login: string) => [...users.values()].find((u) => u.login.toLowerCase() === login.toLowerCase());
  return {
    async insert(user) {
      if (byLogin(user.login)) throw new DuplicateLoginError(user.login);
      const record = { ...user, id: nextId(), createdAt: new Date() };
      users.set(record.id, record);
      return { ...record };
    },
    async findById(id) {
      const user = users.get(id);
      return user && { ...user };
    },
    async findByLogin(login) {
      const user = byLogin(login);
      return user && { ...user };
    },
    async list() {
      return [...users.values()].sort((a, b) => a.name.localeCompare(b.name)).map((u) => ({ ...u }));
    },
    async setPasswordHash(id, passwordHash) {
      const user = users.get(id);
      if (!user) return false;
      user.passwordHash = passwordHash;
      return true;
    },
    async delete(id) {
      return users.delete(id);
    },
    async countAdmins() {
      return [...users.values()].filter((u) => u.isAdmin).length;
    },
  };
}

function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>();
  return {
    async insert(session) {
      sessions.set(session.id, { ...session });
    },
    async find(id) {
      const session = sessions.get(id);
      return session && { ...session };
    },
    async delete(id) {
      sessions.delete(id);
    },
    async deleteByUser(userId, exceptId) {
      let removed = 0;
      for (const [id, session] of sessions) {
        if (session.userId !== userId || id === exceptId) continue;
        sessions.delete(id);
        removed++;
      }
      return removed;
    },
  };
}

function createNodeStore(nextId: () => string): NodeStore {
  const nodes = new Map<string, NodeRecord>();
  const copy = (node: NodeRecord): NodeRecord => ({ ...node, ancestors: [...node.ancestors] });
  const where = (test: (node: NodeRecord) => boolean) => [...nodes.values()].filter(test).map(copy);
  return {
    async insert(node) {
      const record = { ...node, ancestors: [...node.ancestors], id: nextId(), createdAt: new Date() };
      nodes.set(record.id, record);
      return copy(record);
    },
    async findById(id) {
      const node = nodes.get(id);
      return node && copy(node);
    },
    async findByIds(ids) {
      return where((n) => ids.includes(n.id));
    },
    async listChildren(parentId) {
      return where((n) => n.parentId === parentId);
    },
    async listDescendants(id) {
      return where((n) => n.ancestors.includes(id));
    },
    async rename(id, name) {
      const node = nodes.get(id);
      if (node) node.name = name;
    },
    async setPrivate(id, isPrivate) {
      const node = nodes.get(id);
      if (node) node.isPrivate = isPrivate;
    },
    async deleteSubtree(id) {
      for (const node of [...nodes.values()]) {
        if (node.id === id || node.ancestors.includes(id)) nodes.delete(node.id);
      }
    },
    async existsOwnedBy(userId) {
      return [...nodes.values()].some((n) => n.ownerId === userId);
    },
  };
}

export function createMemoryStores(): Stores {
  const nextId = idGenerator();
  return { users: createUserStore(nextId), sessions: createSessionStore(), nodes: createNodeStore(nextId) };
}
