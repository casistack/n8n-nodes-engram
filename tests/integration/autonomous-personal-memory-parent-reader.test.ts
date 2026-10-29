import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import * as qualifiedClaims from '../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  getAutonomousPersonalMemoryLineageOriginV4,
  publishAutonomousPersonalMemoryHandoffV4,
  type PrivateAutonomousPersonalMemoryLineageV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import {
  closeAutonomousPersonalMemoryParentReaderV4,
  getAutonomousPersonalMemoryParentNamespaceGraphV4,
  readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4,
  getAutonomousPersonalMemoryParentReceiptSummaryV4,
  isLiveAutonomousPersonalMemoryParentReaderV4,
  openAutonomousPersonalMemoryParentReaderV4,
} from '../../src/memory/AutonomousPersonalMemoryParentReaderV4';
import { hashAutomaticCaptureV2 } from '../../src/schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema,
  type AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data,
} from '../../src/schemas/AutonomousPersonalMemoryParentQualifiedClaimCandidateV4.schema';
import * as recordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { boundedAutomaticClaimReadJsonBytes } from '../../src/extraction/AutomaticClaimCommitProof';
import {
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScopeRemaining,
  getAutomaticClaimReadScope,
  type AutomaticClaimReadScope,
} from '../../src/storage/AutomaticClaimReadScope';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { AutonomousPersonalNativeOriginV4 } from '../../src/schemas/AutonomousPersonalNativeOriginV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { GraphData } from '../../src/schemas/GraphData.schema';
import type { AutonomousPersonalOperationV4 } from '../../src/schemas/AutonomousPersonalOperationV4.schema';
import type { CompositionalRetrievalSnapshotResultV3 } from '../../src/schemas/CompositionalRetrievalSnapshotV3.schema';
import { readAutonomousPersonalNativeMemoryConfigV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import {
  autonomousPersonalMemoryContextV4,
  autonomousPersonalMemoryStoreHashV4,
  type AutonomousPersonalMemoryContextOptionsV4,
  type AutonomousPersonalMemorySourceMappingV4,
} from '../helpers/autonomousPersonalMemoryBackend';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

type ProviderMode = 'success' | 'unavailable' | 'unexpected';
type CommittedOperation = Extract<AutonomousPersonalOperationV4, { state: 'committed' }>;
type ParentOptions = {
  readonly profile?: 'conservative' | 'explicit' | 'reviewFirst';
  readonly explicitIntent?: boolean;
  readonly providerMode?: ProviderMode;
  readonly providerCategory?: 'preference' | 'work_role';
  readonly sourceMapping?: AutonomousPersonalMemorySourceMappingV4;
  readonly humanQuery?: string;
  readonly seed?: AutonomousPersonalCaptureSeed;
  readonly leaveHandoffPending?: boolean;
};
type ParentFixture = {
  readonly config: Awaited<ReturnType<typeof readAutonomousPersonalNativeMemoryConfigV4>>;
  readonly lineage: PrivateAutonomousPersonalMemoryLineageV4;
  readonly memoryContext: ReturnType<typeof autonomousPersonalMemoryContextV4>;
  readonly native: { instance: string; workflow: string; execution: string };
  readonly operation: CommittedOperation;
  readonly origin: AutonomousPersonalNativeOriginV4;
  readonly source: GraphData['episodes'][number];
  readonly sourceId: string;
  readonly store: GraphologyStorage;
  readonly storeHash: string;
  readonly turn: string;
};
type PendingParentFixture = Omit<ParentFixture, 'lineage' | 'origin'> & { lineage: null };

const queryText = 'I prefer concise explanations.';

describe('actual Graphology Autonomous Personal Memory parent reader V4', () => {
  let directory: string;
  let file: string;
  let workflowId: string;
  let store: GraphologyStorage;
  let storeOpen: boolean;
  let seed: AutonomousPersonalCaptureSeed;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-memory-parent-reader-'));
    workflowId = `memory-parent-${randomUUID()}`;
    file = join(directory, `${workflowId}-engram.json`);
    store = new GraphologyStorage(file);
    storeOpen = false;
    await store.initialize();
    storeOpen = true;
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      if (storeOpen) await store.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      storeOpen = false;
      jest.useRealTimers();
    }
  });

  function installProvider(
    mode: ProviderMode,
    category: 'preference' | 'work_role' = 'preference',
  ) {
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (mode === 'unexpected') throw new Error('unexpected_memory_parent_provider_dispatch');
      if (mode === 'unavailable') return new Response('synthetic unavailable', { status: 503 });
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: user.units.map(({ unitId }) => ({
                    unitId,
                    category,
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
    provider.mockClear();
    return provider;
  }

  function completedOperation(graph: GraphData, turn: string): CommittedOperation {
    const matches = (graph.automatic_operations_v1?.operations ?? []).filter(
      (operation): operation is CommittedOperation =>
        operation.version === 4 &&
        operation.state === 'committed' &&
        operation.identity.turn === turn,
    );
    if (matches.length !== 1) throw new Error('Expected exactly one committed parent Operation4');
    return matches[0]!;
  }

  function memoryParameters(
    base: Omit<AutonomousPersonalMemoryContextOptionsV4, 'persistPath' | 'storageWorkflowId'>,
  ): AutonomousPersonalMemoryContextOptionsV4 {
    return {
      ...base,
      persistPath: file,
      storageWorkflowId: workflowId,
    };
  }

  async function createParent(
    options: ParentOptions & { readonly leaveHandoffPending: true },
  ): Promise<PendingParentFixture>;
  async function createParent(options?: ParentOptions): Promise<ParentFixture>;
  async function createParent(
    options: ParentOptions = {},
  ): Promise<ParentFixture | PendingParentFixture> {
    const profileId = options.profile ?? 'conservative';
    const explicitIntent = options.explicitIntent ?? false;
    const providerMode = options.providerMode ?? 'success';
    const providerCategory = options.providerCategory ?? 'preference';
    const parentSeed = options.seed ?? seed;
    const humanQuery = options.humanQuery ?? queryText;
    const sourceMapping = options.sourceMapping ?? { mode: 'full_body' as const };
    const turn = `memory-parent-turn-${randomUUID()}`;
    const native = {
      instance: `memory-instance-${turn}`,
      workflow: workflowId,
      execution: `memory-execution-${turn}`,
    };
    const formattedSource =
      sourceMapping.mode === 'application_region' ? 'Speaker 🧭: '.concat(humanQuery) : humanQuery;
    const humanRegion =
      sourceMapping.mode === 'application_region'
        ? { start: 'Speaker 🧭: '.length, end: 'Speaker 🧭: '.length + humanQuery.length }
        : undefined;
    if (
      sourceMapping.mode === 'application_region' &&
      (sourceMapping.humanRegion.start !== humanRegion!.start ||
        sourceMapping.humanRegion.end !== humanRegion!.end)
    ) {
      throw new Error('Wrapper test mapping must cover the exact raw human region');
    }

    const provider = installProvider(providerMode, providerCategory);
    const producerContext = nativeAutonomousPersonalCaptureContext(parentSeed, {
      content: formattedSource,
      executionId: native.execution,
      workflowId: native.workflow,
      instanceId: native.instance,
      routeId: 'route:parent-reader',
      model: 'model:parent-reader',
      requestLimit: 2,
      deadlineMs: 30_000,
      extraParameters: {
        automaticMemoryProfile: profileId,
        automaticIntent: explicitIntent ? 'enabled' : 'disabled',
        automaticTurn: turn,
        automaticInput: formattedSource,
        automaticRawHuman: sourceMapping.mode === 'application_region' ? humanQuery : '',
        automaticWrapper: sourceMapping.mode === 'application_region' ? 'enabled' : 'disabled',
        ...(humanRegion
          ? {
              automaticRegionStart: humanRegion.start,
              automaticRegionEnd: humanRegion.end,
            }
          : {}),
        queueTemperatureMode: 'providerDefault',
      },
    });
    const completed = await completeNativeAutonomousPersonalCaptureV4(producerContext, store);
    if (completed.kind !== 'original_turn') {
      throw new Error(`Expected real C2 original turn; got ${completed.kind}`);
    }
    if (providerMode === 'unexpected') expect(provider).not.toHaveBeenCalled();
    else expect(provider).toHaveBeenCalled();

    const beforeReopen = await store.exportGraph(parentSeed.request.namespace);
    const operation = completedOperation(beforeReopen, turn);
    const source = beforeReopen.episodes.find(
      (episode) => episode.uuid === operation.identity.sourceId,
    );
    if (!source) throw new Error('Expected actual committed Source4 episode');
    expect(source.content).toBe(formattedSource);

    const published = publishAutonomousPersonalMemoryHandoffV4(
      producerContext,
      store,
      completed.origin,
    );
    if (published.kind !== 'published') {
      throw new Error(`Expected native handoff publication; got ${published.kind}`);
    }
    expect(published).toEqual({ kind: 'published', sourceId: operation.identity.sourceId });

    await store.close();
    storeOpen = false;
    store = new GraphologyStorage(file);
    await store.initialize();
    storeOpen = true;

    const storeHash = autonomousPersonalMemoryStoreHashV4(file);
    expect(operation.identity.storeHash).toBe(storeHash);
    const memoryContextOptions = memoryParameters({
      native,
      namespace: operation.identity.namespace,
      issuer: operation.identity.issuer,
      actorReference: operation.identity.actorReference,
      turn: operation.identity.turn,
      sourceId: published.sourceId,
      profileId,
      explicitIntent,
      currentHumanQuery: humanQuery,
      ...(sourceMapping.mode === 'application_region' ? { rawHumanContent: humanQuery } : {}),
      sourceMapping,
    });
    const memoryContext = autonomousPersonalMemoryContextV4(memoryContextOptions);
    const config = await readAutonomousPersonalNativeMemoryConfigV4(memoryContext, 0, storeHash);
    const base = {
      config,
      memoryContext,
      native,
      operation,
      source,
      sourceId: operation.identity.sourceId,
      store,
      storeHash,
      turn,
    };
    if (options.leaveHandoffPending) return { ...base, lineage: null };

    const lineage = consumeAutonomousPersonalMemoryHandoffV4(
      memoryContext,
      config.storeHash,
      config.namespace,
      config.issuer,
      config.actorReference,
      config.turn,
      config.sourceId,
    );
    if (!lineage) throw new Error('Expected one genuine same-execution Memory lineage');
    const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
    if (!origin) throw new Error('Expected the private lineage origin DATA');
    expect(origin.identity).toEqual(operation.identity);
    expect(origin.terminalReceipt).toEqual(operation.terminalReceipt);
    return { ...base, lineage, origin };
  }

  function readResources(
    signal: AbortSignal = new AbortController().signal,
    workDeadlineMs = performance.now() + 30_000,
    freezeWork = true,
  ) {
    const budget = { remaining: 512, deferred: 0 };
    const scope: AutomaticClaimReadScope = getAutomaticClaimReadScope(budget);
    const workData = {
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal,
    };
    workData.absoluteMonotonicDeadlineMs = workDeadlineMs;
    const work: AutonomousPersonalTypedSyntaxWorkV1 = freezeWork
      ? Object.freeze(workData)
      : workData;
    return { scope, work, check: jest.fn() };
  }

  function watchSnapshot(owner: GraphologyStorage) {
    let actual: CompositionalRetrievalSnapshotResultV3 | undefined;
    const original = owner.readCompositionalRetrievalSnapshotV3.bind(owner);
    const spy = jest
      .spyOn(owner, 'readCompositionalRetrievalSnapshotV3')
      .mockImplementation(async (scope) => {
        const result = await original(scope);
        if (result.status === 'snapshot') actual = result;
        return result;
      });
    return {
      spy,
      get actual() {
        return actual;
      },
    };
  }

  function watchIndexConstruction() {
    const created: ReturnType<
      typeof recordIntegrity.createIntegrityCheckedAutonomousPersonalClaimIndexV4
    >[] = [];
    const original = recordIntegrity.createIntegrityCheckedAutonomousPersonalClaimIndexV4;
    const spy = jest
      .spyOn(recordIntegrity, 'createIntegrityCheckedAutonomousPersonalClaimIndexV4')
      .mockImplementation((graph, work, check) => {
        const index = original(graph, work, check);
        created.push(index);
        return index;
      });
    return { spy, created };
  }

  function expectRejected(
    owner: GraphologyStorage,
    result: Awaited<ReturnType<typeof openAutonomousPersonalMemoryParentReaderV4>>,
    reason: string,
  ): void {
    if (result.kind === 'reader_ready')
      closeAutonomousPersonalMemoryParentReaderV4(owner, result.reader);
    expect(result).toEqual({ kind: 'rejected', reason });
  }

  function createdClaimId(operation: CommittedOperation): string {
    const receipt = operation.terminalReceipt;
    if (
      receipt.kind !== 'human_autonomous_capture_committed' ||
      receipt.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected a committed occurrence receipt');
    }
    const item = receipt.selection.items.find(
      (candidate) => candidate.effect === 'created' && candidate.claimId !== null,
    );
    if (!item?.claimId) throw new Error('Expected a created Claim3 row');
    return item.claimId;
  }

  function candidateOrThrow(
    candidate: AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data | null,
  ): AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data {
    if (candidate === null) throw new Error('Expected an accepted compact Claim3 candidate');
    return candidate;
  }

  function expectDeepFrozen(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value as Record<string, unknown>)) expectDeepFrozen(child);
  }

  function persistedGraphData(graph: GraphData): Partial<GraphData> {
    const persisted: Partial<GraphData> = { ...graph };
    delete persisted.exported_at;
    return persisted;
  }

  async function setActualCandidateTripleBytes(
    fixture: ParentFixture,
    claimId: string,
    targetBytes: number,
  ): Promise<GraphData> {
    const graph = await fixture.store.exportGraph(fixture.config.namespace);
    const edge = graph.edges.find((row) => row.uuid === claimId);
    if (!edge) throw new Error('Expected the actual Claim3 edge');
    const subject = graph.entities.find((row) => row.uuid === edge.source_node_uuid);
    const value = graph.entities.find((row) => row.uuid === edge.target_node_uuid);
    if (!subject || !value) throw new Error('Expected the actual candidate endpoint rows');
    const attributes = { ...subject.attributes };
    delete attributes.candidate_projection_padding;
    const baseSubject = { ...subject, attributes };
    const triple = { edge, subject: baseSubject, value };
    const baseBytes = boundedAutomaticClaimReadJsonBytes(triple, 100 * 1024 * 1024);
    const key = 'candidate_projection_padding';
    const fixedPropertyBytes =
      (Object.keys(attributes).length === 0 ? 0 : 1) +
      Buffer.byteLength(JSON.stringify(key), 'utf8') +
      1 +
      2;
    const paddingBytes = targetBytes - baseBytes - fixedPropertyBytes;
    if (paddingBytes < 0) throw new Error('Candidate triple base exceeds requested test boundary');
    await fixture.store.updateEntity(subject.uuid, {
      attributes: { ...attributes, [key]: 'x'.repeat(paddingBytes) },
    });
    const paddedGraph = await fixture.store.exportGraph(fixture.config.namespace);
    const paddedEdge = paddedGraph.edges.find((row) => row.uuid === claimId);
    const paddedSubject = paddedGraph.entities.find((row) => row.uuid === subject.uuid);
    const paddedValue = paddedGraph.entities.find((row) => row.uuid === value.uuid);
    if (!paddedEdge || !paddedSubject || !paddedValue)
      throw new Error('Expected the padded actual candidate triple');
    expect(
      boundedAutomaticClaimReadJsonBytes(
        { edge: paddedEdge, subject: paddedSubject, value: paddedValue },
        targetBytes,
      ),
    ).toBe(targetBytes);
    expect(paddedSubject.attributes.engram_actor_bindings_v1).toEqual(
      subject.attributes.engram_actor_bindings_v1,
    );
    expect(paddedSubject.attributes.engram_extraction).toEqual(
      subject.attributes.engram_extraction,
    );
    return paddedGraph;
  }

  async function openAndClose(fixture: Awaited<ReturnType<typeof createParent>>) {
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      readResources(),
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') return;
    try {
      expect(Object.keys(result).sort()).toEqual(['kind', 'reader']);
      expect(Reflect.ownKeys(result.reader)).toEqual([]);
      expect(Object.isFrozen(result.reader)).toBe(true);
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(true);
      expect(result).not.toHaveProperty('source');
      expect(result).not.toHaveProperty('receipt');
      expect(result).not.toHaveProperty('proof');
      expect(result).not.toHaveProperty('graph');
      expect(result).not.toHaveProperty('claim');
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    }
    expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(false);
  }

  it('projects receipt and namespace data from the same checked snapshot without another read or index', async () => {
    const fixture = await createParent();
    const foreign = await seedAutonomousPersonalCaptureSubject(fixture.store);
    expect(foreign.request.namespace).not.toBe(fixture.config.namespace);
    const before = await fixture.store.exportGraph(fixture.config.namespace);
    const snapshot = watchSnapshot(fixture.store);
    const indices = watchIndexConstruction();
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      readResources(),
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') return;
    try {
      const graph = getAutonomousPersonalMemoryParentNamespaceGraphV4(fixture.store, result.reader);
      const receipt = getAutonomousPersonalMemoryParentReceiptSummaryV4(
        fixture.store,
        result.reader,
      );
      expect(graph).not.toBeNull();
      expect(receipt).toMatchObject({ version: 4, kind: 'committed', sourceId: fixture.sourceId });
      expect(graph?.group_id).toBe(fixture.config.namespace);
      expect(graph?.entities.some((row) => row.uuid === foreign.binding.subjectId)).toBe(false);
      for (const rows of [graph!.entities, graph!.edges, graph!.episodes]) {
        expect(Object.isFrozen(rows)).toBe(true);
        expect(
          rows.every((row) => row.group_id === fixture.config.namespace && Object.isFrozen(row)),
        ).toBe(true);
      }
      expect(
        graph!.automatic_operations_v1!.operations.every(
          (op) => op.identity.namespace === fixture.config.namespace,
        ),
      ).toBe(true);
      expect(Object.isFrozen(graph)).toBe(true);
      expect(Object.isFrozen(receipt)).toBe(true);
      const ownedRoot = qualifiedClaims.getAutonomousPersonalClaimIndexGraphV4(indices.created[0]);
      for (const episode of graph!.episodes) {
        expect(episode).toBe(ownedRoot.episodes.find((row) => row.uuid === episode.uuid));
      }
      expect(graph!.episodes).toEqual(before.episodes);
      expect(graph!.edges).toEqual(before.edges);
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(getAutonomousPersonalMemoryParentNamespaceGraphV4({}, result.reader)).toBeNull();
      expect(getAutonomousPersonalMemoryParentReceiptSummaryV4({}, result.reader)).toBeNull();
      expect(getAutonomousPersonalMemoryParentNamespaceGraphV4(fixture.store, {})).toBeNull();
      expect(getAutonomousPersonalMemoryParentReceiptSummaryV4(fixture.store, {})).toBeNull();
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    }
    expect(
      getAutonomousPersonalMemoryParentNamespaceGraphV4(fixture.store, result.reader),
    ).toBeNull();
    expect(
      getAutonomousPersonalMemoryParentReceiptSummaryV4(fixture.store, result.reader),
    ).toBeNull();
    const after = await fixture.store.exportGraph(fixture.config.namespace);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.edges).toEqual(before.edges);
    expect(after.entities).toEqual(before.entities);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('keeps accessor cancellation and trusted undefined failures on their original reader work', async () => {
    const fixture = await createParent();
    const controller = new AbortController();
    let failTrusted = false;
    const resources = {
      ...readResources(controller.signal),
      check: () => {
        if (failTrusted) throw undefined;
      },
    };
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      resources,
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') return;
    try {
      failTrusted = true;
      for (const accessor of [
        getAutonomousPersonalMemoryParentNamespaceGraphV4,
        getAutonomousPersonalMemoryParentReceiptSummaryV4,
      ]) {
        let caught = false;
        try {
          accessor(fixture.store, result.reader);
        } catch (error) {
          caught = true;
          expect(error).toBeUndefined();
        }
        expect(caught).toBe(true);
      }
      failTrusted = false;
      let stillCaught = false;
      try {
        getAutonomousPersonalMemoryParentNamespaceGraphV4(fixture.store, result.reader);
      } catch (error) {
        stillCaught = true;
        expect(error).toBeUndefined();
      }
      expect(stillCaught).toBe(true);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    }
    const next = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      readResources(controller.signal),
    );
    expect(next.kind).toBe('reader_ready');
    if (next.kind !== 'reader_ready') return;
    try {
      controller.abort();
      expect(
        getAutonomousPersonalMemoryParentNamespaceGraphV4(fixture.store, next.reader),
      ).toBeNull();
      expect(
        getAutonomousPersonalMemoryParentReceiptSummaryV4(fixture.store, next.reader),
      ).toBeNull();
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, next.reader);
    }
  });

  it('marks a reader not live when its original read scope expires before its work deadline', async () => {
    const fixture = await createParent();
    const now = performance.now();
    const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(now);
    const resources = readResources(new AbortController().signal, now + 30_000);
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      resources,
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') {
      nowSpy.mockRestore();
      return;
    }

    try {
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(true);
      nowSpy.mockReturnValue(now + 5_001);
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(
        false,
      );
      expect(
        getAutonomousPersonalMemoryParentNamespaceGraphV4(fixture.store, result.reader),
      ).toBeNull();
      expect(
        getAutonomousPersonalMemoryParentReceiptSummaryV4(fixture.store, result.reader),
      ).toBeNull();
    } finally {
      try {
        closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
      } catch {
        // Liveness below verifies cleanup even if the expired resource check throws.
      } finally {
        nowSpy.mockRestore();
      }
    }
    expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(false);
  });

  it('does not let mutation of caller work extend the deadline captured at open', async () => {
    const fixture = await createParent();
    const now = performance.now();
    const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(now);
    const resources = readResources(new AbortController().signal, now + 3_000, false);
    const mutableWork = resources.work as unknown as {
      absoluteMonotonicDeadlineMs: number;
      signal: AbortSignal;
    };
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      resources,
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') {
      nowSpy.mockRestore();
      return;
    }

    try {
      mutableWork.absoluteMonotonicDeadlineMs = now + 30_000;
      nowSpy.mockReturnValue(now + 3_500);
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(
        false,
      );
    } finally {
      try {
        closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
      } catch {
        // Liveness below verifies cleanup even if the expired work check throws.
      } finally {
        nowSpy.mockRestore();
      }
    }
  });

  it('keeps trusted-check failure identity sticky for liveness and still closes the reader', async () => {
    const fixture = await createParent();
    const resources = readResources();
    const trustedFailure = new Error('synthetic post-open parent reader resource failure');
    let failCheck = false;
    resources.check.mockImplementation(() => {
      if (failCheck) throw trustedFailure;
    });
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      resources,
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') return;

    failCheck = true;
    let thrown: unknown;
    try {
      isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(trustedFailure);
    let closeFailure: unknown;
    try {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    } catch (error) {
      closeFailure = error;
    }
    expect(closeFailure === undefined || closeFailure === trustedFailure).toBe(true);
    failCheck = false;
    expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(false);
  });

  it('owns original work before snapshot await even when caller work mutates at the read boundary', async () => {
    const fixture = await createParent();
    const originalSignal = new AbortController();
    const replacementSignal = new AbortController();
    const originalDeadline = performance.now() + 30_000;
    const resources = readResources(originalSignal.signal, originalDeadline, false);
    const callerWork = resources.work as unknown as {
      absoluteMonotonicDeadlineMs: number;
      signal: AbortSignal;
    };
    const originalSnapshot = fixture.store.readCompositionalRetrievalSnapshotV3.bind(fixture.store);
    let mutatedDeadline: number | undefined;
    const snapshotSpy = jest
      .spyOn(fixture.store, 'readCompositionalRetrievalSnapshotV3')
      .mockImplementation(async (scope) => {
        const result = await originalSnapshot(scope);
        if (result.status === 'snapshot') {
          mutatedDeadline = performance.now() - 1;
          callerWork.absoluteMonotonicDeadlineMs = mutatedDeadline;
          callerWork.signal = replacementSignal.signal;
        }
        return result;
      });
    let factoryWork: AutonomousPersonalTypedSyntaxWorkV1 | undefined;
    const originalFactory = recordIntegrity.createIntegrityCheckedAutonomousPersonalClaimIndexV4;
    const factorySpy = jest
      .spyOn(recordIntegrity, 'createIntegrityCheckedAutonomousPersonalClaimIndexV4')
      .mockImplementation((graph, work, check) => {
        factoryWork = work;
        return originalFactory(graph, work, check);
      });

    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      resources,
    );

    expect(result.kind).toBe('reader_ready');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(mutatedDeadline).not.toBeUndefined();
    expect(replacementSignal.signal.aborted).toBe(false);
    if (result.kind !== 'reader_ready') return;
    try {
      if (!factoryWork) throw new Error('Expected the checked factory to receive owned work');
      expect(Object.isFrozen(factoryWork)).toBe(true);
      expect(factoryWork.absoluteMonotonicDeadlineMs).toBe(originalDeadline);
      expect(factoryWork.absoluteMonotonicDeadlineMs).not.toBe(mutatedDeadline);
      expect(factoryWork.signal).toBe(originalSignal.signal);
      expect(factoryWork.signal).not.toBe(replacementSignal.signal);

      originalSignal.abort();
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(
        false,
      );
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    }
    expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(false);
  });

  it.each([
    {
      name: 'full-body accepted occurrence',
      profile: 'conservative' as const,
      explicitIntent: false,
      providerMode: 'success' as const,
      receipt: 'human_autonomous_capture_committed' as const,
      sourceMapping: { mode: 'full_body' as const },
    },
    {
      name: 'wrapped application-region accepted occurrence',
      profile: 'conservative' as const,
      explicitIntent: false,
      providerMode: 'success' as const,
      receipt: 'human_autonomous_capture_committed' as const,
      sourceMapping: {
        mode: 'application_region' as const,
        humanRegion: {
          start: 'Speaker 🧭: '.length,
          end: 'Speaker 🧭: '.length + queryText.length,
        },
      },
    },
    {
      name: 'deferred provider receipt',
      profile: 'conservative' as const,
      explicitIntent: false,
      providerMode: 'unavailable' as const,
      receipt: 'human_autonomous_source_deferred_committed' as const,
      sourceMapping: { mode: 'full_body' as const },
    },
    {
      name: 'source-verdict receipt',
      profile: 'explicit' as const,
      explicitIntent: false,
      providerMode: 'unexpected' as const,
      receipt: 'human_autonomous_source_verdict_committed' as const,
      sourceMapping: { mode: 'full_body' as const },
    },
  ])('opens one bounded parent reader for a real $name', async (scenario) => {
    const fixture = await createParent(scenario);
    expect(fixture.operation.terminalReceipt.kind).toBe(scenario.receipt);
    if (fixture.operation.terminalReceipt.kind === 'human_autonomous_source_verdict_committed') {
      expect(fixture.operation.terminalReceipt.selection.kind).toBe('source_verdict');
      expect(fixture.operation.terminalReceipt.acceptedCoverage).toBe('none');
    }
    if (fixture.operation.terminalReceipt.kind === 'human_autonomous_source_deferred_committed') {
      expect(fixture.operation.terminalReceipt.selection.kind).toBe('source_only_deferred');
      expect(fixture.operation.terminalReceipt.acceptedCoverage).toBe('none');
    }
    const snapshot = watchSnapshot(fixture.store);
    const indices = watchIndexConstruction();
    try {
      await openAndClose(fixture);
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(snapshot.actual?.status).toBe('snapshot');
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(indices.created).toHaveLength(1);
      if (scenario.receipt !== 'human_autonomous_capture_committed') {
        expect(fixture.operation.terminalReceipt.kind).not.toBe(
          'human_autonomous_capture_committed',
        );
      }
    } finally {
      if (indices.created.length === 1) {
        // Each branch's index is checked and belongs to the exact snapshot read above.
        expect(indices.created[0]).toBeDefined();
      }
    }
  });

  it('rejects locator/config mismatches and reads only for the source-bound query check', async () => {
    const fixture = await createParent();
    const other = await createParent({ humanQuery: 'I like spacious rooms.' });
    const owner = store;
    const snapshot = watchSnapshot(owner);

    const malformedConfig = Object.freeze({ ...fixture.config, unexpected: true });
    const attempts: Array<
      [
        string,
        unknown,
        unknown,
        'invalid_lineage' | 'invalid_configuration' | 'parent_mismatch' | 'authority_changed',
      ]
    > = [
      ['fake lineage', Object.freeze(Object.create(null)), fixture.config, 'invalid_lineage'],
      [
        'copied lineage',
        Object.freeze({ ...(fixture.lineage as object) }),
        fixture.config,
        'invalid_lineage',
      ],
      ['foreign lineage', other.lineage, fixture.config, 'parent_mismatch'],
      ['malformed config', fixture.lineage, malformedConfig, 'invalid_configuration'],
      [
        'store locator',
        fixture.lineage,
        { ...fixture.config, storeHash: 'a'.repeat(64) },
        'parent_mismatch',
      ],
      [
        'execution tuple',
        fixture.lineage,
        {
          ...fixture.config,
          native: {
            ...fixture.config.native,
            execution: `${fixture.config.native.execution}:other`,
          },
        },
        'parent_mismatch',
      ],
      [
        'instance tuple',
        fixture.lineage,
        { ...fixture.config, native: { ...fixture.config.native, instance: 'instance:other' } },
        'parent_mismatch',
      ],
      [
        'workflow tuple',
        fixture.lineage,
        { ...fixture.config, native: { ...fixture.config.native, workflow: 'workflow:other' } },
        'parent_mismatch',
      ],
      [
        'source locator',
        fixture.lineage,
        { ...fixture.config, sourceId: randomUUID() },
        'parent_mismatch',
      ],
      [
        'namespace locator',
        fixture.lineage,
        { ...fixture.config, namespace: `${fixture.config.namespace}:other` },
        'parent_mismatch',
      ],
      [
        'issuer locator',
        fixture.lineage,
        { ...fixture.config, issuer: `${fixture.config.issuer}:other` },
        'parent_mismatch',
      ],
      [
        'actor locator',
        fixture.lineage,
        { ...fixture.config, actorReference: `${fixture.config.actorReference}:other` },
        'parent_mismatch',
      ],
      [
        'turn locator',
        fixture.lineage,
        { ...fixture.config, turn: `${fixture.config.turn}:other` },
        'parent_mismatch',
      ],
      [
        'current query',
        fixture.lineage,
        { ...fixture.config, currentHumanQuery: 'I prefer different explanations.' },
        'parent_mismatch',
      ],
      [
        'provider route',
        fixture.lineage,
        {
          ...fixture.config,
          providerReference: { ...fixture.config.providerReference, routeId: 'route:other' },
        },
        'authority_changed',
      ],
    ];

    let expectedSnapshotReads = 0;
    for (const [name, lineage, config, reason] of attempts) {
      const readsBefore = snapshot.spy.mock.calls.length;
      const result = await openAutonomousPersonalMemoryParentReaderV4(
        owner,
        lineage as PrivateAutonomousPersonalMemoryLineageV4,
        config as typeof fixture.config,
        readResources(),
      );
      expectRejected(owner, result, reason);
      const expectedReads = name === 'current query' ? 1 : 0;
      expectedSnapshotReads += expectedReads;
      expect(snapshot.spy).toHaveBeenCalledTimes(readsBefore + expectedReads);
    }
    expect(snapshot.spy).toHaveBeenCalledTimes(expectedSnapshotReads);
  }, 30_000);

  it('rejects when the storage lacks the bounded snapshot capability', async () => {
    const fixture = await createParent();
    const owner = store;
    const unavailable = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === 'readCompositionalRetrievalSnapshotV3') return undefined;
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await openAutonomousPersonalMemoryParentReaderV4(
      unavailable,
      fixture.lineage,
      fixture.config,
      readResources(),
    );

    expectRejected(owner, result, 'unsupported_mode');
  });

  it('keeps a committed parent valid after the original capture window has elapsed', async () => {
    const fixture = await createParent();
    const snapshot = watchSnapshot(fixture.store);
    const dayLater = Date.now() + 24 * 60 * 60 * 1000;
    jest.useFakeTimers({ doNotFake: ['performance', 'nextTick', 'queueMicrotask'] });
    jest.setSystemTime(dayLater);
    try {
      await openAndClose(fixture);
      expect(snapshot.actual?.status).toBe('snapshot');
      if (snapshot.actual?.status === 'snapshot') {
        expect(Date.parse(snapshot.actual.backendNow)).toBeGreaterThan(dayLater - 1000);
        expect(Date.parse(snapshot.actual.backendNow)).toBeGreaterThan(
          Date.parse(fixture.operation.terminalReceipt.terminalAt),
        );
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['source-review', 'source-trust', 'binding-revocation'] as const)(
    'rejects changed current authority for %s after reading the parent snapshot',
    async (axis) => {
      const fixture = await createParent();
      if (axis === 'source-review') {
        await fixture.store.updateEpisode(fixture.sourceId, { review_status: 'rejected' });
      } else if (axis === 'source-trust') {
        await fixture.store.updateEpisode(fixture.sourceId, { trust_level: 'untrusted' });
      } else {
        const result = await fixture.store.automaticBindingCommand!({
          action: 'revoke',
          namespace: seed.request.namespace,
          bindingId: seed.binding.bindingId,
          expectedRevision: seed.binding.revision,
          authorizedBy: 'synthetic-parent-reader-test',
          reason: 'Exercise current parent binding authority',
        });
        expect(result.state).toBe('revoked');
      }
      const snapshot = watchSnapshot(fixture.store);
      const result = await openAutonomousPersonalMemoryParentReaderV4(
        fixture.store,
        fixture.lineage,
        fixture.config,
        readResources(),
      );

      expectRejected(fixture.store, result, 'authority_changed');
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['source-content', 'invalid_snapshot'],
    ['duplicate-source', 'invalid_snapshot'],
    ['missing-source', 'invalid_snapshot'],
    ['duplicate-operation', 'invalid_snapshot'],
    ['attempt-hash', 'parent_mismatch'],
    ['completion-hash', 'parent_mismatch'],
    ['receipt-time', 'parent_mismatch'],
  ] as const)('rejects a test-only detached snapshot tamper on %s', async (tamper, reason) => {
    const fixture =
      tamper === 'receipt-time'
        ? await createParent({ profile: 'explicit', providerMode: 'unexpected' })
        : await createParent();
    const original = fixture.store.readCompositionalRetrievalSnapshotV3.bind(fixture.store);
    const snapshotSpy = jest
      .spyOn(fixture.store, 'readCompositionalRetrievalSnapshotV3')
      .mockImplementation(async (scope) => {
        const result = await original(scope);
        if (result.status !== 'snapshot') return result;
        // Test-only detached transport mutation; no Graphology persistence is changed here.
        const graph = structuredClone(result.graph) as unknown as GraphData;
        let backendNow = result.backendNow;
        const source = graph.episodes.find((episode) => episode.uuid === fixture.sourceId);
        if (!source) throw new Error('Expected source row in detached snapshot');
        if (tamper === 'source-content') source.content = `${source.content} altered`;
        if (tamper === 'duplicate-source') graph.episodes.push(structuredClone(source));
        if (tamper === 'missing-source') {
          graph.episodes = graph.episodes.filter((episode) => episode.uuid !== fixture.sourceId);
        }
        if (tamper === 'duplicate-operation') {
          const operations = graph.automatic_operations_v1?.operations;
          const operation = operations?.find(
            (item) => item.operationId === fixture.operation.operationId,
          );
          if (!operations || !operation) throw new Error('Expected parent operation in snapshot');
          operations.push(structuredClone(operation));
        }
        if (
          tamper === 'attempt-hash' ||
          tamper === 'completion-hash' ||
          tamper === 'receipt-time'
        ) {
          const operation = graph.automatic_operations_v1?.operations.find(
            (item) => item.operationId === fixture.operation.operationId,
          );
          if (!operation || operation.version !== 4 || operation.state !== 'committed') {
            throw new Error('Expected committed parent operation in snapshot');
          }
          if (tamper === 'attempt-hash') {
            operation.attempts[0]!.attemptHash = 'b'.repeat(64);
          } else if (tamper === 'completion-hash') {
            operation.completionCallHash = 'c'.repeat(64);
          } else {
            const changedTime = new Date(
              Date.parse(operation.terminalReceipt.terminalAt) + 1_000,
            ).toISOString();
            operation.terminalReceipt.terminalAt = changedTime;
            operation.lastObservedAt = changedTime;
            const committedAttempt = operation.attempts.find(
              (attempt) => attempt.disposition === 'committed',
            );
            if (!committedAttempt) throw new Error('Expected committed completion attempt');
            committedAttempt.at = changedTime;
            backendNow = new Date(Date.parse(changedTime) + 1_000).toISOString();
          }
        }
        return { ...result, backendNow, graph } as CompositionalRetrievalSnapshotResultV3;
      });
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      readResources(),
    );

    expectRejected(fixture.store, result, reason);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('returns parent_not_found for a valid bound graph without a parent source or operation', async () => {
    const fixture = await createParent();
    const original = fixture.store.readCompositionalRetrievalSnapshotV3.bind(fixture.store);
    const snapshotSpy = jest
      .spyOn(fixture.store, 'readCompositionalRetrievalSnapshotV3')
      .mockImplementation(async (scope) => {
        const result = await original(scope);
        if (result.status !== 'snapshot') return result;
        // Test-only detached graph keeps the actual reviewed subject/binding and removes the
        // complete parent family; no persistent Graphology rows are changed.
        const graph = structuredClone(result.graph) as unknown as GraphData;
        graph.entities = graph.entities.filter((entity) => entity.uuid === seed.subject.uuid);
        graph.edges = [];
        graph.episodes = [];
        graph.automatic_operations_v1 = { version: 1, operations: [] };
        return { ...result, graph } as CompositionalRetrievalSnapshotResultV3;
      });

    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      readResources(),
    );

    expectRejected(fixture.store, result, 'parent_not_found');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a backend clock earlier than the committed parent operation', async () => {
    const fixture = await createParent();
    const original = fixture.store.readCompositionalRetrievalSnapshotV3.bind(fixture.store);
    const snapshotSpy = jest
      .spyOn(fixture.store, 'readCompositionalRetrievalSnapshotV3')
      .mockImplementation(async (scope) => {
        const result = await original(scope);
        if (result.status !== 'snapshot') return result;
        const beforeTerminal = new Date(
          Date.parse(fixture.operation.terminalReceipt.terminalAt) - 1_000,
        ).toISOString();
        return { ...result, backendNow: beforeTerminal } as CompositionalRetrievalSnapshotResultV3;
      });

    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      readResources(),
    );

    expectRejected(fixture.store, result, 'clock_regression');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves a trusted resource-check error raised after the actual snapshot read', async () => {
    const fixture = await createParent();
    const snapshot = watchSnapshot(fixture.store);
    const trustedFailure = new Error('synthetic post-snapshot resource check failure');
    await expect(
      openAutonomousPersonalMemoryParentReaderV4(fixture.store, fixture.lineage, fixture.config, {
        ...readResources(),
        check: () => {
          if (snapshot.spy.mock.calls.length > 0) throw trustedFailure;
        },
      }),
    ).rejects.toBe(trustedFailure);
    expect(snapshot.spy).toHaveBeenCalledTimes(1);
  });

  it('reuses the same actual B1b index to qualify an older accepted fact under a new no-claim parent', async () => {
    const earlier = await createParent();
    expect(earlier.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
    const later = await createParent({
      profile: 'explicit',
      explicitIntent: false,
      providerMode: 'unexpected',
    });
    expect(later.operation.terminalReceipt.kind).toBe('human_autonomous_source_verdict_committed');
    if (later.operation.terminalReceipt.kind === 'human_autonomous_source_verdict_committed') {
      expect(later.operation.terminalReceipt.selection.kind).toBe('source_verdict');
      expect(later.operation.terminalReceipt.acceptedCoverage).toBe('none');
    }
    const priorReceipt = earlier.operation.terminalReceipt;
    if (
      priorReceipt.kind !== 'human_autonomous_capture_committed' ||
      priorReceipt.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected an actual earlier committed occurrence');
    }
    const created = priorReceipt.selection.items.find(
      (item) => item.effect === 'created' && item.claimId !== null,
    );
    if (!created?.claimId) throw new Error('Expected the earlier accepted Claim3 ID');

    const snapshot = watchSnapshot(later.store);
    const indices = watchIndexConstruction();
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      later.store,
      later.lineage,
      later.config,
      readResources(),
    );
    expect(result.kind).toBe('reader_ready');
    expect(snapshot.spy).toHaveBeenCalledTimes(1);
    expect(snapshot.actual?.status).toBe('snapshot');
    expect(indices.spy).toHaveBeenCalledTimes(1);
    expect(indices.created).toHaveLength(1);
    if (result.kind !== 'reader_ready') return;
    try {
      const actualSnapshot = snapshot.actual;
      const index = indices.created[0];
      if (!actualSnapshot || actualSnapshot.status !== 'snapshot' || !index) {
        throw new Error('Expected captured snapshot and its checked B1b index');
      }
      const qualified = qualifiedClaims.qualifyAutonomousPersonalClaimCreatorV4(index, {
        storeHash: earlier.operation.identity.storeHash,
        namespace: earlier.operation.identity.namespace,
        edgeId: created.claimId,
        backendNow: actualSnapshot.backendNow,
      });
      expect(qualified).toMatchObject({
        status: 'qualified',
        proof: {
          claimId: created.claimId,
          sourceId: earlier.operation.identity.sourceId,
          operationId: earlier.operation.operationId,
        },
      });
      expect(qualified).not.toMatchObject({
        proof: {
          sourceId: later.operation.identity.sourceId,
          operationId: later.operation.operationId,
        },
      });
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(later.store, result.reader)).toBe(true);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(later.store, result.reader);
    }
  }, 30_000);

  it('returns compact DATA for both the current accepted claim and that claim under a later parent', async () => {
    const earlier = await createParent();
    const claimId = createdClaimId(earlier.operation);
    const snapshot = watchSnapshot(earlier.store);
    const indices = watchIndexConstruction();
    const currentResources = readResources();
    const currentReader = await openAutonomousPersonalMemoryParentReaderV4(
      earlier.store,
      earlier.lineage,
      earlier.config,
      currentResources,
    );
    expect(currentReader.kind).toBe('reader_ready');
    if (currentReader.kind !== 'reader_ready') return;

    let currentCandidate: AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data;
    try {
      const graph = getAutonomousPersonalMemoryParentNamespaceGraphV4(
        earlier.store,
        currentReader.reader,
      );
      expect(graph).not.toBeNull();
      if (!graph) throw new Error('Expected current namespace graph');
      const beforeBytes = getAutomaticClaimReadScopeRemaining(
        currentResources.scope,
      )!.contextBytesRemaining;
      currentCandidate = candidateOrThrow(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          earlier.store,
          currentReader.reader,
          claimId,
        ),
      );
      const compactBytes = Buffer.byteLength(JSON.stringify(currentCandidate), 'utf8');
      expect(
        getAutomaticClaimReadScopeRemaining(currentResources.scope)!.contextBytesRemaining,
      ).toBe(beforeBytes - compactBytes);
      expect(
        AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(
          currentCandidate,
        ).success,
      ).toBe(true);
      expectDeepFrozen(currentCandidate);
      expect(currentCandidate.proof.claimId).toBe(claimId);
      expect(currentCandidate.proof.sourceId).toBe(earlier.operation.identity.sourceId);
      expect(currentCandidate.proof.operationId).toBe(earlier.operation.operationId);
      expect(currentCandidate.proof.sourceId).toBe(earlier.config.sourceId);
      expect(currentCandidate.terminalAt).toBe(earlier.operation.terminalReceipt.terminalAt);
      expect(currentCandidate.terminalAt).not.toBe(earlier.operation.createdAt);
      expect(currentCandidate.kind).toBe('typed_preference');
      const candidateEdge = graph.edges.find((row) => row.uuid === claimId);
      expect(candidateEdge).toBeDefined();
      const claim = candidateEdge?.attributes.engram_claim_v1 as { meaning: unknown } | undefined;
      expect(claim).toBeDefined();
      if (currentCandidate.kind === 'typed_preference') {
        expect(currentCandidate.meaning).toEqual(claim?.meaning);
        expect(currentCandidate.meaning).toHaveProperty('bundles.0.rootPaths');
        expect(currentCandidate.meaning).toHaveProperty('bundles.0.nodes');
        expect(currentCandidate.meaning).toHaveProperty('bundles.0.edges');
      }
      const subject = graph.entities.find((row) => row.uuid === candidateEdge?.source_node_uuid);
      const value = graph.entities.find((row) => row.uuid === candidateEdge?.target_node_uuid);
      expect(subject).toBeDefined();
      expect(value).toBeDefined();
      expect(currentCandidate.rowHash).toBe(
        hashAutomaticCaptureV2({ edge: candidateEdge, subject, value }),
      );
      expect(currentCandidate.source).toMatchObject({
        sourceMessageId: earlier.source.source_message_id,
        conversationId: earlier.source.conversation_id,
        senderId: earlier.source.sender_id,
        senderName: earlier.source.sender_name,
        episodeKind: earlier.source.episode_kind,
        trustLevel: earlier.source.trust_level,
        reviewStatus: 'accepted',
        referenceTime: earlier.source.reference_time,
        sourceWorkflowId: earlier.source.source_workflow_id,
        sourceExecutionId: earlier.source.source_execution_id,
      });
      expect(currentCandidate.source).not.toHaveProperty('content');
      expect(currentCandidate.source).not.toHaveProperty('attributes');
      expect(currentCandidate).not.toHaveProperty('receipt');
      expect(currentCandidate).not.toHaveProperty('operation');
      expect(currentCandidate).not.toHaveProperty('descriptor');
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(indices.created).toHaveLength(1);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(earlier.store, currentReader.reader);
      indices.spy.mockRestore();
      snapshot.spy.mockRestore();
    }

    const later = await createParent({
      profile: 'explicit',
      explicitIntent: false,
      providerMode: 'unexpected',
    });
    expect(later.operation.terminalReceipt.kind).toBe('human_autonomous_source_verdict_committed');
    const laterSnapshot = watchSnapshot(later.store);
    const laterIndices = watchIndexConstruction();
    const laterResources = readResources();
    const laterReader = await openAutonomousPersonalMemoryParentReaderV4(
      later.store,
      later.lineage,
      later.config,
      laterResources,
    );
    expect(laterReader.kind).toBe('reader_ready');
    if (laterReader.kind !== 'reader_ready') return;
    try {
      const bytesBeforeSecondProjection = getAutomaticClaimReadScopeRemaining(
        laterResources.scope,
      )!.contextBytesRemaining;
      const historical = candidateOrThrow(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          later.store,
          laterReader.reader,
          claimId,
        ),
      );
      const compactBytes = Buffer.byteLength(JSON.stringify(historical), 'utf8');
      expect(getAutomaticClaimReadScopeRemaining(laterResources.scope)!.contextBytesRemaining).toBe(
        bytesBeforeSecondProjection - compactBytes,
      );
      expect(historical.proof.sourceId).toBe(earlier.operation.identity.sourceId);
      expect(historical.proof.operationId).toBe(earlier.operation.operationId);
      expect(historical.proof.sourceId).not.toBe(later.operation.identity.sourceId);
      expect(historical.proof.operationId).not.toBe(later.operation.operationId);
      expect(historical.terminalAt).toBe(earlier.operation.terminalReceipt.terminalAt);
      expect(historical.terminalAt).not.toBe(historical.proof.createdAt);
      expect(laterSnapshot.spy).toHaveBeenCalledTimes(1);
      expect(laterIndices.spy).toHaveBeenCalledTimes(1);
      expect(laterIndices.created).toHaveLength(1);
      expect(
        AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(historical)
          .success,
      ).toBe(true);

      const beforeSecondCharge = getAutomaticClaimReadScopeRemaining(
        laterResources.scope,
      )!.contextBytesRemaining;
      const repeated = candidateOrThrow(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          later.store,
          laterReader.reader,
          claimId,
        ),
      );
      expect(repeated).toEqual(historical);
      expect(getAutomaticClaimReadScopeRemaining(laterResources.scope)!.contextBytesRemaining).toBe(
        beforeSecondCharge - compactBytes,
      );

      const remaining = getAutomaticClaimReadScopeRemaining(laterResources.scope)!;
      expect(
        chargeAutomaticClaimContextBytes(
          laterResources.scope,
          remaining.contextBytesRemaining - compactBytes + 1,
        ),
      ).toBe(true);
      const bytesBeforeDecline = getAutomaticClaimReadScopeRemaining(
        laterResources.scope,
      )!.contextBytesRemaining;
      expect(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          later.store,
          laterReader.reader,
          claimId,
        ),
      ).toBeNull();
      expect(getAutomaticClaimReadScopeRemaining(laterResources.scope)!.contextBytesRemaining).toBe(
        bytesBeforeDecline,
      );
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(later.store, laterReader.reader)).toBe(
        false,
      );
      expect(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          later.store,
          laterReader.reader,
          claimId,
        ),
      ).toBeNull();
      expect(laterSnapshot.spy).toHaveBeenCalledTimes(1);
      expect(laterIndices.spy).toHaveBeenCalledTimes(1);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(later.store, laterReader.reader);
    }
  }, 30_000);

  it('preserves the exact dated statement branch for an older accepted source statement', async () => {
    const earlier = await createParent({
      humanQuery: 'I work as a ceramicist.',
      providerCategory: 'work_role',
    });
    const claimId = createdClaimId(earlier.operation);
    const later = await createParent({
      profile: 'explicit',
      explicitIntent: false,
      providerMode: 'unexpected',
    });
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      later.store,
      later.lineage,
      later.config,
      readResources(),
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') return;
    try {
      const candidate = candidateOrThrow(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          later.store,
          result.reader,
          claimId,
        ),
      );
      expect(candidate.kind).toBe('source_statement_record');
      if (candidate.kind === 'source_statement_record') {
        expect(candidate.statementLiteral).toBe('I work as a ceramicist.');
        expect(candidate.sourceEventTime).toBe(candidate.proof.sourceEventTime);
        expect(candidate.sourceEventTime).toBe(earlier.source.reference_time);
      }
      expect(candidate.proof.sourceId).toBe(earlier.operation.identity.sourceId);
      expect(candidate.proof.operationId).toBe(earlier.operation.operationId);
      expect(candidate.source).not.toHaveProperty('content');
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(later.store, result.reader);
    }
  }, 30_000);

  it('hides actual foreign-subject and proposed candidates under the current reader', async () => {
    const foreignSeed = await seedAutonomousPersonalCaptureSubject(store);
    const foreign = await createParent({
      seed: foreignSeed,
      humanQuery: 'I prefer clear meeting notes.',
    });
    const foreignClaimId = createdClaimId(foreign.operation);

    const proposed = await createParent({
      profile: 'reviewFirst',
      humanQuery: 'I prefer practical examples.',
    });
    const proposedClaimId = createdClaimId(proposed.operation);
    const proposedReceipt = proposed.operation.terminalReceipt;
    if (
      proposedReceipt.kind !== 'human_autonomous_capture_committed' ||
      proposedReceipt.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected the proposed current Claim3 receipt');
    }
    expect(
      proposedReceipt.selection.items.find((item) => item.claimId === proposedClaimId)?.state,
    ).toBe('proposed');

    const current = await createParent({
      profile: 'explicit',
      explicitIntent: false,
      providerMode: 'unexpected',
    });
    const before = await current.store.exportGraph();
    const snapshot = watchSnapshot(current.store);
    const indices = watchIndexConstruction();
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      current.store,
      current.lineage,
      current.config,
      readResources(),
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') return;
    try {
      expect(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          current.store,
          result.reader,
          foreignClaimId,
        ),
      ).toBeNull();
      expect(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          current.store,
          result.reader,
          proposedClaimId,
        ),
      ).toBeNull();
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(current.store, result.reader)).toBe(true);
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(indices.created).toHaveLength(1);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(current.store, result.reader);
    }
    expect(persistedGraphData(await current.store.exportGraph())).toEqual(
      persistedGraphData(before),
    );
  }, 30_000);

  it('counts missing and malformed candidate IDs toward 200 and stops before observing the 201st input', async () => {
    const fixture = await createParent();
    const resources = readResources();
    const snapshot = watchSnapshot(fixture.store);
    const indices = watchIndexConstruction();
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      resources,
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') return;
    try {
      for (let index = 0; index < 100; index += 1) {
        expect(
          readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
            fixture.store,
            result.reader,
            randomUUID(),
          ),
        ).toBeNull();
      }
      for (let index = 0; index < 100; index += 1) {
        expect(
          readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
            fixture.store,
            result.reader,
            `malformed-${index}`,
          ),
        ).toBeNull();
      }
      const checksBeforeOverflow = resources.check.mock.calls.length;
      let observed = 0;
      const hostile = new Proxy(
        {},
        {
          get() {
            observed += 1;
            throw new Error('overflow_candidate_get_trap');
          },
          ownKeys() {
            observed += 1;
            throw new Error('overflow_candidate_keys_trap');
          },
          getOwnPropertyDescriptor() {
            observed += 1;
            throw new Error('overflow_candidate_descriptor_trap');
          },
        },
      );
      expect(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          fixture.store,
          result.reader,
          hostile,
        ),
      ).toBeNull();
      expect(observed).toBe(0);
      expect(resources.check).toHaveBeenCalledTimes(checksBeforeOverflow + 1);
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(indices.created).toHaveLength(1);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    }
  }, 30_000);

  it('accepts an exact 512 KiB candidate preimage and fails closed one byte above it', async () => {
    const fixture = await createParent();
    const claimId = createdClaimId(fixture.operation);
    const atCapGraph = await setActualCandidateTripleBytes(fixture, claimId, 512 * 1024);

    const snapshot = watchSnapshot(fixture.store);
    const indices = watchIndexConstruction();
    const exactResources = readResources();
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      exactResources,
    );
    expect(result.kind).toBe('reader_ready');
    if (result.kind !== 'reader_ready') return;
    try {
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(true);
      const bytesBefore = getAutomaticClaimReadScopeRemaining(
        exactResources.scope,
      )!.contextBytesRemaining;
      const candidate = candidateOrThrow(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          fixture.store,
          result.reader,
          claimId,
        ),
      );
      expect(candidate.proof.claimId).toBe(claimId);
      const compactBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
      expect(getAutomaticClaimReadScopeRemaining(exactResources.scope)!.contextBytesRemaining).toBe(
        bytesBefore - compactBytes,
      );
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    }
    expect(persistedGraphData(await fixture.store.exportGraph(fixture.config.namespace))).toEqual(
      persistedGraphData(atCapGraph),
    );

    const overCapGraph = await setActualCandidateTripleBytes(fixture, claimId, 512 * 1024 + 1);
    const overResources = readResources();
    const overReader = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      overResources,
    );
    expect(overReader.kind).toBe('reader_ready');
    if (overReader.kind !== 'reader_ready') return;
    try {
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, overReader.reader)).toBe(
        true,
      );
      expect(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          fixture.store,
          overReader.reader,
          claimId,
        ),
      ).toBeNull();
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, overReader.reader)).toBe(
        false,
      );
    } finally {
      try {
        closeAutonomousPersonalMemoryParentReaderV4(fixture.store, overReader.reader);
      } catch {
        // Resource exhaustion may be the reader's sticky terminal condition.
      }
    }
    expect(snapshot.spy).toHaveBeenCalledTimes(2);
    expect(indices.spy).toHaveBeenCalledTimes(2);
    expect(indices.created).toHaveLength(2);
    expect(persistedGraphData(await fixture.store.exportGraph(fixture.config.namespace))).toEqual(
      persistedGraphData(overCapGraph),
    );
  }, 30_000);

  it('returns no candidate after abort/deadline and preserves trusted undefined failure without rereads', async () => {
    const fixture = await createParent();
    const claimId = createdClaimId(fixture.operation);
    const snapshot = watchSnapshot(fixture.store);
    const indices = watchIndexConstruction();
    const controller = new AbortController();
    const abortedResources = readResources(controller.signal);
    const abortedReader = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      abortedResources,
    );
    expect(abortedReader.kind).toBe('reader_ready');
    if (abortedReader.kind !== 'reader_ready') return;
    try {
      controller.abort();
      expect(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          fixture.store,
          abortedReader.reader,
          claimId,
        ),
      ).toBeNull();
      expect(
        isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, abortedReader.reader),
      ).toBe(false);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, abortedReader.reader);
    }

    const now = performance.now();
    const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(now);
    const deadlineResources = readResources(new AbortController().signal, now + 1_000);
    const deadlineReader = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      deadlineResources,
    );
    expect(deadlineReader.kind).toBe('reader_ready');
    if (deadlineReader.kind !== 'reader_ready') {
      nowSpy.mockRestore();
      return;
    }
    try {
      nowSpy.mockReturnValue(now + 1_001);
      expect(
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          fixture.store,
          deadlineReader.reader,
          claimId,
        ),
      ).toBeNull();
    } finally {
      try {
        closeAutonomousPersonalMemoryParentReaderV4(fixture.store, deadlineReader.reader);
      } catch {
        // Expired work may make close rethrow its sticky typed budget result.
      } finally {
        nowSpy.mockRestore();
      }
    }

    let failTrusted = false;
    const trustedResources = readResources();
    trustedResources.check.mockImplementation(() => {
      if (failTrusted) throw undefined;
    });
    const trustedReader = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      trustedResources,
    );
    expect(trustedReader.kind).toBe('reader_ready');
    if (trustedReader.kind !== 'reader_ready') return;
    try {
      failTrusted = true;
      let caughtFirst = false;
      try {
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          fixture.store,
          trustedReader.reader,
          claimId,
        );
      } catch (error) {
        caughtFirst = true;
        expect(error).toBeUndefined();
      }
      expect(caughtFirst).toBe(true);
      failTrusted = false;
      let caughtSticky = false;
      try {
        readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
          fixture.store,
          trustedReader.reader,
          claimId,
        );
      } catch (error) {
        caughtSticky = true;
        expect(error).toBeUndefined();
      }
      expect(caughtSticky).toBe(true);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, trustedReader.reader);
    }
    expect(snapshot.spy).toHaveBeenCalledTimes(3);
    expect(indices.spy).toHaveBeenCalledTimes(3);
    expect(indices.created).toHaveLength(3);
  }, 30_000);

  it('rejects expired pending handoff, aborted work, expired scope, and trusted check failure before storage I/O', async () => {
    const pending = await createParent({ leaveHandoffPending: true });
    const fixture = await createParent();
    const snapshot = watchSnapshot(store);

    // A genuine pending handoff expires before the Memory context consumes it.
    const expiryBase = performance.now();
    const ttl = jest.spyOn(performance, 'now').mockReturnValue(expiryBase + 10 * 60 * 1000 + 1);
    try {
      const expiredLineage = consumeAutonomousPersonalMemoryHandoffV4(
        pending.memoryContext,
        pending.config.storeHash,
        pending.config.namespace,
        pending.config.issuer,
        pending.config.actorReference,
        pending.config.turn,
        pending.config.sourceId,
      );
      expect(expiredLineage).toBeNull();
      const expiredLineageResult = await openAutonomousPersonalMemoryParentReaderV4(
        store,
        expiredLineage as unknown as PrivateAutonomousPersonalMemoryLineageV4,
        pending.config,
        readResources(),
      );
      expectRejected(store, expiredLineageResult, 'invalid_lineage');
    } finally {
      ttl.mockRestore();
    }

    const aborted = new AbortController();
    aborted.abort();
    const abortedResult = await openAutonomousPersonalMemoryParentReaderV4(
      store,
      fixture.lineage,
      fixture.config,
      readResources(aborted.signal),
    );
    expectRejected(store, abortedResult, 'budget_exhausted');

    const expired = readResources();
    const now = performance.now();
    const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(now + 5_001);
    try {
      const expiredResult = await openAutonomousPersonalMemoryParentReaderV4(
        store,
        fixture.lineage,
        fixture.config,
        expired,
      );
      expectRejected(store, expiredResult, 'budget_exhausted');
    } finally {
      nowSpy.mockRestore();
    }

    const trustedFailure = new Error('synthetic trusted parent check failure');
    await expect(
      openAutonomousPersonalMemoryParentReaderV4(store, fixture.lineage, fixture.config, {
        ...readResources(),
        check: () => {
          throw trustedFailure;
        },
      }),
    ).rejects.toBe(trustedFailure);
    expect(snapshot.spy).not.toHaveBeenCalled();
  }, 30_000);
});
