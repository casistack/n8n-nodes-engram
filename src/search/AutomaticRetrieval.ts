import type { IGraphStorage } from '../storage/IGraphStorage';
import type { EntityEdge, EntityNode, EpisodicNode, GraphData } from '../schemas';
import { extractionMetadataFromAttributes } from '../schemas';
import { EntityEdgeSchema } from '../schemas/EntityEdge.schema';
import {
  AutomaticClaimMetadataSchema,
  type AutomaticClaimMetadata,
} from '../schemas/AutomaticClaim.schema';
import {
  validateAutomaticClaimReadContext,
  validateStoredAutomaticClaim,
} from '../extraction/AutomaticClaims';
import { boundedAutomaticClaimReadJsonBytes } from '../extraction/AutomaticClaimCommitProof';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import {
  AutomaticClaimReadResultSchema,
  type AutomaticClaimReadContext,
  type AutomaticClaimReadResult,
} from '../schemas/AutomaticClaimRead.schema';
import {
  canUseAutomaticClaimReadScope,
  getAutomaticClaimReadScope,
} from '../storage/AutomaticClaimReadScope';
import type { AutomaticClaimReadScope } from '../storage/AutomaticClaimReadScope';
import { WRITE_OWNER_V2_ATTRIBUTE } from '../storage/AutomaticIdentity';
import type {
  AutomaticReadBudget,
  AutomaticReadContext,
  AutomaticClaimView,
} from '../schemas/AutomaticRuntime.schema';
import { AutomaticReadContextSchema } from '../schemas/AutomaticRuntime.schema';
import type { CompositionalRuntimeReaderV3 } from '../schemas/CompositionalRuntimeReaderV3.schema';
import {
  getCompositionalRuntimeCandidateDataV3,
  getCompositionalRuntimeLiteralDataV3,
  isLiveCompositionalRuntimeReaderV3,
} from './CompositionalRuntimeReaderV3';
import { canonical } from '../extraction/QueueState';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const runtimeVisibilityCache = new WeakMap<
  object,
  WeakMap<object, Map<string, AutomaticClaimView>>
>();

type AutomaticClaimContextReader = {
  readAutomaticClaimContext?: (
    groupId: string,
    edgeId: string,
    scope: AutomaticClaimReadScope,
  ) => Promise<AutomaticClaimReadResult>;
};

function visibleAtRequestedTime(
  edge: EntityEdge,
  view: Pick<AutomaticReadContext, 'mode' | 'at'> | undefined,
  commitAt?: string,
): boolean {
  if (view?.mode !== 'asOf') return true;
  if (
    !view.at ||
    !Number.isFinite(Date.parse(view.at)) ||
    Date.parse(edge.created_at) > Date.parse(view.at) ||
    (commitAt !== undefined && Date.parse(commitAt) > Date.parse(view.at))
  ) {
    return false;
  }
  return true;
}

function currentReviewAccepted(edge: EntityEdge, value: Pick<EntityNode, 'attributes'>): boolean {
  return (
    extractionMetadataFromAttributes(edge.attributes)?.review_status === 'accepted' &&
    extractionMetadataFromAttributes(value.attributes)?.review_status === 'accepted'
  );
}

function opposingClaimMetadata(
  candidateUuid: string,
  polarity: string,
  other: EntityEdge,
): AutomaticClaimMetadata | null {
  if (
    other.uuid === candidateUuid ||
    extractionMetadataFromAttributes(other.attributes)?.review_status === 'rejected'
  ) {
    return null;
  }
  const parsed = AutomaticClaimMetadataSchema.safeParse(other.attributes.engram_claim_v1);
  if (!parsed.success || parsed.data.claim.polarity === polarity) return null;
  return parsed.data;
}

function runtimeEdgeMatches(candidate: EntityEdge, actual: EntityEdge): boolean {
  if (boundedAutomaticClaimReadJsonBytes(candidate, 512 * 1024) > 512 * 1024) return false;
  const parsed = EntityEdgeSchema.safeParse(candidate);
  return parsed.success && canonical(candidate) === canonical(actual);
}

function actualRowsGraph(data: {
  edge: EntityEdge;
  subject: EntityNode;
  value: EntityNode;
  source: EpisodicNode;
}): GraphData {
  return {
    version: '2.0',
    exported_at: data.source.created_at,
    group_id: data.edge.group_id,
    entities: [data.subject, data.value],
    episodes: [data.source],
    edges: [data.edge],
  };
}

function proofContextMatchesRows(
  context: AutomaticClaimReadContext,
  data: {
    edge: EntityEdge;
    subject: EntityNode;
    value: EntityNode;
    source: EpisodicNode;
  },
): boolean {
  return (
    canonical(context.edge) === canonical(data.edge) &&
    canonical(context.subject) === canonical(data.subject) &&
    canonical(context.value) === canonical(data.value) &&
    canonical(context.source) === canonical(data.source)
  );
}

function runtimeVisibilityKey(
  edgeId: string,
  view: Pick<AutomaticReadContext, 'mode' | 'at'> | undefined,
): string | null {
  const mode = view?.mode ?? 'current';
  if (!['current', 'historical', 'asOf'].includes(mode)) return null;
  const at = mode === 'asOf' ? (view?.at ?? '') : '';
  if (at.length > 64) return null;
  return JSON.stringify([edgeId, mode, at]);
}

function cachedRuntimeVisibility(
  reader: CompositionalRuntimeReaderV3,
  scans: AutomaticReadBudget,
  key: string | null,
): AutomaticClaimView | undefined {
  if (key === null) return undefined;
  return runtimeVisibilityCache
    .get(reader as object)
    ?.get(scans as object)
    ?.get(key);
}

function rememberRuntimeVisibility(
  reader: CompositionalRuntimeReaderV3,
  scans: AutomaticReadBudget,
  key: string | null,
  result: AutomaticClaimView,
): void {
  if (key === null) return;
  let byScans = runtimeVisibilityCache.get(reader as object);
  if (!byScans) {
    byScans = new WeakMap();
    runtimeVisibilityCache.set(reader as object, byScans);
  }
  let byQuery = byScans.get(scans as object);
  if (!byQuery) {
    byQuery = new Map();
    byScans.set(scans as object, byQuery);
  }
  if (byQuery.has(key) || byQuery.size < 128) byQuery.set(key, result);
}

async function readV2Context(
  storage: IGraphStorage,
  edge: EntityEdge,
  budget: SourceHydrationBudget,
  historicalEvidence = false,
): Promise<AutomaticClaimReadContext | 'uncommitted' | null> {
  const reader = (storage as IGraphStorage & AutomaticClaimContextReader).readAutomaticClaimContext;
  if (!reader) {
    budget.deferred++;
    return null;
  }
  const scope = getAutomaticClaimReadScope(budget);
  if (!canUseAutomaticClaimReadScope(scope)) {
    budget.deferred++;
    return null;
  }
  let result: unknown;
  try {
    result = await reader.call(storage, edge.group_id, edge.uuid, scope);
  } catch {
    budget.deferred++;
    return null;
  }
  if (!canUseAutomaticClaimReadScope(scope)) {
    budget.deferred++;
    return null;
  }
  if (boundedAutomaticClaimReadJsonBytes(result, 512 * 1024 + 256) > 512 * 1024 + 256) {
    budget.deferred++;
    return null;
  }
  const parsed = AutomaticClaimReadResultSchema.safeParse(result);
  if (!canUseAutomaticClaimReadScope(scope)) {
    budget.deferred++;
    return null;
  }
  if (
    parsed.success &&
    parsed.data.status === 'uncommitted' &&
    ['missing_operation', 'capture_not_committed'].includes(parsed.data.reason)
  ) {
    return 'uncommitted';
  }
  if (!parsed.success || parsed.data.status !== 'committed') {
    budget.deferred++;
    return null;
  }
  if (
    !validateAutomaticClaimReadContext(edge, parsed.data.context, undefined, historicalEvidence)
  ) {
    budget.deferred++;
    return null;
  }
  if (!canUseAutomaticClaimReadScope(scope)) {
    budget.deferred++;
    return null;
  }
  return parsed.data.context;
}

/** Also used when writers roll back to Existing/Custom on this binary. */
export async function automaticClaimVisible(
  storage: IGraphStorage,
  edge: EntityEdge,
  budget: SourceHydrationBudget,
  scans: AutomaticReadBudget,
  view?: Pick<AutomaticReadContext, 'mode' | 'at'>,
): Promise<AutomaticClaimView> {
  if (edge.attributes.engram_claim_v1 === undefined) return 'current';
  const parsed = AutomaticClaimMetadataSchema.safeParse(edge.attributes.engram_claim_v1);
  if (!parsed.success || budget.remaining < 3) {
    budget.deferred++;
    return 'hidden';
  }
  const claim = parsed.data;
  budget.remaining -= 3;
  const [subject, value, source] = await Promise.all([
    storage.getEntity(edge.source_node_uuid),
    storage.getEntity(edge.target_node_uuid),
    storage.getEpisode(claim.sourceId),
  ]);
  if (!subject || !value || !source) return 'hidden';
  const isV2Capture = Object.prototype.hasOwnProperty.call(
    source.attributes,
    WRITE_OWNER_V2_ATTRIBUTE,
  );
  const historicalEvidence = view?.mode === 'historical' || view?.mode === 'asOf';
  let trustedContext: AutomaticClaimReadContext | null = null;
  if (isV2Capture) {
    const context = await readV2Context(storage, edge, budget, historicalEvidence);
    if (context === 'uncommitted') {
      budget.deferred++;
      return 'hidden';
    }
    trustedContext = context;
    if (!trustedContext) return 'hidden';
  }
  const actualSubject = trustedContext?.subject ?? subject;
  const actualValue = trustedContext?.value ?? value;
  const actualSource = trustedContext?.source ?? source;
  const graph: GraphData = {
    version: '2.0',
    exported_at: new Date().toISOString(),
    group_id: edge.group_id,
    entities: [actualSubject, actualValue],
    episodes: [actualSource],
    edges: [edge],
  };
  if (view?.mode === 'historical' || view?.mode === 'asOf') {
    if (!visibleAtRequestedTime(edge, view, trustedContext?.proof.terminalReceipt.terminalAt))
      return 'hidden';
    return trustedContext || validateStoredAutomaticClaim(graph, edge, undefined, true)
      ? 'historical_record'
      : 'hidden';
  }
  if (!currentReviewAccepted(edge, actualValue)) return 'hidden';
  if (!trustedContext && !validateStoredAutomaticClaim(graph, edge)) return 'hidden';
  if (scans.remaining < 1) {
    budget.deferred++;
    return 'hidden';
  }
  const related = await storage.getEdgesBetween(
    edge.source_node_uuid,
    edge.target_node_uuid,
    scans.remaining + 1,
  );
  if (related.length > scans.remaining) {
    scans.remaining = 0;
    budget.deferred++;
    return 'hidden';
  }
  scans.remaining -= related.length;
  let references = 0;
  for (const other of related) {
    const otherClaim = opposingClaimMetadata(edge.uuid, claim.claim.polarity, other);
    if (!otherClaim) continue;
    if (++references > 8 || budget.remaining < 1) {
      budget.deferred++;
      return 'hidden';
    }
    budget.remaining--;
    const otherSource = await storage.getEpisode(otherClaim.sourceId);
    if (!otherSource) continue;
    if (Object.prototype.hasOwnProperty.call(otherSource.attributes, WRITE_OWNER_V2_ATTRIBUTE)) {
      const otherContext = await readV2Context(storage, other, budget);
      if (otherContext === 'uncommitted') continue;
      if (!otherContext) return 'hidden';
      return 'hidden';
    }
    if (
      validateStoredAutomaticClaim(
        { ...graph, episodes: [actualSource, otherSource], edges: [edge, other] },
        other,
      )
    )
      return 'hidden';
  }
  return 'current';
}

/**
 * Actual-origin V1 literal visibility for the runtime adapter. Its opaque reader
 * supplies every row and proof from the already-owned root; this function never
 * accepts a storage facade or caller-created proof context.
 */
export function automaticClaimVisibleForCompositionalRuntimeV3(
  reader: CompositionalRuntimeReaderV3,
  edge: EntityEdge,
  scans: AutomaticReadBudget,
  view?: Pick<AutomaticReadContext, 'mode' | 'at'>,
): AutomaticClaimView {
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
  let cacheKey: string | null = null;
  const finish = (result: AutomaticClaimView): AutomaticClaimView => {
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
    rememberRuntimeVisibility(reader, scans, cacheKey, result);
    return result;
  };
  let ownedView: Pick<AutomaticReadContext, 'mode' | 'at'> | undefined;
  let ownedEdge: unknown;
  try {
    ownedEdge = cloneBoundedAutomaticCaptureJson(edge, 'beginRequest');
    if (view !== undefined)
      ownedView = cloneBoundedAutomaticCaptureJson(view, 'beginRequest') as Pick<
        AutomaticReadContext,
        'mode' | 'at'
      >;
  } catch {
    return finish('hidden');
  }
  if (
    ownedView !== undefined &&
    !AutomaticReadContextSchema.pick({ mode: true, at: true }).strict().safeParse(ownedView).success
  )
    return finish('hidden');
  const parsedEdge = EntityEdgeSchema.safeParse(ownedEdge);
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
  if (!parsedEdge.success || canonical(ownedEdge) !== canonical(parsedEdge.data))
    return finish('hidden');
  const supplied = parsedEdge.data;
  const candidate = getCompositionalRuntimeCandidateDataV3(reader, supplied.uuid);
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
  if (candidate.status !== 'candidate_data' || !runtimeEdgeMatches(supplied, candidate.edge))
    return finish('hidden');
  cacheKey = runtimeVisibilityKey(supplied.uuid, ownedView);
  const cached = cachedRuntimeVisibility(reader, scans, cacheKey);
  if (cached !== undefined) return finish(cached);
  if (supplied.attributes.engram_claim_v1 === undefined) {
    return finish('current');
  }
  const claimResult = AutomaticClaimMetadataSchema.safeParse(supplied.attributes.engram_claim_v1);
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
  if (!claimResult.success) return finish('hidden');

  const dataResult = getCompositionalRuntimeLiteralDataV3(reader, supplied.uuid);
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
  if (dataResult.status !== 'literal_data') return finish('hidden');
  if (!runtimeEdgeMatches(supplied, dataResult.edge)) return finish('hidden');
  const claim = AutomaticClaimMetadataSchema.safeParse(dataResult.edge.attributes.engram_claim_v1);
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
  if (!claim.success) return finish('hidden');

  const isV2Capture = Object.prototype.hasOwnProperty.call(
    dataResult.source.attributes,
    WRITE_OWNER_V2_ATTRIBUTE,
  );
  const historicalEvidence = ownedView?.mode === 'historical' || ownedView?.mode === 'asOf';
  let trustedContext: AutomaticClaimReadContext | null = null;
  if (isV2Capture) {
    if (dataResult.proof.status !== 'committed') return finish('hidden');
    if (!proofContextMatchesRows(dataResult.proof.context, dataResult)) return finish('hidden');
    const valid = validateAutomaticClaimReadContext(
      dataResult.edge,
      dataResult.proof.context,
      undefined,
      historicalEvidence,
    );
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
    if (!valid) return finish('hidden');
    trustedContext = dataResult.proof.context;
  } else {
    const valid = validateStoredAutomaticClaim(
      actualRowsGraph(dataResult),
      dataResult.edge,
      undefined,
      historicalEvidence,
    );
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
    if (!valid) return finish('hidden');
  }

  if (ownedView?.mode === 'historical' || ownedView?.mode === 'asOf') {
    if (
      !visibleAtRequestedTime(
        dataResult.edge,
        ownedView,
        trustedContext?.proof.terminalReceipt.terminalAt,
      )
    )
      return finish('hidden');
    return finish('historical_record');
  }

  if (!currentReviewAccepted(dataResult.edge, dataResult.value)) return finish('hidden');
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
  if (scans.remaining < 1) return finish('hidden');
  const related = dataResult.related;
  if (related.length > scans.remaining) {
    scans.remaining = 0;
    return finish('hidden');
  }
  scans.remaining -= related.length;
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';

  let references = 0;
  for (const other of related) {
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
    const otherClaim = opposingClaimMetadata(
      dataResult.edge.uuid,
      claim.data.claim.polarity,
      other,
    );
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
    if (!otherClaim) continue;
    if (++references > 8) return finish('hidden');

    const otherResult = getCompositionalRuntimeLiteralDataV3(reader, other.uuid);
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
    if (otherResult.status !== 'literal_data' || !runtimeEdgeMatches(other, otherResult.edge))
      return finish('hidden');
    const otherMetadata = AutomaticClaimMetadataSchema.safeParse(
      otherResult.edge.attributes.engram_claim_v1,
    );
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
    if (!otherMetadata.success) return finish('hidden');
    const otherIsV2Capture = Object.prototype.hasOwnProperty.call(
      otherResult.source.attributes,
      WRITE_OWNER_V2_ATTRIBUTE,
    );
    if (otherIsV2Capture) {
      if (
        otherResult.proof.status === 'uncommitted' &&
        ['missing_operation', 'capture_not_committed'].includes(otherResult.proof.reason)
      )
        continue;
      if (otherResult.proof.status !== 'committed') return finish('hidden');
      if (
        !proofContextMatchesRows(otherResult.proof.context, otherResult) ||
        !validateAutomaticClaimReadContext(
          otherResult.edge,
          otherResult.proof.context,
          undefined,
          false,
        )
      ) {
        if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
        return finish('hidden');
      }
      if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
      return finish('hidden');
    }
    const valid = validateStoredAutomaticClaim(actualRowsGraph(otherResult), otherResult.edge);
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return 'hidden';
    if (valid) return finish('hidden');
  }
  return finish('current');
}
