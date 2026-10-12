import type { Readable } from 'node:stream';

/** Storage for file contents. Keys are opaque strings chosen by the caller. */
export interface Storage {
  /** Stores the whole stream and returns the number of bytes written. Leaves no partial object on error. */
  put(key: string, body: Readable, opts?: { contentType?: string }): Promise<{ size: number }>;
  /** Throws StorageNotFoundError when the key does not exist. */
  get(key: string): Promise<{ body: Readable; size: number }>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}
