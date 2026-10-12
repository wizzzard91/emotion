import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// ~32 MB of memory and tens of milliseconds per hash: affordable even on a weak machine.
const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function derive(password: string, salt: Buffer, keyLen: number, params: ScryptParams): Promise<Buffer> {
  const { N, r, p } = params;
  return new Promise((resolve, reject) => {
    // NFKC: the same letter typed on macOS and on Windows must yield the same password.
    scrypt(password.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** String format: `scrypt$N$r$p$salt$hash`, salt and hash in base64url. */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parseHash(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const sane =
    Number.isInteger(N) && N >= 2 && N <= 2 ** 20 && (N & (N - 1)) === 0 &&
    Number.isInteger(r) && r >= 1 && r <= 32 &&
    Number.isInteger(p) && p >= 1 && p <= 16;
  if (!sane) return undefined;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const key = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || key.length < 16 || key.length > 128) return undefined;
  return { params: { N, r, p }, salt, key };
}

/** A malformed hash string simply means "wrong password"; nothing is thrown. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.key.length, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

/** The same work as a real check, so an unknown login does not give itself away through response time. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, randomBytes(SALT_BYTES), KEY_BYTES, DEFAULT_PARAMS);
}
