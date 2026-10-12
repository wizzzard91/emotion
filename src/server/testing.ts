// Shared helpers for unit tests.
import { Readable } from 'node:stream';
import { loadConfig, type Config } from './config.ts';
import type { NewNodeRecord } from './db/types.ts';
import { StorageNotFoundError, type Storage } from './storage/types.ts';

export function testConfig(env: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    MONGODB_URI: 'mongodb://localhost/test',
    S3_ENDPOINT: 'http://localhost:8080',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    ...env,
  });
}

export function folderRecord(ownerId: string, name: string, extra: Partial<NewNodeRecord> = {}): NewNodeRecord {
  return {
    parentId: null,
    ancestors: [],
    kind: 'folder',
    name,
    ownerId,
    isPrivate: false,
    size: 0,
    mime: null,
    storageKey: null,
    ...extra,
  };
}

export class MemoryStorage implements Storage {
  objects = new Map<string, Buffer>();
  started = 0;
  pending = 0;
  failPut = false;

  async put(key: string, body: Readable): Promise<{ size: number }> {
    this.started++;
    this.pending++;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      if (this.failPut) throw new Error('disk full');
      const data = Buffer.concat(chunks);
      this.objects.set(key, data);
      return { size: data.length };
    } finally {
      this.pending--;
    }
  }

  async get(key: string): Promise<{ body: Readable; size: number }> {
    const data = this.objects.get(key);
    if (!data) throw new StorageNotFoundError(key);
    return { body: Readable.from([data]), size: data.length };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
