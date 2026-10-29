import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';

describe('native automatic capture store identity', () => {
  let directory: string;
  let stores: GraphologyStorage[];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-store-identity-'));
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores) await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const createStore = (persistPath?: string): GraphologyStorage => {
    const store = new GraphologyStorage(persistPath);
    stores.push(store);
    return store;
  };

  it('returns null until a persistent owner is initialized and leaves it unchanged', async () => {
    const persistPath = path.join(directory, 'embedded.json');
    const store = createStore(persistPath);

    expect(store.getNativeAutomaticCaptureStoreIdentityV4()).toBeNull();
    expect(fs.existsSync(persistPath)).toBe(false);
    await store.initialize();

    const beforeGraph = await store.exportGraph();
    const fileExistedBefore = fs.existsSync(persistPath);
    const fileBefore = fileExistedBefore ? fs.readFileSync(persistPath, 'utf8') : null;
    expect(store.getNativeAutomaticCaptureStoreIdentityV4()).toBe(
      embeddedAutomaticCaptureStoreHash(persistPath),
    );

    const afterGraph = await store.exportGraph();
    expect(afterGraph.version).toBe(beforeGraph.version);
    expect(afterGraph.entities).toEqual(beforeGraph.entities);
    expect(afterGraph.edges).toEqual(beforeGraph.edges);
    expect(afterGraph.episodes).toEqual(beforeGraph.episodes);
    expect(afterGraph.automatic_operations_v1).toEqual(beforeGraph.automatic_operations_v1);
    expect(fs.existsSync(persistPath)).toBe(fileExistedBefore);
    expect(fileExistedBefore ? fs.readFileSync(persistPath, 'utf8') : null).toBe(fileBefore);
    expect(beforeGraph.episodes).toEqual([]);
    expect(beforeGraph.automatic_operations_v1?.operations ?? []).toEqual([]);

    const memoryOnly = createStore();
    await memoryOnly.initialize();
    expect(memoryOnly.getNativeAutomaticCaptureStoreIdentityV4()).toBeNull();
  });

  it('distinguishes actual persistent paths and reproduces the identity after reopen', async () => {
    const firstPath = path.join(directory, 'first.json');
    const secondPath = path.join(directory, 'second.json');
    const first = createStore(firstPath);
    const second = createStore(secondPath);
    await Promise.all([first.initialize(), second.initialize()]);

    const firstIdentity = first.getNativeAutomaticCaptureStoreIdentityV4();
    const secondIdentity = second.getNativeAutomaticCaptureStoreIdentityV4();
    expect(firstIdentity).toBe(embeddedAutomaticCaptureStoreHash(firstPath));
    expect(secondIdentity).toBe(embeddedAutomaticCaptureStoreHash(secondPath));
    expect(firstIdentity).not.toBe(secondIdentity);

    const fileBeforeReopen = fs.existsSync(firstPath) ? fs.readFileSync(firstPath, 'utf8') : null;
    await first.close();
    const reopened = createStore(firstPath);
    expect(reopened.getNativeAutomaticCaptureStoreIdentityV4()).toBeNull();
    await reopened.initialize();
    expect(reopened.getNativeAutomaticCaptureStoreIdentityV4()).toBe(firstIdentity);
    expect(fs.existsSync(firstPath) ? fs.readFileSync(firstPath, 'utf8') : null).toBe(
      fileBeforeReopen,
    );
  });
});
