import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { Neo4jError } from 'neo4j-driver-core';
import * as automaticClaimReadScope from '../../src/storage/AutomaticClaimReadScope';
import * as autonomousPersonalCompletionHandles from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { AutomaticCaptureBeginRequestV2Schema } from '../../src/schemas/AutomaticCapture.schema';
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
type CompletionAccess = ReturnType<
  typeof autonomousPersonalCompletionHandles.getAutonomousPersonalCompletionAccessV4
>;

function spyCompletionAccess(onAccess: (runtime: CompletionAccess) => void): jest.SpyInstance {
  const original = autonomousPersonalCompletionHandles.getAutonomousPersonalCompletionAccessV4;
  return jest
    .spyOn(autonomousPersonalCompletionHandles, 'getAutonomousPersonalCompletionAccessV4')
    .mockImplementation((storageOwner, access) => {
      const runtime = original(storageOwner, access);
      onAccess(runtime);
      return runtime;
    });
}

function claimEdges(graph: Awaited<ReturnType<Neo4jStorage['exportGraph']>>) {
  return graph.edges.filter((edge) =>
    Object.prototype.hasOwnProperty.call(edge.attributes, 'engram_claim_v1'),
  );
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

function queryText(query: unknown): string {
  if (typeof query === 'string') return query;
  if (query === null || typeof query !== 'object') return '';
  const text = Object.getOwnPropertyDescriptor(query, 'text')?.value;
  return typeof text === 'string' ? text : '';
}

async function prepareCompletion(
  store: Neo4jStorage,
  seed: Seed,
  mode: 'response' | 'deferred' | 'no_dispatch' = 'response',
  executionId = 'execution:A',
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
    executionId,
    credentials: { apiKey: 'neo4j-completion-test-key', baseUrl: 'https://memory.invalid/v1' },
    ...(mode === 'no_dispatch' ? { extraParameters: { automaticMemoryProfile: 'explicit' } } : {}),
  });
  const result = await prepareNativeAutonomousPersonalCompletionV4(context, store);
  if (result.kind !== 'completion_prepared')
    throw new Error(`Expected private completion handle; got ${result.kind}`);
  return { handle: result.handle, fetchSpy };
}

describeNeo('atomic autonomous personal completion on Neo4j', () => {
  let driver: Driver;
  let store: Neo4jStorage;
  let namespace: string;
  let handle: unknown;
  let seed: Seed;
  let namespaces: string[];
  let extraHandles: unknown[];

  const readStoreRevision = async (): Promise<number> => {
    const session = driver.session({ database });
    try {
      const result = await session.run(
        "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.revision AS revision",
      );
      const value = result.records[0]?.get('revision');
      return neo4j.isInt(value) ? value.toNumber() : Number(value);
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
    namespace = seed.request.namespace;
    namespaces = [namespace];
    extraHandles = [];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (handle) closeAutonomousPersonalCompletionV4(store, handle);
    for (const extraHandle of extraHandles ?? [])
      closeAutonomousPersonalCompletionV4(store, extraHandle);
    try {
      await store.close();
      const session = driver.session({ database });
      try {
        for (const currentNamespace of namespaces ?? []) {
          await session.run(
            'MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op',
            { namespace: currentNamespace },
          );
          await session.run(
            'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
            { namespace: currentNamespace },
          );
          await session.run('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
            namespace: currentNamespace,
          });
        }
      } finally {
        await session.close();
      }
    } finally {
      await driver.close();
      handle = undefined;
      namespaces = [];
      extraHandles = [];
    }
  });

  it('atomically persists a response terminal and its complete Claim3 pair', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const before = await store.exportGraph();
    const leased = before.automatic_operations_v1?.operations.find(
      (operation) => operation.identity.namespace === namespace && operation.state === 'leased',
    );
    if (!leased) throw new Error('Expected a persisted leased operation');

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'matched' });

    const actual = await store.exportGraph();
    const terminal = actual.automatic_operations_v1?.operations.find(
      (operation) => operation.operationId === leased.operationId,
    );
    expect(terminal?.state).toBe('committed');
    if (terminal?.version !== 4 || terminal.state !== 'committed')
      throw new Error('Expected a committed autonomous personal operation');
    expect(terminal.terminalReceipt.kind).toBe('human_autonomous_capture_committed');
    expect(actual.entities.length).toBe(before.entities.length + 1);
    expect(actual.edges.length).toBe(before.edges.length + 1);
    expect(actual.metadata?.extraction_epoch).toBeDefined();
    expect(actual.metadata?.extraction_epoch).not.toBe(before.metadata?.extraction_epoch);
  });

  it('commits a deferred source-only terminal without changing the extraction epoch', async () => {
    const prepared = await prepareCompletion(store, seed, 'deferred');
    handle = prepared.handle;
    const before = await store.exportGraph();
    const leased = before.automatic_operations_v1?.operations.find(
      (operation) => operation.identity.namespace === namespace && operation.state === 'leased',
    );
    if (!leased) throw new Error('Expected a persisted leased operation');

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'matched' });

    const actual = await store.exportGraph();
    const terminal = actual.automatic_operations_v1?.operations.find(
      (operation) => operation.operationId === leased.operationId,
    );
    expect(terminal?.state).toBe('committed');
    if (terminal?.version !== 4 || terminal.state !== 'committed')
      throw new Error('Expected a committed autonomous personal operation');
    expect(terminal.terminalReceipt.kind).toBe('human_autonomous_source_deferred_committed');
    expect(actual.entities).toHaveLength(before.entities.length);
    expect(actual.edges).toHaveLength(before.edges.length);
    expect(actual.metadata?.extraction_epoch).toBe(before.metadata?.extraction_epoch);
  });

  it('commits a native no-dispatch verdict without provider I/O or graph facts', async () => {
    const prepared = await prepareCompletion(store, seed, 'no_dispatch');
    handle = prepared.handle;
    expect(prepared.fetchSpy).not.toHaveBeenCalled();
    const before = await store.exportGraph();
    const leased = before.automatic_operations_v1?.operations.find(
      (operation) => operation.identity.namespace === namespace && operation.state === 'leased',
    );
    if (!leased) throw new Error('Expected a persisted leased operation');

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'matched' });

    const actual = await store.exportGraph();
    const terminal = actual.automatic_operations_v1?.operations.find(
      (operation) => operation.operationId === leased.operationId,
    );
    expect(terminal?.state).toBe('committed');
    if (terminal?.version !== 4 || terminal.state !== 'committed')
      throw new Error('Expected a committed autonomous personal operation');
    expect(terminal.terminalReceipt.kind).toBe('human_autonomous_source_verdict_committed');
    expect(actual.entities).toHaveLength(before.entities.length);
    expect(actual.edges).toHaveLength(before.edges.length);
    expect(actual.metadata?.extraction_epoch).toBe(before.metadata?.extraction_epoch);
  });

  it('rolls back all diff rows when the in-transaction epoch target check mismatches', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const before = await store.exportGraph();
    const beforeRevision = await readStoreRevision();
    const internals = store as unknown as { getSession: () => Session };
    const originalGetSession = internals.getSession.bind(store);
    let epochWritten = false;
    let injected = false;
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) =>
        executeWrite(async (tx) => {
          const run = tx.run.bind(tx) as unknown as (
            query: unknown,
            parameters?: unknown,
          ) => Promise<{ records: Array<{ get(key: string): unknown }>; [key: string]: unknown }>;
          const runSpy = jest.spyOn(tx, 'run') as unknown as jest.SpyInstance;
          runSpy.mockImplementation(async (query: unknown, parameters: unknown) => {
            const result = await run(query, parameters);
            const text = queryText(query);
            if (text.includes('SET lock.epoch=$epoch')) epochWritten = true;
            if (
              epochWritten &&
              !injected &&
              text.includes(
                'RETURN lock.epoch AS epoch, lock.automatic_operations_v1_present AS automatic_operations_present',
              )
            ) {
              injected = true;
              const record = result.records[0];
              return {
                ...result,
                records: [
                  {
                    get: (key: string) =>
                      key === 'epoch' ? '00000000-0000-4000-8000-000000000000' : record?.get(key),
                  },
                ],
              };
            }
            return result;
          });
          return work(tx);
        }, config),
      );
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'no_write', reason: 'conflict' });
    expect(injected).toBe(true);
    const after = await store.exportGraph();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    expect(after.metadata).toEqual(before.metadata);
    expect(await readStoreRevision()).toBe(beforeRevision);
  });

  it('replans after a real driver retry caused by a retriable error after the diff query', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const beforeRevision = await readStoreRevision();
    const internals = store as unknown as { getSession: () => Session };
    const originalGetSession = internals.getSession.bind(store);
    let callbackAttempts = 0;
    let injected = false;
    const readScopeReservations: Array<{
      scope: object;
      attemptsRemaining: number | undefined;
      sourceHydrationsRemaining: number | undefined;
    }> = [];
    const reserveReadAttempt = automaticClaimReadScope.beginAutomaticClaimReadAttempt;
    jest
      .spyOn(automaticClaimReadScope, 'beginAutomaticClaimReadAttempt')
      .mockImplementation((scope) => {
        const remaining = automaticClaimReadScope.getAutomaticClaimReadScopeRemaining(scope);
        readScopeReservations.push({
          scope,
          attemptsRemaining: remaining?.attemptsRemaining,
          sourceHydrationsRemaining: remaining?.sourceHydrationsRemaining,
        });
        return reserveReadAttempt(scope);
      });
    const retryable = new Neo4jError(
      'synthetic known-uncommitted write failure',
      'ServiceUnavailable',
      'N/A',
      'N/A',
    );
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) =>
        executeWrite(async (tx) => {
          callbackAttempts += 1;
          const run = tx.run.bind(tx) as unknown as (
            query: unknown,
            parameters?: unknown,
          ) => Promise<{ records: Array<{ get(key: string): unknown }>; [key: string]: unknown }>;
          const runSpy = jest.spyOn(tx, 'run') as unknown as jest.SpyInstance;
          runSpy.mockImplementation(async (query: unknown, parameters: unknown) => {
            const result = await run(query, parameters);
            if (!injected && queryText(query).includes('SET lock.epoch=$epoch')) {
              injected = true;
              throw retryable;
            }
            return result;
          });
          return work(tx);
        }, config),
      );
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'matched' });
    expect(injected).toBe(true);
    expect(callbackAttempts).toBe(2);
    expect(readScopeReservations).toHaveLength(4);
    expect(readScopeReservations.map((entry) => entry.attemptsRemaining)).toEqual([
      128, 127, 126, 125,
    ]);
    expect(readScopeReservations.map((entry) => entry.sourceHydrationsRemaining)).toEqual([
      512, 508, 504, 500,
    ]);
    expect(new Set(readScopeReservations.map((entry) => entry.scope)).size).toBe(1);
    expect(await readStoreRevision()).toBe(beforeRevision + 1);
    const actual = await store.exportGraph();
    expect(
      actual.automatic_operations_v1?.operations.filter(
        (operation) =>
          operation.identity.namespace === namespace && operation.state === 'committed',
      ),
    ).toHaveLength(1);
  });

  it('uses the actual strict clock boundary and rolls back the lock revision at lease expiry', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const before = await store.exportGraph();
    const leased = before.automatic_operations_v1?.operations.find(
      (operation) => operation.identity.namespace === namespace && operation.state === 'leased',
    );
    if (!leased || leased.version !== 4 || leased.state !== 'leased')
      throw new Error('Expected a leased autonomous personal operation');
    const beforeRevision = await readStoreRevision();
    const internals = store as unknown as { getSession: () => Session };
    const originalGetSession = internals.getSession.bind(store);
    let injectedClock = false;
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) =>
        executeWrite(async (tx) => {
          const run = tx.run.bind(tx) as unknown as (
            query: unknown,
            parameters?: unknown,
          ) => Promise<{ records: Array<{ get(key: string): unknown }>; [key: string]: unknown }>;
          const runSpy = jest.spyOn(tx, 'run') as unknown as jest.SpyInstance;
          runSpy.mockImplementation(async (query: unknown, parameters: unknown) => {
            const result = await run(query, parameters);
            if (!injectedClock && queryText(query).includes('datetime.realtime().epochMillis')) {
              injectedClock = true;
              const record = result.records[0];
              const substitutedRecord = {
                get: (key: string) =>
                  key === 'now' ? neo4j.int(Date.parse(leased.lease.expiresAt)) : record?.get(key),
              };
              return {
                ...result,
                records: [substitutedRecord],
              } as unknown as typeof result;
            }
            return result;
          });
          return work(tx);
        }, config),
      );
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'no_write', reason: 'lease_expired' });
    expect(injectedClock).toBe(true);
    const after = await store.exportGraph();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    expect(after.metadata).toEqual(before.metadata);
    expect(await readStoreRevision()).toBe(beforeRevision);
  });

  it('stops before opening a session when the original completion signal is aborted', async () => {
    const originalAbortController = globalThis.AbortController;
    let completionController: AbortController | undefined;
    globalThis.AbortController = class extends originalAbortController {
      constructor() {
        super();
        // Preserve the exact controller used by the private completion lifetime.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        completionController ??= this;
      }
    };
    let prepared: Awaited<ReturnType<typeof prepareCompletion>>;
    try {
      prepared = await prepareCompletion(store, seed);
    } finally {
      globalThis.AbortController = originalAbortController;
    }
    handle = prepared.handle;
    if (!completionController) throw new Error('Expected the native completion controller');
    completionController.abort();
    const internals = store as unknown as { getSession: () => Session };
    const sessionSpy = jest.spyOn(internals, 'getSession');

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'no_write', reason: 'budget_exhausted' });
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it('uses one actual writer attempt and reads back after an injected post-commit acknowledgement loss', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const sessionSpy = jest.spyOn(internals.driver, 'session');
    let writerAttempts = 0;
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
        writerAttempts += 1;
        await executeWrite(work, config);
        throw new Error('synthetic acknowledgement lost after actual Neo4j commit');
      });
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'matched' });
    expect(writerAttempts).toBe(1);
    const writerRoutedReadbacks = sessionSpy.mock.calls.filter(([config]) => {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) return false;
      return 'defaultAccessMode' in config && config.defaultAccessMode === neo4j.session.WRITE;
    });
    expect(writerRoutedReadbacks).toHaveLength(1);
    const actual = await store.exportGraph();
    const committed = actual.automatic_operations_v1?.operations.filter(
      (operation) => operation.identity.namespace === namespace && operation.state === 'committed',
    );
    expect(committed).toHaveLength(1);
  });

  it('blocks a second production callback invocation before another query or write', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const internals = store as unknown as { getSession: () => Session };
    const originalGetSession = internals.getSession.bind(store);
    let queriesAtReentry = -1;
    let reentryQueries = -1;
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) =>
        executeWrite(async (tx) => {
          const runSpy = jest.spyOn(tx, 'run');
          const result = await work(tx);
          queriesAtReentry = runSpy.mock.calls.length;
          await expect(work(tx)).rejects.toBeInstanceOf(Error);
          reentryQueries = runSpy.mock.calls.length;
          runSpy.mockRestore();
          return result;
        }, config),
      );
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'matched' });
    expect(queriesAtReentry).toBeGreaterThan(0);
    expect(reentryQueries).toBe(queriesAtReentry);
  });

  it('returns unconfirmed after the committed audit witness changes before readback', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const sessionSpy = jest.spyOn(internals.driver, 'session');
    let writerAttempts = 0;
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
        writerAttempts += 1;
        await executeWrite(work, config);
        const mutationSession = driver.session({ database });
        try {
          const operations = await mutationSession.run(
            'MATCH (op:AutomaticOperation {namespace:$namespace}) RETURN op.operation_id AS id, op.record_json AS record_json',
            { namespace },
          );
          const stored = operations.records
            .map(
              (record) =>
                JSON.parse(String(record.get('record_json'))) as {
                  operationId: string;
                  attempts: Array<{ attemptHash: string; disposition: string }>;
                },
            )
            .find((operation) =>
              operation.attempts.some((attempt) => attempt.disposition === 'committed'),
            );
          if (!stored) throw new Error('Expected committed operation audit');
          const committedAttempt = stored.attempts.find(
            (attempt) => attempt.disposition === 'committed',
          );
          if (!committedAttempt) throw new Error('Expected completion audit attempt');
          committedAttempt.attemptHash = 'f'.repeat(64);
          await mutationSession.run(
            'MATCH (op:AutomaticOperation {operation_id:$operationId}) SET op.record_json=$recordJson',
            { operationId: stored.operationId, recordJson: JSON.stringify(stored) },
          );
        } finally {
          await mutationSession.close();
        }
        throw new Error('synthetic acknowledgement lost after audit changed');
      });
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'unconfirmed' });
    expect(writerAttempts).toBe(1);
    const writerRoutedReadbacks = sessionSpy.mock.calls.filter(([config]) => {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) return false;
      return 'defaultAccessMode' in config && config.defaultAccessMode === neo4j.session.WRITE;
    });
    expect(writerRoutedReadbacks).toHaveLength(1);
    const actual = await store.exportGraph();
    expect(
      actual.automatic_operations_v1?.operations.filter(
        (operation) =>
          operation.identity.namespace === namespace && operation.state === 'committed',
      ),
    ).toHaveLength(1);
  });

  it('commits a valid audit-truncated terminal but keeps the external result unconfirmed', async () => {
    const originalBegin = store.beginAndClaimAutonomousPersonalCaptureV4.bind(store);
    let filledAudit = false;
    jest
      .spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4')
      .mockImplementation(async (input, attempt) => {
        const result = await originalBegin(input, attempt);
        if (result.kind !== 'claimed' || filledAudit) return result;
        filledAudit = true;
        const session = driver.session({ database });
        try {
          const operations = await session.run(
            'MATCH (op:AutomaticOperation {namespace:$namespace}) RETURN op.operation_id AS id, op.record_json AS record_json',
            { namespace },
          );
          const record = operations.records[0];
          if (!record) throw new Error('Expected the initial leased operation');
          const operation = JSON.parse(String(record.get('record_json'))) as {
            operationId: string;
            attempts: Array<{ attemptHash: string; at: string; disposition: string }>;
            lastObservedAt: string;
          };
          const attempts = [operation.attempts[0]!];
          const hashes = new Set(attempts.map((entry) => entry.attemptHash));
          for (let index = 0; attempts.length < 32; index += 1) {
            let attemptHash = index.toString(16).padStart(64, '0');
            if (hashes.has(attemptHash)) attemptHash = `e${index.toString(16).padStart(63, '0')}`;
            hashes.add(attemptHash);
            attempts.push({
              attemptHash,
              at: operation.lastObservedAt,
              disposition: 'in_progress',
            });
          }
          operation.attempts = attempts;
          await session.run(
            'MATCH (op:AutomaticOperation {operation_id:$operationId}) SET op.record_json=$recordJson',
            { operationId: operation.operationId, recordJson: JSON.stringify(operation) },
          );
        } finally {
          await session.close();
        }
        return result;
      });

    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    expect(filledAudit).toBe(true);
    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'unconfirmed' });
    const actual = await store.exportGraph();
    const committed = actual.automatic_operations_v1?.operations.find(
      (operation) => operation.identity.namespace === namespace && operation.state === 'committed',
    );
    if (!committed || committed.version !== 4 || committed.state !== 'committed')
      throw new Error('Expected a persisted terminal after one callback return');
    expect(committed.auditTruncated).toBe(true);
    expect(committed.attempts).toHaveLength(32);
    expect(actual.edges.length).toBeGreaterThan(0);
  });

  it('rolls back the first writer payload when the genuine snapshot budget has one byte left', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const before = await store.exportGraph(namespace);
    const leased = before.automatic_operations_v1?.operations.find(
      (operation) => operation.identity.namespace === namespace && operation.state === 'leased',
    );
    if (!leased || leased.version !== 4 || leased.state !== 'leased')
      throw new Error('Expected a persisted leased operation');
    const beforeRevision = await readStoreRevision();

    let readScope:
      | ReturnType<typeof automaticClaimReadScope.getAutomaticClaimReadScope>
      | undefined;
    let bytesAtAccess: number | undefined;
    let reserved = false;
    let bytesAfterReservation: number | undefined;
    spyCompletionAccess((runtime) => {
      readScope = automaticClaimReadScope.getAutomaticClaimReadScope(runtime.legacyReadBudget);
      const remaining = automaticClaimReadScope.getAutomaticClaimReadScopeRemaining(readScope);
      bytesAtAccess = remaining?.snapshotBytesRemaining;
      if (remaining)
        reserved = automaticClaimReadScope.reserveAutomaticClaimSnapshotBytes(
          readScope,
          remaining.snapshotBytesRemaining - 1,
        );
      bytesAfterReservation =
        automaticClaimReadScope.getAutomaticClaimReadScopeRemaining(
          readScope,
        )?.snapshotBytesRemaining;
    });

    const internals = store as unknown as { getSession: () => Session };
    const originalGetSession = internals.getSession.bind(store);
    const writerQueries: string[] = [];
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) =>
        executeWrite(async (tx) => {
          const run = tx.run.bind(tx) as unknown as (
            query: unknown,
            parameters?: unknown,
          ) => Promise<{
            records: Array<{ get(key: string): unknown }>;
            [key: string]: unknown;
          }>;
          const runSpy = jest.spyOn(tx, 'run') as unknown as jest.SpyInstance;
          runSpy.mockImplementation(async (query: unknown, parameters: unknown) => {
            writerQueries.push(queryText(query));
            return run(query, parameters);
          });
          return work(tx);
        }, config),
      );
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'no_write', reason: 'capacity' });
    expect(bytesAtAccess).toBe(100 * 1024 * 1024);
    expect(reserved).toBe(true);
    expect(bytesAfterReservation).toBe(1);
    expect(writerQueries).toHaveLength(1);
    expect(writerQueries[0]).toContain('SET lock.revision=coalesce(lock.revision,0)+1');
    const after = await store.exportGraph(namespace);
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    expect(after.metadata).toEqual(before.metadata);
    expect(
      after.episodes.find((episode) => episode.uuid === leased.identity.sourceId),
    ).toBeDefined();
    expect(claimEdges(after)).toHaveLength(0);
    expect(await readStoreRevision()).toBe(beforeRevision);
  });

  it('keeps a real commit when the same runtime budget is exhausted before external readback', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const before = await store.exportGraph(namespace);
    const beforeRevision = await readStoreRevision();
    let readScope:
      | ReturnType<typeof automaticClaimReadScope.getAutomaticClaimReadScope>
      | undefined;
    let bytesAtAccess: number | undefined;
    spyCompletionAccess((runtime) => {
      readScope = automaticClaimReadScope.getAutomaticClaimReadScope(runtime.legacyReadBudget);
      bytesAtAccess =
        automaticClaimReadScope.getAutomaticClaimReadScopeRemaining(
          readScope,
        )?.snapshotBytesRemaining;
    });

    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const sessionSpy = jest.spyOn(internals.driver, 'session');
    let writerAttempts = 0;
    let exhaustedAfterCommit = false;
    let bytesAfterExhaustion: number | undefined;
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
        writerAttempts += 1;
        const result = await executeWrite(work, config);
        if (!exhaustedAfterCommit) {
          const remaining = readScope
            ? automaticClaimReadScope.getAutomaticClaimReadScopeRemaining(readScope)
            : null;
          if (!readScope || !remaining) throw new Error('Expected the genuine read scope');
          exhaustedAfterCommit = automaticClaimReadScope.reserveAutomaticClaimSnapshotBytes(
            readScope,
            remaining.snapshotBytesRemaining,
          );
          bytesAfterExhaustion =
            automaticClaimReadScope.getAutomaticClaimReadScopeRemaining(
              readScope,
            )?.snapshotBytesRemaining;
        }
        return result;
      });
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'unconfirmed' });
    expect(bytesAtAccess).toBe(100 * 1024 * 1024);
    expect(exhaustedAfterCommit).toBe(true);
    expect(bytesAfterExhaustion).toBe(0);
    expect(writerAttempts).toBe(1);
    const writerRoutedReadbacks = sessionSpy.mock.calls.filter(([config]) => {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) return false;
      return 'defaultAccessMode' in config && config.defaultAccessMode === neo4j.session.WRITE;
    });
    expect(writerRoutedReadbacks).toHaveLength(1);

    const after = await store.exportGraph(namespace);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.entities).toHaveLength(before.entities.length + 1);
    expect(after.edges).toHaveLength(before.edges.length + 1);
    const committed = after.automatic_operations_v1?.operations.filter(
      (operation) => operation.identity.namespace === namespace && operation.state === 'committed',
    );
    expect(committed).toHaveLength(1);
    expect(claimEdges(after)).toHaveLength(1);
    expect(await readStoreRevision()).toBe(beforeRevision + 1);
  });

  it('returns unconfirmed and preserves a Source4 review/trust update made after the real commit', async () => {
    const prepared = await prepareCompletion(store, seed);
    handle = prepared.handle;
    const before = await store.exportGraph(namespace);
    const leased = before.automatic_operations_v1?.operations.find(
      (operation) => operation.identity.namespace === namespace && operation.state === 'leased',
    );
    if (!leased || leased.version !== 4 || leased.state !== 'leased')
      throw new Error('Expected a persisted leased operation');
    const source = before.episodes.find((episode) => episode.uuid === leased.identity.sourceId);
    if (!source) throw new Error('Expected the leased Source4 episode');
    expect(source.review_status).toBe('accepted');
    expect(source.trust_level).toBe('standard');

    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const sessionSpy = jest.spyOn(internals.driver, 'session');
    let completionSessionClaimed = false;
    let writerAttempts = 0;
    let updatedSource: Awaited<ReturnType<Neo4jStorage['updateEpisode']>> | undefined;
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      if (completionSessionClaimed) return session;
      completionSessionClaimed = true;
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
        writerAttempts += 1;
        const result = await executeWrite(work, config);
        updatedSource = await store.updateEpisode(source.uuid, {
          trust_level: 'untrusted',
          review_status: 'rejected',
        });
        return result;
      });
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'unconfirmed' });
    expect(updatedSource).toMatchObject({ trust_level: 'untrusted', review_status: 'rejected' });
    expect(writerAttempts).toBe(1);
    const writerRoutedReadbacks = sessionSpy.mock.calls.filter(([config]) => {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) return false;
      return 'defaultAccessMode' in config && config.defaultAccessMode === neo4j.session.WRITE;
    });
    expect(writerRoutedReadbacks).toHaveLength(1);

    const after = await store.exportGraph(namespace);
    expect(after.edges).toHaveLength(before.edges.length + 1);
    expect(claimEdges(after)).toHaveLength(1);
    expect(after.episodes.find((episode) => episode.uuid === source.uuid)).toMatchObject({
      trust_level: 'untrusted',
      review_status: 'rejected',
    });
    expect(
      after.automatic_operations_v1?.operations.filter(
        (operation) =>
          operation.identity.namespace === namespace && operation.state === 'committed',
      ),
    ).toHaveLength(1);
  });

  it('keeps a real reference commit but reports unconfirmed when its existing value vector changes', async () => {
    const firstPrepared = await prepareCompletion(store, seed);
    handle = firstPrepared.handle;
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });
    closeAutonomousPersonalCompletionV4(store, handle);
    handle = undefined;

    const firstGraph = await store.exportGraph(namespace);
    const firstOperation = firstGraph.automatic_operations_v1?.operations.find(
      (operation) =>
        operation.identity.namespace === namespace &&
        operation.identity.turn === seed.request.turn &&
        operation.state === 'committed',
    );
    if (
      !firstOperation ||
      firstOperation.version !== 4 ||
      firstOperation.state !== 'committed' ||
      firstOperation.terminalReceipt.kind !== 'human_autonomous_capture_committed'
    )
      throw new Error('Expected a first committed preference');
    const firstCreated = firstOperation.terminalReceipt.selection.items.find(
      (item) => item.effect === 'created',
    );
    if (!firstCreated) throw new Error('Expected a created preference receipt item');
    const firstEdge = firstGraph.edges.find((edge) => edge.uuid === firstCreated.claimId);
    if (!firstEdge) throw new Error('Expected the first Claim3 edge');
    const existingValue = firstGraph.entities.find(
      (entity) => entity.uuid === firstEdge.target_node_uuid,
    );
    if (!existingValue) throw new Error('Expected the first Claim3 value entity');
    expect(claimEdges(firstGraph)).toHaveLength(1);

    const secondSeed: Seed = {
      ...seed,
      request: AutomaticCaptureBeginRequestV2Schema.parse({
        ...seed.request,
        turn: `${seed.request.turn}:reference`,
        attemptIdHash: 'b'.repeat(64),
        source: {
          ...seed.request.source,
          sourceMessageId: 'synthetic-original-message:reference',
        },
      }),
    };
    const secondPrepared = await prepareCompletion(
      store,
      secondSeed,
      'response',
      'synthetic:reference-event',
    );
    handle = secondPrepared.handle;
    const beforeSecond = await store.exportGraph(namespace);

    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const sessionSpy = jest.spyOn(internals.driver, 'session');
    let completionSessionClaimed = false;
    let writerAttempts = 0;
    let updatedValue: Awaited<ReturnType<Neo4jStorage['updateEntity']>> | undefined;
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      if (completionSessionClaimed) return session;
      completionSessionClaimed = true;
      const executeWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
        writerAttempts += 1;
        const result = await executeWrite(work, config);
        updatedValue = await store.updateEntity(existingValue.uuid, {
          name_embedding: [0.125, 0.25, 0.5],
        });
        return result;
      });
      return session;
    });

    const result = await store.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'unconfirmed' });
    expect(updatedValue?.name_embedding).toEqual([0.125, 0.25, 0.5]);
    expect(writerAttempts).toBe(1);
    const writerRoutedReadbacks = sessionSpy.mock.calls.filter(([config]) => {
      if (config === null || typeof config !== 'object' || Array.isArray(config)) return false;
      return 'defaultAccessMode' in config && config.defaultAccessMode === neo4j.session.WRITE;
    });
    expect(writerRoutedReadbacks).toHaveLength(1);

    const after = await store.exportGraph(namespace);
    expect(after.entities).toHaveLength(beforeSecond.entities.length);
    expect(after.edges).toHaveLength(beforeSecond.edges.length);
    expect(claimEdges(after)).toHaveLength(1);
    expect(
      after.entities.find((entity) => entity.uuid === existingValue.uuid)?.name_embedding,
    ).toEqual([0.125, 0.25, 0.5]);
    expect(after.edges.find((edge) => edge.uuid === firstEdge.uuid)).toEqual(
      beforeSecond.edges.find((edge) => edge.uuid === firstEdge.uuid),
    );
    const committed = after.automatic_operations_v1?.operations.filter(
      (operation) => operation.identity.namespace === namespace && operation.state === 'committed',
    );
    expect(committed).toHaveLength(2);
    const secondOperation = committed?.find(
      (operation) => operation.identity.turn === secondSeed.request.turn,
    );
    if (
      !secondOperation ||
      secondOperation.version !== 4 ||
      secondOperation.state !== 'committed' ||
      secondOperation.terminalReceipt.kind !== 'human_autonomous_capture_committed'
    )
      throw new Error('Expected a second committed preference');
    const reference = secondOperation.terminalReceipt.selection.items.find(
      (item) => item.effect === 'reference',
    );
    expect(reference?.claimId).toBe(firstEdge.uuid);
  });

  it('rejects a malformed Claim3 footprint from a different namespace before any diff', async () => {
    const firstPrepared = await prepareCompletion(store, seed);
    handle = firstPrepared.handle;
    expect(await store.completeAutonomousPersonalCaptureV4!(handle)).toEqual({ kind: 'matched' });
    const firstGraph = await store.exportGraph();
    const claimEdge = firstGraph.edges.find((edge) =>
      Object.prototype.hasOwnProperty.call(edge.attributes, 'engram_claim_v1'),
    );
    if (!claimEdge) throw new Error('Expected a stored Claim3 edge');

    const foreignSeed = await seedAutonomousPersonalCaptureSubject(store);
    const foreignNamespace = foreignSeed.request.namespace;
    namespaces.push(foreignNamespace);
    const secondPrepared = await prepareCompletion(store, foreignSeed);
    extraHandles.push(secondPrepared.handle);
    const beforeRevision = await readStoreRevision();
    const foreignSession = driver.session({ database });
    try {
      await foreignSession.run(
        `MATCH (source:Entity {uuid:$source})
         MATCH (target:Entity {uuid:$target})
         CREATE (source)-[r:RELATES_TO]->(target)
         SET r += $properties`,
        {
          source: claimEdge.source_node_uuid,
          target: claimEdge.target_node_uuid,
          properties: {
            ...claimEdge,
            group_id: foreignNamespace,
            attributes: JSON.stringify(claimEdge.attributes),
          },
        },
      );
    } finally {
      await foreignSession.close();
    }

    const result = await store.completeAutonomousPersonalCaptureV4!(secondPrepared.handle);
    expect(result).toEqual({ kind: 'no_write', reason: 'conflict' });
    expect(await readStoreRevision()).toBe(beforeRevision);
    const verify = driver.session({ database });
    try {
      const operations = await verify.run(
        'MATCH (op:AutomaticOperation {namespace:$namespace}) RETURN op.record_json AS record_json',
        { namespace: foreignNamespace },
      );
      const foreignOperations = operations.records.map(
        (record) => JSON.parse(String(record.get('record_json'))) as { state: string },
      );
      expect(foreignOperations).toHaveLength(1);
      expect(foreignOperations[0]?.state).toBe('leased');
      const duplicatedClaim = await verify.run(
        'MATCH ()-[edge:RELATES_TO {uuid:$uuid}]->() RETURN count(edge) AS count',
        { uuid: claimEdge.uuid },
      );
      const duplicateCount = duplicatedClaim.records[0]?.get('count');
      expect(neo4j.isInt(duplicateCount) ? duplicateCount.toNumber() : Number(duplicateCount)).toBe(
        2,
      );
    } finally {
      await verify.close();
    }
  });
});
