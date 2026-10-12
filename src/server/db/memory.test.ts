import { describeStores } from './contract.ts';
import { createMemoryStores } from './memory.ts';

describeStores('in-memory', async () => createMemoryStores());
