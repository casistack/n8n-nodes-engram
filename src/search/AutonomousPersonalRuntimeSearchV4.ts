import { types as utilTypes } from 'util';
import { z } from 'zod';
import { boundedAutomaticClaimReadJsonBytes } from '../extraction/AutomaticClaimCommitProof';
import type { PrivateAutonomousPersonalMemoryParentReaderV4 } from '../memory/AutonomousPersonalMemoryParentReaderV4';
import {
  isLiveAutonomousPersonalMemoryParentReaderV4,
  readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4,
} from '../memory/AutonomousPersonalMemoryParentReaderV4';
import type { CompositionalRuntimeReaderV3 } from '../schemas/CompositionalRuntimeReaderV3.schema';
import {
  CompositionalRuntimeSearchFiltersV3Schema,
  CompositionalRuntimeSearchHitV3Schema,
  CompositionalRuntimeSearchViewV3Schema,
} from '../schemas/CompositionalRuntimeSearchV3.schema';
import { AutonomousPersonalClaimV3OwnedDataSchema } from '../schemas/AutonomousPersonalClaimV3.schema';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema,
  type AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data,
} from '../schemas/AutonomousPersonalMemoryParentQualifiedClaimCandidateV4.schema';
import {
  AutonomousPersonalRuntimeDisplayV4OwnedDataSchema,
  AutonomousPersonalRuntimeGovernedHitV4OwnedDataSchema,
  AutonomousPersonalRuntimeSearchDecisionV4OwnedDataSchema,
  AutonomousPersonalRuntimeSearchResultV4OwnedDataSchema,
  type AutonomousPersonalRuntimeDisplayV4,
  type AutonomousPersonalRuntimeGovernedHitV4,
  type AutonomousPersonalRuntimeSearchDecisionV4,
  type AutonomousPersonalRuntimeSearchResultV4,
} from '../schemas/AutonomousPersonalRuntimeSearchV4.schema';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  isNativePlainAutomaticCaptureObject,
  cloneBoundedAutomaticCaptureJson,
} from '../storage/BoundedAutomaticCaptureJson';
import { isCompositionalCompatibilityRuntimeReaderV4 } from './CompositionalRuntimeReaderV3';

const MAX_HITS = 200;
const MAX_TRIPLE_BYTES = 512 * 1024;
const MAX_TOTAL_TRIPLE_BYTES = 8 * 1024 * 1024;
const STOPPED = Symbol('autonomous_personal_runtime_search_stopped');

type RankedHit = z.infer<typeof CompositionalRuntimeSearchHitV3Schema>;
type Triple = {
  edge: RankedHit['edge'];
  subject: RankedHit['sourceEntity'];
  value: RankedHit['targetEntity'];
};
type PreparedHit = {
  readonly hit: RankedHit;
  readonly triple: Triple;
  readonly rowHash: string;
  readonly claim: z.infer<typeof AutonomousPersonalClaimV3OwnedDataSchema> | null;
  readonly claimTagIsV3: boolean;
};
type Registration = {
  readonly owner: IGraphStorage;
  readonly parent: PrivateAutonomousPersonalMemoryParentReaderV4;
  readonly compatibilityReader: CompositionalRuntimeReaderV3;
  readonly rowHash: string;
  readonly display: AutonomousPersonalRuntimeDisplayV4;
};

const displays = new WeakMap<object, Registration>();
const parentCandidates = new WeakMap<
  object,
  WeakMap<object, Map<string, ParentCandidate | null>>
>();
type ParentCandidate = AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data;

function freezeOwned<T>(value: T, check: () => void): T {
  check();
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeOwned(child, check);
    Object.freeze(value);
  }
  check();
  return value;
}

function live(
  owner: IGraphStorage,
  parent: PrivateAutonomousPersonalMemoryParentReaderV4,
  compatibilityReader: unknown,
): compatibilityReader is CompositionalRuntimeReaderV3 {
  // Fixed identity joins are deliberately checked before any caller DATA is inspected.
  if (!isCompositionalCompatibilityRuntimeReaderV4(owner, parent, compatibilityReader))
    return false;
  return isLiveAutonomousPersonalMemoryParentReaderV4(owner, parent);
}

function freezeWithLiveReaders<T>(
  value: T,
  owner: IGraphStorage,
  parent: PrivateAutonomousPersonalMemoryParentReaderV4,
  compatibilityReader: CompositionalRuntimeReaderV3,
): T | null {
  try {
    return freezeOwned(value, () => {
      if (!live(owner, parent, compatibilityReader)) throw STOPPED;
    });
  } catch (error) {
    if (error === STOPPED) return null;
    throw error;
  }
}

function ownDenseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return null;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDescriptor ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_HITS
    ) {
      return null;
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) return null;
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      items.push(descriptor.value);
    }
    for (const key of keys) {
      if (key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)))
        return null;
    }
    return items;
  } catch {
    return null;
  }
}

function ownHitFields(value: unknown): {
  readonly edge: unknown;
  readonly sourceEntity: unknown;
  readonly targetEntity: unknown;
  readonly score: unknown;
  readonly hasMatchEvidence: boolean;
  readonly matchEvidence?: unknown;
} | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  ) {
    return null;
  }
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < 4 ||
      keys.length > 5 ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !['edge', 'sourceEntity', 'targetEntity', 'score', 'match_evidence'].includes(key),
      )
    ) {
      return null;
    }
    const own = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      own.set(key, descriptor.value);
    }
    if (
      !own.has('edge') ||
      !own.has('sourceEntity') ||
      !own.has('targetEntity') ||
      !own.has('score')
    ) {
      return null;
    }
    return {
      edge: own.get('edge'),
      sourceEntity: own.get('sourceEntity'),
      targetEntity: own.get('targetEntity'),
      score: own.get('score'),
      hasMatchEvidence: own.has('match_evidence'),
      ...(own.has('match_evidence') ? { matchEvidence: own.get('match_evidence') } : {}),
    };
  } catch {
    return null;
  }
}

function ownHit(value: unknown): { readonly hit: RankedHit; readonly rawTriple: Triple } | null {
  const fields = ownHitFields(value);
  if (!fields) return null;
  let triple: Triple;
  let evidence: unknown;
  try {
    triple = cloneBoundedAutomaticCaptureJson<Triple>(
      { edge: fields.edge, subject: fields.sourceEntity, value: fields.targetEntity },
      'beginRequest',
    );
    if (fields.hasMatchEvidence) {
      evidence = cloneBoundedAutomaticCaptureJson(fields.matchEvidence, 'policyData');
    }
  } catch {
    return null;
  }
  const candidate = {
    edge: triple.edge,
    sourceEntity: triple.subject,
    targetEntity: triple.value,
    score: fields.score,
    ...(fields.hasMatchEvidence ? { match_evidence: evidence } : {}),
  };
  const parsed = CompositionalRuntimeSearchHitV3Schema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.edge.source_node_uuid !== parsed.data.sourceEntity.uuid ||
    parsed.data.edge.target_node_uuid !== parsed.data.targetEntity.uuid ||
    parsed.data.edge.group_id !== parsed.data.sourceEntity.group_id ||
    parsed.data.edge.group_id !== parsed.data.targetEntity.group_id
  ) {
    return null;
  }
  return { hit: parsed.data, rawTriple: triple };
}

/** Bounded ranked-hit DATA intake shared by fixed V4 retrieval callers. */
export function ownAutonomousPersonalRuntimeRankedHitsV4(
  storageOwner: IGraphStorage,
  parentReader: PrivateAutonomousPersonalMemoryParentReaderV4,
  compatibilityReader: CompositionalRuntimeReaderV3,
  rawHits: unknown,
): readonly { readonly hit: RankedHit; readonly rawTriple: Triple }[] | null {
  if (!live(storageOwner, parentReader, compatibilityReader)) return null;
  const rawItems = ownDenseArray(rawHits);
  if (!rawItems) {
    live(storageOwner, parentReader, compatibilityReader);
    return null;
  }

  const ownedHits: Array<{ readonly hit: RankedHit; readonly rawTriple: Triple }> = [];
  let totalTripleBytes = 0;
  for (const raw of rawItems) {
    if (!live(storageOwner, parentReader, compatibilityReader)) return null;
    const owned = ownHit(raw);
    if (!owned) {
      live(storageOwner, parentReader, compatibilityReader);
      return null;
    }
    const remaining = MAX_TOTAL_TRIPLE_BYTES - totalTripleBytes;
    const limit = Math.min(MAX_TRIPLE_BYTES, remaining);
    const bytes = boundedAutomaticClaimReadJsonBytes(owned.rawTriple, limit);
    if (bytes > limit) {
      live(storageOwner, parentReader, compatibilityReader);
      return null;
    }
    if (
      hashAutomaticCaptureV2(owned.rawTriple) !==
      hashAutomaticCaptureV2({
        edge: owned.hit.edge,
        subject: owned.hit.sourceEntity,
        value: owned.hit.targetEntity,
      })
    ) {
      live(storageOwner, parentReader, compatibilityReader);
      return null;
    }
    totalTripleBytes += bytes;
    if (totalTripleBytes > MAX_TOTAL_TRIPLE_BYTES) {
      live(storageOwner, parentReader, compatibilityReader);
      return null;
    }
    ownedHits.push(owned);
    if (!live(storageOwner, parentReader, compatibilityReader)) return null;
  }
  try {
    return freezeOwned(ownedHits, () => {
      if (!live(storageOwner, parentReader, compatibilityReader)) throw STOPPED;
    });
  } catch (error) {
    if (error === STOPPED) return null;
    throw error;
  }
}

function cachedParentCandidate(
  storageOwner: IGraphStorage,
  parentReader: PrivateAutonomousPersonalMemoryParentReaderV4,
  compatibilityReader: CompositionalRuntimeReaderV3,
  edgeId: string,
): ParentCandidate | null {
  let byCompatibility = parentCandidates.get(parentReader);
  if (!byCompatibility) {
    byCompatibility = new WeakMap();
    parentCandidates.set(parentReader, byCompatibility);
  }
  let byEdge = byCompatibility.get(compatibilityReader);
  if (!byEdge) {
    byEdge = new Map();
    byCompatibility.set(compatibilityReader, byEdge);
  }
  if (byEdge.has(edgeId)) return byEdge.get(edgeId) ?? null;
  const candidate = readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
    storageOwner,
    parentReader,
    edgeId,
  );
  if (!live(storageOwner, parentReader, compatibilityReader)) return null;
  if (byEdge.size < MAX_HITS) byEdge.set(edgeId, candidate);
  return candidate;
}

function tripleFor(hit: RankedHit | AutonomousPersonalRuntimeGovernedHitV4): Triple {
  return { edge: hit.edge, subject: hit.sourceEntity, value: hit.targetEntity };
}

function sourceMatches(
  source: AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data['source'],
  filters: z.infer<typeof CompositionalRuntimeSearchFiltersV3Schema>,
): boolean {
  return !(
    (filters.sender_id && source.senderId !== filters.sender_id) ||
    (filters.episode_kind && source.episodeKind !== filters.episode_kind) ||
    (filters.trust_level && source.trustLevel !== filters.trust_level) ||
    (filters.source_workflow_id && source.sourceWorkflowId !== filters.source_workflow_id) ||
    (filters.source_execution_id && source.sourceExecutionId !== filters.source_execution_id) ||
    (filters.reference_after && source.referenceTime < filters.reference_after) ||
    (filters.reference_before && source.referenceTime > filters.reference_before)
  );
}

function decision(
  candidateId: string,
  score: number,
  included: boolean,
  reason: AutonomousPersonalRuntimeSearchDecisionV4['reasons'][number],
): AutonomousPersonalRuntimeSearchDecisionV4 {
  return AutonomousPersonalRuntimeSearchDecisionV4OwnedDataSchema.parse({
    candidate_id: candidateId,
    candidate_type: 'fact',
    score,
    included,
    reasons: [reason],
  });
}

function empty(): AutonomousPersonalRuntimeSearchResultV4 {
  return { results: [], decisions: [] };
}

/**
 * Current-only Claim3 governance over already-ranked search DATA. It adds no search,
 * snapshot, index, timer, authority, or resource scope of its own.
 */
export function governAutonomousPersonalRuntimeEdgesV4(
  storageOwner: IGraphStorage,
  parentReader: PrivateAutonomousPersonalMemoryParentReaderV4,
  compatibilityReader: CompositionalRuntimeReaderV3,
  rawHits: unknown,
  rawFilters: unknown = {},
  rawView: unknown = { mode: 'current' },
): AutonomousPersonalRuntimeSearchResultV4 {
  if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
  const checkedEmpty = () => {
    live(storageOwner, parentReader, compatibilityReader);
    return empty();
  };

  let filters: z.infer<typeof CompositionalRuntimeSearchFiltersV3Schema>;
  let view: z.infer<typeof CompositionalRuntimeSearchViewV3Schema>;
  try {
    filters = CompositionalRuntimeSearchFiltersV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(rawFilters, 'policyData'),
    );
    view = CompositionalRuntimeSearchViewV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(rawView, 'policyData'),
    );
  } catch {
    live(storageOwner, parentReader, compatibilityReader);
    return empty();
  }
  if (!live(storageOwner, parentReader, compatibilityReader)) return empty();

  // Intake is per-hit: complete ranked arrays are never serialized under one 512 KiB cap.
  const owned = ownAutonomousPersonalRuntimeRankedHitsV4(
    storageOwner,
    parentReader,
    compatibilityReader,
    rawHits,
  );
  if (!owned) return checkedEmpty();

  // All candidate triples have been bounded before any row hash or Claim3 semantic hash.
  const prepared: PreparedHit[] = [];
  for (const ownedRow of owned) {
    if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
    const { hit, rawTriple } = ownedRow;
    const triple = tripleFor(hit);
    const rowHash = hashAutomaticCaptureV2(rawTriple);
    if (rowHash !== hashAutomaticCaptureV2(triple)) return checkedEmpty();
    const rawMetadata = hit.edge.attributes.engram_claim_v1;
    const parsedClaim = AutonomousPersonalClaimV3OwnedDataSchema.safeParse(rawMetadata);
    const claimTagIsV3 =
      rawMetadata !== null &&
      typeof rawMetadata === 'object' &&
      !Array.isArray(rawMetadata) &&
      Object.getOwnPropertyDescriptor(rawMetadata, 'version')?.value === 3;
    if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
    prepared.push({
      hit,
      triple,
      rowHash,
      claim: parsedClaim.success ? parsedClaim.data : null,
      claimTagIsV3,
    });
  }

  // Keep only the first ranked occurrence of a UUID. Later duplicate triples are
  // still individually bounded above, but cannot add a second result or Parent charge.
  const uniquePrepared: PreparedHit[] = [];
  const seenIds = new Set<string>();
  for (const row of prepared) {
    const id = row.hit.edge.uuid;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    uniquePrepared.push(row);
  }

  const decisions: AutonomousPersonalRuntimeSearchDecisionV4[] = [];
  const resultRows: AutonomousPersonalRuntimeGovernedHitV4[] = [];
  const resultDisplays: AutonomousPersonalRuntimeDisplayV4[] = [];

  for (const row of uniquePrepared) {
    if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
    const id = row.hit.edge.uuid;
    const score = row.hit.score;
    if (!row.claim || !row.claimTagIsV3) {
      decisions.push(decision(id, score, false, 'automatic_claim_authority'));
      continue;
    }
    if (view.mode === 'historical') {
      decisions.push(decision(id, score, false, 'autonomous_personal_historical_unsupported'));
      continue;
    }
    if (view.mode === 'asOf') {
      decisions.push(decision(id, score, false, 'autonomous_personal_as_of_unsupported'));
      continue;
    }

    let candidate = cachedParentCandidate(storageOwner, parentReader, compatibilityReader, id);
    if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
    if (candidate) {
      const parsed =
        AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(candidate);
      candidate = parsed.success ? parsed.data : null;
      if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
    }
    if (!candidate) {
      decisions.push(decision(id, score, false, 'automatic_claim_authority'));
      continue;
    }
    if (
      candidate.kind !== row.claim.kind ||
      candidate.proof.claimId !== id ||
      candidate.proof.kind !== row.claim.kind ||
      candidate.proof.key !== row.claim.key
    ) {
      decisions.push(decision(id, score, false, 'automatic_claim_authority'));
      continue;
    }
    if (row.rowHash !== candidate.rowHash) {
      decisions.push(decision(id, score, false, 'automatic_claim_row_mismatch'));
      continue;
    }
    if (filters.review_statuses?.length && !filters.review_statuses.includes('accepted')) {
      decisions.push(decision(id, score, false, 'review_status_filtered'));
      continue;
    }
    if (!sourceMatches(candidate.source, filters)) {
      decisions.push(decision(id, score, false, 'no_source_episode_matched_filters'));
      continue;
    }

    const provenance = [
      {
        source_episode_uuid: candidate.proof.sourceId,
        source_message_id: candidate.source.sourceMessageId,
        conversation_id: candidate.source.conversationId,
        speaker_role: 'human' as const,
        sender_id: candidate.source.senderId,
        sender_name: candidate.source.senderName,
        episode_kind: candidate.source.episodeKind,
        reference_time: candidate.source.referenceTime,
        trust_level: candidate.source.trustLevel,
        episode_review_status: 'accepted' as const,
        source_workflow_id: candidate.source.sourceWorkflowId,
        source_execution_id: candidate.source.sourceExecutionId,
        fact_confidence: candidate.confidence,
        fact_review_status: 'accepted' as const,
      },
    ];
    const displayInput =
      candidate.kind === 'typed_preference'
        ? {
            kind: candidate.kind,
            meaning: candidate.meaning,
            confidence: candidate.confidence,
            source: candidate.source,
          }
        : {
            kind: candidate.kind,
            statementLiteral: candidate.statementLiteral,
            sourceEventTime: candidate.sourceEventTime,
            ...(candidate.qualification === undefined
              ? {}
              : { qualification: candidate.qualification }),
            confidence: candidate.confidence,
            source: candidate.source,
          };
    const parsedDisplay = AutonomousPersonalRuntimeDisplayV4OwnedDataSchema.safeParse(displayInput);
    const parsedHit = AutonomousPersonalRuntimeGovernedHitV4OwnedDataSchema.safeParse({
      ...row.hit,
      provenance,
    });
    if (
      !parsedDisplay.success ||
      !parsedHit.success ||
      hashAutomaticCaptureV2({
        edge: parsedHit.data.edge,
        subject: parsedHit.data.sourceEntity,
        value: parsedHit.data.targetEntity,
      }) !== candidate.rowHash
    ) {
      decisions.push(decision(id, score, false, 'automatic_claim_row_mismatch'));
      continue;
    }

    const frozenDisplay = freezeWithLiveReaders(
      parsedDisplay.data,
      storageOwner,
      parentReader,
      compatibilityReader,
    );
    if (!frozenDisplay) return empty();
    resultRows.push(parsedHit.data);
    resultDisplays.push(frozenDisplay);
    decisions.push(decision(id, score, true, 'included'));
    if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
  }

  if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
  const parsedResult = AutonomousPersonalRuntimeSearchResultV4OwnedDataSchema.safeParse({
    results: resultRows,
    decisions,
  });
  if (!parsedResult.success || parsedResult.data.results.length !== resultDisplays.length)
    return checkedEmpty();

  const registrations: Registration[] = [];
  for (let index = 0; index < parsedResult.data.results.length; index += 1) {
    if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
    const hit = parsedResult.data.results[index]!;
    const display = resultDisplays[index]!;
    const rowHash = hashAutomaticCaptureV2({
      edge: hit.edge,
      subject: hit.sourceEntity,
      value: hit.targetEntity,
    });
    const expected = resultRows[index];
    if (!expected || rowHash !== hashAutomaticCaptureV2(tripleFor(expected))) return checkedEmpty();
    registrations.push({
      owner: storageOwner,
      parent: parentReader,
      compatibilityReader,
      rowHash,
      display,
    });
  }

  const output = freezeWithLiveReaders(
    parsedResult.data,
    storageOwner,
    parentReader,
    compatibilityReader,
  );
  if (!output) return empty();
  for (let index = 0; index < output.results.length; index += 1) {
    if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
    displays.set(output.results[index]!, registrations[index]!);
  }
  if (!live(storageOwner, parentReader, compatibilityReader)) return empty();
  return output;
}

function readRegisteredDisplay(hit: unknown): Registration | null {
  if (!hit || typeof hit !== 'object' || utilTypes.isProxy(hit)) return null;
  const registration = displays.get(hit);
  if (
    !registration ||
    !live(registration.owner, registration.parent, registration.compatibilityReader)
  )
    return null;
  const actual = hit as AutonomousPersonalRuntimeGovernedHitV4;
  const triple = tripleFor(actual);
  const bytes = boundedAutomaticClaimReadJsonBytes(triple, MAX_TRIPLE_BYTES);
  if (bytes > MAX_TRIPLE_BYTES) {
    live(registration.owner, registration.parent, registration.compatibilityReader);
    return null;
  }
  const rowHash = hashAutomaticCaptureV2(triple);
  const matches = rowHash === registration.rowHash;
  return live(registration.owner, registration.parent, registration.compatibilityReader) && matches
    ? registration
    : null;
}

/** Safe structured display for one exact immutable governed hit, while its readers remain live. */
export function getAutonomousPersonalRuntimeDisplayV4(
  hit: unknown,
): AutonomousPersonalRuntimeDisplayV4 | null {
  return readRegisteredDisplay(hit)?.display ?? null;
}

/** Grounded edge text may be used lexically only after exact-row and reader revalidation. */
export function getAutonomousPersonalRuntimeLexicalHintV4(hit: unknown): string | null {
  const registration = readRegisteredDisplay(hit);
  if (!registration || !hit || typeof hit !== 'object') return null;
  const fact = (hit as AutonomousPersonalRuntimeGovernedHitV4).edge.fact;
  if (!live(registration.owner, registration.parent, registration.compatibilityReader)) return null;
  const display = registration.display;
  // Qualified statements are not preferences by kind or label; only an explicit whole-word
  // preference term in the revalidated fact joins the typed matching family.
  const preferenceFamily =
    display.kind === 'typed_preference' ||
    (display.kind === 'source_statement_record' &&
      display.qualification !== undefined &&
      /\b(?:prefer|preference|preferences|preferred)\b/iu.test(fact));
  return preferenceFamily ? `${fact} preference preferences preferred` : fact;
}
