import { MongoClient, MongoServerError, ObjectId, type Collection, type Db } from 'mongodb';
import type { MongoConfig } from '../config.ts';
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

interface UserDoc {
  _id: ObjectId;
  login: string;
  /** Lowercased login; the unique index lives here so logins are case-insensitive. */
  loginKey: string;
  name: string;
  passwordHash: string;
  role: 'admin' | 'member';
  createdAt: Date;
}

interface SessionDoc {
  _id: string;
  userId: ObjectId;
  expiresAt: Date;
}

interface NodeDoc {
  _id: ObjectId;
  parentId: ObjectId | null;
  ancestors: ObjectId[];
  kind: 'folder' | 'file';
  name: string;
  ownerId: ObjectId;
  isPrivate: boolean;
  size: number;
  mime: string | null;
  storageKey: string | null;
  createdAt: Date;
}

const ID_RE = /^[0-9a-f]{24}$/;

// Ids arrive from URLs; anything that is not a well-formed ObjectId simply matches nothing.
function oid(id: string): ObjectId | undefined {
  return ID_RE.test(id) ? new ObjectId(id) : undefined;
}

function oids(ids: string[]): ObjectId[] {
  return ids.map(oid).filter((id) => id !== undefined);
}

function toUser(doc: UserDoc): UserRecord {
  return {
    id: doc._id.toHexString(),
    login: doc.login,
    name: doc.name,
    passwordHash: doc.passwordHash,
    isAdmin: doc.role === 'admin',
    createdAt: doc.createdAt,
  };
}

function createUserStore(users: Collection<UserDoc>): UserStore {
  return {
    async insert(user) {
      const doc: UserDoc = {
        _id: new ObjectId(),
        login: user.login,
        loginKey: user.login.toLowerCase(),
        name: user.name,
        passwordHash: user.passwordHash,
        role: user.isAdmin ? 'admin' : 'member',
        createdAt: new Date(),
      };
      try {
        await users.insertOne(doc);
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) throw new DuplicateLoginError(user.login);
        throw err;
      }
      return toUser(doc);
    },
    async findById(id) {
      const _id = oid(id);
      const doc = _id && (await users.findOne({ _id }));
      return doc ? toUser(doc) : undefined;
    },
    async findByLogin(login) {
      const doc = await users.findOne({ loginKey: login.toLowerCase() });
      return doc ? toUser(doc) : undefined;
    },
    async list() {
      const docs = await users.find().sort({ name: 1, _id: 1 }).collation({ locale: 'ru', strength: 2 }).toArray();
      return docs.map(toUser);
    },
    async setPasswordHash(id, passwordHash) {
      const _id = oid(id);
      if (!_id) return false;
      return (await users.updateOne({ _id }, { $set: { passwordHash } })).matchedCount > 0;
    },
    async delete(id) {
      const _id = oid(id);
      if (!_id) return false;
      return (await users.deleteOne({ _id })).deletedCount > 0;
    },
    countAdmins: () => users.countDocuments({ role: 'admin' }),
  };
}

function createSessionStore(sessions: Collection<SessionDoc>): SessionStore {
  return {
    async insert(session) {
      await sessions.insertOne({
        _id: session.id,
        userId: new ObjectId(session.userId),
        expiresAt: session.expiresAt,
      });
    },
    async find(id) {
      const doc = await sessions.findOne({ _id: id });
      return doc ? { id: doc._id, userId: doc.userId.toHexString(), expiresAt: doc.expiresAt } : undefined;
    },
    async delete(id) {
      await sessions.deleteOne({ _id: id });
    },
    async deleteByUser(userId, exceptId) {
      const _id = oid(userId);
      if (!_id) return 0;
      const result = await sessions.deleteMany({ userId: _id, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
      return result.deletedCount;
    },
  };
}

function toNode(doc: NodeDoc): NodeRecord {
  return {
    id: doc._id.toHexString(),
    parentId: doc.parentId?.toHexString() ?? null,
    ancestors: doc.ancestors.map((id) => id.toHexString()),
    kind: doc.kind,
    name: doc.name,
    ownerId: doc.ownerId.toHexString(),
    isPrivate: doc.isPrivate,
    size: doc.size,
    mime: doc.mime,
    storageKey: doc.storageKey,
    createdAt: doc.createdAt,
  };
}

function createNodeStore(nodes: Collection<NodeDoc>): NodeStore {
  return {
    async insert(node) {
      const doc: NodeDoc = {
        _id: new ObjectId(),
        parentId: node.parentId === null ? null : new ObjectId(node.parentId),
        ancestors: node.ancestors.map((id) => new ObjectId(id)),
        kind: node.kind,
        name: node.name,
        ownerId: new ObjectId(node.ownerId),
        isPrivate: node.isPrivate,
        size: node.size,
        mime: node.mime,
        storageKey: node.storageKey,
        createdAt: new Date(),
      };
      await nodes.insertOne(doc);
      return toNode(doc);
    },
    async findById(id) {
      const _id = oid(id);
      const doc = _id && (await nodes.findOne({ _id }));
      return doc ? toNode(doc) : undefined;
    },
    async findByIds(ids) {
      if (ids.length === 0) return [];
      return (await nodes.find({ _id: { $in: oids(ids) } }).toArray()).map(toNode);
    },
    async listChildren(parentId) {
      const parent = parentId === null ? null : oid(parentId);
      if (parent === undefined) return [];
      return (await nodes.find({ parentId: parent }).toArray()).map(toNode);
    },
    async listDescendants(id) {
      const _id = oid(id);
      if (!_id) return [];
      return (await nodes.find({ ancestors: _id }).toArray()).map(toNode);
    },
    async rename(id, name) {
      const _id = oid(id);
      if (_id) await nodes.updateOne({ _id }, { $set: { name } });
    },
    async setPrivate(id, isPrivate) {
      const _id = oid(id);
      if (_id) await nodes.updateOne({ _id }, { $set: { isPrivate } });
    },
    async deleteSubtree(id) {
      const _id = oid(id);
      if (_id) await nodes.deleteMany({ $or: [{ _id }, { ancestors: _id }] });
    },
    async existsOwnedBy(userId) {
      const _id = oid(userId);
      return _id ? (await nodes.findOne({ ownerId: _id }, { projection: { _id: 1 } })) !== null : false;
    },
  };
}

export function createMongoStores(db: Db): Stores {
  return {
    users: createUserStore(db.collection<UserDoc>('users')),
    sessions: createSessionStore(db.collection<SessionDoc>('sessions')),
    nodes: createNodeStore(db.collection<NodeDoc>('nodes')),
  };
}

async function ensureIndexes(db: Db): Promise<void> {
  await db.collection('users').createIndex({ loginKey: 1 }, { unique: true });
  // MongoDB removes expired sessions on its own.
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('sessions').createIndex({ userId: 1 });
  await db.collection('nodes').createIndex({ parentId: 1 });
  await db.collection('nodes').createIndex({ ancestors: 1 });
  await db.collection('nodes').createIndex({ ownerId: 1 });
}

export async function connectMongo(config: MongoConfig): Promise<{ client: MongoClient; stores: Stores }> {
  const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(config.db);
  await ensureIndexes(db);
  return { client, stores: createMongoStores(db) };
}
