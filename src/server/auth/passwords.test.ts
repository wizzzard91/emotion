import { hashPassword, verifyPassword } from './passwords.ts';

const FAST = { N: 1024, r: 8, p: 1 };

test('the hash is self-describing and verifies', async () => {
  const hash = await hashPassword('correct horse');
  expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  expect(await verifyPassword('correct horse', hash)).toBe(true);
  expect(await verifyPassword('correct horsf', hash)).toBe(false);
  expect(await verifyPassword('', hash)).toBe(false);
});

test('the salt is random: equal passwords give different hashes', async () => {
  const [a, b] = await Promise.all([hashPassword('пароль-123', FAST), hashPassword('пароль-123', FAST)]);
  expect(a).not.toBe(b);
  expect(await verifyPassword('пароль-123', a)).toBe(true);
  expect(await verifyPassword('пароль-123', b)).toBe(true);
});

test('parameters are read from the hash string', async () => {
  const hash = await hashPassword('старый пароль', FAST);
  expect(hash.startsWith('scrypt$1024$8$1$')).toBe(true);
  expect(await verifyPassword('старый пароль', hash)).toBe(true);
});

test('Unicode is normalised (composed and decomposed forms match)', async () => {
  const hash = await hashPassword('моййпароль', FAST);
  expect(await verifyPassword('моййпароль', hash)).toBe(true);
});

test('a malformed hash string is false, not an exception', async () => {
  for (const bad of ['', 'plain', 'scrypt$1024$8$1$c2FsdA', 'bcrypt$1024$8$1$c2FsdA$aGFzaA', 'scrypt$1000$8$1$c2FsdA$' + 'a'.repeat(43), 'scrypt$1e99$8$1$c2FsdA$' + 'a'.repeat(43)]) {
    expect(await verifyPassword('x', bad)).toBe(false);
  }
});
