import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import {
  createCompositionalCompletionStageFactoryV3,
  CompositionalCompletionStageFailureV3,
} from '../../../src/storage/CompositionalCompletionStageV3';
import {
  CompositionalCaptureRegistryActualV3Schema,
  parseCompositionalCaptureCompletionInvocationV3,
  type CompositionalCaptureCompletionInvocationV3,
  type CompositionalCaptureAttemptAuditV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  compositionalCaptureOperationIdentityHashV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { GraphDataSchema, type GraphData } from '../../../src/schemas/GraphData.schema';
import { assertAutomaticBindingIdentity } from '../../../src/storage/AutomaticIdentity';
import * as Planner from '../../../src/extraction/CompositionalMaterializationV3';
import { reviewExtractionMetadata } from '../../../src/schemas/ExtractionMetadata.schema';

const T0 = '2026-10-25T12:00:00.000Z';
const T1 = '2026-10-25T12:00:01.000Z';
const T2 = '2026-10-25T12:00:02.000Z';
const T3 = '2026-10-25T12:00:03.000Z';
const EXPIRY = '2026-10-25T12:01:01.000Z';
const RICH =
  'I like responses in plain Australian English, with one worked example ahead of any technical terms.';
const clone = <T>(value: T): T => structuredClone(value);

function fixture(
  options: {
    content?: string;
    profileId?: 'conservative' | 'explicit' | 'reviewFirst';
    committed?: ReturnType<typeof makeCompositionalCommittedClaimFixture>;
  } = {},
) {
  const prior = options.committed;
  const base = makeCompositionalCaptureFixture(
    options.content ?? prior?.source.content ?? RICH,
    prior?.operation.identity.storeHash,
  );
  const subject =
    prior?.graph.entities.find((row) => row.uuid === prior.operation.identity.binding.subjectId) ??
    base.graph.entities.find((row) => row.uuid === base.operation.identity.binding.subjectId)!;
  const namespace = prior?.operation.identity.namespace ?? base.operation.identity.namespace;
  const input = clone(base.input);
  input.request.namespace = namespace;
  input.request.issuer = prior?.operation.identity.issuer ?? input.request.issuer;
  input.request.actorReference =
    prior?.operation.identity.actorReference ?? input.request.actorReference;
  input.request.settings.profileId = options.profileId ?? 'conservative';
  const sourceGraph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: T0,
    entities: [subject],
    edges: [],
    episodes: [],
  });
  const built = buildCompositionalHumanCaptureSourceV3(sourceGraph, input);
  const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...base.operation,
    identity: built.identity,
    descriptor: built.descriptor,
    state: 'leased',
    generation: 1,
    lastObservedAt: T1,
    attempts: [{ attemptHash: '1'.repeat(64), at: T0, disposition: 'claim_won' }],
    lease: {
      token: randomUUID(),
      acquiredAt: T0,
      renewedAt: T1,
      expiresAt: EXPIRY,
      claimKind: 'initial',
    },
  });
  const graph = GraphDataSchema.parse({
    ...(prior?.graph ?? sourceGraph),
    episodes: [...(prior?.graph.episodes ?? []), built.episode],
    automatic_operations_v1: {
      version: 1,
      operations: [...(prior?.graph.automatic_operations_v1?.operations ?? []), operation],
    },
  });
  if (operation.state !== 'leased') throw new Error('Expected leased fixture');
  const wrapper = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
    built.episode.attributes.engram_source_envelope_v2,
  );
  const invocation = parseCompositionalCaptureCompletionInvocationV3({
    boundFence: {
      version: 3,
      purpose: 'human_turn_memory',
      operationId: operation.operationId,
      sourceId: operation.identity.sourceId,
      descriptorHash: operation.identity.descriptorHash,
      identityHash: compositionalCaptureOperationIdentityHashV3(operation.identity),
      sourceHash: operation.identity.sourceHash,
      envelopeHash: hashAutomaticCaptureV2(wrapper),
      beginCallHash: operation.beginCallHash,
      state: 'leased',
      generation: 1,
      token: operation.lease.token,
      claimKind: 'initial',
      retryCount: 0,
      planTimestamp: T1,
    },
    storeHash: operation.identity.storeHash,
    namespace,
    sourceHash: operation.identity.sourceHash,
    envelopeHash: hashAutomaticCaptureV2(wrapper),
    expiresAt: EXPIRY,
    acknowledgedBackendNow: T1,
    leaseRemainingMsAtMonotonicAnchor: 60_000,
    invocationDeadlineAtMonotonicMs: performance.now() + 30_000,
    claimKind: 'initial',
    completionCallHash: '9'.repeat(64),
    audit: Object.freeze({}),
  });
  const actual = (backendNow = T2, currentGraph: GraphData = graph) => ({
    storeHash: operation.identity.storeHash,
    namespace,
    backendNow,
    graph: currentGraph,
    operation: currentGraph.automatic_operations_v1!.operations.find(
      (row) => row.operationId === operation.operationId,
    )!,
  });
  return { base, graph, operation, invocation, actual };
}

/** Code-owned synthetic callbacks; no actual backend registry or processing proof is installed. */
function harness(f = fixture()) {
  const cap = Object.freeze({});
  const known = new WeakMap<object, CompositionalCaptureCompletionInvocationV3>([
    [cap, f.invocation],
  ]);
  const authenticate = jest.fn((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || !known.has(candidate))
      throw new CompositionalCompletionStageFailureV3('invalid_capability');
  });
  let audit: CompositionalCaptureAttemptAuditV3 = {
    action: 'completion',
    attemptIdHash: '2'.repeat(64),
    operationId: f.operation.operationId,
    sourceId: f.operation.identity.sourceId,
  };
  const resolve = jest.fn((candidate: unknown, raw: unknown, expected: 'leased' | 'committed') => {
    authenticate(candidate);
    const parsed = CompositionalCaptureRegistryActualV3Schema.safeParse(raw);
    if (!parsed.success) return null;
    const actual = parsed.data,
      op = actual.operation;
    if (
      op.state !== expected ||
      op.operationId !== f.operation.operationId ||
      compositionalCaptureOperationIdentityHashV3(op.identity) !==
        f.invocation.boundFence.identityHash
    )
      return null;
    if (
      expected === 'leased' &&
      (op.state !== 'leased' ||
        op.lease.token !== f.invocation.boundFence.token ||
        op.lease.renewedAt !== f.invocation.boundFence.planTimestamp)
    )
      return null;
    const source = actual.graph.episodes.find((row) => row.uuid === op.identity.sourceId);
    if (
      !source ||
      source.review_status !== 'accepted' ||
      source.trust_level !== op.descriptor.requestedTrustLevel
    )
      return null;
    try {
      assertAutomaticBindingIdentity(
        actual.graph,
        op.identity.namespace,
        op.identity.issuer,
        op.identity.actorReference,
        op.identity.binding,
      );
    } catch {
      return null;
    }
    return { actual, invocation: known.get(candidate as object)! };
  });
  const factory = createCompositionalCompletionStageFactoryV3({
    authenticate,
    resolve,
    readCompletionAudit(candidate) {
      authenticate(candidate);
      return audit;
    },
  });
  return {
    ...f,
    cap,
    factory,
    authenticate,
    resolve,
    setAudit(value: CompositionalCaptureAttemptAuditV3) {
      audit = value;
    },
  };
}

function prepare(h: ReturnType<typeof harness>, budget = { remaining: 512, deferred: 0 }) {
  const result = h.factory.prepare(h.cap, h.actual(), budget);
  if (result.status !== 'prepared_stage')
    throw new Error(`Stage preparation failed: ${result.reason}`);
  return { stage: result.stage, budget };
}
function apply(
  h: ReturnType<typeof harness>,
  stage: ReturnType<typeof prepare>['stage'],
  now = T3,
) {
  const result = h.factory.prepareApply(h.cap, stage, h.actual(now));
  if (result.status !== 'prepared_apply')
    throw new Error(`Apply preparation failed: ${result.reason}`);
  return result.candidate;
}
function committedGraph(
  h: ReturnType<typeof harness>,
  candidate: ReturnType<typeof apply>,
): GraphData {
  return GraphDataSchema.parse({
    ...h.graph,
    entities: [...h.graph.entities, ...candidate.plan.createEntities],
    edges: [...h.graph.edges, ...candidate.plan.createEdges],
    automatic_operations_v1: {
      version: 1,
      operations: h.graph.automatic_operations_v1!.operations.map((op) =>
        op.operationId === h.operation.operationId ? candidate.operation : op,
      ),
    },
  });
}

describe('standalone compositional completion stage (candidate data only)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('plans once, keeps row time pinned, and verifies only the exact committed candidate', () => {
    const h = harness(),
      before = clone(h.graph);
    const planner = jest.spyOn(Planner, 'planCompositionalMaterializationV3');
    const { stage } = prepare(h);
    expect(Object.keys(stage)).toEqual([]);
    expect(Object.isFrozen(stage)).toBe(true);
    const candidate = apply(h, stage);
    expect(planner).toHaveBeenCalledTimes(1);
    expect(candidate.plan.createEdges[0].created_at).toBe(T1);
    expect(candidate.receipt.terminalAt).toBe(T3);
    expect(candidate.operation.state).toBe('committed');
    expect(candidate.operation.attempts[0]).toEqual(h.operation.attempts[0]);
    expect(candidate.operation.attempts.at(-1)?.disposition).toBe('committed');
    const graph = committedGraph(h, candidate);
    expect(h.factory.verifyAcknowledged(h.cap, h.actual(T3, graph))).toBe(true);
    expect(planner).toHaveBeenCalledTimes(1);
    graph.edges.at(-1)!.fact += ' changed';
    expect(h.factory.verifyAcknowledged(h.cap, h.actual(T3, graph))).toBe(false);
    expect(h.graph).toEqual(before);
  });

  it.each([
    {
      profileId: 'reviewFirst' as const,
      content: RICH,
      states: ['proposed'],
      mutations: ['created'],
      coverage: 'none',
    },
    {
      profileId: 'explicit' as const,
      content: RICH,
      states: ['not_selected'],
      mutations: ['none'],
      coverage: 'none',
    },
    {
      profileId: 'conservative' as const,
      content: 'I like JSON. I like JSON.',
      states: ['accepted', 'unchanged'],
      mutations: ['created', 'none'],
      coverage: 'all',
    },
  ])(
    'retains whole occurrence selection for $profileId/$content',
    ({ states, mutations, coverage, ...options }) => {
      const h = harness(fixture(options));
      const candidate = apply(h, prepare(h).stage);
      expect(candidate.receipt.kind).toBe('human_compositional_capture_committed');
      if (candidate.receipt.kind !== 'human_compositional_capture_committed')
        throw new Error('Wrong receipt');
      expect(candidate.receipt.selection.items.map((item) => item.state)).toEqual(states);
      expect(candidate.receipt.selection.items.map((item) => item.mutation)).toEqual(mutations);
      expect(candidate.receipt.acceptedCoverage).toBe(coverage);
      expect(candidate.receipt.selection.items.every((item) => item.reason !== undefined)).toBe(
        true,
      );
    },
  );

  it('references an actual qualified committed pair without changing old records', () => {
    const prior = makeCompositionalCommittedClaimFixture();
    const h = harness(fixture({ committed: prior }));
    const candidate = apply(h, prepare(h).stage);
    expect(candidate.plan.createEntities).toEqual([]);
    expect(candidate.plan.createEdges).toEqual([]);
    if (candidate.receipt.kind !== 'human_compositional_capture_committed')
      throw new Error('Wrong receipt');
    expect(candidate.receipt.selection.items[0]).toMatchObject({
      state: 'unchanged',
      mutation: 'none',
      reason: 'existing_accepted',
    });
    expect(h.factory.verifyAcknowledged(h.cap, h.actual(T3, committedGraph(h, candidate)))).toBe(
      true,
    );
  });

  it.each(['Hello there.', 'I might prefer French.'])(
    'does not fabricate a bundle receipt for a source-verdict branch: %s',
    (content) => {
      const h = harness(fixture({ content }));
      expect(h.factory.prepare(h.cap, h.actual(), { remaining: 512, deferred: 0 })).toEqual({
        status: 'deferred',
        reason: 'source_verdict_required',
      });
      expect(h.factory.verifyAcknowledged(h.cap, h.actual())).toBe(false);
    },
  );

  it.each(['proposed', 'rejected'] as const)(
    'keeps an existing %s pair unchanged and never promotes its receipt coverage',
    (review) => {
      const prior = makeCompositionalCommittedClaimFixture('proposed');
      if (review === 'rejected') {
        const edge = prior.graph.edges[0];
        const value = prior.graph.entities.find((row) => row.uuid === edge.target_node_uuid)!;
        for (const row of [edge, value])
          row.attributes.engram_extraction = reviewExtractionMetadata(
            row.attributes.engram_extraction,
            'rejected',
            'synthetic-reviewer',
            T1,
          );
      }
      const h = harness(fixture({ committed: prior }));
      const candidate = apply(h, prepare(h).stage);
      if (candidate.receipt.kind !== 'human_compositional_capture_committed')
        throw new Error('Wrong receipt');
      expect(candidate.receipt.selection.items[0]).toMatchObject({
        state: review,
        mutation: 'none',
        persisted: true,
        reason: `existing_${review}`,
      });
      expect(candidate.receipt.acceptedCoverage).toBe('none');
      expect(candidate.plan.createEdges).toEqual([]);
    },
  );

  it('reports partial accepted coverage without dropping a declined source occurrence', () => {
    const prior = makeCompositionalCommittedClaimFixture();
    const h = harness(
      fixture({ committed: prior, content: `${prior.source.content} I like French.` }),
    );
    const candidate = apply(h, prepare(h).stage);
    if (candidate.receipt.kind !== 'human_compositional_capture_committed')
      throw new Error('Wrong receipt');
    expect(candidate.receipt.acceptedCoverage).toBe('partial');
    expect(candidate.receipt.selection.items.map((item) => item.state)).toEqual([
      'unchanged',
      'not_selected',
    ]);
    expect(candidate.receipt.selection.items.map((item) => item.bundleIndex)).toEqual([0, 1]);
    expect(candidate.plan.createEdges).toEqual([]);
  });

  it('retains the first32 unique audits and marks truncation without evicting claim_won', () => {
    const f = fixture();
    const operation = f.graph.automatic_operations_v1!.operations.find(
      (op) => op.operationId === f.operation.operationId,
    )!;
    operation.attempts = [
      operation.attempts[0],
      ...Array.from({ length: 31 }, (_, index) => ({
        attemptHash: (index + 100).toString(16).padStart(64, '0'),
        at: T1,
        disposition: 'in_progress' as const,
      })),
    ];
    const before = clone(operation.attempts);
    const h = harness(f),
      candidate = apply(h, prepare(h).stage);
    expect(candidate.operation.attempts).toEqual(before);
    expect(candidate.operation.attempts).toHaveLength(32);
    expect(candidate.operation.attempts[0].disposition).toBe('claim_won');
    expect(candidate.operation.auditTruncated).toBe(true);
    expect(candidate.operation.overflowCount).toBe(operation.overflowCount);
    expect(h.factory.verifyAcknowledged(h.cap, h.actual(T3, committedGraph(h, candidate)))).toBe(
      true,
    );
  });

  it('allows only append-only committed replay audits on a referenced creator', () => {
    const prior = makeCompositionalCommittedClaimFixture();
    const originalCreator = prior.graph.automatic_operations_v1!.operations.find(
      (op) => op.operationId === prior.operation.operationId,
    )!;
    originalCreator.attempts.push({
      attemptHash: '6'.repeat(64),
      at: T1,
      disposition: 'committed_replay',
    });
    originalCreator.lastObservedAt = T1;
    const h = harness(fixture({ committed: prior }));
    const candidate = apply(h, prepare(h).stage);
    const graph = committedGraph(h, candidate);
    const creator = graph.automatic_operations_v1!.operations.find(
      (op) => op.operationId === prior.operation.operationId,
    )!;
    creator.attempts.push({ attemptHash: '4'.repeat(64), at: T3, disposition: 'committed_replay' });
    creator.lastObservedAt = T3;
    expect(h.factory.verifyAcknowledged(h.cap, h.actual(T3, graph))).toBe(true);
    creator.attempts[0].attemptHash = '5'.repeat(64);
    expect(h.factory.verifyAcknowledged(h.cap, h.actual(T3, graph))).toBe(false);
  });

  it('rejects fake capabilities before inspecting hostile snapshots or resources', () => {
    const h = harness();
    let traps = 0;
    const raw = new Proxy(
      {},
      {
        get() {
          traps++;
          throw new Error('raw trap');
        },
        getPrototypeOf() {
          traps++;
          throw new Error('prototype trap');
        },
      },
    );
    expect(h.factory.prepare({}, raw, raw).status).toBe('deferred');
    expect(traps).toBe(0);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('rejects hostile resource objects without invoking getters or snapshot resolution', () => {
    const h = harness();
    let reads = 0;
    const budget = Object.defineProperty({ deferred: 0 }, 'remaining', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('resource getter');
      },
    });
    expect(h.factory.prepare(h.cap, h.actual(), budget).status).toBe('deferred');
    expect(reads).toBe(0);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('rejects cloned, cross-cap, and cross-factory stage tokens', () => {
    const h = harness(),
      stage = prepare(h).stage;
    const other = harness();
    for (const token of [{}, clone(stage)])
      expect(h.factory.prepareApply(h.cap, token, h.actual()).status).toBe('deferred');
    expect(other.factory.prepareApply(other.cap, stage, other.actual()).status).toBe('deferred');
    expect(h.factory.prepareApply(other.cap, stage, h.actual()).status).toBe('deferred');
    expect(h.factory.verifyAcknowledged(other.cap, h.actual())).toBe(false);
  });

  it('binds retries to one original resource scope and invalidates replaced stage tokens', () => {
    const h = harness(),
      first = prepare(h);
    expect(h.factory.prepare(h.cap, h.actual(), { remaining: 512, deferred: 0 }).status).toBe(
      'deferred',
    );
    const second = h.factory.prepare(h.cap, h.actual(), first.budget);
    expect(second.status).toBe('prepared_stage');
    expect(h.factory.prepareApply(h.cap, first.stage, h.actual()).status).toBe('deferred');
  });

  it('rejects an already expired shared scope before resolving another full root', () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const h = harness(),
      first = prepare(h);
    h.resolve.mockClear();
    now = 6_000;
    expect(h.factory.prepare(h.cap, h.actual(), first.budget)).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('requires a matching authenticated completion audit and immutable current source', () => {
    const h = harness();
    h.setAudit({
      action: 'initial',
      attemptIdHash: '3'.repeat(64),
      operationId: h.operation.operationId,
      sourceId: h.operation.identity.sourceId,
    });
    expect(h.factory.prepare(h.cap, h.actual(), { remaining: 512, deferred: 0 })).toEqual({
      status: 'deferred',
      reason: 'invalid_audit',
    });
    const active = harness(),
      { stage } = prepare(active);
    const changed = clone(active.graph);
    changed.episodes[0].review_status = 'rejected';
    expect(active.factory.prepareApply(active.cap, stage, active.actual(T3, changed)).status).toBe(
      'deferred',
    );
  });

  it('fences expiry equality and monotonic staging time, without mutating the source', () => {
    const h = harness(),
      { stage } = prepare(h),
      before = clone(h.graph);
    expect(h.factory.prepareApply(h.cap, stage, h.actual(EXPIRY))).toEqual({
      status: 'deferred',
      reason: 'lease_expired',
    });
    const regressed = harness(),
      regressedStage = prepare(regressed).stage;
    expect(
      regressed.factory.prepareApply(regressed.cap, regressedStage, regressed.actual(T0)),
    ).toEqual({ status: 'deferred', reason: 'clock_regression' });
    expect(h.graph).toEqual(before);
  });

  it('propagates one-shot cancellation caught inside parser recovery with the same identity', () => {
    const h = harness(),
      abort = Object.freeze({ kind: 'synthetic-stage-cancel' });
    const original = h.authenticate.getMockImplementation()!;
    let fired = false;
    h.authenticate.mockImplementation((cap) => {
      original(cap);
      if (!fired && new Error().stack?.includes('CompositionalPreferenceV2Parser')) {
        fired = true;
        throw abort;
      }
    });
    let caught: unknown;
    try {
      prepare(h);
    } catch (error) {
      caught = error;
    }
    expect(fired).toBe(true);
    expect(caught).toBe(abort);
    expect(h.factory.verifyAcknowledged(h.cap, h.actual())).toBe(false);
  });

  it('rechecks the original shared deadline after freezing an apply candidate', () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const h = harness(),
      { stage } = prepare(h);
    const freeze = Object.freeze;
    let fired = false;
    jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = freeze(value);
      if (
        value &&
        typeof value === 'object' &&
        'plan' in value &&
        'receipt' in value &&
        'operation' in value
      ) {
        fired = true;
        now = 6_000;
      }
      return result;
    });
    expect(h.factory.prepareApply(h.cap, stage, h.actual(T3))).toMatchObject({
      status: 'deferred',
    });
    expect(fired).toBe(true);
  });
});
