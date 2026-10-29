import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { EdgeSearchResult, IGraphStorage } from '../../src/storage/IGraphStorage';
import * as recordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import * as compositionalIndex from '../../src/extraction/CompositionalSnapshotIndexV3';
import * as retrievalFactory from '../../src/search/CompositionalRetrievalSessionV3';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { AutomaticCaptureBeginRequestV2Schema } from '../../src/schemas/AutomaticCapture.schema';
import { captureCompositionalHumanMemoryV3 } from '../../src/memory/CompositionalHumanCaptureV3';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import { planAutomaticClaims } from '../../src/extraction/AutomaticClaims';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  publishAutonomousPersonalMemoryHandoffV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import {
  closeAutonomousPersonalMemoryParentReaderV4,
  openAutonomousPersonalMemoryParentReaderV4,
  readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4,
  type PrivateAutonomousPersonalMemoryParentReaderV4,
} from '../../src/memory/AutonomousPersonalMemoryParentReaderV4';
import { readAutonomousPersonalNativeMemoryConfigV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import {
  autonomousPersonalMemoryContextV4,
  autonomousPersonalMemoryStoreHashV4,
  type AutonomousPersonalMemoryContextOptionsV4,
} from '../helpers/autonomousPersonalMemoryBackend';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import {
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  type AutomaticClaimReadScope,
} from '../../src/storage/AutomaticClaimReadScope';
import type { SourceHydrationBudget } from '../../src/schemas/ExtractionPolicy.schema';
import {
  getCompositionalRuntimeNamespaceDataV3,
  getCompositionalRuntimeAutomaticReadContextV3,
  isCompositionalCompatibilityRuntimeReaderV4,
  isLiveCompositionalRuntimeReaderV3,
  loadCompositionalRuntimeReaderV3,
  loadCompositionalCompatibilityRuntimeReaderV4,
  readCompositionalRuntimeFactsV3,
  readCompositionalRuntimeLiteralContextV3,
} from '../../src/search/CompositionalRuntimeReaderV3';
import { RetrievalGovernance } from '../../src/search/RetrievalGovernance';
import { getAutonomousPersonalRuntimeDisplayV4 } from '../../src/search/AutonomousPersonalRuntimeSearchV4';
import { GraphDataSchema, type GraphData } from '../../src/schemas/GraphData.schema';

type Fixture = {
  readonly store: GraphologyStorage;
  readonly directory: string;
  readonly path: string;
  readonly seed: AutonomousPersonalCaptureSeed;
  readonly config: Awaited<ReturnType<typeof readAutonomousPersonalNativeMemoryConfigV4>>;
  readonly lineage: NonNullable<ReturnType<typeof consumeAutonomousPersonalMemoryHandoffV4>>;
  readonly oldV1EdgeId: string;
  readonly oldV3EdgeId: string;
  readonly generalEdgeId: string;
  readonly claim3EdgeId: string | null;
  readonly claim3SourceId: string | null;
  readonly currentSourceId: string;
};

type ReadResources = {
  readonly budget: SourceHydrationBudget;
  readonly scope: AutomaticClaimReadScope;
  readonly check: () => void;
};

let openedStore: GraphologyStorage | undefined;
let openedDirectory: string | undefined;

async function createFixture(includeClaim3 = false): Promise<Fixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-memory-legacy-compatibility-'));
  const workflowId = `memory-legacy-${randomUUID()}`;
  const path = join(directory, `${workflowId}-engram.json`);
  let store = new GraphologyStorage(path);
  await store.initialize();
  openedStore = store;
  openedDirectory = directory;
  const seed = await seedAutonomousPersonalCaptureSubject(store);
  const namespace = seed.request.namespace;

  // Create genuine legacy Source3/Claim2 rows through the existing V3 coordinator.
  const oldV3Request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
    ...seed.request,
    version: 3,
    preferenceInterpreter: 'compositionalV2',
    turn: `legacy-source3-${randomUUID()}`,
    attemptIdHash: 'b'.repeat(64),
    settings: { ...seed.request.settings, profileId: 'conservative' },
    source: {
      ...seed.request.source,
      content:
        'I prefer explanations in plain Australian English, with one worked example before technical terms.',
    },
  });
  const oldV3Result = await captureCompositionalHumanMemoryV3(store, oldV3Request);
  if (!oldV3Result.should_process || !oldV3Result.sourceId)
    throw new Error(
      `Expected a genuine committed legacy Source3 capture: ${JSON.stringify(oldV3Result)}`,
    );

  // The existing legacy V1 writer cannot enroll beside a Source3 operation in one live
  // namespace. Create the old V1 rows with that real writer in a temporary store, then seed
  // the resulting schema-valid historical rows into this same namespace before the C2 turn.
  const v1Directory = fs.mkdtempSync(join(tmpdir(), 'engram-memory-legacy-v1-fixture-'));
  const v1Path = join(v1Directory, 'legacy-v1.json');
  let v1Store: GraphologyStorage | undefined = new GraphologyStorage(v1Path);
  let v1StoreOpen = false;
  let oldV1EdgeId = '';
  try {
    await v1Store.initialize();
    v1StoreOpen = true;
    const v1Seed = await seedAutomaticCaptureSubject(v1Store, namespace);
    const v1Subject = await v1Store.addEntity({
      group_id: namespace,
      name: 'Legacy literal subject',
      entity_type: 'person',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'manual',
          confidence: null,
          review_status: 'accepted',
          threshold_decision: 'manually_reviewed',
          extracted_at: new Date().toISOString(),
          episode_uuids: [],
          reviewed_at: new Date().toISOString(),
          reviewed_by: 'synthetic-reviewer',
        },
      },
    });
    await v1Store.automaticBindingCommand!({
      action: 'create',
      namespace,
      issuer: 'legacy-literal-app',
      actorReference: 'legacy-literal-actor',
      subjectId: v1Subject.uuid,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic legacy V1 subject identity',
    });
    const oldV1Request = AutomaticCaptureBeginRequestV2Schema.parse({
      ...v1Seed.request,
      issuer: 'legacy-literal-app',
      actorReference: 'legacy-literal-actor',
      turn: `legacy-literal-${randomUUID()}`,
      attemptIdHash: 'c'.repeat(64),
      source: { ...v1Seed.request.source, content: 'I prefer concise explanations.' },
    });
    const oldV1Begin = await v1Store.beginAndClaimAutomaticCaptureV2(oldV1Request);
    if (oldV1Begin.kind !== 'claimed' || oldV1Begin.purpose !== 'human_turn_memory')
      throw new Error('Expected a genuine legacy V1 capture lease');
    const v1LeaseGraph = await v1Store.readExtractionSnapshot(namespace);
    const v1Operation = v1LeaseGraph.automatic_operations_v1?.operations.find(
      (operation) => operation.operationId === oldV1Begin.operationId,
    );
    if (
      !v1Operation ||
      v1Operation.version !== 2 ||
      v1Operation.state !== 'leased' ||
      v1Operation.descriptor.purpose !== 'human_turn_memory'
    ) {
      throw new Error('Expected the actual leased legacy V1 operation');
    }
    const v1Plan = planAutomaticClaims(
      v1LeaseGraph,
      namespace,
      [oldV1Begin.sourceId],
      v1Operation.descriptor.policy,
      new ExtractionDiagnostics().finish(),
      v1Operation.lease.renewedAt,
    );
    const v1Committed = await v1Store.completeHumanCaptureV2(oldV1Begin.leaseHandle, v1Plan);
    if (v1Committed.kind !== 'committed') throw new Error('Expected committed legacy V1 literal');
    const v1Graph = await v1Store.readExtractionSnapshot(namespace);
    const v1Edge = v1Graph.edges.find(
      (edge) =>
        (edge.attributes.engram_claim_v1 as { version?: unknown } | undefined)?.version === 1,
    );
    if (!v1Edge) throw new Error('Expected a persisted legacy V1 claim row');
    oldV1EdgeId = v1Edge.uuid;
    const v1OnlyGraph = GraphDataSchema.parse({
      ...v1Graph,
      entities: v1Graph.entities.filter((entity) => entity.uuid !== v1Seed.subject.uuid),
    });
    await v1Store.close();
    v1StoreOpen = false;
    v1Store = undefined;

    const currentGraph = await store.readExtractionSnapshot(namespace);
    const mergedGraph = GraphDataSchema.parse({
      ...currentGraph,
      entities: [...currentGraph.entities, ...v1OnlyGraph.entities],
      edges: [...currentGraph.edges, ...v1OnlyGraph.edges],
      episodes: [...currentGraph.episodes, ...v1OnlyGraph.episodes],
      automatic_operations_v1: {
        version: 1,
        operations: [
          ...(currentGraph.automatic_operations_v1?.operations ?? []),
          ...(v1OnlyGraph.automatic_operations_v1?.operations ?? []),
        ],
      },
    });
    await store.close();
    store = new GraphologyStorage(path);
    openedStore = store;
    fs.writeFileSync(path, JSON.stringify(mergedGraph, null, 2), 'utf8');
    await store.initialize();
  } finally {
    if (v1StoreOpen && v1Store) await v1Store.close();
    fs.rmSync(v1Directory, { recursive: true, force: true });
  }
  const afterLegacy = await store.readExtractionSnapshot(namespace);
  const oldV1Edge = afterLegacy.edges.find((edge) => edge.uuid === oldV1EdgeId);
  const oldV3Edge = afterLegacy.edges.find(
    (edge) => (edge.attributes.engram_claim_v1 as { version?: unknown } | undefined)?.version === 2,
  );
  if (!oldV1Edge || !oldV3Edge) throw new Error('Expected both persisted legacy claim families');

  const ordinaryValue = await store.addEntity({
    group_id: namespace,
    name: 'Ordinary legacy retrieval subject',
    entity_type: 'concept',
  });
  const general = await store.addEdge({
    group_id: namespace,
    source_node_uuid: seed.subject.uuid,
    target_node_uuid: ordinaryValue.uuid,
    name: 'RELATED_TO',
    fact: 'The verified subject has an ordinary related concept.',
  });

  let claim3EdgeId: string | null = null;
  let claim3SourceId: string | null = null;
  if (includeClaim3) {
    const claimTurn = `memory-claim3-${randomUUID()}`;
    const claimContent = 'I work as a ceramicist.';
    const claimNative = {
      instance: `memory-claim3-instance-${randomUUID()}`,
      workflow: workflowId,
      execution: `memory-claim3-execution-${randomUUID()}`,
    };
    const claimProvider = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const prompt = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: prompt.units.map(({ unitId }) => ({
                    unitId,
                    category: 'work_role',
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
    try {
      const claimContext = nativeAutonomousPersonalCaptureContext(seed, {
        content: claimContent,
        executionId: claimNative.execution,
        workflowId: claimNative.workflow,
        instanceId: claimNative.instance,
        routeId: 'route:parent-reader-claim3',
        model: 'model:parent-reader-claim3',
        requestLimit: 2,
        deadlineMs: 30_000,
        extraParameters: {
          automaticMemoryProfile: 'conservative',
          automaticIntent: 'disabled',
          automaticTurn: claimTurn,
          automaticInput: claimContent,
          queueTemperatureMode: 'providerDefault',
        },
      });
      const claimCompleted = await completeNativeAutonomousPersonalCaptureV4(claimContext, store);
      if (claimCompleted.kind !== 'original_turn')
        throw new Error(`Expected actual Claim3 capture; completion kind=${claimCompleted.kind}`);
      const claimGraph = await store.exportGraph(namespace);
      const claimOperation = claimGraph.automatic_operations_v1?.operations.find(
        (operation) =>
          operation.version === 4 &&
          operation.state === 'committed' &&
          operation.identity.turn === claimTurn,
      );
      if (
        !claimOperation ||
        claimOperation.version !== 4 ||
        claimOperation.state !== 'committed' ||
        claimOperation.terminalReceipt.kind !== 'human_autonomous_capture_committed' ||
        claimOperation.terminalReceipt.selection.kind !== 'occurrences'
      )
        throw new Error('Expected an actual committed Claim3 occurrence receipt');
      const item = claimOperation.terminalReceipt.selection.items.find(
        (candidate) =>
          candidate.kind === 'source_statement_record' &&
          candidate.state === 'accepted' &&
          candidate.effect === 'created' &&
          candidate.claimId !== null,
      );
      if (!item?.claimId || !claimGraph.edges.some((edge) => edge.uuid === item.claimId))
        throw new Error('Expected an actual committed Claim3 statement edge');
      claim3EdgeId = item.claimId;
      claim3SourceId = claimOperation.identity.sourceId;
    } finally {
      claimProvider.mockRestore();
    }
  }

  const native = {
    instance: `memory-instance-${randomUUID()}`,
    workflow: workflowId,
    execution: `memory-execution-${randomUUID()}`,
  };
  const turn = `memory-current-${randomUUID()}`;
  const query = 'What games are on today?';
  const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('The current source-verdict fixture must not call a provider');
  });
  const producerContext = nativeAutonomousPersonalCaptureContext(seed, {
    content: query,
    executionId: native.execution,
    workflowId: native.workflow,
    instanceId: native.instance,
    routeId: 'route:parent-reader',
    model: 'model:parent-reader',
    requestLimit: 2,
    deadlineMs: 30_000,
    extraParameters: {
      automaticMemoryProfile: 'explicit',
      automaticIntent: 'disabled',
      automaticTurn: turn,
      automaticInput: query,
      queueTemperatureMode: 'providerDefault',
    },
  });
  const completed = await completeNativeAutonomousPersonalCaptureV4(producerContext, store);
  provider.mockRestore();
  if (completed.kind !== 'original_turn') throw new Error('Expected an actual C2 original turn');
  const beforeReopen = await store.exportGraph(namespace);
  if (!beforeReopen.automatic_operations_v1) throw new Error('Expected automatic ledger');
  const currentOperation = beforeReopen.automatic_operations_v1.operations.find(
    (operation) =>
      operation.version === 4 &&
      operation.state === 'committed' &&
      operation.identity.turn === turn,
  );
  if (
    !currentOperation ||
    currentOperation.version !== 4 ||
    currentOperation.state !== 'committed' ||
    currentOperation.terminalReceipt.kind !== 'human_autonomous_source_verdict_committed' ||
    currentOperation.terminalReceipt.selection.kind !== 'source_verdict'
  ) {
    throw new Error(
      `Expected a committed no-claim current Operation4 source verdict: ${JSON.stringify(
        currentOperation?.version === 4 && currentOperation.state === 'committed'
          ? currentOperation.terminalReceipt
          : null,
      )}`,
    );
  }
  expect(provider).not.toHaveBeenCalled();

  const published = publishAutonomousPersonalMemoryHandoffV4(
    producerContext,
    store,
    completed.origin,
  );
  if (published.kind !== 'published') throw new Error('Expected native C2 handoff publication');
  await store.close();
  store = new GraphologyStorage(path);
  await store.initialize();
  openedStore = store;

  const storeHash = autonomousPersonalMemoryStoreHashV4(path);
  const contextOptions: AutonomousPersonalMemoryContextOptionsV4 = {
    persistPath: path,
    storageWorkflowId: workflowId,
    native,
    namespace,
    issuer: currentOperation.identity.issuer,
    actorReference: currentOperation.identity.actorReference,
    turn: currentOperation.identity.turn,
    sourceId: published.sourceId,
    profileId: 'explicit',
    explicitIntent: false,
    currentHumanQuery: query,
    sourceMapping: { mode: 'full_body' },
  };
  const memoryContext = autonomousPersonalMemoryContextV4(contextOptions);
  const config = await readAutonomousPersonalNativeMemoryConfigV4(memoryContext, 0, storeHash);
  const lineage = consumeAutonomousPersonalMemoryHandoffV4(
    memoryContext,
    config.storeHash,
    config.namespace,
    config.issuer,
    config.actorReference,
    config.turn,
    config.sourceId,
  );
  if (!lineage) throw new Error('Expected the actual same-execution C2 lineage');

  return {
    store,
    directory,
    path,
    seed,
    config,
    lineage,
    oldV1EdgeId: oldV1Edge.uuid,
    oldV3EdgeId: oldV3Edge.uuid,
    generalEdgeId: general.uuid,
    claim3EdgeId,
    claim3SourceId,
    currentSourceId: currentOperation.identity.sourceId,
  };
}

function makeReadResources(check: () => void = () => {}): ReadResources {
  const budget: SourceHydrationBudget = { remaining: 512, deferred: 0 };
  const scope = getAutomaticClaimReadScope(budget);
  return { budget, scope, check };
}

async function openParent(fixture: Fixture, resources: ReadResources) {
  const work = Object.freeze({
    absoluteMonotonicDeadlineMs: performance.now() + 30_000,
    signal: new AbortController().signal,
  });
  const opened = await openAutonomousPersonalMemoryParentReaderV4(
    fixture.store,
    fixture.lineage,
    fixture.config,
    { scope: resources.scope, work, check: resources.check },
  );
  if (opened.kind !== 'reader_ready') throw new Error(`Expected parent: ${opened.reason}`);
  return opened.reader;
}

function persistedRows(graph: GraphData) {
  return {
    entities: graph.entities,
    edges: graph.edges,
    episodes: graph.episodes,
    operations: graph.automatic_operations_v1?.operations,
  };
}

async function rankedHitFromStorage(
  storage: IGraphStorage,
  edgeId: string,
  score: number,
): Promise<EdgeSearchResult> {
  const edge = await storage.getEdge(edgeId);
  if (!edge) throw new Error(`Expected staged edge ${edgeId}`);
  const [sourceEntity, targetEntity] = await Promise.all([
    storage.getEntity(edge.source_node_uuid),
    storage.getEntity(edge.target_node_uuid),
  ]);
  if (!sourceEntity || !targetEntity) throw new Error(`Expected staged endpoints for ${edgeId}`);
  return { edge, sourceEntity, targetEntity, score };
}

describe('V4 ParentReader legacy compositional compatibility bridge', () => {
  let fixture: Fixture | undefined;
  let parentReader: PrivateAutonomousPersonalMemoryParentReaderV4 | undefined;

  beforeEach(async () => {
    fixture = await createFixture();
  }, 30_000);

  afterEach(async () => {
    jest.restoreAllMocks();
    if (fixture && parentReader)
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, parentReader);
    const store = fixture?.store ?? openedStore;
    const directory = fixture?.directory ?? openedDirectory;
    if (store) await store.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    fixture = undefined;
    parentReader = undefined;
    openedStore = undefined;
    openedDirectory = undefined;
    jest.useRealTimers();
  });

  it('runs actual V1, Source3/Claim2 and general DATA through the same root and original scope', async () => {
    const f = fixture!;
    const resources = makeReadResources();
    const snapshot = jest.spyOn(f.store, 'readCompositionalRetrievalSnapshotV3');
    const originalB1b = recordIntegrity.createIntegrityCheckedAutonomousPersonalClaimIndexV4;
    const b1bIndices: unknown[] = [];
    jest
      .spyOn(recordIntegrity, 'createIntegrityCheckedAutonomousPersonalClaimIndexV4')
      .mockImplementation((...args) => {
        const index = originalB1b(...args);
        b1bIndices.push(index);
        return index;
      });
    const originalV3Index = compositionalIndex.createCompositionalRetrievalSnapshotIndexV3;
    const pureIndices: unknown[] = [];
    jest
      .spyOn(compositionalIndex, 'createCompositionalRetrievalSnapshotIndexV3')
      .mockImplementation((...args) => {
        const index = originalV3Index(...args);
        pureIndices.push(index);
        return index;
      });

    parentReader = await openParent(f, resources);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(b1bIndices).toHaveLength(1);
    const attemptsBeforeCompatibility = getAutomaticClaimReadScopeRemaining(
      resources.scope,
    )!.attemptsRemaining;
    const budgetBeforeCompatibility = resources.budget.remaining;
    const before = persistedRows(await f.store.exportGraph(f.config.namespace));

    const loaded = await loadCompositionalCompatibilityRuntimeReaderV4(
      f.store,
      parentReader,
      resources.budget,
    );
    expect(loaded.status).toBe('ready');
    if (loaded.status !== 'ready') throw new Error('Expected compatibility reader');
    expect(isLiveCompositionalRuntimeReaderV3(loaded.reader)).toBe(true);
    expect(resources.budget.remaining).toBe(budgetBeforeCompatibility - 4);
    expect(getAutomaticClaimReadScopeRemaining(resources.scope)!.attemptsRemaining).toBe(
      attemptsBeforeCompatibility - 1,
    );
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(b1bIndices).toHaveLength(1);
    expect(pureIndices).toHaveLength(1);

    const facts = readCompositionalRuntimeFactsV3(loaded.reader, [f.oldV3EdgeId]);
    expect(facts.status).toBe('data');
    if (facts.status !== 'data') throw new Error('Expected Source3/Claim2 data');
    expect(facts.entries[0]).toMatchObject({
      status: 'qualified_current_data',
      edgeId: f.oldV3EdgeId,
    });
    const literal = readCompositionalRuntimeLiteralContextV3(loaded.reader, f.oldV1EdgeId);
    expect(literal.status).toBe('committed');
    const namespace = getCompositionalRuntimeNamespaceDataV3(loaded.reader);
    expect(namespace.status).toBe('namespace_data');
    if (namespace.status !== 'namespace_data') throw new Error('Expected same-root namespace DATA');
    expect(namespace.graph.edges.find((edge) => edge.uuid === f.generalEdgeId)).toBeDefined();
    expect(namespace.graph.edges.find((edge) => edge.uuid === f.oldV1EdgeId)).toBeDefined();
    expect(namespace.graph.edges.find((edge) => edge.uuid === f.oldV3EdgeId)).toBeDefined();
    expect(
      namespace.graph.episodes.find((episode) => episode.uuid === f.currentSourceId),
    ).toBeDefined();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(persistedRows(await f.store.exportGraph(f.config.namespace))).toEqual(before);
  }, 30_000);

  it('binds the compatibility reader to the exact parent and storage owner', async () => {
    const f = fixture!;
    const resources = makeReadResources();
    parentReader = await openParent(f, resources);
    const loaded = await loadCompositionalCompatibilityRuntimeReaderV4(
      f.store,
      parentReader,
      resources.budget,
    );
    expect(loaded.status).toBe('ready');
    if (loaded.status !== 'ready') throw new Error('Expected compatibility reader');

    expect(isCompositionalCompatibilityRuntimeReaderV4(f.store, parentReader, loaded.reader)).toBe(
      true,
    );
    expect(
      isCompositionalCompatibilityRuntimeReaderV4({} as IGraphStorage, parentReader, loaded.reader),
    ).toBe(false);

    const otherResources = makeReadResources();
    const otherParent = await openParent(f, otherResources);
    try {
      expect(isCompositionalCompatibilityRuntimeReaderV4(f.store, otherParent, loaded.reader)).toBe(
        false,
      );
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(f.store, otherParent);
    }

    const ordinaryResources = makeReadResources();
    const ordinary = await loadCompositionalRuntimeReaderV3(
      f.store,
      { namespace: f.config.namespace },
      { budget: ordinaryResources.budget },
    );
    expect(ordinary.status).toBe('ready');
    if (ordinary.status !== 'ready') throw new Error('Expected ordinary V3 runtime reader');
    expect(isLiveCompositionalRuntimeReaderV3(ordinary.reader)).toBe(true);
    expect(
      isCompositionalCompatibilityRuntimeReaderV4(f.store, parentReader, ordinary.reader),
    ).toBe(false);
  }, 30_000);

  it('rejects fake, wrong-owner, foreign-scope and source-budget-spent admissions without a second read', async () => {
    const f = fixture!;
    const resources = makeReadResources();
    const snapshot = jest.spyOn(f.store, 'readCompositionalRetrievalSnapshotV3');
    parentReader = await openParent(f, resources);
    const afterOpenBudget = resources.budget.remaining;
    const afterOpenScope = getAutomaticClaimReadScopeRemaining(resources.scope)!;

    expect(
      await loadCompositionalCompatibilityRuntimeReaderV4(
        f.store,
        {} as PrivateAutonomousPersonalMemoryParentReaderV4,
        resources.budget,
      ),
    ).toEqual({ status: 'deferred', reason: 'invalid_reader' });
    expect(
      await loadCompositionalCompatibilityRuntimeReaderV4(
        {} as IGraphStorage,
        parentReader,
        resources.budget,
      ),
    ).toEqual({ status: 'deferred', reason: 'invalid_reader' });

    const foreignBudget: SourceHydrationBudget = { remaining: 512, deferred: 0 };
    expect(
      await loadCompositionalCompatibilityRuntimeReaderV4(f.store, parentReader, foreignBudget),
    ).toEqual({ status: 'deferred', reason: 'invalid_reader' });
    expect(foreignBudget.remaining).toBe(512);
    expect(resources.budget.remaining).toBe(afterOpenBudget);
    expect(getAutomaticClaimReadScopeRemaining(resources.scope)!.attemptsRemaining).toBe(
      afterOpenScope.attemptsRemaining,
    );
    expect(snapshot).toHaveBeenCalledTimes(1);

    resources.budget.remaining = 0;
    expect(
      await loadCompositionalCompatibilityRuntimeReaderV4(f.store, parentReader, resources.budget),
    ).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
    expect(snapshot).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.each([new Error('synthetic trusted resource failure'), undefined])(
    'retains the exact external failure identity, including %s',
    async (failure) => {
      const f = fixture!;
      let shouldThrow = false;
      const check = () => {
        if (shouldThrow) throw failure;
      };
      const resources = makeReadResources(check);
      parentReader = await openParent(f, resources);
      const live = await loadCompositionalCompatibilityRuntimeReaderV4(
        f.store,
        parentReader,
        resources.budget,
      );
      expect(live.status).toBe('ready');
      if (live.status !== 'ready') throw new Error('Expected compatibility reader');
      shouldThrow = true;
      let predicateThrew = false;
      let predicateCaught: unknown;
      try {
        isCompositionalCompatibilityRuntimeReaderV4(f.store, parentReader, live.reader);
      } catch (error) {
        predicateThrew = true;
        predicateCaught = error;
      }
      expect(predicateThrew).toBe(true);
      expect(predicateCaught).toBe(failure);
      let threw = false;
      let caught: unknown;
      try {
        await loadCompositionalCompatibilityRuntimeReaderV4(
          f.store,
          parentReader,
          resources.budget,
        );
      } catch (error) {
        threw = true;
        caught = error;
      }
      expect(threw).toBe(true);
      expect(caught).toBe(failure);
    },
    30_000,
  );

  it('maps an expired ParentReader scope to bounded DATA during a later read', async () => {
    const f = fixture!;
    const resources = makeReadResources();
    parentReader = await openParent(f, resources);
    const live = await loadCompositionalCompatibilityRuntimeReaderV4(
      f.store,
      parentReader,
      resources.budget,
    );
    expect(live.status).toBe('ready');
    if (live.status !== 'ready') throw new Error('Expected compatibility reader');
    const base = performance.now();
    const readClock = jest.spyOn(performance, 'now').mockReturnValue(base + 6_000);
    expect(readCompositionalRuntimeFactsV3(live.reader, [f.oldV3EdgeId])).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    readClock.mockRestore();
  }, 30_000);

  it('maps a ParentReader scope stop reached inside the V3 preparation index to bounded DATA', async () => {
    const f = fixture!;
    const resources = makeReadResources();
    parentReader = await openParent(f, resources);
    const originalFactory = retrievalFactory.createCompositionalRetrievalSessionFactoryV3;
    let prepareCalled = false;
    jest
      .spyOn(retrievalFactory, 'createCompositionalRetrievalSessionFactoryV3')
      .mockImplementation((internalStop) => {
        const factory = originalFactory(internalStop);
        return Object.freeze({
          ...factory,
          prepare: (intake: unknown, data: unknown) => {
            prepareCalled = true;
            return factory.prepare(intake, data);
          },
        });
      });
    const originalIndex = compositionalIndex.createCompositionalRetrievalSnapshotIndexV3;
    let indexCalls = 0;
    jest
      .spyOn(compositionalIndex, 'createCompositionalRetrievalSnapshotIndexV3')
      .mockImplementation((...args) => {
        indexCalls++;
        const expiresOriginalScope = jest
          .spyOn(performance, 'now')
          .mockReturnValue(performance.now() + 6_000);
        try {
          return originalIndex(...args);
        } finally {
          expiresOriginalScope.mockRestore();
        }
      });

    const result = await loadCompositionalCompatibilityRuntimeReaderV4(
      f.store,
      parentReader,
      resources.budget,
    );
    expect(prepareCalled).toBe(true);
    expect(indexCalls).toBe(1);
    expect(result).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
  }, 30_000);

  it('turns an actual ParentReader resource stop into bounded DATA before factory preparation', async () => {
    const f = fixture!;
    const resources = makeReadResources();
    parentReader = await openParent(f, resources);
    const originalFactory = retrievalFactory.createCompositionalRetrievalSessionFactoryV3;
    let prepareCalls = 0;
    jest
      .spyOn(retrievalFactory, 'createCompositionalRetrievalSessionFactoryV3')
      .mockImplementation((internalStop) => {
        const factory = originalFactory(internalStop);
        return Object.freeze({
          ...factory,
          begin: (request: unknown, factoryResources: unknown) => {
            const result = factory.begin(request, factoryResources);
            for (let index = 0; index < 201; index++)
              readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
                f.store,
                parentReader,
                f.oldV3EdgeId,
              );
            return result;
          },
          prepare: (intake: unknown, data: unknown) => {
            prepareCalls++;
            return factory.prepare(intake, data);
          },
        });
      });
    const result = await loadCompositionalCompatibilityRuntimeReaderV4(
      f.store,
      parentReader,
      resources.budget,
    );
    expect(result).toEqual({ status: 'deferred', reason: 'resource_exhausted' });
    expect(prepareCalls).toBe(0);
  }, 30_000);
});

describe('fixed V4 governance over a single staged Parent namespace', () => {
  it('preserves legacy families while governing a genuine Claim3 row from the same snapshot', async () => {
    const f = await createFixture(true);
    const resources = makeReadResources();
    let parentReader: PrivateAutonomousPersonalMemoryParentReaderV4 | undefined;
    try {
      if (!f.claim3EdgeId || !f.claim3SourceId) throw new Error('Expected actual Claim3 fixture');
      const snapshot = jest.spyOn(f.store, 'readCompositionalRetrievalSnapshotV3');
      const b1bFactory = jest.spyOn(
        recordIntegrity,
        'createIntegrityCheckedAutonomousPersonalClaimIndexV4',
      );
      const actualEpisodes = jest.spyOn(f.store, 'getEpisodes');
      const actualEntities = jest.spyOn(f.store, 'getEntity');
      const before = persistedRows(await f.store.exportGraph(f.config.namespace));

      parentReader = await openParent(f, resources);
      const loaded = await loadCompositionalCompatibilityRuntimeReaderV4(
        f.store,
        parentReader,
        resources.budget,
      );
      expect(loaded.status).toBe('ready');
      if (loaded.status !== 'ready') throw new Error('Expected compatibility runtime reader');
      const automatic = getCompositionalRuntimeAutomaticReadContextV3(loaded.reader, {
        mode: 'current',
      });
      if (!automatic) throw new Error('Expected original compatibility read counters');
      const route = RetrievalGovernance.forAutonomousPersonalMemoryV4(
        f.store,
        parentReader,
        loaded.reader,
      );
      if (!route) throw new Error('Expected fixed governance route');
      expect(route.namespace).toBe(f.config.namespace);

      const orderedIds = [f.oldV1EdgeId, f.claim3EdgeId, f.generalEdgeId, f.oldV3EdgeId];
      const allHits = await Promise.all(
        orderedIds.map((edgeId, index) =>
          rankedHitFromStorage(route.storage, edgeId, 1 - index / 10),
        ),
      );
      const legacyHits = allHits.filter((hit) => hit.edge.uuid !== f.claim3EdgeId);
      const legacyBaseline = await route.governance.governEdgesWithDecisions(
        legacyHits,
        {},
        resources.budget,
        automatic,
        loaded.reader,
      );

      const fixed = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        f.store,
        parentReader,
        loaded.reader,
        allHits,
        {},
        resources.budget,
        automatic,
      );
      expect(fixed.decisions.map((decision) => decision.candidate_id)).toEqual(orderedIds);
      expect(fixed.results.map((hit) => hit.edge.uuid)).toEqual(
        orderedIds.filter(
          (edgeId) =>
            legacyBaseline.results.some((hit) => hit.edge.uuid === edgeId) ||
            edgeId === f.claim3EdgeId,
        ),
      );
      const baselineById = new Map(
        legacyBaseline.decisions.map((decision) => [decision.candidate_id, decision]),
      );
      const baselineResultsById = new Map(
        legacyBaseline.results.map((result) => [result.edge.uuid, result]),
      );
      for (const edgeId of orderedIds.filter((id) => id !== f.claim3EdgeId)) {
        expect(fixed.decisions.find((decision) => decision.candidate_id === edgeId)).toEqual(
          baselineById.get(edgeId),
        );
        expect(fixed.results.find((result) => result.edge.uuid === edgeId)).toEqual(
          baselineResultsById.get(edgeId),
        );
      }
      const claim3Result = fixed.results.find((hit) => hit.edge.uuid === f.claim3EdgeId);
      expect(claim3Result).toBeDefined();
      expect(getAutonomousPersonalRuntimeDisplayV4(claim3Result!)).toMatchObject({
        kind: 'source_statement_record',
        statementLiteral: 'I work as a ceramicist.',
      });
      expect(claim3Result?.provenance?.[0]?.source_episode_uuid).toBe(f.claim3SourceId);
      expect(actualEpisodes).not.toHaveBeenCalled();
      expect(actualEntities).not.toHaveBeenCalled();
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(b1bFactory).toHaveBeenCalledTimes(1);
      expect(persistedRows(await f.store.exportGraph(f.config.namespace))).toEqual(before);

      const historicalAutomatic = getCompositionalRuntimeAutomaticReadContextV3(loaded.reader, {
        mode: 'historical',
      });
      if (!historicalAutomatic) throw new Error('Expected historical shared read counters');
      const historicalLegacy = await route.governance.governEdgesWithDecisions(
        legacyHits,
        {},
        resources.budget,
        historicalAutomatic,
        loaded.reader,
      );
      const historical = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        f.store,
        parentReader,
        loaded.reader,
        allHits,
        {},
        resources.budget,
        historicalAutomatic,
      );
      expect(
        historical.decisions.find((decision) => decision.candidate_id === f.claim3EdgeId)?.reasons,
      ).toEqual(['autonomous_personal_historical_unsupported']);
      const historicalLegacyById = new Map(
        historicalLegacy.decisions.map((decision) => [decision.candidate_id, decision]),
      );
      const historicalLegacyResultsById = new Map(
        historicalLegacy.results.map((result) => [result.edge.uuid, result]),
      );
      for (const edgeId of orderedIds.filter((id) => id !== f.claim3EdgeId)) {
        expect(historical.decisions.find((decision) => decision.candidate_id === edgeId)).toEqual(
          historicalLegacyById.get(edgeId),
        );
        expect(historical.results.find((result) => result.edge.uuid === edgeId)).toEqual(
          historicalLegacyResultsById.get(edgeId),
        );
      }
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(b1bFactory).toHaveBeenCalledTimes(1);
      expect(actualEpisodes).not.toHaveBeenCalled();
      expect(actualEntities).not.toHaveBeenCalled();
      expect(persistedRows(await f.store.exportGraph(f.config.namespace))).toEqual(before);
    } finally {
      jest.restoreAllMocks();
      if (parentReader) closeAutonomousPersonalMemoryParentReaderV4(f.store, parentReader);
      await f.store.close();
      fs.rmSync(f.directory, { recursive: true, force: true });
    }
  }, 30_000);
});
