import { buildCompositionalHumanCaptureSourceV3 } from '../../src/storage/CompositionalAutomaticCaptureSourceV3';
import { v5 as uuidV5 } from 'uuid';
import { makeCompositionalCaptureFixture } from './compositionalCaptureFixture';
import { CompositionalMaterializationPreparedV3Schema as Schema } from '../../src/schemas/CompositionalMaterializationPreparedV3.schema';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../../src/schemas/AutomaticCapture.schema';
import {
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  compositionalCaptureBundleHashV3,
  compositionalCaptureMeaningHashV3,
  compositionalCapturePredicateDependenciesV3,
  compositionalCaptureOperationIdentityHashV3,
} from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { compositionalAutomaticClaimKeyV2 } from '../../src/schemas/CompositionalAutomaticMemory.schema';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../src/schemas/CompositionalPreferenceV2.schema';
import { interpretCompositionalPreferencesV2 } from '../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../src/extraction/CompositionalPreferenceV2Meaning';
let actualCapture: ReturnType<typeof makeCompositionalCaptureFixture>;
function fixture(profile: 'conservative' | 'reviewFirst' = 'conservative', storeHash?: string) {
  let f = makeCompositionalCaptureFixture(
    'I like responses in plain Australian English, with one worked example ahead of any technical terms.',
    storeHash,
  );
  if (profile === 'reviewFirst') {
    const input = {
      ...f.input,
      request: {
        ...f.input.request,
        settings: { ...f.input.request.settings, profileId: 'reviewFirst' as const },
      },
    };
    const built = buildCompositionalHumanCaptureSourceV3({ ...f.graph, episodes: [] }, input);
    const source = structuredClone(built.episode);
    f = {
      ...f,
      input,
      built,
      source,
      graph: { ...f.graph, episodes: [source] },
      operation: CompositionalAutomaticCaptureOperationV3Schema.parse({
        ...f.operation,
        identity: built.identity,
        descriptor: built.descriptor,
      }),
    };
  }
  actualCapture = f;
  const wrapper = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
    f.source.attributes.engram_source_envelope_v2,
  );
  const { policy, version, ...mapping } = wrapper.sourceEnvelope;
  if (version !== 2) throw new Error('Synthetic envelope version');
  const preference = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: f.source.content,
    mappedContent: f.source.content,
    envelope: { ...mapping, version: 1 },
  });
  if (preference.coverage !== 'complete')
    throw new Error('Synthetic rich source must parse completely');
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
    review_status: profile === 'reviewFirst' ? ('proposed' as const) : ('accepted' as const),
    threshold_decision:
      profile === 'reviewFirst' ? ('pending_review' as const) : ('auto_accepted' as const),
    extracted_at: f.graph.exported_at,
    episode_uuids: [f.source.uuid],
    reviewed_at: null,
    reviewed_by: null,
  };
  const item = {
    decision:
      profile === 'reviewFirst' ? ('create_proposed' as const) : ('create_accepted' as const),
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

import { CompositionalAutomaticCaptureOperationV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { GraphDataSchema } from '../../src/schemas/GraphData.schema';

export function makeCompositionalCommittedClaimFixture(
  review: 'accepted' | 'proposed' = 'accepted',
  storeHash?: string,
) {
  const plan = fixture(review === 'proposed' ? 'reviewFirst' : 'conservative', storeHash);
  const f = actualCapture;
  const item = plan.items[0];
  if (item.decision !== 'create_accepted' && item.decision !== 'create_proposed')
    throw new Error('fixture');
  const terminalAt = '2026-10-25T12:00:01.000Z';
  for (const row of [...plan.createEdges, ...plan.createEntities]) {
    row.attributes.engram_extraction.review_status = review;
    row.attributes.engram_extraction.threshold_decision =
      review === 'accepted' ? 'auto_accepted' : 'pending_review';
  }
  const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...f.operation,
    state: 'committed',
    generation: 1,
    lastObservedAt: terminalAt,
    completionCallHash: 'd'.repeat(64),
    terminalReceipt: {
      version: 3,
      kind: 'human_compositional_capture_committed',
      operationId: f.operation.operationId,
      sourceId: f.source.uuid,
      sourceHash: f.operation.identity.sourceHash,
      descriptorHash: f.built.descriptorHash,
      policyFingerprint: f.built.descriptor.policy.fingerprint,
      terminalAt,
      interpretationCoverage: 'complete',
      acceptedCoverage: review === 'accepted' ? 'all' : 'none',
      reasons: [],
      selection: {
        kind: 'bundles',
        items: [
          {
            bundleIndex: 0,
            bundleHash: item.bundleHash,
            meaningHash: item.meaningHash,
            predicateDependencies: item.predicateDependencies,
            state: review,
            persisted: true,
            mutation: 'created',
            claimId: item.claimId,
          },
        ],
      },
    },
  });
  if (
    operation.state !== 'committed' ||
    operation.terminalReceipt.kind !== 'human_compositional_capture_committed'
  )
    throw new Error('fixture');
  const graph = GraphDataSchema.parse({
    ...f.graph,
    entities: [...f.graph.entities, ...plan.createEntities],
    edges: plan.createEdges,
    automatic_operations_v1: { version: 1, operations: [operation] },
  });
  return {
    graph,
    capturedOperation: f.operation,
    source: f.source,
    operation,
    request: {
      namespace: f.source.group_id,
      edgeId: item.claimId,
      now: '2026-10-25T12:00:03.000Z',
    },
  };
}
