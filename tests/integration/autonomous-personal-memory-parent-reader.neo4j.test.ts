import type { IExecuteFunctions } from 'n8n-workflow';
import { readReplaySafeMemoryNativeContext } from '../../src/utils/replaySafeMemoryNative';
import { issueAutonomousPersonalAssistantFinalInvocationV4 } from '../../src/storage/AutonomousPersonalAssistantFinalInvocationV4';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import * as qualifiedClaims from '../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  getAutonomousPersonalMemoryLineageOriginV4,
  publishAutonomousPersonalMemoryHandoffV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import {
  closeAutonomousPersonalMemoryParentReaderV4,
  getAutonomousPersonalMemoryParentNamespaceGraphV4,
  getAutonomousPersonalMemoryParentReceiptSummaryV4,
  isLiveAutonomousPersonalMemoryParentReaderV4,
  openAutonomousPersonalMemoryParentReaderV4,
  readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4,
} from '../../src/memory/AutonomousPersonalMemoryParentReaderV4';
import * as recordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  type AutomaticClaimReadScope,
} from '../../src/storage/AutomaticClaimReadScope';
import {
  getCompositionalRuntimeNamespaceDataV3,
  isCompositionalCompatibilityRuntimeReaderV4,
  isLiveCompositionalRuntimeReaderV3,
  loadCompositionalCompatibilityRuntimeReaderV4,
} from '../../src/search/CompositionalRuntimeReaderV3';
import type { SourceHydrationBudget } from '../../src/schemas/ExtractionPolicy.schema';
import { neo4jAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { hashAutomaticCaptureV2 } from '../../src/schemas/AutomaticCapture.schema';
import { AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema } from '../../src/schemas/AutonomousPersonalMemoryParentQualifiedClaimCandidateV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { GraphData } from '../../src/schemas/GraphData.schema';
import type { AutonomousPersonalOperationV4 } from '../../src/schemas/AutonomousPersonalOperationV4.schema';
import type { CompositionalRetrievalSnapshotResultV3 } from '../../src/schemas/CompositionalRetrievalSnapshotV3.schema';
import { readAutonomousPersonalNativeMemoryConfigV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import type { AutonomousPersonalNativeMemoryConfigContextV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

jest.setTimeout(90_000);

const uri = process.env.NEO4J_TEST_URI;
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
const describeNeo = uri ? describe : describe.skip;

type Seed = Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;
type ProviderMode = 'success' | 'unavailable' | 'unexpected';
type ProviderBody = { messages: Array<{ role: string; content: string }> };
type DriverTransactionTimeout = NonNullable<Parameters<Session['beginTransaction']>[0]>['timeout'];
type CommittedOperation = Extract<AutonomousPersonalOperationV4, { state: 'committed' }>;
type ParentFixture = {
  readonly config: Awaited<ReturnType<typeof readAutonomousPersonalNativeMemoryConfigV4>>;
  readonly lineage: NonNullable<ReturnType<typeof consumeAutonomousPersonalMemoryHandoffV4>>;
  readonly native: { instance: string; workflow: string; execution: string };
  readonly operation: CommittedOperation;
  readonly provider: ProviderMode;
  readonly sourceId: string;
  readonly store: Neo4jStorage;
  readonly turn: string;
  readonly graphBeforeRead: GraphData;
};

const queryText = 'I prefer concise explanations.';
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const sortedRows = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
const committedOperations = (graph: GraphData) =>
  (graph.automatic_operations_v1?.operations ?? []).filter(
    (operation): operation is CommittedOperation =>
      operation.version === 4 && operation.state === 'committed',
  );
const claimEdges = (graph: GraphData, namespace: string) =>
  graph.edges.filter(
    (edge) => edge.group_id === namespace && hasOwn(edge.attributes ?? {}, 'engram_claim_v1'),
  );

describeNeo('actual Neo4j Autonomous Personal Memory parent reader V4', () => {
  let driver: Driver | undefined;
  let store: Neo4jStorage | undefined;
  let seed: Seed;
  let namespaces: string[] = [];
  let openStores: Neo4jStorage[] = [];
  let providerBodies: ProviderBody[] = [];
  let restoreProvider: (() => void) | undefined;

  const createStore = () => new Neo4jStorage(uri!, username, password, database);

  const closeStore = async (candidate: Neo4jStorage) => {
    if (!openStores.includes(candidate)) return;
    openStores = openStores.filter((entry) => entry !== candidate);
    await candidate.close();
  };

  const openStore = async () => {
    const candidate = createStore();
    expect(candidate.getNativeAutomaticCaptureStoreIdentityV4()).toBeNull();
    openStores.push(candidate);
    try {
      await candidate.initialize();
      expect(candidate.getNativeAutomaticCaptureStoreIdentityV4()).toBe(
        neo4jAutomaticCaptureStoreHash(uri!, database),
      );
      return candidate;
    } catch (error) {
      await closeStore(candidate);
      throw error;
    }
  };

  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver!.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };

  beforeEach(async () => {
    namespaces = [];
    openStores = [];
    providerBodies = [];
    driver = neo4j.driver(
      uri!.replace('://localhost:', '://127.0.0.1:'),
      neo4j.auth.basic(username, password),
    );
    store = await openStore();
    seed = await seedAutonomousPersonalCaptureSubject(store);
    namespaces = [seed.request.namespace];
  });

  afterEach(async () => {
    restoreProvider = undefined;
    jest.restoreAllMocks();
    const errors: unknown[] = [];
    const attempt = async (step: () => unknown) => {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      for (const candidate of [...openStores]) await attempt(() => closeStore(candidate));
      if (driver) {
        for (const namespace of namespaces) {
          await attempt(() =>
            query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
              namespace,
            }),
          );
          await attempt(() =>
            query(
              'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
              { namespace },
            ),
          );
          await attempt(() =>
            query('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
              namespace,
            }),
          );
        }
      }
      await attempt(async () => driver?.close());
    } finally {
      store = undefined;
      driver = undefined;
      namespaces = [];
      openStores = [];
    }
    if (errors.length > 0) {
      throw Object.assign(new Error('Neo4j parent reader test cleanup failed'), { errors });
    }
  });

  function producerContext(
    turn: string,
    options: {
      readonly profile?: 'conservative' | 'explicit';
      readonly intent?: 'enabled' | 'disabled';
    } = {},
  ) {
    return nativeAutonomousPersonalCaptureContext(seed, {
      executionId: `parent-execution:${turn}`,
      workflowId: `parent-workflow:${turn}`,
      instanceId: `parent-instance:${turn}`,
      deadlineMs: 30_000,
      content: queryText,
      routeId: 'route:parent-reader',
      model: 'model:parent-reader',
      requestLimit: 2,
      extraParameters: {
        automaticMemoryProfile: options.profile ?? 'conservative',
        automaticIntent: options.intent ?? 'disabled',
        automaticTurn: turn,
      },
    });
  }

  function installProvider(mode: ProviderMode) {
    restoreProvider?.();
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (mode === 'unexpected') throw new Error('unexpected_neo4j_parent_provider_dispatch');
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      providerBodies.push(body);
      if (mode === 'unavailable') return new Response('synthetic unavailable', { status: 503 });
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
    restoreProvider = () => spy.mockRestore();
    spy.mockClear();
    return spy;
  }

  function memoryContextFor(
    turn: string,
    native: ParentFixture['native'],
    identity: CommittedOperation['identity'],
    profile: 'conservative' | 'explicit',
    intent: 'enabled' | 'disabled',
  ): AutonomousPersonalNativeMemoryConfigContextV4 {
    const parameters: Record<string, unknown> = {
      sessionIdType: 'customKey',
      sessionKey: identity.namespace,
      extractionExecution: 'synchronous',
      currentHumanQuery: queryText,
      automaticMemoryProfile: profile,
      automaticIssuer: identity.issuer,
      automaticActor: identity.actorReference,
      automaticTurn: turn,
      automaticIntent: intent,
      automaticRawHuman: '',
      automaticWrapper: 'disabled',
      automaticCapturedSource: identity.sourceId,
      advancedExtractionPolicy: 'bounded',
      knowledgeSelection: 'durableTemporal',
      extractionRequestLimit: 2,
      extractionDeadlineMs: 30_000,
      extractionRouteId: 'route:parent-reader',
      extractionModel: 'model:parent-reader',
      extractionTemperatureMode: 'providerDefault',
    };
    return {
      getNode: () => ({
        id: 'synthetic-neo-parent-memory-node',
        type: 'n8n-nodes-engram.engramMemory',
        typeVersion: 3,
        parameters: { automaticCaptureLifecycle: 'replaySafeV2' },
        continueOnFail: false,
        onError: 'stopWorkflow',
      }),
      getNodeParameter: (name: string, _itemIndex: number, fallback: unknown) =>
        Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
      getInputData: () => [{ json: { sessionId: identity.namespace } }],
      getExecutionId: () => native.execution,
      getWorkflow: () => ({ id: native.workflow }),
      getInstanceId: () => native.instance,
      getCredentials: async () => ({
        apiKey: 'synthetic-memory-secret',
        baseUrl: 'https://memory.invalid/v1',
      }),
      evaluateExpression: () => identity.namespace,
    } as unknown as AutonomousPersonalNativeMemoryConfigContextV4;
  }

  async function reopenMemoryOwner() {
    if (!store) throw new Error('Expected an initialized Neo4j storage owner');
    await closeStore(store);
    store = await openStore();
    return store;
  }

  async function createParent(
    options: {
      readonly profile?: 'conservative' | 'explicit';
      readonly intent?: 'enabled' | 'disabled';
      readonly provider?: ProviderMode;
    } = {},
  ): Promise<ParentFixture> {
    if (!store) throw new Error('Expected an initialized Neo4j storage owner');
    const profile = options.profile ?? 'conservative';
    const intent = options.intent ?? 'disabled';
    const provider = options.provider ?? 'success';
    const turn = `neo-memory-parent:${randomUUID()}`;
    const ctx = producerContext(turn, { profile, intent });
    const fetchSpy = installProvider(provider);
    const completed = await completeNativeAutonomousPersonalCaptureV4(ctx, store);
    if (completed.kind !== 'original_turn') {
      throw new Error(`Expected genuine C2 parent bridge; received ${completed.kind}`);
    }
    if (provider === 'unexpected') expect(fetchSpy).not.toHaveBeenCalled();
    else expect(fetchSpy).toHaveBeenCalled();

    const beforeOwnerChange = await store.exportGraph(seed.request.namespace);
    const operations = committedOperations(beforeOwnerChange).filter(
      (operation) => operation.identity.turn === turn,
    );
    expect(operations).toHaveLength(1);
    const operation = operations[0]!;
    const source = beforeOwnerChange.episodes.find(
      (episode) => episode.uuid === operation.identity.sourceId,
    );
    expect(source).toMatchObject({
      uuid: operation.identity.sourceId,
      role: 'human',
      episode_kind: 'active_human',
      content: queryText,
    });

    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, completed.origin)).toEqual({
      kind: 'published',
      sourceId: operation.identity.sourceId,
    });
    const native = {
      instance: `parent-instance:${turn}`,
      workflow: `parent-workflow:${turn}`,
      execution: `parent-execution:${turn}`,
    };
    const storeHash = neo4jAutomaticCaptureStoreHash(uri!, database);
    expect(operation.identity.storeHash).toBe(storeHash);
    const memoryContext = memoryContextFor(turn, native, operation.identity, profile, intent);
    await reopenMemoryOwner();

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
    if (!lineage) throw new Error('Expected genuine one-use lineage after fresh-owner handoff');
    const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
    expect(origin?.identity).toEqual(operation.identity);
    expect(origin?.terminalReceipt).toEqual(operation.terminalReceipt);
    const graphBeforeRead = await store!.exportGraph(seed.request.namespace);
    return {
      config,
      lineage,
      native,
      operation,
      provider,
      sourceId: operation.identity.sourceId,
      store: store!,
      turn,
      graphBeforeRead,
    };
  }

  function readResources(signal: AbortSignal = new AbortController().signal) {
    const budget = { remaining: 512, deferred: 0 };
    const scope: AutomaticClaimReadScope = getAutomaticClaimReadScope(budget);
    const work: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal,
    });
    return { scope, work, check: jest.fn() };
  }

  function watchSnapshot(owner: Neo4jStorage) {
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
    const created: Parameters<typeof qualifiedClaims.inspectAutonomousPersonalClaimCreatorV4>[0][] =
      [];
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
    result: Awaited<ReturnType<typeof openAutonomousPersonalMemoryParentReaderV4>>,
    reason: string,
  ) {
    if (result.kind === 'reader_ready') {
      closeAutonomousPersonalMemoryParentReaderV4(store!, result.reader);
    }
    expect(result).toEqual({ kind: 'rejected', reason });
  }

  function expectRowsUnchanged(before: GraphData, after: GraphData) {
    expect(sortedRows(after.entities)).toEqual(sortedRows(before.entities));
    expect(sortedRows(after.edges)).toEqual(sortedRows(before.edges));
    expect(sortedRows(after.episodes)).toEqual(sortedRows(before.episodes));
    expect(sortedRows(after.automatic_operations_v1?.operations ?? [])).toEqual(
      sortedRows(before.automatic_operations_v1?.operations ?? []),
    );
  }

  it.each([
    [
      'accepted occurrence',
      'conservative',
      'enabled',
      'success',
      'human_autonomous_capture_committed',
      1,
    ],
    [
      'deferred provider',
      'conservative',
      'enabled',
      'unavailable',
      'human_autonomous_source_deferred_committed',
      0,
    ],
    [
      'source verdict',
      'explicit',
      'disabled',
      'unexpected',
      'human_autonomous_source_verdict_committed',
      0,
    ],
  ] as const)(
    'opens one read-only Neo4j parent for a genuine %s receipt',
    async (_name, profile, intent, provider, expectedReceipt, expectedClaims) => {
      const fixture = await createParent({ profile, intent, provider });
      expect(fixture.operation.terminalReceipt.kind).toBe(expectedReceipt);
      expect(claimEdges(fixture.graphBeforeRead, seed.request.namespace)).toHaveLength(
        expectedClaims,
      );
      const foreign = await seedAutonomousPersonalCaptureSubject(fixture.store);
      namespaces.push(foreign.request.namespace);
      expect(foreign.request.namespace).not.toBe(fixture.config.namespace);
      const beforeAccessors = await fixture.store.exportGraph();
      const snapshot = watchSnapshot(fixture.store);
      const indices = watchIndexConstruction();
      const resources = readResources();
      const result = await openAutonomousPersonalMemoryParentReaderV4(
        fixture.store,
        fixture.lineage,
        fixture.config,
        resources,
      );
      expect(result.kind).toBe('reader_ready');
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(snapshot.actual?.status).toBe('snapshot');
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(indices.created).toHaveLength(1);
      if (snapshot.actual?.status === 'snapshot') {
        expect(Date.parse(snapshot.actual.backendNow)).toBeGreaterThanOrEqual(
          Date.parse(fixture.operation.terminalReceipt.terminalAt),
        );
      }
      if (result.kind === 'reader_ready') {
        try {
          expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(
            true,
          );
          const summary = getAutonomousPersonalMemoryParentReceiptSummaryV4(
            fixture.store,
            result.reader,
          );
          const namespaceGraph = getAutonomousPersonalMemoryParentNamespaceGraphV4(
            fixture.store,
            result.reader,
          );
          const receipt = fixture.operation.terminalReceipt;
          if (receipt.kind === 'cancelled' || summary === null || summary.kind !== 'committed') {
            throw new Error('Expected one committed receipt summary for the committed parent');
          }
          expect(summary).toMatchObject({
            version: 4,
            kind: 'committed',
            sourceId: receipt.sourceId,
            terminalAt: receipt.terminalAt,
            acceptedCoverage: receipt.acceptedCoverage,
            interpretationCoverage: receipt.interpretationCoverage,
            sourceCoverage: receipt.sourceCoverage,
          });
          expect(Object.keys(summary!).sort()).toEqual(
            [
              'acceptedCoverage',
              'acceptanceSemantics',
              'counts',
              'interpretationCoverage',
              'kind',
              'selection',
              'sourceCoverage',
              'sourceId',
              'terminalAt',
              'version',
            ].sort(),
          );
          expect(summary!.selection.kind).toBe(receipt.selection.kind);
          expect(Object.isFrozen(summary!)).toBe(true);
          expect(Object.isFrozen(summary!.selection)).toBe(true);
          expect(Object.isFrozen(summary!.counts)).toBe(true);
          expect(Object.isFrozen(summary!.sourceCoverage)).toBe(true);
          if (receipt.kind === 'human_autonomous_capture_committed') {
            if (receipt.selection.kind !== 'occurrences') {
              throw new Error('Expected occurrence items in the accepted C2 receipt');
            }
            expect(summary!.selection).toEqual({
              kind: 'occurrences',
              items: receipt.selection.items.map((item) => ({
                occurrenceIndex: item.occurrenceIndex,
                kind: item.kind,
                state: item.state,
                effect: item.effect,
                claimId: item.claimId,
                reason: item.reason,
              })),
            });
            expect(summary!.counts.occurrenceCount).toBe(receipt.selection.items.length);
            if ('items' in summary!.selection) {
              expect(Object.isFrozen(summary!.selection.items)).toBe(true);
              expect(summary!.selection.items.every(Object.isFrozen)).toBe(true);
            }

            const created = receipt.selection.items.find(
              (item) => item.effect === 'created' && item.claimId !== null,
            );
            if (!created?.claimId || created.state !== 'accepted') {
              throw new Error('Expected the actual current accepted Claim3 row');
            }
            const candidate = readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
              fixture.store,
              result.reader,
              created.claimId,
            );
            expect(candidate).not.toBeNull();
            if (!candidate) throw new Error('Expected compact candidate DATA');
            expect(
              AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(
                candidate,
              ).success,
            ).toBe(true);
            expect(Object.isFrozen(candidate)).toBe(true);
            expect(Object.isFrozen(candidate.proof)).toBe(true);
            expect(candidate.proof).toMatchObject({
              claimId: created.claimId,
              sourceId: fixture.operation.identity.sourceId,
              operationId: fixture.operation.operationId,
              reviewState: 'accepted',
            });
            expect(candidate.terminalAt).toBe(receipt.terminalAt);
            expect(candidate.terminalAt).not.toBe(candidate.proof.createdAt);
            const actualEdge = namespaceGraph!.edges.find((edge) => edge.uuid === created.claimId);
            if (!actualEdge) throw new Error('Expected current Claim3 edge in reader root');
            const actualSubject = namespaceGraph!.entities.find(
              (entity) => entity.uuid === actualEdge.source_node_uuid,
            );
            const actualValue = namespaceGraph!.entities.find(
              (entity) => entity.uuid === actualEdge.target_node_uuid,
            );
            if (!actualSubject || !actualValue) {
              throw new Error('Expected actual current candidate endpoints in the reader root');
            }
            expect(candidate.rowHash).toBe(
              hashAutomaticCaptureV2({
                edge: actualEdge,
                subject: actualSubject,
                value: actualValue,
              }),
            );
            expect(snapshot.spy).toHaveBeenCalledTimes(1);
            expect(indices.spy).toHaveBeenCalledTimes(1);
            expect(indices.created).toHaveLength(1);
          } else {
            expect(summary!.selection).toEqual(receipt.selection);
            expect(summary!.counts).toEqual({
              occurrenceCount: 0,
              byState: { accepted: 0, proposed: 0, rejected: 0, not_selected: 0 },
              createdOccurrenceCount: 0,
              referenceOccurrenceCount: 0,
              distinctPersistedClaimCount: 0,
            });
            expect(claimEdges(namespaceGraph!, fixture.config.namespace)).toHaveLength(0);
            // Source-only and deferred receipts have no current claim id to pass to the fixed
            // candidate reader. The source ID remains the parent source, never a fake edge ID.
          }

          expect(namespaceGraph).not.toBeNull();
          expect(namespaceGraph!.group_id).toBe(fixture.config.namespace);
          expect(namespaceGraph!.version).toBe(beforeAccessors.version);
          expect(sortedRows(namespaceGraph!.entities)).toEqual(
            sortedRows(
              beforeAccessors.entities.filter((row) => row.group_id === fixture.config.namespace),
            ),
          );
          expect(sortedRows(namespaceGraph!.edges)).toEqual(
            sortedRows(
              beforeAccessors.edges.filter((row) => row.group_id === fixture.config.namespace),
            ),
          );
          expect(sortedRows(namespaceGraph!.episodes)).toEqual(
            sortedRows(
              beforeAccessors.episodes.filter((row) => row.group_id === fixture.config.namespace),
            ),
          );
          expect(sortedRows(namespaceGraph!.automatic_operations_v1!.operations)).toEqual(
            sortedRows(
              beforeAccessors.automatic_operations_v1!.operations.filter(
                (operation) => operation.identity.namespace === fixture.config.namespace,
              ),
            ),
          );
          expect(namespaceGraph!.metadata).toEqual(
            beforeAccessors.metadata?.extraction_epoch
              ? { extraction_epoch: beforeAccessors.metadata.extraction_epoch }
              : undefined,
          );
          if (namespaceGraph!.metadata !== undefined) {
            expect(namespaceGraph!.metadata).not.toHaveProperty('entity_count');
            expect(namespaceGraph!.metadata).not.toHaveProperty('edge_count');
            expect(namespaceGraph!.metadata).not.toHaveProperty('episode_count');
            expect(namespaceGraph!.metadata).not.toHaveProperty('checksum_sha256');
            expect(namespaceGraph!.metadata).not.toHaveProperty('checksum_algorithm');
          }
          expect(
            namespaceGraph!.entities.some((row) => row.uuid === foreign.binding.subjectId),
          ).toBe(false);
          expect(
            namespaceGraph!.edges.every((row) => row.group_id === fixture.config.namespace),
          ).toBe(true);
          expect(
            namespaceGraph!.episodes.every((row) => row.group_id === fixture.config.namespace),
          ).toBe(true);
          expect(
            namespaceGraph!.automatic_operations_v1!.operations.every(
              (operation) => operation.identity.namespace === fixture.config.namespace,
            ),
          ).toBe(true);
          expect(Object.isFrozen(namespaceGraph)).toBe(true);
          expect(Object.isFrozen(namespaceGraph!.entities)).toBe(true);
          expect(Object.isFrozen(namespaceGraph!.edges)).toBe(true);
          expect(Object.isFrozen(namespaceGraph!.episodes)).toBe(true);
          expect(Object.isFrozen(namespaceGraph!.automatic_operations_v1)).toBe(true);
          expect(Object.isFrozen(namespaceGraph!.automatic_operations_v1!.operations)).toBe(true);
          expect(namespaceGraph!.entities.every(Object.isFrozen)).toBe(true);
          expect(namespaceGraph!.edges.every(Object.isFrozen)).toBe(true);
          expect(namespaceGraph!.episodes.every(Object.isFrozen)).toBe(true);
          expect(namespaceGraph!.automatic_operations_v1!.operations.every(Object.isFrozen)).toBe(
            true,
          );
          // Both accessors project the reader's single owned DATA snapshot; they do not read or
          // mutate storage and do not allocate a second checked index.
          expect(snapshot.spy).toHaveBeenCalledTimes(1);
          expect(indices.spy).toHaveBeenCalledTimes(1);
        } finally {
          closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
        }
      }
      if (result.kind === 'reader_ready') {
        expect(
          getAutonomousPersonalMemoryParentReceiptSummaryV4(fixture.store, result.reader),
        ).toBeNull();
        expect(
          getAutonomousPersonalMemoryParentNamespaceGraphV4(fixture.store, result.reader),
        ).toBeNull();
      }
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(indices.spy).toHaveBeenCalledTimes(1);
      const graphAfterRead = await fixture.store.exportGraph(seed.request.namespace);
      expectRowsUnchanged(fixture.graphBeforeRead, graphAfterRead);
      expectRowsUnchanged(beforeAccessors, await fixture.store.exportGraph());
    },
  );

  it('qualifies an earlier real Claim3 from the same Neo4j index under a later no-claim parent', async () => {
    const earlier = await createParent({ profile: 'conservative', intent: 'disabled' });
    expect(earlier.operation.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
    const priorReceipt = earlier.operation.terminalReceipt;
    if (
      priorReceipt.kind !== 'human_autonomous_capture_committed' ||
      priorReceipt.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected the real earlier accepted occurrence receipt');
    }
    const created = priorReceipt.selection.items.find(
      (item) => item.effect === 'created' && item.claimId !== null,
    );
    if (!created?.claimId) throw new Error('Expected the earlier real Claim3 identifier');

    const later = await createParent({
      profile: 'explicit',
      intent: 'disabled',
      provider: 'unexpected',
    });
    expect(later.operation.terminalReceipt.kind).toBe('human_autonomous_source_verdict_committed');
    expect(claimEdges(later.graphBeforeRead, seed.request.namespace)).toHaveLength(1);
    const snapshot = watchSnapshot(later.store);
    const indices = watchIndexConstruction();
    const resources = readResources();
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      later.store,
      later.lineage,
      later.config,
      resources,
    );
    expect(result.kind).toBe('reader_ready');
    expect(snapshot.spy).toHaveBeenCalledTimes(1);
    expect(indices.spy).toHaveBeenCalledTimes(1);
    expect(indices.created).toHaveLength(1);
    if (result.kind !== 'reader_ready') return;
    try {
      const actualSnapshot = snapshot.actual;
      const index = indices.created[0];
      if (!actualSnapshot || actualSnapshot.status !== 'snapshot' || !index) {
        throw new Error('Expected the one actual Neo4j snapshot and its checked index');
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

      const compact = readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
        later.store,
        result.reader,
        created.claimId,
      );
      expect(compact).not.toBeNull();
      if (!compact) throw new Error('Expected the fixed older compact Claim3 candidate');
      expect(
        AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(compact)
          .success,
      ).toBe(true);
      expect(compact.proof).toMatchObject({
        claimId: created.claimId,
        sourceId: earlier.operation.identity.sourceId,
        operationId: earlier.operation.operationId,
        reviewState: 'accepted',
      });
      expect(compact.proof.sourceId).not.toBe(later.operation.identity.sourceId);
      expect(compact.proof.operationId).not.toBe(later.operation.operationId);
      expect(compact.terminalAt).toBe(priorReceipt.terminalAt);
      expect(compact.terminalAt).not.toBe(compact.proof.createdAt);
      const namespaceGraph = getAutonomousPersonalMemoryParentNamespaceGraphV4(
        later.store,
        result.reader,
      );
      expect(namespaceGraph).not.toBeNull();
      const actualEdge = namespaceGraph!.edges.find((edge) => edge.uuid === created.claimId);
      if (!actualEdge) throw new Error('Expected earlier Claim3 edge in the same checked root');
      const actualSubject = namespaceGraph!.entities.find(
        (entity) => entity.uuid === actualEdge.source_node_uuid,
      );
      const actualValue = namespaceGraph!.entities.find(
        (entity) => entity.uuid === actualEdge.target_node_uuid,
      );
      if (!actualSubject || !actualValue) {
        throw new Error('Expected actual earlier candidate endpoints in the same checked root');
      }
      expect(compact.rowHash).toBe(
        hashAutomaticCaptureV2({
          edge: actualEdge,
          subject: actualSubject,
          value: actualValue,
        }),
      );
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(indices.created).toHaveLength(1);
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(later.store, result.reader);
    }
    expect(indices.created).toHaveLength(1);
    expectRowsUnchanged(
      later.graphBeforeRead,
      await later.store.exportGraph(seed.request.namespace),
    );
  }, 30_000);

  it('rejects wrong locator before a snapshot, and checks current query only after one snapshot', async () => {
    const fixture = await createParent();
    const snapshot = watchSnapshot(fixture.store);
    const wrongLocator = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      { ...fixture.config, sourceId: randomUUID() },
      readResources(),
    );
    expectRejected(wrongLocator, 'parent_mismatch');
    expect(snapshot.spy).not.toHaveBeenCalled();

    const wrongQuery = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      { ...fixture.config, currentHumanQuery: 'I prefer different explanations.' },
      readResources(),
    );
    expectRejected(wrongQuery, 'parent_mismatch');
    expect(snapshot.spy).toHaveBeenCalledTimes(1);
    expectRowsUnchanged(
      fixture.graphBeforeRead,
      await fixture.store.exportGraph(seed.request.namespace),
    );
  });

  it.each(['source-review-rejection', 'binding-revocation'] as const)(
    'rejects current Neo4j authority after %s without changing parent rows',
    async (axis) => {
      const fixture = await createParent();
      if (axis === 'source-review-rejection') {
        await fixture.store.updateEpisode(fixture.sourceId, { review_status: 'rejected' });
      } else {
        const revoked = await fixture.store.automaticBindingCommand!({
          action: 'revoke',
          namespace: seed.request.namespace,
          bindingId: seed.binding.bindingId,
          expectedRevision: seed.binding.revision,
          authorizedBy: 'synthetic-neo-parent-reader-test',
          reason: 'Exercise native parent binding revocation',
        });
        expect(revoked.state).toBe('revoked');
      }
      const beforeRead = await fixture.store.exportGraph(seed.request.namespace);
      const snapshot = watchSnapshot(fixture.store);
      const result = await openAutonomousPersonalMemoryParentReaderV4(
        fixture.store,
        fixture.lineage,
        fixture.config,
        readResources(),
      );
      expectRejected(result, 'authority_changed');
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expectRowsUnchanged(beforeRead, await fixture.store.exportGraph(seed.request.namespace));
      if (axis === 'source-review-rejection') {
        expect(
          (await fixture.store.exportGraph(seed.request.namespace)).episodes.find(
            (episode) => episode.uuid === fixture.sourceId,
          )?.review_status,
        ).toBe('rejected');
      }
    },
  );

  it('rejects a backend clock regression after one actual read and preserves every stored row', async () => {
    const fixture = await createParent();
    const original = fixture.store.readCompositionalRetrievalSnapshotV3.bind(fixture.store);
    const snapshotSpy = jest
      .spyOn(fixture.store, 'readCompositionalRetrievalSnapshotV3')
      .mockImplementation(async (scope) => {
        const result = await original(scope);
        if (result.status !== 'snapshot') return result;
        const backendNow = new Date(
          Date.parse(fixture.operation.terminalReceipt.terminalAt) - 1_000,
        ).toISOString();
        return { ...result, backendNow } as CompositionalRetrievalSnapshotResultV3;
      });
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      readResources(),
    );
    expectRejected(result, 'clock_regression');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expectRowsUnchanged(
      fixture.graphBeforeRead,
      await fixture.store.exportGraph(seed.request.namespace),
    );
  });

  it('keeps a Neo4j reader live until its original signal aborts, without changing stored rows', async () => {
    const fixture = await createParent();
    const controller = new AbortController();
    const snapshot = watchSnapshot(fixture.store);
    const result = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      readResources(controller.signal),
    );
    expect(result.kind).toBe('reader_ready');
    expect(snapshot.spy).toHaveBeenCalledTimes(1);
    if (result.kind !== 'reader_ready') return;
    try {
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(true);
      controller.abort();
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(
        false,
      );
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader);
    }
    expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, result.reader)).toBe(false);
    expectRowsUnchanged(
      fixture.graphBeforeRead,
      await fixture.store.exportGraph(seed.request.namespace),
    );
  });

  // Scope: one actual Neo4j parent through the compatibility bridge. Mixed legacy-family
  // coverage (V1, Source3/Claim2, general rows) lives only in the Graphology compatibility suite.
  it('loads the V4 compatibility reader from the actual Neo4j parent with the original budget and signal', async () => {
    const fixture = await createParent();
    expect(claimEdges(fixture.graphBeforeRead, seed.request.namespace)).toHaveLength(1);
    const controller = new AbortController();
    const budget: SourceHydrationBudget = { remaining: 512, deferred: 0 };
    const scope: AutomaticClaimReadScope = getAutomaticClaimReadScope(budget);
    const work: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal: controller.signal,
    });
    const foreignOwner = await openStore();
    const snapshot = watchSnapshot(fixture.store);
    const foreignSnapshot = watchSnapshot(foreignOwner);
    const indices = watchIndexConstruction();

    const opened = await openAutonomousPersonalMemoryParentReaderV4(
      fixture.store,
      fixture.lineage,
      fixture.config,
      { scope, work, check: jest.fn() },
    );
    expect(opened.kind).toBe('reader_ready');
    if (opened.kind !== 'reader_ready') return;
    try {
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(snapshot.actual?.status).toBe('snapshot');
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(indices.created).toHaveLength(1);
      const budgetAfterOpen = budget.remaining;
      const attemptsAfterOpen = getAutomaticClaimReadScopeRemaining(scope)!.attemptsRemaining;

      const loaded = await loadCompositionalCompatibilityRuntimeReaderV4(
        fixture.store,
        opened.reader,
        budget,
      );
      expect(loaded.status).toBe('ready');
      if (loaded.status !== 'ready') throw new Error('Expected the compatibility reader');

      // The bridge reuses the parent's one Neo4j snapshot and B1b index; it charges only the
      // one additional attempt (four source hydrations) from the exact original budget.
      expect(snapshot.spy).toHaveBeenCalledTimes(1);
      expect(foreignSnapshot.spy).not.toHaveBeenCalled();
      expect(indices.spy).toHaveBeenCalledTimes(1);
      expect(indices.created).toHaveLength(1);
      expect(budget.remaining).toBe(budgetAfterOpen - 4);
      expect(getAutomaticClaimReadScopeRemaining(scope)!.attemptsRemaining).toBe(
        attemptsAfterOpen - 1,
      );

      expect(isLiveCompositionalRuntimeReaderV3(loaded.reader)).toBe(true);
      expect(
        isCompositionalCompatibilityRuntimeReaderV4(fixture.store, opened.reader, loaded.reader),
      ).toBe(true);
      expect(
        isCompositionalCompatibilityRuntimeReaderV4(foreignOwner, opened.reader, loaded.reader),
      ).toBe(false);

      const namespaceData = getCompositionalRuntimeNamespaceDataV3(loaded.reader);
      expect(namespaceData.status).toBe('namespace_data');
      if (namespaceData.status !== 'namespace_data') {
        throw new Error('Expected same-root namespace DATA');
      }
      const before = fixture.graphBeforeRead;
      expect(
        namespaceData.graph.episodes.find((episode) => episode.uuid === fixture.sourceId),
      ).toBeDefined();
      expect(sortedRows(namespaceData.graph.edges)).toEqual(
        sortedRows(before.edges.filter((row) => row.group_id === fixture.config.namespace)),
      );
      expect(sortedRows(namespaceData.graph.episodes)).toEqual(
        sortedRows(before.episodes.filter((row) => row.group_id === fixture.config.namespace)),
      );
      expect(claimEdges(namespaceData.graph, fixture.config.namespace)).toHaveLength(1);
      expect(snapshot.spy).toHaveBeenCalledTimes(1);

      // Aborting the original signal stops the compatibility reader as DATA, with no read.
      controller.abort();
      expect(
        isCompositionalCompatibilityRuntimeReaderV4(fixture.store, opened.reader, loaded.reader),
      ).toBe(false);
      expect(isLiveCompositionalRuntimeReaderV3(loaded.reader)).toBe(false);
      expect(isLiveAutonomousPersonalMemoryParentReaderV4(fixture.store, opened.reader)).toBe(
        false,
      );
    } finally {
      closeAutonomousPersonalMemoryParentReaderV4(fixture.store, opened.reader);
    }
    expect(snapshot.spy).toHaveBeenCalledTimes(1);
    expect(foreignSnapshot.spy).not.toHaveBeenCalled();
    expect(indices.spy).toHaveBeenCalledTimes(1);
    expectRowsUnchanged(
      fixture.graphBeforeRead,
      await fixture.store.exportGraph(seed.request.namespace),
    );
  });

  async function issueFinal(
    fixture: ParentFixture,
    content = 'Synthetic final reply.',
    signal = new AbortController().signal,
  ) {
    const profile = fixture.config.profileId;
    if (profile !== 'conservative' && profile !== 'explicit') throw new Error('Unexpected profile');
    const context = memoryContextFor(
      fixture.turn,
      fixture.native,
      fixture.operation.identity,
      profile,
      fixture.config.explicitIntent ? 'enabled' : 'disabled',
    );
    const admission = readReplaySafeMemoryNativeContext(context as IExecuteFunctions, 0);
    if (!admission) throw new Error('Expected actual synthetic Memory native admission');
    const intent = {
      version: 4,
      purpose: 'assistant_final_save',
      humanObservation: { kind: 'configured_query' },
      memoryAttemptHash: admission.processingAttemptHash,
      invocationDeadlineMs: fixture.config.invocationDeadlineMs,
      finalAssistant: {
        content,
        sourceMessageId: null,
        conversationId: null,
        senderId: null,
        senderName: null,
        sourceWorkflowId: null,
        originalSourceExecutionId: null,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
      },
    };
    const token = await issueAutonomousPersonalAssistantFinalInvocationV4(
      fixture.store,
      fixture.lineage,
      intent,
      async () => ({
        config: await readAutonomousPersonalNativeMemoryConfigV4(
          context,
          0,
          neo4jAutomaticCaptureStoreHash(uri!, database),
        ),
        memoryAttemptHash: admission.processingAttemptHash,
      }),
      {
        absoluteMonotonicDeadlineMs: performance.now() + 30_000,
        signal,
      },
      () => {},
    );
    if (!token) throw new Error('Expected genuine owner-bound final invocation');
    return token;
  }

  it.each([
    { profile: 'conservative', provider: 'success', intent: 'disabled' },
    { profile: 'conservative', provider: 'unavailable', intent: 'disabled' },
    { profile: 'explicit', provider: 'unexpected', intent: 'disabled' },
  ] as const)(
    'atomically saves one assistant final for $provider parent and reuses semantic replay',
    async (options) => {
      const fixture = await createParent(options);
      const before = await fixture.store.exportGraph(seed.request.namespace);
      const result = await fixture.store.saveAssistantFinalV4(await issueFinal(fixture));
      expect(result.kind).toBe('committed');
      if (result.kind !== 'committed') throw new Error('Expected known durable final commit');
      expect(result.currentAuthority).toBe('active');
      const after = await fixture.store.exportGraph(seed.request.namespace);
      const addedEpisodes = after.episodes.filter(
        (row) => !before.episodes.some((prior) => prior.uuid === row.uuid),
      );
      expect(addedEpisodes).toHaveLength(1);
      expect(addedEpisodes[0]).toMatchObject({
        uuid: result.terminalReceipt.sourceId,
        role: 'ai',
        episode_kind: 'assistant_reply',
        content: 'Synthetic final reply.',
        previous_episode_uuid: fixture.sourceId,
      });
      const addedOperations = (after.automatic_operations_v1?.operations ?? []).filter(
        (row) =>
          !(before.automatic_operations_v1?.operations ?? []).some(
            (prior) => prior.operationId === row.operationId,
          ),
      );
      expect(addedOperations).toHaveLength(1);
      expect(addedOperations[0]).toMatchObject({
        version: 2,
        state: 'committed',
        terminalReceipt: result.terminalReceipt,
        descriptor: {
          assistantWriteAuthority: {
            kind: 'owned_human_turn_v4',
            parentOperationId: fixture.operation.operationId,
            sourceId: fixture.sourceId,
          },
        },
      });
      const originalProjection = {
        ...after,
        episodes: after.episodes.filter((row) =>
          before.episodes.some((prior) => prior.uuid === row.uuid),
        ),
        automatic_operations_v1: {
          version: 1 as const,
          operations: (after.automatic_operations_v1?.operations ?? []).filter((row) =>
            (before.automatic_operations_v1?.operations ?? []).some(
              (prior) => prior.operationId === row.operationId,
            ),
          ),
        },
      };
      expectRowsUnchanged(before, originalProjection);
      const replay = await fixture.store.saveAssistantFinalV4(await issueFinal(fixture));
      expect(replay).toMatchObject({
        kind: 'committed_replay',
        terminalReceipt: result.terminalReceipt,
      });
      expectRowsUnchanged(after, await fixture.store.exportGraph(seed.request.namespace));
      const conflict = await fixture.store.saveAssistantFinalV4(
        await issueFinal(fixture, 'A changed final reply.'),
      );
      expect(conflict).toMatchObject({ kind: 'decision', reason: 'conflict' });
      expectRowsUnchanged(after, await fixture.store.exportGraph(seed.request.namespace));
    },
  );

  it('rejects a revoked source after issuance and a cancelled original invocation before any write', async () => {
    const fixture = await createParent({ profile: 'explicit', provider: 'unexpected' });
    const cancelled = new AbortController();
    const cancelledToken = await issueFinal(fixture, 'Cancelled reply.', cancelled.signal);
    cancelled.abort();
    expect(await fixture.store.saveAssistantFinalV4(cancelledToken)).toMatchObject({
      kind: 'decision',
      reason: 'interrupted',
    });
    expectRowsUnchanged(
      fixture.graphBeforeRead,
      await fixture.store.exportGraph(seed.request.namespace),
    );
    const token = await issueFinal(fixture);
    await fixture.store.updateEpisode(fixture.sourceId, { review_status: 'rejected' });
    const revoked = await fixture.store.exportGraph(seed.request.namespace);
    expect(await fixture.store.saveAssistantFinalV4(token)).toMatchObject({
      kind: 'decision',
      reason: 'authority_changed',
    });
    expectRowsUnchanged(revoked, await fixture.store.exportGraph(seed.request.namespace));
  });

  it.each(['recover', 'cancel_readback', 'revoke_parent'] as const)(
    'never resubmits an actual committed writer after lost ACK (%s)',
    async (mode) => {
      const fixture = await createParent({ profile: 'explicit', provider: 'unexpected' });
      const controller = new AbortController();
      const token = await issueFinal(fixture, 'ACK recovery reply.', controller.signal);
      const internals = fixture.store as unknown as { driver: Driver };
      const originalSession = internals.driver.session.bind(internals.driver);
      const sessions = jest.spyOn(internals.driver, 'session');
      const writeSessions: Session[] = [];
      const transactionTimeouts: Array<{
        phase: 'writer' | 'readback';
        timeout: DriverTransactionTimeout | undefined;
      }> = [];
      let writerTransactions = 0;
      let readbackTransactions = 0;
      sessions.mockImplementation((config) => {
        const session = originalSession(config);
        if (config?.defaultAccessMode !== neo4j.session.WRITE) return session;

        writeSessions.push(session);
        const phase = writeSessions.length === 1 ? 'writer' : 'readback';
        const beginTransaction = session.beginTransaction.bind(session);
        jest.spyOn(session, 'beginTransaction').mockImplementation((transactionConfig) => {
          if (phase === 'writer') writerTransactions += 1;
          else readbackTransactions += 1;
          transactionTimeouts.push({ phase, timeout: transactionConfig?.timeout });
          const transaction = beginTransaction(transactionConfig);
          if (phase === 'writer') {
            const commit = transaction.commit.bind(transaction);
            jest.spyOn(transaction, 'commit').mockImplementation(async () => {
              await commit();
              // The real transaction committed; only its outer acknowledgement is lost.
              if (mode === 'cancel_readback') controller.abort();
              if (mode === 'revoke_parent') {
                await fixture.store.updateEpisode(fixture.sourceId, { review_status: 'rejected' });
              }
              throw new Error('Synthetic lost assistant commit acknowledgement');
            });
          }
          return transaction;
        });
        return session;
      });
      const result = await fixture.store.saveAssistantFinalV4(token);
      expect(writerTransactions).toBe(1);
      expect(readbackTransactions).toBe(mode === 'cancel_readback' ? 0 : 1);
      expect(transactionTimeouts.filter(({ phase }) => phase === 'writer')).toHaveLength(1);
      expect(transactionTimeouts.filter(({ phase }) => phase === 'readback')).toHaveLength(
        mode === 'cancel_readback' ? 0 : 1,
      );
      const writerTimeout = transactionTimeouts.find(({ phase }) => phase === 'writer')?.timeout;
      const timeoutMs = (timeout: DriverTransactionTimeout | undefined): number => {
        if (typeof timeout === 'number') return timeout;
        if (typeof timeout === 'bigint') return Number(timeout);
        if (neo4j.isInt(timeout)) return timeout.toNumber();
        throw new Error('Expected a finite Neo4j transaction timeout');
      };
      const writerTimeoutMs = timeoutMs(writerTimeout);
      expect(writerTimeoutMs).toBeGreaterThan(0);
      expect(writerTimeoutMs).toBeLessThanOrEqual(5_000);
      const readbackTimeout = transactionTimeouts.find(
        ({ phase }) => phase === 'readback',
      )?.timeout;
      if (readbackTimeout !== undefined) {
        const readbackTimeoutMs = timeoutMs(readbackTimeout);
        expect(readbackTimeoutMs).toBeGreaterThan(0);
        expect(readbackTimeoutMs).toBeLessThanOrEqual(5_000);
        expect(readbackTimeoutMs).toBeLessThanOrEqual(writerTimeoutMs);
      }
      if (mode === 'recover') {
        expect(result).toMatchObject({
          kind: 'committed',
          invocation: 'same_call_ack_recovered',
          currentAuthority: 'active',
        });
      } else {
        expect(result).toMatchObject({ kind: 'decision', reason: 'acknowledgement_unknown' });
      }
      const writeRoutedSessions = sessions.mock.calls.filter(
        ([config]) =>
          config !== null &&
          typeof config === 'object' &&
          config.defaultAccessMode === neo4j.session.WRITE,
      );
      expect(writeRoutedSessions).toHaveLength(mode === 'cancel_readback' ? 1 : 2);
      const after = await fixture.store.exportGraph(seed.request.namespace);
      expect(
        after.episodes.filter((row) => row.role === 'ai' && row.content === 'ACK recovery reply.'),
      ).toHaveLength(1);
      expect(
        (after.automatic_operations_v1?.operations ?? []).filter(
          (row) => row.identity.role === 'assistant' && row.state === 'committed',
        ),
      ).toHaveLength(1);
    },
  );
});
