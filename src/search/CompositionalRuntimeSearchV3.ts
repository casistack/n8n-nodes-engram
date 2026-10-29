import { z } from 'zod';
import { types as utilTypes } from 'util';
import {
  CompositionalRuntimeSearchHitV3Schema as hitSchema,
  CompositionalRuntimeSearchFiltersV3Schema as filterSchema,
  CompositionalRuntimeSearchViewV3Schema as viewSchema,
} from '../schemas/CompositionalRuntimeSearchV3.schema';
import { extractionMetadataFromAttributes } from '../schemas/ExtractionMetadata.schema';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import type {
  GovernedEdgeSearchResult,
  GovernedResult,
  RetrievalFilters,
  FactProvenance,
} from './RetrievalGovernance';
import {
  getCompositionalRuntimeCandidateDataV3,
  isLiveCompositionalRuntimeReaderV3,
  readCompositionalRuntimeFactsV3,
} from './CompositionalRuntimeReaderV3';

type Registration = { reader: unknown; hash: string; lexical: string };
const qualifiedHits = new WeakMap<object, Registration>();
/** Closed code-owned filter normalization; known absent optional fields retain their existing semantics. */
export function snapshotCompositionalRuntimeFiltersV3(
  reader: unknown,
  raw: unknown,
): z.infer<typeof filterSchema> | null {
  if (
    !isLiveCompositionalRuntimeReaderV3(reader) ||
    !raw ||
    typeof raw !== 'object' ||
    utilTypes.isProxy(raw) ||
    Array.isArray(raw)
  )
    return null;
  try {
    const keys = Reflect.ownKeys(raw);
    if (keys.length > 9) return null;
    const data: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(filterSchema.shape, key))
        return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      if (descriptor.value !== undefined) data[key] = descriptor.value;
    }
    const parsed = filterSchema.safeParse(cloneBoundedAutomaticCaptureJson(data, 'beginRequest'));
    return parsed.success && isLiveCompositionalRuntimeReaderV3(reader) ? parsed.data : null;
  } catch (error) {
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return null;
    return null;
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function rowHash(
  hit: Pick<GovernedEdgeSearchResult, 'edge' | 'sourceEntity' | 'targetEntity'>,
): string {
  return hashAutomaticCaptureV2({
    edge: hit.edge,
    subject: hit.sourceEntity,
    value: hit.targetEntity,
  });
}
/** Only fixed qualification below registers a FINAL hit. Parsed metadata cannot install hints. */
export function getCompositionalRuntimeLexicalHintV3(hit: unknown): string | null {
  if (!hit || typeof hit !== 'object' || utilTypes.isProxy(hit)) return null;
  const saved = qualifiedHits.get(hit);
  if (!saved || !isLiveCompositionalRuntimeReaderV3(saved.reader)) return null;
  const actual = hit as GovernedEdgeSearchResult;
  if (rowHash(actual) !== saved.hash) return null;
  return isLiveCompositionalRuntimeReaderV3(saved.reader) ? saved.lexical : null;
}
/** Qualifies actual complete rows and provenance before publishing immutable governed hits. */
export function governCompositionalRuntimeEdgesV3(
  reader: unknown,
  hits: unknown,
  filters: unknown = {},
  view: unknown = { mode: 'current' },
): GovernedResult<GovernedEdgeSearchResult> {
  const empty: GovernedResult<GovernedEdgeSearchResult> = { results: [], decisions: [] };
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
  const ownedFilters = snapshotCompositionalRuntimeFiltersV3(reader, filters);
  if (ownedFilters === null) return empty;
  let owned: unknown;
  try {
    owned = cloneBoundedAutomaticCaptureJson({ hits, filters: ownedFilters, view }, 'beginRequest');
  } catch {
    return empty;
  }
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
  const request = z
    .object({ hits: z.array(hitSchema).max(200), filters: filterSchema, view: viewSchema })
    .strict()
    .safeParse(owned);
  if (!request.success) return empty;
  const parsed = request.data;
  const original = (owned as { hits: GovernedEdgeSearchResult[] }).hits;
  for (let index = 0; index < parsed.hits.length; index++) {
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
    if (rowHash(original[index]) !== rowHash(parsed.hits[index])) return empty;
  }
  const decisions: GovernedResult<GovernedEdgeSearchResult>['decisions'] = [];
  const results: GovernedEdgeSearchResult[] = [];
  const registrations: Array<{ hit: GovernedEdgeSearchResult; hash: string; lexical: string }> = [];
  const reject = (hit: z.infer<typeof hitSchema>, reason: string) =>
    decisions.push({
      candidate_id: hit.edge.uuid,
      candidate_type: 'fact',
      score: hit.score,
      included: false,
      reasons: [reason],
    });
  if (parsed.view.mode !== 'current') {
    for (const hit of parsed.hits) reject(hit, 'compositional_historical_unsupported');
    return { results, decisions };
  }
  const ids = [...new Set(parsed.hits.map((hit) => hit.edge.uuid))];
  const read = readCompositionalRuntimeFactsV3(reader, ids);
  if (read.status !== 'data') {
    for (const hit of parsed.hits) reject(hit, 'compositional_read_deferred');
    return { results, decisions };
  }
  const entries = new Map(read.entries.map((entry) => [entry.edgeId, entry]));
  for (const hit of parsed.hits) {
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
    const entry = entries.get(hit.edge.uuid),
      actual = getCompositionalRuntimeCandidateDataV3(reader, hit.edge.uuid);
    if (
      entry?.status !== 'qualified_current_data' ||
      actual.status !== 'candidate_data' ||
      rowHash(hit) !==
        hashAutomaticCaptureV2({ edge: actual.edge, subject: actual.subject, value: actual.value })
    ) {
      reject(hit, 'compositional_claim_authority');
      continue;
    }
    const p = entry.provenance,
      f: RetrievalFilters = parsed.filters;
    if (f.review_statuses?.length && !f.review_statuses.includes('accepted')) {
      reject(hit, 'review_status_filtered');
      continue;
    }
    if (
      (f.sender_id && p.senderId !== f.sender_id) ||
      (f.episode_kind && p.episodeKind !== f.episode_kind) ||
      (f.trust_level && p.sourceTrust !== f.trust_level) ||
      (f.source_workflow_id && p.sourceWorkflowId !== f.source_workflow_id) ||
      (f.source_execution_id && p.sourceExecutionId !== f.source_execution_id) ||
      (f.reference_after && (!p.referenceTime || p.referenceTime < f.reference_after)) ||
      (f.reference_before && (!p.referenceTime || p.referenceTime > f.reference_before))
    ) {
      reject(hit, 'no_source_episode_matched_filters');
      continue;
    }
    const provenance: FactProvenance = {
      source_episode_uuid: p.sourceId,
      source_message_id: p.sourceMessageId,
      conversation_id: p.conversationId,
      speaker_role: 'human',
      sender_id: p.senderId,
      sender_name: p.senderName,
      episode_kind: p.episodeKind,
      reference_time: p.referenceTime,
      trust_level: p.sourceTrust,
      episode_review_status: 'accepted',
      source_workflow_id: p.sourceWorkflowId,
      source_execution_id: p.sourceExecutionId,
      fact_confidence: extractionMetadataFromAttributes(actual.edge.attributes)?.confidence ?? null,
      fact_review_status: 'accepted',
      creation_review_status: p.creationReview,
      creation_operation_uuid: p.operationId,
      creation_committed_at: p.terminalAt,
    };
    const final = freeze({
      ...hit,
      edge: actual.edge,
      sourceEntity: actual.subject,
      targetEntity: actual.value,
      provenance: [provenance],
    });
    const hash = rowHash(final);
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
    registrations.push({ hit: final, hash, lexical: entry.lexicalForm });
    results.push(final);
    decisions.push({
      candidate_id: hit.edge.uuid,
      candidate_type: 'fact',
      score: hit.score,
      included: true,
      reasons: ['included'],
    });
  }
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
  if (Buffer.byteLength(JSON.stringify({ results, decisions }), 'utf8') > 512 * 1024) return empty;
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
  for (const registration of registrations) {
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
    qualifiedHits.set(registration.hit, {
      reader,
      hash: registration.hash,
      lexical: registration.lexical,
    });
  }
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
  return { results, decisions };
}
