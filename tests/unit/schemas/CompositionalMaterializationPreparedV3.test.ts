import { v5 as uuidV5 } from 'uuid';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { CompositionalMaterializationPreparedV3Schema as Schema } from '../../../src/schemas/CompositionalMaterializationPreparedV3.schema';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../../../src/schemas/AutomaticCapture.schema';
import {
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  compositionalCaptureBundleHashV3,
  compositionalCaptureMeaningHashV3,
  compositionalCapturePredicateDependenciesV3,
  compositionalCaptureOperationIdentityHashV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import {
  compositionalAutomaticClaimKeyV2,
  compileCompositionalAutomaticPolicyV2,
} from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function fixture() {
  const f = makeCompositionalCaptureFixture(
    'I like responses in plain Australian English, with one worked example ahead of any technical terms.',
  );
  const wrapper = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
    f.source.attributes.engram_source_envelope_v2,
  );
  const { policy, version, ...mapping } = wrapper.sourceEnvelope;
  expect(version).toBe(2);
  const preference = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: f.source.content,
    mappedContent: f.source.content,
    envelope: { ...mapping, version: 1 },
  });
  expect(preference.coverage).toBe('complete');
  const projected = projectCompositionalPreferenceV2Meaning({
    preference,
    namespace: f.source.group_id,
    subjectId: f.built.identity.binding.subjectId,
  });
  if (!projected.ok) throw new Error('Synthetic rich meaning must project');
  const meaning = projected.meaning;
  const key = compositionalAutomaticClaimKeyV2(meaning);
  const claimId = uuidV5(
    canonicalAutomaticCaptureV2({ domain: 'engram-compositional-claim-row-v2', key }),
    uuidV5.URL,
  );
  const valueId = uuidV5(
    canonicalAutomaticCaptureV2({ domain: 'engram-compositional-value-row-v2', key }),
    uuidV5.URL,
  );
  const identity = f.built.identity;
  const sourceGuard = {
    version: 3 as const,
    operationId: f.operation.operationId,
    sourceId: f.source.uuid,
    storeHash: identity.storeHash,
    namespace: f.source.group_id,
    issuer: identity.issuer,
    actorReference: identity.actorReference,
    bindingRef: identity.binding,
    capturedIdentityHash: compositionalCaptureOperationIdentityHashV3(identity),
    capturedSourceHash: identity.sourceHash,
    observedSourceHash: identity.sourceHash,
    rawContentHash: mapping.rawContentHash,
    mappedContentHash: mapping.contentHash,
    originalProducerHash: identity.originalProducerHash,
    stableProducerHash: identity.stableProducerHash,
    requestedAuthorityHash: identity.requestedAuthorityHash,
    envelopeHash: hashAutomaticCaptureV2(wrapper),
    descriptorHash: identity.descriptorHash,
    settingsHash: identity.settingsHash,
    policyFingerprint: policy.fingerprint,
  };
  const claim = {
    version: 2 as const,
    generation: 'compositional-preferences-v2' as const,
    namespace: f.source.group_id,
    subjectId: identity.binding.subjectId,
    binding: identity.binding,
    issuer: identity.issuer,
    actorReference: identity.actorReference,
    policy,
    sourceId: f.source.uuid,
    bundle: preference.bundles[0],
    meaning,
    key,
  };
  const meta = {
    version: 2 as const,
    source: 'policy' as const,
    confidence: null,
    review_status: 'accepted' as const,
    threshold_decision: 'auto_accepted' as const,
    extracted_at: f.graph.exported_at,
    episode_uuids: [f.source.uuid],
    reviewed_at: null,
    reviewed_by: null,
  };
  const item = {
    decision: 'create_accepted' as const,
    bundleIndex: 0,
    bundleHash: compositionalCaptureBundleHashV3(claim.bundle),
    meaningHash: compositionalCaptureMeaningHashV3(meaning),
    semanticKey: key,
    predicateDependencies: compositionalCapturePredicateDependenciesV3(meaning),
    codes: ['eligible_create' as const],
    claimId,
    valueId,
  };
  return Schema.parse({
    version: 3,
    kind: 'prepared_compositional_materialization',
    sourceGuard,
    snapshotHash: 'a'.repeat(64),
    planTimestamp: f.graph.exported_at,
    items: [item],
    createEntities: [
      {
        uuid: valueId,
        group_id: f.source.group_id,
        name: claim.bundle.evidence.lexicalForm,
        summary: '',
        entity_type: 'compositional_preference_value',
        name_embedding: null,
        attributes: {
          engram_literal_v1: { version: 2, generation: 'compositional-preferences-v2', key },
          engram_extraction: meta,
        },
        created_at: f.graph.exported_at,
        updated_at: f.graph.exported_at,
      },
    ],
    createEdges: [
      {
        uuid: claimId,
        group_id: f.source.group_id,
        source_node_uuid: identity.binding.subjectId,
        target_node_uuid: valueId,
        name: 'PREFERS',
        fact: claim.bundle.evidence.lexicalForm,
        fact_embedding: null,
        episodes: [f.source.uuid],
        valid_at: null,
        invalid_at: null,
        expired_at: null,
        attributes: { engram_claim_v1: claim, engram_extraction: meta },
        created_at: f.graph.exported_at,
        updated_at: f.graph.exported_at,
      },
    ],
  });
}

describe('standalone compositional prepared decisions (no persistence authority)', () => {
  it('fits a complete rich compound and retains every typed qualifier and exact evidence', () => {
    const plan = fixture();
    expect(Schema.parse(plan)).toEqual(plan);
    expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThan(512 * 1024);
    expect(plan.createEdges[0].attributes.engram_claim_v1.bundle.members.length).toBe(11);
    expect(plan.createEdges[0].fact).toContain('plain Australian English');
    expect(plan).not.toHaveProperty('should_process');
  });
  it.each([
    'reference_accepted',
    'reference_proposed',
    'reference_rejected',
    'not_selected',
  ] as const)('represents %s without creating rows', (decision) => {
    const plan = fixture();
    const original = plan.items[0];
    const { claimId, valueId, ...common } = original as Extract<
      typeof original,
      { decision: 'create_accepted' }
    >;
    plan.items = [
      decision === 'not_selected'
        ? { ...common, decision, codes: ['explicit_intent_required'] }
        : { ...common, decision, claimId, valueId, referenceGuardHash: 'b'.repeat(64) },
    ];
    plan.createEdges = [];
    plan.createEntities = [];
    expect(Schema.safeParse(plan).success).toBe(true);
  });
  it('supports proposed creation and a uniformly proposed prepared duplicate without promotion', () => {
    const plan = fixture();
    const first = plan.items[0];
    if (first.decision !== 'create_accepted') throw new Error('fixture');
    plan.items[0] = { ...first, decision: 'create_proposed', codes: ['profile_review_required'] };
    for (const row of [...plan.createEntities, ...plan.createEdges]) {
      row.attributes.engram_extraction.review_status = 'proposed';
      row.attributes.engram_extraction.threshold_decision = 'pending_review';
    }
    plan.items.push({
      ...first,
      bundleIndex: 1,
      decision: 'reference_prepared',
      primaryBundleIndex: 0,
      intendedReview: 'proposed',
    });
    expect(Schema.safeParse(plan).success).toBe(true);
    if (plan.items[1].decision !== 'reference_prepared') throw new Error('fixture');
    plan.items[1].intendedReview = 'accepted';
    expect(Schema.safeParse(plan).success).toBe(false);
  });
  it.each(['reference_rejected', 'reference_proposed'] as const)(
    'does not mix %s with accepted duplicate references',
    (decision) => {
      const plan = fixture();
      const first = plan.items[0];
      if (first.decision !== 'create_accepted') throw new Error('fixture');
      plan.createEntities = [];
      plan.createEdges = [];
      plan.items = [
        { ...first, decision, referenceGuardHash: 'a'.repeat(64) },
        {
          ...first,
          bundleIndex: 1,
          decision: 'reference_accepted',
          referenceGuardHash: 'a'.repeat(64),
        },
      ];
      expect(Schema.safeParse(plan).success).toBe(false);
    },
  );
  it.each(['hash', 'count'] as const)(
    'rejects a changed same-meaning prepared dependency %s',
    (kind) => {
      const plan = fixture();
      const first = plan.items[0];
      if (first.decision !== 'create_accepted') throw new Error('fixture');
      const duplicate = {
        ...copy(first),
        bundleIndex: 1,
        decision: 'reference_prepared' as const,
        primaryBundleIndex: 0,
        intendedReview: 'accepted' as const,
      };
      if (kind === 'hash') duplicate.predicateDependencies[0].dependencyHash = 'f'.repeat(64);
      else
        duplicate.predicateDependencies.push({ predicateIndex: 1, dependencyHash: 'a'.repeat(64) });
      plan.items.push(duplicate);
      expect(Schema.safeParse(plan).success).toBe(false);
    },
  );
  it('rejects accepted creation under a structurally valid reviewFirst policy', () => {
    const plan = fixture();
    const policy = compileCompositionalAutomaticPolicyV2({ profileId: 'reviewFirst' });
    plan.createEdges[0].attributes.engram_claim_v1.policy = policy;
    plan.sourceGuard.policyFingerprint = policy.fingerprint;
    expect(Schema.safeParse(plan).success).toBe(false);
  });
  it('allows one earlier creation plus a same-plan duplicate without external proof', () => {
    const plan = fixture();
    const first = plan.items[0];
    if (first.decision !== 'create_accepted') throw new Error('fixture');
    plan.items.push({
      ...first,
      bundleIndex: 1,
      decision: 'reference_prepared',
      primaryBundleIndex: 0,
      intendedReview: 'accepted',
    });
    expect(Schema.safeParse(plan).success).toBe(true);
    if (plan.items[1].decision !== 'reference_prepared') throw new Error('fixture');
    plan.items[1].primaryBundleIndex = 1;
    expect(Schema.safeParse(plan).success).toBe(false);
  });
  it.each([
    'missing_rows',
    'orphan',
    'confidence',
    'extra_attribute',
    'wrong_namespace',
    'wrong_source',
    'wrong_policy',
    'wrong_key',
    'drop_dependency',
    'wrong_evidence',
    'wrong_time',
    'duplicate_creation',
    'false_permit',
    'update_intent',
  ] as const)('rejects %s', (kind) => {
    const plan = fixture();
    const mutable = plan as unknown as Record<string, unknown>;
    switch (kind) {
      case 'missing_rows':
        plan.createEdges = [];
        break;
      case 'orphan':
        plan.items = [];
        break;
      case 'confidence':
        (
          plan.createEdges[0].attributes.engram_extraction as unknown as Record<string, unknown>
        ).confidence = 1;
        break;
      case 'extra_attribute':
        (plan.createEntities[0].attributes as unknown as Record<string, unknown>).other = true;
        break;
      case 'wrong_namespace':
        plan.sourceGuard.namespace = 'other';
        break;
      case 'wrong_source':
        plan.sourceGuard.sourceId = '11111111-1111-4111-8111-111111111111';
        break;
      case 'wrong_policy':
        plan.sourceGuard.policyFingerprint = 'f'.repeat(64);
        break;
      case 'wrong_key':
        plan.items[0].semanticKey = 'f'.repeat(64);
        break;
      case 'drop_dependency':
        plan.items[0].predicateDependencies = [];
        break;
      case 'wrong_evidence':
        plan.createEdges[0].fact += ' dropped';
        break;
      case 'wrong_time':
        plan.planTimestamp = '2026-10-26T12:00:00.000Z';
        break;
      case 'duplicate_creation':
        plan.items.push({ ...plan.items[0], bundleIndex: 1 });
        break;
      case 'false_permit':
        mutable.should_process = true;
        break;
      case 'update_intent':
        mutable.updateEdges = [];
        break;
    }
    expect(Schema.safeParse(plan).success).toBe(false);
  });
  it('enforces global predicate capacity across hash-only occurrences', () => {
    const plan = fixture();
    const { claimId, valueId, ...first } = plan.items[0] as Extract<
      (typeof plan.items)[number],
      { decision: 'create_accepted' }
    >;
    expect(claimId).not.toBe(valueId);
    plan.createEntities = [];
    plan.createEdges = [];
    plan.items = Array.from({ length: 32 }, (_, bundleIndex) => ({
      ...first,
      bundleIndex,
      decision: 'not_selected',
      codes: ['explicit_intent_required'],
    }));
    expect(Schema.safeParse(plan).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThan(512 * 1024);
    plan.items[31].predicateDependencies.push({
      predicateIndex: 1,
      dependencyHash: 'a'.repeat(64),
    });
    expect(Schema.safeParse(plan).success).toBe(false);
  });
  it('counts known repeated compound topology per occurrence toward the global 128-node cap', () => {
    const plan = fixture();
    const first = plan.items[0];
    if (first.decision !== 'create_accepted') throw new Error('fixture');
    plan.items = Array.from({ length: 12 }, (_, bundleIndex) =>
      bundleIndex === 0
        ? first
        : {
            ...first,
            bundleIndex,
            decision: 'reference_prepared',
            primaryBundleIndex: 0,
            intendedReview: 'accepted',
          },
    );
    expect(Schema.safeParse(plan).success).toBe(false);
  });
  it('rejects accessors/proxies/cycles and oversized unknown input before schema access', () => {
    let calls = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'version', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('secret');
      },
    });
    expect(Schema.safeParse(accessor).success).toBe(false);
    expect(calls).toBe(0);
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          calls++;
          throw new Error('secret');
        },
      },
    );
    expect(Schema.safeParse(proxy).success).toBe(false);
    expect(calls).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [cyclic, { huge: 'x'.repeat(512 * 1024 + 1) }])
      expect(Schema.safeParse(bad).success).toBe(false);
  });
  it('requires identical dependencies for duplicate hash-only whole meanings', () => {
    const plan = fixture();
    const first = plan.items[0];
    if (first.decision !== 'create_accepted') throw new Error('fixture');
    const { claimId, valueId, ...common } = first;
    expect(claimId).not.toBe(valueId);
    plan.createEntities = [];
    plan.createEdges = [];
    plan.items = [
      { ...common, decision: 'not_selected' },
      { ...copy(common), bundleIndex: 1, decision: 'not_selected' },
    ];
    plan.items[1].predicateDependencies[0].dependencyHash = 'f'.repeat(64);
    expect(Schema.safeParse(plan).success).toBe(false);
  });
  it('does not mutate caller data', () => {
    const plan = fixture();
    const before = copy(plan);
    Schema.parse(plan);
    expect(plan).toEqual(before);
  });
});
