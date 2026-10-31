import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as RecordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import * as LosslessGraph from '../../src/storage/LosslessAutomaticCaptureGraph';
import { getOwnedImmutableGraphData } from '../../src/storage/ImmutableGraphSnapshot';
import {
  closeAutonomousPersonalCompletionV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { getAutomaticClaimReadScope } from '../../src/storage/AutomaticClaimReadScope';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { GraphData } from '../../src/schemas';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

/**
 * Private stable-read DATA cache: exact raw-byte hits skip only the lossless schema parse.
 * Every read still opens, charges, reads, hashes, stat-checks and integrity-checks.
 */
type Counters = { hits: number; misses: number };
type WriteTextAtomic = (payload: string, path: string, ...rest: unknown[]) => Promise<void>;
const proto = GraphologyStorage.prototype as unknown as { writeTextAtomic: WriteTextAtomic };
const realWriteTextAtomic = proto.writeTextAtomic;
const realParse = LosslessGraph.parseLosslessAutomaticCaptureGraph;

let directories: string[] = [];
let openStores: GraphologyStorage[] = [];

afterEach(async () => {
  jest.restoreAllMocks();
  for (const store of openStores) await store.close();
  openStores = [];
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function track(store: GraphologyStorage): GraphologyStorage {
  openStores.push(store);
  return store;
}

function counters(store: GraphologyStorage): Counters {
  const value = (store as unknown as { immutableReadCacheCountersV4: Counters })
    .immutableReadCacheCountersV4;
  return { hits: value.hits, misses: value.misses };
}

function cacheEntry(store: GraphologyStorage): unknown {
  return (store as unknown as { immutableReadCacheV4: unknown }).immutableReadCacheV4;
}

function installSyntheticProvider() {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const user = JSON.parse(body.messages[1]!.content) as { units: Array<{ unitId: string }> };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                version: 1,
                units: user.units.map(({ unitId }) => ({
                  unitId,
                  category: 'preference',
                  risk: 'ordinary',
                  usefulness: 'personal_memory',
                  downgrade: [],
                })),
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

/** Native enrollment + committed claim at the actual producer path; no forged records. */
async function committedEnrolledStore(): Promise<{ file: string; namespace: string }> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-immutable-read-'));
  directories.push(directory);
  const file = join(directory, 'store.json');
  const store = new GraphologyStorage(file);
  await store.initialize();
  const seed = await seedAutonomousPersonalCaptureSubject(store);
  const fetchSpy = installSyntheticProvider();
  const turn = 'immutable-read-turn';
  const prepared = await prepareNativeAutonomousPersonalCompletionV4(
    nativeAutonomousPersonalCaptureContext(seed, {
      executionId: `execution:${turn}`,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content: 'I prefer concise explanations.',
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: 'enabled',
        automaticTurn: turn,
      },
    }),
    store,
  );
  if (prepared.kind !== 'completion_prepared') throw new Error(`Unexpected ${prepared.kind}`);
  try {
    expect(await store.completeAutonomousPersonalCaptureV4!(prepared.handle)).toEqual({
      kind: 'matched',
    });
  } finally {
    closeAutonomousPersonalCompletionV4(store, prepared.handle);
  }
  // The producer's own completion + readback ran through stable reads.
  expect(counters(store).misses + counters(store).hits).toBeGreaterThan(0);
  fetchSpy.mockRestore();
  await store.close();
  return { file, namespace: seed.request.namespace };
}

async function openEnrolled() {
  const fixture = await committedEnrolledStore();
  const store = track(new GraphologyStorage(fixture.file));
  await store.initialize();
  return { ...fixture, store };
}

async function read(store: GraphologyStorage, budget = { remaining: 512, deferred: 0 }) {
  return store.readCompositionalRetrievalSnapshotV3(getAutomaticClaimReadScope(budget));
}

function claimEdge(graph: GraphData) {
  return graph.edges.find((edge) => edge.attributes.engram_claim_v1 !== undefined);
}

/** Same-length, same-mtime byte change that stays valid JSON and schema DATA. */
function rewriteSameSizeAndMtime(file: string): void {
  const stat = fs.statSync(file);
  const text = fs.readFileSync(file, 'utf8');
  const changed = text.replace(
    /("exported_at":\s*")[^"]{24}(")/,
    (_match, open: string, close: string) => `${open}2001-01-01T00:00:00.000Z${close}`,
  );
  expect(changed).not.toBe(text);
  expect(Buffer.byteLength(changed)).toBe(stat.size);
  fs.writeFileSync(file, changed);
  fs.utimesSync(file, stat.atime, stat.mtime);
}

describe('Graphology immutable stable read (V4)', () => {
  it('misses once, then hits on exact bytes without a schema parse, still integrity-checking', async () => {
    const { store, file } = await openEnrolled();
    const before = counters(store);
    const parse = jest.spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph');
    expect((await read(store)).status).toBe('snapshot');
    expect(counters(store)).toEqual({ hits: before.hits, misses: before.misses + 1 });
    const missParses = parse.mock.calls.length;
    parse.mockClear();

    const integrity = jest.spyOn(RecordIntegrity, 'assertAutonomousPersonalRecordIntegrityV4');
    const stat = jest.spyOn(fs.promises, 'stat');
    const open = jest.spyOn(fs.promises, 'open');
    const bytes = fs.readFileSync(file);
    const second = await read(store);
    expect(second.status).toBe('snapshot');
    expect(counters(store)).toEqual({ hits: before.hits + 1, misses: before.misses + 1 });
    // Only the file-level schema parse is skipped; the file is still opened and read,
    // both stability stats run, and record integrity reran on the cached DATA.
    expect(parse.mock.calls.length).toBe(missParses - 1);
    expect(open.mock.calls.some(([path]) => path === file)).toBe(true);
    expect(stat.mock.calls.filter(([path]) => path === file).length).toBeGreaterThanOrEqual(2);
    expect(integrity).toHaveBeenCalled();
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('gives Core a fresh mutable copy and never the cached immutable DATA', async () => {
    const { store, file, namespace } = await openEnrolled();
    const ordinary = await store.addEntity({
      group_id: namespace,
      name: 'Mutable probe',
      entity_type: 'concept',
    });
    await read(store);
    await read(store);
    const live = await store.exportGraph();
    const publicOrdinary = live.entities.find((row) => row.uuid === ordinary.uuid)!;
    expect(Object.isFrozen(publicOrdinary)).toBe(false);
    // Existing actor-binding protection remains intact.
    const bound = live.entities.find(
      (row) => row.attributes.engram_actor_bindings_v1 !== undefined,
    );
    expect(bound).toBeDefined();
    expect(Object.isFrozen(bound)).toBe(true);
    expect(getOwnedImmutableGraphData(live)).toBeUndefined();
    const result = await read(store);
    if (result.status !== 'snapshot') throw new Error(result.status);
    expect(getOwnedImmutableGraphData(result.graph)).toBeUndefined();
    expect(Object.isFrozen(result.graph)).toBe(false);
    // Mutating the public outputs cannot reach the next cached read.
    publicOrdinary.name = 'mutated in caller';
    result.graph.edges.length = 0;
    const again = await read(store);
    if (again.status !== 'snapshot') throw new Error(again.status);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
    expect(again.graph.edges).toEqual(stored.edges);
    expect(again.graph.entities.map((row) => row.name)).toEqual(
      stored.entities.map((row) => row.name),
    );
    // Row/ledger/prototype contract matches the file.
    expect(again.graph.automatic_operations_v1).toEqual(stored.automatic_operations_v1);
    expect(Object.getPrototypeOf(again.graph.entities[0])).toBe(Object.prototype);
  });

  it('fully validates changed bytes even with identical size and mtime', async () => {
    const { store, file } = await openEnrolled();
    await read(store);
    const base = counters(store);
    rewriteSameSizeAndMtime(file);
    const parse = jest
      .spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph')
      .mockImplementation((value) => realParse(value));
    expect((await read(store)).status).toBe('snapshot');
    expect(counters(store)).toEqual({ hits: base.hits, misses: base.misses + 1 });
    expect(parse).toHaveBeenCalled();
  });

  it('rejects a tampered claim after a cached read; no stale DATA or verdict is reused', async () => {
    const { store, file } = await openEnrolled();
    await read(store);
    const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
    claimEdge(graph)!.attributes.engram_claim_v1 = { version: 7, family: 'x' };
    fs.writeFileSync(file, JSON.stringify(graph));
    const result = await read(store);
    expect(result.status).not.toBe('snapshot');
    expect(cacheEntry(store)).toBeUndefined();
  });

  it('invalidates on missing, corrupt and externally replaced files', async () => {
    const { store, file } = await openEnrolled();
    const bytes = fs.readFileSync(file);
    await read(store);

    fs.renameSync(file, `${file}.away`);
    expect((await read(store)).status).not.toBe('snapshot');
    expect(cacheEntry(store)).toBeUndefined();
    fs.renameSync(`${file}.away`, file);
    let base = counters(store);
    expect((await read(store)).status).toBe('snapshot');
    expect(counters(store).misses).toBe(base.misses + 1);

    const corrupt = Buffer.from(bytes);
    corrupt[0] = 0x00;
    fs.writeFileSync(file, corrupt);
    expect((await read(store)).status).not.toBe('snapshot');
    expect(cacheEntry(store)).toBeUndefined();

    // Replacement with the original bytes (new inode) is a miss after the failure.
    fs.writeFileSync(`${file}.next`, bytes);
    fs.renameSync(`${file}.next`, file);
    base = counters(store);
    expect((await read(store)).status).toBe('snapshot');
    expect(counters(store).misses).toBe(base.misses + 1);
  });

  it('starts empty after restart and keeps the cache per instance', async () => {
    const { store, file } = await openEnrolled();
    await read(store);
    await store.close();
    const restarted = track(new GraphologyStorage(file));
    await restarted.initialize();
    expect(cacheEntry(restarted)).toBeUndefined();
    const base = counters(restarted);
    await read(restarted);
    expect(counters(restarted).misses).toBe(base.misses + 1);
  });

  it('charges the same snapshot budget on a hit as on a miss', async () => {
    const { store } = await openEnrolled();
    const missBudget = { remaining: 512, deferred: 0 };
    await read(store, missBudget);
    const hitBudget = { remaining: 512, deferred: 0 };
    const base = counters(store);
    await read(store, hitBudget);
    expect(counters(store).hits).toBe(base.hits + 1);
    expect(hitBudget.remaining).toBe(missBudget.remaining);

    const exhausted = await read(store, { remaining: 0, deferred: 0 }).catch(() => ({
      status: 'rejected' as const,
    }));
    expect(exhausted.status).not.toBe('snapshot');
  });

  it('clears on a successful write and on writer failures; never promotes', async () => {
    const { store, namespace } = await openEnrolled();
    await read(store);
    await store.addEntity({ group_id: namespace, name: 'Appended', entity_type: 'concept' });
    expect(cacheEntry(store)).toBeUndefined();
    let base = counters(store);
    await read(store);
    expect(counters(store).misses).toBe(base.misses + 1);

    jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('synthetic_rename'));
    await expect(
      store.addEntity({ group_id: namespace, name: 'Lost', entity_type: 'concept' }),
    ).rejects.toThrow('synthetic_rename');
    expect(cacheEntry(store)).toBeUndefined();

    await read(store);
    jest.spyOn(proto, 'writeTextAtomic').mockImplementationOnce(async function (
      this: unknown,
      ...args
    ) {
      await realWriteTextAtomic.apply(this, args as Parameters<WriteTextAtomic>);
      throw new Error('synthetic_fsync_after_rename');
    });
    await expect(
      store.addEntity({ group_id: namespace, name: 'Unsynced', entity_type: 'concept' }),
    ).rejects.toThrow('synthetic_fsync_after_rename');
    expect(cacheEntry(store)).toBeUndefined();
    base = counters(store);
    expect((await read(store)).status).toBe('snapshot');
    expect(counters(store).misses).toBe(base.misses + 1);
  });

  it('leaves default mutable parsing and non-stable reads unchanged', async () => {
    const { store, file, namespace } = await openEnrolled();
    const parsed = realParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(Object.isFrozen(parsed)).toBe(false);
    expect(getOwnedImmutableGraphData(parsed)).toBeUndefined();
    const checked = RecordIntegrity.parseIntegrityCheckedAutonomousPersonalGraphV4;
    expect(checked).toBeDefined();
    // An ordinary (non-stable) mutation refresh neither reads nor installs the cache.
    await store.addEntity({ group_id: namespace, name: 'Plain', entity_type: 'concept' });
    expect(cacheEntry(store)).toBeUndefined();
    expect(counters(store)).toEqual({ hits: 0, misses: 0 });
    expect(await store.getMigrationStatus()).toMatchObject({ migration_required: false });
  });
});
