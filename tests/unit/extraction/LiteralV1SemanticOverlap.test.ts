import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import {
  EntityNodeSchema,
  EntityEdgeSchema,
  EpisodicNodeSchema,
  type GraphData,
} from '../../../src/schemas';
import {
  captureEnvelope,
  compileAutomaticPolicy,
  parseAutomaticPreferences,
} from '../../../src/extraction/AutomaticEvidence';
import * as CompositionalParser from '../../../src/extraction/CompositionalPreferenceV2Parser';
import * as AutomaticClaimValidation from '../../../src/extraction/AutomaticClaims';
import * as AutomaticCommitProof from '../../../src/extraction/AutomaticClaimCommitProof';
import { planAutomaticClaims } from '../../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import {
  applyAutomaticBindingCommand,
  automaticWriteOwnerIdempotencyKey,
} from '../../../src/storage/AutomaticIdentity';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { inspectLiteralV1SemanticOverlap } from '../../../src/extraction/LiteralV1SemanticOverlap';
import { LiteralV1SemanticOverlapResultSchema } from '../../../src/schemas/LiteralV1SemanticOverlap.schema';
import {
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  chargeAutomaticClaimContextBytes,
} from '../../../src/storage/AutomaticClaimReadScope';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';

const NOW = '2026-10-24T12:00:00.000Z';
const NAMESPACE = 'literal-overlap-synthetic';
const POLICY = compileAutomaticPolicy({ profileId: 'conservative' });

function base() {
  const subject = EntityNodeSchema.parse({
    uuid: randomUUID(),
    group_id: NAMESPACE,
    name: 'Synthetic reviewed person',
    entity_type: 'person',
    created_at: NOW,
    updated_at: NOW,
    attributes: {
      engram_extraction: {
        version: 2,
        source: 'manual',
        confidence: null,
        review_status: 'accepted',
        threshold_decision: 'manually_reviewed',
        extracted_at: NOW,
        episode_uuids: [],
        reviewed_at: NOW,
        reviewed_by: 'operator',
      },
    },
  });
  const graph: GraphData = {
    version: '2.0',
    exported_at: NOW,
    entities: [subject],
    edges: [],
    episodes: [],
  };
  const binding = applyAutomaticBindingCommand(
    graph,
    {
      action: 'create',
      namespace: NAMESPACE,
      issuer: 'synthetic-app',
      actorReference: 'actor',
      subjectId: subject.uuid,
      authorizedBy: 'operator',
      reason: 'Synthetic identity verification',
    },
    randomUUID(),
    NOW,
  );
  return { graph, subject, binding };
}
type Fixture = ReturnType<typeof base>;

function addOld(f: Fixture, body: string, prefix = '') {
  const raw = prefix + body;
  const capture = captureEnvelope(
    body,
    raw,
    {
      namespace: NAMESPACE,
      issuer: 'synthetic-app',
      actorReference: 'actor',
      ...(prefix
        ? {
            applicationOwnedWrapper: true as const,
            humanRegion: { start: prefix.length, end: raw.length },
          }
        : {}),
    },
    {
      bindingId: f.binding.bindingId,
      revision: f.binding.revision,
      subjectId: f.binding.subjectId,
      fingerprint: f.binding.fingerprint,
    },
    false,
    POLICY,
  );
  if (!capture.ok) throw new Error(capture.reason);
  const owner = AutomaticWriteOwnerSchema.parse({
    version: 1,
    store: 'a'.repeat(64),
    namespace: NAMESPACE,
    turn: randomUUID(),
    role: 'human',
    actor: 'actor',
    issuer: 'synthetic-app',
    binding: capture.envelope.bindingRef,
    policy: POLICY,
    contentHash: capture.envelope.rawContentHash,
  });
  const source = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: NAMESPACE,
    content: raw,
    role: 'human',
    reference_time: NOW,
    created_at: NOW,
    episode_kind: 'active_human',
    trust_level: 'standard',
    review_status: 'accepted',
    idempotency_key: automaticWriteOwnerIdempotencyKey(owner),
    attributes: { engram_source_envelope_v1: capture.envelope, engram_write_owner_v1: owner },
  });
  f.graph.episodes.push(source);
  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  const plan = planAutomaticClaims(f.graph, NAMESPACE, [source.uuid], POLICY, outcome, NOW);
  expect(plan.edges).toHaveLength(1);
  f.graph.entities.push(...plan.entities);
  f.graph.edges.push(...plan.edges);
  return { source, edge: plan.edges[0], envelope: capture.envelope };
}

function meaning(body: string, namespace: string, subjectId: string) {
  // Actual complete original text, not a predicate invented from a stored value.
  const mapped = body,
    raw = body;
  const f = base();
  const captured = captureEnvelope(
    mapped,
    raw,
    { namespace, issuer: 'synthetic-app', actorReference: 'actor' },
    { bindingId: f.binding.bindingId, revision: 1, subjectId, fingerprint: f.binding.fingerprint },
    false,
    POLICY,
  );
  if (!captured.ok) throw new Error(captured.reason);
  const preference = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: raw,
    mappedContent: mapped,
    envelope: captured.envelope,
  });
  expect(preference.coverage).toBe('complete');
  const projected = projectCompositionalPreferenceV2Meaning({ preference, namespace, subjectId });
  if (!projected.ok) throw new Error(projected.reason);
  return projected.meaning;
}

function request(f: Fixture, text: string) {
  return {
    descriptor: { ...COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR },
    namespace: NAMESPACE,
    subjectId: f.subject.uuid,
    newMeaning: meaning(text, NAMESPACE, f.subject.uuid),
  };
}
function inspect(f: Fixture, text: string, check?: () => void) {
  const before = JSON.stringify(f.graph);
  const sources = { remaining: 512, deferred: 0 },
    scans = { remaining: 128 };
  const result = inspectLiteralV1SemanticOverlap(f.graph, request(f, text), sources, scans, check);
  expect(JSON.stringify(f.graph)).toBe(before);
  expect(LiteralV1SemanticOverlapResultSchema.safeParse(result).success).toBe(true);
  return { result, sources, scans };
}

function review(edge: GraphData['edges'][number], state: 'accepted' | 'proposed' | 'rejected') {
  (edge.attributes.engram_extraction as { review_status: string }).review_status = state;
}

describe('literal-v1 read-only semantic overlap evidence', () => {
  test.each([
    'I prefer concise explanations.',
    'I like JSON.',
    'I do not like bullet points.',
    "I don't like detailed explanations.",
    'I prefer short explanations with examples.',
    'Remember this: I like Markdown.',
    'I like JSON!',
    'I like JSON',
  ])('projects actual whole-source safe v1 form without a synthetic assertion: %s', (text) => {
    const f = base();
    const old = addOld(f, text, 'Application 🐘\n');
    const { result, sources, scans } = inspect(f, text);
    expect(result.status).toBe('complete');
    expect(result.inspections[0]).toMatchObject({
      oldEdgeId: old.edge.uuid,
      projection: 'exact',
      equivalent: true,
      currentReview: 'accepted',
      currentAuthority: 'current',
      oldCurrentEligibility: 'eligible',
      blocksNewAcceptance: false,
    });
    expect(sources.remaining).toBe(508);
    expect(scans.remaining).toBe(127);
    expect(sources.deferred).toBe(0);
    expect(result).not.toHaveProperty('acceptedReuse');
    expect(result).not.toHaveProperty('should_process');
  });

  test.each(['proposed', 'rejected'] as const)(
    'inspects %s exact meaning without allowing resurrection',
    (state) => {
      const f = base();
      const old = addOld(f, 'I like JSON.');
      review(old.edge, state);
      const { result } = inspect(f, 'I like JSON.');
      expect(result.inspections[0]).toMatchObject({
        projection: 'exact',
        equivalent: true,
        currentReview: state,
        oldCurrentEligibility: 'ineligible',
        blocksNewAcceptance: true,
      });
      expect(result.inspections[0].reasons).toContain(`${state}_overlap`);
    },
  );

  test.each([
    ['I prefer concise explanations.', 'I like concise explanations.'],
    ['I like concise explanations.', 'I do not like concise explanations.'],
    ['I prefer short explanations.', 'I prefer short explanations with examples.'],
    ['I prefer concise explanations.', 'I prefer short explanations.'],
  ])('keeps complete meaning inequality separate from nonconflict: %s / %s', (oldText, newText) => {
    const f = base();
    addOld(f, oldText);
    const { result } = inspect(f, newText);
    expect(result.inspections[0]).toMatchObject({
      projection: 'exact',
      equivalent: false,
      domain: 'possible_overlap',
      blocksNewAcceptance: true,
    });
    expect(result.inspections[0].reasons).toContain('not_equivalent');
  });

  test.each(['I like JSON?', 'I like JSON..', 'I like JSON.!', 'I like JSON .', 'I like JSON !'])(
    'does not align unapproved terminal geometry: %s',
    (body) => {
      const f = base();
      const old = addOld(f, 'I like JSON.');
      const captured = captureEnvelope(
        body,
        body,
        { namespace: NAMESPACE, issuer: 'synthetic-app', actorReference: 'actor' },
        old.envelope.bindingRef,
        false,
        POLICY,
      );
      if (!captured.ok) throw new Error(captured.reason);
      old.source.content = body;
      old.source.attributes.engram_source_envelope_v1 = captured.envelope;
      old.source.attributes.engram_write_owner_v1 = {
        ...(old.source.attributes.engram_write_owner_v1 as object),
        contentHash: captured.envelope.rawContentHash,
      };
      const actual = parseAutomaticPreferences(captured.envelope, body).claims[0];
      if (actual) {
        old.edge.attributes.engram_claim_v1 = {
          ...(old.edge.attributes.engram_claim_v1 as object),
          claim: actual,
        };
        old.edge.fact = actual.clause;
      }
      const item = inspect(f, 'I like JSON.').result.inspections[0];
      expect(item.projection).not.toBe('exact');
      expect(item.blocksNewAcceptance).toBe(true);
    },
  );

  test('terminal alignment cannot drop a semantic token from a returned parser evidence root', () => {
    const f = base();
    addOld(f, 'I like JSON.');
    const req = request(f, 'I like JSON.');
    const original = CompositionalParser.interpretCompositionalPreferencesV2;
    const spy = jest
      .spyOn(CompositionalParser, 'interpretCompositionalPreferencesV2')
      .mockImplementation((input) => {
        const result = structuredClone(original(input));
        const evidence = result.bundles[0]?.evidence;
        if (evidence) {
          evidence.spans[0].content.end--;
          evidence.spans[0].raw.end--;
          evidence.lexicalForm = evidence.lexicalForm.slice(0, -1);
        }
        return result;
      });
    try {
      expect(
        inspectLiteralV1SemanticOverlap(
          f.graph,
          req,
          { remaining: 512, deferred: 0 },
          { remaining: 128 },
        ).inspections[0].projection,
      ).toBe('unresolved');
    } finally {
      spy.mockRestore();
    }
  });

  test('does not project intentionally withheld negative emoji usage through a literal fallback', () => {
    const f = base();
    addOld(f, 'I do not like no emojis.');
    expect(inspect(f, 'I like JSON.').result.inspections[0]).toMatchObject({
      projection: 'unresolved',
      domain: 'unknown_domain',
      equivalent: null,
      blocksNewAcceptance: true,
    });
  });

  test('nine genuinely disjoint records remain complete with deterministic bounded detail samples', () => {
    const f = base();
    for (const format of [
      'JSON',
      'Markdown',
      'CSV',
      'YAML',
      'XML',
      'HTML',
      'LaTeX',
      'plain text',
      'rich text',
    ])
      addOld(f, `I like ${format}.`);
    const req = request(f, 'I prefer French.');
    const run = () =>
      inspectLiteralV1SemanticOverlap(
        f.graph,
        req,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
      );
    const result = run();
    expect(result.status).toBe('complete');
    expect(result.inspectedCandidateCount).toBe(9);
    expect(result.provenDisjointCount).toBe(9);
    expect(result.relevantCandidateCount).toBe(0);
    expect(result.inspections).toHaveLength(8);
    f.graph.edges.reverse();
    expect(run()).toEqual(result);
  });

  test('a rejected value remains a current-eligibility blocker even if the old edge is accepted', () => {
    const f = base();
    const old = addOld(f, 'I like JSON.');
    const value = f.graph.entities.find((entity) => entity.uuid === old.edge.target_node_uuid)!;
    (value.attributes.engram_extraction as { review_status: string }).review_status = 'rejected';
    expect(inspect(f, 'I like JSON.').result.inspections[0]).toMatchObject({
      projection: 'exact',
      equivalent: true,
      oldCurrentEligibility: 'ineligible',
      blocksNewAcceptance: true,
    });
  });

  test('one-shot cancellation swallowed by the old validator is propagated at the inspector boundary', () => {
    const f = base();
    addOld(f, 'I like JSON.');
    const req = request(f, 'I like JSON.');
    let inside = false,
      thrown = false;
    const abort = new Error('one-shot original callback abort');
    const original = AutomaticClaimValidation.validateStoredAutomaticClaim;
    const spy = jest
      .spyOn(AutomaticClaimValidation, 'validateStoredAutomaticClaim')
      .mockImplementation((...args) => {
        inside = true;
        try {
          return original(...args);
        } finally {
          inside = false;
        }
      });
    try {
      expect(() =>
        inspectLiteralV1SemanticOverlap(
          f.graph,
          req,
          { remaining: 512, deferred: 0 },
          { remaining: 128 },
          () => {
            if (inside && !thrown) {
              thrown = true;
              throw abort;
            }
          },
        ),
      ).toThrow(abort);
      expect(thrown).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test.each([
    'Alice said: I like JSON.',
    'If asked, I like JSON.',
    'I like JSON. That was fictional.',
    'Do I like JSON?',
    'Imagine that I like JSON.',
    '"I like JSON."',
  ])(
    'cannot recover an embedded literal through a coherently rehashed source frame: %s',
    (body) => {
      const f = base();
      const old = addOld(f, 'I like JSON.');
      const captured = captureEnvelope(
        body,
        body,
        { namespace: NAMESPACE, issuer: 'synthetic-app', actorReference: 'actor' },
        old.envelope.bindingRef,
        false,
        POLICY,
      );
      if (!captured.ok) throw new Error(captured.reason);
      old.source.content = body;
      old.source.attributes.engram_source_envelope_v1 = captured.envelope;
      old.source.attributes.engram_write_owner_v1 = {
        ...(old.source.attributes.engram_write_owner_v1 as object),
        contentHash: captured.envelope.rawContentHash,
      };
      const item = inspect(f, 'I like JSON.').result.inspections[0];
      expect(item).toMatchObject({
        projection: 'unresolved',
        domain: 'unknown_domain',
        blocksNewAcceptance: true,
      });
      expect(item).not.toHaveProperty('canonicalMeaning');
    },
  );

  test.each(['source_review', 'source_trust', 'binding'] as const)(
    'historical projection is separate from current %s authority',
    (field) => {
      const f = base();
      const old = addOld(f, 'I like JSON.');
      if (field === 'source_review') old.source.review_status = 'rejected';
      if (field === 'source_trust') old.source.trust_level = 'unverified';
      if (field === 'binding')
        applyAutomaticBindingCommand(
          f.graph,
          {
            action: 'revoke',
            namespace: NAMESPACE,
            bindingId: f.binding.bindingId,
            expectedRevision: 1,
            authorizedBy: 'operator',
            reason: 'Synthetic revocation',
          },
          randomUUID(),
          NOW,
        );
      const item = inspect(f, 'I like JSON.').result.inspections[0];
      expect(item).toMatchObject({
        projection: 'exact',
        equivalent: true,
        oldCurrentEligibility: 'ineligible',
        blocksNewAcceptance: true,
      });
      expect(item.currentAuthority).toBe(field === 'binding' ? 'binding_not_current' : 'invalid');
    },
  );

  test('unknown/manual prefs are uncertainty, not a fact-text projection or claimed semantic conflict', () => {
    const f = base();
    const old = addOld(f, 'I like JSON.');
    delete old.edge.attributes.engram_claim_v1;
    old.edge.fact = 'I like JSON.';
    const item = inspect(f, 'I prefer French.').result.inspections[0];
    expect(item).toMatchObject({
      provenance: 'manual_or_generic',
      projection: 'unresolved',
      domain: 'unknown_domain',
      equivalent: null,
      blocksNewAcceptance: true,
    });
    expect(item).not.toHaveProperty('canonicalMeaning');
    expect(item.reasons).toContain('manual_overlap_unresolved');
  });

  test('fully classified language and representation are disjoint, rejected review does not invent a conflict', () => {
    const f = base();
    const old = addOld(f, 'I like JSON.');
    review(old.edge, 'rejected');
    const { result } = inspect(f, 'I prefer French.');
    expect(result.inspections[0]).toMatchObject({
      projection: 'exact',
      domain: 'proven_disjoint',
      equivalent: false,
      blocksNewAcceptance: false,
    });
    expect(result.provenDisjointCount).toBe(1);
    expect(result.relevantCandidateCount).toBe(0);
    expect(result.inspections[0].reasons).not.toContain('rejected_overlap');
  });

  test.each([
    'missing_source',
    'claim_version',
    'key',
    'edge_id',
    'target',
    'source_text',
    'quoted',
    'framed',
  ] as const)('fails closed for %s without guessed evidence', (field) => {
    const f = base();
    const old = addOld(f, 'I like JSON.');
    if (field === 'missing_source') f.graph.episodes = [];
    if (field === 'claim_version')
      (old.edge.attributes.engram_claim_v1 as { version: number }).version = 99;
    if (field === 'key')
      (old.edge.attributes.engram_claim_v1 as { key: string }).key = '0'.repeat(64);
    if (field === 'edge_id') old.edge.uuid = randomUUID();
    if (field === 'target') old.edge.target_node_uuid = f.subject.uuid;
    if (field === 'source_text') old.source.content = 'I prefer JSON.';
    if (field === 'quoted')
      old.source.attributes.engram_source_envelope_v1 = {
        ...old.envelope,
        quoteRegions: [{ start: 0, end: 12 }],
      };
    if (field === 'framed') old.source.content = 'Alice said: I like JSON.';
    const item = inspect(f, 'I like JSON.').result.inspections[0];
    expect(item.projection).not.toBe('exact');
    expect(item.blocksNewAcceptance).toBe(true);
    expect(item).not.toHaveProperty('canonicalMeaning');
  });

  test('multiple genuine literal IDs with the same canonical format are ambiguous', () => {
    const f = base();
    addOld(f, 'I like JSON.');
    const other = addOld(f, 'I like json.');
    review(other.edge, 'accepted');
    const { result } = inspect(f, 'I like JSON.');
    expect(result.status).toBe('incomplete');
    expect(result.reasons).toContain('ambiguous_existing_ids');
    expect(result.inspections).toHaveLength(2);
    expect(
      result.inspections.every(
        (item) => item.projection === 'exact' && item.equivalent && item.blocksNewAcceptance,
      ),
    ).toBe(true);
  });

  test('native V2 source needs actual committed operation for current-old eligibility', () => {
    const native = makeHumanFixture('native-overlap');
    const req = {
      descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
      namespace: native.human.group_id,
      subjectId: native.binding.subjectId,
      newMeaning: meaning(
        'I prefer concise explanations.',
        native.human.group_id,
        native.binding.subjectId,
      ),
    };
    const read = () =>
      inspectLiteralV1SemanticOverlap(
        native.graph,
        req,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
      );
    expect(read().inspections[0]).toMatchObject({
      projection: 'exact',
      oldCurrentEligibility: 'eligible',
    });
    native.graph.automatic_operations_v1!.operations = [];
    expect(read().inspections[0]).toMatchObject({
      projection: 'exact',
      oldCurrentEligibility: 'ineligible',
      blocksNewAcceptance: true,
    });
  });

  test('uses one root index and the charged projected proof for native candidates in a large graph', () => {
    const native = makeHumanFixture('native-overlap-indexed');
    const template = native.graph.entities[0];
    for (let index = 0; index < 2000; index++)
      native.graph.entities.push({
        ...template,
        uuid: randomUUID(),
        group_id: 'unrelated',
        attributes: {},
      });
    const indexSpy = jest.spyOn(AutomaticCommitProof, 'buildAutomaticClaimReadIndices');
    const fullValidationSpy = jest.spyOn(AutomaticClaimValidation, 'validateStoredAutomaticClaim');
    const contextSpy = jest.spyOn(AutomaticClaimValidation, 'validateAutomaticClaimReadContext');
    try {
      const result = inspectLiteralV1SemanticOverlap(
        native.graph,
        {
          descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
          namespace: native.human.group_id,
          subjectId: native.binding.subjectId,
          newMeaning: meaning(
            'I prefer concise explanations.',
            native.human.group_id,
            native.binding.subjectId,
          ),
        },
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
      );
      expect(result.inspections[0].oldCurrentEligibility).toBe('eligible');
      expect(indexSpy).toHaveBeenCalledTimes(1);
      expect(fullValidationSpy).not.toHaveBeenCalled();
      expect(contextSpy).toHaveBeenCalledTimes(1);
    } finally {
      indexSpy.mockRestore();
      fullValidationSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });

  test('validates literal-v1 candidates against private indexed rows after one full registry check', () => {
    const f = base();
    addOld(f, 'I like JSON.');
    const template = f.subject;
    for (let index = 0; index < 2000; index++)
      f.graph.entities.push({
        ...template,
        uuid: randomUUID(),
        group_id: 'unrelated',
        attributes: {},
      });
    const spy = jest.spyOn(AutomaticClaimValidation, 'validateStoredAutomaticClaim');
    try {
      expect(inspect(f, 'I like JSON.').result.inspections[0].oldCurrentEligibility).toBe(
        'eligible',
      );
      expect(spy).toHaveBeenCalledTimes(1);
      const privateGraph = spy.mock.calls[0][0];
      expect(privateGraph.entities).toHaveLength(2);
      expect(privateGraph.episodes).toHaveLength(1);
      expect(privateGraph.edges).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test.each(['duplicate_actor', 'malformed_binding_elsewhere'])(
    'does not hide global binding corruption behind indexed literal-v1 rows: %s',
    (kind) => {
      const f = base();
      addOld(f, 'I like JSON.');
      const other = base().subject;
      if (kind === 'malformed_binding_elsewhere') other.uuid = randomUUID();
      f.graph.entities.push(other);
      const result = inspect(f, 'I like JSON.').result;
      expect(result.status).toBe('incomplete');
      expect(result.reasons).toContain('invalid_v1_provenance');
      expect(result.inspections).toHaveLength(0);
    },
  );

  test('missing new-source authority is never inferred even from a unique current old equivalent', () => {
    const f = base();
    addOld(f, 'I like JSON.');
    const result = inspect(f, 'I like JSON.').result;
    expect(JSON.stringify(result)).not.toContain('exact_current_unique');
    expect(() =>
      LiteralV1SemanticOverlapResultSchema.parse({ ...result, should_process: true }),
    ).toThrow();
  });

  test('shared budgets/deadline are not reset; graph preparation does not claim disk I/O bytes', () => {
    let clock = 100;
    const spy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const f = base();
      addOld(f, 'I like JSON.');
      const req = request(f, 'I like JSON.');
      const sources = { remaining: 8, deferred: 0 },
        scans = { remaining: 128 };
      const scope = getAutomaticClaimReadScope(sources);
      const first = inspectLiteralV1SemanticOverlap(f.graph, req, sources, scans);
      expect(first.status).toBe('complete');
      expect(sources.remaining).toBe(4);
      const after = getAutomaticClaimReadScopeRemaining(scope)!;
      expect(after.snapshotBytesRemaining).toBe(100 * 1024 * 1024);
      expect(after.contextBytesRemaining).toBeLessThan(8 * 1024 * 1024);
      inspectLiteralV1SemanticOverlap(f.graph, req, sources, scans);
      expect(sources.remaining).toBe(0);
      expect(inspectLiteralV1SemanticOverlap(f.graph, req, sources, scans).status).toBe(
        'incomplete',
      );
      clock = 5100;
      sources.remaining = 512;
      expect(inspectLiteralV1SemanticOverlap(f.graph, req, sources, scans).status).toBe(
        'incomplete',
      );
      expect(getAutomaticClaimReadScopeRemaining(scope)?.attemptsRemaining).toBe(126);
    } finally {
      spy.mockRestore();
    }
  });

  test('expired deadline during processing and external one-shot cancellation remain distinct', () => {
    const f = base();
    addOld(f, 'I like JSON.');
    const req = request(f, 'I like JSON.');
    let clock = 0,
      calls = 0;
    const spy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const result = inspectLiteralV1SemanticOverlap(
        f.graph,
        req,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
        () => {
          if (++calls > 12) clock = 5000;
        },
      );
      expect(result.status).toBe('incomplete');
      expect(result.reasons).toContain('inspection_capacity');
    } finally {
      spy.mockRestore();
    }
    const aborted = new Error('external cancellation sentinel');
    let count = 0;
    expect(() =>
      inspectLiteralV1SemanticOverlap(
        f.graph,
        req,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
        () => {
          if (++count === 15) throw aborted;
        },
      ),
    ).toThrow(aborted);
  });

  test('counts failed/oversized candidate context bytes and respects pre-existing aggregate exhaustion', () => {
    const f = base();
    const old = addOld(f, 'I like JSON.');
    old.source.attributes.large = 'x'.repeat(600 * 1024);
    const sources = { remaining: 512, deferred: 0 },
      scans = { remaining: 128 };
    const scope = getAutomaticClaimReadScope(sources);
    const result = inspectLiteralV1SemanticOverlap(
      f.graph,
      request(f, 'I like JSON.'),
      sources,
      scans,
    );
    expect(result.status).toBe('incomplete');
    expect(sources.remaining).toBe(508);
    expect(getAutomaticClaimReadScopeRemaining(scope)?.contextBytesRemaining).toBe(
      8 * 1024 * 1024 - 512 * 1024 - 1,
    );
    expect(
      chargeAutomaticClaimContextBytes(
        scope,
        getAutomaticClaimReadScopeRemaining(scope)!.contextBytesRemaining,
      ),
    ).toBe(true);
    expect(
      inspectLiteralV1SemanticOverlap(f.graph, request(f, 'I like JSON.'), sources, scans).status,
    ).toBe('incomplete');
  });

  test('9th relevant manual reference and129th domain candidate defer without silent selection', () => {
    const f = base();
    const old = addOld(f, 'I like JSON.');
    for (let i = 0; i < 8; i++)
      f.graph.edges.push(
        EntityEdgeSchema.parse({ ...old.edge, uuid: randomUUID(), attributes: {} }),
      );
    const ninth = inspect(f, 'I like JSON.').result;
    expect(ninth.status).toBe('incomplete');
    expect(ninth.relevantCandidateCount).toBe(9);
    expect(ninth.inspections).toHaveLength(8);
    while (f.graph.edges.length < 129)
      f.graph.edges.push(
        EntityEdgeSchema.parse({ ...old.edge, uuid: randomUUID(), attributes: {} }),
      );
    const capacity = inspect(f, 'I like JSON.').result;
    expect(capacity.status).toBe('incomplete');
    expect(capacity.inspectedCandidateCount).toBe(0);
  });

  test('closed request/proxy and graph record-count bounds fail before deeper inspection', () => {
    const f = base();
    addOld(f, 'I like JSON.');
    const req = request(f, 'I like JSON.');
    let calls = 0;
    const requestProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          calls++;
          throw new Error('private request proxy');
        },
      },
    );
    expect(() =>
      inspectLiteralV1SemanticOverlap(
        f.graph,
        requestProxy as never,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
      ),
    ).toThrow('Engram automatic overlap: invalid_request');
    expect(calls).toBe(0);
    const getter = Object.defineProperty(
      { descriptor: req.descriptor, namespace: NAMESPACE, subjectId: f.subject.uuid },
      'newMeaning',
      {
        enumerable: true,
        get() {
          calls++;
          throw new Error('private meaning');
        },
      },
    );
    expect(() =>
      inspectLiteralV1SemanticOverlap(
        f.graph,
        getter as never,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
      ),
    ).toThrow('Engram automatic overlap: invalid_request');
    expect(calls).toBe(0);
    expect(
      inspectLiteralV1SemanticOverlap(
        { ...f.graph, edges: Array(100001).fill(null) } as never,
        req,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
      ),
    ).toMatchObject({ status: 'incomplete', reasons: ['inspection_capacity'] });
  });

  test('all potential source references are capped, and same UUIDs in another namespace do not collide', () => {
    const f = base();
    const old = addOld(f, 'I like JSON.');
    f.graph.edges.push({ ...structuredClone(old.edge), group_id: 'another-namespace' });
    expect(inspect(f, 'I like JSON.').result.inspectedCandidateCount).toBe(1);
    old.edge.episodes = Array.from({ length: 9 }, () => randomUUID());
    expect(inspect(f, 'I like JSON.').result).toMatchObject({
      status: 'incomplete',
      reasons: ['inspection_capacity'],
    });
  });

  test('graph getter/proxy metadata is rejected without executing original source getters or exposing exceptions', () => {
    const f = base();
    const old = addOld(f, 'I like JSON.');
    const req = request(f, 'I like JSON.');
    let calls = 0;
    Object.defineProperty(old.source, 'content', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('private raw source');
      },
    });
    expect(
      inspectLiteralV1SemanticOverlap(
        f.graph,
        req,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
      ),
    ).toMatchObject({ status: 'incomplete', reasons: ['invalid_v1_provenance'] });
    expect(calls).toBe(0);
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          calls++;
          throw new Error('private proxy');
        },
      },
    );
    expect(
      inspectLiteralV1SemanticOverlap(
        proxy as never,
        req,
        { remaining: 512, deferred: 0 },
        { remaining: 128 },
      ).status,
    ).toBe('incomplete');
    expect(calls).toBe(0);
  });
});
