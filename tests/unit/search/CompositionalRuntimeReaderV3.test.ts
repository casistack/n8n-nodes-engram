import { performance } from 'perf_hooks';
import { runInNewContext } from 'vm';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import {
  loadCompositionalRuntimeReaderV3,
  isLiveCompositionalRuntimeReaderV3,
  getCompositionalRuntimeParentDataV3,
  getCompositionalRuntimeHistoryDataV3,
  getCompositionalRuntimeNamespaceDataV3,
  getCompositionalRuntimeCandidateDataV3,
  getCompositionalRuntimeRequestAllowanceV3,
  readCompositionalRuntimeFactsV3,
  readCompositionalRuntimeLiteralContextV3,
} from '../../../src/search/CompositionalRuntimeReaderV3';
import { CompositionalRetrievalSnapshotV3Schema } from '../../../src/schemas/CompositionalRetrievalSnapshotV3.schema';
import {
  beginAutomaticClaimReadAttempt,
  getAutomaticClaimReadScopeRemaining,
  type AutomaticClaimReadScope,
} from '../../../src/storage/AutomaticClaimReadScope';
import { EpisodicNodeSchema } from '../../../src/schemas/EpisodicNode.schema';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { interpretCompositionalHumanSourceV3EvidenceWithExecutionReport } from '../../../src/extraction/CompositionalAutomaticCaptureV3Evidence';
import * as Proof from '../../../src/extraction/AutomaticClaimCommitProof';
import { createCompositionalRetrievalSessionFactoryV3 } from '../../../src/search/CompositionalRetrievalSessionV3';
import type { OwnedCompositionalRetrievalSnapshotV3 } from '../../../src/extraction/CompositionalSnapshotIndexV3';

const NOW = '2026-10-25T12:00:03.000Z';
type Fixture = ReturnType<typeof makeCompositionalCommittedClaimFixture>;
const clone = <T>(value: T): T => structuredClone(value);
function backend(f: Pick<Fixture, 'graph'>, outcome?: (scope: AutomaticClaimReadScope) => unknown) {
  let actualScope: AutomaticClaimReadScope | undefined, actualReceiver: unknown;
  const read = jest.fn(function (this: unknown, scope: AutomaticClaimReadScope) {
    actualScope = scope;
    actualReceiver = Reflect.get({ receiver: this }, 'receiver');
    if (!beginAutomaticClaimReadAttempt(scope))
      return Promise.resolve({ status: 'deferred', reason: 'budget_exhausted' });
    return outcome
      ? outcome(scope)
      : Promise.resolve(
          CompositionalRetrievalSnapshotV3Schema.parse({
            status: 'snapshot',
            graph: f.graph,
            backendNow: NOW,
          }),
        );
  });
  const storage = { readCompositionalRetrievalSnapshotV3: read } as unknown as IGraphStorage;
  return { storage, read, scope: () => actualScope!, receiver: () => actualReceiver };
}
async function loaded(f = makeCompositionalCommittedClaimFixture()) {
  const b = backend(f),
    budget = { remaining: 512, deferred: 0 };
  const result = await loadCompositionalRuntimeReaderV3(
    b.storage,
    { namespace: f.request.namespace },
    { budget },
  );
  if (result.status !== 'ready') throw new Error(`Expected reader: ${result.reason}`);
  return { ...f, ...b, reader: result.reader, budget };
}
function locator(h: {
  source: Fixture['source'];
  operation: Pick<Fixture['operation'], 'identity'>;
}) {
  const identity = h.operation.identity;
  return {
    capturedSourceId: h.source.uuid,
    namespace: identity.namespace,
    issuer: identity.issuer,
    actorReference: identity.actorReference,
    turn: identity.turn,
  };
}

describe('actual-capability runtime read adapter (no write or processing permission)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the actual capability receiver, same scope and both four-unit root reservations', async () => {
    const h = await loaded();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.receiver()).toBe(h.storage);
    expect(h.budget.remaining).toBe(504);
    expect(getAutomaticClaimReadScopeRemaining(h.scope())!.attemptsRemaining).toBe(126);
    expect(Object.keys(h.reader)).toEqual([]);
    expect(Object.isFrozen(h.reader)).toBe(true);
    expect(isLiveCompositionalRuntimeReaderV3(h.reader)).toBe(true);
    const facts = readCompositionalRuntimeFactsV3(h.reader, [h.request.edgeId]);
    expect(facts.status).toBe('data');
    if (facts.status !== 'data') throw new Error('Expected data');
    expect(facts.entries[0]).toMatchObject({
      status: 'qualified_current_data',
      lexicalForm: h.graph.edges[0].fact,
    });
    expect(h.budget.remaining).toBe(500);
  });

  it('returns actual parent rows/current binding once, not a parent permission', async () => {
    const h = await loaded(),
      before = getAutomaticClaimReadScopeRemaining(h.scope())!;
    const result = getCompositionalRuntimeParentDataV3(h.reader, locator(h));
    expect(result.status).toBe('parent_data');
    if (result.status !== 'parent_data') throw new Error('Expected parent data');
    expect(result.source.uuid).toBe(h.source.uuid);
    expect(result.operation.operationId).toBe(h.operation.operationId);
    expect(result.currentBinding?.fingerprint).toBe(h.operation.identity.binding.fingerprint);
    expect(result.backendNow).toBe(NOW);
    expect(result).not.toHaveProperty('shouldProcess');
    expect(Object.isFrozen(result.source)).toBe(true);
    const after = getAutomaticClaimReadScopeRemaining(h.scope())!;
    expect(after.sourceHydrationsRemaining).toBe(before.sourceHydrationsRemaining - 4);
    expect(after.contextBytesRemaining).toBeLessThan(before.contextBytesRemaining);
    expect(getCompositionalRuntimeParentDataV3(h.reader, locator(h))).toBe(result);
    expect(h.budget.remaining).toBe(500);
    expect(
      getCompositionalRuntimeParentDataV3(h.reader, { ...locator(h), actorReference: 'other' }),
    ).toEqual({ status: 'deferred', reason: 'locator_mismatch' });
    expect(h.budget.remaining).toBe(500);
  });

  it('supports a committed source-verdict parent with no preference edge', async () => {
    const f = makeCompositionalCaptureFixture('Hello there.');
    const report = interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
      f.source,
      f.operation.descriptor,
      f.operation.identity,
    );
    const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...f.operation,
      state: 'committed',
      generation: 1,
      lastObservedAt: NOW,
      completionCallHash: 'd'.repeat(64),
      terminalReceipt: {
        version: 3,
        kind: 'human_compositional_source_verdict_committed',
        operationId: f.operation.operationId,
        sourceId: f.source.uuid,
        sourceHash: f.operation.identity.sourceHash,
        descriptorHash: f.operation.identity.descriptorHash,
        policyFingerprint: f.operation.identity.policyFingerprint,
        terminalAt: NOW,
        reasons: report.evidence.result.reasons,
        interpretationCoverage: 'none',
        acceptedCoverage: 'none',
        selection: {
          kind: 'source_verdict',
          verdict: 'no_supported_preference_detected',
          interpreterResultHash: report.evidence.interpreterResultHash,
        },
      },
    });
    f.graph.automatic_operations_v1 = { version: 1, operations: [operation] };
    const b = backend(f),
      result = await loadCompositionalRuntimeReaderV3(
        b.storage,
        { namespace: f.source.group_id },
        { budget: { remaining: 512, deferred: 0 } },
      );
    if (result.status !== 'ready') throw new Error('Expected reader');
    const observed = getCompositionalRuntimeParentDataV3(
      result.reader,
      locator({ source: f.source, operation }),
    );
    expect(observed.status).toBe('parent_data');
    if (observed.status !== 'parent_data') throw new Error('Expected data');
    expect(
      observed.operation.state === 'committed' && observed.operation.terminalReceipt.kind,
    ).toBe('human_compositional_source_verdict_committed');
    expect(f.graph.edges).toEqual([]);
  });

  it('rejects fake/cloned/serialized readers before inspecting a locator getter', async () => {
    const h = await loaded();
    let getters = 0;
    const bad = Object.defineProperty({}, 'capturedSourceId', {
      enumerable: true,
      get() {
        getters++;
        throw new Error('not input');
      },
    });
    for (const reader of [{}, clone(h.reader), JSON.parse(JSON.stringify(h.reader))]) {
      expect(isLiveCompositionalRuntimeReaderV3(reader)).toBe(false);
      expect(getCompositionalRuntimeParentDataV3(reader, bad)).toEqual({
        status: 'deferred',
        reason: 'invalid_reader',
      });
      expect(getCompositionalRuntimeHistoryDataV3(reader, bad)).toEqual({
        status: 'deferred',
        reason: 'invalid_reader',
      });
    }
    expect(getters).toBe(0);
  });

  it('does not mutate or trust a caller GraphData object as a reader constructor', async () => {
    const h = await loaded();
    const data = getCompositionalRuntimeParentDataV3(h.reader, locator(h));
    expect(isLiveCompositionalRuntimeReaderV3(data)).toBe(false);
    expect(readCompositionalRuntimeFactsV3(h.graph, [h.request.edgeId])).toEqual({
      status: 'deferred',
      reason: 'invalid_reader',
    });
  });

  it('has no missing-capability, grouped-snapshot, or live-getter fallback', async () => {
    const live = jest.fn(() => {
      throw new Error('not called');
    });
    const storage = {
      getEntity: live,
      getEpisode: live,
      readExtractionSnapshot: live,
    } as unknown as IGraphStorage;
    expect(
      await loadCompositionalRuntimeReaderV3(
        storage,
        { namespace: 'synthetic' },
        { budget: { remaining: 512, deferred: 0 } },
      ),
    ).toEqual({ status: 'deferred', reason: 'missing_capability' });
    expect(live).not.toHaveBeenCalled();
    const f = makeCompositionalCommittedClaimFixture(),
      b = backend(f, () =>
        Promise.resolve({
          status: 'snapshot',
          graph: { ...f.graph, group_id: f.request.namespace },
          backendNow: NOW,
        }),
      );
    expect(
      await loadCompositionalRuntimeReaderV3(
        b.storage,
        { namespace: f.request.namespace },
        { budget: { remaining: 512, deferred: 0 } },
      ),
    ).toEqual({ status: 'deferred', reason: 'invalid_snapshot' });
  });

  it.each([
    { status: 'unavailable', reason: 'missing_store' },
    { status: 'unavailable', reason: 'recovery_required' },
    { status: 'deferred', reason: 'concurrent_snapshot' },
  ])('returns a fixed backend failure without a ready reader: $reason', async (failure) => {
    const f = makeCompositionalCommittedClaimFixture(),
      b = backend(f, () => Promise.resolve(failure));
    expect(
      await loadCompositionalRuntimeReaderV3(
        b.storage,
        { namespace: f.request.namespace },
        { budget: { remaining: 512, deferred: 0 } },
      ),
    ).toEqual({ status: 'deferred', reason: failure.reason });
  });

  it('never awaits a raw thenable or a genuine Promise with own then/constructor overrides', async () => {
    const f = makeCompositionalCommittedClaimFixture();
    let getters = 0;
    const thenable = Object.defineProperty({}, 'then', {
      get() {
        getters++;
        throw new Error('then');
      },
    });
    const pThen = Promise.resolve(null),
      pConstructor = Promise.resolve(null);
    Object.defineProperty(pThen, 'then', {
      get() {
        getters++;
        throw new Error('own then');
      },
    });
    Object.defineProperty(pConstructor, 'constructor', {
      get() {
        getters++;
        throw new Error('own constructor');
      },
    });
    for (const pending of [thenable, pThen, pConstructor]) {
      const b = backend(f, () => pending);
      expect(
        await loadCompositionalRuntimeReaderV3(
          b.storage,
          { namespace: f.request.namespace },
          { budget: { remaining: 512, deferred: 0 } },
        ),
      ).toEqual({ status: 'deferred', reason: 'invalid_response' });
    }
    expect(getters).toBe(0);
  });

  it('accepts a genuine cross-realm Promise and rejects an ordinary getter-bearing result without invoking it', async () => {
    const f = makeCompositionalCommittedClaimFixture();
    const b = backend(f, () =>
      runInNewContext('Promise.resolve(value)', {
        value: { status: 'snapshot', graph: f.graph, backendNow: NOW },
      }),
    );
    expect(
      (
        await loadCompositionalRuntimeReaderV3(
          b.storage,
          { namespace: f.request.namespace },
          { budget: { remaining: 512, deferred: 0 } },
        )
      ).status,
    ).toBe('ready');
    let getters = 0;
    const response = Object.defineProperty({ status: 'snapshot', backendNow: NOW }, 'graph', {
      enumerable: true,
      get() {
        getters++;
        throw new Error('graph');
      },
    });
    const malformed = backend(f, () => Promise.resolve(response));
    expect(
      await loadCompositionalRuntimeReaderV3(
        malformed.storage,
        { namespace: f.request.namespace },
        { budget: { remaining: 512, deferred: 0 } },
      ),
    ).toEqual({ status: 'deferred', reason: 'invalid_snapshot' });
    expect(getters).toBe(0);
  });

  it('redacts a backend rejection and preserves an external cancellation after await', async () => {
    const f = makeCompositionalCommittedClaimFixture(),
      bad = backend(f, () => Promise.reject(new Error('secret backend text')));
    expect(
      await loadCompositionalRuntimeReaderV3(
        bad.storage,
        { namespace: f.request.namespace },
        { budget: { remaining: 512, deferred: 0 } },
      ),
    ).toEqual({ status: 'deferred', reason: 'storage_error' });
    const abort = Object.freeze({ kind: 'synthetic-abort' });
    let cancelled = false;
    const b = backend(f, () => {
      cancelled = true;
      return Promise.resolve({ status: 'snapshot', graph: f.graph, backendNow: NOW });
    });
    let caught: unknown;
    try {
      await loadCompositionalRuntimeReaderV3(
        b.storage,
        { namespace: f.request.namespace },
        {
          budget: { remaining: 512, deferred: 0 },
          check: () => {
            if (cancelled) throw abort;
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(abort);
  });

  it('rejects a delayed result before inspecting its graph and never revives the reader deadline', async () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const f = makeCompositionalCommittedClaimFixture();
    let getters = 0;
    const response = Object.defineProperty({ status: 'snapshot', backendNow: NOW }, 'graph', {
      enumerable: true,
      get() {
        getters++;
        throw new Error('late');
      },
    });
    const b = backend(f, () => {
      now = 6_000;
      return Promise.resolve(response);
    });
    expect(
      await loadCompositionalRuntimeReaderV3(
        b.storage,
        { namespace: f.request.namespace },
        { budget: { remaining: 512, deferred: 0 } },
      ),
    ).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
    expect(getters).toBe(0);
  });

  it('rechecks expiry after publication preparation and before any later locator access', async () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const h = await loaded();
    now = 6_000;
    let getters = 0;
    const raw = Object.defineProperty({}, 'namespace', {
      enumerable: true,
      get() {
        getters++;
        throw new Error('late locator');
      },
    });
    expect(isLiveCompositionalRuntimeReaderV3(h.reader)).toBe(false);
    expect(getCompositionalRuntimeParentDataV3(h.reader, raw)).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(getCompositionalRuntimeHistoryDataV3(h.reader, raw)).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(getters).toBe(0);
  });

  it('preserves owned history order and large chat data without fact-proof fees or per-row parsing', async () => {
    const f = makeCompositionalCommittedClaimFixture();
    const first = EpisodicNodeSchema.parse({
      uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      group_id: f.request.namespace,
      content: 'a'.repeat(80_000),
      reference_time: f.graph.exported_at,
      role: 'human',
      created_at: f.graph.exported_at,
    });
    const second = EpisodicNodeSchema.parse({
      uuid: '00000000-0000-4000-8000-000000000001',
      group_id: f.request.namespace,
      content: 'b'.repeat(80_000),
      reference_time: f.graph.exported_at,
      role: 'ai',
      created_at: f.graph.exported_at,
    });
    f.graph.episodes.push(first, second);
    const h = await loaded(f);
    const result = getCompositionalRuntimeHistoryDataV3(h.reader, {
      namespace: f.request.namespace,
      limit: 2,
    });
    if (result.status !== 'history_data') throw new Error('Expected history data');
    expect(result.episodes.map((row) => row.uuid)).toEqual([first.uuid, second.uuid]);
    expect(result.episodes[0].content).toHaveLength(80_000);
    expect(Object.isFrozen(result.episodes)).toBe(true);
    expect(Object.isFrozen(result.episodes[0])).toBe(true);
    expect(h.budget.remaining).toBe(504);
    expect(
      getCompositionalRuntimeHistoryDataV3(h.reader, { namespace: 'other', limit: 2 }),
    ).toEqual({ status: 'deferred', reason: 'locator_mismatch' });
    expect(
      getCompositionalRuntimeHistoryDataV3(h.reader, {
        namespace: f.request.namespace,
        limit: 10003,
      }),
    ).toEqual({ status: 'deferred', reason: 'invalid_input' });
  });

  it('bounds and charges a failed parent context before exposing any rows, then caches the failure', async () => {
    const f = makeCompositionalCommittedClaimFixture();
    f.graph.entities.find((row) => row.uuid === f.operation.identity.binding.subjectId)!.summary =
      'x'.repeat(513 * 1024);
    const h = await loaded(f),
      before = getAutomaticClaimReadScopeRemaining(h.scope())!.contextBytesRemaining;
    const result = getCompositionalRuntimeParentDataV3(h.reader, locator(h));
    expect(result).toEqual({ status: 'deferred', reason: 'capacity' });
    expect(Object.isFrozen(result)).toBe(true);
    const after = getAutomaticClaimReadScopeRemaining(h.scope())!.contextBytesRemaining;
    expect(after).toBeLessThan(before);
    expect(getCompositionalRuntimeParentDataV3(h.reader, locator(h))).toBe(result);
    expect(getAutomaticClaimReadScopeRemaining(h.scope())!.contextBytesRemaining).toBe(after);
    expect(h.budget.remaining).toBe(500);
  });

  it('uses the same owned literal proof cache for repeated legacy proof reads', async () => {
    const literal = makeHumanFixture();
    delete literal.graph.group_id;
    const proof = jest.spyOn(Proof, 'projectAutomaticClaimReadContextWithUsage');
    const b = backend(literal),
      budget = { remaining: 512, deferred: 0 };
    const result = await loadCompositionalRuntimeReaderV3(
      b.storage,
      { namespace: literal.human.group_id },
      { budget },
    );
    if (result.status !== 'ready') throw new Error('Expected reader');
    const edge = literal.graph.edges.find((row) => row.name === 'PREFERS')!;
    const first = readCompositionalRuntimeLiteralContextV3(result.reader, edge.uuid);
    expect(first.status).toBe('committed');
    expect(readCompositionalRuntimeLiteralContextV3(result.reader, edge.uuid)).toBe(first);
    expect(proof).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(500);
  });

  it('latches cancellation for every retained reader entry point', async () => {
    const f = makeCompositionalCommittedClaimFixture(),
      b = backend(f);
    const abort = Object.freeze({ kind: 'reader-abort' });
    let stop = false;
    const result = await loadCompositionalRuntimeReaderV3(
      b.storage,
      { namespace: f.request.namespace },
      {
        budget: { remaining: 512, deferred: 0 },
        check: () => {
          if (stop) {
            stop = false;
            throw abort;
          }
        },
      },
    );
    if (result.status !== 'ready') throw new Error('Expected reader');
    stop = true;
    for (const read of [
      () => isLiveCompositionalRuntimeReaderV3(result.reader),
      () => getCompositionalRuntimeHistoryDataV3(result.reader, {}),
      () => getCompositionalRuntimeParentDataV3(result.reader, {}),
      () => readCompositionalRuntimeFactsV3(result.reader, []),
      () => getCompositionalRuntimeNamespaceDataV3(result.reader),
    ]) {
      let caught: unknown;
      try {
        read();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(abort);
    }
  });

  it('does not publish a reader when its final result freeze exhausts the original deadline', async () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const original = Object.freeze;
    jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = original(value);
      if (value && typeof value === 'object' && 'status' in value && value.status === 'ready')
        now = 5001;
      return result;
    });
    const f = makeCompositionalCommittedClaimFixture(),
      b = backend(f);
    expect(
      await loadCompositionalRuntimeReaderV3(
        b.storage,
        { namespace: f.request.namespace },
        { budget: { remaining: 512, deferred: 0 } },
      ),
    ).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
  });

  it('keeps successful borrowed data lookups live-bound and invalidates a failed borrow', () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const f = makeCompositionalCommittedClaimFixture(),
      factory = createCompositionalRetrievalSessionFactoryV3();
    const begun = factory.begin(
      { namespace: f.request.namespace, mode: 'current' },
      { budget: { remaining: 512, deferred: 0 } },
    );
    if (begun.status !== 'intake') throw new Error('Expected intake');
    const prepared = factory.prepare(begun.intake, { graph: f.graph, backendNow: NOW });
    if (prepared.status !== 'prepared_data') throw new Error('Expected session');
    let good: OwnedCompositionalRetrievalSnapshotV3 | undefined;
    expect(
      factory.withOwnedSnapshotData(
        prepared.session,
        (view: OwnedCompositionalRetrievalSnapshotV3) => {
          good = view;
          return { found: !!view.episode(f.source.uuid) };
        },
      ),
    ).toEqual({ status: 'snapshot_data', value: { found: true } });
    expect(good!.episode(f.source.uuid)?.uuid).toBe(f.source.uuid);
    let bad: OwnedCompositionalRetrievalSnapshotV3 | undefined,
      getters = 0;
    const returned = Object.defineProperty({}, 'then', {
      enumerable: true,
      get() {
        getters++;
        throw new Error('unsafe');
      },
    });
    expect(
      factory.withOwnedSnapshotData(
        prepared.session,
        (view: OwnedCompositionalRetrievalSnapshotV3) => {
          bad = view;
          return returned;
        },
      ),
    ).toEqual({ status: 'deferred', reason: 'invalid_input' });
    expect(getters).toBe(0);
    expect(() => bad!.episode(f.source.uuid)).toThrow();
    now = 5001;
    expect(() => good!.episode(f.source.uuid)).toThrow();
    expect(() => good!.graph).toThrow();
  });

  it('projects namespace candidates from the same owned root without changing bytes, order or proof resources', async () => {
    const f = makeCompositionalCommittedClaimFixture(),
      other = makeHumanFixture('other-namespace');
    f.graph.entities.push(...other.graph.entities);
    f.graph.edges.push(...other.graph.edges);
    f.graph.episodes.push(...other.graph.episodes);
    f.graph.automatic_operations_v1!.operations.push(
      ...other.graph.automatic_operations_v1!.operations,
    );
    f.graph.metadata = {
      generated_by: 'synthetic namespace snapshot',
      entity_count: f.graph.entities.length,
    };
    const large = EpisodicNodeSchema.parse({
      uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      group_id: f.request.namespace,
      content: 'z'.repeat(80_000),
      role: 'human',
      reference_time: NOW,
      created_at: NOW,
    });
    f.graph.episodes.push(large);
    const h = await loaded(f),
      before = getAutomaticClaimReadScopeRemaining(h.scope());
    const result = getCompositionalRuntimeNamespaceDataV3(h.reader);
    if (result.status !== 'namespace_data') throw new Error(result.reason);
    expect(result.graph.group_id).toBe(f.request.namespace);
    expect(result.graph.metadata).toEqual(f.graph.metadata);
    expect(result.graph.entities).toEqual(
      f.graph.entities.filter((row) => row.group_id === f.request.namespace),
    );
    expect(result.graph.edges).toEqual(
      f.graph.edges.filter((row) => row.group_id === f.request.namespace),
    );
    expect(result.graph.episodes).toEqual(
      f.graph.episodes.filter((row) => row.group_id === f.request.namespace),
    );
    expect(result.graph.automatic_operations_v1!.operations).toEqual([f.operation]);
    expect(result.graph.episodes.at(-1)!.content).toHaveLength(80_000);
    const actual = getCompositionalRuntimeCandidateDataV3(h.reader, h.request.edgeId);
    if (actual.status !== 'candidate_data') throw new Error(actual.reason);
    expect(result.graph.entities.find((row) => row.uuid === actual.subject.uuid)).toBe(
      actual.subject,
    );
    expect(Object.isFrozen(result.graph)).toBe(true);
    for (const rows of [
      result.graph.entities,
      result.graph.edges,
      result.graph.episodes,
      result.graph.automatic_operations_v1!.operations,
    ])
      expect(Object.isFrozen(rows)).toBe(true);
    expect(isLiveCompositionalRuntimeReaderV3(result)).toBe(false);
    expect(h.budget.remaining).toBe(504);
    const after = getAutomaticClaimReadScopeRemaining(h.scope())!;
    expect({ ...after, deadlineRemainingMs: 0 }).toEqual({ ...before, deadlineRemainingMs: 0 });
    expect(after.deadlineRemainingMs).toBeLessThanOrEqual(before!.deadlineRemainingMs);
  });

  it('authenticates namespace access and checks the original deadline after its final freeze', async () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const h = await loaded();
    let traps = 0;
    const fake = new Proxy(
      {},
      {
        get() {
          traps++;
          throw new Error('unsafe');
        },
        ownKeys() {
          traps++;
          throw new Error('unsafe');
        },
      },
    );
    expect(getCompositionalRuntimeNamespaceDataV3(fake)).toEqual({
      status: 'deferred',
      reason: 'invalid_reader',
    });
    expect(getCompositionalRuntimeNamespaceDataV3(clone(h.reader))).toEqual({
      status: 'deferred',
      reason: 'invalid_reader',
    });
    const freeze = Object.freeze;
    jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = freeze(value);
      if (
        value &&
        typeof value === 'object' &&
        'status' in value &&
        value.status === 'namespace_data'
      )
        now = 5001;
      return result;
    });
    expect(getCompositionalRuntimeNamespaceDataV3(h.reader)).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(traps).toBe(0);
  });

  it('returns only a conservative original request deadline, never a fresh network window', async () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
    const h = await loaded();
    clock
      .mockReturnValue(60)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(40)
      .mockReturnValueOnce(50);
    const allowance = getCompositionalRuntimeRequestAllowanceV3(h.reader);
    expect(allowance).toEqual({ deadlineAt: 4990 });
    expect(Object.isFrozen(allowance)).toBe(true);
    expect(getCompositionalRuntimeRequestAllowanceV3(h.reader)!.deadlineAt).toBeLessThanOrEqual(
      5000,
    );
    expect(isLiveCompositionalRuntimeReaderV3(allowance)).toBe(false);
    let traps = 0;
    const fake = new Proxy(
      {},
      {
        get() {
          traps++;
          throw new Error('unsafe');
        },
        ownKeys() {
          traps++;
          throw new Error('unsafe');
        },
      },
    );
    expect(getCompositionalRuntimeRequestAllowanceV3(fake)).toBeNull();
    expect(traps).toBe(0);
  });

  it('withholds an allowance when its final freeze crosses the original deadline', async () => {
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const h = await loaded(),
      freeze = Object.freeze;
    jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = freeze(value);
      if (value && typeof value === 'object' && 'deadlineAt' in value) clock = 5001;
      return result;
    });
    expect(getCompositionalRuntimeRequestAllowanceV3(h.reader)).toBeNull();
  });
});
