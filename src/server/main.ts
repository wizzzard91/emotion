import { createApp } from './app.ts';
import { ensureAdmin } from './auth/bootstrap.ts';
import { loadConfig } from './config.ts';
import { connectMongo } from './db/mongo.ts';
import { createStorage } from './storage/index.ts';

const config = loadConfig();
const { client, stores } = await connectMongo(config.mongo).catch((err: unknown) => {
  console.error(`Cannot connect to MongoDB: ${err instanceof Error ? err.message : err}`);
  console.error('Check MONGODB_URI and, for Atlas, that this machine\'s IP is on the Network Access list.');
  process.exit(1);
});
const storage = createStorage(config.s3);

const seeded = await ensureAdmin(stores, config.admin);
if (seeded === 'created') console.log(`Created administrator "${config.admin!.login}"`);
if ((await stores.users.countAdmins()) === 0) {
  console.warn('No administrator exists: set ADMIN_LOGIN and ADMIN_PASSWORD and restart to create one.');
}

const server = createApp({ stores, storage, config }).listen(config.port, () => {
  console.log(`Emotion is listening on http://localhost:${config.port}`);
});
// Large uploads over a slow link must not be cut off by a timeout.
server.requestTimeout = 0;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      client.close().finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  });
}
