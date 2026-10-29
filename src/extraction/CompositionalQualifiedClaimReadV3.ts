import type { CompositionalQualifiedClaimReadRequestV3 } from '../schemas/CompositionalQualifiedClaimReadV3.schema';
import {
  getOwnedCompositionalSnapshotV3,
  type CompositionalSnapshotIndexV3,
  type OwnedCompositionalSnapshotV3,
} from './CompositionalSnapshotIndexV3';
import { boundedAutomaticClaimReadJsonBytes } from './AutomaticClaimCommitProof';
import { v5 as uuidV5 } from 'uuid';
import { parseLosslessAutomaticCaptureGraph } from '../storage/LosslessAutomaticCaptureGraph';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { reconstructCompositionalAutomaticSourceIdentityV3 } from '../storage/CompositionalAutomaticCaptureSourceTupleV3';
import { assertAutomaticBindingIdentity } from '../storage/AutomaticIdentity';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  CompositionalAutomaticClaimMetadataV2Schema,
  CompositionalAutomaticValueMarkerV2Schema,
  compositionalAutomaticClaimKeyV2,
} from '../schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  reconcileCompositionalCaptureOperationIdentityV3,
  compositionalCaptureBundleHashV3,
  compositionalCaptureMeaningHashV3,
  compositionalCapturePredicateDependenciesV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import { ExtractionMetadataV2Schema } from '../schemas/ExtractionMetadata.schema';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../schemas/CompositionalPreferenceV2.schema';
import { interpretCompositionalPreferencesV2 } from './CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from './CompositionalPreferenceV2Meaning';
import {
  CompositionalQualifiedClaimReadContextV3Schema,
  CompositionalQualifiedClaimReadRequestV3Schema,
  CompositionalQualifiedClaimCommitProofV3Schema,
  type CompositionalQualifiedClaimReadResultV3,
} from '../schemas/CompositionalQualifiedClaimReadV3.schema';

const same = (a: unknown, b: unknown) =>
  canonicalAutomaticCaptureV2(a) === canonicalAutomaticCaptureV2(b);
type CandidateView = Pick<
  OwnedCompositionalSnapshotV3,
  'edge' | 'entity' | 'episode' | 'operationsForSource' | 'assertBinding'
>;
const invalid = (
  reason: Extract<
    CompositionalQualifiedClaimReadResultV3,
    { status: 'invalid' | 'uncommitted' }
  >['reason'],
): CompositionalQualifiedClaimReadResultV3 => ({ status: 'invalid', reason });
function projectQualifiedCandidate(
  view: CandidateView,
  request: CompositionalQualifiedClaimReadRequestV3,
  check: () => void,
): CompositionalQualifiedClaimReadResultV3 {
  const edge = view.edge(request.edgeId);
  if (!edge) return invalid('missing_edge');
  if (edge.group_id !== request.namespace) return invalid('invalid_context');
  const claimResult = CompositionalAutomaticClaimMetadataV2Schema.safeParse(
    edge.attributes.engram_claim_v1,
  );
  if (!claimResult.success) return invalid('invalid_claim');
  const claim = claimResult.data;
  const source = view.episode(claim.sourceId);
  const subject = view.entity(edge.source_node_uuid);
  const value = view.entity(edge.target_node_uuid);
  if (!source) return invalid('missing_source');
  if (!subject) return invalid('missing_subject');
  if (!value) return invalid('missing_value');
  const operations = view.operationsForSource(source.uuid);
  if (!operations.length) return { status: 'uncommitted', reason: 'missing_operation' };
  if (operations.length !== 1) return invalid('ambiguous_operation');
  const opResult = CompositionalAutomaticCaptureOperationV3Schema.safeParse(operations[0]);
  if (!opResult.success) return invalid('invalid_operation');
  const op = opResult.data;
  if (op.state !== 'committed') return { status: 'uncommitted', reason: 'capture_not_committed' };
  const receipt = op.terminalReceipt;
  if (receipt.kind !== 'human_compositional_capture_committed') return invalid('invalid_operation');
  const proof = {
    version: 1 as const,
    kind: 'committed_compositional_human_creation' as const,
    operationId: op.operationId,
    identity: op.identity,
    descriptor: op.descriptor,
    terminalReceipt: receipt,
  };
  if (!CompositionalQualifiedClaimCommitProofV3Schema.safeParse(proof).success)
    return invalid('proof_too_large');
  const tuple = reconstructCompositionalAutomaticSourceIdentityV3(source, op.descriptor, check);
  if (!reconcileCompositionalCaptureOperationIdentityV3(tuple.identity, op.identity))
    return invalid('invalid_operation');
  if (
    source.group_id !== request.namespace ||
    op.identity.namespace !== request.namespace ||
    claim.namespace !== request.namespace ||
    claim.subjectId !== subject.uuid ||
    claim.issuer !== op.identity.issuer ||
    claim.actorReference !== op.identity.actorReference ||
    !same(claim.binding, op.identity.binding) ||
    !same(claim.policy, op.descriptor.policy)
  )
    return invalid('invalid_claim');
  if (
    source.review_status !== 'accepted' ||
    source.trust_level !== op.descriptor.requestedTrustLevel ||
    Date.parse(receipt.terminalAt) > Date.parse(request.now)
  )
    return invalid('authority_inactive');
  // This scan checks the complete unfiltered binding registry, not a synthetic
  // partial root containing only the selected subject.
  view.assertBinding(
    request.namespace,
    op.identity.issuer,
    op.identity.actorReference,
    op.identity.binding,
    check,
  );
  const { version, policy, ...mapping } = tuple.envelope.sourceEnvelope;
  if (version !== 2 || !same(policy, op.descriptor.policy)) return invalid('invalid_claim');
  const interpreted = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: source.content,
    mappedContent: tuple.mappedContent,
    envelope: { ...mapping, version: 1 },
    check,
  });
  check();
  if (
    interpreted.coverage !== 'complete' ||
    interpreted.bundles.length !== receipt.selection.items.length
  )
    return invalid('invalid_claim');
  for (const [index, bundle] of interpreted.bundles.entries()) {
    check();
    const projection = projectCompositionalPreferenceV2Meaning({
      preference: { ...interpreted, bundles: [bundle] },
      namespace: request.namespace,
      subjectId: subject.uuid,
      check,
    });
    if (!projection.ok) return invalid('invalid_claim');
    const item = receipt.selection.items[index];
    if (
      item.bundleIndex !== index ||
      item.bundleHash !== compositionalCaptureBundleHashV3(bundle) ||
      item.meaningHash !== compositionalCaptureMeaningHashV3(projection.meaning) ||
      !same(
        item.predicateDependencies,
        compositionalCapturePredicateDependenciesV3(projection.meaning),
      )
    )
      return invalid('invalid_claim');
  }
  const creators = receipt.selection.items.filter(
    (item) => item.claimId === edge.uuid && item.mutation === 'created',
  );
  if (creators.length !== 1) return invalid('invalid_claim');
  const creator = creators[0];
  if (
    !creator.persisted ||
    (creator.state !== 'accepted' && creator.state !== 'proposed') ||
    creator.bundleHash !== compositionalCaptureBundleHashV3(claim.bundle) ||
    creator.meaningHash !== compositionalCaptureMeaningHashV3(claim.meaning) ||
    !same(creator.predicateDependencies, compositionalCapturePredicateDependenciesV3(claim.meaning))
  )
    return invalid('invalid_claim');
  if (
    (creator.state === 'accepted' && !op.descriptor.policy.autoAccept) ||
    (op.descriptor.policy.requiresExplicitIntent && !tuple.owner.intentEvidence)
  )
    return invalid('invalid_claim');
  const key = compositionalAutomaticClaimKeyV2(claim.meaning);
  const marker = CompositionalAutomaticValueMarkerV2Schema.safeParse(
    value.attributes.engram_literal_v1,
  );
  if (
    !marker.success ||
    marker.data.key !== key ||
    claim.key !== key ||
    edge.uuid !==
      uuidV5(
        canonicalAutomaticCaptureV2({ domain: 'engram-compositional-claim-row-v2', key }),
        uuidV5.URL,
      ) ||
    value.uuid !==
      uuidV5(
        canonicalAutomaticCaptureV2({ domain: 'engram-compositional-value-row-v2', key }),
        uuidV5.URL,
      ) ||
    value.entity_type !== 'compositional_preference_value' ||
    value.summary !== '' ||
    value.name_embedding !== null ||
    edge.fact_embedding !== null ||
    edge.name !== 'PREFERS' ||
    edge.fact !== claim.bundle.evidence.lexicalForm ||
    value.name !== edge.fact ||
    !same(edge.episodes, [source.uuid])
  )
    return invalid('invalid_claim');
  if (
    Object.keys(edge.attributes).sort().join(',') !== 'engram_claim_v1,engram_extraction' ||
    Object.keys(value.attributes).sort().join(',') !== 'engram_extraction,engram_literal_v1' ||
    edge.created_at !== value.created_at
  )
    return invalid('invalid_claim');
  const edgeMeta = ExtractionMetadataV2Schema.safeParse(edge.attributes.engram_extraction);
  const valueMeta = ExtractionMetadataV2Schema.safeParse(value.attributes.engram_extraction);
  if (
    !edgeMeta.success ||
    !valueMeta.success ||
    !same(edgeMeta.data, edge.attributes.engram_extraction) ||
    !same(valueMeta.data, value.attributes.engram_extraction) ||
    !same(edgeMeta.data.episode_uuids, [source.uuid]) ||
    !same(valueMeta.data.episode_uuids, [source.uuid])
  )
    return invalid('invalid_review_pair');
  const review = edgeMeta.data.review_status;
  if (review !== valueMeta.data.review_status) return invalid('invalid_review_pair');
  if (
    edgeMeta.data.threshold_decision !== valueMeta.data.threshold_decision ||
    edgeMeta.data.reviewed_at !== valueMeta.data.reviewed_at ||
    edgeMeta.data.reviewed_by !== valueMeta.data.reviewed_by
  )
    return invalid('invalid_review_pair');
  for (const row of [edge, value]) {
    check();
    const meta = row === edge ? edgeMeta.data : valueMeta.data;
    if (
      meta.source !== 'policy' ||
      meta.confidence !== null ||
      Date.parse(row.created_at) < Date.parse(source.created_at) ||
      Date.parse(row.created_at) > Date.parse(receipt.terminalAt) ||
      Date.parse(meta.extracted_at) !== Date.parse(row.created_at)
    )
      return invalid('invalid_claim');
    const initial =
      review === creator.state &&
      meta.threshold_decision ===
        (creator.state === 'accepted' ? 'auto_accepted' : 'pending_review') &&
      meta.reviewed_at === null &&
      meta.reviewed_by === null;
    const manual =
      meta.threshold_decision === 'manually_reviewed' &&
      meta.reviewed_at !== null &&
      meta.reviewed_by !== null &&
      Date.parse(meta.reviewed_at) >= Date.parse(receipt.terminalAt) &&
      Date.parse(meta.reviewed_at) <= Date.parse(request.now);
    if (!initial && !manual) return invalid('invalid_review_pair');
  }
  if (
    (edge.valid_at !== null && Date.parse(edge.valid_at) > Date.parse(request.now)) ||
    (edge.invalid_at !== null && Date.parse(edge.invalid_at) <= Date.parse(request.now)) ||
    edge.expired_at !== null
  )
    return invalid('authority_inactive');
  const contextResult = CompositionalQualifiedClaimReadContextV3Schema.safeParse({
    version: 1,
    namespace: request.namespace,
    edge,
    subject,
    value,
    source,
    proof,
  });
  if (!contextResult.success) return invalid('context_too_large');
  check();
  return {
    status: 'valid_data',
    context: contextResult.data,
    creationReview: creator.state,
    currentReview: review,
  };
}
/**
 * Validate/project supplied full-root DATA. The caller cannot establish storage
 * origin by constructing JSON. Trusted coherent backend read remains a separate
 * gate; this helper returns no create, reuse, acceptance or processing permit.
 */
export function validateCompositionalQualifiedClaimReadV3(
  graphValue: unknown,
  requestValue: unknown,
  externalCheck: () => void = () => {},
): CompositionalQualifiedClaimReadResultV3 {
  let aborted = false;
  let abort: unknown;
  const check = () => {
    if (aborted) throw abort;
    try {
      externalCheck();
    } catch (error) {
      aborted = true;
      abort = error;
      throw error;
    }
  };

  try {
    check();
    const request = CompositionalQualifiedClaimReadRequestV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(requestValue, 'beginRequest'),
    );
    const graph = parseLosslessAutomaticCaptureGraph(graphValue);
    check();
    // Count identities unfiltered before selecting an endpoint; namespace/UUID
    // collisions cannot be hidden by array order or a qualified-looking row.
    const ids = new Set<string>();
    for (const row of [...graph.entities, ...graph.edges, ...graph.episodes]) {
      check();
      if (ids.has(row.uuid)) return invalid('invalid_context');
      ids.add(row.uuid);
    }
    return projectQualifiedCandidate(
      {
        edge: (id) =>
          graph.edges.find((row) => {
            check();
            return row.uuid === id;
          }),
        entity: (id) =>
          graph.entities.find((row) => {
            check();
            return row.uuid === id;
          }),
        episode: (id) =>
          graph.episodes.find((row) => {
            check();
            return row.uuid === id;
          }),
        operationsForSource: (id) =>
          (graph.automatic_operations_v1?.operations ?? []).filter((op) => {
            check();
            return op.identity.sourceId === id;
          }),
        assertBinding: (namespace, issuer, actor, ref, innerCheck) =>
          assertAutomaticBindingIdentity(graph, namespace, issuer, actor, ref, innerCheck),
      },
      request,
      check,
    );
  } catch (error) {
    if (aborted) throw abort;
    return invalid('invalid_context');
  }
}

/** Private owned-index projection. Same safety logic as the public full-root
 * wrapper, with no per-candidate root clone/index/global-registry scan. */
export function createCompositionalQualifiedClaimReadPrivateProjectorV3(
  token: CompositionalSnapshotIndexV3,
  now: string,
  externalCheck: () => void = () => {},
) {
  const view = getOwnedCompositionalSnapshotV3(token);
  if (
    !view ||
    typeof now !== 'string' ||
    now.length !== 24 ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    throw new Error('Engram compositional batch: invalid_snapshot');
  let aborted = false;
  let abort: unknown;
  const check = () => {
    if (aborted) throw abort;
    try {
      externalCheck();
    } catch (error) {
      aborted = true;
      abort = error;
      throw error;
    }
  };
  const cache = new Map<
    string,
    { result: CompositionalQualifiedClaimReadResultV3; inspectedBytes: number }
  >();
  return Object.freeze({
    projectCandidate: (edgeId: string, maxInspectionBytes: number = 512 * 1024) => {
      check();
      if (
        typeof edgeId !== 'string' ||
        edgeId.length !== 36 ||
        !Number.isSafeInteger(maxInspectionBytes) ||
        maxInspectionBytes < 0 ||
        maxInspectionBytes > 512 * 1024
      )
        return { result: invalid('invalid_context'), inspectedBytes: 0 };
      const cached = cache.get(edgeId);
      if (cached) return cached;
      const edge = view.edge(edgeId);
      const rawClaim = edge?.attributes.engram_claim_v1;
      const sourceId =
        rawClaim !== null && typeof rawClaim === 'object' && !Array.isArray(rawClaim)
          ? (rawClaim as Record<string, unknown>).sourceId
          : undefined;
      const source =
        typeof sourceId === 'string' && sourceId.length === 36 ? view.episode(sourceId) : undefined;
      const inspectedBytes = boundedAutomaticClaimReadJsonBytes(
        {
          edge: edge ?? null,
          subject: edge ? (view.entity(edge.source_node_uuid) ?? null) : null,
          value: edge ? (view.entity(edge.target_node_uuid) ?? null) : null,
          source: source ?? null,
          operations: source ? view.operationsForSource(source.uuid) : [],
        },
        maxInspectionBytes,
      );
      let result: CompositionalQualifiedClaimReadResultV3;
      if (inspectedBytes > maxInspectionBytes) result = invalid('context_too_large');
      else if (
        edge &&
        (edge.group_id !== view.namespace || edge.source_node_uuid !== view.subjectId)
      )
        result = invalid('invalid_context');
      else
        try {
          result = projectQualifiedCandidate(
            view,
            { namespace: view.namespace, edgeId, now },
            check,
          );
        } catch (error) {
          if (aborted) throw abort;
          result = invalid('invalid_context');
        }
      const freeze = (value: unknown): void => {
        if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
          for (const child of Object.values(value)) freeze(child);
          Object.freeze(value);
        }
      };
      freeze(result);
      check();
      const projected = Object.freeze({ result, inspectedBytes });
      cache.set(edgeId, projected);
      return projected;
    },
  });
}
