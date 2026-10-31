import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as LosslessGraph from '../../src/storage/LosslessAutomaticCaptureGraph';
import * as RecordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { getOwnedImmutableGraphData } from '../../src/storage/ImmutableGraphSnapshot';
import {
  closeAutonomousPersonalCompletionV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { getAutomaticClaimReadScope } from '../../src/storage/AutomaticClaimReadScope';
import type { GraphData } from '../../src/schemas';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

/**
 * readOwnedSnapshotV4 hands its read-only callbacks registered immutable DATA for a
 * current enrolled file, so nested lookups skip their reparse. Every read still opens
 * and reads the whole file under the lock and reruns integrity; Core keeps old data.
 */
type Counters = { hits: number; misses: number };
type ReadOwned = (
  read: (graph: GraphData) => unknown,
  options: { operation: string },
) => Promise<unknown>;
const proto = GraphologyStorage.prototype as unknown as { readOwnedSnapshotV4: ReadOwned };
const realReadOwned = proto.readOwnedSnapshotV4;

let directories: string[] = [];
let openStores: GraphologyStorage[] = [];

afterEach(async () => {
  jest.restoreAllMocks();
  for (const store of openStores) await store.close();
  openStores = [];
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function counters(store: GraphologyStorage): Counters {
  const value = (store as unknown as { immutableReadCacheCountersV4: Counters })
    .immutableReadCacheCountersV4;
  return { hits: value.hits, misses: value.misses };
}

function cacheEntry(store: GraphologyStorage): unknown {
  return (store as unknown as { immutableReadCacheV4: unknown }).immutableReadCacheV4;
}

function readOwned<T>(store: GraphologyStorage, read: (graph: GraphData) => T): Promise<T> {
  return realReadOwned.call(store, read, { operation: 'plan037_test_read' }) as Promise<T>;
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

type Seed = Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;

/** One native turn at the actual producer path; no forged records. */
async function nativeTurn(store: GraphologyStorage, seed: Seed, turn: string, content: string) {
  const prepared = await prepareNativeAutonomousPersonalCompletionV4(
    nativeAutonomousPersonalCaptureContext(seed, {
      executionId: `execution:${turn}`,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content,
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
    return await store.completeAutonomousPersonalCaptureV4!(prepared.handle);
  } finally {
    closeAutonomousPersonalCompletionV4(store, prepared.handle);
  }
}

async function enrolledStore() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-plan037-'));
  directories.push(directory);
  const file = join(directory, 'store.json');
  const store = new GraphologyStorage(file);
  openStores.push(store);
  await store.initialize();
  const seed = await seedAutonomousPersonalCaptureSubject(store);
  installSyntheticProvider();
  expect(await nativeTurn(store, seed, 'plan037-first', 'I prefer concise explanations.')).toEqual({
    kind: 'matched',
  });
  return { store, file, seed };
}

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

describe('plan037 owned read DATA', () => {
  it('gives real native begin/provider/readback callbacks registered DATA with no reparse', async () => {
    const { store, seed } = await enrolledStore();
    const parse = jest.spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph');
    const observed: Array<{ operation: string; owned: boolean; parses: number }> = [];
    jest.spyOn(proto, 'readOwnedSnapshotV4').mockImplementation(function (
      this: unknown,
      read,
      options,
    ) {
      return realReadOwned.call(
        this,
        (graph) => {
          const before = parse.mock.calls.length;
          const result = read(graph);
          observed.push({
            operation: options.operation,
            owned: getOwnedImmutableGraphData(graph) === graph,
            parses: parse.mock.calls.length - before,
          });
          return result;
        },
        options,
      );
    });

    expect(await nativeTurn(store, seed, 'plan037-second', 'I prefer tea over coffee.')).toEqual({
      kind: 'matched',
    });

    expect(observed.length).toBeGreaterThanOrEqual(3);
    expect(observed.every((entry) => entry.owned)).toBe(true);
    const preflight = observed.find(
      (entry) => entry.operation === 'autonomous_personal_preflight_v4',
    );
    expect(preflight).toEqual(expect.objectContaining({ owned: true, parses: 0 }));
    // Native begin readback and provider preflight must really execute; no conditional pass.
    for (const operation of [
      'autonomous_personal_readback_v4',
      'autonomous_personal_provider_preflight_v4',
    ]) {
      expect(observed.find((entry) => entry.operation === operation)).toEqual(
        expect.objectContaining({ owned: true }),
      );
    }
  });

  it('hits on exact bytes, reruns integrity, and keeps Core data mutable and unaliased', async () => {
    const { store, file, seed } = await enrolledStore();
    const ordinary = await store.addEntity({
      group_id: seed.request.namespace,
      name: 'Mutable probe',
      entity_type: 'concept',
      attributes: { nested: { value: -0 } },
    });
    await readOwned(store, () => undefined);
    const base = counters(store);
    const parse = jest.spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph');
    const integrity = jest.spyOn(RecordIntegrity, 'assertAutonomousPersonalRecordIntegrityV4');
    const open = jest.spyOn(fs.promises, 'open');
    const seen = await readOwned(store, (graph) => graph);
    expect(counters(store)).toEqual({ hits: base.hits + 1, misses: base.misses });
    expect(parse).not.toHaveBeenCalled();
    expect(integrity).toHaveBeenCalled();
    expect(open.mock.calls.some(([path]) => path === file)).toBe(true);
    expect(getOwnedImmutableGraphData(seen)).toBe(seen);

    const live = await store.exportGraph();
    expect(getOwnedImmutableGraphData(live)).toBeUndefined();
    const mutable = live.entities.find((row) => row.uuid === ordinary.uuid)!;
    expect(Object.isFrozen(mutable)).toBe(false);
    const protectedActor = live.entities.find(
      (row) => row.attributes.engram_actor_bindings_v1 !== undefined,
    );
    expect(protectedActor).toBeDefined();
    expect(Object.isFrozen(protectedActor)).toBe(true);
    expect(live.entities.some((row) => seen.entities.includes(row))).toBe(false);
    expect(Object.getPrototypeOf(live.entities[0])).toBe(Object.prototype);
  });

  it('fully validates changed bytes with identical size and mtime', async () => {
    const { store, file } = await enrolledStore();
    await readOwned(store, () => undefined);
    rewriteSameSizeAndMtime(file);
    const base = counters(store);
    const parse = jest.spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph');
    await readOwned(store, () => undefined);
    expect(counters(store).misses).toBe(base.misses + 1);
    expect(parse).toHaveBeenCalled();
  });

  it('rejects a tampered claim and invalidates; no stale DATA or verdict', async () => {
    const { store, file } = await enrolledStore();
    await readOwned(store, () => undefined);
    const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
    const edge = graph.edges.find((row) => row.attributes.engram_claim_v1 !== undefined)!;
    edge.attributes.engram_claim_v1 = { version: 7, family: 'x' };
    fs.writeFileSync(file, JSON.stringify(graph));
    await expect(readOwned(store, () => undefined)).rejects.toThrow();
    expect(cacheEntry(store)).toBeUndefined();
  });

  it('invalidates on missing, corrupt and replaced files without empty fallback', async () => {
    const { store, file } = await enrolledStore();
    const bytes = fs.readFileSync(file);
    await readOwned(store, () => undefined);

    fs.renameSync(file, `${file}.away`);
    await expect(readOwned(store, () => undefined)).rejects.toThrow();
    expect(cacheEntry(store)).toBeUndefined();
    fs.renameSync(`${file}.away`, file);

    const corrupt = Buffer.from(bytes);
    corrupt[0] = 0x00;
    fs.writeFileSync(file, corrupt);
    await expect(readOwned(store, () => undefined)).rejects.toThrow();
    expect(cacheEntry(store)).toBeUndefined();

    fs.writeFileSync(`${file}.next`, bytes);
    fs.renameSync(`${file}.next`, file);
    const base = counters(store);
    const entities = await readOwned(store, (graph) => graph.entities.length);
    expect(entities).toBeGreaterThan(0);
    expect(counters(store).misses).toBe(base.misses + 1);
  });

  it('propagates a callback failure and still releases the read', async () => {
    const { store } = await enrolledStore();
    await expect(
      readOwned(store, () => {
        throw new Error('synthetic_cancel');
      }),
    ).rejects.toThrow('synthetic_cancel');
    expect(await readOwned(store, (graph) => graph.entities.length)).toBeGreaterThan(0);
  });

  it('never admits an owned group-scoped cache entry into a full retrieval snapshot', async () => {
    const { store, file, seed } = await enrolledStore();
    const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
    graph.group_id = seed.request.namespace;
    fs.writeFileSync(file, JSON.stringify(graph));
    await readOwned(store, () => undefined);
    expect(cacheEntry(store)).toBeDefined();
    const before = counters(store);
    const result = await store.readCompositionalRetrievalSnapshotV3(
      getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
    );
    expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_snapshot' });
    expect(counters(store).hits).toBe(before.hits);
    expect(cacheEntry(store)).toBeUndefined();
  });

  it('keeps the old copy path for an unenrolled store', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'engram-plan037-plain-'));
    directories.push(directory);
    const store = new GraphologyStorage(join(directory, 'store.json'));
    openStores.push(store);
    await store.initialize();
    await store.addEntity({ group_id: 'plain', name: 'Plain', entity_type: 'concept' });
    const seen = await readOwned(store, (graph) => graph);
    expect(getOwnedImmutableGraphData(seen)).toBeUndefined();
    expect(Object.isFrozen(seen)).toBe(true);
    expect(counters(store)).toEqual({ hits: 0, misses: 0 });
    expect(cacheEntry(store)).toBeUndefined();
  });
});
