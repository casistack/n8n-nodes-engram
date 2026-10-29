import type { EntityNode, EntityEdge, EpisodicNode } from '../schemas';
import type { StoredAutomaticOperation } from '../schemas/AutomaticLedger.schema';
import type { CompositionalQualifiedClaimReadResultV3 } from '../schemas/CompositionalQualifiedClaimReadV3.schema';
import type { OwnedCompositionalSnapshotV3 } from './CompositionalSnapshotIndexV3';
import { types as utilTypes } from 'util';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { BoundedAutomaticCaptureJsonError } from '../storage/BoundedAutomaticCaptureJson';
import {
  getAutomaticClaimReadScope,
  canUseAutomaticClaimReadScope,
  beginAutomaticClaimReadAttempt,
  getAutomaticClaimReadScopeRemaining,
  chargeAutomaticClaimContextBytes,
} from '../storage/AutomaticClaimReadScope';
import {
  createCompositionalSnapshotIndexV3,
  getOwnedCompositionalSnapshotV3,
  isCompositionalSnapshotReadScopeV3,
  CompositionalSnapshotIndexErrorV3,
  type CompositionalSnapshotIndexV3,
} from './CompositionalSnapshotIndexV3';
import { createCompositionalQualifiedClaimReadPrivateProjectorV3 } from './CompositionalQualifiedClaimReadV3';
import {
  createLiteralV1SemanticOverlapPrivateProjectorV1,
  compareCompositionalMeaningOverlapDomainV1,
} from './LiteralV1SemanticOverlap';
import { inspectLiteralCompositionalPairCompatibilityV1 } from './LiteralCompositionalPairCompatibilityV1';
import { CompositionalQualifiedClaimReadContextV3Schema } from '../schemas/CompositionalQualifiedClaimReadV3.schema';
import {
  CompositionalOverlapBatchRequestV3Schema,
  CompositionalPlanningDataExpectationV3Schema,
  CompositionalOverlapBundleDataV3Schema,
  type CompositionalOverlapBundleDataV3,
  type CompositionalOverlapBatchFailureV3,
} from '../schemas/CompositionalOverlapBatchV3.schema';
import type { LiteralV1SemanticInspection } from '../schemas/LiteralV1SemanticOverlap.schema';
import type { CompositionalAutomaticClaimMeaningV2 } from '../schemas/CompositionalAutomaticMemory.schema';

class BatchCapacity extends Error {}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function ownRecord(value: unknown, maxKeys = 3): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      return null;
    const out: Record<string, unknown> = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > maxKeys) return null;
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || !('value' in d)) return null;
      out[key] = d.value;
    }
    return out;
  } catch {
    return null;
  }
}
export function resolveCompositionalBatchResourcesV3(
  value: unknown,
): { budget: SourceHydrationBudget; now: string; check: () => void } | null {
  const r = ownRecord(value);
  if (!r || Object.keys(r).some((k) => !['budget', 'now', 'check'].includes(k))) return null;
  const b = ownRecord(r.budget, 2);
  if (
    !b ||
    Object.keys(b).sort().join(',') !== 'deferred,remaining' ||
    !Number.isInteger(b.remaining) ||
    (b.remaining as number) < 0 ||
    (b.remaining as number) > 1024 ||
    !Number.isInteger(b.deferred) ||
    (b.deferred as number) < 0
  )
    return null;
  if (
    typeof r.now !== 'string' ||
    r.now.length !== 24 ||
    !Number.isFinite(Date.parse(r.now)) ||
    new Date(r.now).toISOString() !== r.now ||
    (r.check !== undefined && (typeof r.check !== 'function' || utilTypes.isProxy(r.check)))
  )
    return null;
  for (const key of ['remaining', 'deferred'])
    if (!Object.getOwnPropertyDescriptor(r.budget, key)?.writable) return null;
  return {
    budget: r.budget as SourceHydrationBudget,
    now: r.now,
    check: (r.check as (() => void) | undefined) ?? (() => {}),
  };
}
declare const batchBrand: unique symbol;
export type CompositionalReadBatchV3 = Readonly<{ [batchBrand]: true }>;
type Detail = CompositionalOverlapBundleDataV3['details'][number];
export interface PrivateCompositionalPlanningCandidateV3 {
  readonly candidateId: string;
  readonly edge: EntityEdge;
  readonly subject: EntityNode;
  readonly value: EntityNode | null;
  readonly source: EpisodicNode | null;
  readonly operations: readonly StoredAutomaticOperation[];
  readonly canonicalMeaning: CompositionalAutomaticClaimMeaningV2 | null;
  readonly qualifiedCompositional: Extract<
    CompositionalQualifiedClaimReadResultV3,
    { status: 'valid_data' }
  > | null;
  readonly relations: readonly Detail[];
}
export interface PrivateCompositionalPlanningDataV3 {
  readonly snapshotHash: string;
  readonly namespace: string;
  readonly subjectId: string;
  readonly candidateCount: number;
  source(id: string): EpisodicNode | undefined;
  operation(id: string): StoredAutomaticOperation | undefined;
  lookupRecordId(id: string): Readonly<{
    category: 'entity' | 'edge' | 'episode' | 'operation';
    id: string;
    namespace: string;
  }> | null;
  forEachCandidate(visitor: (candidate: PrivateCompositionalPlanningCandidateV3) => void): void;
}

const failure = (
  reason: CompositionalOverlapBatchFailureV3['reason'],
): CompositionalOverlapBatchFailureV3 => ({ status: 'incomplete', reason });
function literalDetail(
  inspection: LiteralV1SemanticInspection,
  meaning: CompositionalAutomaticClaimMeaningV2,
  check: () => void,
): Detail {
  const result: Detail = {
    candidateId: inspection.oldEdgeId,
    family: inspection.provenance === 'automatic_literal_v1' ? 'literal_v1' : 'unknown',
    projection: inspection.projection === 'exact' ? 'exact' : 'unknown',
    currentReview: inspection.currentReview,
    currentEligibility:
      inspection.oldCurrentEligibility === 'eligible'
        ? 'eligible'
        : inspection.oldCurrentEligibility === 'ineligible'
          ? 'ineligible'
          : 'unknown',
    domain: inspection.domain,
    equivalent: inspection.equivalent,
    disposition:
      inspection.domain === 'proven_disjoint'
        ? 'proven_disjoint'
        : inspection.projection === 'exact'
          ? 'possible_overlap'
          : 'unknown',
  };
  if (
    inspection.projection === 'exact' &&
    inspection.domain !== 'proven_disjoint' &&
    inspection.oldCurrentEligibility === 'eligible' &&
    inspection.currentReview === 'accepted'
  ) {
    if (inspection.equivalent) result.disposition = 'legacy_reuse_not_authorized';
    else {
      const compatible = inspectLiteralCompositionalPairCompatibilityV1(
        { oldMeaning: inspection.canonicalMeaning, newMeaning: meaning },
        check,
      );
      if (compatible.status === 'compatible_constraints') {
        result.disposition = 'conditional_compatible';
        result.conditionalRuleId = compatible.ruleId;
      }
    }
  }
  return result;
}
/** Per-instance immutable read/cache ownership only; never backend/source/lease authority. */
export function createCompositionalOverlapBatchInspectorV3() {
  const batches = new WeakMap<
    object,
    {
      data: readonly CompositionalOverlapBundleDataV3[];
      check: () => void;
      view: OwnedCompositionalSnapshotV3;
      allCandidates: readonly PrivateCompositionalPlanningCandidateV3[];
    }
  >();
  const prepare = (
    input: { kind: 'graph'; graph: unknown } | { kind: 'index'; token: unknown },
    requestValue: unknown,
    resourceValue: unknown,
  ):
    | { status: 'prepared_data'; batch: CompositionalReadBatchV3 }
    | CompositionalOverlapBatchFailureV3 => {
    const r = resolveCompositionalBatchResourcesV3(resourceValue);
    if (!r) return failure('invalid_resources');
    const scope = getAutomaticClaimReadScope(r.budget);
    let aborted = false;
    let abort: unknown;
    const check = () => {
      if (aborted) throw abort;
      try {
        r.check();
      } catch (error) {
        aborted = true;
        abort = error;
        throw error;
      }
      if (!canUseAutomaticClaimReadScope(scope)) throw new BatchCapacity();
    };
    try {
      check();
      let requestSnapshot: unknown;
      try {
        requestSnapshot = cloneBoundedAutomaticCaptureJson(requestValue, 'beginRequest');
      } catch {
        return failure('invalid_input');
      }
      const request = CompositionalOverlapBatchRequestV3Schema.safeParse(requestSnapshot);
      if (!request.success) return failure('invalid_input');
      check();
      let token: CompositionalSnapshotIndexV3;
      if (input.kind === 'index') {
        const candidate = getOwnedCompositionalSnapshotV3(input.token);
        if (!candidate) return failure('invalid_batch');
        if (!isCompositionalSnapshotReadScopeV3(input.token, scope))
          return failure('invalid_resources');
        if (
          candidate.namespace !== request.data.namespace ||
          candidate.subjectId !== request.data.subjectId
        )
          return failure('invalid_input');
        token = input.token as CompositionalSnapshotIndexV3;
      } else
        token = createCompositionalSnapshotIndexV3(
          input.graph,
          { namespace: request.data.namespace, subjectId: request.data.subjectId },
          check,
          scope,
        );
      const view = getOwnedCompositionalSnapshotV3(token)!;
      if (view.candidates.length > 128) return failure('inspection_capacity');
      const literal = createLiteralV1SemanticOverlapPrivateProjectorV1(token, {
        now: Date.parse(r.now),
        check,
      });
      if (!literal) return failure('invalid_snapshot');
      const compositional = createCompositionalQualifiedClaimReadPrivateProjectorV3(
        token,
        r.now,
        check,
      );
      for (const meaning of request.data.meanings) literal.prepareMeaning(meaning);
      const projected: Array<{
        edgeId: string;
        compare: (meaning: CompositionalAutomaticClaimMeaningV2) => Detail;
        canonicalMeaning?: CompositionalAutomaticClaimMeaningV2;
        qualifiedCompositional?: Extract<
          CompositionalQualifiedClaimReadResultV3,
          { status: 'valid_data' }
        >;
        relations: Detail[];
      }> = [];
      for (const edge of view.candidates) {
        check();
        if (!beginAutomaticClaimReadAttempt(scope)) throw new BatchCapacity();
        const remaining = getAutomaticClaimReadScopeRemaining(scope)?.contextBytesRemaining ?? 0;
        const limit = Math.min(512 * 1024, remaining);
        const payload = edge.attributes.engram_claim_v1;
        const version =
          payload !== null && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).version
            : undefined;
        if (version === 2) {
          const p = compositional.projectCandidate(edge.uuid, limit);
          if (
            !chargeAutomaticClaimContextBytes(scope, Math.min(p.inspectedBytes, remaining)) ||
            p.inspectedBytes > limit
          )
            throw new BatchCapacity();
          if (
            p.result.status === 'invalid' &&
            ['context_too_large', 'proof_too_large'].includes(p.result.reason)
          )
            throw new BatchCapacity();
          if (p.result.status === 'valid_data') {
            const context = p.result.context;
            const oldMeaning = (
              context.edge.attributes.engram_claim_v1 as {
                meaning: CompositionalAutomaticClaimMeaningV2;
              }
            ).meaning;
            const guard = hashAutomaticCaptureV2({
              domain: 'engram-compositional-qualified-reference-v3',
              context: CompositionalQualifiedClaimReadContextV3Schema.parse(context),
            });
            projected.push({
              edgeId: edge.uuid,
              canonicalMeaning: oldMeaning,
              qualifiedCompositional: p.result,
              relations: [],
              compare: (meaning) => {
                check();
                const domain = compareCompositionalMeaningOverlapDomainV1(
                  oldMeaning,
                  meaning,
                  check,
                );
                return {
                  candidateId: edge.uuid,
                  family: 'compositional_v2',
                  projection: 'exact',
                  currentReview:
                    p.result.status === 'valid_data' ? p.result.currentReview : 'unknown',
                  currentEligibility:
                    p.result.status === 'valid_data' && p.result.currentReview === 'accepted'
                      ? 'eligible'
                      : 'ineligible',
                  ...domain,
                  disposition:
                    domain.domain === 'proven_disjoint'
                      ? 'proven_disjoint'
                      : domain.equivalent
                        ? 'same_family_reference_data'
                        : 'possible_overlap',
                  referenceGuardHash: guard,
                };
              },
            });
          } else
            projected.push({
              edgeId: edge.uuid,
              relations: [],
              compare: () => ({
                candidateId: edge.uuid,
                family: 'compositional_v2',
                projection: p.result.status === 'uncommitted' ? 'uncommitted' : 'unknown',
                currentReview: 'unknown',
                currentEligibility: 'unknown',
                domain: 'unknown_domain',
                equivalent: null,
                disposition: p.result.status === 'uncommitted' ? 'uncommitted' : 'unknown',
              }),
            });
        } else {
          const p = literal.projectCandidate(edge.uuid, limit);
          if (!p) return failure('invalid_snapshot');
          if (
            !chargeAutomaticClaimContextBytes(scope, Math.min(p.inspectedBytes, remaining)) ||
            p.inspectedBytes > limit ||
            p.capacityExceeded
          )
            throw new BatchCapacity();
          const base = p.compare(request.data.meanings[0]);
          projected.push({
            edgeId: edge.uuid,
            relations: [],
            canonicalMeaning: base.projection === 'exact' ? base.canonicalMeaning : undefined,
            compare: (meaning) => literalDetail(p.compare(meaning), meaning, check),
          });
        }
        check();
      }
      const snapshotHash = view.snapshotHash;
      const data: CompositionalOverlapBundleDataV3[] = [];
      for (const [bundleIndex, meaning] of request.data.meanings.entries()) {
        check();
        const details: Detail[] = [];
        let disjoint = 0;
        let relevant = 0;
        for (const p of projected) {
          check();
          const d = p.compare(meaning);
          p.relations.push(d);
          details.push(d);
          if (d.domain === 'proven_disjoint') disjoint++;
          else relevant++;
          if (relevant > 8) return failure('inspection_capacity');
        }
        data.push(
          CompositionalOverlapBundleDataV3Schema.parse({
            version: 3,
            status: 'complete_data',
            bundleIndex,
            snapshotHash,
            inspectedCandidateCount: projected.length,
            provenDisjointCount: disjoint,
            relevantCandidateCount: relevant,
            details: [
              ...details.filter((d) => d.domain !== 'proven_disjoint'),
              ...details.filter((d) => d.domain === 'proven_disjoint'),
            ].slice(0, 8),
          }),
        );
      }
      if (Buffer.byteLength(canonicalAutomaticCaptureV2(data), 'utf8') > 32768)
        return failure('diagnostic_capacity');
      check();
      const batch = Object.freeze(Object.create(null)) as CompositionalReadBatchV3;
      const allCandidates = projected.map((p) => {
        const edge = view.edge(p.edgeId)!;
        const raw = edge.attributes.engram_claim_v1;
        const sourceId =
          raw !== null && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>).sourceId
            : undefined;
        const source =
          typeof sourceId === 'string' && sourceId.length === 36
            ? view.episode(sourceId)
            : undefined;
        const value = view.entity(edge.target_node_uuid);
        return freeze({
          candidateId: p.edgeId,
          edge,
          subject: view.subject,
          value: value?.group_id === view.namespace ? value : null,
          source: source?.group_id === view.namespace ? source : null,
          operations:
            source?.group_id === view.namespace ? view.operationsForSource(source.uuid) : [],
          canonicalMeaning: p.canonicalMeaning ?? null,
          qualifiedCompositional: p.qualifiedCompositional ?? null,
          relations: p.relations,
        });
      });
      const ownedData = freeze(data);
      const ownedCandidates = freeze(allCandidates);
      check();
      batches.set(batch as object, {
        data: ownedData,
        check,
        view,
        allCandidates: ownedCandidates,
      });
      return { status: 'prepared_data', batch };
    } catch (error) {
      if (aborted) throw abort;
      if (
        error instanceof BatchCapacity ||
        (error instanceof CompositionalSnapshotIndexErrorV3 && error.reason === 'budget_exhausted')
      )
        return failure('budget_exhausted');
      if (
        error instanceof Error &&
        error.message === 'Engram compositional batch: candidate_capacity'
      )
        return failure('inspection_capacity');
      if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json')
        return failure('inspection_capacity');
      return failure('invalid_snapshot');
    }
  };
  return Object.freeze({
    prepare(graphValue: unknown, requestValue: unknown, resourceValue: unknown) {
      return prepare({ kind: 'graph', graph: graphValue }, requestValue, resourceValue);
    },
    prepareFromOwnedIndex(token: unknown, requestValue: unknown, resourceValue: unknown) {
      return prepare({ kind: 'index', token }, requestValue, resourceValue);
    },
    withPlanningData<T>(
      batch: unknown,
      expectedValue: unknown,
      reader: (view: PrivateCompositionalPlanningDataV3) => T,
    ): { status: 'planning_data'; value: T } | CompositionalOverlapBatchFailureV3 {
      const state = batch !== null && typeof batch === 'object' ? batches.get(batch) : undefined;
      if (!state) return failure('invalid_batch');
      let active = true;
      let readerViolation = false;
      const guard = () => {
        state.check();
        if (!active) throw new Error('Engram compositional batch: inactive_reader');
        if (readerViolation) throw new Error('Engram compositional batch: invalid_reader');
      };
      const after = () => {
        try {
          state.check();
          return null;
        } catch (error) {
          if (error instanceof BatchCapacity) return failure('budget_exhausted');
          throw error;
        }
      };
      const start = after();
      if (start) return start;
      let expected;
      try {
        expected = CompositionalPlanningDataExpectationV3Schema.parse(
          cloneBoundedAutomaticCaptureJson(expectedValue, 'beginRequest'),
        );
      } catch {
        return failure('invalid_input');
      }
      if (
        expected.snapshotHash !== state.data[0].snapshotHash ||
        expected.namespace !== state.view.namespace ||
        expected.subjectId !== state.view.subjectId
      )
        return failure('invalid_batch');
      if (
        typeof reader !== 'function' ||
        utilTypes.isProxy(reader) ||
        utilTypes.isAsyncFunction(reader)
      )
        return failure('invalid_input');
      const safeId = (id: unknown) => typeof id === 'string' && id.length === 36;
      const view: PrivateCompositionalPlanningDataV3 = Object.freeze({
        snapshotHash: expected.snapshotHash,
        namespace: state.view.namespace,
        subjectId: state.view.subjectId,
        candidateCount: state.allCandidates.length,
        source: (id: string) => {
          guard();
          const row = safeId(id) ? state.view.episode(id) : undefined;
          guard();
          return row?.group_id === state.view.namespace ? row : undefined;
        },
        operation: (id: string) => {
          guard();
          const op = safeId(id) ? state.view.operation(id) : undefined;
          guard();
          return op?.identity.namespace === state.view.namespace ? op : undefined;
        },
        lookupRecordId: (id: string) => {
          guard();
          if (!safeId(id)) return null;
          const entity = state.view.entity(id);
          const edge = state.view.edge(id);
          const episode = state.view.episode(id);
          const operation = state.view.operation(id);
          const record = entity ?? edge ?? episode;
          const category = entity
            ? 'entity'
            : edge
              ? 'edge'
              : episode
                ? 'episode'
                : operation
                  ? 'operation'
                  : undefined;
          guard();
          return category
            ? Object.freeze({
                category,
                id,
                namespace: record?.group_id ?? operation!.identity.namespace,
              })
            : null;
        },
        forEachCandidate: (
          visitor: (candidate: PrivateCompositionalPlanningCandidateV3) => void,
        ) => {
          guard();
          if (
            typeof visitor !== 'function' ||
            utilTypes.isProxy(visitor) ||
            utilTypes.isAsyncFunction(visitor)
          ) {
            readerViolation = true;
            throw new Error('Engram compositional batch: invalid_reader');
          }
          for (const candidate of state.allCandidates) {
            guard();
            let threw = false;
            let result: unknown;
            try {
              result = visitor(candidate);
            } catch {
              threw = true;
            } finally {
              guard();
            }
            if (threw || result !== undefined) {
              readerViolation = true;
              throw new Error('Engram compositional batch: invalid_reader');
            }
          }
        },
      });
      let value: T | undefined;
      let threw = false;
      try {
        value = reader(view);
      } catch {
        threw = true;
      } finally {
        active = false;
      }
      const finished = after();
      if (finished) return finished;
      if (threw || readerViolation) return failure('invalid_input');
      let cloned: T;
      try {
        cloned = cloneBoundedAutomaticCaptureJson<T>(value, 'beginRequest');
      } catch {
        return failure('invalid_input');
      }
      const ownedValue = freeze(cloned);
      const checked = after();
      if (checked) return checked;
      return { status: 'planning_data', value: ownedValue };
    },
    readBundle(
      batch: unknown,
      bundleIndex: number,
    ): CompositionalOverlapBundleDataV3 | CompositionalOverlapBatchFailureV3 {
      const state = batch !== null && typeof batch === 'object' ? batches.get(batch) : undefined;
      if (!state) return failure('invalid_batch');
      try {
        state.check();
      } catch (error) {
        if (error instanceof BatchCapacity) return failure('budget_exhausted');
        throw error;
      }
      if (!Number.isInteger(bundleIndex) || bundleIndex < 0 || bundleIndex >= state.data.length)
        return failure('invalid_input');
      return state.data[bundleIndex];
    },
  });
}
