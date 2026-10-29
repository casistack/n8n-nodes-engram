import { randomUUID } from 'crypto';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { Neo4jError } from 'neo4j-driver-core';
import type { GraphData } from '../../src/schemas';
import { graphFingerprint, sourceFingerprint } from '../../src/extraction/QueueState';
import { exportQueueBackup } from '../../src/extraction/QueueState';
import * as automaticClaimReadScope from '../../src/storage/AutomaticClaimReadScope';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import {
  dispatchNativeAutonomousPersonalCaptureV4,
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

function queryText(query: unknown): string {
  if (typeof query === 'string') return query;
  if (query === null || typeof query !== 'object') return '';
  const text = Object.getOwnPropertyDescriptor(query, 'text')?.value;
  return typeof text === 'string' ? text : '';
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

function withoutExportedAt(graph: GraphData): Omit<GraphData, 'exported_at'> {
  return Object.fromEntries(Object.entries(graph).filter(([key]) => key !== 'exported_at')) as Omit<
    GraphData,
    'exported_at'
  >;
}

describeNeo('actual Neo4j autonomous personal record protection', () => {
  let driver: Driver;
  let store: Neo4jStorage;
  let namespaces: string[] = [];
  let completionResources: Array<{ owner: Neo4jStorage; handle: unknown }> = [];
  let initialFormat: unknown = null;

  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };

  const revision = async (): Promise<number> => {
    const result = await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.revision AS revision",
    );
    const value = result.records[0]?.get('revision');
    return neo4j.isInt(value) ? value.toNumber() : Number(value ?? 0);
  };

  const createCommittedPair = async () => {
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    namespaces.push(seed.request.namespace);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const user = JSON.parse(body.messages[1]!.content) as { units: Array<{ unitId: string }> };
      return providerResponse(user.units.map((unit) => unit.unitId));
    });
    const prepared = await prepareNativeAutonomousPersonalCompletionV4(
      nativeAutonomousPersonalCaptureContext(seed, {
        executionId: `protection:${randomUUID()}`,
        credentials: {
          apiKey: 'neo4j-record-protection-test-key',
          baseUrl: 'https://memory.invalid/v1',
        },
      }),
      store,
    );
    if (prepared.kind !== 'completion_prepared')
      throw new Error(`Expected completion handle, got ${prepared.kind}`);
    completionResources.push({ owner: store, handle: prepared.handle });
    expect(await store.completeAutonomousPersonalCaptureV4!(prepared.handle)).toEqual({
      kind: 'matched',
    });
    fetchSpy.mockRestore();
    const graph = await store.exportGraph(seed.request.namespace);
    const claim = graph.edges.find((edge) =>
      Object.prototype.hasOwnProperty.call(edge.attributes, 'engram_claim_v1'),
    );
    if (!claim) throw new Error('Expected one committed Claim3 edge');
    const value = graph.entities.find((entity) => entity.uuid === claim.target_node_uuid);
    if (!value) throw new Error('Expected the Claim3 value entity');
    const source = graph.episodes.find(
      (episode) =>
        episode.uuid ===
        graph.automatic_operations_v1?.operations.find(
          (operation) => operation.identity.namespace === seed.request.namespace,
        )?.identity.sourceId,
    );
    if (!source) throw new Error('Expected the Source4 creator episode');
    return { seed, claim, value, source };
  };

  beforeEach(async () => {
    driver = neo4j.driver(
      uri!.replace('://localhost:', '://127.0.0.1:'),
      neo4j.auth.basic(username, password),
    );
    store = new Neo4jStorage(uri!, username, password, database);
    await store.initialize();
    namespaces = [];
    completionResources = [];
    const lock = await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.autonomous_source_format_v4 AS format",
    );
    initialFormat = lock.records[0]?.get('format') ?? null;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      for (const resource of completionResources) {
        closeAutonomousPersonalCompletionV4(resource.owner, resource.handle);
      }
      await store.close();
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
      if (neo4j.isInt(initialFormat)) {
        await query(
          "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.autonomous_source_format_v4=$format",
          { format: initialFormat },
        );
      } else {
        await query(
          "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) REMOVE lock.autonomous_source_format_v4",
        );
      }
    } finally {
      await driver.close();
      namespaces = [];
      completionResources = [];
      initialFormat = null;
    }
  });

  it('charges the initial registered marker and reuses one guard across validation retries', async () => {
    const retryStore = new Neo4jStorage(uri!, username, password, database);
    const internals = retryStore as unknown as { getSession: () => Session };
    const originalGetSession = internals.getSession.bind(retryStore);
    const originalGetReadScope = automaticClaimReadScope.getAutomaticClaimReadScope;
    const originalReserveBytes = automaticClaimReadScope.reserveAutomaticClaimSnapshotBytes;
    const events: string[] = [];
    let callbackAttempts = 0;
    let injected = false;
    const retryable = new Neo4jError(
      'synthetic retry after native validation',
      'ServiceUnavailable',
      'N/A',
      'N/A',
    );

    jest
      .spyOn(automaticClaimReadScope, 'getAutomaticClaimReadScope')
      .mockImplementation((budget) => {
        events.push('scope');
        return originalGetReadScope(budget);
      });
    jest
      .spyOn(automaticClaimReadScope, 'reserveAutomaticClaimSnapshotBytes')
      .mockImplementation((scope, bytes) => {
        events.push('charge');
        return originalReserveBytes(scope, bytes);
      });
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const originalExecuteRead = session.executeRead.bind(session);
      jest.spyOn(session, 'executeRead').mockImplementation((work, config) =>
        originalExecuteRead(async (tx) => {
          callbackAttempts++;
          const originalRun = tx.run.bind(tx);
          const runSpy = jest.spyOn(tx, 'run').mockImplementation((query, parameters) => {
            const text = queryText(query);
            if (text.includes('RETURN lock.autonomous_source_format_v4 AS format'))
              events.push('format');
            if (text.includes('entity_count')) events.push('preflight');
            return originalRun(query, parameters);
          });
          try {
            const value = await work(tx);
            if (!injected) {
              injected = true;
              throw retryable;
            }
            return value;
          } finally {
            runSpy.mockRestore();
          }
        }, config),
      );
      return session;
    });

    try {
      await expect(retryStore.initialize()).resolves.toBeUndefined();
    } finally {
      await retryStore.close();
    }

    expect(injected).toBe(true);
    expect(callbackAttempts).toBe(2);
    expect(automaticClaimReadScope.getAutomaticClaimReadScope).toHaveBeenCalledTimes(1);
    const firstFormat = events.indexOf('format');
    const firstPreflight = events.indexOf('preflight');
    expect(firstFormat).toBeGreaterThanOrEqual(0);
    expect(firstPreflight).toBeGreaterThan(firstFormat);
    expect(
      events.slice(firstFormat + 1, firstPreflight).filter((event) => event === 'charge'),
    ).toHaveLength(2);
  });

  it('rolls back public edge, fact, and Source4 provenance corruption while allowing supported writes', async () => {
    const { seed, claim, value, source } = await createCommittedPair();
    const embedding = await store.updateEntity(value.uuid, {
      name_embedding: [0.125, 0.25, 0.5],
    });
    expect(embedding.name_embedding).toEqual([0.125, 0.25, 0.5]);

    const unrelatedNamespace = `legacy-${randomUUID()}`;
    namespaces.push(unrelatedNamespace);
    const unrelated = await store.addEntity({
      group_id: unrelatedNamespace,
      name: 'Unrelated legacy row',
      entity_type: 'unknown',
    });
    expect(unrelated.name).toBe('Unrelated legacy row');

    const binding = await store.automaticBindingCommand!({
      action: 'revoke',
      namespace: seed.request.namespace,
      bindingId: seed.binding.bindingId,
      expectedRevision: seed.binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic governance boundary',
    });
    expect(binding.state).toBe('revoked');

    const before = await store.exportGraph(seed.request.namespace);
    const beforeRevision = await revision();
    await expect(
      store.updateEdge(claim.uuid, { fact: 'Changed accepted preference fact.' }),
    ).rejects.toThrow();
    expect(await revision()).toBe(beforeRevision);
    expect(withoutExportedAt(await store.exportGraph(seed.request.namespace))).toEqual(
      withoutExportedAt(before),
    );

    await expect(
      store.updateEntity(value.uuid, { summary: 'Tampered value summary.' }),
    ).rejects.toThrow();
    expect(await revision()).toBe(beforeRevision);
    expect(withoutExportedAt(await store.exportGraph(seed.request.namespace))).toEqual(
      withoutExportedAt(before),
    );

    await expect(store.deleteEdge(claim.uuid)).rejects.toThrow();
    expect(await revision()).toBe(beforeRevision);
    expect(withoutExportedAt(await store.exportGraph(seed.request.namespace))).toEqual(
      withoutExportedAt(before),
    );

    await expect(
      store.updateEpisode(source.uuid, {
        attributes: {
          ...source.attributes,
          engram_write_owner_v4: {
            ...(source.attributes.engram_write_owner_v4 as Record<string, unknown>),
            turn: 'tampered',
          },
        },
      }),
    ).rejects.toThrow('reserved_native_record');
    expect(await revision()).toBe(beforeRevision);
    expect(withoutExportedAt(await store.exportGraph(seed.request.namespace))).toEqual(
      withoutExportedAt(before),
    );

    const governedSource = await store.updateEpisode(source.uuid, { review_status: 'rejected' });
    expect(governedSource.review_status).toBe('rejected');
  });

  it('rejects generic reserved writes and raw imports before they reach persistence', async () => {
    const { seed, claim, value } = await createCommittedPair();
    const before = await store.exportGraph(seed.request.namespace);
    const subject = await store.getEntity(seed.subject.uuid);
    if (!subject) throw new Error('Expected the seeded subject');

    await expect(
      store.addEntity({
        group_id: seed.request.namespace,
        name: 'Forged reserved value',
        entity_type: 'autonomous_personal_value',
      }),
    ).rejects.toThrow('reserved_native_record');
    await expect(
      store.addEntity({
        group_id: seed.request.namespace,
        name: 'Forged Claim3 marker',
        attributes: { engram_claim_v1: { version: 3, family: 'autonomous-personal-v1' } },
      }),
    ).rejects.toThrow('reserved_native_record');
    await expect(
      store.addEpisode({
        group_id: seed.request.namespace,
        content: 'Forged Source4 record',
        role: 'human',
        reference_time: '2026-10-28T00:00:00.000Z',
        attributes: { engram_write_owner_v4: { version: 1 } },
      }),
    ).rejects.toThrow('reserved_native_record');
    await expect(
      store.updateEntity(seed.subject.uuid, {
        attributes: {
          ...subject.attributes,
          engram_literal_v1: { version: 3, family: 'autonomous-personal-v1' },
        },
      }),
    ).rejects.toThrow('reserved_native_record');
    await expect(
      store.updateEdge(claim.uuid, {
        attributes: {
          ...claim.attributes,
          engram_literal_v1: { version: 3, family: 'autonomous-personal-v1' },
        },
      }),
    ).rejects.toThrow('reserved_native_record');

    const imported = structuredClone(before) as GraphData;
    delete imported.automatic_operations_v1;
    imported.edges = [];
    imported.episodes = [];
    imported.entities = [
      {
        ...value,
        uuid: randomUUID(),
        name: 'Forged imported marker',
        attributes: { engram_literal_v1: { version: 3, family: 'autonomous-personal-v1' } },
      },
    ];
    expect(imported.entities[0]?.attributes.engram_literal_v1).toMatchObject({ version: 3 });
    await expect(store.importGraph(imported as never)).rejects.toThrow('reserved_native_record');
    await expect(
      store.importExtractionBackup(exportQueueBackup(imported) as never),
    ).rejects.toThrow('reserved_native_record');

    const ordinary = await store.addEntity({
      group_id: seed.request.namespace,
      name: 'Staged target',
      entity_type: 'unknown',
    });
    const episode = await store.appendEpisode({
      group_id: seed.request.namespace,
      content: 'A simple source event for the staged plan.',
      role: 'human',
      reference_time: '2026-10-28T00:00:00.000Z',
    });
    const stagedGraph = await store.exportGraph(seed.request.namespace);
    const stagedOrdinary = stagedGraph.entities.find((entity) => entity.uuid === ordinary.uuid);
    if (!stagedOrdinary) throw new Error('Expected the staged entity');
    const forgedStaged = {
      version: 1 as const,
      group_id: seed.request.namespace,
      source_guards: [{ uuid: episode.episode.uuid, hash: sourceFingerprint(episode.episode) }],
      graph_hash: graphFingerprint(stagedGraph, seed.request.namespace),
      entities: [
        {
          ...stagedOrdinary,
          attributes: {
            ...stagedOrdinary.attributes,
            engram_literal_v1: { version: 3, family: 'autonomous-personal-v1' },
          },
        },
      ],
      edges: [],
      outcome: {
        status: 'disabled' as const,
        reason: 'disabled' as const,
        duration_ms: 0,
        counts: {
          entities_created: 0,
          entities_updated: 0,
          edges_created: 0,
          edges_updated: 0,
          edges_expired: 0,
          unchanged: 0,
          malformed: 0,
          filtered: 0,
        },
        stages: [],
        errors: [],
        error_count: 0,
        errors_truncated: false,
      },
    };
    await expect(store.applyStagedExtraction(forgedStaged as never)).rejects.toThrow(
      'reserved_native_record',
    );
    expect(withoutExportedAt(await store.exportGraph(seed.request.namespace))).toEqual(
      withoutExportedAt(stagedGraph),
    );
  });

  it('blocks a foreign namespace orphan before an unrelated ordinary mutation', async () => {
    const { seed } = await createCommittedPair();
    const foreignNamespace = `foreign-${randomUUID()}`;
    namespaces.push(foreignNamespace);
    const orphanId = randomUUID();
    await query(
      `CREATE (:Entity {uuid:$uuid, name:'Foreign orphan', group_id:$group,
        summary:'', entity_type:'autonomous_personal_value', name_embedding:null,
        attributes:'{}', created_at:'2026-10-28T00:00:00.000Z',
        updated_at:'2026-10-28T00:00:00.000Z'})`,
      { uuid: orphanId, group: foreignNamespace },
    );
    const beforeRevision = await revision();
    await expect(
      store.addEntity({
        group_id: seed.request.namespace,
        name: 'Must roll back',
        entity_type: 'unknown',
      }),
    ).rejects.toThrow();
    expect(await revision()).toBe(beforeRevision);
    const beforeEntities = await query(
      'MATCH (e:Entity {group_id:$group}) RETURN count(e) AS count',
      { group: seed.request.namespace },
    );
    const result = await query('MATCH (e:Entity {group_id:$group}) RETURN count(e) AS count', {
      group: seed.request.namespace,
    });
    expect(result.records[0]?.get('count').toNumber()).toBe(
      beforeEntities.records[0]?.get('count').toNumber(),
    );

    await store.close();
    store = new Neo4jStorage(uri!, username, password, database);
    await expect(store.initialize()).rejects.toThrow();
  });

  it('keeps markerless legacy Claim1/2 shared keys and the old value type readable', async () => {
    const lock = await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.autonomous_source_format_v4 AS format",
    );
    const previous = lock.records[0]?.get('format') ?? null;
    const legacyNamespace = `legacy-${randomUUID()}`;
    namespaces.push(legacyNamespace);
    const legacyId = randomUUID();
    await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) REMOVE lock.autonomous_source_format_v4",
    );
    await query(
      `CREATE (:Entity {uuid:$uuid, name:'Legacy value', group_id:$group,
        summary:'', entity_type:'autonomous_personal_value', name_embedding:null,
        attributes:$attributes, created_at:'2026-10-28T00:00:00.000Z',
        updated_at:'2026-10-28T00:00:00.000Z'})`,
      {
        uuid: legacyId,
        group: legacyNamespace,
        attributes: JSON.stringify({
          engram_claim_v1: { version: 2, source: 'legacy' },
          engram_literal_v1: 'legacy scalar',
        }),
      },
    );
    await store.close();
    const readScopeSpy = jest.spyOn(automaticClaimReadScope, 'getAutomaticClaimReadScope');
    const snapshotChargeSpy = jest.spyOn(
      automaticClaimReadScope,
      'reserveAutomaticClaimSnapshotBytes',
    );
    store = new Neo4jStorage(uri!, username, password, database);
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(readScopeSpy).not.toHaveBeenCalled();
    expect(snapshotChargeSpy).not.toHaveBeenCalled();
    const legacy = await store.getEntity(legacyId);
    expect(legacy?.entity_type).toBe('autonomous_personal_value');
    expect(legacy?.attributes.engram_claim_v1).toEqual({ version: 2, source: 'legacy' });
    expect(legacy?.attributes.engram_literal_v1).toBe('legacy scalar');
    if (previous !== null) {
      await query(
        "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.autonomous_source_format_v4=$format",
        { format: previous },
      );
    }
  });

  it('allows markerless plain and nested Source4 mentions through one bounded retry scope', async () => {
    const namespace = `markerless-candidates-${randomUUID()}`;
    namespaces.push(namespace);
    await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) REMOVE lock.autonomous_source_format_v4",
    );
    const plainId = randomUUID();
    const nestedId = randomUUID();
    const largeId = randomUUID();
    const largeText = '界'.repeat(120_000);
    const rows = [
      {
        uuid: plainId,
        attributes: JSON.stringify({
          note: 'Plain mention of engram_write_owner_v4 in free text.',
        }),
      },
      {
        uuid: nestedId,
        attributes: JSON.stringify({
          nested: {
            engram_write_owner_v4: { version: 1 },
            engram_source_envelope_v3: { version: 3 },
          },
        }),
      },
      {
        uuid: largeId,
        attributes: JSON.stringify({
          note: 'Plain mention of engram_source_envelope_v3 in a legacy note.',
          largeText,
        }),
      },
    ];
    await query(
      `UNWIND $rows AS row
       CREATE (:Episode {uuid:row.uuid, group_id:$group, content:'legacy candidate fixture',
         role:'human', source_type:'message', reference_time:'2026-10-28T00:00:00.000Z',
         previous_episode_uuid:null, created_at:'2026-10-28T00:00:00.000Z',
         updated_at:'2026-10-28T00:00:00.000Z', attributes:row.attributes})`,
      { group: namespace, rows },
    );
    await store.close();
    store = new Neo4jStorage(uri!, username, password, database);

    const createdScopes: automaticClaimReadScope.AutomaticClaimReadScope[] = [];
    const attemptScopes: automaticClaimReadScope.AutomaticClaimReadScope[] = [];
    const originalGetScope = automaticClaimReadScope.getAutomaticClaimReadScope;
    const originalBeginAttempt = automaticClaimReadScope.beginAutomaticClaimReadAttempt;
    const internals = store as unknown as {
      getSession: () => Session;
      readNativeGraphDataInTransaction: (...args: unknown[]) => Promise<unknown>;
    };
    const originalGetSession = internals.getSession.bind(store);
    let callbackAttempts = 0;
    let injected = false;
    const retryable = new Neo4jError(
      'synthetic markerless validation retry',
      'ServiceUnavailable',
      'N/A',
      'N/A',
    );
    jest
      .spyOn(automaticClaimReadScope, 'getAutomaticClaimReadScope')
      .mockImplementation((budget) => {
        const scope = originalGetScope(budget);
        createdScopes.push(scope);
        return scope;
      });
    jest
      .spyOn(automaticClaimReadScope, 'beginAutomaticClaimReadAttempt')
      .mockImplementation((scope) => {
        attemptScopes.push(scope);
        return originalBeginAttempt(scope);
      });
    const fullGraphRead = jest.spyOn(internals, 'readNativeGraphDataInTransaction');
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const originalExecuteRead = session.executeRead.bind(session);
      jest.spyOn(session, 'executeRead').mockImplementation((work, config) =>
        originalExecuteRead(async (tx) => {
          callbackAttempts++;
          const value = await work(tx);
          if (!injected) {
            injected = true;
            throw retryable;
          }
          return value;
        }, config),
      );
      return session;
    });

    await expect(store.initialize()).resolves.toBeUndefined();
    expect(injected).toBe(true);
    expect(callbackAttempts).toBe(2);
    expect(createdScopes).toHaveLength(1);
    expect(attemptScopes).toHaveLength(2);
    expect(attemptScopes[0]).toBe(createdScopes[0]);
    expect(attemptScopes[1]).toBe(createdScopes[0]);
    expect(fullGraphRead).not.toHaveBeenCalled();
    const remaining = automaticClaimReadScope.getAutomaticClaimReadScopeRemaining(
      createdScopes[0]!,
    );
    expect(remaining?.sourceHydrationsRemaining).toBe(504);
    expect(remaining?.attemptsRemaining).toBe(126);
    expect(remaining?.contextBytesRemaining).toBeLessThan(8 * 1024 * 1024);
    expect(remaining?.snapshotBytesRemaining).toBeLessThan(100 * 1024 * 1024);
    expect((await store.getEpisode(largeId))?.attributes.largeText).toBe(largeText);
    expect((await store.getEpisode(plainId))?.attributes.note).toContain(
      'Plain mention of engram_write_owner_v4',
    );
    expect((await store.getEpisode(nestedId))?.attributes.nested).toHaveProperty(
      'engram_source_envelope_v3',
    );
  });

  it('rejects a first A1 enrollment when markerless legacy data contains a family4 orphan', async () => {
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    namespaces.push(seed.request.namespace);
    await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) REMOVE lock.autonomous_source_format_v4",
    );
    const orphanId = randomUUID();
    const orphanNamespace = `orphan-${randomUUID()}`;
    namespaces.push(orphanNamespace);
    await query(
      `CREATE (:Entity {uuid:$uuid, name:'Orphan value', group_id:$group,
        summary:'', entity_type:'autonomous_personal_value', name_embedding:null,
        attributes:'{}', created_at:'2026-10-28T00:00:00.000Z',
        updated_at:'2026-10-28T00:00:00.000Z'})`,
      { uuid: orphanId, group: orphanNamespace },
    );
    const result = await dispatchNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed, { executionId: `orphan:${randomUUID()}` }),
      store,
    );
    expect(result.kind).not.toBe('claimed');
    const marker = await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.autonomous_source_format_v4 AS format",
    );
    expect(marker.records[0]?.get('format') ?? null).toBeNull();
    const operationCount = await query(
      'MATCH (op:AutomaticOperation {namespace:$namespace}) RETURN count(op) AS count',
      { namespace: seed.request.namespace },
    );
    expect(operationCount.records[0]?.get('count').toNumber()).toBe(0);
  });

  it('rejects markerless Source4 owner and Operation4 rows during initialization', async () => {
    await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) REMOVE lock.autonomous_source_format_v4",
    );
    const namespace = `unregistered-${randomUUID()}`;
    namespaces.push(namespace);
    const sourceId = randomUUID();
    await query(
      `CREATE (:Episode {uuid:$uuid, group_id:$group, content:'unregistered source',
        role:'human', source_type:'message', reference_time:'2026-10-28T00:00:00.000Z',
        previous_episode_uuid:null, created_at:'2026-10-28T00:00:00.000Z',
        updated_at:'2026-10-28T00:00:00.000Z', attributes:$attributes})`,
      {
        uuid: sourceId,
        group: namespace,
        attributes: JSON.stringify({ engram_write_owner_v4: { version: 1 } }),
      },
    );
    await store.close();
    store = new Neo4jStorage(uri!, username, password, database);
    await expect(store.initialize()).rejects.toThrow('unregistered_native_format');
    await store.close();
    await query('MATCH (ep:Episode {uuid:$uuid}) DETACH DELETE ep', { uuid: sourceId });

    const envelopeId = randomUUID();
    await query(
      `CREATE (:Episode {uuid:$uuid, group_id:$group, content:'unregistered envelope',
        role:'human', source_type:'message', reference_time:'2026-10-28T00:00:00.000Z',
        previous_episode_uuid:null, created_at:'2026-10-28T00:00:00.000Z',
        updated_at:'2026-10-28T00:00:00.000Z', attributes:$attributes})`,
      {
        uuid: envelopeId,
        group: namespace,
        attributes: JSON.stringify({ engram_source_envelope_v3: { version: 3 } }),
      },
    );
    store = new Neo4jStorage(uri!, username, password, database);
    await expect(store.initialize()).rejects.toThrow('unregistered_native_format');
    await store.close();
    await query('MATCH (ep:Episode {uuid:$uuid}) DETACH DELETE ep', { uuid: envelopeId });

    const operationId = randomUUID();
    await query(
      `CREATE (:AutomaticOperation {operation_id:$id, namespace:$namespace,
        record_json:'{"version":4,"state":"synthetic"}'})`,
      { id: operationId, namespace },
    );
    store = new Neo4jStorage(uri!, username, password, database);
    await expect(store.initialize()).rejects.toThrow('unregistered_native_format');
    await store.close();
    await query('MATCH (op:AutomaticOperation {operation_id:$id}) DETACH DELETE op', {
      id: operationId,
    });
  });
});
