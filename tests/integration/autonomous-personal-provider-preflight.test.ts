import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';
import { providerPreflightBackendContract } from '../helpers/autonomousPersonalProviderPreflightContract';

providerPreflightBackendContract('embedded actual-source provider preflight', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-provider-preflight-'));
  const file = join(directory, 'store.json');
  const stores: GraphologyStorage[] = [];
  const readers: jest.SpyInstance[] = [];
  async function open() {
    const storage = new GraphologyStorage(file);
    await storage.initialize();
    stores.push(storage);
    readers.push(
      jest.spyOn(storage as unknown as { runMutation: () => Promise<unknown> }, 'runMutation'),
    );
    return storage;
  }
  const store = await open();
  const seed = await seedAutonomousPersonalCaptureSubject(store);
  return {
    store,
    seed,
    nativeState: async () => fs.readFileSync(file, 'utf8'),
    readCount: () => readers.reduce((total, spy) => total + spy.mock.calls.length, 0),
    anotherOwner: open,
    close: async () => {
      for (const storage of stores) await storage.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
});
