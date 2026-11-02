import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as RecordIntegrity from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import type { GraphData } from '../../../src/schemas';
import {
  autonomousPersonalQualifiedClaimFixtureV4,
  type AutonomousPersonalQualifiedClaimFixtureV4,
} from '../../helpers/autonomousPersonalQualifiedClaimV4';
import { createAutonomousPersonalPersistedExistingStoreFixture } from '../../helpers/autonomousPersonalExistingStoreFixture';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import {
  AutonomousPersonalExecutionScopeBudgetError,
  bindAutonomousPersonalExecutionScopeV1,
  currentAutonomousPersonalExecutionScopeWorkV1,
  openAutonomousPersonalExecutionScopeV1,
  runAutonomousPersonalExecutionScopeV1,
} from '../../../src/storage/AutonomousPersonalExecutionScopeV1';

/**
 * Synthetic data only. An ordinary public episode append (addEpisode/appendEpisode/
 * appendEpisodes) on an enrolled embedded store roots its rollback in the private, ledger-
 * and record-verified parse the same call's refresh already produced, instead of exporting
 * live Core aliases and verifying them a second time. addEntity, addEdge, updates and every
 * other write path keep the export-based path; the tests that use them are characterization
 * of that old path, not coverage of the candidate. Post-mutation validation and the
 * native-footprint check are unchanged, and the candidate's footprint coverage injects the
 * footprint inside appendEpisodeInternal.
 *
 * Rollback contract: the restored state is semantically equal (rows, ledger, identity), not
 * byte-identical, once a snapshot has replaced the file, because the rewrite is compacted or
 * re-serialized. Only a failure before any replacement is asserted byte-exact.
 *
 * Budget contract: the 5 s ordinary guard covers refresh I/O, mutation, post-validation and
 * elapsed wall time at integrity checkpoints once armed (not a complete snapshot-I/O timeout); only mutation-queue and file-lock wait are excluded, and
 * only for the ordinary unscoped shape.
 */

jest.setTimeout(60_000);

const ORDINARY_GROUP = 'engram084-ordinary-writer';

const FIXTURES = [
  {
    label: 'typed_preference',
    claimName: 'PREFERS',
    options: {
      content:
        'For summaries, I usually prefer answers in plain Canadian French with one practical example before any technical definitions.',
    },
  },
  {
    label: 'source_statement_record',
    claimName: 'STATED',
    options: { content: 'I work as a ceramicist.', prefix: 'Speaker 🧭: ' },
  },
] as const;

interface Harness {
  fixture: AutonomousPersonalQualifiedClaimFixtureV4;
  file: string;
  storage: GraphologyStorage;
}

type Internals = {
  graph: {
    getNodeAttributes(key: string): { data: Record<string, unknown> };
    getEdgeAttributes(key: string): { data: Record<string, unknown> };
    dropNode(key: string): void;
    addNode(key: string, attributes: { type: 'entity'; data: unknown }): void;
    addEdgeWithKey(
      key: string,
      source: string,
      target: string,
      attributes: { type: 'entity_edge'; data: unknown },
    ): void;
  };
  mutationTail: Promise<void>;
  recoveryRequired: boolean;
  appendEpisodeInternal(...args: unknown[]): unknown;
  runMutation(mutation: () => unknown, options?: Record<string, unknown>): Promise<unknown>;
  writeTextAtomic(...args: unknown[]): Promise<void>;
  refreshFromDiskUnderLock(...args: unknown[]): Promise<unknown>;
  readAndMigratePersistedDataUnderLock(...args: unknown[]): Promise<{
    data: GraphData;
    verifiedPrivate?: GraphData;
  }>;
  writeSnapshotUnderLock(...args: unknown[]): Promise<number>;
  acquirePersistLock(...args: unknown[]): Promise<() => Promise<void>>;
};

const internals = (storage: GraphologyStorage): Internals => storage as unknown as Internals;

let directories: string[] = [];
let openStores: GraphologyStorage[] = [];
let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  jest.restoreAllMocks();
  for (const store of openStores) await store.close();
  openStores = [];
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  directories = [];
});

async function enrolledHarness(options: (typeof FIXTURES)[number]['options']): Promise<Harness> {
  const fixture = await autonomousPersonalQualifiedClaimFixtureV4(options);
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram084-'));
  directories.push(directory);
  const file = join(directory, 'store.json');
  fs.writeFileSync(file, JSON.stringify(fixture.graph, null, 2));
  const storage = new GraphologyStorage(file);
  openStores.push(storage);
  await storage.initialize();
  return { fixture, file, storage };
}

function readGraph(file: string): GraphData {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
}

function byUuid<T extends { uuid: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.uuid.localeCompare(right.uuid));
}

/** Every original row, the ledger and the root identity survive unchanged. */
function expectOriginalPreserved(actual: GraphData, original: GraphData): void {
  expect(byUuid(actual.entities)).toEqual(byUuid(original.entities));
  expect(byUuid(actual.edges)).toEqual(byUuid(original.edges));
  expect(actual.automatic_operations_v1).toEqual(original.automatic_operations_v1);
  expect(actual.metadata).toEqual(original.metadata);
  expect(actual.version).toBe(original.version);
  for (const episode of original.episodes) {
    expect(actual.episodes.find((row) => row.uuid === episode.uuid)).toEqual(episode);
  }
}

function ordinaryEpisode(content: string, extra: Record<string, unknown> = {}) {
  return {
    group_id: ORDINARY_GROUP,
    content,
    role: 'human' as const,
    reference_time: '2026-05-01T10:00:00.000Z',
    ...extra,
  };
}

function integritySpies() {
  return {
    assert: jest.spyOn(RecordIntegrity, 'assertAutonomousPersonalRecordIntegrityV4'),
    parse: jest.spyOn(RecordIntegrity, 'parseIntegrityCheckedAutonomousPersonalGraphV4'),
    validateOwned: jest.spyOn(RecordIntegrity, 'validateOwnedAutonomousPersonalRecordGraphV4'),
  };
}

/** Records what each disk read returned, calling through to the real implementation. */
function observeReads(storage: GraphologyStorage) {
  const reads: Array<{ data: GraphData; verifiedPrivate?: GraphData }> = [];
  const target = internals(storage);
  const original = target.readAndMigratePersistedDataUnderLock.bind(storage);
  jest
    .spyOn(target, 'readAndMigratePersistedDataUnderLock')
    .mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      reads.push(result);
      return result;
    });
  return reads;
}

/** One fake monotonic clock: every performance.now() reader sees real time plus the offset. */
function fakeClock() {
  const realNow = performance.now.bind(performance);
  let offset = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
  return {
    advance(ms: number) {
      offset += ms;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The typed ordinary-guard deadline, not any other failure. */
const TYPED_DEADLINE = { name: 'AutonomousPersonalTypedSyntaxFailureV1', reason: 'deadline' };

/** Records every refresh call's guard context and ordinary-unowned flag. */
function observeRefreshes(storage: GraphologyStorage) {
  const calls: Array<{
    captureRecords: unknown;
    requireExistingSnapshot: unknown;
    captureRead: unknown;
    guard: { typedSyntaxWork: unknown; check: () => void };
    ordinaryUnowned: unknown;
  }> = [];
  const target = internals(storage);
  const original = target.refreshFromDiskUnderLock.bind(storage);
  jest.spyOn(target, 'refreshFromDiskUnderLock').mockImplementation(async (...args: unknown[]) => {
    calls.push({
      captureRecords: args[0],
      requireExistingSnapshot: args[1],
      captureRead: args[2],
      guard: args[3] as { typedSyntaxWork: unknown; check: () => void },
      ordinaryUnowned: args[4],
    });
    return original(...args);
  });
  return calls;
}

/** Makes the append's mutation add a footprint to live Core after the real append ran. */
function injectDuringAppend(storage: GraphologyStorage, inject: () => void) {
  const target = internals(storage);
  const original = target.appendEpisodeInternal.bind(storage);
  return jest.spyOn(target, 'appendEpisodeInternal').mockImplementation((...args: unknown[]) => {
    const result = original(...args);
    inject();
    return result;
  });
}

describe.each(FIXTURES)('ordinary append on an enrolled store ($label)', (variant) => {
  it('keeps both claim kinds covered by the synthetic fixture', async () => {
    const { fixture } = await enrolledHarness(variant.options);
    expect(fixture.edge.name).toBe(variant.claimName);
  });

  it('preserves every original row, ledger and identity, and drops the pre-mutation re-verification', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const spies = integritySpies();
    const reads = observeReads(storage);

    const created = await storage.addEpisode(ordinaryEpisode('ordinary note one'));
    const second = await storage.appendEpisode(ordinaryEpisode('ordinary note two'));

    expect(second.created).toBe(true);
    const onDisk = readGraph(file);
    expectOriginalPreserved(onDisk, fixture.graph);
    expect(onDisk.episodes.map((row) => row.uuid)).toEqual(
      expect.arrayContaining([created.uuid, second.episode.uuid]),
    );
    expect(onDisk.episodes).toHaveLength(fixture.graph.episodes.length + 2);

    // The pre-mutation assertion on the exported pre-state is gone; the refresh's checked
    // parse and the full post-mutation validation both still ran for every append.
    expect(spies.assert).not.toHaveBeenCalled();
    expect(spies.parse.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(spies.validateOwned.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The private root is detached from what Core received.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) {
      expect(read.verifiedPrivate).toBeDefined();
      expect(read.verifiedPrivate).not.toBe(read.data);
      expect(read.verifiedPrivate!.entities[0]).not.toBe(read.data.entities[0]);
      expect(read.verifiedPrivate!.edges[0]).not.toBe(read.data.edges[0]);
    }

    // The written file reloads under full cold validation.
    const reopened = new GraphologyStorage(file);
    openStores.push(reopened);
    await reopened.initialize();
    expectOriginalPreserved(await reopened.exportGraph(), fixture.graph);
  });

  it('keeps the old path for every other mutation', async () => {
    const { file, storage } = await enrolledHarness(variant.options);
    const entity = await storage.addEntity({ group_id: ORDINARY_GROUP, name: 'ordinary entity' });
    const spies = integritySpies();
    const reads = observeReads(storage);

    await storage.updateEntity(entity.uuid, { summary: 'changed' });

    expect(spies.assert).toHaveBeenCalled();
    expect(reads.every((read) => read.verifiedPrivate === undefined)).toBe(true);
    expect(readGraph(file).entities.find((row) => row.uuid === entity.uuid)?.summary).toBe(
      'changed',
    );
  });

  it.each<[string, (storage: GraphologyStorage, fixture: Harness['fixture']) => void]>([
    [
      'value entity',
      (storage, fixture) => {
        internals(storage).graph.addNode('engram084-injected-value', {
          type: 'entity',
          data: { ...fixture.value, uuid: 'engram084-injected-value', name: 'injected value' },
        });
      },
    ],
    [
      'claim edge',
      (storage, fixture) => {
        internals(storage).graph.addEdgeWithKey(
          'engram084-injected-edge',
          fixture.subject.uuid,
          fixture.value.uuid,
          {
            type: 'entity_edge',
            data: { ...fixture.edge, uuid: 'engram084-injected-edge', fact: 'injected claim' },
          },
        );
      },
    ],
  ])(
    'refuses a footprint created inside the append callback (%s): native_write_required, bytes unchanged, Core restored',
    async (_label, inject) => {
      const { fixture, file, storage } = await enrolledHarness(variant.options);
      const before = fs.readFileSync(file);
      const reads = observeReads(storage);
      const write = jest.spyOn(internals(storage), 'writeSnapshotUnderLock');
      const injected = injectDuringAppend(storage, () => inject(storage, fixture));

      await expect(storage.addEpisode(ordinaryEpisode('must not land'))).rejects.toThrow(
        /native_write_required/,
      );

      // The candidate path ran: the rollback root was the verified parse.
      expect(injected).toHaveBeenCalledTimes(1);
      expect(reads[reads.length - 1]?.verifiedPrivate).toBeDefined();
      expect(write).not.toHaveBeenCalled();
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      jest.restoreAllMocks();
      const restored = await storage.exportGraph();
      expectOriginalPreserved(restored, fixture.graph);
      expect(restored.episodes.some((row) => row.content === 'must not land')).toBe(false);
      expect(restored.entities.some((row) => row.uuid.startsWith('engram084-injected'))).toBe(
        false,
      );
      expect(restored.edges.some((row) => row.uuid.startsWith('engram084-injected'))).toBe(false);
      const recovered = await storage.addEpisode(ordinaryEpisode('lands after refusal'));
      expect(readGraph(file).episodes.some((row) => row.uuid === recovered.uuid)).toBe(true);
    },
  );

  // Characterization of the export-based path (addEntity/addEdge), not candidate coverage.
  it('refuses ordinary addEdge/addEntity footprints on the old path, leaving bytes unchanged', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const before = fs.readFileSync(file);

    await expect(
      storage.addEdge({
        group_id: fixture.edge.group_id,
        source_node_uuid: fixture.subject.uuid,
        target_node_uuid: fixture.value.uuid,
        name: fixture.edge.name,
        fact: 'ordinary writer claim',
        attributes: { engram_claim_v1: fixture.edge.attributes.engram_claim_v1 },
      }),
    ).rejects.toThrow(/native_write_required/);
    await expect(
      storage.addEntity({
        group_id: fixture.value.group_id,
        name: 'ordinary writer value',
        entity_type: 'autonomous_personal_value',
      }),
    ).rejects.toThrow(/native_write_required/);

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expectOriginalPreserved(await storage.exportGraph(), fixture.graph);
  });

  it('fails closed on a tampered file before any mutation and leaves it untouched', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const tampered = JSON.parse(JSON.stringify(fixture.graph)) as GraphData;
    tampered.episodes.find((row) => row.uuid === fixture.source.uuid)!.content += ' tampered';
    fs.writeFileSync(file, JSON.stringify(tampered, null, 2));
    const before = fs.readFileSync(file);
    const mutation = jest.spyOn(
      storage as unknown as { appendEpisodeInternal(...args: unknown[]): unknown },
      'appendEpisodeInternal',
    );

    await expect(storage.addEpisode(ordinaryEpisode('must not land'))).rejects.toThrow();

    expect(mutation).not.toHaveBeenCalled();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it.each<[string, (storage: GraphologyStorage, fixture: Harness['fixture']) => void]>([
    [
      'rewritten claim literal',
      (storage: GraphologyStorage, fixture: Harness['fixture']) => {
        internals(storage).graph.getNodeAttributes(fixture.value.uuid).data.name =
          'tampered literal';
        internals(storage).graph.getEdgeAttributes(fixture.edge.uuid).data.fact =
          'tampered literal';
      },
    ],
    [
      'dropped committed claim',
      (storage: GraphologyStorage, fixture: Harness['fixture']) => {
        internals(storage).graph.dropNode(fixture.value.uuid);
      },
    ],
  ])(
    'fails closed when live Core rows are tampered after the refresh (%s) and restores the verified state',
    async (_label, tamper) => {
      const { fixture, file, storage } = await enrolledHarness(variant.options);
      const before = fs.readFileSync(file);
      const target = internals(storage);
      const original = target.refreshFromDiskUnderLock.bind(storage);
      jest
        .spyOn(target, 'refreshFromDiskUnderLock')
        .mockImplementation(async (...args: unknown[]) => {
          const result = await original(...args);
          tamper(storage, fixture);
          return result;
        });

      await expect(storage.addEpisode(ordinaryEpisode('must not land'))).rejects.toThrow();

      expect(fs.readFileSync(file).equals(before)).toBe(true);
      jest.restoreAllMocks();
      // Rollback restores the detached verified parse, not the tampered live rows.
      const restored = await storage.exportGraph();
      expectOriginalPreserved(restored, fixture.graph);
      expect(restored.episodes.some((row) => row.content === 'must not land')).toBe(false);
      const recovered = await storage.addEpisode(ordinaryEpisode('lands after recovery'));
      expect(readGraph(file).episodes.some((row) => row.uuid === recovered.uuid)).toBe(true);
    },
  );

  it('rolls memory and file back to the verified pre-state when the snapshot write fails', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const before = fs.readFileSync(file);
    jest
      .spyOn(internals(storage), 'writeSnapshotUnderLock')
      .mockRejectedValueOnce(new Error('synthetic write failure'));

    await expect(storage.addEpisode(ordinaryEpisode('must not land'))).rejects.toThrow(
      'synthetic write failure',
    );

    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expectOriginalPreserved(await storage.exportGraph(), fixture.graph);
  });

  it('rewrites the verified pre-state when the failure happens after the snapshot replaced the file', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const target = internals(storage);
    const original = target.writeSnapshotUnderLock.bind(storage);
    jest
      .spyOn(target, 'writeSnapshotUnderLock')
      .mockImplementationOnce(async (...args: unknown[]) => {
        await original(...args);
        throw new Error('synthetic post-rename failure');
      });

    await expect(storage.addEpisode(ordinaryEpisode('must not land'))).rejects.toThrow(
      'synthetic post-rename failure',
    );

    const onDisk = readGraph(file);
    expectOriginalPreserved(onDisk, fixture.graph);
    expect(onDisk.episodes.some((row) => row.content === 'must not land')).toBe(false);
    const reopened = new GraphologyStorage(file);
    openStores.push(reopened);
    await reopened.initialize();
    expectOriginalPreserved(await reopened.exportGraph(), fixture.graph);
    expectOriginalPreserved(await storage.exportGraph(), fixture.graph);
  });

  it('keeps replay idempotent and writes nothing for an exact replay', async () => {
    const { file, storage } = await enrolledHarness(variant.options);
    const input = ordinaryEpisode('replayed note', { idempotency_key: 'engram084-replay' });
    const first = await storage.appendEpisode(input);
    const afterFirst = fs.readFileSync(file);

    const replay = await storage.appendEpisode(input);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.episode.uuid).toBe(first.episode.uuid);
    expect(fs.readFileSync(file).equals(afterFirst)).toBe(true);
  });

  it('adopts an externally replaced file instead of resurrecting stale memory', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const landed = await storage.addEpisode(ordinaryEpisode('before external replacement'));
    expect(readGraph(file).episodes.some((row) => row.uuid === landed.uuid)).toBe(true);

    fs.writeFileSync(file, JSON.stringify(fixture.graph, null, 2));
    const next = await storage.addEpisode(ordinaryEpisode('after external replacement'));

    const onDisk = readGraph(file);
    expectOriginalPreserved(onDisk, fixture.graph);
    expect(onDisk.episodes.some((row) => row.uuid === landed.uuid)).toBe(false);
    expect(onDisk.episodes.some((row) => row.uuid === next.uuid)).toBe(true);
  });

  it('counts only processing, not lock wait, against the ordinary budget, and still enforces it', async () => {
    const { file, storage } = await enrolledHarness(variant.options);
    const realNow = performance.now.bind(performance);
    let offset = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
    const target = internals(storage);
    const acquire = target.acquirePersistLock.bind(storage);
    jest.spyOn(target, 'acquirePersistLock').mockImplementation(async (...args: unknown[]) => {
      const release = await acquire(...args);
      offset += 6_000;
      return release;
    });

    const landed = await storage.addEpisode(ordinaryEpisode('slow lock'));
    expect(readGraph(file).episodes.some((row) => row.uuid === landed.uuid)).toBe(true);

    jest.restoreAllMocks();
    offset = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
    const read = target.readAndMigratePersistedDataUnderLock.bind(storage);
    jest
      .spyOn(target, 'readAndMigratePersistedDataUnderLock')
      .mockImplementation(async (...args: unknown[]) => {
        offset += 6_000;
        return read(...args);
      });
    const before = fs.readFileSync(file);

    const mutation = jest.spyOn(internals(storage), 'appendEpisodeInternal');

    await expect(storage.addEpisode(ordinaryEpisode('slow processing'))).rejects.toMatchObject(
      TYPED_DEADLINE,
    );

    expect(mutation).not.toHaveBeenCalled();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('does not charge mutation-queue wait against the ordinary budget', async () => {
    const { file, storage } = await enrolledHarness(variant.options);
    const clock = fakeClock();
    let release!: () => void;
    internals(storage).mutationTail = new Promise<void>((resolve) => (release = resolve));

    const pending = storage.addEpisode(ordinaryEpisode('queued behind a slow writer'));
    await tick();
    clock.advance(6_000);
    release();

    const landed = await pending;
    expect(readGraph(file).episodes.some((row) => row.uuid === landed.uuid)).toBe(true);
  });

  it('still enforces the budget on processing after the queue and lock waits, before mutation', async () => {
    const { file, storage } = await enrolledHarness(variant.options);
    const clock = fakeClock();
    let release!: () => void;
    internals(storage).mutationTail = new Promise<void>((resolve) => (release = resolve));
    const target = internals(storage);
    const read = target.readAndMigratePersistedDataUnderLock.bind(storage);
    jest
      .spyOn(target, 'readAndMigratePersistedDataUnderLock')
      .mockImplementation(async (...args: unknown[]) => {
        clock.advance(6_000);
        return read(...args);
      });
    const mutation = jest.spyOn(target, 'appendEpisodeInternal');
    const before = fs.readFileSync(file);

    const pending = storage.addEpisode(ordinaryEpisode('slow after queue'));
    const outcome = expect(pending).rejects.toMatchObject(TYPED_DEADLINE);
    await tick();
    clock.advance(6_000); // queue wait: excluded
    release();

    await outcome;
    expect(mutation).not.toHaveBeenCalled();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('enforces the budget on wall time spent after the mutation and rolls back before any write', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const clock = fakeClock();
    const write = jest.spyOn(internals(storage), 'writeSnapshotUnderLock');
    const target = internals(storage);
    const original = target.appendEpisodeInternal.bind(storage);
    jest.spyOn(target, 'appendEpisodeInternal').mockImplementation((...args: unknown[]) => {
      const result = original(...args);
      clock.advance(6_000);
      return result;
    });
    const before = fs.readFileSync(file);

    await expect(storage.addEpisode(ordinaryEpisode('slow mutation'))).rejects.toMatchObject(
      TYPED_DEADLINE,
    );

    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    jest.restoreAllMocks();
    const restored = await storage.exportGraph();
    expectOriginalPreserved(restored, fixture.graph);
    expect(restored.episodes.some((row) => row.content === 'slow mutation')).toBe(false);
  });

  it('refuses a queued append with recovery_required after a rollback rewrite itself fails', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const target = internals(storage);
    const snapshot = target.writeSnapshotUnderLock.bind(storage);
    jest
      .spyOn(target, 'writeSnapshotUnderLock')
      .mockImplementationOnce(async (...args: unknown[]) => {
        await snapshot(...args);
        // Only the rollback rewrite fails: the snapshot already replaced the file.
        jest.spyOn(target, 'writeTextAtomic').mockRejectedValueOnce(new Error('rollback io'));
        throw new Error('synthetic post-rename failure');
      });

    await expect(storage.addEpisode(ordinaryEpisode('first fails'))).rejects.toThrow(
      'synthetic post-rename failure',
    );

    expect(target.recoveryRequired).toBe(true);
    const afterFailure = fs.readFileSync(file);
    await expect(storage.addEpisode(ordinaryEpisode('refused'))).rejects.toThrow(
      /recovery_required/,
    );
    expect(fs.readFileSync(file).equals(afterFailure)).toBe(true);
    expectOriginalPreserved(readGraph(file), fixture.graph);
  });

  it('refuses the second of two concurrent appends when the first fails its rollback write, losing no source or claim', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const target = internals(storage);
    const snapshot = target.writeSnapshotUnderLock.bind(storage);
    jest
      .spyOn(target, 'writeSnapshotUnderLock')
      .mockImplementationOnce(async (...args: unknown[]) => {
        await snapshot(...args);
        jest.spyOn(target, 'writeTextAtomic').mockRejectedValueOnce(new Error('rollback io'));
        throw new Error('synthetic post-rename failure');
      });

    const [first, second] = await Promise.allSettled([
      storage.addEpisode(ordinaryEpisode('first fails')),
      storage.addEpisode(ordinaryEpisode('second must not land')),
    ]);

    expect(first.status).toBe('rejected');
    expect((first as PromiseRejectedResult).reason).toEqual(
      expect.objectContaining({ message: 'synthetic post-rename failure' }),
    );
    expect(second.status).toBe('rejected');
    expect(String((second as PromiseRejectedResult).reason)).toMatch(/recovery_required/);
    const onDisk = readGraph(file);
    expectOriginalPreserved(onDisk, fixture.graph);
    expect(onDisk.episodes.some((row) => row.content === 'second must not land')).toBe(false);
    expect(onDisk.episodes.some((row) => row.uuid === fixture.source.uuid)).toBe(true);
    expect(onDisk.entities.some((row) => row.uuid === fixture.value.uuid)).toBe(true);
    expect(onDisk.edges.some((row) => row.uuid === fixture.edge.uuid)).toBe(true);
  });

  it('appends into the owned namespace and with an explicit owned previous episode without losing provenance', async () => {
    for (const mode of ['automatic_chain', 'explicit_previous'] as const) {
      const { fixture, file, storage } = await enrolledHarness(variant.options);
      const before = fs.readFileSync(file);
      const input = {
        group_id: fixture.source.group_id,
        content: `ordinary note into owned namespace (${mode})`,
        role: 'human' as const,
        reference_time: '2026-05-01T10:00:00.000Z',
        ...(mode === 'explicit_previous' ? { previous_episode_uuid: fixture.source.uuid } : {}),
      };

      // Baseline 0.8.3 accepts both forms. The original sources, claims, ledger and
      // provenance must survive, and the file must stay loadable.
      let outcome: 'accepted' | 'rejected';
      let landedUuid: string | undefined;
      try {
        landedUuid = (await storage.addEpisode(input)).uuid;
        outcome = 'accepted';
      } catch {
        outcome = 'rejected';
      }

      // Both chain forms accept on the unchanged 0.8.3 backend; retain that contract.
      expect(outcome).toBe('accepted');
      const reopened = new GraphologyStorage(file);
      openStores.push(reopened);
      if (outcome === 'rejected') {
        expect(fs.readFileSync(file).equals(before)).toBe(true);
        expectOriginalPreserved(await storage.exportGraph(), fixture.graph);
      } else {
        const onDisk = readGraph(file);
        expect(onDisk.episodes.some((row) => row.uuid === landedUuid)).toBe(true);
        expectOriginalPreserved(onDisk, fixture.graph);
      }
      // Cold validation of whatever is on disk: accepted writes must remain loadable.
      await reopened.initialize();
      expectOriginalPreserved(await reopened.exportGraph(), fixture.graph);
    }
  });
});

describe('ordinary append eligibility differential (verified root must not apply)', () => {
  const [variant] = FIXTURES;

  it('uses the verified root and the re-armed ordinary guard for a plain public append', async () => {
    const { storage } = await enrolledHarness(variant.options);
    const refreshes = observeRefreshes(storage);
    const reads = observeReads(storage);

    await storage.addEpisode(ordinaryEpisode('baseline for differential'));

    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].ordinaryUnowned).toBe(true);
    expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBeUndefined();
    expect(reads.every((read) => read.verifiedPrivate !== undefined)).toBe(true);
  });

  it('keeps the export-based path and configured guard inside an active execution scope', async () => {
    const { fixture, file, storage } = await enrolledHarness(variant.options);
    const spies = integritySpies();
    const refreshes = observeRefreshes(storage);
    const reads = observeReads(storage);
    const context = {};
    const entry = openAutonomousPersonalExecutionScopeV1(context, 'memoryRead');
    bindAutonomousPersonalExecutionScopeV1(
      entry,
      context,
      {
        semantics: 'configured',
        version: 1,
        completion: { mode: 'inheritOverall' },
        syntax: { mode: 'limited', durationMs: 4_000 },
        finalizationReserve: { mode: 'automatic' },
      },
      20_000,
    );
    let configuredWork: unknown;

    const landed = await runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
      configuredWork = currentAutonomousPersonalExecutionScopeWorkV1();
      return storage.addEpisode(ordinaryEpisode('scoped append'));
    });

    expect(configuredWork).toBeDefined();
    expect(refreshes).toHaveLength(1);
    // No ordinary re-arm: the guard is the configured scope's work, not a fresh 5 s one.
    expect(refreshes[0].guard.typedSyntaxWork).toBe(configuredWork);
    expect(refreshes[0].ordinaryUnowned).toBe(false);
    expect(reads.every((read) => read.verifiedPrivate === undefined)).toBe(true);
    expect(spies.assert).toHaveBeenCalled();
    expect(readGraph(file).episodes.some((row) => row.uuid === landed.uuid)).toBe(true);
    expectOriginalPreserved(readGraph(file), fixture.graph);
  });

  it.each<[string, Record<string, unknown>]>([
    ['captureRecords', { captureRecords: 'lossless' }],
    ['requireExistingSnapshot', { requireExistingSnapshot: true }],
  ])(
    'never roots rollback in a verified parse for %s even when the ordinary flag is passed',
    async (_label, shape) => {
      const { fixture, file, storage } = await enrolledHarness(variant.options);
      const before = fs.readFileSync(file);
      const spies = integritySpies();
      const refreshes = observeRefreshes(storage);
      const reads = observeReads(storage);
      const mutation = jest.fn(() => 'done');

      await internals(storage).runMutation(mutation, {
        ...shape,
        ordinaryUnownedAppend: true,
        shouldWriteSnapshot: () => false,
      });

      expect(mutation).toHaveBeenCalledTimes(1);
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0].ordinaryUnowned).toBe(false);
      expect(reads.every((read) => read.verifiedPrivate === undefined)).toBe(true);
      expect(spies.assert).toHaveBeenCalled();
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expectOriginalPreserved(await storage.exportGraph(), fixture.graph);
    },
  );

  // Not constructible here without opaque private capabilities, which tests must not forge:
  // autonomousPersonalCompletionV4 (native completion) and captureRead (capture read).
  // Both are ANDed into ordinaryUnscoped at runMutation; cover them in an integration test
  // that obtains them through the public native/capture factories.
});

describe('configured execution scope deadline during an ordinary append', () => {
  it('raises the typed scope budget error and leaves bytes and Core unchanged when time runs out before mutation', async () => {
    const { fixture, file, storage } = await enrolledHarness(FIXTURES[0].options);
    const before = fs.readFileSync(file);
    const target = internals(storage);
    const read = target.readAndMigratePersistedDataUnderLock.bind(storage);
    jest
      .spyOn(target, 'readAndMigratePersistedDataUnderLock')
      .mockImplementation(async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 160));
        return read(...args);
      });
    const mutation = jest.spyOn(target, 'appendEpisodeInternal');
    const context = {};
    const entry = openAutonomousPersonalExecutionScopeV1(context, 'memoryRead');
    bindAutonomousPersonalExecutionScopeV1(
      entry,
      context,
      {
        semantics: 'configured',
        version: 1,
        completion: { mode: 'inheritOverall' },
        syntax: { mode: 'limited', durationMs: 100 },
        finalizationReserve: { mode: 'automatic' },
      },
      100,
    );

    const failure = await runAutonomousPersonalExecutionScopeV1(entry, context, () =>
      storage.addEpisode(ordinaryEpisode('scope deadline')),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect((failure as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
      'invocation_deadline',
    );
    expect(failure).not.toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
    expect(mutation).not.toHaveBeenCalled();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    jest.restoreAllMocks();
    expectOriginalPreserved(await storage.exportGraph(), fixture.graph);
  });
});

describe('in-memory store (no persist path)', () => {
  it('does not charge mutation-queue wait against the ordinary budget', async () => {
    const storage = new GraphologyStorage();
    openStores.push(storage);
    await storage.initialize();
    const clock = fakeClock();
    let release!: () => void;
    internals(storage).mutationTail = new Promise<void>((resolve) => (release = resolve));

    const pending = storage.addEpisode(ordinaryEpisode('in-memory queued'));
    await tick();
    clock.advance(6_000);
    release();

    const landed = await pending;
    expect((await storage.exportGraph()).episodes.some((row) => row.uuid === landed.uuid)).toBe(
      true,
    );
  });
});

describe('plain existing (unenrolled) store', () => {
  it('keeps the export-based path and the same rollback behavior', async () => {
    const fixture = await createAutonomousPersonalPersistedExistingStoreFixture({
      groupId: 'engram084-plain-existing',
      counts: { episodes: 6, entities: 4, edges: 3 },
      bytes: {
        episodeContent: 40,
        entitySummary: 20,
        edgeFact: 24,
        episodeAttributePayload: 3,
        entityAttributePayload: 2,
        edgeAttributePayload: 1,
      },
    });
    cleanups.push(() => fixture.close());
    const reads = observeReads(fixture.storage);
    const original = readGraph(fixture.file);

    const landed = await fixture.storage.addEpisode({
      group_id: 'engram084-plain-existing',
      content: 'plain append',
      role: 'human',
      reference_time: '2026-05-01T10:00:00.000Z',
    });

    expect(reads.every((read) => read.verifiedPrivate === undefined)).toBe(true);
    const appended = readGraph(fixture.file);
    expect(appended.episodes.some((row) => row.uuid === landed.uuid)).toBe(true);
    expect(byUuid(appended.entities)).toEqual(byUuid(original.entities));
    expect(byUuid(appended.edges)).toEqual(byUuid(original.edges));

    const before = fs.readFileSync(fixture.file);
    jest
      .spyOn(internals(fixture.storage), 'writeSnapshotUnderLock')
      .mockRejectedValueOnce(new Error('synthetic write failure'));
    await expect(
      fixture.storage.addEpisode({
        group_id: 'engram084-plain-existing',
        content: 'must not land',
        role: 'human',
        reference_time: '2026-05-01T10:00:00.000Z',
      }),
    ).rejects.toThrow('synthetic write failure');
    expect(fs.readFileSync(fixture.file).equals(before)).toBe(true);
    expect(
      (await fixture.storage.exportGraph()).episodes.some((row) => row.content === 'must not land'),
    ).toBe(false);
  });
});
