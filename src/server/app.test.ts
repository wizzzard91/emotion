import request from 'supertest';
import { createApp } from './app.ts';
import { createMemoryStores } from './db/memory.ts';
import { MemoryStorage, testConfig } from './testing.ts';

const app = () => createApp({ stores: createMemoryStores(), storage: new MemoryStorage(), config: testConfig() });

test('the health check answers without a session', async () => {
  const res = await request(app()).get('/healthz').expect(200);
  expect(res.text).toBe('ok');
});

test('pages need a session; unknown paths render the 404 page', async () => {
  const drive = await request(app()).get('/drive').expect(302);
  expect(drive.headers.location).toBe('/login?next=%2Fdrive');
  const missing = await request(app()).get('/nope').expect(404);
  expect(missing.text).toContain('Страница не найдена');
});

test('cross-site POSTs are rejected', async () => {
  await request(app()).post('/logout').set('Origin', 'https://evil.example').expect(403);
  await request(app()).post('/logout').set('Sec-Fetch-Site', 'cross-site').expect(403);
});
