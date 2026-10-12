import type { S3Config } from '../config.ts';
import { S3Storage } from './s3.ts';
import type { Storage } from './types.ts';

export { InvalidStorageKeyError } from './key.ts';
export { S3Storage } from './s3.ts';
export { StorageNotFoundError } from './types.ts';
export type { Storage } from './types.ts';

export function createStorage(config: S3Config): Storage {
  return new S3Storage(config);
}
