import { createHash, randomUUID } from 'crypto';
import { EntityNodeSchema, EpisodicNodeSchema, type GraphData } from '../../../src/schemas';
import { captureEnvelope, compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import {
  ExtractionBudgetError,
  ExtractionDiagnostics,
} from '../../../src/extraction/ExtractionDiagnostics';
import { applyAutomaticBindingCommand } from '../../../src/storage/AutomaticIdentity';
import {
  AUTOMATIC_ENVELOPE,
  AUTOMATIC_OWNER,
  planAutomaticClaims,
  validateAutomaticPlan,
  validateStoredAutomaticClaim,
} from '../../../src/extraction/AutomaticClaims';

const now = '2026-10-24T12:00:00.000Z';
function fixture() {
  const subject = EntityNodeSchema.parse({
    uuid: randomUUID(),
    group_id: 'scope',
    name: 'Subject',
    entity_type: 'person',
    summary: '',
    created_at: now,
    updated_at: now,
    attributes: {
      engram_extraction: {
        version: 2,
        source: 'manual',
        confidence: null,
        review_status: 'accepted',
        threshold_decision: 'manually_reviewed',
        extracted_at: now,
        episode_uuids: [],
        reviewed_at: now,
        reviewed_by: 'operator',
      },
    },
  });
  const graph: GraphData = {
    version: '2.0',
    exported_at: now,
    entities: [subject],
    edges: [],
    episodes: [],
  };
  const binding = applyAutomaticBindingCommand(
    graph,
    {
      action: 'create',
      namespace: 'scope',
      issuer: 'app',
      actorReference: 'actor',
      subjectId: subject.uuid,
      authorizedBy: 'operator',
      reason: 'verified sender',
    },
    randomUUID(),
    now,
  );
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const content = 'I prefer concise explanations.';
  const captured = captureEnvelope(
    content,
    content,
    { namespace: 'scope', issuer: 'app', actorReference: 'actor' },
    {
      bindingId: binding.bindingId,
      revision: binding.revision,
      subjectId: binding.subjectId,
      fingerprint: binding.fingerprint,
    },
    false,
    policy,
  );
  if (!captured.ok) throw new Error(captured.reason);
  const source = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: 'scope',
    content,
    role: 'human',
    reference_time: now,
    created_at: now,
    sender_id: 'actor',
    idempotency_key: `automatic:${createHash('sha256').update('turn-fixture').digest('hex')}:human`,
    episode_kind: 'active_human',
    trust_level: 'standard',
    review_status: 'accepted',
    attributes: {
      [AUTOMATIC_ENVELOPE]: captured.envelope,
      [AUTOMATIC_OWNER]: {
        version: 1,
        store: 'a'.repeat(64),
        namespace: 'scope',
        turn: 'turn-fixture',
        role: 'human',
        actor: 'actor',
        issuer: 'app',
        binding: captured.envelope.bindingRef,
        policy,
        contentHash: captured.envelope.rawContentHash,
      },
    },
  });
  graph.episodes.push(source);
  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  const plan = planAutomaticClaims(graph, 'scope', [source.uuid], policy, outcome, now);
  return { graph, binding, policy, source, outcome, plan };
}

describe('automatic claims adversarial authority checks', () => {
  it.each(['deadline', 'cancelled'] as const)('honors %s before any plan is returned', (reason) => {
    const { graph, source, policy, outcome } = fixture();
    const before = structuredClone(graph);
    expect(() =>
      planAutomaticClaims(graph, 'scope', [source.uuid], policy, outcome, now, () => {
        throw new ExtractionBudgetError(reason);
      }),
    ).toThrow(ExtractionBudgetError);
    expect(graph).toEqual(before);
  });
  it('propagates cancellation during graph inspection without mutating captured evidence', () => {
    const { graph, source, policy, outcome } = fixture();
    const before = structuredClone(graph);
    let inspected = 0;
    expect(() =>
      planAutomaticClaims(graph, 'scope', [source.uuid], policy, outcome, now, () => {
        if (++inspected === 3) throw new ExtractionBudgetError('cancelled');
      }),
    ).toThrow(ExtractionBudgetError);
    expect(inspected).toBe(3);
    expect(graph).toEqual(before);
  });
  it.each(['namespace', 'actor', 'issuer'])('rejects mismatched source owner %s', (field) => {
    const { graph, plan, source } = fixture();
    (source.attributes[AUTOMATIC_OWNER] as Record<string, unknown>)[field] = 'foreign';
    expect(() => validateAutomaticPlan(graph, plan)).toThrow();
  });
  it.each(['proposed', 'rejected'])('does not auto-accept through a %s value node', (review) => {
    const { graph, plan, source, policy, outcome } = fixture();
    graph.entities.push(...plan.entities);
    (plan.entities[0].attributes.engram_extraction as { review_status: string }).review_status =
      review;
    const next = planAutomaticClaims(graph, 'scope', [source.uuid], policy, outcome, now);
    expect(
      (next.edges[0].attributes.engram_extraction as { review_status: string }).review_status,
    ).toBe('proposed');
  });
  it('reconciles independently staged repeats against committed logical identity', () => {
    const { graph, plan, source, policy, outcome } = fixture();
    const concurrent = planAutomaticClaims(graph, 'scope', [source.uuid], policy, outcome, now);
    expect(concurrent.edges[0].uuid).toBe(plan.edges[0].uuid);
    graph.entities.push(...plan.entities);
    graph.edges.push(...plan.edges);
    expect(() => validateAutomaticPlan(graph, concurrent)).toThrow();
    const retry = planAutomaticClaims(graph, 'scope', [source.uuid], policy, outcome, now);
    expect(retry.entities).toHaveLength(0);
    expect(retry.edges).toHaveLength(0);
    expect(retry.outcome.automatic?.items[0]).toMatchObject({
      state: 'unchanged',
      mutation: 'none',
    });
  });
  it('withdraws stored claim authority immediately after binding revocation', () => {
    const { graph, plan, binding } = fixture();
    graph.entities.push(...plan.entities);
    graph.edges.push(...plan.edges);
    expect(validateStoredAutomaticClaim(graph, graph.edges[0])).toBe(true);
    applyAutomaticBindingCommand(
      graph,
      {
        action: 'revoke',
        namespace: 'scope',
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
        authorizedBy: 'operator',
        reason: 'revocation',
      },
      binding.bindingId,
      now,
    );
    expect(validateStoredAutomaticClaim(graph, graph.edges[0])).toBe(false);
  });
  it('rebuilds legitimate literal claims and rejects changed fact or subject', () => {
    const { graph, plan } = fixture();
    expect(validateAutomaticPlan(graph, plan)).toBe(true);
    for (const field of ['fact', 'source_node_uuid'] as const) {
      const altered = structuredClone(plan);
      altered.edges[0][field] = field === 'fact' ? 'Unsupported assertion' : randomUUID();
      expect(() => validateAutomaticPlan(graph, altered)).toThrow();
    }
  });
  it('rejects source trust changes and binding revocation after staging', () => {
    const { graph, plan, binding } = fixture();
    graph.episodes[0].trust_level = 'untrusted';
    expect(() => validateAutomaticPlan(graph, plan)).toThrow();
    graph.episodes[0].trust_level = 'standard';
    applyAutomaticBindingCommand(
      graph,
      {
        action: 'revoke',
        namespace: 'scope',
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
        authorizedBy: 'operator',
        reason: 'revoked sender',
      },
      binding.bindingId,
      now,
    );
    expect(() => validateAutomaticPlan(graph, plan)).toThrow();
  });
  it('does not reuse a deterministic-ID edge with forged endpoint or evidence', () => {
    const { graph, plan, source, policy, outcome } = fixture();
    graph.entities.push(...plan.entities);
    graph.edges.push(...plan.edges);
    expect(validateStoredAutomaticClaim(graph, graph.edges[0])).toBe(true);
    graph.edges[0].target_node_uuid = randomUUID();
    expect(validateStoredAutomaticClaim(graph, graph.edges[0])).toBe(false);
    expect(() =>
      planAutomaticClaims(graph, 'scope', [source.uuid], policy, outcome, now),
    ).toThrow();
  });
  it('preserves rejected claims instead of auto-accepting a replay', () => {
    const { graph, plan, source, policy, outcome } = fixture();
    graph.entities.push(...plan.entities);
    graph.edges.push(...plan.edges);
    (graph.edges[0].attributes.engram_extraction as { review_status: string }).review_status =
      'rejected';
    const replay = planAutomaticClaims(graph, 'scope', [source.uuid], policy, outcome, now);
    expect(replay.edges).toEqual([]);
    expect(replay.outcome.automatic?.items[0]).toMatchObject({
      state: 'rejected',
      mutation: 'none',
      persisted: true,
    });
  });
  it('cannot validate accepted writes alongside a failed extraction outcome', () => {
    const { graph, plan } = fixture();
    plan.outcome.status = 'failed';
    expect(() => validateAutomaticPlan(graph, plan)).toThrow();
  });
});
