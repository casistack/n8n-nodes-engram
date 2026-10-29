import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { createCompositionalRetrievalSessionFactoryV3 } from '../../../src/search/CompositionalRetrievalSessionV3';
import { reviewExtractionMetadata } from '../../../src/schemas/ExtractionMetadata.schema';
import type { CompositionalRetrievalReadResultV3 } from '../../../src/schemas/CompositionalRetrievalSessionV3.schema';
import { getAutomaticClaimReadScopeRemaining } from '../../../src/storage/AutomaticClaimReadScope';
import { applyAutomaticBindingCommand } from '../../../src/storage/AutomaticIdentity';
import { compileAutomaticPolicy, captureEnvelope } from '../../../src/extraction/AutomaticEvidence';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { automaticWriteOwnerIdempotencyKey } from '../../../src/storage/AutomaticIdentity';
import { EpisodicNodeSchema } from '../../../src/schemas/EpisodicNode.schema';
import { planAutomaticClaims } from '../../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import * as CaptureFixture from '../../helpers/compositionalCaptureFixture';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { GraphDataSchema } from '../../../src/schemas/GraphData.schema';

const NOW = '2026-10-25T12:00:03.000Z';
const clone = <T>(value: T): T => structuredClone(value);
function setup(
  f = makeCompositionalCommittedClaimFixture(),
  budget = { remaining: 512, deferred: 0 },
) {
  const factory = createCompositionalRetrievalSessionFactoryV3();
  const begun = factory.begin({ namespace: f.request.namespace, mode: 'current' }, { budget });
  if (begun.status !== 'intake') throw new Error('Expected resource intake');
  const scope = factory.getScope(begun.intake)!;
  const prepared = factory.prepare(begun.intake, { graph: f.graph, backendNow: NOW });
  if (prepared.status !== 'prepared_data')
    throw new Error(`Expected data session: ${prepared.reason}`);
  return { ...f, factory, intake: begun.intake, session: prepared.session, budget, scope };
}
function data(result: CompositionalRetrievalReadResultV3) {
  if (result.status !== 'data') throw new Error(`Expected read data: ${result.reason}`);
  return result;
}
function first(h: ReturnType<typeof setup>) {
  return data(h.factory.readMany(h.session, [h.request.edgeId])).entries[0];
}

it('shares literal reservation and inspection bytes between rich consistency and repeated proof reads', () => {
  const f = makeCompositionalCommittedClaimFixture();
  const old = addLiteral(f, 'I prefer short explanations with examples.');
  const h = setup(f);
  expect(first(h).status).toBe('qualified_current_data');
  const remaining = h.budget.remaining;
  const bytes = getAutomaticClaimReadScopeRemaining(h.scope)!.contextBytesRemaining;
  const initial = h.factory.readLiteralContextData(h.session, old.edge.uuid);
  expect(h.factory.readLiteralContextData(h.session, old.edge.uuid)).toBe(initial);
  expect(h.budget.remaining).toBe(remaining);
  expect(getAutomaticClaimReadScopeRemaining(h.scope)!.contextBytesRemaining).toBe(bytes);
});
function addManual(f: ReturnType<typeof makeCompositionalCommittedClaimFixture>, count: number) {
  const original = f.graph.edges[0],
    originalValue = f.graph.entities.find((row) => row.uuid === original.target_node_uuid)!;
  for (let index = 0; index < count; index++) {
    const value = {
      ...clone(originalValue),
      uuid: randomUUID(),
      name: `Synthetic manual ${index}`,
      entity_type: 'concept',
      attributes: {},
    };
    f.graph.entities.push(value);
    f.graph.edges.push({
      ...clone(original),
      uuid: randomUUID(),
      target_node_uuid: value.uuid,
      fact: `Synthetic manual preference ${index}`,
      attributes: {},
      episodes: [],
    });
  }
}
function addLiteral(
  f: ReturnType<typeof makeCompositionalCommittedClaimFixture>,
  content: string,
  review: 'accepted' | 'proposed' | 'rejected' = 'accepted',
) {
  const identity = f.operation.identity,
    policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const captured = captureEnvelope(
    content,
    content,
    {
      namespace: identity.namespace,
      issuer: identity.issuer,
      actorReference: identity.actorReference,
    },
    identity.binding,
    false,
    policy,
  );
  if (!captured.ok) throw new Error(captured.reason);
  const owner = AutomaticWriteOwnerSchema.parse({
    version: 1,
    store: identity.storeHash,
    namespace: identity.namespace,
    turn: randomUUID(),
    role: 'human',
    actor: identity.actorReference,
    issuer: identity.issuer,
    binding: identity.binding,
    policy,
    contentHash: captured.envelope.rawContentHash,
  });
  const source = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: identity.namespace,
    content,
    role: 'human',
    reference_time: f.graph.exported_at,
    created_at: f.graph.exported_at,
    episode_kind: 'active_human',
    trust_level: 'standard',
    review_status: 'accepted',
    idempotency_key: automaticWriteOwnerIdempotencyKey(owner),
    attributes: { engram_source_envelope_v1: captured.envelope, engram_write_owner_v1: owner },
  });
  f.graph.episodes.push(source);
  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  const plan = planAutomaticClaims(
    f.graph,
    identity.namespace,
    [source.uuid],
    policy,
    outcome,
    f.graph.exported_at,
  );
  if (plan.edges.length !== 1) throw new Error('Expected actual literal preference');
  f.graph.edges.push(...plan.edges);
  f.graph.entities.push(...plan.entities);
  if (review !== 'accepted')
    for (const row of [...plan.edges, ...plan.entities])
      row.attributes.engram_extraction = reviewExtractionMetadata(
        row.attributes.engram_extraction,
        review,
        'synthetic-reviewer',
        NOW,
      );
  return { source, edge: plan.edges[0] };
}
/** Adapt only fixture input through the real source builder; all interpreters,
 * meaning/hash/receipt construction and read qualification remain real. */
function variant(
  foundation: ReturnType<typeof makeCompositionalCommittedClaimFixture>,
  content: string,
  review: 'accepted' | 'proposed' = 'accepted',
  otherActor = false,
) {
  const base = CaptureFixture.makeCompositionalCaptureFixture(
    content,
    foundation.operation.identity.storeHash,
  );
  const identity = foundation.operation.identity;
  const subject = clone(
    foundation.graph.entities.find((row) => row.uuid === identity.binding.subjectId)!,
  );
  let actor = identity.actorReference;
  if (otherActor) {
    subject.uuid = randomUUID();
    delete subject.attributes.engram_actor_bindings_v1;
    actor += `-other-${randomUUID()}`;
  }
  const graph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: foundation.graph.exported_at,
    entities: [subject],
    edges: [],
    episodes: [],
  });
  if (otherActor)
    applyAutomaticBindingCommand(
      graph,
      {
        action: 'create',
        namespace: identity.namespace,
        issuer: identity.issuer,
        actorReference: actor,
        subjectId: subject.uuid,
        reason: 'synthetic-fixture',
        authorizedBy: 'synthetic-operator',
      },
      randomUUID(),
      graph.exported_at,
    );
  const input = clone(base.input);
  input.request.namespace = identity.namespace;
  input.request.issuer = identity.issuer;
  input.request.actorReference = actor;
  const built = buildCompositionalHumanCaptureSourceV3(graph, input);
  const source = clone(built.episode);
  const actual = {
    ...base,
    input,
    built,
    source,
    graph: { ...graph, episodes: [source] },
    operation: CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...base.operation,
      identity: built.identity,
      descriptor: built.descriptor,
    }),
  };
  const fixtureInput = jest
    .spyOn(CaptureFixture, 'makeCompositionalCaptureFixture')
    .mockImplementationOnce(() => actual);
  try {
    return makeCompositionalCommittedClaimFixture(review, identity.storeHash);
  } finally {
    fixtureInput.mockRestore();
  }
}
function merge(
  f: ReturnType<typeof makeCompositionalCommittedClaimFixture>,
  other: ReturnType<typeof makeCompositionalCommittedClaimFixture>,
) {
  const entities = new Map(
    [...f.graph.entities, ...other.graph.entities].map((row) => [row.uuid, row]),
  );
  f.graph = GraphDataSchema.parse({
    ...f.graph,
    entities: [...entities.values()],
    edges: [...f.graph.edges, ...other.graph.edges],
    episodes: [...f.graph.episodes, ...other.graph.episodes],
    automatic_operations_v1: {
      version: 1,
      operations: [
        ...f.graph.automatic_operations_v1!.operations,
        ...other.graph.automatic_operations_v1!.operations,
      ],
    },
  });
}

describe('standalone compositional retrieval sessions (owned data only)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns one complete rich meaning and exact original lexical provenance without mutating its root', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      before = clone(f.graph);
    const h = setup(f),
      result = first(h);
    expect(result.status).toBe('qualified_current_data');
    if (result.status !== 'qualified_current_data') throw new Error('Expected qualified data');
    expect(result.lexicalForm).toBe(f.graph.edges[0].fact);
    expect(result.meaning).toEqual(
      (f.graph.edges[0].attributes.engram_claim_v1 as { meaning: unknown }).meaning,
    );
    expect(result.subject.id).toBe(f.operation.identity.binding.subjectId);
    expect(result.provenance).toMatchObject({
      sourceId: f.source.uuid,
      operationId: f.operation.operationId,
      creationReview: 'accepted',
      currentReview: 'accepted',
    });
    expect(result).not.toHaveProperty('proof');
    expect(result).not.toHaveProperty('source');
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.graph).toEqual(before);
    expect(h.factory.getScope(h.intake)).toBeNull();
  });

  it('reserves the root read before input inspection and caches candidate work across calls', () => {
    const h = setup();
    expect(h.budget.remaining).toBe(508);
    const firstResult = data(h.factory.readMany(h.session, [h.request.edgeId]));
    const after = getAutomaticClaimReadScopeRemaining(h.scope);
    expect(h.budget.remaining).toBe(504);
    const repeated = data(h.factory.readMany(h.session, [h.request.edgeId]));
    expect(repeated).toEqual(firstResult);
    const repeatedBudget = getAutomaticClaimReadScopeRemaining(h.scope)!;
    expect(repeatedBudget).toMatchObject({
      attemptsRemaining: after!.attemptsRemaining,
      contextBytesRemaining: after!.contextBytesRemaining,
      snapshotBytesRemaining: after!.snapshotBytesRemaining,
      sourceHydrationsRemaining: after!.sourceHydrationsRemaining,
    });
    expect(repeatedBudget.deadlineRemainingMs).toBeLessThanOrEqual(after!.deadlineRemainingMs);
    expect(firstResult.diagnostics.inspectedCandidates).toBe(1);
  });

  it.each(['historical', 'asOf'] as const)(
    'withholds unsupported rich mode %s without resource use',
    (mode) => {
      const factory = createCompositionalRetrievalSessionFactoryV3(),
        budget = { remaining: 512, deferred: 0 };
      expect(factory.begin({ namespace: 'synthetic', mode }, { budget })).toEqual({
        status: 'deferred',
        reason: 'unsupported_mode',
      });
      expect(budget.remaining).toBe(512);
    },
  );

  it('never emits value entities or a fabricated edge when a value UUID is requested', () => {
    const h = setup();
    expect(
      data(h.factory.readMany(h.session, [h.graph.edges[0].target_node_uuid])).entries,
    ).toEqual([
      { status: 'hidden', edgeId: h.graph.edges[0].target_node_uuid, reason: 'missing_edge' },
    ]);
  });

  it.each(['proposed', 'rejected'] as const)('does not expose a current %s pair', (review) => {
    const f = makeCompositionalCommittedClaimFixture('proposed');
    if (review === 'rejected') {
      const edge = f.graph.edges[0],
        value = f.graph.entities.find((row) => row.uuid === edge.target_node_uuid)!;
      for (const row of [edge, value])
        row.attributes.engram_extraction = reviewExtractionMetadata(
          row.attributes.engram_extraction,
          review,
          'synthetic-reviewer',
          NOW,
        );
    }
    const h = setup(f);
    expect(first(h)).toMatchObject({ status: 'hidden', reason: 'not_current_qualified' });
  });

  it('keeps proposed-at-commit distinct from legitimate paired manual acceptance now', () => {
    const f = makeCompositionalCommittedClaimFixture('proposed'),
      edge = f.graph.edges[0];
    const value = f.graph.entities.find((row) => row.uuid === edge.target_node_uuid)!;
    for (const row of [edge, value])
      row.attributes.engram_extraction = reviewExtractionMetadata(
        row.attributes.engram_extraction,
        'accepted',
        'synthetic-reviewer',
        NOW,
      );
    const h = setup(f);
    expect(first(h)).toMatchObject({
      status: 'qualified_current_data',
      provenance: {
        creationReview: 'proposed',
        currentReview: 'accepted',
        reviewedBy: 'synthetic-reviewer',
      },
    });
  });

  it('hides mismatched paired review, missing/noncommitted creators and revoked binding', () => {
    for (const mutation of ['pair', 'missing', 'noncommitted', 'revoked'] as const) {
      const f = makeCompositionalCommittedClaimFixture();
      if (mutation === 'pair')
        f.graph.edges[0].attributes.engram_extraction = reviewExtractionMetadata(
          f.graph.edges[0].attributes.engram_extraction,
          'accepted',
          'different-reviewer',
          NOW,
        );
      if (mutation === 'missing') f.graph.automatic_operations_v1!.operations = [];
      if (mutation === 'noncommitted')
        f.graph.automatic_operations_v1!.operations = [f.capturedOperation];
      if (mutation === 'revoked')
        applyAutomaticBindingCommand(
          f.graph,
          {
            action: 'revoke',
            namespace: f.request.namespace,
            bindingId: f.operation.identity.binding.bindingId,
            expectedRevision: 1,
            reason: 'synthetic-revocation',
            authorizedBy: 'synthetic-operator',
          },
          randomUUID(),
          NOW,
        );
      expect(first(setup(f))).toMatchObject({ status: 'hidden', reason: 'not_current_qualified' });
    }
  });

  it('consumes intake before inspecting an invalid wrapper and rejects copied/cross-factory tokens', () => {
    const factory = createCompositionalRetrievalSessionFactoryV3(),
      other = createCompositionalRetrievalSessionFactoryV3();
    const begun = factory.begin(
      { namespace: 'synthetic', mode: 'current' },
      { budget: { remaining: 512, deferred: 0 } },
    );
    if (begun.status !== 'intake') throw new Error('Expected intake');
    let reads = 0;
    const raw = Object.defineProperty({ backendNow: NOW }, 'graph', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('not data');
      },
    });
    expect(factory.prepare(begun.intake, raw)).toEqual({
      status: 'deferred',
      reason: 'invalid_input',
    });
    expect(reads).toBe(0);
    expect(factory.prepare(begun.intake, raw)).toEqual({
      status: 'deferred',
      reason: 'invalid_intake',
    });
    expect(other.prepare(begun.intake, raw)).toEqual({
      status: 'deferred',
      reason: 'invalid_intake',
    });
    expect(factory.prepare(clone(begun.intake), raw)).toEqual({
      status: 'deferred',
      reason: 'invalid_intake',
    });
    expect(factory.readMany({}, raw)).toEqual({ status: 'deferred', reason: 'invalid_session' });
    expect(reads).toBe(0);
  });

  it('rejects hostile request/resources/edge arrays with zero getter or proxy invocation', () => {
    const factory = createCompositionalRetrievalSessionFactoryV3();
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++;
          throw new Error('proxy');
        },
        getPrototypeOf() {
          traps++;
          throw new Error('prototype');
        },
        ownKeys() {
          traps++;
          throw new Error('keys');
        },
      },
    );
    expect(factory.begin(hostile, hostile)).toEqual({
      status: 'deferred',
      reason: 'invalid_input',
    });
    expect(factory.begin({ namespace: 'synthetic', mode: 'current' }, hostile)).toEqual({
      status: 'deferred',
      reason: 'invalid_resources',
    });
    const h = setup();
    expect(h.factory.readMany(h.session, hostile)).toEqual({
      status: 'deferred',
      reason: 'invalid_input',
    });
    expect(traps).toBe(0);
  });

  it('rejects raw then/getter graph data before Zod or interpretation can invoke it', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      factory = createCompositionalRetrievalSessionFactoryV3();
    let getters = 0;
    const graph = Object.defineProperty(clone(f.graph), 'then', {
      enumerable: true,
      get() {
        getters++;
        throw new Error('secret raw error');
      },
    });
    const begun = factory.begin(
      { namespace: f.request.namespace, mode: 'current' },
      { budget: { remaining: 512, deferred: 0 } },
    );
    if (begun.status !== 'intake') throw new Error('Expected intake');
    expect(factory.prepare(begun.intake, { graph, backendNow: NOW })).toEqual({
      status: 'deferred',
      reason: 'invalid_snapshot',
    });
    expect(getters).toBe(0);
    const request = Object.defineProperty(
      { namespace: f.request.namespace, mode: 'current' },
      'then',
      {
        enumerable: true,
        get() {
          getters++;
          throw new Error('request then');
        },
      },
    );
    expect(factory.begin(request, { budget: { remaining: 512, deferred: 0 } })).toEqual({
      status: 'deferred',
      reason: 'invalid_input',
    });
    expect(getters).toBe(0);
  });

  it('owns a detached root while a fresh session observes later permitted display changes', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      h = setup(f);
    f.graph.episodes[0].sender_name = 'Later synthetic display';
    expect(first(h)).toMatchObject({
      status: 'qualified_current_data',
      provenance: { senderName: null },
    });
    expect(first(setup(f))).toMatchObject({
      status: 'qualified_current_data',
      provenance: { senderName: 'Later synthetic display' },
    });
  });

  it('starts the shared deadline before root preparation and never resets it', () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const f = makeCompositionalCommittedClaimFixture(),
      factory = createCompositionalRetrievalSessionFactoryV3();
    const budget = { remaining: 512, deferred: 0 };
    const begun = factory.begin({ namespace: f.request.namespace, mode: 'current' }, { budget });
    if (begun.status !== 'intake') throw new Error('Expected intake');
    now = 6_000;
    let reads = 0;
    const wrapper = Object.defineProperty({ backendNow: NOW }, 'graph', {
      enumerable: true,
      get() {
        reads++;
        return f.graph;
      },
    });
    expect(factory.prepare(begun.intake, wrapper)).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(factory.begin({ namespace: f.request.namespace, mode: 'current' }, { budget })).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(reads).toBe(0);
  });

  it('does not turn nine manual unknowns into semantic blockers or an eight-sample universe', () => {
    const f = makeCompositionalCommittedClaimFixture();
    addManual(f, 9);
    const h = setup(f),
      result = data(h.factory.readMany(h.session, [h.request.edgeId]));
    expect(result.entries[0].status).toBe('qualified_current_data');
    expect(result.diagnostics.inspectedCandidates).toBe(10);
    expect(result.diagnostics.samples).toHaveLength(1);
    expect(h.budget.remaining).toBe(512 - 4 - 10 * 4);
  });

  it('retains rich context with the two independently accepted compatible old controls', () => {
    const f = makeCompositionalCommittedClaimFixture();
    addLiteral(f, 'I prefer short explanations with examples.');
    addLiteral(f, 'I do not like long explanations.');
    const h = setup(f);
    expect(first(h).status).toBe('qualified_current_data');
    expect(
      data(h.factory.readMany(h.session, [h.request.edgeId])).diagnostics.inspectedCandidates,
    ).toBe(3);
  });

  it('does not let a conclusively unprojectable old modifier run suppress rich context', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const old = addLiteral(f, 'I prefer short long explanations.');
    const before = clone(old.edge);
    const h = setup(f);
    expect(first(h).status).toBe('qualified_current_data');
    expect(data(h.factory.readMany(h.session, [old.edge.uuid])).entries[0]).toMatchObject({
      status: 'hidden',
      reason: 'unsupported_family',
    });
    expect(old.edge).toEqual(before);
  });

  it.each(['accepted', 'proposed', 'rejected'] as const)(
    'only independently accepted semantic old overlap can suppress rich context (%s)',
    (review) => {
      const f = makeCompositionalCommittedClaimFixture();
      addLiteral(f, 'I prefer French.', review);
      const h = setup(f);
      expect(first(h)).toMatchObject(
        review === 'accepted'
          ? { status: 'hidden', reason: 'unresolved_overlap' }
          : { status: 'qualified_current_data' },
      );
    },
  );

  it('symmetrically hides independently qualified accepted rich overlap without a source-order winner', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      other = variant(f, 'I prefer French.');
    merge(f, other);
    const h = setup(f),
      result = data(h.factory.readMany(h.session, [f.request.edgeId, other.request.edgeId]));
    expect(result.entries.map((entry) => entry.status)).toEqual(['hidden', 'hidden']);
    for (const entry of result.entries)
      expect(entry).toMatchObject({ reason: 'unresolved_overlap' });
  });

  it('keeps fully disjoint accepted rich facts together', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      other = variant(f, 'I prefer polite style.');
    merge(f, other);
    const h = setup(f);
    expect(
      data(h.factory.readMany(h.session, [f.request.edgeId, other.request.edgeId])).entries.map(
        (entry) => entry.status,
      ),
    ).toEqual(['qualified_current_data', 'qualified_current_data']);
  });

  it.each([
    'I prefer French and dislike French.',
    'I prefer Canadian French and like concise explanations.',
  ])('defers a whole accepted multi-root bundle without emitting any subset: %s', (content) => {
    const foundation = makeCompositionalCommittedClaimFixture(),
      f = variant(foundation, content);
    const before = clone(f.graph),
      h = setup(f),
      result = first(h);
    expect(result).toMatchObject({ status: 'deferred', reason: 'internal_consistency_unproved' });
    expect(result).not.toHaveProperty('lexicalForm');
    expect(result).not.toHaveProperty('meaning');
    expect(f.graph).toEqual(before);
  });

  it.each([
    'I prefer French and dislike French.',
    'I prefer Canadian French and like concise explanations.',
  ])(
    'does not let an internally unproved accepted bundle suppress a one-root fact: %s',
    (content) => {
      const foundation = makeCompositionalCommittedClaimFixture();
      const one = variant(foundation, 'I like French.'),
        multi = variant(foundation, content);
      merge(one, multi);
      const h = setup(one);
      const result = data(
        h.factory.readMany(h.session, [one.request.edgeId, multi.request.edgeId]),
      );
      expect(result.entries[0].status).toBe('qualified_current_data');
      expect(result.entries[1]).toMatchObject({
        status: 'deferred',
        reason: 'internal_consistency_unproved',
      });
    },
  );

  it.each(['proposed', 'rejected', 'uncommitted'] as const)(
    'does not let a %s V3 alternative suppress an accepted rich fact',
    (state) => {
      const f = makeCompositionalCommittedClaimFixture(),
        other = variant(f, 'I prefer French.', 'proposed');
      if (state === 'rejected') {
        const edge = other.graph.edges[0],
          value = other.graph.entities.find((row) => row.uuid === edge.target_node_uuid)!;
        for (const row of [edge, value])
          row.attributes.engram_extraction = reviewExtractionMetadata(
            row.attributes.engram_extraction,
            'rejected',
            'synthetic-reviewer',
            NOW,
          );
      }
      if (state === 'uncommitted')
        other.graph.automatic_operations_v1!.operations = [other.capturedOperation];
      merge(f, other);
      const h = setup(f);
      expect(first(h).status).toBe('qualified_current_data');
    },
  );

  it('keeps different actors with identical display names independent on one shared root/budget', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      other = variant(f, 'I prefer French.', 'accepted', true);
    merge(f, other);
    const h = setup(f),
      result = data(h.factory.readMany(h.session, [f.request.edgeId, other.request.edgeId]));
    expect(result.entries.map((entry) => entry.status)).toEqual([
      'qualified_current_data',
      'qualified_current_data',
    ]);
    const qualified = result.entries.filter((entry) => entry.status === 'qualified_current_data');
    expect(new Set(qualified.map((entry) => entry.subject.name)).size).toBe(1);
    expect(new Set(qualified.map((entry) => entry.subject.id)).size).toBe(2);
    expect(h.budget.remaining).toBe(500);
  });

  it('rejects a source-ambiguous ledger before publishing any rich subject context', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      other = variant(f, 'I prefer French.');
    const ambiguous = clone(other.operation);
    ambiguous.operationId = randomUUID();
    ambiguous.terminalReceipt.operationId = ambiguous.operationId;
    merge(f, other);
    f.graph.automatic_operations_v1!.operations.push(ambiguous);
    const factory = createCompositionalRetrievalSessionFactoryV3();
    const begun = factory.begin(
      { namespace: f.request.namespace, mode: 'current' },
      { budget: { remaining: 512, deferred: 0 } },
    );
    if (begun.status !== 'intake') throw new Error('Expected intake');
    expect(factory.prepare(begun.intake, { graph: f.graph, backendNow: NOW })).toEqual({
      status: 'deferred',
      reason: 'invalid_snapshot',
    });
  });

  it('isolates a resource-incomplete subject while retaining another completely inspected actor', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      other = variant(f, 'I prefer French.', 'accepted', true);
    addManual(other, 129);
    merge(f, other);
    const h = setup(f),
      result = data(h.factory.readMany(h.session, [f.request.edgeId, other.request.edgeId]));
    expect(result.entries[0].status).toBe('qualified_current_data');
    expect(result.entries[1]).toMatchObject({ status: 'deferred', reason: 'capacity' });
    expect(result.diagnostics.inspectedCandidates).toBe(1);
    expect(h.budget.remaining).toBe(504);
  });

  it('shares the global candidate/work cap across independently bound subjects', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      other = variant(f, 'I prefer French.', 'accepted', true);
    addManual(f, 100);
    addManual(other, 27);
    merge(f, other);
    const h = setup(f),
      result = data(h.factory.readMany(h.session, [f.request.edgeId, other.request.edgeId]));
    expect(result.entries.map((entry) => entry.status).sort()).toEqual([
      'deferred',
      'qualified_current_data',
    ]);
    expect(result.diagnostics.inspectedCandidates).toBeLessThanOrEqual(127);
    expect(h.budget.remaining).toBeGreaterThanOrEqual(0);
  });

  it('retains observed source attribution without inferring the verified subject from its display label', () => {
    const f = makeCompositionalCommittedClaimFixture();
    f.graph.episodes[0].sender_name = 'Synthetic observed display';
    const h = setup(f),
      result = first(h);
    expect(result).toMatchObject({
      status: 'qualified_current_data',
      subject: { id: f.operation.identity.binding.subjectId },
      provenance: { senderName: 'Synthetic observed display', senderId: null, sourceRole: 'human' },
    });
  });

  it.each([127, 128])(
    'defers a whole rich subject when %i manual candidates exceed work capacity',
    (count) => {
      const f = makeCompositionalCommittedClaimFixture();
      addManual(f, count);
      const h = setup(f),
        result = first(h);
      expect(result.status).toBe('deferred');
      const remaining = h.budget.remaining;
      expect(first(h)).toEqual(result);
      expect(h.budget.remaining).toBe(remaining);
      expect(h.budget.deferred).toBe(1);
    },
  );

  it('charges an oversized failed context and never returns a partially qualified subject', () => {
    const f = makeCompositionalCommittedClaimFixture();
    f.graph.episodes[0].attributes.syntheticOversize = 'x'.repeat(513 * 1024);
    const h = setup(f),
      before = getAutomaticClaimReadScopeRemaining(h.scope)!.contextBytesRemaining;
    expect(first(h).status).toBe('deferred');
    expect(getAutomaticClaimReadScopeRemaining(h.scope)!.contextBytesRemaining).toBeLessThan(
      before,
    );
    expect(h.budget.deferred).toBe(1);
  });

  it('defers a whole entry at its UTF-8 cap without truncating a valid observed subject name', () => {
    const f = makeCompositionalCommittedClaimFixture();
    f.graph.entities.find((row) => row.uuid === f.operation.identity.binding.subjectId)!.name =
      '界'.repeat(17_000);
    const h = setup(f),
      result = first(h);
    expect(result).toMatchObject({ status: 'deferred', reason: 'capacity' });
    expect(result).not.toHaveProperty('lexicalForm');
    expect(result).not.toHaveProperty('subject');
    expect(getAutomaticClaimReadScopeRemaining(h.scope)!.contextBytesRemaining).toBeLessThan(
      8 * 1024 * 1024,
    );
  });

  it('fails the complete call at 512KiB instead of returning an output prefix', () => {
    jest.spyOn(performance, 'now').mockReturnValue(0);
    const f = makeCompositionalCommittedClaimFixture();
    f.graph.entities.find((row) => row.uuid === f.operation.identity.binding.subjectId)!.name =
      'n'.repeat(23_000);
    const ids = [f.request.edgeId];
    for (let index = 0; index < 23; index++) {
      const other = variant(f, 'I prefer French.', 'accepted', true);
      merge(f, other);
      ids.push(other.request.edgeId);
    }
    const h = setup(f),
      result = h.factory.readMany(h.session, ids);
    expect(result).toEqual({ status: 'deferred', reason: 'capacity' });
    expect(h.budget.deferred).toBe(24);
    expect(h.budget.remaining).toBe(512 - 4 - 24 * 4);
  });

  it('bounds total requested IDs across calls even when no such records exist', () => {
    const h = setup();
    expect(
      h.factory.readMany(
        h.session,
        Array.from({ length: 128 }, () => randomUUID()),
      ).status,
    ).toBe('data');
    expect(h.factory.readMany(h.session, [randomUUID()])).toEqual({
      status: 'deferred',
      reason: 'capacity',
    });
  });

  it('precharges inspected rows and latches a one-shot parser cancellation', () => {
    const f = makeCompositionalCommittedClaimFixture(),
      factory = createCompositionalRetrievalSessionFactoryV3();
    const abort = Object.freeze({ kind: 'synthetic-read-cancellation' });
    let cancel = false,
      fired = false;
    const budget = { remaining: 512, deferred: 0 };
    const begun = factory.begin(
      { namespace: f.request.namespace, mode: 'current' },
      {
        budget,
        check: () => {
          if (cancel && !fired && new Error().stack?.includes('CompositionalPreferenceV2Parser')) {
            fired = true;
            throw abort;
          }
        },
      },
    );
    if (begun.status !== 'intake') throw new Error('Expected intake');
    const scope = factory.getScope(begun.intake)!;
    const prepared = factory.prepare(begun.intake, { graph: f.graph, backendNow: NOW });
    if (prepared.status !== 'prepared_data') throw new Error('Expected session');
    const before = getAutomaticClaimReadScopeRemaining(scope)!.contextBytesRemaining;
    cancel = true;
    let caught: unknown;
    try {
      factory.readMany(prepared.session, [f.request.edgeId]);
    } catch (error) {
      caught = error;
    }
    expect(fired).toBe(true);
    expect(caught).toBe(abort);
    expect(getAutomaticClaimReadScopeRemaining(scope)!.contextBytesRemaining).toBeLessThan(before);
    caught = undefined;
    try {
      factory.readMany(prepared.session, [f.request.edgeId]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(abort);
    expect(budget.deferred).toBe(1);
  });

  it('checks the original deadline after the final full-result freeze', () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const h = setup(),
      original = Object.freeze;
    let fired = false;
    jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = original(value);
      if (value && typeof value === 'object' && 'status' in value && value.status === 'data') {
        now = 6_000;
        fired = true;
      }
      return result;
    });
    expect(h.factory.readMany(h.session, [h.request.edgeId])).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(fired).toBe(true);
    expect(h.budget.deferred).toBe(1);
  });
});
