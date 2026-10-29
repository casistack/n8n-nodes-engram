import { compareCompositionalMeaningOverlapDomainV1 } from './LiteralV1SemanticOverlap';
import { v5 as uuidV5 } from 'uuid';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import {
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  compositionalCaptureBundleHashV3,
  compositionalCaptureMeaningHashV3,
  compositionalCaptureOperationIdentityHashV3,
  compositionalCapturePredicateDependenciesV3,
  compositionalCaptureSourceHashV3,
  type CompositionalAutomaticCaptureOperationV3,
  type CompositionalAutomaticOperationIdentityV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticClaimMetadataV2Schema,
  CompositionalAutomaticValueMarkerV2Schema,
  compositionalAutomaticClaimKeyV2,
  type CompositionalAutomaticPolicyV2,
} from '../schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalMaterializationPreparedV3Schema,
  type PreparedCompositionalBundleDecisionV3,
  PreparedCompositionalSourceGuardV3Schema,
  type PreparedCompositionalSourceGuardV3,
} from '../schemas/CompositionalMaterializationPreparedV3.schema';
import {
  CompositionalMaterializationSelectorV3Schema,
  CompositionalMaterializationInterpretationV3Schema,
  type CompositionalMaterializationDeferredReasonV3,
  type CompositionalMaterializationResultV3,
} from '../schemas/CompositionalMaterializationV3.schema';
import {
  CompositionalPreferenceV2Schema,
  type CompositionalPreferenceV2,
  type CompositionalPreferenceV2Bundle,
} from '../schemas/CompositionalPreferenceV2.schema';
import type { CompositionalAutomaticClaimMeaningV2 } from '../schemas/CompositionalAutomaticMemory.schema';
import type { EntityEdge, EntityNode, EpisodicNode } from '../schemas';
import { EntityNodeSchema } from '../schemas/EntityNode.schema';
import { EntityEdgeSchema } from '../schemas/EntityEdge.schema';
import { ExtractionMetadataV2Schema } from '../schemas/ExtractionMetadata.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { interpretCompositionalHumanSourceV3EvidenceWithExecutionReport } from './CompositionalAutomaticCaptureV3Evidence';
import { projectCompositionalPreferenceV2Meaning } from './CompositionalPreferenceV2Meaning';
import {
  createCompositionalOperationSnapshotIndexV3,
  CompositionalSnapshotIndexErrorV3,
  getOwnedCompositionalSnapshotV3,
} from './CompositionalSnapshotIndexV3';
import {
  createCompositionalOverlapBatchInspectorV3,
  resolveCompositionalBatchResourcesV3,
  type PrivateCompositionalPlanningCandidateV3,
} from './CompositionalOverlapBatchV3';
import {
  getAutomaticClaimReadScope,
  canUseAutomaticClaimReadScope,
} from '../storage/AutomaticClaimReadScope';

class MaterializationResourceFailure extends Error {
  constructor(readonly reason: CompositionalMaterializationDeferredReasonV3) {
    super('Compositional materialization resource limit');
  }
}

type BundleInput = {
  index: number;
  bundle: CompositionalPreferenceV2Bundle;
  meaning: CompositionalAutomaticClaimMeaningV2;
  bundleHash: string;
  meaningHash: string;
  semanticKey: string;
  claimId: string;
  valueId: string;
  predicateDependencies: Array<{ predicateIndex: number; dependencyHash: string }>;
};

type PlannedRows = {
  status: 'rows';
  items: PreparedCompositionalBundleDecisionV3[];
  createEntities: EntityNode[];
  createEdges: EntityEdge[];
};
type PlanningOutcome =
  | PlannedRows
  | { status: 'deferred'; reason: CompositionalMaterializationDeferredReasonV3 };
type ClaimIdentity = Pick<
  CompositionalAutomaticOperationIdentityV3,
  'namespace' | 'issuer' | 'actorReference' | 'binding'
>;
type RecordLocation = Readonly<{
  category: 'entity' | 'edge' | 'episode' | 'operation';
  id: string;
  namespace: string;
}> | null;
type DecisionCode = PreparedCompositionalBundleDecisionV3['codes'][number];

const defer = (
  reason: CompositionalMaterializationDeferredReasonV3,
): CompositionalMaterializationResultV3 => ({
  status: 'deferred',
  reason,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function indexFailureReason(
  error: CompositionalSnapshotIndexErrorV3,
): CompositionalMaterializationDeferredReasonV3 | undefined {
  switch (error.reason) {
    case 'invalid_scope':
      return 'invalid_resources';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'missing_operation':
    case 'ambiguous_operation':
    case 'unsupported_mode':
      return error.reason;
    case 'invalid_snapshot':
      return 'invalid_snapshot';
  }
}

function makeSourceGuard(
  operation: CompositionalAutomaticCaptureOperationV3,
  source: EpisodicNode,
): PreparedCompositionalSourceGuardV3 {
  const identity = operation.identity;
  if (!source) throw new Error('missing source');
  const envelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
    source.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
  );
  return {
    version: 3,
    operationId: operation.operationId,
    sourceId: source.uuid,
    storeHash: identity.storeHash,
    namespace: identity.namespace,
    issuer: identity.issuer,
    actorReference: identity.actorReference,
    bindingRef: identity.binding,
    capturedIdentityHash: compositionalCaptureOperationIdentityHashV3(identity),
    capturedSourceHash: identity.sourceHash,
    observedSourceHash: compositionalCaptureSourceHashV3(source),
    rawContentHash: envelope.sourceEnvelope.rawContentHash,
    mappedContentHash: envelope.sourceEnvelope.contentHash,
    originalProducerHash: identity.originalProducerHash,
    stableProducerHash: identity.stableProducerHash,
    requestedAuthorityHash: identity.requestedAuthorityHash,
    envelopeHash: hashAutomaticCaptureV2(envelope),
    descriptorHash: identity.descriptorHash,
    settingsHash: identity.settingsHash,
    policyFingerprint: identity.policyFingerprint,
  };
}

function makeBundleInputs(
  result: CompositionalPreferenceV2,
  namespace: string,
  subjectId: string,
  check: () => void,
): BundleInput[] | null {
  const output: BundleInput[] = [];
  for (const [index, bundle] of result.bundles.entries()) {
    check();
    if (bundle.coverage !== 'complete') return null;
    const oneBundle: CompositionalPreferenceV2 = CompositionalPreferenceV2Schema.parse({
      version: 2,
      descriptor: result.descriptor,
      coverage: 'complete',
      bundles: [bundle],
      withheld: [],
      reasons: [],
    });
    const projected = projectCompositionalPreferenceV2Meaning({
      preference: oneBundle,
      namespace,
      subjectId,
      check,
    });
    if (!projected.ok) return null;
    const meaning = projected.meaning;
    if (meaning.bundles.length !== 1) return null;
    const semanticKey = compositionalAutomaticClaimKeyV2(meaning);
    output.push({
      index,
      bundle,
      meaning,
      bundleHash: compositionalCaptureBundleHashV3(bundle),
      meaningHash: compositionalCaptureMeaningHashV3(meaning),
      semanticKey,
      claimId: uuidV5(
        canonicalAutomaticCaptureV2({
          domain: 'engram-compositional-claim-row-v2',
          key: semanticKey,
        }),
        uuidV5.URL,
      ),
      valueId: uuidV5(
        canonicalAutomaticCaptureV2({
          domain: 'engram-compositional-value-row-v2',
          key: semanticKey,
        }),
        uuidV5.URL,
      ),
      predicateDependencies: compositionalCapturePredicateDependenciesV3(meaning),
    });
  }
  return output;
}

function uniqueCodes(codes: Iterable<DecisionCode>): DecisionCode[] {
  const result: DecisionCode[] = [];
  for (const code of codes) {
    if (!result.includes(code)) result.push(code);
    if (result.length === 8) break;
  }
  return result;
}

function blockerCodes(
  candidate: PrivateCompositionalPlanningCandidateV3,
  bundleIndex: number,
): DecisionCode[] {
  const relation = candidate.relations[bundleIndex];
  if (!relation || relation.domain === 'proven_disjoint') return [];
  if (
    relation.disposition === 'conditional_compatible' &&
    relation.family === 'literal_v1' &&
    relation.currentReview === 'accepted' &&
    relation.currentEligibility === 'eligible'
  )
    return [];
  const codes: DecisionCode[] = [];
  if (relation.family === 'literal_v1' && relation.disposition === 'legacy_reuse_not_authorized') {
    codes.push('legacy_reuse_not_authorized');
  }
  if (relation.family !== 'unknown') {
    if (relation.currentReview === 'accepted') codes.push('existing_accepted');
    else if (relation.currentReview === 'proposed') codes.push('existing_proposed');
    else if (relation.currentReview === 'rejected') codes.push('existing_rejected');
    if (relation.currentEligibility === 'ineligible') codes.push('existing_ineligible');
  }
  if (
    relation.domain === 'unknown_domain' ||
    relation.family === 'unknown' ||
    relation.projection === 'unknown' ||
    relation.projection === 'uncommitted' ||
    relation.disposition === 'unknown' ||
    relation.disposition === 'uncommitted'
  )
    codes.push('unknown_overlap_domain');
  else codes.push('possible_overlap');
  return codes;
}

function exactSameFamilyMatches(
  candidates: readonly PrivateCompositionalPlanningCandidateV3[],
  input: BundleInput,
  bundleIndex: number,
): PrivateCompositionalPlanningCandidateV3[] {
  return candidates.filter((candidate) => {
    const relation = candidate.relations[bundleIndex];
    const qualified = candidate.qualifiedCompositional;
    if (
      !relation ||
      relation.family !== 'compositional_v2' ||
      relation.equivalent !== true ||
      relation.disposition !== 'same_family_reference_data' ||
      !qualified ||
      qualified.status !== 'valid_data' ||
      candidate.canonicalMeaning === null
    )
      return false;
    return compositionalAutomaticClaimKeyV2(candidate.canonicalMeaning) === input.semanticKey;
  });
}

function makeRows(
  input: BundleInput,
  identity: ClaimIdentity,
  policy: CompositionalAutomaticPolicyV2,
  sourceId: string,
  planTimestamp: string,
  review: 'accepted' | 'proposed',
): { entity: EntityNode; edge: EntityEdge } {
  const metadata = ExtractionMetadataV2Schema.parse({
    version: 2,
    source: 'policy',
    confidence: null,
    review_status: review,
    threshold_decision: review === 'accepted' ? 'auto_accepted' : 'pending_review',
    extracted_at: planTimestamp,
    episode_uuids: [sourceId],
    reviewed_at: null,
    reviewed_by: null,
  });
  const claim = CompositionalAutomaticClaimMetadataV2Schema.parse({
    version: 2,
    generation: 'compositional-preferences-v2',
    namespace: identity.namespace,
    subjectId: identity.binding.subjectId,
    binding: identity.binding,
    issuer: identity.issuer,
    actorReference: identity.actorReference,
    policy,
    sourceId,
    bundle: input.bundle,
    meaning: input.meaning,
    key: input.semanticKey,
  });
  const valueMarker = CompositionalAutomaticValueMarkerV2Schema.parse({
    version: 2,
    generation: 'compositional-preferences-v2',
    key: input.semanticKey,
  });
  const lexicalForm = input.bundle.evidence.lexicalForm;
  const entity = EntityNodeSchema.parse({
    uuid: input.valueId,
    group_id: identity.namespace,
    name: lexicalForm,
    summary: '',
    entity_type: 'compositional_preference_value',
    name_embedding: null,
    attributes: { engram_literal_v1: valueMarker, engram_extraction: metadata },
    created_at: planTimestamp,
    updated_at: planTimestamp,
  });
  const edge = EntityEdgeSchema.parse({
    uuid: input.claimId,
    group_id: identity.namespace,
    source_node_uuid: identity.binding.subjectId,
    target_node_uuid: input.valueId,
    name: 'PREFERS',
    fact: lexicalForm,
    fact_embedding: null,
    episodes: [sourceId],
    valid_at: null,
    invalid_at: null,
    expired_at: null,
    attributes: { engram_claim_v1: claim, engram_extraction: metadata },
    created_at: planTimestamp,
    updated_at: planTimestamp,
  });
  return { entity, edge };
}

function buildDecisions(
  candidates: readonly PrivateCompositionalPlanningCandidateV3[],
  bundles: readonly BundleInput[],
  sourceGuard: PreparedCompositionalSourceGuardV3,
  planTimestamp: string,
  policy: CompositionalAutomaticPolicyV2,
  explicitIntent: boolean,
  lookupRecordId: (id: string) => RecordLocation,
  check: () => void,
): PlanningOutcome {
  const groups = new Map<string, number[]>();
  for (const input of bundles) {
    check();
    groups.set(input.semanticKey, [...(groups.get(input.semanticKey) ?? []), input.index]);
  }
  // Distinct new complete meanings must obey the same conservative overlap
  // boundary as later separate events. Do not choose a source-order winner;
  // exact duplicate groups are handled below by one primary creation.
  const intraSourceCodes = new Map<string, Set<DecisionCode>>();
  for (const input of bundles) {
    check();
    // Structural completeness is not an internal consistency proof for allOf.
    // Retain the entire coupled assertion without accepting any subset.
    if (input.predicateDependencies.length > 1)
      intraSourceCodes.set(input.semanticKey, new Set<DecisionCode>(['unknown_overlap_domain']));
  }
  const representatives = [...groups.values()].map((indexes) => bundles[indexes[0]]);
  for (let left = 0; left < representatives.length; left++)
    for (let right = left + 1; right < representatives.length; right++) {
      check();
      const a = representatives[left],
        b = representatives[right];
      const comparison = compareCompositionalMeaningOverlapDomainV1(a.meaning, b.meaning, check);
      if (comparison.domain === 'proven_disjoint') continue;
      const code: DecisionCode =
        comparison.domain === 'unknown_domain' ? 'unknown_overlap_domain' : 'possible_overlap';
      for (const key of [a.semanticKey, b.semanticKey]) {
        const codes = intraSourceCodes.get(key) ?? new Set<DecisionCode>();
        codes.add(code);
        intraSourceCodes.set(key, codes);
      }
    }
  const matchByIndex = new Map<number, PrivateCompositionalPlanningCandidateV3 | null>();
  const blockerCodesByIndex = new Map<number, DecisionCode[]>();
  const collisionGroups = new Set<string>();

  for (const input of bundles) {
    check();
    const matches = exactSameFamilyMatches(candidates, input, input.index);
    if (matches.length > 1) collisionGroups.add(input.semanticKey);
    matchByIndex.set(input.index, matches[0] ?? null);
    const codes = new Set<DecisionCode>(intraSourceCodes.get(input.semanticKey) ?? []);
    for (const candidate of candidates) {
      check();
      if (matches.includes(candidate)) continue;
      for (const code of blockerCodes(candidate, input.index)) codes.add(code);
    }
    blockerCodesByIndex.set(input.index, [...codes]);
  }

  for (const [semanticKey, indexes] of groups) {
    check();
    const first = bundles[indexes[0]];
    if (
      indexes.some(
        (index) =>
          bundles[index].meaningHash !== first.meaningHash ||
          canonicalAutomaticCaptureV2(bundles[index].predicateDependencies) !==
            canonicalAutomaticCaptureV2(first.predicateDependencies),
      )
    )
      collisionGroups.add(semanticKey);
    const found = indexes.map((index) => matchByIndex.get(index) ?? null);
    const foundIds = new Set(
      found
        .filter(
          (candidate): candidate is PrivateCompositionalPlanningCandidateV3 => candidate !== null,
        )
        .map((candidate) => candidate.candidateId),
    );
    if (foundIds.size > 1) collisionGroups.add(semanticKey);

    const claimOccupant = lookupRecordId(first.claimId);
    const valueOccupant = lookupRecordId(first.valueId);
    const reference = found[0];
    if (reference) {
      const relation = reference.relations[indexes[0]];
      const qualified = reference.qualifiedCompositional;
      if (
        !relation?.referenceGuardHash ||
        !qualified ||
        qualified.status !== 'valid_data' ||
        qualified.context.edge.uuid !== first.claimId ||
        qualified.context.value.uuid !== first.valueId ||
        claimOccupant?.category !== 'edge' ||
        claimOccupant.namespace !== sourceGuard.namespace ||
        valueOccupant?.category !== 'entity' ||
        valueOccupant.namespace !== sourceGuard.namespace
      )
        collisionGroups.add(semanticKey);
    } else if (claimOccupant || valueOccupant) {
      collisionGroups.add(semanticKey);
    }
  }
  if (collisionGroups.size) return { status: 'deferred', reason: 'identity_collision' };

  const items: PreparedCompositionalBundleDecisionV3[] = [];
  const createEntities: EntityNode[] = [];
  const createEdges: EntityEdge[] = [];
  const primaryByMeaning = new Map<
    string,
    { bundleIndex: number; review: 'accepted' | 'proposed' }
  >();

  for (const input of bundles) {
    check();
    const common = {
      bundleIndex: input.index,
      bundleHash: input.bundleHash,
      meaningHash: input.meaningHash,
      semanticKey: input.semanticKey,
      predicateDependencies: input.predicateDependencies,
    };
    const extraCodes = blockerCodesByIndex.get(input.index) ?? [];
    if (policy.requiresExplicitIntent && !explicitIntent) {
      items.push({
        ...common,
        decision: 'not_selected',
        codes: ['explicit_intent_required'] as DecisionCode[],
      });
      continue;
    }

    const sameFamily = matchByIndex.get(input.index) ?? null;
    if (sameFamily) {
      const result = sameFamily.qualifiedCompositional;
      const relation = sameFamily.relations[input.index];
      if (!result || result.status !== 'valid_data' || !relation?.referenceGuardHash)
        return { status: 'deferred', reason: 'identity_collision' };
      const state = result.currentReview;
      const statusCode: DecisionCode =
        state === 'accepted'
          ? 'existing_accepted'
          : state === 'proposed'
            ? 'existing_proposed'
            : 'existing_rejected';
      const codes = uniqueCodes([statusCode, ...extraCodes]);
      const decision =
        state === 'accepted'
          ? 'reference_accepted'
          : state === 'proposed'
            ? 'reference_proposed'
            : 'reference_rejected';
      items.push({
        ...common,
        decision,
        claimId: result.context.edge.uuid,
        valueId: result.context.value.uuid,
        referenceGuardHash: relation.referenceGuardHash,
        codes,
      });
      continue;
    }

    if (extraCodes.length > 0) {
      items.push({ ...common, decision: 'not_selected', codes: uniqueCodes(extraCodes) });
      continue;
    }

    const prior = primaryByMeaning.get(input.semanticKey);
    if (prior) {
      const codes: DecisionCode[] =
        prior.review === 'proposed' ? ['profile_review_required'] : ['eligible_create'];
      items.push({
        ...common,
        decision: 'reference_prepared',
        claimId: input.claimId,
        valueId: input.valueId,
        primaryBundleIndex: prior.bundleIndex,
        intendedReview: prior.review,
        codes,
      });
      continue;
    }

    const review: 'accepted' | 'proposed' =
      policy.profileId === 'reviewFirst' ? 'proposed' : 'accepted';
    const rows = makeRows(
      input,
      {
        namespace: sourceGuard.namespace,
        issuer: sourceGuard.issuer,
        actorReference: sourceGuard.actorReference,
        binding: sourceGuard.bindingRef,
      },
      policy,
      sourceGuard.sourceId,
      planTimestamp,
      review,
    );
    // The complete row schemas are checked again by the prepared-plan source of truth.
    createEntities.push(rows.entity);
    createEdges.push(rows.edge);
    const decision = review === 'accepted' ? 'create_accepted' : 'create_proposed';
    const codes: DecisionCode[] =
      review === 'accepted' ? ['eligible_create'] : ['profile_review_required'];
    items.push({
      ...common,
      decision,
      claimId: input.claimId,
      valueId: input.valueId,
      codes,
    });
    primaryByMeaning.set(input.semanticKey, { bundleIndex: input.index, review });
  }
  return { status: 'rows', items, createEntities, createEdges };
}

/** Produce bounded create-only data from the actual leased full-root operation. */
export function planCompositionalMaterializationV3(
  graphValue: unknown,
  selectorValue: unknown,
  resourcesValue: unknown,
): CompositionalMaterializationResultV3 {
  const resources = resolveCompositionalBatchResourcesV3(resourcesValue);
  if (!resources) return defer('invalid_resources');
  const scope = getAutomaticClaimReadScope(resources.budget);
  let cancellationLatched = false;
  let cancellation: unknown;
  const check = () => {
    if (cancellationLatched) throw cancellation;
    try {
      resources.check();
    } catch (error) {
      cancellationLatched = true;
      cancellation = error;
      throw error;
    }
    if (!canUseAutomaticClaimReadScope(scope))
      throw new MaterializationResourceFailure('budget_exhausted');
  };

  try {
    check();
    let selectorSnapshot: unknown;
    try {
      selectorSnapshot = cloneBoundedAutomaticCaptureJson(selectorValue, 'beginRequest');
    } catch {
      return defer('invalid_input');
    }
    check();
    const selectorResult = CompositionalMaterializationSelectorV3Schema.safeParse(selectorSnapshot);
    if (!selectorResult.success) return defer('invalid_input');
    const selector = selectorResult.data;
    check();
    let token;
    try {
      token = createCompositionalOperationSnapshotIndexV3(graphValue, selector, scope, check);
    } catch (error) {
      if (cancellationLatched) throw cancellation;
      if (error instanceof CompositionalSnapshotIndexErrorV3) {
        const reason = indexFailureReason(error);
        return defer(reason ?? 'invalid_snapshot');
      }
      if (error instanceof MaterializationResourceFailure) return defer(error.reason);
      return defer('invalid_snapshot');
    }
    check();
    const view = getOwnedCompositionalSnapshotV3(token);
    if (!view) return defer('invalid_snapshot');
    const operation = view.operation(selector.operationId);
    if (!operation || operation.version !== 3) return defer('missing_operation');
    if (operation.state !== 'leased') return defer('operation_not_leased');
    const nowMs = Date.parse(resources.now);
    if (nowMs < Date.parse(operation.lastObservedAt)) return defer('clock_regression');
    if (nowMs >= Date.parse(operation.lease.expiresAt)) return defer('lease_expired');
    const source = view.episode(operation.identity.sourceId);
    if (!source) return defer('invalid_source');
    if (
      source.uuid !== operation.identity.sourceId ||
      source.group_id !== operation.identity.namespace ||
      source.review_status !== 'accepted' ||
      source.trust_level !== operation.descriptor.requestedTrustLevel
    )
      return defer('authority_changed');
    try {
      const subject = view.assertBinding(
        operation.identity.namespace,
        operation.identity.issuer,
        operation.identity.actorReference,
        operation.identity.binding,
        check,
      );
      if (
        subject.uuid !== operation.identity.binding.subjectId ||
        subject.group_id !== operation.identity.namespace
      )
        return defer('authority_changed');
    } catch (error) {
      if (cancellationLatched) throw cancellation;
      if (error instanceof MaterializationResourceFailure) return defer(error.reason);
      if (error instanceof CompositionalSnapshotIndexErrorV3 && error.reason === 'budget_exhausted')
        return defer('budget_exhausted');
      return defer('authority_changed');
    }

    check();
    let report;
    try {
      report = interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
        source,
        operation.descriptor,
        operation.identity,
        check,
      );
    } catch (error) {
      if (cancellationLatched) throw cancellation;
      if (error instanceof MaterializationResourceFailure) throw error;
      if (error instanceof CompositionalSnapshotIndexErrorV3 && error.reason === 'budget_exhausted')
        throw new MaterializationResourceFailure('budget_exhausted');
      return defer('invalid_source');
    }
    check();
    const interpreted = report.evidence.result;
    if (interpreted.coverage !== 'complete' || interpreted.bundles.length === 0)
      return defer('source_verdict_required');
    if (interpreted.bundles.some((bundle) => bundle.coverage !== 'complete'))
      return defer('source_verdict_required');

    const sourceEnvelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
      source.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
    );
    const sourceGuard = PreparedCompositionalSourceGuardV3Schema.parse(
      makeSourceGuard(operation, source),
    );
    const bundles = makeBundleInputs(
      interpreted,
      operation.identity.namespace,
      operation.identity.binding.subjectId,
      check,
    );
    if (!bundles || bundles.length !== interpreted.bundles.length) return defer('invalid_source');
    const planTimestamp = operation.lease.renewedAt;

    let outcome: PlanningOutcome;
    if (
      operation.descriptor.policy.requiresExplicitIntent &&
      !sourceEnvelope.sourceEnvelope.explicitIntent
    ) {
      outcome = {
        status: 'rows',
        items: bundles.map((input) => ({
          bundleIndex: input.index,
          bundleHash: input.bundleHash,
          meaningHash: input.meaningHash,
          semanticKey: input.semanticKey,
          predicateDependencies: input.predicateDependencies,
          decision: 'not_selected',
          codes: ['explicit_intent_required'],
        })),
        createEntities: [],
        createEdges: [],
      };
    } else {
      const request = {
        namespace: operation.identity.namespace,
        subjectId: operation.identity.binding.subjectId,
        meanings: bundles.map((input) => input.meaning),
      };
      const inspector = createCompositionalOverlapBatchInspectorV3();
      const prepared = inspector.prepareFromOwnedIndex(token, request, {
        budget: resources.budget,
        now: resources.now,
        check,
      });
      if (prepared.status !== 'prepared_data') {
        if (prepared.reason === 'budget_exhausted') return defer('budget_exhausted');
        if (prepared.reason === 'invalid_resources') return defer('invalid_resources');
        if (prepared.reason === 'invalid_input') return defer('invalid_input');
        if (prepared.reason === 'invalid_snapshot' || prepared.reason === 'invalid_batch')
          return defer('invalid_snapshot');
        return defer('inspection_incomplete');
      }
      const checked = inspector.withPlanningData(
        prepared.batch,
        { snapshotHash: view.snapshotHash, namespace: view.namespace, subjectId: view.subjectId },
        (planning) => {
          check();
          const candidates: PrivateCompositionalPlanningCandidateV3[] = [];
          planning.forEachCandidate((candidate) => {
            check();
            candidates.push(candidate);
          });
          check();
          if (candidates.length !== planning.candidateCount)
            return { status: 'deferred' as const, reason: 'inspection_incomplete' as const };
          return buildDecisions(
            candidates,
            bundles,
            sourceGuard,
            planTimestamp,
            operation.descriptor.policy,
            sourceEnvelope.sourceEnvelope.explicitIntent,
            planning.lookupRecordId,
            check,
          );
        },
      );
      if (checked.status !== 'planning_data') {
        if (checked.reason === 'budget_exhausted') return defer('budget_exhausted');
        if (checked.reason === 'invalid_batch') return defer('invalid_snapshot');
        return defer('inspection_incomplete');
      }
      outcome = checked.value;
    }
    if (outcome.status === 'deferred') return defer(outcome.reason);
    check();
    const planCandidate = {
      version: 3 as const,
      kind: 'prepared_compositional_materialization' as const,
      sourceGuard,
      snapshotHash: view.snapshotHash,
      planTimestamp,
      items: outcome.items,
      createEntities: outcome.createEntities,
      createEdges: outcome.createEdges,
    };
    const planSerialized = JSON.stringify(planCandidate);
    if (Buffer.byteLength(planSerialized, 'utf8') > 512 * 1024) return defer('plan_too_large');
    const aggregateAttributes = [...outcome.createEntities, ...outcome.createEdges].reduce(
      (size, row) => size + Buffer.byteLength(JSON.stringify(row.attributes), 'utf8'),
      0,
    );
    if (aggregateAttributes > 32 * 1024) return defer('plan_too_large');
    const parsedPlan = CompositionalMaterializationPreparedV3Schema.safeParse(planCandidate);
    if (!parsedPlan.success) return defer('invalid_plan');
    check();
    const plan = deepFreeze(parsedPlan.data);
    const interpretation = deepFreeze(
      CompositionalMaterializationInterpretationV3Schema.parse({
        interpreterResultHash: report.evidence.interpreterResultHash,
        reasons: interpreted.reasons,
      }),
    );
    check();
    return { status: 'prepared_data', plan, interpretation };
  } catch (error) {
    if (cancellationLatched) throw cancellation;
    if (error instanceof MaterializationResourceFailure) return defer(error.reason);
    if (error instanceof CompositionalSnapshotIndexErrorV3) {
      const reason = indexFailureReason(error);
      return defer(reason ?? 'invalid_snapshot');
    }
    if (error instanceof Error && error.message.includes('identity_collision'))
      return defer('identity_collision');
    if (error instanceof Error && error.message.includes('JSON exceeds'))
      return defer('plan_too_large');
    if (error instanceof Error && error.message.includes('Compositional materialization'))
      return defer('invalid_source');
    return defer('invalid_plan');
  }
}
