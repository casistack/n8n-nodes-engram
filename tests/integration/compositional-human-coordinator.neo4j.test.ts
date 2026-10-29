import neo4j from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { captureCompositionalHumanMemoryV3 } from '../../src/memory/CompositionalHumanCaptureV3';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { neo4jAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { loadCompositionalRuntimeReaderV3 } from '../../src/search/CompositionalRuntimeReaderV3';
import { validateCompositionalMemoryParentV3 } from '../../src/memory/CompositionalMemoryParentV3';
import type { CompositionalMemoryParentExpectedV3 } from '../../src/schemas/CompositionalMemoryParentV3.schema';

jest.setTimeout(60_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI ?? '';
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

describeNeo('actual Neo4j native V3 human capture coordinator', () => {
  let store: Neo4jStorage;
  let driver: ReturnType<typeof neo4j.driver>;
  let request: ReturnType<typeof CompositionalAutomaticCaptureBeginRequestV3Schema.parse>;
  let binding: Awaited<ReturnType<typeof seedAutomaticCaptureSubject>>['binding'];

  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };

  beforeEach(async () => {
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    const seeded = await seedAutomaticCaptureSubject(store);
    binding = seeded.binding;
    request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...seeded.request,
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      source: {
        ...seeded.request.source,
        content:
          'I prefer explanations in plain British English, with one practical example before technical terms.',
      },
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    if (request) {
      const namespace = request.namespace;
      await query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
        namespace,
      });
      await query(
        'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
        { namespace },
      );
      await query('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', { namespace });
    }
    await driver?.close();
  });

  const snapshot = () => store.readExtractionSnapshot(request.namespace);
  const parent = async (sourceId: string | null, valid = true) => {
    if (!sourceId) throw new Error('Expected captured source');
    const storeIdentity = neo4jAutomaticCaptureStoreHash(uri, database);
    if (!storeIdentity) throw new Error('Expected configured store identity');
    const expected: CompositionalMemoryParentExpectedV3 = {
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      namespace: request.namespace,
      currentHumanInput: request.source.content,
      expectedHumanProcessingAttemptHash: request.attemptIdHash,
      invocationDeadlineMs: request.settings.invocationDeadlineMs,
      runtime: {
        profileId: request.settings.profileId,
        storeIdentity,
        turnId: request.turn,
        capturedSourceId: sourceId,
        explicitIntent: request.settings.intentSetting,
        actor: {
          namespace: request.namespace,
          issuer: request.issuer,
          actorReference: request.actorReference,
          quoteRegions: [],
        },
      },
    };
    const loaded = await loadCompositionalRuntimeReaderV3(
      store,
      { namespace: request.namespace },
      {
        budget: { remaining: 512, deferred: 0 },
      },
    );
    if (loaded.status !== 'ready') throw new Error(JSON.stringify(loaded));
    const result = validateCompositionalMemoryParentV3(loaded.reader, expected);
    if (valid) {
      expect(result.status).toBe('valid_parent_data');
      expect(
        validateCompositionalMemoryParentV3(loaded.reader, {
          ...expected,
          expectedHumanProcessingAttemptHash: 'f'.repeat(64),
        }),
      ).toEqual({ status: 'rejected', reason: 'processing_attempt_mismatch' });
    }
    return result;
  };

  it('commits accepted bundles once and returns a false historical receipt on redelivery', async () => {
    const before = await snapshot();
    const first = await captureCompositionalHumanMemoryV3(store, request);
    expect(first).toMatchObject({ status: 'first_capture_committed', should_process: true });
    expect(first.receiptSummary?.kind).toBe('committed');
    await parent(first.sourceId);
    const committed = await snapshot();
    expect(committed.episodes).toHaveLength(before.episodes.length + 1);
    expect(committed.edges.length).toBeGreaterThan(before.edges.length);

    const replayRequest = structuredClone(request);
    replayRequest.attemptIdHash = 'c'.repeat(64);
    const replay = await captureCompositionalHumanMemoryV3(store, replayRequest);
    expect(replay).toMatchObject({
      status: 'committed_replay',
      sourceId: first.sourceId,
      should_process: false,
      receiptSummary: first.receiptSummary,
    });
    expect((await snapshot()).episodes).toEqual(committed.episodes);
  });

  it('permits a first ReviewFirst turn with persisted proposed claims and accepted coverage none', async () => {
    request.settings.profileId = 'reviewFirst';
    const result = await captureCompositionalHumanMemoryV3(store, request);
    expect(result).toMatchObject({
      status: 'first_capture_committed',
      should_process: true,
      receiptSummary: {
        kind: 'committed',
        acceptedCoverage: 'none',
        selection: { kind: 'bundles' },
      },
    });
    if (
      result.receiptSummary?.kind !== 'committed' ||
      result.receiptSummary.selection.kind !== 'bundles'
    )
      throw new Error('Expected proposed bundle summary');
    expect(result.receiptSummary.counts.byState.proposed).toBeGreaterThan(0);
    await parent(result.sourceId);
  });

  it('permits a zero-fact temporary-question conversation and preserves its source-verdict replay', async () => {
    request.source.content = 'What games are on today?';
    const first = await captureCompositionalHumanMemoryV3(store, request);
    expect(first).toMatchObject({
      status: 'first_capture_committed',
      should_process: true,
      receiptSummary: {
        kind: 'committed',
        acceptedCoverage: 'none',
        selection: { kind: 'source_verdict', verdict: 'no_supported_preference_detected' },
        counts: { bundleCount: 0, distinctPersistedClaimCount: 0 },
      },
    });
    await parent(first.sourceId);
    const replayRequest = structuredClone(request);
    replayRequest.attemptIdHash = 'd'.repeat(64);
    expect(await captureCompositionalHumanMemoryV3(store, replayRequest)).toMatchObject({
      status: 'committed_replay',
      sourceId: first.sourceId,
      should_process: false,
    });
    expect((await snapshot()).edges).toHaveLength(0);
  });

  it('rejects changed content without source disclosure or another episode', async () => {
    const first = await captureCompositionalHumanMemoryV3(store, request);
    expect(first.should_process).toBe(true);
    const committed = await snapshot();
    const changed = structuredClone(request);
    changed.attemptIdHash = 'e'.repeat(64);
    changed.source.content += ' Changed after the original capture.';
    expect(await captureCompositionalHumanMemoryV3(store, changed)).toMatchObject({
      status: 'conflict',
      sourceId: null,
      should_process: false,
      receiptSummary: null,
    });
    expect((await snapshot()).episodes).toEqual(committed.episodes);
  });

  it('rejects a formerly valid parent after current binding revocation without changing source or receipt', async () => {
    const first = await captureCompositionalHumanMemoryV3(store, request);
    expect(first.should_process).toBe(true);
    await parent(first.sourceId);
    const before = await snapshot();
    await store.automaticBindingCommand({
      action: 'revoke',
      namespace: request.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic revocation',
    });
    expect(await parent(first.sourceId, false)).toEqual({
      status: 'rejected',
      reason: 'authority_changed',
    });
    const after = await snapshot();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });
});
