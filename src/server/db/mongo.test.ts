// Runs the store contract against a real MongoDB. Skipped unless MONGODB_TEST_URI is set:
//   MONGODB_TEST_URI=mongodb://... pnpm jest src/server/db
// A throwaway database is created for the run and dropped afterwards.
import { randomBytes } from 'node:crypto';
import type { MongoClient } from 'mongodb';
import { describeStores } from './contract.ts';
import { connectMongo } from './mongo.ts';
import type { Stores } from './types.ts';

const uri = process.env.MONGODB_TEST_URI;

if (!uri) {
  test.skip('MongoDB stores (set MONGODB_TEST_URI to run)', () => {});
} else {
  const dbName = `emotion_test_${randomBytes(4).toString('hex')}`;
  let client: MongoClient;
  let stores: Stores;

  beforeAll(async () => {
    ({ client, stores } = await connectMongo({ uri, db: dbName }));
  }, 30_000);

  afterAll(async () => {
    await client.db(dbName).dropDatabase();
    await client.close();
  });

  describeStores('MongoDB', async () => {
    const db = client.db(dbName);
    await Promise.all(['users', 'sessions', 'nodes'].map((name) => db.collection(name).deleteMany({})));
    return stores;
  });

  jest.setTimeout(30_000);
}
