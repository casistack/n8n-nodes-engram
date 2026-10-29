import { randomUUID } from 'crypto';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import * as backendOutcomes from '../../src/storage/AutonomousPersonalCompletionBackendRegistryV4';
import * as completionHandles from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import * as nativeOriginProjector from '../../src/storage/AutonomousPersonalNativeOriginV4';
import { AutonomousPersonalNativeOriginV4Error } from '../../src/storage/AutonomousPersonalNativeOriginV4';
import type { AutonomousPersonalNativeOriginV4 } from '../../src/schemas/AutonomousPersonalNativeOriginV4.schema';
import type { GraphData } from '../../src/schemas';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import {
  closeAutonomousPersonalCompletionV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
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
type PrepareMode = 'response' | 'deferred' | 'no_dispatch';

function withoutExportedAt(graph: GraphData): Omit<GraphData, 'exported_at'> {
  return Object.fromEntries(Object.entries(graph).filter(([key]) => key !== 'exported_at')) as Omit<
    GraphData,
    'exported_at'
  >;
}

function providerResponse(unitIds: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              version: 1,
              units: unitIds.map((unitId) => ({
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
}

async function prepareCompletion(
  store: Neo4jStorage,
  seed: Seed,
  mode: PrepareMode = 'response',
): Promise<{ handle: unknown; fetchSpy: jest.SpyInstance }> {
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (mode === 'deferred') return new Response('temporarily unavailable', { status: 503 });
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = JSON.parse(body.messages[1]!.content) as { units: Array<{ unitId: string }> };
    return providerResponse(user.units.map((unit) => unit.unitId));
  });
  const context = nativeAutonomousPersonalCaptureContext(seed, {
    executionId: `native-proof:${randomUUID()}`,
    credentials: {
      apiKey: 'neo4j-native-completion-test-key',
      baseUrl: 'https://memory.invalid/v1',
    },
    ...(mode === 'no_dispatch' ? { extraParameters: { automaticMemoryProfile: 'explicit' } } : {}),
  });
  const result = await prepareNativeAutonomousPersonalCompletionV4(context, store);
  if (result.kind !== 'completion_prepared')
    throw new Error(`Expected private completion handle; got ${result.kind}`);
  return { handle: result.handle, fetchSpy };
}

describeNeo('native proof core for autonomous personal completion on Neo4j', () => {
  let driver: Driver | undefined;
  let store: Neo4jStorage | undefined;
  let seed: Seed;
  let handle: unknown;
  let namespaces: string[] = [];

  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver!.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };

  beforeEach(async () => {
    driver = neo4j.driver(
      uri!.replace('://localhost:', '://127.0.0.1:'),
      neo4j.auth.basic(username, password),
    );
    store = new Neo4jStorage(uri!, username, password, database);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
    namespaces = [seed.request.namespace];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (store && handle) closeAutonomousPersonalCompletionV4(store, handle);
    try {
      await store?.close();
      for (const namespace of namespaces) {
        await query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
          namespace,
        });
        await query(
          'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
          { namespace },
        );
        await query('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
          namespace,
        });
      }
    } finally {
      await driver?.close();
      driver = undefined;
      store = undefined;
      namespaces = [];
      handle = undefined;
    }
  });

  it.each([
    { mode: 'response' as const, receipt: 'human_autonomous_capture_committed' as const },
    {
      mode: 'deferred' as const,
      receipt: 'human_autonomous_source_deferred_committed' as const,
    },
    {
      mode: 'no_dispatch' as const,
      receipt: 'human_autonomous_source_verdict_committed' as const,
    },
  ])('returns a one-use proof view for the $receipt branch', async ({ mode, receipt }) => {
    const prepared = await prepareCompletion(store!, seed, mode);
    handle = prepared.handle;
    if (mode === 'no_dispatch') expect(prepared.fetchSpy).not.toHaveBeenCalled();

    const projectedOrigins: AutonomousPersonalNativeOriginV4[] = [];
    const originalProject = nativeOriginProjector.projectAutonomousPersonalNativeOriginV4;
    jest
      .spyOn(nativeOriginProjector, 'projectAutonomousPersonalNativeOriginV4')
      .mockImplementation((input, plan, check) => {
        const origin = originalProject(input, plan, check);
        projectedOrigins.push(origin);
        return origin;
      });

    const token = await store!.completeAutonomousPersonalCaptureForNativeV4!(handle);
    expect(Object.isFrozen(token)).toBe(true);
    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(
      backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4({}, handle, token),
    ).toBeNull();
    expect(
      backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(store!, {}, token),
    ).toBeNull();

    const view = backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(
      store!,
      handle,
      token,
    );
    expect(view?.observation).toEqual({ kind: 'matched' });
    expect(projectedOrigins).toHaveLength(1);
    expect(view?.proof?.nativeOrigin).toBe(projectedOrigins[0]);
    expect(
      backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(store!, handle, token),
    ).toBeNull();

    const origin = view?.proof?.nativeOrigin;
    if (!origin) throw new Error('Expected the backend-owned origin proof view');
    expect(origin.terminalReceipt.kind).toBe(receipt);
    const actual = await store!.exportGraph(seed.request.namespace);
    const terminal = actual.automatic_operations_v1?.operations.find(
      (operation) => operation.operationId === origin.terminalReceipt.operationId,
    );
    expect(terminal?.state).toBe('committed');
    if (terminal?.version !== 4 || terminal.state !== 'committed')
      throw new Error('Expected a committed operation');
    expect(terminal.identity).toEqual(origin.identity);
    expect(terminal.terminalReceipt).toEqual(origin.terminalReceipt);
    const claims = actual.edges.filter(
      (edge) =>
        edge.group_id === seed.request.namespace &&
        Object.prototype.hasOwnProperty.call(edge.attributes, 'engram_claim_v1'),
    );
    if (mode === 'response') expect(claims).toHaveLength(1);
    else expect(claims).toHaveLength(0);
  });

  it('keeps DATA-only completion free of native-origin projection and proof output', async () => {
    const prepared = await prepareCompletion(store!, seed);
    handle = prepared.handle;
    const originProjector = jest.spyOn(
      nativeOriginProjector,
      'projectAutonomousPersonalNativeOriginV4',
    );
    const aggregate = jest.spyOn(
      completionHandles,
      'assertAutonomousPersonalCompletionNativeAggregateBytesV4',
    );
    const registerOutcome = jest.spyOn(
      backendOutcomes.AutonomousPersonalCompletionBackendRegistryV4.prototype,
      'registerCoreOutcome',
    );

    const result = await store!.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'matched' });
    expect(Object.keys(result)).toEqual(['kind']);
    expect(originProjector).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    expect(registerOutcome).not.toHaveBeenCalled();
  });

  it.each(['invalid_input', 'conflict', 'capacity'] as const)(
    'preserves native-origin %s failure before any graph diff',
    async (reason) => {
      const prepared = await prepareCompletion(store!, seed);
      handle = prepared.handle;
      const before = await store!.exportGraph();
      const internals = store as unknown as {
        writeExtractionDiff: (...args: unknown[]) => Promise<void>;
      };
      const writeDiff = jest.spyOn(internals, 'writeExtractionDiff');
      const projector = jest
        .spyOn(nativeOriginProjector, 'projectAutonomousPersonalNativeOriginV4')
        .mockImplementation(() => {
          throw new AutonomousPersonalNativeOriginV4Error(reason);
        });

      const token = await store!.completeAutonomousPersonalCaptureForNativeV4!(handle);
      const view = backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(
        store!,
        handle,
        token,
      );
      expect(view?.observation).toEqual({ kind: 'no_write', reason });
      expect(view?.proof).toBeNull();
      expect(projector).toHaveBeenCalledTimes(1);
      expect(writeDiff).not.toHaveBeenCalled();
      expect(withoutExportedAt(await store!.exportGraph())).toEqual(withoutExportedAt(before));
    },
  );

  it('does not mint proof after an actual commit whose source changes before readback', async () => {
    const prepared = await prepareCompletion(store!, seed);
    handle = prepared.handle;
    const graphBeforeCompletion = await store!.exportGraph(seed.request.namespace);
    const leased = graphBeforeCompletion.automatic_operations_v1?.operations.find(
      (operation) =>
        operation.identity.namespace === seed.request.namespace && operation.state === 'leased',
    );
    if (!leased) throw new Error('Expected a leased operation before completion');

    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const originalDriverSession = internals.driver.session.bind(internals.driver);
    let managedWrites = 0;
    let readbackSessions = 0;
    let changedSource = false;
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
        const changed = await query(
          `MATCH (source:Episode {uuid:$sourceId})
           SET source.review_status='rejected'
           RETURN source.uuid AS uuid`,
          { sourceId: leased.identity.sourceId },
        );
        changedSource = changed.records.length === 1;
        return result;
      });
      return session;
    });

    const token = await store!.completeAutonomousPersonalCaptureForNativeV4!(handle);
    const view = backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(
      store!,
      handle,
      token,
    );
    expect(changedSource).toBe(true);
    expect(managedWrites).toBe(1);
    expect(readbackSessions).toBe(1);
    expect(view?.observation).toEqual({ kind: 'unconfirmed' });
    expect(view?.proof).toBeNull();
  });

  it('returns matched DATA without proof when the managed write acknowledgement is lost', async () => {
    const prepared = await prepareCompletion(store!, seed);
    handle = prepared.handle;
    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const originalDriverSession = internals.driver.session.bind(internals.driver);
    let managedWrites = 0;
    let readbackSessions = 0;
    let rejectAfterCommit = true;
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

    const token = await store!.completeAutonomousPersonalCaptureForNativeV4!(handle);
    const view = backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(
      store!,
      handle,
      token,
    );
    expect(managedWrites).toBe(1);
    expect(readbackSessions).toBe(1);
    expect(view?.observation).toEqual({ kind: 'matched' });
    expect(view?.proof).toBeNull();
  });
});
