import neo4j, { type Driver, type Session } from 'neo4j-driver';
import type { GraphData } from '../../src/schemas';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import * as completionHandles from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import * as nativeOriginProjector from '../../src/storage/AutonomousPersonalNativeOriginV4';
import {
  completeNativeAutonomousPersonalCaptureV4,
  consumeAutonomousPersonalOriginalTurnV4,
} from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
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
type NativeResult = Awaited<ReturnType<typeof completeNativeAutonomousPersonalCaptureV4>>;

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const sortedRows = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
const committedOperations = (graph: GraphData) =>
  (graph.automatic_operations_v1?.operations ?? []).filter(
    (operation) => operation.state === 'committed',
  );
const claimEdges = (graph: GraphData, namespace: string) =>
  graph.edges.filter(
    (edge) => edge.group_id === namespace && hasOwn(edge.attributes ?? {}, 'engram_claim_v1'),
  );

describeNeo('native autonomous personal coordinator V4 on Neo4j', () => {
  let driver: Driver | undefined;
  let store: Neo4jStorage;
  let seed: Seed;
  let namespaces: string[] = [];
  let openStores: Neo4jStorage[] = [];
  let preparedHandles: Array<{ owner: IGraphStorage; handle: unknown }> = [];
  let providerBodies: ProviderBody[] = [];

  const createStore = () => new Neo4jStorage(uri!, username, password, database);

  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver!.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };

  const closeStore = async (candidate: Neo4jStorage) => {
    if (!openStores.includes(candidate)) return;
    openStores = openStores.filter((entry) => entry !== candidate);
    await candidate.close();
  };

  beforeEach(async () => {
    namespaces = [];
    openStores = [];
    preparedHandles = [];
    providerBodies = [];
    driver = neo4j.driver(
      uri!.replace('://localhost:', '://127.0.0.1:'),
      neo4j.auth.basic(username, password),
    );
    store = createStore();
    openStores.push(store);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
    namespaces = [seed.request.namespace];
  });

  afterEach(async () => {
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
      for (const { owner, handle } of preparedHandles) {
        await attempt(() => completionHandles.closeAutonomousPersonalCompletionV4(owner, handle));
      }
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
      driver = undefined;
      namespaces = [];
      openStores = [];
      preparedHandles = [];
    }
    if (errors.length > 0) {
      throw Object.assign(new Error('Neo4j coordinator test cleanup failed'), { errors });
    }
  });

  function contextFor(
    turn: string,
    intent: 'enabled' | 'disabled' = 'enabled',
    executionId = `execution:${turn}`,
  ) {
    return nativeAutonomousPersonalCaptureContext(seed, {
      executionId,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content: 'I prefer concise explanations.',
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: intent,
        automaticTurn: turn,
      },
    });
  }

  function installProvider(mode: ProviderMode = 'success') {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (mode === 'unexpected') throw new Error('unexpected_native_provider_dispatch');
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
  }

  function expectProviderDefaultOmitsTemperature() {
    expect(providerBodies.length).toBeGreaterThan(0);
    for (const body of providerBodies) expect(hasOwn(body, 'temperature')).toBe(false);
  }

  /** The hook runs only after real preparation returns, so A1 lease/source writes are untouched. */
  function spyPreparation(afterPrepared?: () => void) {
    const original = completionHandles.prepareNativeAutonomousPersonalCompletionV4;
    return jest
      .spyOn(completionHandles, 'prepareNativeAutonomousPersonalCompletionV4')
      .mockImplementation(async (ctx, owner) => {
        const result = await original(ctx, owner);
        if (result.kind === 'completion_prepared') {
          preparedHandles.push({ owner, handle: result.handle });
          afterPrepared?.();
        }
        return result;
      });
  }

  function spyClose() {
    const original = completionHandles.closeAutonomousPersonalCompletionV4;
    return jest
      .spyOn(completionHandles, 'closeAutonomousPersonalCompletionV4')
      .mockImplementation((owner, handle) => original(owner, handle));
  }

  function overrideParameter(context: object, name: string, value: unknown): void {
    const mutable = context as {
      getNodeParameter: (key: string, index: number, fallback: unknown) => unknown;
    };
    const original = mutable.getNodeParameter.bind(context);
    mutable.getNodeParameter = (key, index, fallback) =>
      key === name ? value : original(key, index, fallback);
  }

  /** Wraps the real native backend; `after` runs once the actual commit has been acknowledged. */
  function wrapBackend(after: () => void) {
    const original = store.completeAutonomousPersonalCaptureForNativeV4!.bind(store);
    return jest
      .spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4')
      .mockImplementation(async (handle) => {
        const token = await original(handle);
        after();
        return token;
      });
  }

  function expectHandleClosed() {
    expect(preparedHandles).toHaveLength(1);
    expect(() =>
      completionHandles.checkAutonomousPersonalCompletionV4(
        preparedHandles[0]!.owner,
        preparedHandles[0]!.handle,
      ),
    ).toThrow('Engram autonomous personal provider: invalid_handle');
  }

  async function expectCommittedGraphRemains(expectedClaims: number) {
    const graph = await store.exportGraph(seed.request.namespace);
    expect(committedOperations(graph)).toHaveLength(1);
    expect(claimEdges(graph, seed.request.namespace)).toHaveLength(expectedClaims);
    return graph;
  }

  function requireOriginalTurn(result: NativeResult) {
    expect(result.kind).toBe('original_turn');
    if (result.kind !== 'original_turn') throw new Error(`Expected original turn: ${result.kind}`);
    return result.origin;
  }

  it.each([
    ['occurrence', 'enabled', 'success', 'human_autonomous_capture_committed', 1],
    [
      'provider-deferred',
      'enabled',
      'unavailable',
      'human_autonomous_source_deferred_committed',
      0,
    ],
    ['source-verdict', 'disabled', 'unexpected', 'human_autonomous_source_verdict_committed', 0],
  ] as const)(
    'issues a one-use opaque original-turn bridge for the real %s committed receipt',
    async (name, intent, providerMode, receiptKind, expectedClaims) => {
      const turn = `neo-coordinator-${name}`;
      const fetchSpy = installProvider(providerMode);
      const preparationSpy = spyPreparation();
      const closeSpy = spyClose();
      const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
      const providerSpy = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
      const backendSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');
      const projectSpy = jest.spyOn(
        nativeOriginProjector,
        'projectAutonomousPersonalNativeOriginV4',
      );

      const result = await completeNativeAutonomousPersonalCaptureV4(
        contextFor(turn, intent),
        store,
      );

      expect(preparationSpy).toHaveBeenCalledTimes(1);
      expect(beginSpy).toHaveBeenCalledTimes(1);
      expect(providerSpy).toHaveBeenCalledTimes(1);
      expect(backendSpy).toHaveBeenCalledTimes(1);
      expect(projectSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      if (providerMode === 'unexpected') expect(fetchSpy).not.toHaveBeenCalled();
      else {
        expect(fetchSpy).toHaveBeenCalled();
        expectProviderDefaultOmitsTemperature();
      }
      expectHandleClosed();

      const token = requireOriginalTurn(result);
      expect(Object.isFrozen(token)).toBe(true);
      expect(Reflect.ownKeys(token)).toEqual([]);
      expect(JSON.stringify(token)).toBe('{}');

      // Foreign, copied, proxied, JSON and reconstructed inputs must not spend the genuine token.
      expect(consumeAutonomousPersonalOriginalTurnV4({}, token)).toBeNull();
      expect(consumeAutonomousPersonalOriginalTurnV4(Object.create(store), token)).toBeNull();
      expect(consumeAutonomousPersonalOriginalTurnV4(store, { ...(token as object) })).toBeNull();
      expect(
        consumeAutonomousPersonalOriginalTurnV4(store, new Proxy(token as object, {})),
      ).toBeNull();
      expect(
        consumeAutonomousPersonalOriginalTurnV4(store, JSON.parse(JSON.stringify(token))),
      ).toBeNull();
      expect(consumeAutonomousPersonalOriginalTurnV4(store, Object.create(null))).toBeNull();
      expect(consumeAutonomousPersonalOriginalTurnV4(store, null)).toBeNull();

      const origin = consumeAutonomousPersonalOriginalTurnV4(store, token);
      expect(origin).not.toBeNull();
      expect(origin).toBe(projectSpy.mock.results[0]?.value);
      expect(Object.isFrozen(origin)).toBe(true);
      expect(origin!.terminalReceipt.kind).toBe(receiptKind);
      expect(origin!.identity.turn).toBe(turn);
      expect(origin!.instance).toBe(`instance:${turn}`);
      expect(origin!.workflow).toBe(`workflow:${turn}`);
      expect(origin!.execution).toBe(`execution:${turn}`);
      expect(consumeAutonomousPersonalOriginalTurnV4(store, token)).toBeNull();

      // Truthful meaning: the bridge matches the actual persisted terminal, with no invented fact.
      const graph = await expectCommittedGraphRemains(expectedClaims);
      const terminal = committedOperations(graph)[0]!;
      expect(terminal.operationId).toBe(origin!.terminalReceipt.operationId);
      if (terminal.version !== 4 || terminal.state !== 'committed')
        throw new Error('Expected a committed V4 operation');
      expect(terminal.identity).toEqual(origin!.identity);
      expect(terminal.terminalReceipt).toEqual(origin!.terminalReceipt);
    },
  );

  it('observes the exact persisted receipt after reopen with a different execution, without redispatch or duplicate rows', async () => {
    const turn = 'neo-coordinator-replay';
    const fetchSpy = installProvider('success');
    const firstPreparation = spyPreparation();
    const first = await completeNativeAutonomousPersonalCaptureV4(contextFor(turn), store);
    const original = consumeAutonomousPersonalOriginalTurnV4(store, requireOriginalTurn(first));
    if (!original) throw new Error('Expected the first owner-bound origin');
    expect(firstPreparation).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    firstPreparation.mockRestore();
    fetchSpy.mockClear();
    fetchSpy.mockImplementation(async () => {
      throw new Error('unexpected_native_provider_dispatch');
    });

    const namespace = seed.request.namespace;
    const before = await store.exportGraph(namespace);
    expect(claimEdges(before, namespace)).toHaveLength(1);
    await closeStore(store);

    store = createStore();
    openStores.push(store);
    await store.initialize();
    const preparationSpy = spyPreparation();
    const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const providerSpy = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const backendSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');

    const replay = await completeNativeAutonomousPersonalCaptureV4(
      contextFor(turn, 'enabled', 'execution:redelivery'),
      store,
    );

    expect(replay).toEqual({
      kind: 'decision',
      result: {
        kind: 'committed_observed',
        terminalReceipt: original.terminalReceipt,
        eligibleFirstCommit: false,
      },
    });
    expect(preparationSpy).toHaveBeenCalledTimes(1);
    expect(beginSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(backendSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Replay may append an operation audit, so compare persisted rows rather than the root graph.
    const after = await store.exportGraph(namespace);
    expect(sortedRows(after.entities)).toEqual(sortedRows(before.entities));
    expect(sortedRows(after.edges)).toEqual(sortedRows(before.edges));
    expect(sortedRows(after.episodes)).toEqual(sortedRows(before.episodes));
    const committedBefore = committedOperations(before);
    const committedAfter = committedOperations(after);
    expect(committedAfter).toHaveLength(1);
    expect(committedAfter[0]!.operationId).toBe(committedBefore[0]!.operationId);
    if (committedAfter[0]!.version !== 4 || committedBefore[0]!.version !== 4)
      throw new Error('Expected committed V4 operations');
    expect(committedAfter[0]!.terminalReceipt).toEqual(original.terminalReceipt);
    expect(committedAfter[0]!.identity).toEqual(committedBefore[0]!.identity);
  });

  it('never issues a bridge after a real commit whose outer executeWrite acknowledgement is lost', async () => {
    installProvider('success');
    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const originalDriverSession = internals.driver.session.bind(internals.driver);
    let managedWrites = 0;
    let readbackSessions = 0;
    let rejectAfterCommit = true;

    // Installed only after the real preparation returns, so lease/source writes are unaffected.
    const preparationSpy = spyPreparation(() => {
      jest.spyOn(internals.driver, 'session').mockImplementation((config) => {
        const session = originalDriverSession(config);
        if (
          config !== undefined &&
          typeof config === 'object' &&
          config.defaultAccessMode === neo4j.session.WRITE
        ) {
          readbackSessions++;
        }
        return session;
      });
      jest.spyOn(internals, 'getSession').mockImplementation(() => {
        const session = originalGetSession();
        const originalExecuteWrite = session.executeWrite.bind(session);
        jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
          managedWrites++;
          const result = await originalExecuteWrite(work, config);
          if (rejectAfterCommit) {
            rejectAfterCommit = false;
            throw new Error('synthetic outer commit acknowledgement loss');
          }
          return result;
        });
        return session;
      });
    });
    const closeSpy = spyClose();
    const backendSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');

    const result = await completeNativeAutonomousPersonalCaptureV4(
      contextFor('neo-coordinator-ack-loss'),
      store,
    );

    expect(result).toEqual({ kind: 'no_origin', observation: { kind: 'unconfirmed' } });
    expect(preparationSpy).toHaveBeenCalledTimes(1);
    expect(backendSpy).toHaveBeenCalledTimes(1);
    expect(managedWrites).toBe(1);
    expect(readbackSessions).toBe(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expectHandleClosed();
    expectProviderDefaultOmitsTemperature();
    // The commit really happened; only the bridge is withheld.
    await expectCommittedGraphRemains(1);
  });

  it.each([
    [
      'profile',
      (context: object) => overrideParameter(context, 'automaticMemoryProfile', 'reviewFirst'),
    ],
    [
      'input',
      (context: object) =>
        overrideParameter(context, 'automaticInput', 'I prefer detailed examples.'),
    ],
    ['model', (context: object) => overrideParameter(context, 'queueModel', 'model:changed')],
    [
      'execution',
      (context: object) => {
        (context as unknown as { getExecutionId: () => string }).getExecutionId = () =>
          'execution:changed';
      },
    ],
  ] as const)(
    'withholds the bridge after a post-backend %s change while the committed graph remains',
    async (name, mutate) => {
      installProvider('success');
      spyPreparation();
      const closeSpy = spyClose();
      const context = contextFor(`neo-coordinator-post-backend-${name}`);
      const backend = wrapBackend(() => mutate(context));

      const result = await completeNativeAutonomousPersonalCaptureV4(context, store);

      expect(result).toEqual({
        kind: 'decision',
        result: { kind: 'authority_changed', eligibleFirstCommit: false },
      });
      expect(backend).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expectHandleClosed();
      await expectCommittedGraphRemains(1);
    },
  );

  it.each(['abort', 'expiry'] as const)(
    'withholds the bridge and cleans up when %s arrives after the native backend',
    async (cause) => {
      const controller = new AbortController();
      const context = Object.assign(contextFor(`neo-coordinator-post-backend-${cause}`), {
        getExecutionCancelSignal: () => controller.signal,
      });
      installProvider('success');
      const closeSpy = spyClose();
      spyPreparation();
      const actualNow = performance.now.bind(performance);
      let nowSpy: jest.SpyInstance | undefined;
      const backend = wrapBackend(() => {
        if (cause === 'abort') controller.abort();
        else nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => actualNow() + 60_000);
      });

      let result: NativeResult;
      try {
        result = await completeNativeAutonomousPersonalCaptureV4(context, store);
      } finally {
        nowSpy?.mockRestore();
      }

      // The registry strips proof on abort/expiry at consume time but keeps matched DATA, so the
      // coordinator normalizes it to unconfirmed. Lifetime decisions belong to pre-backend checks.
      expect(result).toEqual({ kind: 'no_origin', observation: { kind: 'unconfirmed' } });
      expect(backend).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expectHandleClosed();
      await expectCommittedGraphRemains(1);
    },
  );

  it('returns unsupported_mode before any dispatch when the native backend method is absent', async () => {
    const fetchSpy = installProvider('unexpected');
    const preparationSpy = spyPreparation();
    const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const mutable = store as unknown as { completeAutonomousPersonalCaptureForNativeV4?: unknown };
    mutable.completeAutonomousPersonalCaptureForNativeV4 = undefined;
    try {
      await expect(
        completeNativeAutonomousPersonalCaptureV4(contextFor('neo-coordinator-unsupported'), store),
      ).resolves.toEqual({
        kind: 'decision',
        result: { kind: 'unsupported_mode', eligibleFirstCommit: false },
      });
    } finally {
      // Remove the own-property shadow so the prototype method is visible again.
      delete mutable.completeAutonomousPersonalCaptureForNativeV4;
    }
    expect(preparationSpy).not.toHaveBeenCalled();
    expect(beginSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const graph = await store.exportGraph(seed.request.namespace);
    expect(committedOperations(graph)).toHaveLength(0);
  });

  it('propagates an exact backend no_write reason without a bridge or committed rows', async () => {
    installProvider('success');
    spyPreparation();
    const closeSpy = spyClose();
    jest
      .spyOn(nativeOriginProjector, 'projectAutonomousPersonalNativeOriginV4')
      .mockImplementation(() => {
        throw new nativeOriginProjector.AutonomousPersonalNativeOriginV4Error('capacity');
      });

    const result = await completeNativeAutonomousPersonalCaptureV4(
      contextFor('neo-coordinator-no-write'),
      store,
    );

    expect(result).toEqual({
      kind: 'no_origin',
      observation: { kind: 'no_write', reason: 'capacity' },
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expectHandleClosed();
    const graph = await store.exportGraph(seed.request.namespace);
    expect(committedOperations(graph)).toHaveLength(0);
    expect(claimEdges(graph, seed.request.namespace)).toHaveLength(0);
  });
  it('persists a context-qualified literal and refuses a same-event policy switch on actual Neo4j', async () => {
    installProvider('success');
    const literal =
      'Whenever I review a pull request, I prefer a short summary before the detailed diff.';
    const turn = 'neo-context-qualified';
    const make = (enabled: boolean, execution: string) => {
      const ctx = contextFor(turn, 'enabled', execution);
      overrideParameter(ctx, 'automaticInput', literal);
      const node = ctx.getNode();
      ctx.getNode = () => ({
        ...node,
        parameters: {
          ...node.parameters,
          automaticStatementContextMode: enabled ? 'contextQualifiedV1' : 'off',
        },
      });
      return ctx;
    };
    const result = await completeNativeAutonomousPersonalCaptureV4(
      make(true, 'execution:qualified'),
      store,
    );
    const token = requireOriginalTurn(result);
    expect(consumeAutonomousPersonalOriginalTurnV4(store, token)).not.toBeNull();
    const before = await store.exportGraph(seed.request.namespace);
    const claims = claimEdges(before, seed.request.namespace);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!.attributes.engram_claim_v1 as {
      qualification?: string;
      evidence: { literal: string };
    };
    expect(claim.qualification).toBe('context_conditional_v1');
    expect(claim.evidence.literal).toBe(literal);
    expect(claims[0]!.fact).toBe(literal);
    const calls = providerBodies.length;
    const switched = await completeNativeAutonomousPersonalCaptureV4(
      make(false, 'execution:policy-switch'),
      store,
    );
    expect(switched.kind).not.toBe('original_turn');
    expect(providerBodies).toHaveLength(calls);
    const after = await store.exportGraph(seed.request.namespace);
    expect(sortedRows(after.entities)).toEqual(sortedRows(before.entities));
    expect(sortedRows(after.edges)).toEqual(sortedRows(before.edges));
    expect(sortedRows(after.episodes)).toEqual(sortedRows(before.episodes));
    expect(
      committedOperations(after).map((op) => ('terminalReceipt' in op ? op.terminalReceipt : null)),
    ).toEqual(
      committedOperations(before).map((op) =>
        'terminalReceipt' in op ? op.terminalReceipt : null,
      ),
    );
    const reopened = createStore();
    openStores.push(reopened);
    await reopened.initialize();
    expect(sortedRows((await reopened.exportGraph(seed.request.namespace)).edges)).toEqual(
      sortedRows(before.edges),
    );
  });
});
