import { types as utilTypes } from 'util';
import {
  CompositionalRetrievalRequestV3Schema,
  CompositionalRetrievalDataV3Schema,
  CompositionalRetrievalEntryV3Schema,
  type CompositionalRetrievalIntakeV3,
  type CompositionalRetrievalSessionV3,
  type CompositionalRetrievalBeginResultV3,
  type CompositionalRetrievalPrepareResultV3,
  type CompositionalRetrievalReadResultV3,
  type CompositionalRetrievalFailureV3,
  type CompositionalRetrievalSessionReasonV3,
  type CompositionalRetrievalOutcomeV3,
  type CompositionalRetrievalEntryV3,
  type CompositionalOwnedSnapshotDataResultV3,
} from '../schemas/CompositionalRetrievalSessionV3.schema';
import {
  createCompositionalRetrievalSnapshotIndexV3,
  selectCompositionalRetrievalSubjectIndexV3,
  getOwnedCompositionalRetrievalSnapshotV3,
  getOwnedCompositionalSnapshotV3,
  CompositionalSnapshotIndexErrorV3,
  type CompositionalRetrievalSnapshotIndexV3,
  type OwnedCompositionalRetrievalSnapshotV3,
} from '../extraction/CompositionalSnapshotIndexV3';
import { resolveCompositionalBatchResourcesV3 } from '../extraction/CompositionalOverlapBatchV3';
import { createCompositionalQualifiedClaimReadPrivateProjectorV3 } from '../extraction/CompositionalQualifiedClaimReadV3';
import {
  createLiteralV1SemanticOverlapPrivateProjectorV1,
  compareCompositionalMeaningOverlapDomainV1,
  type LiteralV1SemanticOverlapCandidateProjectionV1,
} from '../extraction/LiteralV1SemanticOverlap';
import { inspectLiteralCompositionalPairCompatibilityV1 } from '../extraction/LiteralCompositionalPairCompatibilityV1';
import {
  beginAutomaticClaimReadAttempt,
  canUseAutomaticClaimReadScope,
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  chargeAutomaticClaimContextBytes,
  type AutomaticClaimReadScope,
} from '../storage/AutomaticClaimReadScope';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import {
  CompositionalAutomaticClaimMetadataV2Schema,
  type CompositionalAutomaticClaimMeaningV2,
} from '../schemas/CompositionalAutomaticMemory.schema';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import type { CompositionalQualifiedClaimReadResultV3 } from '../schemas/CompositionalQualifiedClaimReadV3.schema';
import { extractionMetadataFromAttributes } from '../schemas/ExtractionMetadata.schema';
import { boundedAutomaticClaimReadJsonBytes } from '../extraction/AutomaticClaimCommitProof';
import type { AutomaticClaimReadResult } from '../schemas/AutomaticClaimRead.schema';

class ResourceFailure extends Error {
  constructor(readonly reason: CompositionalRetrievalSessionReasonV3) {
    super(reason);
  }
}
const fail = (reason: CompositionalRetrievalSessionReasonV3): CompositionalRetrievalFailureV3 => ({
  status: 'deferred',
  reason,
});
function own(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
    return null;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const names = Reflect.ownKeys(value);
    if (
      names.length !== keys.length ||
      names.some((key) => typeof key !== 'string' || !keys.includes(key))
    )
      return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
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
type Qualified = Extract<CompositionalQualifiedClaimReadResultV3, { status: 'valid_data' }>;
type Projection =
  | { family: 'v3'; qualified?: Qualified; meaning?: CompositionalAutomaticClaimMeaningV2 }
  | { family: 'v1'; literal: LiteralV1SemanticOverlapCandidateProjectionV1; limit: number };
type InternalStop = () => Extract<
  CompositionalRetrievalSessionReasonV3,
  'budget_exhausted' | 'capacity'
> | null;
type Intake = {
  namespace: string;
  scope: AutomaticClaimReadScope;
  budget: SourceHydrationBudget;
  external: () => void;
  internalStop?: InternalStop;
  aborted: boolean;
  abort?: unknown;
  consumed: boolean;
};
type Session = {
  intake: Intake;
  token: CompositionalRetrievalSnapshotIndexV3;
  now: string;
  projections: Map<string, Projection>;
  subjects: Map<string, CompositionalRetrievalSessionReasonV3 | null>;
  blocked: Set<string>;
  counted: Set<string>;
  requested: Set<string>;
  diagnosed: Set<string>;
  tools: Map<string, SubjectTools>;
};
type SubjectTools = {
  view: NonNullable<ReturnType<typeof getOwnedCompositionalSnapshotV3>>;
  literal: NonNullable<ReturnType<typeof createLiteralV1SemanticOverlapPrivateProjectorV1>>;
  compositional: ReturnType<typeof createCompositionalQualifiedClaimReadPrivateProjectorV3>;
};
const sorted = (values: Iterable<string>) =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
function check(state: Intake) {
  if (state.aborted) throw state.abort;
  try {
    state.external();
  } catch (error) {
    state.aborted = true;
    state.abort = error;
    throw error;
  }
  // Code-owned stop data is read only after the trusted external check; it never latches `aborted`.
  if (state.internalStop) {
    const stop: unknown = state.internalStop();
    if (stop === 'budget_exhausted' || stop === 'capacity') throw new ResourceFailure(stop);
    if (stop !== null) throw new ResourceFailure('invalid_resources');
  }
  if (!canUseAutomaticClaimReadScope(state.scope)) throw new ResourceFailure('budget_exhausted');
}
function canonicalTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function version(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).version
    : undefined;
}
function charge(session: Session, inspected: number, remaining: number, limit: number) {
  if (!chargeAutomaticClaimContextBytes(session.intake.scope, Math.min(inspected, remaining)))
    throw new ResourceFailure('budget_exhausted');
  if (inspected > limit)
    throw new ResourceFailure(remaining < 512 * 1024 ? 'budget_exhausted' : 'capacity');
}

/** Standalone owned data/resource session. Actual storage origin must be supplied by a future private adapter. */
export type CompositionalRetrievalSessionFactoryV3 = Readonly<{
  begin(request: unknown, resources: unknown): CompositionalRetrievalBeginResultV3;
  getScope(intake: unknown): AutomaticClaimReadScope | null;
  prepare(intake: unknown, snapshot: unknown): CompositionalRetrievalPrepareResultV3;
  readMany(session: unknown, edgeIds: unknown): CompositionalRetrievalReadResultV3;
  withOwnedSnapshotData(session: unknown, visitor: unknown): CompositionalOwnedSnapshotDataResultV3;
  readLiteralContextData(session: unknown, edgeId: unknown): AutomaticClaimReadResult;
}>;
export function createCompositionalRetrievalSessionFactoryV3(
  internalStop?: InternalStop,
): CompositionalRetrievalSessionFactoryV3 {
  const invalidStop =
    internalStop !== undefined &&
    (typeof internalStop !== 'function' || utilTypes.isProxy(internalStop));
  const intakes = new WeakMap<object, Intake>(),
    sessions = new WeakMap<object, Session>();
  const intakeFor = (value: unknown) =>
    value && typeof value === 'object' && !utilTypes.isProxy(value)
      ? intakes.get(value)
      : undefined;
  const sessionFor = (value: unknown) =>
    value && typeof value === 'object' && !utilTypes.isProxy(value)
      ? sessions.get(value)
      : undefined;

  const begin = (
    requestValue: unknown,
    resourceValue: unknown,
  ): CompositionalRetrievalBeginResultV3 => {
    let request;
    try {
      request = CompositionalRetrievalRequestV3Schema.safeParse(
        cloneBoundedAutomaticCaptureJson(requestValue, 'beginRequest'),
      );
    } catch {
      return fail('invalid_input');
    }
    if (!request.success) return fail('invalid_input');
    if (request.data.mode !== 'current') return fail('unsupported_mode');
    if (invalidStop) return fail('invalid_resources');
    const resources = own(resourceValue, ['budget', 'check']) ?? own(resourceValue, ['budget']);
    if (!resources) return fail('invalid_resources');
    const resolved = resolveCompositionalBatchResourcesV3({
      budget: resources.budget,
      now: '2000-01-01T00:00:00.000Z',
      ...(resources.check === undefined ? {} : { check: resources.check }),
    });
    if (!resolved) return fail('invalid_resources');
    const scope = getAutomaticClaimReadScope(resolved.budget);
    const state: Intake = {
      namespace: request.data.namespace,
      scope,
      budget: resolved.budget,
      external: resolved.check,
      ...(internalStop === undefined ? {} : { internalStop }),
      aborted: false,
      consumed: false,
    };
    try {
      check(state);
      if (!beginAutomaticClaimReadAttempt(scope)) return fail('budget_exhausted');
      const intake = Object.freeze(Object.create(null)) as CompositionalRetrievalIntakeV3;
      check(state);
      intakes.set(intake, state);
      return { status: 'intake', intake };
    } catch (error) {
      if (error instanceof ResourceFailure && !state.aborted) return fail(error.reason);
      throw error;
    }
  };
  const getScope = (token: unknown): AutomaticClaimReadScope | null => {
    const state = intakeFor(token);
    if (!state || state.consumed) return null;
    try {
      check(state);
      return state.scope;
    } catch (error) {
      if (error instanceof ResourceFailure && !state.aborted) return null;
      throw error;
    }
  };
  const prepare = (
    token: unknown,
    wrapperValue: unknown,
  ): CompositionalRetrievalPrepareResultV3 => {
    const state = intakeFor(token);
    if (!state || state.consumed) return fail('invalid_intake');
    state.consumed = true;
    try {
      check(state);
      const wrapper = own(wrapperValue, ['graph', 'backendNow']);
      if (!wrapper || !canonicalTime(wrapper.backendNow)) return fail('invalid_input');
      const index = createCompositionalRetrievalSnapshotIndexV3(
        wrapper.graph,
        { namespace: state.namespace },
        state.scope,
        () => check(state),
      );
      check(state);
      const session = Object.freeze(Object.create(null)) as CompositionalRetrievalSessionV3;
      const record: Session = {
        intake: state,
        token: index,
        now: wrapper.backendNow,
        projections: new Map(),
        subjects: new Map(),
        blocked: new Set(),
        counted: new Set(),
        requested: new Set(),
        diagnosed: new Set(),
        tools: new Map(),
      };
      check(state);
      sessions.set(session, record);
      return { status: 'prepared_data', session };
    } catch (error) {
      if (state.aborted) throw state.abort;
      if (error instanceof ResourceFailure) return fail(error.reason);
      if (error instanceof CompositionalSnapshotIndexErrorV3 && error.reason === 'budget_exhausted')
        return fail('budget_exhausted');
      return fail('invalid_snapshot');
    }
  };

  const withOwnedSnapshotData = (
    token: unknown,
    visitor: unknown,
  ): CompositionalOwnedSnapshotDataResultV3 => {
    const record = sessionFor(token);
    if (!record) return fail('invalid_session');
    const state = record.intake;
    let denied = false;
    const access = () => {
      if (denied) throw new ResourceFailure('invalid_session');
      check(state);
      const view = getOwnedCompositionalRetrievalSnapshotV3(record.token);
      if (!view) throw new ResourceFailure('invalid_session');
      return view;
    };
    try {
      check(state);
      if (typeof visitor !== 'function' || utilTypes.isProxy(visitor)) return fail('invalid_input');
      const borrowed: OwnedCompositionalRetrievalSnapshotV3 = Object.freeze({
        get graph() {
          return access().graph;
        },
        get namespace() {
          return access().namespace;
        },
        get snapshotHash() {
          return access().snapshotHash;
        },
        entity: (id: string) => access().entity(id),
        episode: (id: string) => access().episode(id),
        edge: (id: string) => access().edge(id),
        edgesBetween: (a: string, b: string, limit: number) => access().edgesBetween(a, b, limit),
        operation: (id: string) => access().operation(id),
        operationsForSource: (id: string) => access().operationsForSource(id),
        currentBinding: (namespace: string, issuer: string, actor: string) =>
          access().currentBinding(namespace, issuer, actor),
        assertBinding: (
          namespace: string,
          issuer: string,
          actor: string,
          ref: unknown,
          innerCheck?: () => void,
        ) => access().assertBinding(namespace, issuer, actor, ref, innerCheck),
        projectLiteralCommitContext: (edgeId: string, maxBytes: number) =>
          access().projectLiteralCommitContext(edgeId, maxBytes),
      });
      let value: unknown,
        threw = false;
      try {
        value = Reflect.apply(visitor, undefined, [borrowed]);
      } catch {
        threw = true;
      }
      check(state);
      if (threw) {
        denied = true;
        return fail('invalid_input');
      }
      let copied: { value: unknown };
      try {
        copied = cloneBoundedAutomaticCaptureJson(
          { value: value === undefined ? null : value },
          'beginRequest',
        );
      } catch {
        denied = true;
        check(state);
        return fail('invalid_input');
      }
      const result = freeze({ status: 'snapshot_data' as const, value: copied.value });
      check(state);
      return result;
    } catch (error) {
      denied = true;
      if (state.aborted) throw state.abort;
      if (error instanceof ResourceFailure) return fail(error.reason);
      return fail('invalid_snapshot');
    }
  };

  function toolsFor(record: Session, edgeId: string): SubjectTools {
    const state = record.intake;
    check(state);
    const subjectToken = selectCompositionalRetrievalSubjectIndexV3(
      record.token,
      edgeId,
      state.scope,
      () => check(state),
    );
    const view = getOwnedCompositionalSnapshotV3(subjectToken);
    if (!view) throw new ResourceFailure('invalid_snapshot');
    const cached = record.tools.get(view.subjectId);
    if (cached) return cached;
    const literal = createLiteralV1SemanticOverlapPrivateProjectorV1(subjectToken, {
      now: Date.parse(record.now),
      check: () => check(state),
    });
    if (!literal) throw new ResourceFailure('invalid_snapshot');
    const tools = {
      view,
      literal,
      compositional: createCompositionalQualifiedClaimReadPrivateProjectorV3(
        subjectToken,
        record.now,
        () => check(state),
      ),
    };
    record.tools.set(view.subjectId, tools);
    return tools;
  }

  const readLiteralContextData = (token: unknown, edgeValue: unknown): AutomaticClaimReadResult => {
    const record = sessionFor(token);
    if (!record) return { status: 'invalid', reason: 'invalid_context' };
    const state = record.intake;
    try {
      check(state);
      if (typeof edgeValue !== 'string' || edgeValue.length !== 36)
        return { status: 'invalid', reason: 'invalid_context' };
      if (!record.requested.has(edgeValue) && record.requested.size >= 128)
        return { status: 'deferred', reason: 'budget_exhausted' };
      record.requested.add(edgeValue);
      const root = getOwnedCompositionalRetrievalSnapshotV3(record.token);
      const edge = root?.edge(edgeValue);
      if (!edge) return { status: 'invalid', reason: 'missing_edge' };
      if (version(edge.attributes.engram_claim_v1) !== 1)
        return { status: 'invalid', reason: 'invalid_claim' };
      const tools = toolsFor(record, edgeValue);
      let projection = record.projections.get(edgeValue);
      if (!projection) {
        if (
          record.counted.has(edgeValue) ||
          record.counted.size >= 128 ||
          !beginAutomaticClaimReadAttempt(state.scope)
        )
          return { status: 'deferred', reason: 'budget_exhausted' };
        record.counted.add(edgeValue);
        const remaining =
          getAutomaticClaimReadScopeRemaining(state.scope)?.contextBytesRemaining ?? 0;
        const limit = Math.min(512 * 1024, remaining);
        const payload = edge.attributes.engram_claim_v1 as { sourceId?: unknown };
        const source =
          typeof payload.sourceId === 'string' && payload.sourceId.length === 36
            ? tools.view.episode(payload.sourceId)
            : undefined;
        charge(
          record,
          boundedAutomaticClaimReadJsonBytes(
            {
              edge,
              subject: tools.view.subject,
              value: tools.view.entity(edge.target_node_uuid) ?? null,
              source: source ?? null,
              operations: source ? tools.view.operationsForSource(source.uuid) : [],
            },
            limit,
          ),
          remaining,
          limit,
        );
        const literal = tools.literal.projectCandidate(edgeValue, limit);
        if (!literal || literal.capacityExceeded)
          return { status: 'invalid', reason: 'context_too_large' };
        projection = { family: 'v1', literal, limit };
        record.projections.set(edgeValue, projection);
      }
      if (projection.family !== 'v1') return { status: 'invalid', reason: 'invalid_claim' };
      const result = tools.view.projectLiteralCommitContext(edgeValue, projection.limit).result;
      check(state);
      return result;
    } catch (error) {
      if (state.aborted) throw state.abort;
      if (error instanceof ResourceFailure)
        return { status: 'deferred', reason: 'budget_exhausted' };
      return { status: 'invalid', reason: 'invalid_context' };
    }
  };

  function inspectSubject(record: Session, edgeId: string): void {
    const state = record.intake;
    check(state);
    const { view, literal, compositional } = toolsFor(record, edgeId);
    if (record.subjects.has(view.subjectId)) return;
    // A subject is published only after its complete actor-unfiltered universe was inspected.
    record.subjects.set(view.subjectId, 'incomplete_subject');
    try {
      if (
        view.candidates.length > 128 ||
        record.counted.size +
          view.candidates.filter((edge) => !record.counted.has(edge.uuid)).length >
          128
      )
        throw new ResourceFailure('capacity');
      for (const edge of view.candidates) {
        check(state);
        if (record.projections.has(edge.uuid)) continue;
        if (!beginAutomaticClaimReadAttempt(state.scope))
          throw new ResourceFailure('budget_exhausted');
        record.counted.add(edge.uuid);
        const remaining =
          getAutomaticClaimReadScopeRemaining(state.scope)?.contextBytesRemaining ?? 0;
        const limit = Math.min(512 * 1024, remaining);
        // Account for located rows before interpretation, including cancellation.
        // This byte walk establishes no evidence or current eligibility.
        const metadata = edge.attributes.engram_claim_v1 as { sourceId?: unknown } | undefined;
        const locatedSource =
          typeof metadata?.sourceId === 'string' && metadata.sourceId.length === 36
            ? view.episode(metadata.sourceId)
            : undefined;
        const inspectedBytes = boundedAutomaticClaimReadJsonBytes(
          {
            edge,
            subject: view.subject,
            value: view.entity(edge.target_node_uuid) ?? null,
            source: locatedSource ?? null,
            operations: locatedSource ? view.operationsForSource(locatedSource.uuid) : [],
          },
          limit,
        );
        charge(record, inspectedBytes, remaining, limit);
        if (version(edge.attributes.engram_claim_v1) === 2) {
          const projected = compositional.projectCandidate(edge.uuid, limit);
          const result = projected.result;
          if (
            result.status === 'invalid' &&
            ['context_too_large', 'proof_too_large', 'ambiguous_operation'].includes(result.reason)
          )
            throw new ResourceFailure(
              result.reason === 'ambiguous_operation' ? 'ambiguous_qualification' : 'capacity',
            );
          if (result.status === 'valid_data') {
            const claim = CompositionalAutomaticClaimMetadataV2Schema.parse(
              result.context.edge.attributes.engram_claim_v1,
            );
            record.projections.set(edge.uuid, {
              family: 'v3',
              qualified: result,
              meaning: claim.meaning,
            });
          } else record.projections.set(edge.uuid, { family: 'v3' });
        } else {
          const projected = literal.projectCandidate(edge.uuid, limit);
          if (!projected) throw new ResourceFailure('invalid_snapshot');
          if (projected.capacityExceeded) throw new ResourceFailure('capacity');
          const payload = edge.attributes.engram_claim_v1 as { sourceId?: unknown } | undefined;
          const source =
            typeof payload?.sourceId === 'string' ? view.episode(payload.sourceId) : undefined;
          if (
            source &&
            Object.prototype.hasOwnProperty.call(source.attributes, 'engram_write_owner_v2') &&
            view.operationsForSource(source.uuid).length > 1
          )
            throw new ResourceFailure('ambiguous_qualification');
          record.projections.set(edge.uuid, { family: 'v1', literal: projected, limit });
        }
      }
      const accepted = view.candidates
        .map((edge) => ({ edge, projection: record.projections.get(edge.uuid)! }))
        .filter(
          (
            entry,
          ): entry is {
            edge: typeof entry.edge;
            projection: Extract<Projection, { family: 'v3' }> & {
              qualified: Qualified;
              meaning: CompositionalAutomaticClaimMeaningV2;
            };
          } =>
            entry.projection.family === 'v3' &&
            entry.projection.qualified?.currentReview === 'accepted' &&
            !!entry.projection.meaning &&
            entry.projection.meaning.bundles[0].rootPaths.length === 1,
        );
      for (const { edge, projection } of accepted) {
        for (const other of view.candidates) {
          check(state);
          if (other.uuid === edge.uuid) continue;
          const alternative = record.projections.get(other.uuid)!;
          if (alternative.family === 'v3') {
            if (
              alternative.qualified?.currentReview !== 'accepted' ||
              !alternative.meaning ||
              alternative.meaning.bundles[0].rootPaths.length !== 1
            )
              continue;
            const compared = compareCompositionalMeaningOverlapDomainV1(
              projection.meaning,
              alternative.meaning,
              () => check(state),
            );
            if (!compared.equivalent && compared.domain !== 'proven_disjoint')
              record.blocked.add(edge.uuid);
          } else {
            const inspection = alternative.literal.compare(projection.meaning);
            if (
              inspection.projection === 'unavailable' &&
              inspection.reasons.includes('inspection_capacity')
            )
              throw new ResourceFailure('capacity');
            if (inspection.reasons.includes('ambiguous_existing_ids'))
              throw new ResourceFailure('ambiguous_qualification');
            if (
              inspection.projection !== 'exact' ||
              inspection.oldCurrentEligibility !== 'eligible' ||
              inspection.currentReview !== 'accepted' ||
              inspection.canonicalMeaning.bundles[0].rootPaths.length !== 1
            )
              continue;
            if (inspection.equivalent || inspection.domain === 'proven_disjoint') continue;
            const compatibility = inspectLiteralCompositionalPairCompatibilityV1(
              { oldMeaning: inspection.canonicalMeaning, newMeaning: projection.meaning },
              () => check(state),
            );
            if (compatibility.status !== 'compatible_constraints') record.blocked.add(edge.uuid);
          }
        }
      }
      check(state);
      record.subjects.set(view.subjectId, null);
    } catch (error) {
      if (state.aborted) throw state.abort;
      const reason = error instanceof ResourceFailure ? error.reason : 'incomplete_subject';
      record.subjects.set(view.subjectId, reason);
    }
  }

  const readMany = (token: unknown, idsValue: unknown): CompositionalRetrievalReadResultV3 => {
    const record = sessionFor(token);
    if (!record) return fail('invalid_session');
    const state = record.intake;
    let attempted: string[] | undefined;
    const diagnose = () => {
      for (const id of attempted ?? []) {
        if (record.requested.has(id) && !record.diagnosed.has(id)) {
          state.budget.deferred++;
          record.diagnosed.add(id);
        }
      }
    };
    try {
      check(state);
      if (!Array.isArray(idsValue) || utilTypes.isProxy(idsValue) || idsValue.length > 128)
        return fail('invalid_input');
      let ids: unknown;
      try {
        ids = cloneBoundedAutomaticCaptureJson<{ ids: unknown }>(
          { ids: idsValue },
          'beginRequest',
        ).ids;
      } catch {
        return fail('invalid_input');
      }
      if (
        !Array.isArray(ids) ||
        ids.some(
          (id) =>
            typeof id !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id),
        ) ||
        new Set(ids).size !== ids.length
      )
        return fail('invalid_input');
      const root = getOwnedCompositionalRetrievalSnapshotV3(record.token);
      if (!root) return fail('invalid_snapshot');
      const requested = ids as string[];
      attempted = requested;
      if (record.requested.size + requested.filter((id) => !record.requested.has(id)).length > 128)
        return fail('capacity');
      for (const id of requested) record.requested.add(id);
      for (const id of sorted(requested)) {
        check(state);
        const edge = root.edge(id);
        if (
          edge &&
          edge.group_id === state.namespace &&
          version(edge.attributes.engram_claim_v1) === 2
        )
          inspectSubject(record, id);
      }
      let resultBytes = 0;
      const entries: CompositionalRetrievalOutcomeV3[] = [];
      for (const edgeId of requested) {
        check(state);
        const edge = root.edge(edgeId),
          projection = record.projections.get(edgeId);
        let result: CompositionalRetrievalOutcomeV3;
        const incomplete = edge ? record.subjects.get(edge.source_node_uuid) : undefined;
        if (!edge || edge.group_id !== state.namespace)
          result = { status: 'hidden', edgeId, reason: 'missing_edge' };
        else if (incomplete) result = { status: 'deferred', edgeId, reason: incomplete };
        else if (version(edge.attributes.engram_claim_v1) !== 2)
          result = { status: 'hidden', edgeId, reason: 'unsupported_family' };
        else if (
          projection?.family !== 'v3' ||
          !projection.qualified ||
          projection.qualified.currentReview !== 'accepted' ||
          !projection.meaning
        )
          result = { status: 'hidden', edgeId, reason: 'not_current_qualified' };
        else if (projection.meaning.bundles[0].rootPaths.length > 1)
          result = { status: 'deferred', edgeId, reason: 'internal_consistency_unproved' };
        else if (record.blocked.has(edgeId))
          result = { status: 'hidden', edgeId, reason: 'unresolved_overlap' };
        else {
          const qualified = projection.qualified,
            context = qualified.context;
          const candidate: CompositionalRetrievalEntryV3 = {
            status: 'qualified_current_data',
            edgeId,
            semanticKey: (context.edge.attributes.engram_claim_v1 as { key: string }).key,
            namespace: state.namespace,
            subject: { id: context.subject.uuid, name: context.subject.name },
            meaning: projection.meaning,
            lexicalForm: context.edge.fact,
            provenance: {
              sourceId: context.source.uuid,
              operationId: context.proof.operationId,
              terminalAt: context.proof.terminalReceipt.terminalAt,
              creationReview: qualified.creationReview,
              currentReview: 'accepted',
              reviewedAt:
                extractionMetadataFromAttributes(context.edge.attributes)?.reviewed_at ?? null,
              reviewedBy:
                extractionMetadataFromAttributes(context.edge.attributes)?.reviewed_by ?? null,
              sourceMessageId: context.source.source_message_id ?? null,
              conversationId: context.source.conversation_id ?? null,
              senderId: context.source.sender_id ?? null,
              senderName: context.source.sender_name ?? null,
              referenceTime: context.source.reference_time,
              sourceWorkflowId: context.source.source_workflow_id ?? null,
              sourceExecutionId: context.source.source_execution_id ?? null,
              sourceRole: 'human',
              episodeKind: context.source.episode_kind,
              sourceTrust: context.source.trust_level,
            },
          };
          const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
          result =
            bytes > 48 * 1024
              ? { status: 'deferred', edgeId, reason: 'capacity' }
              : CompositionalRetrievalEntryV3Schema.parse(candidate);
        }
        if (result.status !== 'qualified_current_data' && !record.diagnosed.has(edgeId)) {
          state.budget.deferred++;
          record.diagnosed.add(edgeId);
        }
        resultBytes += Buffer.byteLength(JSON.stringify(result), 'utf8');
        if (resultBytes > 512 * 1024) throw new ResourceFailure('capacity');
        entries.push(result);
      }
      const result = freeze(
        CompositionalRetrievalDataV3Schema.parse({
          status: 'data',
          entries,
          diagnostics: {
            inspectedCandidates: record.counted.size,
            samples: entries.slice(0, 8).map((entry) => ({
              edgeId: entry.edgeId,
              status: entry.status,
              ...(entry.status === 'qualified_current_data' ? {} : { reason: entry.reason }),
            })),
          },
        }),
      );
      if (
        Buffer.byteLength(JSON.stringify(result), 'utf8') > 512 * 1024 ||
        Buffer.byteLength(JSON.stringify(result.diagnostics), 'utf8') > 32768
      )
        throw new ResourceFailure('capacity');
      check(state);
      return result;
    } catch (error) {
      diagnose();
      if (state.aborted) throw state.abort;
      if (error instanceof ResourceFailure) return fail(error.reason);
      return fail('invalid_snapshot');
    }
  };
  return Object.freeze({
    begin,
    getScope,
    prepare,
    readMany,
    withOwnedSnapshotData,
    readLiteralContextData,
  });
}
