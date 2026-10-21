import { loadConfig } from './config.ts';

const env = {
  MONGODB_URI: 'mongodb://localhost/test',
  S3_ENDPOINT: 'http://localhost:8080',
  S3_BUCKET: 'emotion',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

test('applies defaults', () => {
  const config = loadConfig(env);
  expect(config.port).toBe(3000);
  expect(config.mongo.db).toBe('emotion');
  expect(config.s3.forcePathStyle).toBe(true);
  expect(config.admin).toBeNull();
  expect(config.trustProxy).toBe('loopback');
});

test.each([
  ['true', true],
  ['1', 1],
  ['172.16.0.0/12', '172.16.0.0/12'],
])('parses TRUST_PROXY=%s', (value, expected) => {
  expect(loadConfig({ ...env, TRUST_PROXY: value }).trustProxy).toBe(expected);
});

test('lists every missing required variable', () => {
  expect(() => loadConfig({ S3_BUCKET: 'emotion' })).toThrow(
    'MONGODB_URI, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY',
  );
});

test('reads the administrator seed only when login and password are both set', () => {
  expect(loadConfig({ ...env, ADMIN_LOGIN: 'boss' }).admin).toBeNull();
  expect(loadConfig({ ...env, ADMIN_LOGIN: 'boss', ADMIN_PASSWORD: 'long-enough' }).admin).toEqual({
    login: 'boss',
    name: 'boss',
    password: 'long-enough',
  });
});
