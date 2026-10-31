import { isDeepStrictEqual } from 'node:util';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as GraphDataMigration from '../../src/schemas/GraphDataMigration';
import * as RecordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { AutonomousPersonalRecordIntegrityV4Error } from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import {
  closeAutonomousPersonalCompletionV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  AutonomousPersonalExecutionScopeBudgetError,
  bindAutonomousPersonalExecutionScopeV1,
  openAutonomousPersonalExecutionScopeV1,
  runAutonomousPersonalExecutionScopeV1,
} from '../../src/storage/AutonomousPersonalExecutionScopeV1';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import { EngramChatMemory } from '../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { GraphData } from '../../src/schemas';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

/**
 * Captured before any spy is installed so a mock implementation can call through
 * to the real assertion instead of to the spy itself.
 */
const realIntegrityAssertion = RecordIntegrity.assertAutonomousPersonalRecordIntegrityV4;
const realCheckedParse = RecordIntegrity.parseIntegrityCheckedAutonomousPersonalGraphV4;
const realMigrateGraphData = GraphDataMigration.migrateGraphData;

/**
 * A cold read of an enrolled store asserted record integrity three times originally: raw
 * file graph, migrated graph, loader copy. Package A removed the loader copy (2). Package B
 * also skips the migrated-graph assertion, but ONLY when the same call's raw assertion
 * passed, nothing migrated and `provenIdenticalLosslessGraphData` proved the two graphs
 * structurally identical (so the migrated assertion would repeat the raw one on equal
 * data). The remaining assertion is the raw one, and a guard `check()` still runs after it.
 * Migrating stores, non-enrolled stores and raw/migrated differences still assert as before.
 */
const BASELINE_COLD_INTEGRITY_ASSERTIONS = 3;
const PACKAGE_A_COLD_INTEGRITY_ASSERTIONS = 2;
const EXPECTED_COLD_INTEGRITY_ASSERTIONS = 1;

const NESTED_ATTRIBUTES = {
  synthetic_nested: {
    unknown_field: 'preserved',
    list: [1, 2.5, { deep: ['a', { deeper: null, flag: true }] }],
    text: 'x'.repeat(512),
  },
};

interface EnrolledFixture {
  directory: string;
  file: string;
  namespace: string;
  sourceId: string;
}

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

/** Synthetic provider: one unit-selection response per request, no external network. */
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

/**
 * Enrolls and COMMITS an accepted claim through the supported native preparation and
 * completion entry points, with a synthetic provider response. Nothing is forged.
 */
async function createCommittedEnrolledStore(): Promise<EnrolledFixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-enrolled-cold-'));
  directories.push(directory);
  const file = join(directory, 'store.json');
  const store = new GraphologyStorage(file);
  await store.initialize();
  const seed = await seedAutonomousPersonalCaptureSubject(store);
  await store.addEntity({
    group_id: seed.request.namespace,
    name: 'Synthetic ordinary entity',
    entity_type: 'concept',
    attributes: NESTED_ATTRIBUTES,
  });
  const fetchSpy = installSyntheticProvider();
  const turn = 'cold-load-committed-turn';
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
  if (prepared.kind !== 'completion_prepared') {
    throw new Error(`Expected completion handle, received ${prepared.kind}`);
  }
  try {
    expect(await store.completeAutonomousPersonalCaptureV4!(prepared.handle)).toEqual({
      kind: 'matched',
    });
  } finally {
    closeAutonomousPersonalCompletionV4(store, prepared.handle);
  }
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  fetchSpy.mockRestore();
  await store.close();

  const persisted = readGraph(file);
  const operation = persisted.automatic_operations_v1?.operations.find((row) => row.version === 4);
  if (
    !operation ||
    operation.version !== 4 ||
    operation.state !== 'committed' ||
    operation.terminalReceipt.kind !== 'human_autonomous_capture_committed' ||
    operation.terminalReceipt.selection.kind !== 'occurrences'
  ) {
    throw new Error('Expected a committed occurrence receipt');
  }
  expect(operation.terminalReceipt.selection.items[0]).toMatchObject({ state: 'accepted' });
  expect(claimEdge(persisted)).toBeDefined();
  expect(valueEntity(persisted)).toBeDefined();
  return {
    directory,
    file,
    namespace: seed.request.namespace,
    sourceId: operation.identity.sourceId,
  };
}

function claimEdge(graph: GraphData) {
  return graph.edges.find((edge) => edge.attributes.engram_claim_v1 !== undefined);
}

function valueEntity(graph: GraphData) {
  return graph.entities.find((entity) => entity.attributes.engram_literal_v1 !== undefined);
}

function committedSelection(graph: GraphData) {
  const operation = graph.automatic_operations_v1!.operations[0]!;
  if (
    operation.version !== 4 ||
    operation.state !== 'committed' ||
    operation.terminalReceipt.kind !== 'human_autonomous_capture_committed' ||
    operation.terminalReceipt.selection.kind !== 'occurrences'
  ) {
    throw new Error('Expected a committed occurrence receipt');
  }
  return operation.terminalReceipt.selection;
}

function integritySpy() {
  // Observe either fully validating entry point. Their real implementations still
  // execute; migration can use the assertion while the raw read uses checked parse.
  const observed = jest.fn<void, Parameters<typeof realIntegrityAssertion>>();
  jest
    .spyOn(RecordIntegrity, 'assertAutonomousPersonalRecordIntegrityV4')
    .mockImplementation((...args) => {
      observed(...args);
      return realIntegrityAssertion(...args);
    });
  jest
    .spyOn(RecordIntegrity, 'parseIntegrityCheckedAutonomousPersonalGraphV4')
    .mockImplementation((...args) => {
      observed(...args);
      return realCheckedParse(...args);
    });
  return observed;
}

function isInitialized(store: GraphologyStorage): boolean {
  return (store as unknown as { initialized: boolean }).initialized;
}

function readGraph(file: string): GraphData {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
}

function writeGraph(file: string, graph: GraphData): void {
  fs.writeFileSync(file, JSON.stringify(graph, null, 2));
}

async function initializeFailure(store: GraphologyStorage): Promise<Error & { cause?: unknown }> {
  const failure = await store.initialize().then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  if (!failure) throw new Error('Expected initialize() to reject');
  return failure;
}

describe('enrolled embedded store cold load', () => {
  it('drops the cold integrity assertion count from 3 (A: 2) to 1 without changing any record', async () => {
    const fixture = await createCommittedEnrolledStore();
    const bytesBefore = fs.readFileSync(fixture.file);
    const onDisk = readGraph(fixture.file);
    const spy = integritySpy();

    const restarted = track(new GraphologyStorage(fixture.file));
    await restarted.initialize();

    expect(isInitialized(restarted)).toBe(true);
    // The claim index path really ran (committed pair), and the count still holds.
    expect(spy).toHaveBeenCalledTimes(EXPECTED_COLD_INTEGRITY_ASSERTIONS);
    expect(EXPECTED_COLD_INTEGRITY_ASSERTIONS).toBeLessThan(PACKAGE_A_COLD_INTEGRITY_ASSERTIONS);
    expect(PACKAGE_A_COLD_INTEGRITY_ASSERTIONS).toBeLessThan(BASELINE_COLD_INTEGRITY_ASSERTIONS);
    expect(fs.readFileSync(fixture.file).equals(bytesBefore)).toBe(true);

    const exported = await restarted.exportGraph();
    // UUIDs, content, source offsets, operations, bindings, decisions and unknown attributes.
    expect(exported.entities).toEqual(onDisk.entities);
    expect(exported.edges).toEqual(onDisk.edges);
    expect(exported.episodes).toEqual(onDisk.episodes);
    expect(exported.automatic_operations_v1).toEqual(onDisk.automatic_operations_v1);
    expect(isDeepStrictEqual(exported.entities, onDisk.entities)).toBe(true);
    expect(isDeepStrictEqual(exported.edges, onDisk.edges)).toBe(true);
    expect(isDeepStrictEqual(exported.episodes, onDisk.episodes)).toBe(true);
    expect(
      isDeepStrictEqual(exported.automatic_operations_v1, onDisk.automatic_operations_v1),
    ).toBe(true);
    expect(
      exported.entities.find((row) => row.name === 'Synthetic ordinary entity')?.attributes,
    ).toEqual(NESTED_ATTRIBUTES);
    expect(claimEdge(exported)).toBeDefined();
    expect(valueEntity(exported)).toBeDefined();
  });

  it('keeps the unchanged default path for a non-enrolled store', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'engram-plain-cold-'));
    directories.push(directory);
    const file = join(directory, 'store.json');
    const store = new GraphologyStorage(file);
    await store.initialize();
    await store.addEntity({
      group_id: 'plain',
      name: 'Synthetic plain entity',
      entity_type: 'concept',
      attributes: NESTED_ATTRIBUTES,
    });
    await store.close();
    const onDisk = readGraph(file);
    const spy = integritySpy();
    const migrate = jest.spyOn(GraphDataMigration, 'migrateGraphData');

    const restarted = track(new GraphologyStorage(file));
    await restarted.initialize();

    expect(spy).not.toHaveBeenCalled();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect((await restarted.exportGraph()).entities).toEqual(onDisk.entities);
  });

  it('keeps every row after an ordinary addEntity append to the enrolled store', async () => {
    const fixture = await createCommittedEnrolledStore();
    const before = readGraph(fixture.file);
    const store = track(new GraphologyStorage(fixture.file));
    await store.initialize();
    const appended = await store.addEntity({
      group_id: fixture.namespace,
      name: 'Synthetic post-enrollment entity',
      entity_type: 'concept',
      attributes: NESTED_ATTRIBUTES,
    });
    await store.close();

    const after = readGraph(fixture.file);
    expect(after.entities.map((row) => row.uuid)).toEqual([
      ...before.entities.map((row) => row.uuid),
      appended.uuid,
    ]);
    expect(after.entities.slice(0, before.entities.length)).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('appends an ordinary legacy human + final assistant turn through EngramChatMemory.saveContext', async () => {
    const fixture = await createCommittedEnrolledStore();
    const before = readGraph(fixture.file);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected_provider_dispatch');
    });

    const store = track(new GraphologyStorage(fixture.file));
    await store.initialize();
    const memory = new EngramChatMemory({
      storage: store,
      groupId: 'legacy-ordinary-turns',
      enableExtraction: false,
    });
    await memory.saveContext(
      { input: 'Ordinary legacy human turn' },
      { output: 'Ordinary legacy assistant final' },
    );
    await store.close();

    expect(fetchSpy).not.toHaveBeenCalled();
    const after = readGraph(fixture.file);
    // Every pre-existing row, protected attribute, offset, chain, binding and receipt is untouched.
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    for (const episode of before.episodes) {
      expect(after.episodes.find((row) => row.uuid === episode.uuid)).toEqual(episode);
    }
    const added = after.episodes.filter(
      (row) => !before.episodes.some((existing) => existing.uuid === row.uuid),
    );
    expect(added.map((row) => row.content)).toEqual([
      'Ordinary legacy human turn',
      'Ordinary legacy assistant final',
    ]);
    for (const episode of added) {
      expect(episode.group_id).toBe('legacy-ordinary-turns');
      expect(episode.attributes.engram_write_owner_v4).toBeUndefined();
    }

    const again = track(new GraphologyStorage(fixture.file));
    await again.initialize();
    expect(isInitialized(again)).toBe(true);
  });

  describe('tampered persisted state is still denied', () => {
    interface Tamper {
      name: string;
      mutate: (graph: GraphData, sourceId: string) => void;
      /** Exact record-integrity reason traced to AutonomousPersonalRecordIntegrityV4.test.ts. */
      reason?: string;
    }
    const tampers: Tamper[] = [
      {
        name: 'claim edge (future family tag)',
        mutate: (graph) => {
          claimEdge(graph)!.attributes.engram_claim_v1 = {
            version: 7,
            family: 'autonomous-personal-future',
          };
        },
        reason: 'invalid_pair',
      },
      {
        name: 'value marker (future family tag)',
        mutate: (graph) => {
          valueEntity(graph)!.attributes.engram_literal_v1 = {
            version: 7,
            family: 'autonomous-personal-future',
          };
        },
        // Source trace: collectFootprints adds the value (family tag), the claim edge is
        // inspected, inspectCreator fails marker parsing with 'invalid_claim', and
        // inspectFailureReason maps that to 'invalid_pair'. Index construction and the
        // ledger/source guard do not interpret entity markers.
        reason: 'invalid_pair',
      },
      {
        name: 'terminal receipt occurrence evidence hash',
        mutate: (graph) => {
          const selection = committedSelection(graph) as {
            items: Array<{ evidenceHash: string }>;
          };
          selection.items[0]!.evidenceHash = 'f'.repeat(64);
        },
        reason: 'invalid_creator',
      },
      {
        name: 'positive occurrence whose pair rows were deleted',
        mutate: (graph) => {
          const edge = claimEdge(graph)!;
          const value = valueEntity(graph)!;
          graph.edges = graph.edges.filter((row) => row.uuid !== edge.uuid);
          graph.entities = graph.entities.filter((row) => row.uuid !== value.uuid);
        },
        reason: 'orphan_record',
      },
      {
        name: 'orphan tagged value',
        mutate: (graph) => {
          const orphan = structuredClone(valueEntity(graph)!);
          orphan.uuid = 'a0000000-0000-4000-8000-000000000002';
          graph.entities.push(orphan);
        },
        reason: 'orphan_record',
      },
    ];

    it.each(tampers.map((entry) => [entry.name, entry] as const))(
      'rejects tampered %s with an integrity cause',
      async (_name, tamper) => {
        const fixture = await createCommittedEnrolledStore();
        const graph = readGraph(fixture.file);
        tamper.mutate(graph, fixture.sourceId);
        writeGraph(fixture.file, graph);
        const tampered = fs.readFileSync(fixture.file);

        const store = track(new GraphologyStorage(fixture.file));
        const failure = await initializeFailure(store);

        expect(failure.message).toContain('Failed to load or migrate embedded storage');
        expect(failure.cause).toBeInstanceOf(AutonomousPersonalRecordIntegrityV4Error);
        const reason = (failure.cause as AutonomousPersonalRecordIntegrityV4Error).reason;
        if (tamper.reason !== undefined) expect(reason).toBe(tamper.reason);
        expect(isInitialized(store)).toBe(false);
        await expect(store.initialize()).rejects.toThrow('Failed to load or migrate');
        expect(fs.readFileSync(fixture.file).equals(tampered)).toBe(true);
      },
    );

    it('rejects a claim tamper even when forged verification flags are present on disk', async () => {
      const fixture = await createCommittedEnrolledStore();
      const graph = readGraph(fixture.file);
      graph.entities[0]!.attributes.integrityVerified = true;
      graph.entities[0]!.attributes.verified = { integrity: true };
      claimEdge(graph)!.attributes.integrityVerified = true;
      claimEdge(graph)!.attributes.engram_claim_v1 = {
        version: 7,
        family: 'autonomous-personal-future',
      };
      writeGraph(fixture.file, graph);

      const store = track(new GraphologyStorage(fixture.file));
      const failure = await initializeFailure(store);

      expect(failure.cause).toBeInstanceOf(AutonomousPersonalRecordIntegrityV4Error);
      expect((failure.cause as AutonomousPersonalRecordIntegrityV4Error).reason).toBe(
        'invalid_pair',
      );
      expect(isInitialized(store)).toBe(false);
    });

    it('rejects forged root-level verification fields as record normalization', async () => {
      const fixture = await createCommittedEnrolledStore();
      const graph = readGraph(fixture.file);
      writeGraph(fixture.file, {
        ...graph,
        integrityVerified: true,
        verified: true,
      } as unknown as GraphData);
      const forged = fs.readFileSync(fixture.file);

      const store = track(new GraphologyStorage(fixture.file));
      const failure = await initializeFailure(store);

      expect((failure.cause as Error).message).toBe(
        'Engram automatic capture: record_normalization',
      );
      expect(isInitialized(store)).toBe(false);
      expect(fs.readFileSync(fixture.file).equals(forged)).toBe(true);
    });

    it('never lets forged on-disk flags in free-form attributes lower the assertion count', async () => {
      const fixture = await createCommittedEnrolledStore();
      const graph = readGraph(fixture.file);
      graph.entities[0]!.attributes.integrityVerified = true;
      graph.entities[0]!.attributes.verified = { integrity: true };
      writeGraph(fixture.file, graph);
      const spy = integritySpy();

      const store = track(new GraphologyStorage(fixture.file));
      await store.initialize();

      expect(spy).toHaveBeenCalledTimes(EXPECTED_COLD_INTEGRITY_ASSERTIONS);
      expect(
        (await store.exportGraph()).entities.find((row) => row.uuid === graph.entities[0]!.uuid)
          ?.attributes,
      ).toMatchObject({ integrityVerified: true, verified: { integrity: true } });
    });

    it('keeps source and ledger tampering as separately classified failures', async () => {
      const fixture = await createCommittedEnrolledStore();
      const graph = readGraph(fixture.file);
      graph.episodes.find((row) => row.uuid === fixture.sourceId)!.content += ' tampered';
      writeGraph(fixture.file, graph);

      const store = track(new GraphologyStorage(fixture.file));
      const failure = await initializeFailure(store);

      // The first guard may be the ledger/source guard, not the record integrity class.
      expect(failure.cause).toBeInstanceOf(Error);
      expect(failure.cause).not.toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
      expect(failure.cause).not.toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
      expect(isInitialized(store)).toBe(false);
    });
  });

  it('keeps an original typed deadline cause distinct from an integrity cause', async () => {
    const fixture = await createCommittedEnrolledStore();
    const realNow = performance.now.bind(performance);
    let offset = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
    // Deterministic injected clock: the ordinary 5s typed-syntax deadline passes
    // before the first integrity assertion starts, on the genuine committed-claim path.
    integritySpy().mockImplementation((...args) => {
      offset += 60_000;
      return realIntegrityAssertion(...args);
    });

    const store = track(new GraphologyStorage(fixture.file));
    const failure = await initializeFailure(store);

    expect(failure.cause).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
    expect(failure.cause).not.toBeInstanceOf(AutonomousPersonalRecordIntegrityV4Error);
    expect((failure.cause as AutonomousPersonalTypedSyntaxFailureV1).reason).toBe('deadline');
    expect(isInitialized(store)).toBe(false);
  });

  describe('configured execution scope', () => {
    const budget = {
      semantics: 'configured',
      version: 1,
      completion: { mode: 'inheritOverall' },
      syntax: { mode: 'inheritOverall' },
      finalizationReserve: { mode: 'automatic' },
    };

    /**
     * The disturbance is queued as a microtask after the LAST real assertion (the raw one;
     * the migrated assertion is skipped by proof) returned. The synchronous identity proof
     * and the retained guard check run before that microtask, so only the loader's check
     * after the awaits can observe it.
     */
    async function initializeInScope(
      fixture: EnrolledFixture,
      parent: AbortController,
      disturb: () => void,
    ) {
      const events: string[] = [];
      const spy = integritySpy();
      spy.mockImplementation((...args) => {
        const result = realIntegrityAssertion(...args);
        events.push('assertion-completed');
        if (
          events.filter((event) => event === 'assertion-completed').length ===
          EXPECTED_COLD_INTEGRITY_ASSERTIONS
        ) {
          queueMicrotask(() => {
            events.push('disturbed');
            disturb();
          });
        }
        return result;
      });
      const context = {};
      const entry = openAutonomousPersonalExecutionScopeV1(context, 'memorySave');
      bindAutonomousPersonalExecutionScopeV1(entry, context, budget, 30_000, parent.signal);
      const store = track(new GraphologyStorage(fixture.file));
      let inner: unknown;
      let outer: unknown;
      try {
        await runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
          try {
            await store.initialize();
            events.push('initialized');
          } catch (error) {
            inner = error;
            events.push('initialize-rejected');
          }
        });
      } catch (error) {
        // The final scope check can reject the outer run as well.
        outer = error;
        events.push('scope-rejected');
      }
      return { store, failure: outer ?? inner, events, spy };
    }

    function expectLateScopeFailure(
      result: Awaited<ReturnType<typeof initializeInScope>>,
      stopReason: string,
      fixture: EnrolledFixture,
      bytes: Buffer,
    ) {
      // The one remaining real assertion completed, the disturbance came after it, and the
      // failure after that (observed by the retained post-await check).
      expect(result.spy).toHaveBeenCalledTimes(EXPECTED_COLD_INTEGRITY_ASSERTIONS);
      expect(result.events.slice(0, 2)).toEqual(['assertion-completed', 'disturbed']);
      expect(result.events).not.toContain('initialized');
      expect(result.failure).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
      expect((result.failure as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
        stopReason,
      );
      expect(result.failure).not.toBeInstanceOf(AutonomousPersonalRecordIntegrityV4Error);
      expect(isInitialized(result.store)).toBe(false);
      expect(fs.readFileSync(fixture.file).equals(bytes)).toBe(true);
    }

    it('does not bypass abort observed after the awaits when the third assertion is skipped', async () => {
      const fixture = await createCommittedEnrolledStore();
      const bytes = fs.readFileSync(fixture.file);
      const parent = new AbortController();
      const result = await initializeInScope(fixture, parent, () => parent.abort());
      expectLateScopeFailure(result, 'parent_cancelled', fixture, bytes);
    });

    it('does not bypass a scope deadline reached after the awaits', async () => {
      const fixture = await createCommittedEnrolledStore();
      const bytes = fs.readFileSync(fixture.file);
      const realNow = performance.now.bind(performance);
      let offset = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
      const result = await initializeInScope(fixture, new AbortController(), () => {
        offset += 120_000;
      });
      expectLateScopeFailure(result, 'invocation_deadline', fixture, bytes);
    });
  });

  describe('migrated-graph assertion skip is decided by the real proof', () => {
    type Migration = ReturnType<typeof realMigrateGraphData>;
    const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, child]) => [key, reorder(child)]),
        );
      }
      return value;
    };

    /**
     * Replaces only the cold read's own migration result; every other call stays real.
     * A validated current enrolled file no longer reaches the migrator (it reuses the
     * same call's lossless graph with a report-only summary, see
     * SUPPORT/CURRENT_READ_DESIGN.md), so `transformed()` must stay 0 and the injected
     * change can never apply. Outcomes that used to fail now succeed ONLY because the
     * injected migrator provably did not execute.
     */
    function spyMigration(transform: (real: Migration) => Migration) {
      let calls = 0;
      let transformed = 0;
      jest.spyOn(GraphDataMigration, 'migrateGraphData').mockImplementation((input) => {
        const result = realMigrateGraphData(input);
        calls += 1;
        if (calls !== 1) return result;
        transformed += 1;
        return transform(result);
      });
      return { transformed: () => transformed };
    }

    async function expectOriginalPreserved(
      store: GraphologyStorage,
      fixture: EnrolledFixture,
      bytes: Buffer,
      before: ReturnType<typeof readGraph>,
    ) {
      expect(isInitialized(store)).toBe(true);
      expect(fs.readFileSync(fixture.file).equals(bytes)).toBe(true);
      const exported = await store.exportGraph();
      expect(exported.entities).toEqual(before.entities);
      expect(exported.edges).toEqual(before.edges);
      expect(exported.episodes).toEqual(before.episodes);
      expect(exported.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    }

    it('never applies an injected claim-tag change to a validated current file', async () => {
      const fixture = await createCommittedEnrolledStore();
      const bytes = fs.readFileSync(fixture.file);
      const before = readGraph(fixture.file);
      const migration = spyMigration((real) => {
        const data = jsonCopy(real.data);
        claimEdge(data)!.attributes.engram_claim_v1 = {
          version: 7,
          family: 'autonomous-personal-future',
        };
        return { ...real, data };
      });
      const integrity = integritySpy();

      const store = track(new GraphologyStorage(fixture.file));
      await store.initialize();

      expect(migration.transformed()).toBe(0);
      expect(integrity).toHaveBeenCalledTimes(EXPECTED_COLD_INTEGRITY_ASSERTIONS);
      await expectOriginalPreserved(store, fixture, bytes, before);
    });

    it('never applies an injected migration_required to a validated current file', async () => {
      const fixture = await createCommittedEnrolledStore();
      const bytes = fs.readFileSync(fixture.file);
      const before = readGraph(fixture.file);
      const migration = spyMigration((real) => ({
        ...real,
        report: { ...real.report, migration_required: true },
      }));
      const integrity = integritySpy();

      const store = track(new GraphologyStorage(fixture.file));
      await store.initialize();

      expect(migration.transformed()).toBe(0);
      expect(integrity).toHaveBeenCalledTimes(EXPECTED_COLD_INTEGRITY_ASSERTIONS);
      expect(fs.existsSync(`${fixture.file}.pre-schema-2.0.backup.json`)).toBe(false);
      const status = await store.getMigrationStatus();
      expect(status.automatic_migration_completed).toBe(false);
      expect(status.backup).toMatchObject({ created: false });
      await expectOriginalPreserved(store, fixture, bytes, before);
    });

    it('skips with one assertion and never runs an injected key reorder', async () => {
      const fixture = await createCommittedEnrolledStore();
      const bytes = fs.readFileSync(fixture.file);
      const before = readGraph(fixture.file);
      const migration = spyMigration((real) => ({
        ...real,
        data: reorder(real.data) as Migration['data'],
      }));
      const integrity = integritySpy();

      const store = track(new GraphologyStorage(fixture.file));
      await store.initialize();

      expect(migration.transformed()).toBe(0);
      expect(integrity).toHaveBeenCalledTimes(EXPECTED_COLD_INTEGRITY_ASSERTIONS);
      await expectOriginalPreserved(store, fixture, bytes, before);
    });

    it('never applies an injected hostile object to a validated current file', async () => {
      const fixture = await createCommittedEnrolledStore();
      const bytes = fs.readFileSync(fixture.file);
      const before = readGraph(fixture.file);
      const migration = spyMigration((real) => {
        const data = jsonCopy(real.data);
        data.entities[0]!.attributes.hostile = new Proxy({}, {});
        return { ...real, data };
      });
      const integrity = integritySpy();

      const store = track(new GraphologyStorage(fixture.file));
      await store.initialize();

      expect(migration.transformed()).toBe(0);
      expect(integrity).toHaveBeenCalledTimes(EXPECTED_COLD_INTEGRITY_ASSERTIONS);
      await expectOriginalPreserved(store, fixture, bytes, before);
    });
  });
});
