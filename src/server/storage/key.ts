// Segments of [A-Za-z0-9._-] separated by "/"; a segment may not start with a dot.
const KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const MAX_KEY_LENGTH = 512;

export class InvalidStorageKeyError extends Error {
  constructor(key: unknown) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = 'InvalidStorageKeyError';
  }
}

/** One set of rules for every backend, so a key accepted by one is valid for another. */
export function assertValidKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    key.includes('..') ||
    !KEY_RE.test(key)
  ) {
    throw new InvalidStorageKeyError(key);
  }
}
