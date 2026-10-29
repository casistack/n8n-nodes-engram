import { z } from 'zod';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import {
  CompositionalClaimReviewPairV3Schema,
  CompositionalClaimReviewRequestV3Schema,
  CompositionalClaimReviewBackendContextV3Schema,
  type CompositionalClaimReviewBackendContextV3,
  type CompositionalClaimReviewPreparationV3,
} from '../schemas/CompositionalClaimReviewV3.schema';
import {
  ExtractionMetadataV2Schema,
  reviewExtractionMetadata,
} from '../schemas/ExtractionMetadata.schema';
import { validateCompositionalQualifiedClaimReadV3 } from '../extraction/CompositionalQualifiedClaimReadV3';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';

/** Optimistic data guard only; no hash authenticates storage or an operator. */
export function compositionalClaimReviewPairHashV3(value: unknown): string {
  const input = cloneBoundedAutomaticCaptureJson(value, 'beginRequest');
  const pair = CompositionalClaimReviewPairV3Schema.parse(input);
  if (canonicalAutomaticCaptureV2(input) !== canonicalAutomaticCaptureV2(pair))
    throw new Error('Engram compositional review: invalid_pair');
  return hashAutomaticCaptureV2({ domain: 'engram-compositional-review-pair-v3', ...pair });
}

/** Pure candidate preparation. Actual backend coordination/persistence is separate. */
export function prepareCompositionalClaimReviewV3(
  graphValue: unknown,
  requestValue: unknown,
  backend: CompositionalClaimReviewBackendContextV3,
  check: () => void = () => {},
): CompositionalClaimReviewPreparationV3 {
  const decision = (
    reason: Extract<CompositionalClaimReviewPreparationV3, { kind: 'decision' }>['reason'],
  ): CompositionalClaimReviewPreparationV3 => ({ kind: 'decision', reason });
  check();
  let request: z.infer<typeof CompositionalClaimReviewRequestV3Schema>;
  try {
    request = CompositionalClaimReviewRequestV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(requestValue, 'beginRequest'),
    );
  } catch {
    return decision('invalid_input');
  }
  let context: CompositionalClaimReviewBackendContextV3;
  try {
    context = CompositionalClaimReviewBackendContextV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(backend, 'beginRequest'),
    );
  } catch {
    return decision('backend_clock_invalid');
  }
  const { backendNow, storeHash } = context;
  if (new Date(backendNow).toISOString() !== backendNow) return decision('backend_clock_invalid');
  let graph: ReturnType<typeof parseLosslessAutomaticCaptureGraph>;
  try {
    graph = parseLosslessAutomaticCaptureGraph(graphValue);
  } catch {
    return decision('invalid_claim');
  }
  check();
  // Diagnose clock regression independently of the reader's current-time
  // eligibility checks, which intentionally reject future manual reviews.
  const currentEdge = graph.edges.find(
    (row) => row.uuid === request.edgeId && row.group_id === request.namespace,
  );
  const currentValue = graph.entities.find(
    (row) => row.uuid === currentEdge?.target_node_uuid && row.group_id === request.namespace,
  );
  for (const row of [currentEdge, currentValue]) {
    check();
    if (!row) continue;
    const metadata = ExtractionMetadataV2Schema.safeParse(row.attributes.engram_extraction);
    for (const time of [row.updated_at, metadata.success ? metadata.data.reviewed_at : null]) {
      if (time !== null && Date.parse(time) > Date.parse(backendNow))
        return decision('backend_clock_invalid');
    }
  }
  for (const op of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (
      op.version !== 3 ||
      op.state !== 'committed' ||
      op.identity.namespace !== request.namespace ||
      op.identity.sourceId !== currentEdge?.episodes[0]
    )
      continue;
    if (
      Date.parse(op.lastObservedAt) > Date.parse(backendNow) ||
      Date.parse(op.terminalReceipt.terminalAt) > Date.parse(backendNow)
    )
      return decision('backend_clock_invalid');
  }
  const read = validateCompositionalQualifiedClaimReadV3(
    graph,
    { namespace: request.namespace, edgeId: request.edgeId, now: backendNow },
    check,
  );
  if (read.status !== 'valid_data') return decision('invalid_claim');
  const { edge, value, proof } = read.context;
  if (proof.identity.storeHash !== storeHash) return decision('invalid_claim');
  const pair = { namespace: request.namespace, edge, value };
  if (compositionalClaimReviewPairHashV3(pair) !== request.expectedPairHash)
    return decision('conflict');
  const operation = graph.automatic_operations_v1?.operations.find(
    (op) => op.operationId === proof.operationId,
  );
  if (!operation || operation.version !== 3) return decision('invalid_claim');
  const meta = ExtractionMetadataV2Schema.parse(edge.attributes.engram_extraction);
  const valueMeta = ExtractionMetadataV2Schema.parse(value.attributes.engram_extraction);
  const nowMs = Date.parse(backendNow);
  for (const time of [
    proof.terminalReceipt.terminalAt,
    operation.lastObservedAt,
    edge.updated_at,
    value.updated_at,
    meta.reviewed_at,
    valueMeta.reviewed_at,
  ]) {
    check();
    if (time !== null && (!Number.isFinite(Date.parse(time)) || Date.parse(time) > nowMs))
      return decision('backend_clock_invalid');
  }
  if (
    meta.threshold_decision === 'manually_reviewed' &&
    meta.review_status === request.reviewStatus &&
    meta.reviewed_by === request.reviewedBy
  )
    return { kind: 'unchanged', pair };
  const updated = {
    namespace: request.namespace,
    edge: {
      ...edge,
      updated_at: backendNow,
      attributes: {
        ...edge.attributes,
        engram_extraction: reviewExtractionMetadata(
          meta,
          request.reviewStatus,
          request.reviewedBy,
          backendNow,
        ),
      },
    },
    value: {
      ...value,
      updated_at: backendNow,
      attributes: {
        ...value.attributes,
        engram_extraction: reviewExtractionMetadata(
          valueMeta,
          request.reviewStatus,
          request.reviewedBy,
          backendNow,
        ),
      },
    },
  };
  check();
  return { kind: 'prepared_review', pair: updated };
}
