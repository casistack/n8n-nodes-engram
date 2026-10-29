import neo4j, { type Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';
import { EngramChatMessageHistory } from '../../src/memory/EngramChatMessageHistory';
import {
  AutonomousPersonalNativeMemoryAdapterV4Error,
  closeAutonomousPersonalNativeMemoryAdapterV4,
  closePreparedAutonomousPersonalNativeMemoryAdapterV4,
  consumeAutonomousPersonalNativeMemoryAdapterV4,
  prepareNativeAutonomousPersonalMemoryAdapterV4,
  type AutonomousPersonalNativeMemoryAdapterContextV4,
  type PrivateAutonomousPersonalNativeMemoryAdapterTokenV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryAdapterV4';
import {
  openAutonomousPersonalMemoryReadV4,
  readAutonomousPersonalConversationV4,
  type AutonomousPersonalMemoryReadFrameV4,
} from '../../src/memory/AutonomousPersonalMemoryReadV4';
import { getAutonomousPersonalMemoryParentReadStopV4 } from '../../src/memory/AutonomousPersonalMemoryParentReaderV4';
import { publishAutonomousPersonalMemoryHandoffV4 } from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import { ExtractionBudgetError } from '../../src/extraction/ExtractionDiagnostics';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { neo4jAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import * as PersonalRecordIntegrity from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { HybridSearchEngine } from '../../src/search/HybridSearchEngine';
import type { GraphData } from '../../src/schemas/GraphData.schema';
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
const currentSource = 'I prefer concise explanations.';
const rawJsonHuman = '{"genuine":"human JSON stays conversation history"}';

type Seed = Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;
type Fixture = {
  readonly controller: AbortController;
  readonly memory: object;
  readonly namespace: string;
  readonly owner: Neo4jStorage;
  readonly sourceId: string;
  readonly turn: string;
  readonly token: PrivateAutonomousPersonalNativeMemoryAdapterTokenV4;
};
type PendingToken = {
  readonly owner: Neo4jStorage;
  readonly token: PrivateAutonomousPersonalNativeMemoryAdapterTokenV4;
};

const sortedRows = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).sort();

describeNeo('actual Neo4j Autonomous Personal Memory read V4', () => {
  let driver: Driver | undefined;
  let store: Neo4jStorage | undefined;
  let seed: Seed;
  let namespaces: string[] = [];
  let openStores: Neo4jStorage[] = [];
  let providerBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fixtures: Fixture[] = [];
  const frames: AutonomousPersonalMemoryReadFrameV4[] = [];
  const pendingTokens: PendingToken[] = [];

  const createStore = () => new Neo4jStorage(uri!, username, password, database);

  const openStore = async () => {
    const candidate = createStore();
    openStores.push(candidate);
    await candidate.initialize();
    return candidate;
  };

  const closeStore = async (candidate: Neo4jStorage) => {
    if (!openStores.includes(candidate)) return;
    openStores = openStores.filter((entry) => entry !== candidate);
    await candidate.close();
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
    jest.restoreAllMocks();
    for (const frame of frames.splice(0)) frame.close();
    for (const fixture of fixtures.splice(0)) {
      closeAutonomousPersonalNativeMemoryAdapterV4(fixture.memory);
    }
    for (const pending of pendingTokens.splice(0)) {
      closePreparedAutonomousPersonalNativeMemoryAdapterV4(pending.owner, pending.token);
    }

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
      throw Object.assign(new Error('Neo4j native Memory read test cleanup failed'), { errors });
    }
  });

  function installProvider() {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      providerBodies.push(body);
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

  async function appendConversation(namespace: string): Promise<void> {
    if (!store) throw new Error('Expected initialized source storage');
    await store.appendEpisodes([
      {
        group_id: namespace,
        role: 'human',
        content: 'An older conversation turn.',
        episode_kind: 'active_human',
        reference_time: '2026-10-24T09:00:00.000Z',
      },
      {
        group_id: namespace,
        role: 'ai',
        content: 'An older answer.',
        episode_kind: 'assistant_reply',
        reference_time: '2026-10-24T09:01:00.000Z',
      },
      {
        group_id: namespace,
        role: 'human',
        content: rawJsonHuman,
        episode_kind: 'active_human',
        reference_time: '2026-10-24T10:00:00.000Z',
      },
      {
        group_id: namespace,
        role: 'ai',
        content: 'Earlier answer in this conversation.',
        episode_kind: 'assistant_reply',
        reference_time: '2026-10-24T10:01:00.000Z',
      },
      {
        group_id: namespace,
        role: 'system',
        content: 'Synthetic tool audit that must stay out of history.',
        episode_kind: 'tool_output',
        reference_time: '2026-10-24T10:02:00.000Z',
        trust_level: 'unverified',
        review_status: 'proposed',
        attributes: { engram_audit: true },
      },
    ]);
  }

  function memoryContextFor(
    turn: string,
    native: { readonly instance: string; readonly workflow: string; readonly execution: string },
    namespace: string,
    sourceId: string,
    controller: AbortController,
    intent: 'enabled' | 'disabled',
  ): AutonomousPersonalNativeMemoryAdapterContextV4 {
    const parameters: Record<string, unknown> = {
      backend: 'neo4j',
      sessionIdType: 'customKey',
      sessionKey: namespace,
      extractionExecution: 'synchronous',
      currentHumanQuery: currentSource,
      automaticMemoryProfile: 'explicit',
      automaticIssuer: seed.request.issuer,
      automaticActor: seed.request.actorReference,
      automaticTurn: turn,
      automaticIntent: intent,
      automaticRawHuman: '',
      automaticWrapper: 'disabled',
      automaticCapturedSource: sourceId,
      advancedExtractionPolicy: 'bounded',
      knowledgeSelection: 'durableTemporal',
      extractionRequestLimit: 2,
      extractionDeadlineMs: 30_000,
      extractionRouteId: 'route:synthetic',
      extractionModel: 'model:synthetic-memory',
      extractionTemperatureMode: 'providerDefault',
    };
    return {
      getNode: () => ({
        id: 'synthetic-neo-native-memory-read',
        type: 'n8n-nodes-engram.engramMemory',
        typeVersion: 3,
        parameters: {
          backend: 'neo4j',
          automaticCaptureLifecycle: 'replaySafeV2',
          automaticPreferenceInterpreter: 'autonomousPersonalV1',
        },
        continueOnFail: false,
        onError: 'stopWorkflow',
      }),
      getNodeParameter: (name: string, _itemIndex: number, fallback: unknown) =>
        Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
      getInputData: () => [{ json: { sessionId: namespace } }],
      getExecutionId: () => native.execution,
      getWorkflow: () => ({ id: native.workflow }),
      getInstanceId: () => native.instance,
      getCredentials: async (name: string) => {
        if (name === 'engramNeo4jApi') return { uri, username, password, database };
        if (name === 'engramExtractionApi') {
          return { apiKey: 'synthetic-only-key', baseUrl: 'https://memory.invalid/v1' };
        }
        throw new Error(`Unexpected synthetic credential request: ${name}`);
      },
      evaluateExpression: () => namespace,
      getExecutionCancelSignal: () => controller.signal,
    } as unknown as AutonomousPersonalNativeMemoryAdapterContextV4;
  }

  async function createFixture(
    options: {
      readonly intent?: 'enabled' | 'disabled';
      readonly conversation?: boolean;
    } = {},
  ): Promise<Fixture> {
    if (!store) throw new Error('Expected initialized source storage');
    const intent = options.intent ?? 'disabled';
    const turn = `neo-memory-read:${randomUUID()}`;
    const native = {
      instance: `neo-memory-read-instance:${turn}`,
      workflow: `neo-memory-read-workflow:${turn}`,
      execution: `neo-memory-read-execution:${turn}`,
    };
    if (options.conversation) await appendConversation(seed.request.namespace);

    const sourceContext = nativeAutonomousPersonalCaptureContext(seed, {
      executionId: native.execution,
      workflowId: native.workflow,
      instanceId: native.instance,
      deadlineMs: 30_000,
      content: currentSource,
      routeId: 'route:synthetic',
      model: 'model:synthetic-memory',
      requestLimit: 2,
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: intent,
        automaticTurn: turn,
      },
    });
    if (intent === 'enabled') installProvider();
    const completed = await completeNativeAutonomousPersonalCaptureV4(sourceContext, store);
    if (completed.kind !== 'original_turn') {
      throw new Error(`Expected genuine Neo4j C2 completion, received ${completed.kind}`);
    }
    if (intent === 'enabled') expect(providerBodies).toHaveLength(1);
    else expect(providerBodies).toHaveLength(0);

    const sourceGraph = await store.exportGraph(seed.request.namespace);
    const operation = (sourceGraph.automatic_operations_v1?.operations ?? []).find(
      (candidate) =>
        candidate.version === 4 &&
        candidate.state === 'committed' &&
        candidate.identity.turn === turn,
    );
    if (!operation || operation.version !== 4 || operation.state !== 'committed') {
      throw new Error('Expected the genuine committed Operation4');
    }
    const sourceEpisode = sourceGraph.episodes.find(
      (episode) => episode.uuid === operation.identity.sourceId,
    );
    expect(sourceEpisode).toMatchObject({
      uuid: operation.identity.sourceId,
      role: 'human',
      episode_kind: 'active_human',
      content: currentSource,
    });

    const published = publishAutonomousPersonalMemoryHandoffV4(
      sourceContext,
      store,
      completed.origin,
    );
    expect(published).toEqual({ kind: 'published', sourceId: operation.identity.sourceId });
    if (published.kind !== 'published') throw new Error('Expected native handoff publication');

    await closeStore(store);
    store = await openStore();
    expect(operation.identity.storeHash).toBe(neo4jAutomaticCaptureStoreHash(uri!, database));
    const controller = new AbortController();
    const memory = {};
    const context = memoryContextFor(
      turn,
      native,
      seed.request.namespace,
      published.sourceId,
      controller,
      intent,
    );
    const token = await prepareNativeAutonomousPersonalMemoryAdapterV4(context, 0, store);
    pendingTokens.push({ owner: store, token });
    expect(consumeAutonomousPersonalNativeMemoryAdapterV4(store, token, memory)).toBe(true);

    const fixture = {
      controller,
      memory,
      namespace: seed.request.namespace,
      owner: store,
      sourceId: published.sourceId,
      turn,
      token,
    };
    fixtures.push(fixture);
    return fixture;
  }

  async function openFrame(fixture: Fixture): Promise<AutonomousPersonalMemoryReadFrameV4> {
    const result = await openAutonomousPersonalMemoryReadV4(fixture.memory);
    if (result.kind !== 'read_ready') {
      throw new Error(`Expected actual Neo4j read frame, got rejected:${result.reason}`);
    }
    frames.push(result.frame);
    return result.frame;
  }

  function memoryHistory(fixture: Fixture, frame: AutonomousPersonalMemoryReadFrameV4) {
    const history = new EngramChatMessageHistory({
      storage: fixture.owner,
      groupId: fixture.namespace,
      contextWindow: 2,
      humanEpisodeKind: 'active_human',
      policy: { historyFilter: 'provenance', finalTurnWrites: true },
    });
    const forbiddenGuard = jest.fn(async () => {
      throw new Error('native snapshot delegate must own the history read');
    });
    history.setReadGuard(forbiddenGuard);
    history.setSnapshotReadProvider(() =>
      readAutonomousPersonalConversationV4(frame, {
        contextWindow: 2,
        humanEpisodeKind: 'active_human',
        policy: { historyFilter: 'provenance', finalTurnWrites: true },
      }),
    );
    return { forbiddenGuard, history };
  }

  function expectStoredRowsUnchanged(before: GraphData, after: GraphData) {
    expect(sortedRows(after.entities)).toEqual(sortedRows(before.entities));
    expect(sortedRows(after.edges)).toEqual(sortedRows(before.edges));
    expect(sortedRows(after.episodes)).toEqual(sortedRows(before.episodes));
    expect(sortedRows(after.automatic_operations_v1?.operations ?? [])).toEqual(
      sortedRows(before.automatic_operations_v1?.operations ?? []),
    );
  }

  it('opens one checked Neo4j snapshot and serves staged graph/history without changing source rows', async () => {
    installProvider();
    const fixture = await createFixture({ intent: 'enabled', conversation: true });
    const before = await fixture.owner.exportGraph(fixture.namespace);
    const snapshotSpy = jest.spyOn(fixture.owner, 'readCompositionalRetrievalSnapshotV3');
    const backendHistorySpy = jest.spyOn(fixture.owner, 'getRecentEpisodes');
    const indexSpy = jest.spyOn(
      PersonalRecordIntegrity,
      'createIntegrityCheckedAutonomousPersonalClaimIndexV4',
    );
    const engineSpy = jest.spyOn(HybridSearchEngine, 'forAutonomousPersonalMemoryV4');

    const frame = await openFrame(fixture);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(indexSpy).toHaveBeenCalledTimes(1);
    expect(engineSpy).toHaveBeenCalledTimes(1);
    expect(frame.owner).toBe(fixture.owner);
    expect(frame.parentReader).not.toBeNull();
    expect(frame.compatibilityReader).not.toBeNull();
    expect(frame.engine).not.toBeNull();
    expect(frame.storage).not.toBeNull();
    expect(frame.storage).not.toBe(fixture.owner);
    expect(frame.receiptSummary?.kind).toBe('committed');

    const { history, forbiddenGuard } = memoryHistory(fixture, frame);
    const result = await history.getMessagesWithDiagnostics();
    expect(forbiddenGuard).not.toHaveBeenCalled();
    expect(backendHistorySpy).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message._getType())).toEqual(['human', 'ai']);
    expect(result.messages[0]?.content).toBe(rawJsonHuman);
    expect(String(result.messages[1]?.content)).toBe('Earlier answer in this conversation.');
    expect(result.history.excluded_provenance).toBeGreaterThan(0);
    expect(result.history.returned).toBe(2);
    expect(JSON.stringify(result)).not.toContain(currentSource);
    expect(JSON.stringify(result)).not.toContain(fixture.sourceId);
    expect(JSON.stringify(result)).not.toContain('Synthetic tool audit');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);

    const after = await fixture.owner.exportGraph(fixture.namespace);
    expectStoredRowsUnchanged(before, after);
  }, 60_000);

  it.each(['source-review-rejection', 'binding-revocation'] as const)(
    'fails closed on a current Neo4j %s before serving history',
    async (axis) => {
      const fixture = await createFixture();
      if (axis === 'source-review-rejection') {
        await fixture.owner.updateEpisode(fixture.sourceId, { review_status: 'rejected' });
      } else {
        const revoked = await fixture.owner.automaticBindingCommand!({
          action: 'revoke',
          namespace: fixture.namespace,
          bindingId: seed.binding.bindingId,
          expectedRevision: seed.binding.revision,
          authorizedBy: 'synthetic-neo-memory-read-test',
          reason: 'Exercise current native Memory authority revalidation',
        });
        expect(revoked.state).toBe('revoked');
      }
      const beforeRead = await fixture.owner.exportGraph(fixture.namespace);
      const snapshotSpy = jest.spyOn(fixture.owner, 'readCompositionalRetrievalSnapshotV3');
      const backendHistorySpy = jest.spyOn(fixture.owner, 'getRecentEpisodes');

      const result = await openAutonomousPersonalMemoryReadV4(fixture.memory);

      expect(result).toEqual({ kind: 'rejected', reason: 'authority_changed' });
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
      expect(backendHistorySpy).not.toHaveBeenCalled();
      expectStoredRowsUnchanged(beforeRead, await fixture.owner.exportGraph(fixture.namespace));
    },
  );

  it.each(['adapter-close', 'native-cancel'] as const)(
    'does not fall back to backend history after %s',
    async (mode) => {
      const fixture = await createFixture();
      const before = await fixture.owner.exportGraph(fixture.namespace);
      const frame = await openFrame(fixture);
      const parent = frame.parentReader!;
      const snapshotSpy = jest.spyOn(fixture.owner, 'readCompositionalRetrievalSnapshotV3');
      const backendHistorySpy = jest.spyOn(fixture.owner, 'getRecentEpisodes');
      const { history } = memoryHistory(fixture, frame);

      if (mode === 'adapter-close') {
        closeAutonomousPersonalNativeMemoryAdapterV4(fixture.memory);
      } else {
        fixture.controller.abort();
      }

      if (mode === 'adapter-close') {
        await expect(history.getMessagesWithDiagnostics()).rejects.toBeInstanceOf(
          AutonomousPersonalNativeMemoryAdapterV4Error,
        );
      } else {
        await expect(history.getMessagesWithDiagnostics()).rejects.toBeInstanceOf(
          ExtractionBudgetError,
        );
      }
      expect(snapshotSpy).not.toHaveBeenCalled();
      expect(backendHistorySpy).not.toHaveBeenCalled();
      expect(getAutonomousPersonalMemoryParentReadStopV4(fixture.owner, parent)).toBe(
        'invalid_reader',
      );
      expect(frame.storage).toBeNull();
      expectStoredRowsUnchanged(before, await fixture.owner.exportGraph(fixture.namespace));
    },
  );
});
