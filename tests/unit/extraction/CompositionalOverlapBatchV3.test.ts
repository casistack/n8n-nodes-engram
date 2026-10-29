import * as LiteralHook from '../../../src/extraction/LiteralV1SemanticOverlap';
import { AutomaticClaimMetadataSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { createCompositionalOverlapBatchInspectorV3 } from '../../../src/extraction/CompositionalOverlapBatchV3';
import {
  createCompositionalSnapshotIndexV3,
  getOwnedCompositionalSnapshotV3,
} from '../../../src/extraction/CompositionalSnapshotIndexV3';
import {
  createCompositionalQualifiedClaimReadPrivateProjectorV3,
  validateCompositionalQualifiedClaimReadV3,
} from '../../../src/extraction/CompositionalQualifiedClaimReadV3';
import { captureEnvelope, compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { automaticWriteOwnerIdempotencyKey } from '../../../src/storage/AutomaticIdentity';
import { EntityNodeSchema, EntityEdgeSchema, EpisodicNodeSchema } from '../../../src/schemas';
import { planAutomaticClaims } from '../../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
import type { CompositionalAutomaticClaimMeaningV2 } from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import type { GraphData } from '../../../src/schemas';
import * as Lossless from '../../../src/storage/LosslessAutomaticCaptureGraph';
import * as Identity from '../../../src/storage/AutomaticIdentity';
import * as CommitProof from '../../../src/extraction/AutomaticClaimCommitProof';
import * as Parser from '../../../src/extraction/CompositionalPreferenceV2Parser';
import {
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  chargeAutomaticClaimContextBytes,
  beginAutomaticClaimReadAttempt,
} from '../../../src/storage/AutomaticClaimReadScope';
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NOW = '2026-10-25T12:00:03.000Z';
function meaning(
  text: string,
  namespace: string,
  subjectId: string,
): CompositionalAutomaticClaimMeaningV2 {
  const captured = captureEnvelope(
    text,
    text,
    { namespace, issuer: 'synthetic', actorReference: 'human' },
    { bindingId: randomUUID(), revision: 1, subjectId, fingerprint: 'a'.repeat(64) },
    false,
    compileAutomaticPolicy({ profileId: 'conservative' }),
  );
  if (!captured.ok) throw new Error('capture');
  const preference = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: text,
    mappedContent: text,
    envelope: captured.envelope,
  });
  if (preference.coverage !== 'complete') throw new Error('synthetic source must parse');
  const projection = projectCompositionalPreferenceV2Meaning({ preference, namespace, subjectId });
  if (!projection.ok) throw new Error('meaning');
  return projection.meaning;
}
function addOld(f: ReturnType<typeof makeCompositionalCaptureFixture>, text: string) {
  const identity = f.built.identity;
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const c = captureEnvelope(
    text,
    text,
    {
      namespace: identity.namespace,
      issuer: identity.issuer,
      actorReference: identity.actorReference,
    },
    identity.binding,
    false,
    policy,
  );
  if (!c.ok) throw new Error(c.reason);
  const owner = AutomaticWriteOwnerSchema.parse({
    version: 1,
    store: 'a'.repeat(64),
    namespace: identity.namespace,
    turn: randomUUID(),
    role: 'human',
    actor: identity.actorReference,
    issuer: identity.issuer,
    binding: identity.binding,
    policy,
    contentHash: c.envelope.rawContentHash,
  });
  const source = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: identity.namespace,
    content: text,
    role: 'human',
    reference_time: f.graph.exported_at,
    created_at: f.graph.exported_at,
    episode_kind: 'active_human',
    trust_level: 'standard',
    review_status: 'accepted',
    idempotency_key: automaticWriteOwnerIdempotencyKey(owner),
    attributes: { engram_source_envelope_v1: c.envelope, engram_write_owner_v1: owner },
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
  if (plan.edges.length !== 1) throw new Error('Expected one genuine old literal claim');
  f.graph.entities.push(...plan.entities);
  f.graph.edges.push(...plan.edges);
  return plan.edges[0];
}
function domain(
  f: ReturnType<typeof makeCompositionalCaptureFixture>,
  texts = ['I like English.'],
) {
  return {
    namespace: f.source.group_id,
    subjectId: f.built.identity.binding.subjectId,
    meanings: texts.map((text) =>
      meaning(text, f.source.group_id, f.built.identity.binding.subjectId),
    ),
  };
}
function manual(graph: GraphData, namespace: string, subjectId: string) {
  const value = EntityNodeSchema.parse({
    uuid: randomUUID(),
    group_id: namespace,
    name: 'Unknown manual value',
    entity_type: 'concept',
    created_at: graph.exported_at,
    updated_at: graph.exported_at,
  });
  graph.entities.push(value);
  graph.edges.push(
    EntityEdgeSchema.parse({
      uuid: randomUUID(),
      group_id: namespace,
      source_node_uuid: subjectId,
      target_node_uuid: value.uuid,
      name: 'PREFERS',
      fact: 'Unowned manual preference',
      created_at: graph.exported_at,
      updated_at: graph.exported_at,
    }),
  );
}
afterEach(() => jest.restoreAllMocks());
describe('private compositional batch/index resource ownership (no permits)', () => {
  it('indexes one immutable snapshot and caches one actual creator projection', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const claim = f.graph.edges[0].attributes.engram_claim_v1 as {
      meaning: CompositionalAutomaticClaimMeaningV2;
    };
    const before = copy(f.graph);
    const token = createCompositionalSnapshotIndexV3(f.graph, {
      namespace: f.request.namespace,
      subjectId: claim.meaning.subjectId,
    });
    const view = getOwnedCompositionalSnapshotV3(token)!;
    expect(Object.keys(token)).toEqual([]);
    expect(Object.isFrozen(view.graph)).toBe(true);
    expect(Object.isFrozen(view.graph.edges[0].attributes)).toBe(true);
    expect(getOwnedCompositionalSnapshotV3({ ...token })).toBeNull();
    const projector = createCompositionalQualifiedClaimReadPrivateProjectorV3(token, NOW);
    const first = projector.projectCandidate(f.request.edgeId);
    expect(first.result).toEqual(validateCompositionalQualifiedClaimReadV3(f.graph, f.request));
    expect(projector.projectCandidate(f.request.edgeId)).toBe(first);
    expect(first.inspectedBytes).toBeGreaterThan(0);
    f.graph.edges[0].fact = 'caller changed';
    expect(view.edge(f.request.edgeId)?.fact).toBe(before.edges[0].fact);
  });
  it.each(['accepted', 'proposed'] as const)(
    'projects actual same-family %s creation only as reference data',
    (review) => {
      const f = makeCompositionalCommittedClaimFixture(review);
      const claim = f.graph.edges[0].attributes.engram_claim_v1 as {
        meaning: CompositionalAutomaticClaimMeaningV2;
      };
      const inspector = createCompositionalOverlapBatchInspectorV3();
      const budget = { remaining: 512, deferred: 0 };
      const prepared = inspector.prepare(
        f.graph,
        {
          namespace: f.request.namespace,
          subjectId: claim.meaning.subjectId,
          meanings: [claim.meaning],
        },
        { budget, now: NOW },
      );
      expect(prepared.status).toBe('prepared_data');
      if (prepared.status !== 'prepared_data') throw new Error(JSON.stringify(prepared));
      const data = inspector.readBundle(prepared.batch, 0);
      if (data.status !== 'complete_data') throw new Error('fixture');
      expect(data.details[0]).toMatchObject({
        family: 'compositional_v2',
        currentReview: review,
        disposition: 'same_family_reference_data',
        equivalent: true,
      });
      expect(data.details[0].referenceGuardHash).toMatch(/^[a-f0-9]{64}$/);
      expect(budget.remaining).toBe(508);
    },
  );
  it('shares one candidate attempt/quad hydration across32 meanings and does not report clone bytes as IO', () => {
    const f = makeCompositionalCaptureFixture();
    addOld(f, 'I prefer short explanations.');
    const request = domain(f, Array(32).fill('I like English.'));
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const batch = createCompositionalOverlapBatchInspectorV3();
    const result = batch.prepare(f.graph, request, { budget, now: NOW });
    expect(result.status).toBe('prepared_data');
    if (result.status !== 'prepared_data') throw new Error(JSON.stringify(result));
    expect(budget.remaining).toBe(508);
    expect(budget.deferred).toBe(0);
    expect(getAutomaticClaimReadScopeRemaining(scope)).toMatchObject({
      attemptsRemaining: 127,
      snapshotBytesRemaining: 100 * 1024 * 1024,
    });
    expect(getAutomaticClaimReadScopeRemaining(scope)!.contextBytesRemaining).toBeLessThan(
      8 * 1024 * 1024,
    );
    for (let index = 0; index < 32; index++)
      expect(batch.readBundle(result.batch, index)).toMatchObject({
        status: 'complete_data',
        inspectedCandidateCount: 1,
        provenDisjointCount: 1,
        relevantCandidateCount: 0,
      });
    expect(budget.remaining).toBe(508);
  });
  it('retains both restored-store literal controls against a whole rich compound as conditional data', () => {
    const f = makeCompositionalCaptureFixture();
    addOld(f, 'I prefer short explanations with examples.');
    addOld(f, "I don't like long explanations.");
    const request = domain(f, [
      'I like responses in plain Kenyan Swahili, with one practical example before any technical terms.',
    ]);
    const batch = createCompositionalOverlapBatchInspectorV3();
    const result = batch.prepare(f.graph, request, {
      budget: { remaining: 512, deferred: 0 },
      now: NOW,
    });
    expect(result.status).toBe('prepared_data');
    if (result.status !== 'prepared_data') throw new Error(JSON.stringify(result));
    const data = batch.readBundle(result.batch, 0);
    expect(data).toMatchObject({
      status: 'complete_data',
      inspectedCandidateCount: 2,
      relevantCandidateCount: 2,
    });
    if (data.status !== 'complete_data') throw new Error('fixture');
    expect(data.details.every((d) => d.disposition === 'conditional_compatible')).toBe(true);
    expect(data).not.toHaveProperty('should_process');
  });
  it.each(['proposed', 'rejected'] as const)(
    'keeps relevant old %s rows out of the conditional accepted-only rule',
    (review) => {
      const f = makeCompositionalCaptureFixture();
      const old = addOld(f, 'I prefer short explanations with examples.');
      old.attributes.engram_extraction = {
        ...(old.attributes.engram_extraction as object),
        review_status: review,
      };
      const batch = createCompositionalOverlapBatchInspectorV3();
      const r = batch.prepare(
        f.graph,
        domain(f, [
          'I like responses in plain English with one practical example before any terms.',
        ]),
        { budget: { remaining: 512, deferred: 0 }, now: NOW },
      );
      expect(r.status).toBe('prepared_data');
      if (r.status !== 'prepared_data') throw new Error(JSON.stringify(r));
      const data = batch.readBundle(r.batch, 0);
      if (data.status !== 'complete_data') throw new Error('fixture');
      expect(data.details[0]).toMatchObject({
        currentReview: review,
        disposition: 'possible_overlap',
      });
    },
  );
  it('requires all relevant candidates, rejects ninth relevant but not nine proven-disjoint rows', () => {
    const f = makeCompositionalCaptureFixture();
    for (const language of [
      'English',
      'French',
      'Spanish',
      'Swahili',
      'German',
      'Portuguese',
      'Italian',
      'Japanese',
      'Korean',
    ])
      addOld(f, `I prefer ${language}.`);
    const batch = createCompositionalOverlapBatchInspectorV3();
    const r = batch.prepare(f.graph, domain(f, ['I like short explanations.']), {
      budget: { remaining: 512, deferred: 0 },
      now: NOW,
    });
    expect(r.status).toBe('prepared_data');
    if (r.status !== 'prepared_data') throw new Error(JSON.stringify(r));
    expect(batch.readBundle(r.batch, 0)).toMatchObject({
      provenDisjointCount: 9,
      relevantCandidateCount: 0,
    });
    const g = makeCompositionalCaptureFixture();
    for (let i = 0; i < 9; i++)
      manual(g.graph, g.source.group_id, g.built.identity.binding.subjectId);
    expect(
      batch.prepare(g.graph, domain(g), { budget: { remaining: 512, deferred: 0 }, now: NOW }),
    ).toEqual({ status: 'incomplete', reason: 'inspection_capacity' });
  });
  it('never substitutes the first eight public samples for a later relevant meaning', () => {
    const f = makeCompositionalCaptureFixture();
    for (const language of [
      'English',
      'French',
      'Spanish',
      'Swahili',
      'German',
      'Portuguese',
      'Italian',
      'Japanese',
      'Korean',
    ])
      addOld(f, `I prefer ${language}.`);
    const batch = createCompositionalOverlapBatchInspectorV3();
    expect(
      batch.prepare(f.graph, domain(f, ['I like short explanations.', 'I like German.']), {
        budget: { remaining: 512, deferred: 0 },
        now: NOW,
      }),
    ).toEqual({ status: 'incomplete', reason: 'inspection_capacity' });
  });
  it('provides all nine private projections while the public diagnostic is capped at eight', () => {
    const f = makeCompositionalCaptureFixture();
    for (const language of [
      'English',
      'French',
      'Spanish',
      'Swahili',
      'German',
      'Portuguese',
      'Italian',
      'Japanese',
      'Korean',
    ])
      addOld(f, `I prefer ${language}.`);
    const inspector = createCompositionalOverlapBatchInspectorV3();
    const budget = { remaining: 512, deferred: 0 };
    const prepared = inspector.prepare(f.graph, domain(f, ['I like short explanations.']), {
      budget,
      now: NOW,
    });
    if (prepared.status !== 'prepared_data') throw new Error(JSON.stringify(prepared));
    const data = inspector.readBundle(prepared.batch, 0);
    if (data.status !== 'complete_data') throw new Error('fixture');
    expect(data.details).toHaveLength(8);
    const remaining = budget.remaining;
    const read = inspector.withPlanningData(
      prepared.batch,
      {
        snapshotHash: data.snapshotHash,
        namespace: f.source.group_id,
        subjectId: f.built.identity.binding.subjectId,
      },
      (view) => {
        const ids: string[] = [];
        expect(view.candidateCount).toBe(9);
        expect(Object.keys(view)).not.toContain('graph');
        view.forEachCandidate((candidate) => {
          ids.push(candidate.candidateId);
          expect(Object.isFrozen(candidate)).toBe(true);
          expect(Object.isFrozen(candidate.relations)).toBe(true);
          expect(candidate.canonicalMeaning).not.toBeNull();
          expect(candidate.source?.role).toBe('human');
          expect(candidate.relations[0].disposition).toBe('proven_disjoint');
          expect(view.lookupRecordId(candidate.edge.uuid)).toMatchObject({
            category: 'edge',
            id: candidate.edge.uuid,
          });
        });
        expect(view.source(f.source.uuid)).toEqual(f.source);
        return { ids };
      },
    );
    expect(read.status).toBe('planning_data');
    if (read.status !== 'planning_data') throw new Error('fixture');
    expect(read.value.ids).toHaveLength(9);
    expect(budget.remaining).toBe(remaining);
  });
  it('preserves actual same-family rows/proof and rejects changed planner expectations before callback', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const claim = f.graph.edges[0].attributes.engram_claim_v1 as {
      meaning: CompositionalAutomaticClaimMeaningV2;
    };
    const inspector = createCompositionalOverlapBatchInspectorV3();
    const p = inspector.prepare(
      f.graph,
      {
        namespace: f.request.namespace,
        subjectId: claim.meaning.subjectId,
        meanings: [claim.meaning],
      },
      { budget: { remaining: 512, deferred: 0 }, now: NOW },
    );
    if (p.status !== 'prepared_data') throw new Error('fixture');
    const data = inspector.readBundle(p.batch, 0);
    if (data.status !== 'complete_data') throw new Error('fixture');
    const expected = {
      snapshotHash: data.snapshotHash,
      namespace: f.request.namespace,
      subjectId: claim.meaning.subjectId,
    };
    const read = inspector.withPlanningData(p.batch, expected, (view) => {
      view.forEachCandidate((c) => {
        expect(c.qualifiedCompositional?.context.proof.operationId).toBe(f.operation.operationId);
        expect(c.qualifiedCompositional?.creationReview).toBe('accepted');
        expect(c.operations).toHaveLength(1);
        expect(Object.isFrozen(c.source)).toBe(true);
      });
      expect(view.operation(f.operation.operationId)).toEqual(f.operation);
      return { ordinaryData: true };
    });
    expect(read).toEqual({ status: 'planning_data', value: { ordinaryData: true } });
    const reader = jest.fn(() => ({}));
    for (const changed of [
      { ...expected, snapshotHash: 'a'.repeat(64) },
      { ...expected, namespace: expected.namespace + ' ' },
      { ...expected, subjectId: randomUUID() },
    ])
      expect(inspector.withPlanningData(p.batch, changed, reader)).toEqual({
        status: 'incomplete',
        reason: 'invalid_batch',
      });
    expect(reader).not.toHaveBeenCalled();
  });
  it('rejects asynchronous/thenable planner returns without invoking getters and deactivates retained views', () => {
    const f = makeCompositionalCaptureFixture();
    const inspector = createCompositionalOverlapBatchInspectorV3();
    const p = inspector.prepare(f.graph, domain(f), {
      budget: { remaining: 512, deferred: 0 },
      now: NOW,
    });
    if (p.status !== 'prepared_data') throw new Error('fixture');
    const d = inspector.readBundle(p.batch, 0);
    if (d.status !== 'complete_data') throw new Error('fixture');
    const expected = {
      snapshotHash: d.snapshotHash,
      namespace: f.source.group_id,
      subjectId: f.built.identity.binding.subjectId,
    };
    let calls = 0;
    const asyncReader = async () => {
      calls++;
      return {};
    };
    expect(inspector.withPlanningData(p.batch, expected, asyncReader)).toEqual({
      status: 'incomplete',
      reason: 'invalid_input',
    });
    expect(calls).toBe(0);
    const thenable = {};
    Object.defineProperty(thenable, 'then', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('secret');
      },
    });
    expect(inspector.withPlanningData(p.batch, expected, () => thenable)).toEqual({
      status: 'incomplete',
      reason: 'invalid_input',
    });
    expect(calls).toBe(0);
    let retained: Parameters<Parameters<typeof inspector.withPlanningData>[2]>[0] | undefined;
    expect(
      inspector.withPlanningData(p.batch, expected, (view) => {
        retained = view;
        return Promise.resolve({});
      }),
    ).toEqual({ status: 'incomplete', reason: 'invalid_input' });
    expect(() => retained!.source(f.source.uuid)).toThrow('inactive_reader');
    const g = makeCompositionalCaptureFixture();
    addOld(g, 'I prefer short explanations.');
    const other = createCompositionalOverlapBatchInspectorV3();
    const q = other.prepare(g.graph, domain(g), {
      budget: { remaining: 512, deferred: 0 },
      now: NOW,
    });
    if (q.status !== 'prepared_data') throw new Error('fixture');
    const data = other.readBundle(q.batch, 0);
    if (data.status !== 'complete_data') throw new Error('fixture');
    expect(
      other.withPlanningData(
        q.batch,
        {
          snapshotHash: data.snapshotHash,
          namespace: g.source.group_id,
          subjectId: g.built.identity.binding.subjectId,
        },
        (view) => {
          try {
            view.forEachCandidate(() => Promise.resolve());
          } catch {
            /* deliberate swallow */
          }
          return {};
        },
      ),
    ).toEqual({ status: 'incomplete', reason: 'invalid_input' });
  });
  it('checks the original shared deadline after a throwing callback and latches swallowed cancellation', () => {
    let clock = 10;
    const spy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const f = makeCompositionalCaptureFixture();
    const inspector = createCompositionalOverlapBatchInspectorV3();
    const budget = { remaining: 512, deferred: 0 };
    const p = inspector.prepare(f.graph, domain(f), { budget, now: NOW });
    if (p.status !== 'prepared_data') throw new Error('fixture');
    const d = inspector.readBundle(p.batch, 0);
    if (d.status !== 'complete_data') throw new Error('fixture');
    const expected = {
      snapshotHash: d.snapshotHash,
      namespace: f.source.group_id,
      subjectId: f.built.identity.binding.subjectId,
    };
    expect(
      inspector.withPlanningData(p.batch, expected, () => {
        clock = 5010;
        throw new Error('private callback text');
      }),
    ).toEqual({ status: 'incomplete', reason: 'budget_exhausted' });
    spy.mockRestore();
    let stage = false;
    let thrown = false;
    const cancelled = new Error('sticky reader cancellation');
    const other = createCompositionalOverlapBatchInspectorV3();
    const q = other.prepare(f.graph, domain(f), {
      budget: { remaining: 512, deferred: 0 },
      now: NOW,
      check: () => {
        if (stage && !thrown) {
          thrown = true;
          throw cancelled;
        }
      },
    });
    if (q.status !== 'prepared_data') throw new Error('fixture');
    const e = other.readBundle(q.batch, 0);
    if (e.status !== 'complete_data') throw new Error('fixture');
    expect(() =>
      other.withPlanningData(q.batch, { ...expected, snapshotHash: e.snapshotHash }, (view) => {
        stage = true;
        try {
          view.source(f.source.uuid);
        } catch {
          /* deliberate swallow */
        }
        return {};
      }),
    ).toThrow(cancelled);
  });
  it('projects all128 candidates once before bounded relevant-reference failure, never32 root rescans', () => {
    const f = makeCompositionalCaptureFixture();
    for (let i = 0; i < 128; i++)
      manual(f.graph, f.source.group_id, f.built.identity.binding.subjectId);
    const request = domain(f, Array(32).fill('I like English.'));
    const budget = { remaining: 512, deferred: 0 };
    let projections = 0;
    const real = LiteralHook.createLiteralV1SemanticOverlapPrivateProjectorV1;
    jest
      .spyOn(LiteralHook, 'createLiteralV1SemanticOverlapPrivateProjectorV1')
      .mockImplementation((...args) => {
        const p = real(...args);
        return p
          ? {
              ...p,
              projectCandidate: (...input) => {
                projections++;
                return p.projectCandidate(...input);
              },
            }
          : null;
      });
    const clone = jest.spyOn(Lossless, 'parseLosslessAutomaticCaptureGraph');
    const bindings = jest.spyOn(Identity, 'assertAutomaticBindingRegistryIntegrity');
    const result = createCompositionalOverlapBatchInspectorV3().prepare(f.graph, request, {
      budget,
      now: NOW,
    });
    expect(result).toEqual({ status: 'incomplete', reason: 'inspection_capacity' });
    expect(projections).toBe(128);
    expect(budget.remaining).toBe(0);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(bindings).toHaveBeenCalledTimes(1);
  });
  it('rejects a129th candidate before candidate hydration and prebounds malformed legacy metadata before Zod', () => {
    const f = makeCompositionalCaptureFixture();
    for (let i = 0; i < 129; i++)
      manual(f.graph, f.source.group_id, f.built.identity.binding.subjectId);
    const budget = { remaining: 512, deferred: 0 };
    expect(
      createCompositionalOverlapBatchInspectorV3().prepare(f.graph, domain(f), {
        budget,
        now: NOW,
      }),
    ).toEqual({ status: 'incomplete', reason: 'inspection_capacity' });
    expect(budget.remaining).toBe(512);
    const g = makeCompositionalCaptureFixture();
    manual(g.graph, g.source.group_id, g.built.identity.binding.subjectId);
    g.graph.edges[0].attributes.engram_claim_v1 = { version: 1, unknown: Array(20000).fill('x') };
    const request = domain(g);
    const parse = jest.spyOn(AutomaticClaimMetadataSchema, 'safeParse');
    const resources = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(resources);
    expect(
      createCompositionalOverlapBatchInspectorV3().prepare(g.graph, request, {
        budget: resources,
        now: NOW,
      }).status,
    ).toBe('incomplete');
    expect(parse).not.toHaveBeenCalled();
    expect(getAutomaticClaimReadScopeRemaining(scope)!.contextBytesRemaining).toBeLessThan(
      8 * 1024 * 1024,
    );
  });
  it('charges oversized invalid inspected data and never resets byte/attempt budgets on reprepare', () => {
    const f = makeCompositionalCaptureFixture();
    manual(f.graph, f.source.group_id, f.built.identity.binding.subjectId);
    f.graph.entities[1].summary = 'x'.repeat(600 * 1024);
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const batch = createCompositionalOverlapBatchInspectorV3();
    expect(batch.prepare(f.graph, domain(f), { budget, now: NOW }).status).toBe('incomplete');
    expect(budget.remaining).toBe(508);
    expect(getAutomaticClaimReadScopeRemaining(scope)!.contextBytesRemaining).toBeLessThan(
      8 * 1024 * 1024,
    );
    const before = getAutomaticClaimReadScopeRemaining(scope)!.contextBytesRemaining;
    batch.prepare(f.graph, domain(f), { budget, now: NOW });
    expect(budget.remaining).toBe(504);
    expect(getAutomaticClaimReadScopeRemaining(scope)!.contextBytesRemaining).toBeLessThan(before);
  });
  it('rechecks the shared deadline after final token/value freezing', () => {
    let clock = 10;
    const time = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const f = makeCompositionalCaptureFixture();
    const request = domain(f);
    const inspector = createCompositionalOverlapBatchInspectorV3();
    const original = Object.freeze;
    let hit = false;
    const frozen = jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = original(value);
      if (Array.isArray(value) && value.length === 1 && value[0]?.status === 'complete_data') {
        hit = true;
        clock = 5010;
      }
      return result;
    });
    expect(
      inspector.prepare(f.graph, request, { budget: { remaining: 512, deferred: 0 }, now: NOW }),
    ).toEqual({ status: 'incomplete', reason: 'budget_exhausted' });
    expect(hit).toBe(true);
    frozen.mockRestore();
    clock = 10;
    const other = createCompositionalOverlapBatchInspectorV3();
    const p = other.prepare(f.graph, request, {
      budget: { remaining: 512, deferred: 0 },
      now: NOW,
    });
    if (p.status !== 'prepared_data') throw new Error('fixture');
    const d = other.readBundle(p.batch, 0);
    if (d.status !== 'complete_data') throw new Error('fixture');
    let valueHit = false;
    const valueFreeze = jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = original(value);
      if (
        value !== null &&
        typeof value === 'object' &&
        (value as { finalFreezeMarker?: boolean }).finalFreezeMarker === true
      ) {
        valueHit = true;
        clock = 5010;
      }
      return result;
    });
    expect(
      other.withPlanningData(
        p.batch,
        {
          snapshotHash: d.snapshotHash,
          namespace: f.source.group_id,
          subjectId: f.built.identity.binding.subjectId,
        },
        () => ({ finalFreezeMarker: true }),
      ),
    ).toEqual({ status: 'incomplete', reason: 'budget_exhausted' });
    expect(valueHit).toBe(true);
    valueFreeze.mockRestore();
    time.mockRestore();
  });
  it('uses the same shared deadline on later reads/reprepare and rejects foreign/copied tokens', () => {
    let clock = 10;
    const spy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const f = makeCompositionalCaptureFixture();
    const batch = createCompositionalOverlapBatchInspectorV3();
    const budget = { remaining: 512, deferred: 0 };
    const r = batch.prepare(f.graph, domain(f), { budget, now: NOW });
    expect(r.status).toBe('prepared_data');
    if (r.status !== 'prepared_data') throw new Error('fixture');
    expect(batch.readBundle({ ...r.batch }, 0)).toEqual({
      status: 'incomplete',
      reason: 'invalid_batch',
    });
    expect(createCompositionalOverlapBatchInspectorV3().readBundle(r.batch, 0)).toEqual({
      status: 'incomplete',
      reason: 'invalid_batch',
    });
    clock = 5010;
    expect(batch.readBundle(r.batch, 0)).toEqual({
      status: 'incomplete',
      reason: 'budget_exhausted',
    });
    expect(batch.prepare(f.graph, domain(f), { budget, now: NOW })).toEqual({
      status: 'incomplete',
      reason: 'budget_exhausted',
    });
    spy.mockRestore();
  });
  it('reserves actual existing scope attempts before further inspection', () => {
    const f = makeCompositionalCaptureFixture();
    addOld(f, 'I prefer short explanations.');
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    expect(chargeAutomaticClaimContextBytes(scope, 8 * 1024 * 1024)).toBe(true);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    expect(
      createCompositionalOverlapBatchInspectorV3().prepare(f.graph, domain(f), { budget, now: NOW })
        .status,
    ).toBe('incomplete');
    expect(budget.remaining).toBe(504);
  });
  it('does one root clone/index/global binding stage and one parser projection across32 meanings/large unrelated roots', () => {
    const f = makeCompositionalCaptureFixture();
    addOld(f, 'I prefer short explanations.');
    for (let i = 0; i < 1000; i++)
      f.graph.entities.push(
        EntityNodeSchema.parse({
          uuid: randomUUID(),
          group_id: 'other-domain',
          name: `Unrelated ${i}`,
          created_at: f.graph.exported_at,
          updated_at: f.graph.exported_at,
        }),
      );
    const request = domain(f, Array(32).fill('I like English.'));
    const clone = jest.spyOn(Lossless, 'parseLosslessAutomaticCaptureGraph');
    const bindings = jest.spyOn(Identity, 'assertAutomaticBindingRegistryIntegrity');
    const indices = jest.spyOn(CommitProof, 'buildAutomaticClaimReadIndices');
    const parse = jest.spyOn(Parser, 'interpretCompositionalPreferencesV2');
    const r = createCompositionalOverlapBatchInspectorV3().prepare(f.graph, request, {
      budget: { remaining: 512, deferred: 0 },
      now: NOW,
    });
    expect(r.status).toBe('prepared_data');
    expect(clone).toHaveBeenCalledTimes(1);
    expect(bindings).toHaveBeenCalledTimes(1);
    expect(indices).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
  });
  it('latches a one-shot external cancellation during parser work', () => {
    const f = makeCompositionalCaptureFixture();
    addOld(f, 'I prefer short explanations.');
    const request = domain(f);
    let thrown = false;
    const cancelled = new Error('one-shot');
    expect(() =>
      createCompositionalOverlapBatchInspectorV3().prepare(f.graph, request, {
        budget: { remaining: 512, deferred: 0 },
        now: NOW,
        check: () => {
          if (!thrown && new Error().stack?.includes('CompositionalPreferenceV2Parser')) {
            thrown = true;
            throw cancelled;
          }
        },
      }),
    ).toThrow(cancelled);
    expect(thrown).toBe(true);
  });
  it('rejects resource/request/source getters and proxies before access and validates canonical now', () => {
    const f = makeCompositionalCaptureFixture();
    const request = domain(f);
    let calls = 0;
    const batch = createCompositionalOverlapBatchInspectorV3();
    const raw = {};
    Object.defineProperty(raw, 'then', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('secret');
      },
    });
    expect(
      batch.prepare(f.graph, raw, { budget: { remaining: 512, deferred: 0 }, now: NOW }).status,
    ).toBe('incomplete');
    const r = {};
    Object.defineProperty(r, 'budget', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('secret');
      },
    });
    expect(batch.prepare(f.graph, request, r)).toEqual({
      status: 'incomplete',
      reason: 'invalid_resources',
    });
    const proxy = new Proxy(f.graph, {
      get() {
        calls++;
        throw new Error('secret');
      },
      ownKeys() {
        calls++;
        throw new Error('secret');
      },
    });
    expect(
      batch.prepare(proxy, request, { budget: { remaining: 512, deferred: 0 }, now: NOW }).status,
    ).toBe('incomplete');
    expect(calls).toBe(0);
    expect(
      batch.prepare(f.graph, request, {
        budget: { remaining: 512, deferred: 0 },
        now: '2026-10-25T12:00:03Z',
      }),
    ).toEqual({ status: 'incomplete', reason: 'invalid_resources' });
  });
});
