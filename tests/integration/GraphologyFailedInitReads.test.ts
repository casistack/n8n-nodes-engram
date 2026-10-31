import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EngramStorageLoadFailedError,
  GraphologyStorage,
} from '../../src/storage/GraphologyStorage';
import { getAutomaticClaimReadScope } from '../../src/storage/AutomaticClaimReadScope';
import {
  AutonomousPersonalExecutionScopeBudgetError,
  bindAutonomousPersonalExecutionScopeV1,
  openAutonomousPersonalExecutionScopeV1,
  runAutonomousPersonalExecutionScopeV1,
} from '../../src/storage/AutonomousPersonalExecutionScopeV1';

/**
 * A store whose latest persisted load failed must never answer reads from an empty or
 * stale graph and must never let a write recreate or replace the persisted file. Outcomes
 * are recorded inside the persist lock; a corrected valid file recovers through either an
 * explicit `initialize()` retry or a write (which refreshes under the same lock).
 */

const ORIGINAL_FAILURE = 'Failed to load or migrate embedded storage';

let directories: string[] = [];
let stores: GraphologyStorage[] = [];

afterEach(async () => {
  jest.restoreAllMocks();
  for (const store of stores) await store.close();
  stores = [];
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function track(store: GraphologyStorage): GraphologyStorage {
  stores.push(store);
  return store;
}

async function persistedStore() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-failed-init-'));
  directories.push(directory);
  const file = join(directory, 'store.json');
  const store = new GraphologyStorage(file);
  await store.initialize();
  const entity = await store.addEntity({
    group_id: 'failed-init',
    name: 'Synthetic persisted entity',
    entity_type: 'concept',
    attributes: {},
  });
  await store.addEpisode({
    group_id: 'failed-init',
    content: 'Synthetic persisted episode',
    role: 'human',
    reference_time: '2026-10-30T00:00:00.000Z',
  });
  await store.close();
  return { directory, file, entityId: entity.uuid, good: fs.readFileSync(file) };
}

function corrupt(file: string): Buffer {
  fs.writeFileSync(file, '{ not valid json');
  return fs.readFileSync(file);
}

function isInitialized(store: GraphologyStorage): boolean {
  return (store as unknown as { initialized: boolean }).initialized;
}

async function rejection(promise: Promise<unknown>): Promise<Error & { cause?: unknown }> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  if (!failure) throw new Error('Expected the call to reject');
  return failure;
}

/**
 * The es2019 `Error` type declares no `cause`, so read it through its own descriptor. This
 * also asserts it exists as a non-enumerable own data property (the production contract).
 */
function causeOf(error: Error): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
  expect(descriptor).toBeDefined();
  expect(descriptor?.enumerable).toBe(false);
  return descriptor?.value;
}

async function expectLoadFailed(promise: Promise<unknown>) {
  const failure = await rejection(promise);
  expect(failure).toBeInstanceOf(EngramStorageLoadFailedError);
  expect((failure as EngramStorageLoadFailedError).reason).toBe('initialize_failed');
  return failure as EngramStorageLoadFailedError;
}

type Method = (...args: unknown[]) => Promise<unknown>;
function call(store: GraphologyStorage, name: string, args: unknown[]): Promise<unknown> {
  return (store as unknown as Record<string, Method>)[name]!(...args);
}

const ISO = '2026-10-30T00:00:00.000Z';

/** Public read methods that answer from the in-memory graph, with minimal valid arguments. */
const GUARDED_READS: Array<[string, unknown[]]> = [
  ['getEntity', ['x']],
  ['getEntityByName', ['n', 'failed-init']],
  ['listEntities', ['failed-init']],
  ['getEdge', ['x']],
  ['getEdgesBetween', ['a', 'b']],
  ['getEdgesForEntity', ['a']],
  ['getEpisode', ['x']],
  ['getEpisodes', [['x']]],
  ['listEpisodes', ['failed-init']],
  ['getRecentEpisodes', ['failed-init', 1]],
  ['getEpisodeCount', ['failed-init']],
  ['getEpisodesByDateRange', ['failed-init', ISO, ISO]],
  ['getEdgeChangelog', ['failed-init', ISO]],
  ['searchEntities', ['query', 'failed-init']],
  ['searchEdges', ['query', 'failed-init']],
  ['searchEntitiesByVector', [[1], 'failed-init']],
  ['searchEdgesByVector', [[1], 'failed-init']],
  ['exportGraph', []],
  ['getStats', []],
  ['rebuildSearchIndex', []],
  ['readExtractionSnapshot', []],
];

/** Guarded through `runMutation` (post-refresh check, before rollback state and mutation). */
const GUARDED_MUTATIONS: Array<[string, unknown[]]> = [
  ['addEntity', [{ group_id: 'failed-init', name: 'New', entity_type: 'concept', attributes: {} }]],
  ['addEpisode', [{ group_id: 'failed-init', content: 'New', role: 'human', reference_time: ISO }]],
  [
    'appendEpisode',
    [{ group_id: 'failed-init', content: 'New', role: 'human', reference_time: ISO }],
  ],
  ['deleteEntity', ['x']],
  ['updateEntity', ['x', { name: 'Changed' }]],
  ['updateEdge', ['x', { fact: 'Changed' }]],
  ['deleteEdge', ['x']],
  ['updateEpisode', ['x', { content: 'Changed' }]],
  ['deleteEpisode', ['x']],
  [
    'appendEpisodes',
    [[{ group_id: 'failed-init', content: 'New', role: 'human', reference_time: ISO }]],
  ],
  ['clearGroup', ['failed-init']],
  ['clearAll', []],
  ['previewQueueClear', []],
];

/**
 * Not guarded by `assertLoaded`, with tests below: `readAutomaticClaimContext` reads the
 * persisted file under its own validation, and the compositional reader and outcome reader
 * answer from their own status checks.
 */
const GUARDED_ELSEWHERE = [
  'readAutomaticClaimContext',
  'readCompositionalRetrievalSnapshotV3',
  'getAutomaticCaptureOutcomeV2',
];

/** Mutations guarded by the same `runMutation` check, not individually invoked here. */
const GUARDED_MUTATIONS_NOT_INVOKED = [
  'addEdge',
  'purgeEpisodes',
  'importGraph',
  'applyRetention',
  'appendEpisodesWithExtraction',
  'appendAutomaticEpisodes',
  'appendAutomaticEpisodesWithExtraction',
  'extractionQueueCommand',
  'applyStagedExtraction',
  'importExtractionBackup',
];

/** Deliberately unguarded: lifecycle, static configuration and in-memory diagnostics. */
const EXEMPT = [
  'initialize',
  'close',
  'getLastMutationDiagnostics',
  'getMigrationStatus',
  'migrateStorageSchema',
  'supportsDurableExtraction',
  'extractionBackend',
  'getNativeAutomaticCaptureStoreIdentityV4',
];

describe('failed persisted initialization', () => {
  it('classifies every IGraphStorage method exactly once', () => {
    const all = [
      ...GUARDED_READS.map(([name]) => name),
      ...GUARDED_MUTATIONS.map(([name]) => name),
      ...GUARDED_ELSEWHERE,
      ...GUARDED_MUTATIONS_NOT_INVOKED,
      ...EXEMPT,
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const name of all) {
      expect(typeof (GraphologyStorage.prototype as unknown as Record<string, unknown>)[name]).toBe(
        'function',
      );
    }
    // IGraphStorage core + optional members, as declared in src/storage/IGraphStorage.ts.
    const declared = [
      'initialize',
      'close',
      'addEntity',
      'getEntity',
      'getEntityByName',
      'updateEntity',
      'deleteEntity',
      'listEntities',
      'addEdge',
      'getEdge',
      'getEdgesBetween',
      'getEdgesForEntity',
      'updateEdge',
      'deleteEdge',
      'addEpisode',
      'appendEpisode',
      'appendEpisodes',
      'getEpisode',
      'getEpisodes',
      'listEpisodes',
      'updateEpisode',
      'deleteEpisode',
      'purgeEpisodes',
      'getRecentEpisodes',
      'getEpisodeCount',
      'getEpisodesByDateRange',
      'getLastMutationDiagnostics',
      'getEdgeChangelog',
      'searchEntities',
      'searchEdges',
      'searchEntitiesByVector',
      'searchEdgesByVector',
      'clearGroup',
      'clearAll',
      'exportGraph',
      'importGraph',
      'getStats',
      'getMigrationStatus',
      'migrateStorageSchema',
      'rebuildSearchIndex',
      'applyRetention',
      'previewQueueClear',
      'readExtractionSnapshot',
      'readAutomaticClaimContext',
      'readCompositionalRetrievalSnapshotV3',
      'getAutomaticCaptureOutcomeV2',
      'appendEpisodesWithExtraction',
      'appendAutomaticEpisodes',
      'appendAutomaticEpisodesWithExtraction',
      'extractionQueueCommand',
      'applyStagedExtraction',
      'importExtractionBackup',
      'supportsDurableExtraction',
      'extractionBackend',
      'getNativeAutomaticCaptureStoreIdentityV4',
    ];
    for (const name of declared) expect(all).toContain(name);
  });

  it('keeps the original initialize error, then fails every guarded read with the typed error', async () => {
    const { directory, file } = await persistedStore();
    const corruptBytes = corrupt(file);
    const store = track(new GraphologyStorage(file));

    const original = await rejection(store.initialize());
    expect(original).not.toBeInstanceOf(EngramStorageLoadFailedError);
    expect(original.message).toContain(ORIGINAL_FAILURE);
    expect(isInitialized(store)).toBe(false);
    expect(store.getNativeAutomaticCaptureStoreIdentityV4()).toBeNull();

    // The sticky state keeps the ORIGINAL (raw) load error, which is exactly the
    // non-enumerable cause that the initialize() wrapper carries. The wrapper message
    // is unchanged; no message text of the cause is guessed.
    const originalCause = causeOf(original);
    expect(originalCause).toBeDefined();
    for (const [name, args] of GUARDED_READS) {
      const failure = await expectLoadFailed(call(store, name, args));
      expect(causeOf(failure)).toBe(originalCause);
    }

    const typed = await expectLoadFailed(store.exportGraph());
    expect(typed.message).not.toContain(directory);
    expect(typed.message).not.toContain('store.json');
    expect(Object.keys(typed)).not.toContain('cause');
    expect(Object.getOwnPropertyDescriptor(typed, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(typed)).not.toContain(directory);
    expect(fs.readFileSync(file).equals(corruptBytes)).toBe(true);
  });

  it('exempt methods keep working after a failed load', async () => {
    const { file } = await persistedStore();
    corrupt(file);
    const store = track(new GraphologyStorage(file));
    await rejection(store.initialize());
    expect(store.supportsDurableExtraction()).toBe(true);
    expect(store.extractionBackend()).toBe('embedded');
    expect(store.getLastMutationDiagnostics()).toBeNull();
    expect((await store.getMigrationStatus()).backend).toBe('embedded');
    await store.close();
  });

  it('retry with the file now missing fails typed, stays uninitialized and creates nothing', async () => {
    const { file } = await persistedStore();
    corrupt(file);
    const store = track(new GraphologyStorage(file));
    await rejection(store.initialize());

    fs.rmSync(file);
    await expectLoadFailed(store.initialize());

    expect(isInitialized(store)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    await expectLoadFailed(store.listEntities('failed-init'));
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each(GUARDED_MUTATIONS.map(([name, args]) => [name, args] as const))(
    'refuses %s after a failed load when the file went missing and never recreates the store',
    async (name, args) => {
      const { file, directory } = await persistedStore();
      corrupt(file);
      const store = track(new GraphologyStorage(file));
      await rejection(store.initialize());
      fs.rmSync(file);

      await expectLoadFailed(call(store, name, [...args]));

      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(directory).filter((entry) => entry.includes('store.json'))).toEqual([]);
      expect(isInitialized(store)).toBe(false);
    },
  );

  it('recovers through initialize() once the file is corrected, and reads return the corrected data', async () => {
    const { file, entityId, good } = await persistedStore();
    corrupt(file);
    const store = track(new GraphologyStorage(file));
    await rejection(store.initialize());
    await expectLoadFailed(store.getEntity(entityId));

    fs.writeFileSync(file, good);
    await store.initialize();

    expect(isInitialized(store)).toBe(true);
    expect((await store.getEntity(entityId))?.name).toBe('Synthetic persisted entity');
    expect((await store.listEntities('failed-init')).map((row) => row.uuid)).toEqual([entityId]);
    expect(await store.getEpisodeCount('failed-init')).toBe(1);
  });

  it('recovers through a write (without initialize) once the file is corrected', async () => {
    const { file, entityId, good } = await persistedStore();
    corrupt(file);
    const store = track(new GraphologyStorage(file));
    await rejection(store.initialize());

    fs.writeFileSync(file, good);
    const added = await store.addEntity({
      group_id: 'failed-init',
      name: 'Written after recovery',
      entity_type: 'concept',
      attributes: {},
    });

    const names = (await store.listEntities('failed-init')).map((row) => row.name).sort();
    expect(names).toEqual(['Synthetic persisted entity', 'Written after recovery']);
    expect((await store.getEntity(entityId))?.name).toBe('Synthetic persisted entity');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      entities: Array<{ uuid: string }>;
    };
    expect(persisted.entities.map((row) => row.uuid)).toContain(added.uuid);
    expect(persisted.entities.map((row) => row.uuid)).toContain(entityId);
  });

  it('keeps the fresh no-file behavior: initialize then write creates the file', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'engram-fresh-'));
    directories.push(directory);
    const file = join(directory, 'fresh.json');
    const store = track(new GraphologyStorage(file));
    await store.initialize();
    expect(isInitialized(store)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    await store.addEntity({
      group_id: 'fresh',
      name: 'Fresh',
      entity_type: 'concept',
      attributes: {},
    });
    expect(fs.existsSync(file)).toBe(true);
    expect((await store.listEntities('fresh')).map((row) => row.name)).toEqual(['Fresh']);
  });

  it('keeps the fresh no-file behavior for a write without initialize()', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'engram-fresh-preinit-'));
    directories.push(directory);
    const file = join(directory, 'fresh.json');
    const store = track(new GraphologyStorage(file));
    expect(await store.listEntities('fresh')).toEqual([]);
    await store.addEntity({
      group_id: 'fresh',
      name: 'Fresh',
      entity_type: 'concept',
      attributes: {},
    });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('keeps in-memory stores usable with and without initialize()', async () => {
    const store = track(new GraphologyStorage());
    expect(await store.listEntities('memory')).toEqual([]);
    await store.initialize();
    expect(isInitialized(store)).toBe(true);
    await store.addEntity({
      group_id: 'memory',
      name: 'Memory',
      entity_type: 'concept',
      attributes: {},
    });
    expect((await store.listEntities('memory')).map((row) => row.name)).toEqual(['Memory']);
  });

  it('a previously healthy instance keeps its in-memory reads when a later refresh fails', async () => {
    const { file, entityId } = await persistedStore();
    const store = track(new GraphologyStorage(file));
    await store.initialize();
    expect((await store.getEntity(entityId))?.name).toBe('Synthetic persisted entity');

    const corruptBytes = corrupt(file);
    const failure = await rejection(
      store.addEntity({
        group_id: 'failed-init',
        name: 'Refused',
        entity_type: 'concept',
        attributes: {},
      }),
    );

    // Today's behavior is unchanged: the refresh error surfaces and reads keep working.
    expect(failure).not.toBeInstanceOf(EngramStorageLoadFailedError);
    expect(isInitialized(store)).toBe(true);
    expect((await store.getEntity(entityId))?.name).toBe('Synthetic persisted entity');
    expect(await store.getEpisodeCount('failed-init')).toBe(1);
    expect(fs.readFileSync(file).equals(corruptBytes)).toBe(true);
  });

  describe('persisted-file readers keep their own contracts after a failed load', () => {
    const scope = () => getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const MISSING_STORE = { status: 'unavailable', reason: 'missing_store' };

    it('readAutomaticClaimContext on a corrected file answers exactly like a never-failed instance', async () => {
      const { file, good } = await persistedStore();
      const baselineStore = track(new GraphologyStorage(file));
      await baselineStore.initialize();
      const baseline = await baselineStore.readAutomaticClaimContext(
        'failed-init',
        'missing-edge',
        scope(),
      );

      corrupt(file);
      const store = track(new GraphologyStorage(file));
      await rejection(store.initialize());
      fs.writeFileSync(file, good);
      const result = await store.readAutomaticClaimContext('failed-init', 'missing-edge', scope());

      expect(result).toEqual(baseline);
      // The file reader does not recover the in-memory graph, so graph reads stay closed.
      await expectLoadFailed(store.listEntities('failed-init'));
    });

    const INVALID_CONTEXT = { status: 'invalid', reason: 'invalid_context' };

    it('readAutomaticClaimContext on a still-missing file matches a never-failed instance (native fs probe)', async () => {
      const { file } = await persistedStore();
      corrupt(file);
      const store = track(new GraphologyStorage(file));
      await rejection(store.initialize());
      fs.rmSync(file);

      const result = await store.readAutomaticClaimContext('failed-init', 'missing-edge', scope());

      // Baseline comparison is the strong claim: the failed-init state changes nothing.
      const never = track(new GraphologyStorage(file));
      expect(await never.readAutomaticClaimContext('failed-init', 'missing-edge', scope())).toEqual(
        result,
      );
      expect(fs.existsSync(file)).toBe(false);
      // The source catch tests `error instanceof Error`. Node's native fs errors can come
      // from another realm under Jest, which makes that test false and yields
      // invalid_context. Which of the two the native probe gives is realm-dependent and is
      // NOT an approved behavior change; root must confirm it in a single realm.
      expect([MISSING_STORE, INVALID_CONTEXT]).toContainEqual(result);
    });

    it('readAutomaticClaimContext on a still-missing file is unavailable/missing_store through the ENOENT branch', async () => {
      const { file } = await persistedStore();
      corrupt(file);
      const store = track(new GraphologyStorage(file));
      await rejection(store.initialize());
      fs.rmSync(file);

      // Narrow mock: ONLY the store file, ONLY while it is actually absent, with an
      // ENOENT error built in this test's realm so the branch under test is reachable.
      const realStat = fs.promises.stat.bind(fs.promises);
      const stat = jest.spyOn(fs.promises, 'stat').mockImplementation(((
        target: unknown,
        ...rest: unknown[]
      ) => {
        if (String(target) === file && !fs.existsSync(file)) {
          return Promise.reject(
            Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' }),
          );
        }
        return (realStat as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
      }) as unknown as typeof fs.promises.stat);

      const result = await store.readAutomaticClaimContext('failed-init', 'missing-edge', scope());

      expect(result).toEqual(MISSING_STORE);
      expect(stat.mock.calls.some(([target]) => String(target) === file)).toBe(true);
      const never = track(new GraphologyStorage(file));
      expect(await never.readAutomaticClaimContext('failed-init', 'missing-edge', scope())).toEqual(
        MISSING_STORE,
      );
      expect(fs.existsSync(file)).toBe(false);
    });

    it('readCompositionalRetrievalSnapshotV3 is unavailable/missing_store while the load is failed', async () => {
      const { file } = await persistedStore();
      corrupt(file);
      const store = track(new GraphologyStorage(file));
      await rejection(store.initialize());

      expect(await store.readCompositionalRetrievalSnapshotV3(scope())).toEqual(MISSING_STORE);
      fs.rmSync(file);
      expect(await store.readCompositionalRetrievalSnapshotV3(scope())).toEqual(MISSING_STORE);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('readCompositionalRetrievalSnapshotV3 returns the corrected graph once initialize() recovers', async () => {
      const { file, entityId, good } = await persistedStore();
      corrupt(file);
      const store = track(new GraphologyStorage(file));
      await rejection(store.initialize());
      expect(await store.readCompositionalRetrievalSnapshotV3(scope())).toEqual(MISSING_STORE);

      fs.writeFileSync(file, good);
      await store.initialize();
      const result = await store.readCompositionalRetrievalSnapshotV3(scope());

      expect(result.status).toBe('snapshot');
      if (result.status !== 'snapshot') throw new Error('Expected a snapshot');
      expect(result.graph.entities.map((row) => row.uuid)).toEqual([entityId]);
      expect(fs.readFileSync(file).equals(good)).toBe(true);
    });
  });

  describe('concurrent initialize() calls with a controlled file swap', () => {
    /**
     * Deterministic lock order: call A takes the persist lock and its file read is held on a
     * deferred promise AFTER the real bytes were read. Call B can only start waiting on the
     * lock, so A is always the first reader. The file is swapped while A is held, so B
     * always reads the replacement.
     */
    function holdFirstRead(file: string) {
      const real = fs.promises.readFile.bind(fs.promises);
      let reads = 0;
      let markFirstRead!: () => void;
      const firstRead = new Promise<void>((resolve) => {
        markFirstRead = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(fs.promises, 'readFile').mockImplementation(((
        target: unknown,
        ...rest: unknown[]
      ) => {
        const result = (real as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
        if (String(target) !== file) return result;
        reads += 1;
        if (reads !== 1) return result;
        return result.then(async (data) => {
          markFirstRead();
          await gate;
          return data;
        });
      }) as unknown as typeof fs.promises.readFile);
      return { firstRead, release };
    }

    it('A fails, B (next in lock order) succeeds: B clears and A keeps its own error', async () => {
      const { file, entityId, good } = await persistedStore();
      corrupt(file);
      const store = track(new GraphologyStorage(file));
      const { firstRead, release } = holdFirstRead(file);

      const a = store.initialize();
      await firstRead; // A holds the lock and already read the corrupt bytes
      fs.writeFileSync(file, good);
      const b = store.initialize();
      release();
      const [resultA, resultB] = await Promise.allSettled([a, b]);

      expect(resultA.status).toBe('rejected');
      const reasonA = (resultA as PromiseRejectedResult).reason as Error;
      expect(reasonA).not.toBeInstanceOf(EngramStorageLoadFailedError);
      expect(reasonA.message).toContain(ORIGINAL_FAILURE);
      expect(resultB.status).toBe('fulfilled');
      expect(isInitialized(store)).toBe(true);
      expect((await store.getEntity(entityId))?.name).toBe('Synthetic persisted entity');
    });

    it('A succeeds, B (next in lock order) fails: the latest failure wins and reads fail closed', async () => {
      const { file, good } = await persistedStore();
      fs.writeFileSync(file, good);
      const store = track(new GraphologyStorage(file));
      const { firstRead, release } = holdFirstRead(file);

      const a = store.initialize();
      await firstRead; // A holds the lock and already read the good bytes
      corrupt(file);
      const b = store.initialize();
      release();
      const [resultA, resultB] = await Promise.allSettled([a, b]);

      // A finishes (and releases the lock) before B can even acquire it.
      expect(resultA.status).toBe('fulfilled');
      expect(resultB.status).toBe('rejected');
      const reasonB = (resultB as PromiseRejectedResult).reason as Error;
      expect(reasonB).not.toBeInstanceOf(EngramStorageLoadFailedError);
      expect(reasonB.message).toContain(ORIGINAL_FAILURE);
      expect(isInitialized(store)).toBe(false);
      await expectLoadFailed(store.listEntities('failed-init'));
    });

    it('an older successful load that resumes after a newer failure throws typed and never sets initialized', async () => {
      const { file, good } = await persistedStore();
      fs.writeFileSync(file, good);
      const store = track(new GraphologyStorage(file));
      const prototype = GraphologyStorage.prototype as unknown as {
        loadFromDisk: () => Promise<void>;
      };
      const realLoad = prototype.loadFromDisk;
      let calls = 0;
      let markHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        markHeld = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(prototype, 'loadFromDisk').mockImplementation(async function (
        this: GraphologyStorage,
      ) {
        calls += 1;
        const isFirst = calls === 1;
        await realLoad.call(this);
        if (isFirst) {
          // The first load succeeded and released the lock; hold its initialize() continuation.
          markHeld();
          await gate;
        }
      });

      const a = store.initialize();
      await held;
      expect(isInitialized(store)).toBe(false);
      corrupt(file);
      const resultB = await Promise.allSettled([store.initialize()]);
      expect(resultB[0]!.status).toBe('rejected');
      const newerError = (resultB[0] as PromiseRejectedResult).reason as Error;
      expect(newerError.message).toContain(ORIGINAL_FAILURE);
      const newerCause = causeOf(newerError);
      expect(newerCause).toBeDefined();

      release();
      const failure = await expectLoadFailed(a);
      // The older call fails with the NEWER failure's original error.
      expect(causeOf(failure)).toBe(newerCause);
      expect(isInitialized(store)).toBe(false);
      await expectLoadFailed(store.getStats());
    });
  });

  describe('cancellation and deadline during the load', () => {
    const budget = {
      semantics: 'configured',
      version: 1,
      completion: { mode: 'inheritOverall' },
      syntax: { mode: 'inheritOverall' },
      finalizationReserve: { mode: 'automatic' },
    };

    /** Disturbs the scope right after the store file was opened, inside the persist lock. */
    async function scopedFailure(file: string, parent: AbortController, disturb: () => void) {
      const realOpen = fs.promises.open.bind(fs.promises);
      jest.spyOn(fs.promises, 'open').mockImplementation((async (
        target: Parameters<typeof realOpen>[0],
        ...rest: unknown[]
      ) => {
        const handle = await (realOpen as (...args: unknown[]) => Promise<unknown>)(
          target,
          ...rest,
        );
        if (String(target) === file) disturb();
        return handle;
      }) as unknown as typeof fs.promises.open);
      const context = {};
      const entry = openAutonomousPersonalExecutionScopeV1(context, 'memorySave');
      bindAutonomousPersonalExecutionScopeV1(entry, context, budget, 30_000, parent.signal);
      const store = track(new GraphologyStorage(file));
      let failure: unknown;
      try {
        await runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
          await store.initialize();
        });
      } catch (error) {
        failure = error;
      }
      jest.restoreAllMocks();
      return { store, failure };
    }

    it.each([
      [
        'abort',
        'parent_cancelled',
        (parent: AbortController) => () => {
          parent.abort();
        },
      ],
      [
        'deadline',
        'invocation_deadline',
        () => {
          const realNow = performance.now.bind(performance);
          let offset = 0;
          jest.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
          return () => {
            offset += 120_000;
          };
        },
      ],
    ] as const)(
      'a %s mid-load keeps the original error, fails reads closed and is retry-recoverable',
      async (_name, stopReason, makeDisturbance) => {
        const { file, entityId } = await persistedStore();
        const before = fs.readFileSync(file);
        const parent = new AbortController();
        const { store, failure } = await scopedFailure(file, parent, makeDisturbance(parent));

        expect(failure).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
        expect((failure as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
          stopReason,
        );
        expect(isInitialized(store)).toBe(false);
        const typed = await expectLoadFailed(store.getEntity(entityId));
        expect(causeOf(typed)).toBe(failure);
        expect(fs.readFileSync(file).equals(before)).toBe(true);

        await store.initialize();
        expect(isInitialized(store)).toBe(true);
        expect((await store.getEntity(entityId))?.name).toBe('Synthetic persisted entity');
      },
    );
  });
});
