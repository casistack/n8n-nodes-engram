import { createHash } from 'crypto';
import { types as utilTypes } from 'util';
import { v5 as uuid } from 'uuid';
import {
  extractionMetadataFromAttributes,
  type EntityEdge,
  type EntityNode,
  type GraphData,
  type EpisodicNode,
} from '../schemas';
import { AutomaticClaimMetadataSchema } from '../schemas/AutomaticClaim.schema';
import { AutomaticSourceEnvelopeSchema } from '../schemas/AutomaticMemory.schema';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  snapshotBoundedCompositionalJson,
} from '../schemas/CompositionalPreferenceV2.schema';
import type { CompositionalAutomaticClaimMeaningV2 } from '../schemas/CompositionalAutomaticMemory.schema';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import type { AutomaticReadBudget } from '../schemas/AutomaticRuntime.schema';
import {
  LiteralV1SemanticOverlapRequestSchema,
  LiteralV1SemanticOverlapResultSchema,
  type LiteralV1SemanticOverlapRequest,
  type LiteralV1SemanticOverlapResult,
  type LiteralV1SemanticInspection,
  type LiteralV1OverlapReason,
} from '../schemas/LiteralV1SemanticOverlap.schema';
import { parseLosslessAutomaticCaptureGraph } from '../storage/LosslessAutomaticCaptureGraph';
import { BoundedAutomaticCaptureJsonError } from '../storage/BoundedAutomaticCaptureJson';
import {
  assertAutomaticBindingIdentity,
  assertAutomaticBindingRegistryIntegrity,
  prepareAutomaticEpisodeInput,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../storage/AutomaticIdentity';
import {
  getAutomaticClaimReadScope,
  canUseAutomaticClaimReadScope,
  beginAutomaticClaimReadAttempt,
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScopeRemaining,
} from '../storage/AutomaticClaimReadScope';
import {
  buildAutomaticClaimReadIndices,
  boundedAutomaticClaimReadJsonBytes,
  projectAutomaticClaimReadContextWithUsage,
} from './AutomaticClaimCommitProof';
import {
  validateAutomaticClaimEvidence,
  validateAutomaticClaimReadContext,
  validateStoredAutomaticClaim,
} from './AutomaticClaims';
import { compileAutomaticPolicy, parseAutomaticPreferences } from './AutomaticEvidence';
import { interpretCompositionalPreferencesV2 } from './CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from './CompositionalPreferenceV2Meaning';
import {
  getOwnedCompositionalSnapshotV3,
  type CompositionalSnapshotIndexV3,
  type OwnedCompositionalSnapshotV3,
} from './CompositionalSnapshotIndexV3';
import { canonical, fingerprint } from './QueueState';

class InspectionCapacity extends Error {}
class ExternalInspectionAbort extends Error {}
const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const id = (value: unknown) => uuid(canonical(value), uuid.URL);
const equal = (left: unknown, right: unknown) =>
  hashAutomaticCaptureV2(left) === hashAutomaticCaptureV2(right);

/** Fully typed facets are a conservative overlap domain, not a conflict solver. */
function facets(
  meaning: CompositionalAutomaticClaimMeaningV2,
  check: () => void,
): Set<string> | null {
  const bundle = meaning.bundles[0];
  const nodes = new Map(bundle.nodes.map((node) => [node.path, node]));
  const children = new Map<string, string[]>();
  for (const edge of bundle.edges) {
    check();
    if (edge.relation === 'all_of') continue;
    const list = children.get(edge.ownerPath) ?? [];
    list.push(edge.targetPath);
    children.set(edge.ownerPath, list);
  }
  const result = new Set<string>();
  for (const root of bundle.rootPaths) {
    const local = new Set<string>();
    const pending = [root],
      visited = new Set<string>();
    while (pending.length) {
      check();
      const path = pending.pop()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const node = nodes.get(path);
      if (!node) return null;
      switch (node.kind) {
        case 'language':
        case 'language_use':
          local.add('language');
          break;
        case 'presentation':
        case 'format_selection':
          local.add('representation');
          break;
        case 'emoji_usage':
          local.add('emoji_usage');
          break;
        case 'communication_quality':
        case 'style':
        case 'register':
          local.add('delivery_style');
          break;
        case 'length':
        case 'detail':
        case 'action':
        case 'ordering':
          local.add('response_structure');
          break;
        case 'output_characteristic':
          local.add('response_structure');
          local.add('delivery_style');
          break;
        case 'preference':
        case 'output':
        case 'count':
        case 'quantifier':
        case 'action_qualifier':
        case 'task_scope':
        case 'condition':
        case 'frequency':
          break;
        default:
          return null;
      }
      pending.push(...(children.get(path) ?? []));
    }
    if (!local.size) return null;
    local.forEach((facet) => result.add(facet));
  }
  return result.size ? result : null;
}

/** Typed V1/V2 facet comparison only; this carries no eligibility or reuse authority. */
export function compareCompositionalMeaningOverlapDomainV1(
  oldMeaning: CompositionalAutomaticClaimMeaningV2,
  newMeaning: CompositionalAutomaticClaimMeaningV2,
  check: () => void = () => {},
): {
  domain: 'proven_disjoint' | 'possible_overlap' | 'unknown_domain';
  equivalent: boolean;
} {
  const oldFacets = facets(oldMeaning, check);
  const newFacets = facets(newMeaning, check);
  return comparePreparedFacets(oldMeaning, oldFacets, newMeaning, newFacets);
}

function comparePreparedFacets(
  oldMeaning: CompositionalAutomaticClaimMeaningV2,
  oldFacets: Set<string> | null,
  newMeaning: CompositionalAutomaticClaimMeaningV2,
  newFacets: Set<string> | null,
): {
  domain: 'proven_disjoint' | 'possible_overlap' | 'unknown_domain';
  equivalent: boolean;
} {
  const domain =
    !oldFacets || !newFacets
      ? 'unknown_domain'
      : [...oldFacets].some((facet) => newFacets.has(facet))
        ? 'possible_overlap'
        : 'proven_disjoint';
  return { domain, equivalent: equal(oldMeaning, newMeaning) };
}

function currentReview(edge: EntityEdge): LiteralV1SemanticInspection['currentReview'] {
  return extractionMetadataFromAttributes(edge.attributes)?.review_status ?? 'unknown';
}

function unresolved(
  edge: EntityEdge,
  provenance: LiteralV1SemanticInspection['provenance'],
  reason: LiteralV1OverlapReason,
  unavailable = false,
): LiteralV1SemanticInspection {
  return {
    oldEdgeId: edge.uuid,
    provenance,
    projection: unavailable ? 'unavailable' : 'unresolved',
    currentReview: currentReview(edge),
    currentAuthority: unavailable ? 'source_unavailable' : 'invalid',
    oldCurrentEligibility: unavailable ? 'unavailable' : 'ineligible',
    domain: 'unknown_domain',
    equivalent: null,
    blocksNewAcceptance: true,
    reasons: [...new Set<LiteralV1OverlapReason>([reason, 'unknown_overlap_domain'])],
  };
}

function validEvidence(
  edge: EntityEdge,
  source: EpisodicNode,
  value: GraphData['entities'][number] | undefined,
  check: () => void,
) {
  const parsed = AutomaticClaimMetadataSchema.safeParse(edge.attributes.engram_claim_v1);
  if (!parsed.success) return null;
  const meta = parsed.data;
  if (
    source.role !== 'human' ||
    !['active_human', 'passive_human'].includes(source.episode_kind) ||
    source.quoted_message_id ||
    source.content.length > 65536 ||
    Buffer.byteLength(source.content) > 65536
  )
    return null;
  try {
    prepareAutomaticEpisodeInput(source);
  } catch {
    return null;
  }
  const parsedEnvelope = AutomaticSourceEnvelopeSchema.safeParse(
    source.attributes.engram_source_envelope_v1,
  );
  if (!parsedEnvelope.success) return null;
  const envelope = parsedEnvelope.data;
  if (
    meta.policy.profileId === 'existing' ||
    !equal(meta.policy, compileAutomaticPolicy({ profileId: meta.policy.profileId })) ||
    !equal(meta.policy, envelope.policy) ||
    !equal(meta.binding, envelope.bindingRef) ||
    meta.issuer !== envelope.issuer ||
    meta.actorReference !== envelope.actorReference ||
    meta.subjectId !== envelope.bindingRef.subjectId ||
    envelope.namespace !== edge.group_id ||
    source.group_id !== edge.group_id ||
    sha(source.content) !== envelope.rawContentHash ||
    envelope.humanRegion.end > source.content.length
  )
    return null;
  const mappedContent = source.content.slice(envelope.humanRegion.start, envelope.humanRegion.end);
  check();
  const literal = parseAutomaticPreferences(envelope, mappedContent);
  if (literal.claims.length !== 1 || !equal(literal.claims[0], meta.claim)) return null;
  const valueKey = [
    'literal-preference-v1',
    edge.group_id,
    'preference_value',
    meta.claim.languageTag,
    meta.claim.literal,
  ];
  const key = fingerprint([...valueKey, meta.subjectId, meta.claim.polarity]);
  if (
    meta.key !== key ||
    edge.uuid !== id(['attributed-preference-v1', key]) ||
    edge.source_node_uuid !== meta.subjectId ||
    edge.target_node_uuid !== id(valueKey) ||
    edge.name !== 'PREFERS' ||
    edge.fact !== meta.claim.clause ||
    value?.name !== meta.claim.literal ||
    value.entity_type !== 'preference_value' ||
    !edge.episodes.includes(source.uuid) ||
    !extractionMetadataFromAttributes(edge.attributes)?.episode_uuids.includes(source.uuid)
  )
    return null;
  check();
  const preference = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: source.content,
    mappedContent,
    envelope,
    check,
  });
  if (
    preference.coverage !== 'complete' ||
    preference.bundles.length !== 1 ||
    preference.bundles[0].coverage !== 'complete'
  )
    return null;
  // V1 accepted one complete clause, optionally preceded by the reviewed
  // anchored request. Match original offsets; never parse an extracted clause.
  const spans = preference.bundles[0].evidence.spans;
  const span = spans[0];
  if (!span) return null;
  const suffix = mappedContent.slice(span.content.end, meta.claim.clauseSpan.end);
  const rawSuffix = source.content.slice(span.raw.end, meta.claim.rawClauseSpan.end);
  const sameEnds =
    span.content.end === meta.claim.clauseSpan.end && span.raw.end === meta.claim.rawClauseSpan.end;
  const oneTerminal =
    span.content.end + 1 === meta.claim.clauseSpan.end &&
    span.raw.end + 1 === meta.claim.rawClauseSpan.end &&
    (suffix === '.' || suffix === '!') &&
    suffix === rawSuffix &&
    !/[.!?]/u.test(mappedContent[span.content.end - 1] ?? '');
  if (
    spans.length !== 1 ||
    span.content.start !== meta.claim.clauseSpan.start ||
    span.raw.start !== meta.claim.rawClauseSpan.start ||
    (!sameEnds && !oneTerminal) ||
    suffix !== rawSuffix ||
    preference.bundles[0].evidence.lexicalForm !==
      mappedContent.slice(span.content.start, span.content.end) ||
    mappedContent.slice(span.content.start, span.content.end) !==
      source.content.slice(span.raw.start, span.raw.end) ||
    preference.bundles[0].evidence.lexicalForm + suffix !== meta.claim.clause
  )
    return null;
  const projected = projectCompositionalPreferenceV2Meaning({
    preference,
    namespace: edge.group_id,
    subjectId: meta.subjectId,
    check,
  });
  if (!projected.ok || projected.meaning.bundles.length !== 1) return null;
  return { meta, envelope, meaning: projected.meaning };
}

interface PrivateProjectionView {
  readonly graph: GraphData;
  readonly namespace: string;
  readonly subjectId: string;
  readonly subject: EntityNode;
  readonly candidates: readonly EntityEdge[];
  entity(id: string): EntityNode | undefined;
  episode(id: string): EpisodicNode | undefined;
  projectLiteralCommitContext(
    edgeId: string,
    maxBytes: number,
  ): {
    result: ReturnType<typeof projectAutomaticClaimReadContextWithUsage>['result'];
    inspectedBytes: number;
  };
  assertBinding?(
    namespace: string,
    issuer: string,
    actor: string,
    ref: unknown,
    check?: () => void,
  ): EntityNode;
}

interface PrivateProjectionHooks {
  assertCurrentBinding?(
    evidenceGraph: GraphData,
    namespace: string,
    issuer: string,
    actor: string,
    ref: unknown,
    check: () => void,
  ): void;
  validateStoredV1?(evidenceGraph: GraphData, edge: EntityEdge): boolean;
}

export interface LiteralV1SemanticOverlapCandidateProjectionV1 {
  readonly inspectedBytes: number;
  readonly capacityExceeded: boolean;
  compare(newMeaning: CompositionalAutomaticClaimMeaningV2): LiteralV1SemanticInspection;
}

export interface LiteralV1SemanticOverlapPrivateProjectorV1 {
  prepareMeaning(meaning: CompositionalAutomaticClaimMeaningV2): void;
  projectCandidate(
    edgeId: string,
    contextByteLimit: number,
  ): LiteralV1SemanticOverlapCandidateProjectionV1 | null;
}

function createPrivateProjector(
  view: PrivateProjectionView,
  now: number,
  check: () => void,
  hooks: PrivateProjectionHooks = {},
): LiteralV1SemanticOverlapPrivateProjectorV1 {
  const candidateById = new Map(view.candidates.map((edge) => [edge.uuid, edge]));
  const candidateCache = new Map<string, LiteralV1SemanticOverlapCandidateProjectionV1>();
  const preparedMeanings = new Map<CompositionalAutomaticClaimMeaningV2, Set<string> | null>();

  const prepareMeaning = (meaning: CompositionalAutomaticClaimMeaningV2) => {
    if (!preparedMeanings.has(meaning)) {
      check();
      preparedMeanings.set(meaning, facets(meaning, check));
    }
  };

  const makeEvidenceGraph = (
    edge: EntityEdge,
    source: EpisodicNode,
    value: EntityNode | undefined,
  ): GraphData => ({
    version: view.graph.version,
    exported_at: view.graph.exported_at,
    entities: value && value.uuid !== view.subject.uuid ? [view.subject, value] : [view.subject],
    episodes: [source],
    edges: [edge],
  });

  const projectCandidate = (
    edgeId: string,
    contextByteLimit: number,
  ): LiteralV1SemanticOverlapCandidateProjectionV1 | null => {
    check();
    if (!Number.isSafeInteger(contextByteLimit) || contextByteLimit < 0) return null;
    const candidate = candidateById.get(edgeId);
    if (!candidate) return null;
    const cached = candidateCache.get(edgeId);
    if (cached) {
      if (!cached.capacityExceeded && cached.inspectedBytes > contextByteLimit) {
        return { ...cached, capacityExceeded: true };
      }
      return cached;
    }

    const edge = candidate;
    // Bound actual candidate rows BEFORE any legacy Zod metadata traversal.
    // The full snapshot is already detached own JSON; these shallow reads do
    // not execute incoming accessors or treat a source-id string as evidence.
    const rawMeta = edge.attributes.engram_claim_v1;
    const rawSourceId =
      rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
        ? (rawMeta as Record<string, unknown>).sourceId
        : undefined;
    const preSource =
      typeof rawSourceId === 'string' && rawSourceId.length === 36
        ? view.episode(rawSourceId)
        : undefined;
    const preValue = view.entity(edge.target_node_uuid);
    const preBytes = boundedAutomaticClaimReadJsonBytes(
      { edge, subject: view.subject, value: preValue ?? null, source: preSource ?? null },
      contextByteLimit,
    );
    if (preBytes > contextByteLimit) {
      const protectedMetaBytes = boundedAutomaticClaimReadJsonBytes(
        edge.attributes.engram_extraction ?? null,
        32768,
      );
      const claimMetaBytes = boundedAutomaticClaimReadJsonBytes(rawMeta ?? null, 32768);
      const boundedMeta =
        claimMetaBytes <= 32768 ? AutomaticClaimMetadataSchema.safeParse(rawMeta) : null;
      const result: LiteralV1SemanticOverlapCandidateProjectionV1 = {
        inspectedBytes: preBytes,
        capacityExceeded: true,
        compare: () => {
          check();
          return {
            oldEdgeId: edge.uuid,
            provenance: boundedMeta?.success
              ? 'automatic_literal_v1'
              : has(edge.attributes, 'engram_claim_v1')
                ? 'unknown_protected'
                : 'manual_or_generic',
            projection: 'unavailable',
            currentReview: protectedMetaBytes <= 32768 ? currentReview(edge) : 'unknown',
            currentAuthority: 'source_unavailable',
            oldCurrentEligibility: 'unavailable',
            domain: 'unknown_domain',
            equivalent: null,
            blocksNewAcceptance: true,
            reasons: ['inspection_capacity', 'unknown_overlap_domain'],
          };
        },
      };
      candidateCache.set(edgeId, result);
      return result;
    }
    const parsedMeta = AutomaticClaimMetadataSchema.safeParse(edge.attributes.engram_claim_v1);
    const provenance = parsedMeta.success
      ? 'automatic_literal_v1'
      : has(edge.attributes, 'engram_claim_v1')
        ? 'unknown_protected'
        : 'manual_or_generic';
    const source = parsedMeta.success ? view.episode(parsedMeta.data.sourceId) : undefined;
    const rawValue = view.entity(edge.target_node_uuid);
    const value = rawValue?.group_id === view.namespace ? rawValue : undefined;
    const isCapture = source && has(source.attributes, WRITE_OWNER_V2_ATTRIBUTE);
    const projectedContext = isCapture
      ? view.projectLiteralCommitContext(edge.uuid, contextByteLimit)
      : undefined;
    const inspectedBytes =
      projectedContext?.inspectedBytes ??
      boundedAutomaticClaimReadJsonBytes(
        { edge, subject: view.subject, value: value ?? null, source: source ?? null },
        contextByteLimit,
      );
    let capacityExceeded = inspectedBytes > contextByteLimit;
    if (
      projectedContext &&
      projectedContext.result.status !== 'committed' &&
      ['context_too_large', 'proof_too_large'].includes(projectedContext.result.reason)
    ) {
      capacityExceeded = true;
    }
    const refs = new Set([
      ...edge.episodes,
      ...(extractionMetadataFromAttributes(edge.attributes)?.episode_uuids ?? []),
    ]);
    if (refs.size > 8) capacityExceeded = true;

    const unavailable = (reason: LiteralV1OverlapReason) =>
      unresolved(edge, provenance, reason, true);
    if (capacityExceeded) {
      const result: LiteralV1SemanticOverlapCandidateProjectionV1 = {
        inspectedBytes,
        capacityExceeded: true,
        compare: () => unavailable('inspection_capacity'),
      };
      candidateCache.set(edgeId, result);
      return result;
    }

    let fixedInspection: LiteralV1SemanticInspection | undefined;
    let oldMeaning: CompositionalAutomaticClaimMeaningV2 | undefined;
    let oldFacets: Set<string> | null = null;

    if (!parsedMeta.success) {
      fixedInspection = unresolved(
        edge,
        provenance,
        provenance === 'manual_or_generic' ? 'manual_overlap_unresolved' : 'invalid_v1_provenance',
      );
    } else if (!source) {
      fixedInspection = unresolved(edge, provenance, 'source_unavailable', true);
    } else {
      const evidence = validEvidence(edge, source, value, check);
      if (!evidence) {
        fixedInspection = unresolved(edge, provenance, 'invalid_v1_provenance');
      } else {
        oldMeaning = evidence.meaning;
        oldFacets = facets(oldMeaning, check);
        const review = currentReview(edge);
        let authority: LiteralV1SemanticInspection['currentAuthority'] = 'current';
        const evidenceGraph = makeEvidenceGraph(edge, source, value);
        try {
          if (hooks.assertCurrentBinding) {
            hooks.assertCurrentBinding(
              evidenceGraph,
              view.namespace,
              evidence.envelope.issuer,
              evidence.envelope.actorReference,
              evidence.envelope.bindingRef,
              check,
            );
          } else {
            view.assertBinding?.(
              view.namespace,
              evidence.envelope.issuer,
              evidence.envelope.actorReference,
              evidence.envelope.bindingRef,
              check,
            );
          }
        } catch (error) {
          if (error instanceof InspectionCapacity || error instanceof ExternalInspectionAbort)
            throw error;
          check();
          authority = 'binding_not_current';
        }
        if (
          authority === 'current' &&
          (source.review_status !== 'accepted' ||
            !['trusted', 'standard'].includes(source.trust_level) ||
            extractionMetadataFromAttributes(value?.attributes ?? {})?.review_status !==
              'accepted' ||
            (isCapture &&
              (projectedContext?.result.status !== 'committed' ||
                projectedContext.result.context.proof.descriptor.requestedTrustLevel !==
                  source.trust_level)))
        )
          authority = 'invalid';
        const eligible =
          authority === 'current' &&
          review === 'accepted' &&
          (!edge.valid_at || Date.parse(edge.valid_at) <= now) &&
          (!edge.invalid_at || Date.parse(edge.invalid_at) > now) &&
          (!edge.expired_at || Date.parse(edge.expired_at) > now) &&
          (!isCapture ||
            (projectedContext?.result.status === 'committed' &&
              projectedContext.result.context.proof.descriptor.requestedTrustLevel ===
                source.trust_level)) &&
          (isCapture
            ? projectedContext?.result.status === 'committed' &&
              validateAutomaticClaimReadContext(edge, projectedContext.result.context, check)
            : hooks.validateStoredV1
              ? hooks.validateStoredV1(evidenceGraph, edge)
              : validateAutomaticClaimEvidence(evidenceGraph, edge, check, true));
        check();
        const reasons: LiteralV1OverlapReason[] = ['not_equivalent'];
        if (authority === 'binding_not_current') reasons.push('binding_not_current');
        if (review === 'rejected') reasons.push('rejected_overlap');
        if (review === 'proposed') reasons.push('proposed_overlap');
        if (review !== 'accepted') reasons.push('current_review_not_accepted');
        if (extractionMetadataFromAttributes(value?.attributes ?? {})?.review_status !== 'accepted')
          reasons.push('current_review_not_accepted');
        if (!eligible && authority === 'invalid') reasons.push('invalid_v1_provenance');
        fixedInspection = {
          oldEdgeId: edge.uuid,
          provenance,
          projection: 'exact',
          canonicalMeaning: oldMeaning,
          currentReview: review,
          currentAuthority: authority,
          oldCurrentEligibility: eligible ? 'eligible' : 'ineligible',
          domain: 'unknown_domain',
          equivalent: false,
          blocksNewAcceptance: true,
          reasons: [...new Set(reasons)].slice(0, 8),
        };
      }
    }

    const result: LiteralV1SemanticOverlapCandidateProjectionV1 = {
      inspectedBytes,
      capacityExceeded: false,
      compare: (newMeaning) => {
        check();
        prepareMeaning(newMeaning);
        const exactInspection = fixedInspection;
        if (
          !oldMeaning ||
          !exactInspection ||
          exactInspection.projection !== 'exact' ||
          !exactInspection.canonicalMeaning
        )
          return fixedInspection!;
        const newFacets = preparedMeanings.get(newMeaning) ?? null;
        const comparison = comparePreparedFacets(oldMeaning, oldFacets, newMeaning, newFacets);
        const equivalent = comparison.equivalent;
        const domain = comparison.domain;
        const reasons: LiteralV1OverlapReason[] = [equivalent ? 'exact_meaning' : 'not_equivalent'];
        if (domain === 'proven_disjoint') reasons.push('proven_disjoint');
        if (domain === 'unknown_domain') reasons.push('unknown_overlap_domain');
        if (exactInspection.currentAuthority === 'binding_not_current')
          reasons.push('binding_not_current');
        if (exactInspection.currentReview === 'rejected' && domain !== 'proven_disjoint')
          reasons.push('rejected_overlap');
        if (exactInspection.currentReview === 'proposed' && domain !== 'proven_disjoint')
          reasons.push('proposed_overlap');
        if (exactInspection.currentReview !== 'accepted')
          reasons.push('current_review_not_accepted');
        if (extractionMetadataFromAttributes(value?.attributes ?? {})?.review_status !== 'accepted')
          reasons.push('current_review_not_accepted');
        if (
          exactInspection.oldCurrentEligibility === 'ineligible' &&
          exactInspection.currentAuthority === 'invalid'
        )
          reasons.push('invalid_v1_provenance');
        return {
          ...exactInspection,
          domain,
          equivalent,
          blocksNewAcceptance:
            domain === 'unknown_domain' ||
            (domain === 'possible_overlap' &&
              !(equivalent && exactInspection.oldCurrentEligibility === 'eligible')),
          reasons: [...new Set(reasons)].slice(0, 8),
        };
      },
    };
    candidateCache.set(edgeId, result);
    return result;
  };

  return { prepareMeaning, projectCandidate };
}

/** Private data-only projection hook for a token created by the full-root V3 index. */
export function createLiteralV1SemanticOverlapPrivateProjectorV1(
  token: CompositionalSnapshotIndexV3,
  options: { now: number; check?: () => void },
): LiteralV1SemanticOverlapPrivateProjectorV1 | null {
  const view: OwnedCompositionalSnapshotV3 | null = getOwnedCompositionalSnapshotV3(token);
  if (!view) return null;
  const check = options.check ?? (() => {});
  check();
  return createPrivateProjector(view, options.now, check);
}

/** Read-only evidence diagnostics. Results and current-old eligibility are NOT
 * accepted-ID reuse, new-source authority or a processing/storage permit. */
export function inspectLiteralV1SemanticOverlap(
  actualFullGraph: GraphData,
  request: LiteralV1SemanticOverlapRequest,
  sources: SourceHydrationBudget,
  scans: AutomaticReadBudget,
  externalCheck?: () => void,
): LiteralV1SemanticOverlapResult {
  const scope = getAutomaticClaimReadScope(sources);
  let externalFailure: { error: unknown } | undefined;
  const check = () => {
    if (externalFailure) throw new ExternalInspectionAbort();
    try {
      externalCheck?.();
    } catch (error) {
      externalFailure = { error };
      throw new ExternalInspectionAbort();
    }
    if (!canUseAutomaticClaimReadScope(scope)) throw new InspectionCapacity();
  };
  // Snapshot before Zod: its type detection may execute arbitrary JS accessors.
  const requestSnapshot = utilTypes.isProxy(request)
    ? undefined
    : snapshotBoundedCompositionalJson(request, 32768);
  const parsedRequest = LiteralV1SemanticOverlapRequestSchema.safeParse(requestSnapshot);
  if (!parsedRequest.success) throw new Error('Engram automatic overlap: invalid_request');
  const input = parsedRequest.data;
  const result: LiteralV1SemanticOverlapResult = {
    version: 1,
    descriptor: input.descriptor,
    namespace: input.namespace,
    subjectId: input.subjectId,
    status: 'complete',
    inspectedCandidateCount: 0,
    provenDisjointCount: 0,
    relevantCandidateCount: 0,
    inspections: [],
    reasons: [],
  };
  const details: LiteralV1SemanticInspection[] = [];
  const now = Date.now();
  const finish = () => {
    const parsed = LiteralV1SemanticOverlapResultSchema.parse(result);
    try {
      check();
    } catch (error) {
      if (error instanceof ExternalInspectionAbort) throw externalFailure?.error;
      if (!(error instanceof InspectionCapacity)) throw error;
      return LiteralV1SemanticOverlapResultSchema.parse({
        ...result,
        status: 'incomplete',
        reasons: ['inspection_capacity'],
      });
    }
    return parsed;
  };
  try {
    check();
    const available = getAutomaticClaimReadScopeRemaining(scope);
    if (
      !available ||
      available.attemptsRemaining < 1 ||
      available.sourceHydrationsRemaining < 4 ||
      available.contextBytesRemaining < 1 ||
      scans.remaining < 1
    )
      throw new InspectionCapacity();
    let graph: GraphData;
    try {
      graph = parseLosslessAutomaticCaptureGraph(actualFullGraph);
    } catch (error) {
      if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json')
        throw new InspectionCapacity();
      result.status = 'incomplete';
      result.reasons = ['invalid_v1_provenance'];
      return finish();
    }
    check();
    try {
      assertAutomaticBindingRegistryIntegrity(graph, check);
    } catch (error) {
      if (error instanceof InspectionCapacity || error instanceof ExternalInspectionAbort)
        throw error;
      result.status = 'incomplete';
      result.reasons = ['invalid_v1_provenance'];
      return finish();
    }
    // This is bounded in-memory preparation, NOT physical snapshot I/O. Never
    // charge these clone bytes as disk reads against snapshotBytesRemaining.
    const entities = new Map<string, GraphData['entities'][number]>();
    const episodes = new Map<string, EpisodicNode>();
    for (const records of [graph.entities, graph.episodes, graph.edges]) {
      const seen = new Set<string>();
      for (const record of records) {
        check();
        if (record.group_id !== input.namespace) continue;
        if (seen.has(record.uuid)) {
          result.status = 'incomplete';
          result.reasons = ['invalid_v1_provenance'];
          return finish();
        }
        seen.add(record.uuid);
      }
    }
    for (const entity of graph.entities) {
      check();
      if (entity.group_id === input.namespace) entities.set(entity.uuid, entity);
    }
    for (const episode of graph.episodes) {
      check();
      if (episode.group_id === input.namespace) episodes.set(episode.uuid, episode);
    }
    const subject = entities.get(input.subjectId);
    if (!subject) {
      result.status = 'incomplete';
      result.reasons = ['invalid_v1_provenance'];
      return finish();
    }
    const candidates: EntityEdge[] = [];
    for (const edge of graph.edges) {
      check();
      if (
        edge.group_id === input.namespace &&
        edge.source_node_uuid === input.subjectId &&
        (edge.name === 'PREFERS' || has(edge.attributes, 'engram_claim_v1'))
      ) {
        candidates.push(edge);
        if (candidates.length > 128) throw new InspectionCapacity();
      }
    }
    candidates.sort((a, b) => a.uuid.localeCompare(b.uuid));
    const indices = buildAutomaticClaimReadIndices(graph);
    check();
    const legacyView: PrivateProjectionView = {
      graph,
      namespace: input.namespace,
      subjectId: input.subjectId,
      subject,
      candidates,
      entity: (entityId) => entities.get(entityId),
      episode: (episodeId) => episodes.get(episodeId),
      projectLiteralCommitContext: (edgeId, maxBytes) =>
        projectAutomaticClaimReadContextWithUsage(
          graph,
          input.namespace,
          edgeId,
          indices,
          maxBytes,
        ),
    };
    const candidateProjector = createPrivateProjector(legacyView, now, check, {
      assertCurrentBinding: (evidenceGraph, namespace, issuer, actor, ref, innerCheck) =>
        assertAutomaticBindingIdentity(evidenceGraph, namespace, issuer, actor, ref, innerCheck),
      validateStoredV1: (evidenceGraph, edge) =>
        validateStoredAutomaticClaim(evidenceGraph, edge, check),
    });
    candidateProjector.prepareMeaning(input.newMeaning);
    for (const edge of candidates) {
      check();
      if (
        !Number.isInteger(scans.remaining) ||
        scans.remaining < 1 ||
        !beginAutomaticClaimReadAttempt(scope)
      )
        throw new InspectionCapacity();
      scans.remaining--;
      let inspection: LiteralV1SemanticInspection;
      try {
        const remaining = getAutomaticClaimReadScopeRemaining(scope)?.contextBytesRemaining ?? 0;
        const limit = Math.min(512 * 1024, remaining);
        const candidateProjection = candidateProjector.projectCandidate(edge.uuid, limit);
        if (!candidateProjection) throw new InspectionCapacity();
        const charged = chargeAutomaticClaimContextBytes(
          scope,
          Math.min(candidateProjection.inspectedBytes, remaining),
        );
        if (
          !charged ||
          candidateProjection.inspectedBytes > limit ||
          candidateProjection.capacityExceeded
        )
          throw new InspectionCapacity();
        inspection = candidateProjection.compare(input.newMeaning);
      } catch (error) {
        if (!(error instanceof InspectionCapacity)) throw error;
        inspection = unresolved(
          edge,
          has(edge.attributes, 'engram_claim_v1') ? 'unknown_protected' : 'manual_or_generic',
          'inspection_capacity',
          true,
        );
        result.status = 'incomplete';
        result.reasons = ['inspection_capacity'];
      }
      details.push(inspection);
      result.inspectedCandidateCount++;
      if (inspection.domain === 'proven_disjoint') result.provenDisjointCount++;
      else result.relevantCandidateCount++;
      if (result.relevantCandidateCount > 8) throw new InspectionCapacity();
      if (result.status === 'incomplete') break;
    }
    check();
  } catch (error) {
    if (error instanceof ExternalInspectionAbort) throw externalFailure?.error;
    if (!(error instanceof InspectionCapacity)) throw error;
    result.status = 'incomplete';
    result.reasons = ['inspection_capacity'];
  }
  const equivalent = details.filter((item) => item.projection === 'exact' && item.equivalent);
  if (equivalent.length > 1) {
    result.status = 'incomplete';
    result.reasons = [
      ...new Set<LiteralV1OverlapReason>([...result.reasons, 'ambiguous_existing_ids']),
    ];
    for (const item of equivalent) {
      item.blocksNewAcceptance = true;
      item.reasons = [
        ...new Set<LiteralV1OverlapReason>([...item.reasons, 'ambiguous_existing_ids']),
      ].slice(0, 8);
    }
  }
  result.inspections = [
    ...details.filter((item) => item.domain !== 'proven_disjoint'),
    ...details.filter((item) => item.domain === 'proven_disjoint'),
  ].slice(0, 8);
  const snapshot = snapshotBoundedCompositionalJson(result, 32768);
  if (snapshot === undefined) {
    result.status = 'incomplete';
    result.reasons = ['inspection_capacity'];
    result.inspections = [];
  }
  return finish();
}
