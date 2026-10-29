import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import * as Batch from '../../../src/extraction/CompositionalOverlapBatchV3';
import * as CaptureEvidence from '../../../src/extraction/CompositionalAutomaticCaptureV3Evidence';
import * as BoundedJson from '../../../src/storage/BoundedAutomaticCaptureJson';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import { planCompositionalMaterializationV3 } from '../../../src/extraction/CompositionalMaterializationV3';
import { CompositionalMaterializationResultV3Schema } from '../../../src/schemas/CompositionalMaterializationV3.schema';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { compileAutomaticPolicy, captureEnvelope } from '../../../src/extraction/AutomaticEvidence';
import { planAutomaticClaims } from '../../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  compositionalCaptureOperationIdentityHashV3,
  compositionalCaptureSourceHashV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  GraphDataSchema,
  EntityNodeSchema,
  EntityEdgeSchema,
  EpisodicNodeSchema,
  type GraphData,
} from '../../../src/schemas';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { reviewExtractionMetadata } from '../../../src/schemas/ExtractionMetadata.schema';
import {
  automaticWriteOwnerIdempotencyKey,
  applyAutomaticBindingCommand,
} from '../../../src/storage/AutomaticIdentity';
import type { CompositionalAutomaticHumanSourceBuildV3 } from '../../../src/schemas/CompositionalAutomaticCaptureSourceBuildV3.schema';
import { getAutomaticClaimReadScope } from '../../../src/storage/AutomaticClaimReadScope';

const CAPTURED_AT = '2026-10-25T12:00:00.000Z';
const RENEWED_AT = '2026-10-25T12:00:01.000Z';
const NOW = '2026-10-25T12:00:02.000Z';
const EXPIRES_AT = '2026-10-25T12:01:01.000Z';
const RICH =
  'I like responses in plain Australian English, with one worked example ahead of any technical terms.';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type LeaseOptions = {
  content?: string;
  profileId?: 'conservative' | 'explicit' | 'reviewFirst';
  intentSetting?: boolean;
};
type LeasedFixture = ReturnType<typeof makeCompositionalCaptureFixture> & {
  graph: GraphData;
  source: ReturnType<typeof makeCompositionalCaptureFixture>['source'];
  operation: ReturnType<typeof CompositionalAutomaticCaptureOperationV3Schema.parse>;
  built: ReturnType<typeof buildCompositionalHumanCaptureSourceV3>;
  input: CompositionalAutomaticHumanSourceBuildV3;
};

function asLeasedOperation(
  captured: ReturnType<typeof makeCompositionalCaptureFixture>['operation'],
  built: ReturnType<typeof buildCompositionalHumanCaptureSourceV3>,
) {
  return CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...captured,
    identity: built.identity,
    descriptor: built.descriptor,
    lastObservedAt: RENEWED_AT,
    state: 'leased',
    generation: 1,
    lease: {
      token: randomUUID(),
      acquiredAt: CAPTURED_AT,
      renewedAt: RENEWED_AT,
      expiresAt: EXPIRES_AT,
      claimKind: 'initial',
    },
  });
}

function makeLeasedFixture(options: LeaseOptions = {}): LeasedFixture {
  const content = options.content ?? RICH;
  const base = makeCompositionalCaptureFixture(content);
  const subjectId = base.built.identity.binding.subjectId;
  const subject = base.graph.entities.find((row) => row.uuid === subjectId);
  if (!subject) throw new Error('Missing fixture subject');
  const sourceGraph: GraphData = {
    version: '2.0',
    exported_at: base.graph.exported_at,
    entities: [subject],
    edges: [],
    episodes: [],
  };
  const request: CompositionalAutomaticHumanSourceBuildV3['request'] = {
    ...base.input.request,
    settings: {
      ...base.input.request.settings,
      profileId: options.profileId ?? 'conservative',
      intentSetting: options.intentSetting ?? false,
    },
    source: { ...base.input.request.source, content },
  };
  const input: CompositionalAutomaticHumanSourceBuildV3 = {
    ...base.input,
    capturedAt: CAPTURED_AT,
    previousEpisodeId: null,
    request,
  };
  const built = buildCompositionalHumanCaptureSourceV3(sourceGraph, input);
  const source = structuredClone(built.episode);
  const operation = asLeasedOperation(base.operation, built);
  const graph = GraphDataSchema.parse({
    ...sourceGraph,
    episodes: [source],
    automatic_operations_v1: { version: 1, operations: [operation] },
  });
  return { ...base, graph, source, operation, built, input };
}

function appendLeasedSourceToCommitted(
  committed: ReturnType<typeof makeCompositionalCommittedClaimFixture>,
  options: LeaseOptions = {},
): LeasedFixture {
  const content = options.content ?? committed.source.content;
  const identity = committed.operation.identity;
  const base = makeCompositionalCaptureFixture(content, identity.storeHash);
  const subject = committed.graph.entities.find((row) => row.uuid === identity.binding.subjectId);
  if (!subject) throw new Error('Missing committed subject');
  const sourceGraph: GraphData = {
    version: '2.0',
    exported_at: committed.graph.exported_at,
    entities: [subject],
    edges: [],
    episodes: [],
  };
  const request: CompositionalAutomaticHumanSourceBuildV3['request'] = {
    ...base.input.request,
    namespace: identity.namespace,
    issuer: identity.issuer,
    actorReference: identity.actorReference,
    settings: {
      ...base.input.request.settings,
      profileId: options.profileId ?? 'conservative',
      intentSetting: options.intentSetting ?? false,
    },
    source: { ...base.input.request.source, content },
  };
  const input: CompositionalAutomaticHumanSourceBuildV3 = {
    ...base.input,
    storeHash: identity.storeHash,
    capturedAt: committed.graph.exported_at,
    previousEpisodeId: null,
    request,
  };
  const built = buildCompositionalHumanCaptureSourceV3(sourceGraph, input);
  const source = structuredClone(built.episode);
  const operation = asLeasedOperation(base.operation, built);
  const graph = GraphDataSchema.parse({
    ...committed.graph,
    episodes: [...committed.graph.episodes, source],
    automatic_operations_v1: {
      version: 1,
      operations: [...(committed.graph.automatic_operations_v1?.operations ?? []), operation],
    },
  });
  return { ...base, graph, source, operation, built, input };
}

function run(
  fixture: LeasedFixture,
  budget = { remaining: 512, deferred: 0 },
  now = NOW,
  check?: () => void,
) {
  return planCompositionalMaterializationV3(
    fixture.graph,
    { namespace: fixture.operation.identity.namespace, operationId: fixture.operation.operationId },
    { budget, now, ...(check ? { check } : {}) },
  );
}

function getPlan(result: ReturnType<typeof planCompositionalMaterializationV3>) {
  if (result.status !== 'prepared_data')
    throw new Error(`Expected prepared data: ${result.reason}`);
  return result.plan;
}

function addLegacyLiteral(
  f: LeasedFixture,
  content: string,
  review: 'accepted' | 'proposed' | 'rejected' = 'accepted',
) {
  const identity = f.operation.identity;
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
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
  const oldSource = EpisodicNodeSchema.parse({
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
  f.graph.episodes.push(oldSource);
  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  const oldPlan = planAutomaticClaims(
    f.graph,
    identity.namespace,
    [oldSource.uuid],
    policy,
    outcome,
    f.graph.exported_at,
  );
  if (oldPlan.edges.length !== 1) throw new Error('Expected one literal V1 edge');
  f.graph.entities.push(...oldPlan.entities);
  f.graph.edges.push(...oldPlan.edges);
  const edge = oldPlan.edges[0];
  const value = oldPlan.entities.find((row) => row.uuid === edge.target_node_uuid);
  if (!value) throw new Error('Missing literal V1 value');
  if (review !== 'accepted') {
    edge.attributes.engram_extraction = reviewExtractionMetadata(
      edge.attributes.engram_extraction,
      review,
      'synthetic-reviewer',
      '2026-10-25T12:00:01.500Z',
    );
    value.attributes.engram_extraction = reviewExtractionMetadata(
      value.attributes.engram_extraction,
      review,
      'synthetic-reviewer',
      '2026-10-25T12:00:01.500Z',
    );
  }
  return { edge, value };
}

function manualCandidate(f: LeasedFixture): void {
  const identity = f.operation.identity;
  const value = EntityNodeSchema.parse({
    uuid: randomUUID(),
    group_id: identity.namespace,
    name: 'manual value',
    entity_type: 'concept',
    created_at: f.graph.exported_at,
    updated_at: f.graph.exported_at,
  });
  f.graph.entities.push(value);
  f.graph.edges.push(
    EntityEdgeSchema.parse({
      uuid: randomUUID(),
      group_id: identity.namespace,
      source_node_uuid: identity.binding.subjectId,
      target_node_uuid: value.uuid,
      name: 'PREFERS',
      fact: 'manual preference',
      created_at: f.graph.exported_at,
      updated_at: f.graph.exported_at,
    }),
  );
}

function mutateExistingReview(
  graph: GraphData,
  review: 'accepted' | 'proposed' | 'rejected',
): void {
  const edge = graph.edges.find((candidate) => candidate.name === 'PREFERS');
  if (!edge) throw new Error('Missing old compositional edge');
  const value = graph.entities.find((candidate) => candidate.uuid === edge.target_node_uuid);
  if (!value) throw new Error('Missing old compositional value');
  if (
    review === 'accepted' &&
    (edge.attributes.engram_extraction as { review_status?: string }).review_status === 'accepted'
  )
    return;
  for (const row of [edge, value])
    row.attributes.engram_extraction = reviewExtractionMetadata(
      row.attributes.engram_extraction,
      review,
      'synthetic-reviewer',
      '2026-10-25T12:00:01.500Z',
    );
}

describe('pure whole-bundle V3 materializer (detached data only)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { profileId: 'conservative' as const, content: RICH, intentSetting: false },
    { profileId: 'explicit' as const, content: RICH, intentSetting: false },
    { profileId: 'explicit' as const, content: 'Remember this: I like JSON.', intentSetting: true },
  ])(
    'returns the exact once-interpreted result hash and reasons for $profileId/$content',
    (options) => {
      const fixture = makeLeasedFixture(options);
      const interpret = jest.spyOn(
        CaptureEvidence,
        'interpretCompositionalHumanSourceV3EvidenceWithExecutionReport',
      );
      const result = run(fixture);
      expect(interpret).toHaveBeenCalledTimes(1);
      const report = interpret.mock.results[0].value as ReturnType<
        typeof CaptureEvidence.interpretCompositionalHumanSourceV3EvidenceWithExecutionReport
      >;
      expect(result.status).toBe('prepared_data');
      if (result.status !== 'prepared_data') throw new Error('Expected prepared data');
      expect(result.interpretation).toEqual({
        interpreterResultHash: report.evidence.interpreterResultHash,
        reasons: report.evidence.result.reasons,
      });
      expect(result.interpretation.reasons).not.toBe(report.evidence.result.reasons);
      expect(Object.isFrozen(result.interpretation)).toBe(true);
      expect(Object.isFrozen(result.interpretation.reasons)).toBe(true);
      expect(CompositionalMaterializationResultV3Schema.safeParse(result).success).toBe(true);
      const withoutInterpretation: Partial<typeof result> = { ...result };
      delete withoutInterpretation.interpretation;
      expect(
        CompositionalMaterializationResultV3Schema.safeParse(withoutInterpretation).success,
      ).toBe(false);
      const reasons = ['quoted_content', 'unsupported_grammar'] as const;
      expect(
        CompositionalMaterializationResultV3Schema.parse({
          ...result,
          interpretation: { ...result.interpretation, reasons },
        }),
      ).toMatchObject({ interpretation: { ...result.interpretation, reasons } });
      expect(
        CompositionalMaterializationResultV3Schema.safeParse({
          ...result,
          interpretation: { ...result.interpretation, reasons: Array(17).fill('quoted_content') },
        }).success,
      ).toBe(false);
    },
  );

  it('builds one exact rich accepted pair and pins source guard and timestamps to actual lease data', () => {
    const f = makeLeasedFixture();
    const before = copy(f.graph);
    const interpret = jest.spyOn(
      CaptureEvidence,
      'interpretCompositionalHumanSourceV3EvidenceWithExecutionReport',
    );
    const plan = getPlan(run(f));

    expect(interpret).toHaveBeenCalledTimes(1);
    expect(plan).toMatchObject({
      version: 3,
      kind: 'prepared_compositional_materialization',
      planTimestamp: RENEWED_AT,
      sourceGuard: {
        operationId: f.operation.operationId,
        sourceId: f.source.uuid,
        capturedIdentityHash: compositionalCaptureOperationIdentityHashV3(f.operation.identity),
        capturedSourceHash: f.operation.identity.sourceHash,
        observedSourceHash: compositionalCaptureSourceHashV3(f.source),
        descriptorHash: f.operation.identity.descriptorHash,
        settingsHash: f.operation.identity.settingsHash,
        policyFingerprint: f.operation.identity.policyFingerprint,
      },
      items: [{ bundleIndex: 0, decision: 'create_accepted', codes: ['eligible_create'] }],
    });
    expect(plan.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    const wrapper = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
      f.source.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
    );
    expect(plan.sourceGuard.envelopeHash).toBe(hashAutomaticCaptureV2(wrapper));
    expect(plan.sourceGuard.rawContentHash).toBe(wrapper.sourceEnvelope.rawContentHash);
    expect(plan.sourceGuard.mappedContentHash).toBe(wrapper.sourceEnvelope.contentHash);
    expect(plan.createEdges).toHaveLength(1);
    expect(plan.createEntities).toHaveLength(1);
    const edge = plan.createEdges[0];
    const value = plan.createEntities[0];
    expect(edge.fact).toBe(RICH.replace(/\.$/u, ''));
    expect(value.name).toBe(edge.fact);
    expect(edge.episodes).toEqual([f.source.uuid]);
    expect(edge.created_at).toBe(RENEWED_AT);
    expect(value.updated_at).toBe(RENEWED_AT);
    expect((edge.attributes.engram_extraction as { confidence: unknown }).confidence).toBeNull();
    expect(f.graph).toEqual(before);
  });

  it('produces the seven closed prepared decision alternatives without mutating existing rows', () => {
    const fresh = getPlan(run(makeLeasedFixture()));
    expect(fresh.items[0].decision).toBe('create_accepted');

    const proposed = getPlan(run(makeLeasedFixture({ profileId: 'reviewFirst' })));
    expect(proposed.items[0]).toMatchObject({
      decision: 'create_proposed',
      codes: ['profile_review_required'],
    });

    for (const review of ['accepted', 'proposed', 'rejected'] as const) {
      const committed = makeCompositionalCommittedClaimFixture(
        review === 'proposed' ? 'proposed' : 'accepted',
      );
      if (review === 'rejected') mutateExistingReview(committed.graph, 'rejected');
      const fixture = appendLeasedSourceToCommitted(committed);
      const before = copy(fixture.graph);
      const plan = getPlan(run(fixture));
      expect(plan.items[0].decision).toBe(`reference_${review}`);
      expect(plan.createEdges).toHaveLength(0);
      expect(plan.createEntities).toHaveLength(0);
      expect(fixture.graph).toEqual(before);
    }

    const explicitMissing = getPlan(
      run(makeLeasedFixture({ profileId: 'explicit', intentSetting: false })),
    );
    expect(explicitMissing.items[0]).toMatchObject({
      decision: 'not_selected',
      codes: ['explicit_intent_required'],
    });

    const duplicate = getPlan(run(makeLeasedFixture({ content: 'I like JSON. I like JSON.' })));
    expect(duplicate.items.map((item) => item.decision)).toEqual([
      'create_accepted',
      'reference_prepared',
    ]);
  });

  it('keeps an exact same-family reference ahead of a separate unknown blocker and retains its diagnostic', () => {
    const committed = makeCompositionalCommittedClaimFixture();
    const fixture = appendLeasedSourceToCommitted(committed);
    manualCandidate(fixture);
    const plan = getPlan(run(fixture));
    expect(plan.items[0]).toMatchObject({
      decision: 'reference_accepted',
      codes: ['existing_accepted', 'unknown_overlap_domain'],
    });
    expect(plan.createEdges).toHaveLength(0);
  });

  it('allows the accepted short/examples and negative-long V1 controls only through inspected compatibility', () => {
    const f = makeLeasedFixture({
      content:
        'I like responses in plain Kenyan Swahili, with one practical example before any technical terms.',
    });
    addLegacyLiteral(f, 'I prefer short explanations with examples.');
    addLegacyLiteral(f, "I don't like long explanations.");
    const plan = getPlan(run(f));
    expect(plan.items[0].decision).toBe('create_accepted');
    expect(plan.createEdges).toHaveLength(1);
  });

  it.each(['proposed', 'rejected'] as const)(
    'does not waive relevant nonaccepted literal V1 candidates (%s)',
    (review) => {
      const f = makeLeasedFixture({
        content:
          'I like responses in plain Kenyan Swahili, with one practical example before any technical terms.',
      });
      addLegacyLiteral(f, 'I prefer short explanations with examples.', review);
      const plan = getPlan(run(f));
      expect(plan.items[0].decision).toBe('not_selected');
      expect(plan.items[0].codes).toContain(`existing_${review}`);
      expect(plan.createEdges).toHaveLength(0);
    },
  );

  it('blocks a new create on manual outgoing preferences', () => {
    const f = makeLeasedFixture();
    manualCandidate(f);
    const plan = getPlan(run(f));
    expect(plan.items[0]).toMatchObject({ decision: 'not_selected' });
    expect(plan.items[0].codes).toContain('unknown_overlap_domain');
    expect(plan.createEntities).toHaveLength(0);
  });

  it('lets Explicit without protected intent complete 129 candidates without starting batch hydration', () => {
    const f = makeLeasedFixture({ profileId: 'explicit', intentSetting: false });
    const value = EntityNodeSchema.parse({
      uuid: randomUUID(),
      group_id: f.operation.identity.namespace,
      name: 'candidate target',
      created_at: f.graph.exported_at,
      updated_at: f.graph.exported_at,
    });
    f.graph.entities.push(value);
    for (let index = 0; index < 129; index++)
      f.graph.edges.push(
        EntityEdgeSchema.parse({
          uuid: randomUUID(),
          group_id: f.operation.identity.namespace,
          source_node_uuid: f.operation.identity.binding.subjectId,
          target_node_uuid: value.uuid,
          name: 'PREFERS',
          fact: `manual ${index}`,
          created_at: f.graph.exported_at,
          updated_at: f.graph.exported_at,
        }),
      );
    const budget = { remaining: 512, deferred: 0 };
    const batchFactory = jest.spyOn(Batch, 'createCompositionalOverlapBatchInspectorV3');
    const plan = getPlan(run(f, budget));
    expect(plan.items.every((item) => item.decision === 'not_selected')).toBe(true);
    expect(plan.createEdges).toHaveLength(0);
    expect(batchFactory).not.toHaveBeenCalled();
    expect(budget.remaining).toBe(512);
  });

  it('defers deterministic IDs occupied by any existing graph-record category', () => {
    const kinds = ['entity', 'edge', 'episode', 'operation'] as const;
    for (const kind of kinds) {
      const f = makeLeasedFixture();
      const first = getPlan(run(f));
      const id = first.items[0];
      if (!('claimId' in id)) throw new Error('Expected deterministic claim ID');
      if (kind === 'entity')
        f.graph.entities.push(
          EntityNodeSchema.parse({
            uuid: id.claimId,
            group_id: f.operation.identity.namespace,
            name: 'occupied entity ID',
            created_at: f.graph.exported_at,
            updated_at: f.graph.exported_at,
          }),
        );
      else if (kind === 'edge')
        f.graph.edges.push(
          EntityEdgeSchema.parse({
            uuid: id.claimId,
            group_id: f.operation.identity.namespace,
            source_node_uuid: f.operation.identity.binding.subjectId,
            target_node_uuid: f.operation.identity.binding.subjectId,
            name: 'PREFERS',
            fact: 'occupied edge ID',
            created_at: f.graph.exported_at,
            updated_at: f.graph.exported_at,
          }),
        );
      else if (kind === 'episode')
        f.graph.episodes.push(
          EpisodicNodeSchema.parse({
            uuid: id.claimId,
            group_id: f.operation.identity.namespace,
            content: 'occupied episode ID',
            role: 'system',
            reference_time: f.graph.exported_at,
            created_at: f.graph.exported_at,
          }),
        );
      else {
        const collisionOperation = CompositionalAutomaticCaptureOperationV3Schema.parse({
          ...f.operation,
          operationId: id.claimId,
        });
        f.operation = collisionOperation;
        f.graph.automatic_operations_v1 = {
          version: 1,
          operations: [collisionOperation],
        };
      }
      expect(run(f)).toEqual({ status: 'deferred', reason: 'identity_collision' });
    }
  });

  it('returns source_verdict_required for complete none/unknown outcomes, not empty prepared plans', () => {
    for (const content of ['The weather is mild today.', 'Maybe I like JSON.']) {
      const result = run(makeLeasedFixture({ content }));
      expect(result).toEqual({ status: 'deferred', reason: 'source_verdict_required' });
    }
  });

  it('distinguishes nonleased, clock regression, expiry, changed authority, and invalid source', () => {
    const captured = makeLeasedFixture();
    const capturedValue = copy(captured.operation) as Record<string, unknown>;
    delete capturedValue.lease;
    const nonleased = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...capturedValue,
      state: 'captured',
      generation: 0,
      lastObservedAt: CAPTURED_AT,
    });
    captured.operation = nonleased;
    captured.graph.automatic_operations_v1 = { version: 1, operations: [nonleased] };
    expect(run(captured)).toEqual({ status: 'deferred', reason: 'operation_not_leased' });

    const clock = makeLeasedFixture();
    expect(run(clock, undefined, '2026-10-25T12:00:00.999Z')).toEqual({
      status: 'deferred',
      reason: 'clock_regression',
    });
    const expiry = makeLeasedFixture();
    expect(run(expiry, undefined, EXPIRES_AT)).toEqual({
      status: 'deferred',
      reason: 'lease_expired',
    });

    const trust = makeLeasedFixture();
    trust.source.trust_level = 'trusted';
    trust.graph.episodes[0].trust_level = 'trusted';
    expect(run(trust)).toEqual({ status: 'deferred', reason: 'authority_changed' });

    const invalid = makeLeasedFixture();
    invalid.source.content += ' changed';
    invalid.graph.episodes[0].content = invalid.source.content;
    expect(run(invalid)).toEqual({ status: 'deferred', reason: 'invalid_source' });
  });

  it('requires exact protected Explicit intent for creation, and permits its anchored positive case', () => {
    const without = makeLeasedFixture({ profileId: 'explicit', intentSetting: false });
    const notSelected = getPlan(run(without));
    expect(notSelected.items[0].decision).toBe('not_selected');

    const withIntent = makeLeasedFixture({
      profileId: 'explicit',
      intentSetting: true,
      content: 'Remember this: I prefer concise explanations.',
    });
    const accepted = getPlan(run(withIntent));
    expect(accepted.items[0].decision).toBe('create_accepted');
  });

  it('rejects hostile selector/graph access without invoking getters or proxy traps', () => {
    const f = makeLeasedFixture();
    let selectorReads = 0;
    const selector = Object.defineProperty({ operationId: f.operation.operationId }, 'namespace', {
      enumerable: true,
      get() {
        selectorReads += 1;
        return f.operation.identity.namespace;
      },
    });
    expect(
      planCompositionalMaterializationV3(f.graph, selector, {
        budget: { remaining: 512, deferred: 0 },
        now: NOW,
      }),
    ).toEqual({ status: 'deferred', reason: 'invalid_input' });
    expect(selectorReads).toBe(0);

    let graphTraps = 0;
    const proxy = new Proxy(f.graph, {
      get() {
        graphTraps += 1;
        throw new Error('do not invoke proxy');
      },
      ownKeys() {
        graphTraps += 1;
        throw new Error('do not enumerate proxy');
      },
      getPrototypeOf() {
        graphTraps += 1;
        throw new Error('do not inspect proxy prototype');
      },
    });
    expect(
      planCompositionalMaterializationV3(
        proxy,
        { namespace: f.operation.identity.namespace, operationId: f.operation.operationId },
        { budget: { remaining: 512, deferred: 0 }, now: NOW },
      ),
    ).toEqual({ status: 'deferred', reason: 'invalid_snapshot' });
    expect(graphTraps).toBe(0);
  });

  it.each([
    'I prefer French. I do not like French.',
    'I do not like French. I prefer French.',
    'I like short explanations. I like long explanations.',
    'I like English. I like French.',
  ])(
    'does not select a source-order winner among fresh overlapping complete bundles: %s',
    (content) => {
      const f = makeLeasedFixture({ content });
      const plan = getPlan(run(f));
      expect(plan.items).toHaveLength(2);
      expect(
        plan.items.every(
          (item) => item.decision === 'not_selected' && item.codes.includes('possible_overlap'),
        ),
      ).toBe(true);
      expect(plan.createEntities).toHaveLength(0);
      expect(plan.createEdges).toHaveLength(0);
    },
  );
  it('allows independently proven-disjoint new language and length bundles together', () => {
    const plan = getPlan(
      run(makeLeasedFixture({ content: 'I like English. I like short explanations.' })),
    );
    expect(plan.items.map((item) => item.decision)).toEqual(['create_accepted', 'create_accepted']);
    expect(plan.createEdges).toHaveLength(2);
  });
  it('fits five distinct supported overlap domains under the actual private planning bound', () => {
    const plan = getPlan(
      run(
        makeLeasedFixture({
          content:
            'I like English. I like JSON. I prefer fewer emojis. I prefer polite style. I like short explanations.',
        }),
      ),
    );
    expect(plan.items.map((item) => item.decision)).toEqual(Array(5).fill('create_accepted'));
    const metadataBytes = [...plan.createEntities, ...plan.createEdges].reduce(
      (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.attributes), 'utf8'),
      0,
    );
    expect(metadataBytes).toBeLessThanOrEqual(32768);
    expect(Buffer.byteLength(JSON.stringify(plan), 'utf8')).toBeLessThan(512 * 1024);
  });
  it.each([
    'I prefer French and dislike French.',
    'I prefer short explanations and like long explanations.',
    'I prefer Canadian French and like concise explanations.',
  ])('withholds a complete multi-predicate coupled bundle without splitting: %s', (content) => {
    const plan = getPlan(run(makeLeasedFixture({ content })));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      decision: 'not_selected',
      codes: ['unknown_overlap_domain'],
    });
    expect(plan.items[0].predicateDependencies).toHaveLength(2);
    expect(plan.createEntities).toEqual([]);
    expect(plan.createEdges).toEqual([]);
  });
  it('preserves an actual qualified reference while declining another overlapping new source bundle', () => {
    const committed = makeCompositionalCommittedClaimFixture();
    const fixture = appendLeasedSourceToCommitted(committed, {
      content: `${RICH} I like French.`,
    });
    const plan = getPlan(run(fixture));
    expect(plan.items.map((item) => item.decision)).toEqual(['reference_accepted', 'not_selected']);
    expect(plan.items.every((item) => item.codes.includes('possible_overlap'))).toBe(true);
    expect(plan.createEdges).toEqual([]);
    expect(plan.createEntities).toEqual([]);
  });
  it('retains independent source coverage while declining only a blocked whole bundle', () => {
    const f = makeLeasedFixture({ content: 'I like English. I like short explanations.' });
    addLegacyLiteral(f, 'I prefer French.');
    const plan = getPlan(run(f));
    expect(plan.items.map((item) => item.decision)).toEqual(['not_selected', 'create_accepted']);
    expect(plan.createEdges).toHaveLength(1);
    expect(plan.createEdges[0].fact).toBe('I like short explanations');
  });
  it('keeps repeated ReviewFirst occurrences uniformly proposed with one new pair', () => {
    const f = makeLeasedFixture({
      profileId: 'reviewFirst',
      content: 'I like JSON. I like JSON. I like JSON.',
    });
    const plan = getPlan(run(f));
    expect(plan.items.map((item) => item.decision)).toEqual([
      'create_proposed',
      'reference_prepared',
      'reference_prepared',
    ]);
    for (const item of plan.items.slice(1))
      expect(item).toMatchObject({ primaryBundleIndex: 0, intendedReview: 'proposed' });
    expect(plan.createEdges).toHaveLength(1);
    expect(new Set(plan.items.map((item) => ('claimId' in item ? item.claimId : null))).size).toBe(
      1,
    );
    expect(new Set(plan.items.map((item) => item.bundleHash)).size).toBe(3);
  });
  it('declines multiple overlapping rich bundles before creating any oversized partial plan', () => {
    const content = [
      RICH,
      'I like responses in plain Canadian French, with one worked example ahead of any technical terms.',
      'I like responses in plain Kenyan Swahili, with one worked example ahead of any technical terms.',
    ].join(' ');
    const f = makeLeasedFixture({ content });
    const before = copy(f.graph);
    const plan = getPlan(run(f));
    expect(plan.items).toHaveLength(3);
    expect(plan.items.every((item) => item.decision === 'not_selected')).toBe(true);
    expect(plan.createEntities).toEqual([]);
    expect(plan.createEdges).toEqual([]);
    expect(f.graph).toEqual(before);
  });
  it.each(['binding_revoked', 'subject_rejected'] as const)(
    'requires actual current authority: %s',
    (change) => {
      const f = makeLeasedFixture();
      if (change === 'binding_revoked')
        applyAutomaticBindingCommand(
          f.graph,
          {
            action: 'revoke',
            namespace: f.operation.identity.namespace,
            bindingId: f.operation.identity.binding.bindingId,
            expectedRevision: 1,
            authorizedBy: 'synthetic-operator',
            reason: 'synthetic revocation',
          },
          randomUUID(),
          '2026-10-25T12:00:01.500Z',
        );
      else
        f.graph.entities[0].attributes.engram_extraction = reviewExtractionMetadata(
          f.graph.entities[0].attributes.engram_extraction,
          'rejected',
          'synthetic-operator',
          '2026-10-25T12:00:01.500Z',
        );
      expect(run(f)).toEqual({ status: 'deferred', reason: 'authority_changed' });
    },
  );
  it('keeps captured identity/source hashes fixed while binding allowed display changes to the observed guard', () => {
    const f = makeLeasedFixture();
    f.graph.episodes[0].sender_name = 'Renamed synthetic display';
    const plan = getPlan(run(f));
    expect(plan.sourceGuard.capturedSourceHash).toBe(f.operation.identity.sourceHash);
    expect(plan.sourceGuard.observedSourceHash).not.toBe(f.operation.identity.sourceHash);
    expect(plan.sourceGuard.capturedIdentityHash).toBe(
      compositionalCaptureOperationIdentityHashV3(f.operation.identity),
    );
  });
  it('requires app-supplied intent without a magic Remember prefix and gates existing references when intent is absent', () => {
    const f = makeLeasedFixture({
      profileId: 'explicit',
      intentSetting: true,
      content: 'I like JSON.',
    });
    expect(getPlan(run(f)).items[0].decision).toBe('create_accepted');
    const old = makeCompositionalCommittedClaimFixture();
    const next = appendLeasedSourceToCommitted(old, {
      profileId: 'explicit',
      intentSetting: false,
    });
    const budget = { remaining: 512, deferred: 0 };
    const plan = getPlan(run(next, budget));
    expect(plan.items[0].decision).toBe('not_selected');
    expect(plan.items[0]).not.toHaveProperty('claimId');
    expect(budget.remaining).toBe(512);
  });
  it('latches one-shot cancellation caught inside source parser recovery', () => {
    const f = makeLeasedFixture();
    let thrown = false;
    const cancel = new Error('one-shot parser cancellation');
    expect(() =>
      run(f, undefined, NOW, () => {
        if (!thrown && new Error().stack?.includes('CompositionalPreferenceV2Parser')) {
          thrown = true;
          throw cancel;
        }
      }),
    ).toThrow(cancel);
    expect(thrown).toBe(true);
  });
  it('rechecks the shared deadline after freezing the final prepared plan', () => {
    let clock = 10;
    const time = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const f = makeLeasedFixture();
    const original = Object.freeze;
    let hit = false;
    const frozen = jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = original(value);
      if (
        value !== null &&
        typeof value === 'object' &&
        (value as { kind?: string }).kind === 'prepared_compositional_materialization'
      ) {
        hit = true;
        clock = 5010;
      }
      return result;
    });
    expect(run(f)).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
    expect(hit).toBe(true);
    frozen.mockRestore();
    time.mockRestore();
  });
  it('propagates exact external cancellation and reports exhausted candidate resources', () => {
    const f = makeLeasedFixture();
    const cancellation = new Error('cancel from caller');
    expect(() =>
      run(f, { remaining: 512, deferred: 0 }, NOW, () => {
        throw cancellation;
      }),
    ).toThrow(cancellation);

    const constrained = makeLeasedFixture();
    manualCandidate(constrained);
    expect(run(constrained, { remaining: 0, deferred: 0 })).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
  });

  it('starts the same budget deadline before cloning and does not reset it during planning', () => {
    let clock = 10;
    const now = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const f = makeLeasedFixture();
    const budget = { remaining: 512, deferred: 0 };
    getAutomaticClaimReadScope(budget);
    const graphClone = jest.spyOn(BoundedJson, 'cloneBoundedAutomaticCaptureJson');
    clock = 5010;
    expect(run(f, budget)).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
    expect(graphClone).not.toHaveBeenCalled();
    now.mockRestore();
  });
});
