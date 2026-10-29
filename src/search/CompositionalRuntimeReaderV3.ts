import { types as utilTypes } from 'util';
import { performance } from 'perf_hooks';
import { z } from 'zod';
import type { IGraphStorage } from '../storage/IGraphStorage';
import type { AutomaticReadContext } from '../schemas/AutomaticRuntime.schema';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import type { PrivateAutonomousPersonalMemoryParentReaderV4 } from '../memory/AutonomousPersonalMemoryParentReaderV4';
import {
  getAutonomousPersonalMemoryParentReadStopV4,
  readAutonomousPersonalMemoryParentCompatibilityDataV4,
} from '../memory/AutonomousPersonalMemoryParentReaderV4';
import { CompositionalCaptureNamespaceV3Schema } from '../schemas/CompositionalCaptureNamespaceV3.schema';
import { CompositionalRetrievalSnapshotV3Schema } from '../schemas/CompositionalRetrievalSnapshotV3.schema';
import {
  CompositionalRuntimeParentLocatorV3Schema,
  CompositionalRuntimeParentDataV3Schema,
  CompositionalRuntimeHistoryLocatorV3Schema,
  type CompositionalRuntimeReadReasonV3,
  type CompositionalRuntimeReadFailureV3,
  type CompositionalRuntimeReaderV3,
  type CompositionalRuntimeLoadResultV3,
  type CompositionalRuntimeFactsResultV3,
  type CompositionalRuntimeParentResultV3,
  type CompositionalRuntimeLiteralResultV3,
  type CompositionalRuntimeHistoryResultV3,
  type CompositionalRuntimeCandidateResultV3,
  type CompositionalRuntimeLiteralDataResultV3,
  type CompositionalRuntimeNamespaceResultV3,
} from '../schemas/CompositionalRuntimeReaderV3.schema';
import {
  createCompositionalRetrievalSessionFactoryV3,
  type CompositionalRetrievalSessionFactoryV3,
} from './CompositionalRetrievalSessionV3';
import type { CompositionalRetrievalSessionV3 } from '../schemas/CompositionalRetrievalSessionV3.schema';
import type { OwnedCompositionalRetrievalSnapshotV3 } from '../extraction/CompositionalSnapshotIndexV3';
import { resolveCompositionalBatchResourcesV3 } from '../extraction/CompositionalOverlapBatchV3';
import { boundedAutomaticClaimReadJsonBytes } from '../extraction/AutomaticClaimCommitProof';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import {
  canUseAutomaticClaimReadScope,
  beginAutomaticClaimReadAttempt,
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  chargeAutomaticClaimContextBytes,
  type AutomaticClaimReadScope,
} from '../storage/AutomaticClaimReadScope';

class RuntimeFailure extends Error {
  constructor(readonly reason: CompositionalRuntimeReadReasonV3) {
    super(reason);
  }
}
type WorkState = {
  external: () => void;
  scope?: AutomaticClaimReadScope;
  internalStop?: () => 'invalid_reader' | 'budget_exhausted' | 'resource_exhausted' | null;
  aborted: boolean;
  abort?: unknown;
  expired: boolean;
  expiredReason?: 'budget_exhausted' | 'resource_exhausted' | 'invalid_reader';
};
type RuntimeRecord = {
  storage: IGraphStorage;
  compatibilityParentReader?: PrivateAutonomousPersonalMemoryParentReaderV4;
  namespace: string;
  backendNow: string;
  scope: AutomaticClaimReadScope;
  work: WorkState;
  factory: CompositionalRetrievalSessionFactoryV3;
  session: CompositionalRetrievalSessionV3;
  access: OwnedCompositionalRetrievalSnapshotV3;
  parents: Map<string, CompositionalRuntimeParentResultV3>;
  budget: SourceHydrationBudget;
  conflicts: { remaining: number };
};
const readers = new WeakMap<object, RuntimeRecord>();
const namespaceSchema = z.object({ namespace: CompositionalCaptureNamespaceV3Schema }).strict();
const fail = (reason: CompositionalRuntimeReadReasonV3): CompositionalRuntimeReadFailureV3 =>
  Object.freeze({ status: 'deferred', reason });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function externalCheck(work: WorkState) {
  if (work.aborted) throw work.abort;
  try {
    work.external();
  } catch (error) {
    work.aborted = true;
    work.abort = error;
    throw error;
  }
}
function checkWork(work: WorkState) {
  externalCheck(work);
  if (work.expired) {
    throw new RuntimeFailure(work.expiredReason ?? 'budget_exhausted');
  }
  const internalStop = work.internalStop?.();
  if (internalStop) {
    work.expired = true;
    work.expiredReason = internalStop;
    throw new RuntimeFailure(internalStop);
  }
  if (!work.scope || !canUseAutomaticClaimReadScope(work.scope)) {
    work.expired = true;
    work.expiredReason = 'budget_exhausted';
    throw new RuntimeFailure('budget_exhausted');
  }
}
function known(reader: unknown): RuntimeRecord | undefined {
  return reader && typeof reader === 'object' && !utilTypes.isProxy(reader)
    ? readers.get(reader)
    : undefined;
}
function recordFor(reader: unknown): RuntimeRecord {
  const record = known(reader);
  if (!record) throw new RuntimeFailure('invalid_reader');
  return record;
}
function mapped(error: unknown, record?: RuntimeRecord): CompositionalRuntimeReadFailureV3 {
  if (record?.work.aborted) throw record.work.abort;
  if (error instanceof RuntimeFailure) return fail(error.reason);
  if (record) {
    try {
      checkWork(record.work);
    } catch (failure) {
      if (record.work.aborted) throw record.work.abort;
      if (failure instanceof RuntimeFailure) return fail(failure.reason);
      throw failure;
    }
  }
  return fail('invalid_response');
}
function ownResources(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
    return null;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      keys.some((key) => key !== 'budget' && key !== 'check')
    )
      return null;
    const data: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      data[key as string] = descriptor.value;
    }
    return data;
  } catch {
    return null;
  }
}
function capability(storage: IGraphStorage): ((scope: AutomaticClaimReadScope) => unknown) | null {
  if (!storage || typeof storage !== 'object' || utilTypes.isProxy(storage)) return null;
  let value: object | null = storage;
  try {
    for (let depth = 0; value && depth < 16; depth++, value = Object.getPrototypeOf(value)) {
      if (utilTypes.isProxy(value)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(
        value,
        'readCompositionalRetrievalSnapshotV3',
      );
      if (!descriptor) continue;
      return 'value' in descriptor &&
        typeof descriptor.value === 'function' &&
        !utilTypes.isProxy(descriptor.value)
        ? descriptor.value
        : null;
    }
  } catch {
    return null;
  }
  return null;
}
function genuinePromise(value: unknown): value is Promise<unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !utilTypes.isPromise(value)
  )
    return false;
  try {
    if (
      Object.getOwnPropertyDescriptor(value, 'then') ||
      Object.getOwnPropertyDescriptor(value, 'constructor')
    )
      return false;
    const prototype = Object.getPrototypeOf(value);
    if (!prototype || utilTypes.isProxy(prototype)) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const then = Object.getOwnPropertyDescriptor(prototype, 'then');
    if (
      !constructor ||
      !('value' in constructor) ||
      typeof constructor.value !== 'function' ||
      utilTypes.isProxy(constructor.value) ||
      Function.prototype.toString.call(constructor.value) !==
        'function Promise() { [native code] }' ||
      constructor.value.prototype !== prototype ||
      !then ||
      !('value' in then) ||
      typeof then.value !== 'function' ||
      utilTypes.isProxy(then.value)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

/** Only this actual-capability loader registers runtime readers. No parsed JSON/data session can do so. */
export async function loadCompositionalRuntimeReaderV3(
  storage: IGraphStorage,
  config: unknown,
  resources: unknown,
): Promise<CompositionalRuntimeLoadResultV3> {
  let parsed;
  try {
    parsed = namespaceSchema.safeParse(cloneBoundedAutomaticCaptureJson(config, 'beginRequest'));
  } catch {
    return fail('invalid_input');
  }
  if (!parsed.success) return fail('invalid_input');
  const resourceData = ownResources(resources);
  if (!resourceData) return fail('invalid_resources');
  const resolved = resolveCompositionalBatchResourcesV3({
    budget: resourceData.budget,
    now: '2000-01-01T00:00:00.000Z',
    ...(resourceData.check === undefined ? {} : { check: resourceData.check }),
  });
  if (!resolved) return fail('invalid_resources');
  const work: WorkState = { external: resolved.check, aborted: false, expired: false };
  const factory = createCompositionalRetrievalSessionFactoryV3();
  let reader: CompositionalRuntimeReaderV3 | undefined;
  try {
    const begun = factory.begin(
      { namespace: parsed.data.namespace, mode: 'current' },
      { budget: resolved.budget, check: () => externalCheck(work) },
    );
    if (begun.status !== 'intake') return begun;
    const scope = factory.getScope(begun.intake);
    if (!scope) return fail('budget_exhausted');
    work.scope = scope;
    checkWork(work);
    const read = capability(storage);
    if (!read) return fail('missing_capability');
    let pending: unknown;
    try {
      pending = Reflect.apply(read, storage, [scope]);
    } catch {
      checkWork(work);
      return fail('storage_error');
    }
    if (!genuinePromise(pending)) return fail('invalid_response');
    let response: unknown;
    try {
      response = await pending;
    } catch {
      checkWork(work);
      return fail('storage_error');
    }
    checkWork(work);
    // This deliberate bounded facade validation is an additional ownership
    // clone, not snapshot I/O. Session preparation still owns one global index.
    const snapshot = CompositionalRetrievalSnapshotV3Schema.safeParse(response);
    checkWork(work);
    if (!snapshot.success) return fail('invalid_response');
    if (snapshot.data.status !== 'snapshot') return fail(snapshot.data.reason);
    const prepared = factory.prepare(begun.intake, {
      graph: snapshot.data.graph,
      backendNow: snapshot.data.backendNow,
    });
    checkWork(work);
    if (prepared.status !== 'prepared_data') return prepared;
    let access: OwnedCompositionalRetrievalSnapshotV3 | undefined;
    const inspected = factory.withOwnedSnapshotData(
      prepared.session,
      (owned: OwnedCompositionalRetrievalSnapshotV3) => {
        access = owned;
        return null;
      },
    );
    checkWork(work);
    if (inspected.status !== 'snapshot_data' || !access) return fail('invalid_response');
    reader = Object.freeze(Object.create(null)) as CompositionalRuntimeReaderV3;
    const result = Object.freeze({ status: 'ready' as const, reader });
    checkWork(work);
    readers.set(reader, {
      storage,
      namespace: parsed.data.namespace,
      backendNow: snapshot.data.backendNow,
      scope,
      work,
      factory,
      session: prepared.session,
      access,
      parents: new Map(),
      budget: resolved.budget,
      conflicts: { remaining: 128 },
    });
    checkWork(work);
    return result;
  } catch (error) {
    if (reader) readers.delete(reader);
    if (work.aborted) throw work.abort;
    if (error instanceof RuntimeFailure) return fail(error.reason);
    try {
      checkWork(work);
    } catch (failure) {
      if (work.aborted) throw work.abort;
      if (failure instanceof RuntimeFailure) return fail(failure.reason);
      throw failure;
    }
    return fail('invalid_response');
  }
}

/**
 * Fixed compatibility bridge for older compositional/V1/general reads. The actual
 * ParentReader owns the snapshot and its B1b index; this adapter adds only the existing
 * V3 pure clone/index over the same namespace DATA and original resource scope.
 */
export async function loadCompositionalCompatibilityRuntimeReaderV4(
  storageOwner: IGraphStorage,
  parentReader: PrivateAutonomousPersonalMemoryParentReaderV4,
  originalBudget: SourceHydrationBudget,
): Promise<CompositionalRuntimeLoadResultV3> {
  // Authenticate owner-bound ParentReader identity before inspecting caller budget data.
  let parentStop = getAutonomousPersonalMemoryParentReadStopV4(storageOwner, parentReader);
  if (parentStop) return fail(parentStop);

  const resolved = resolveCompositionalBatchResourcesV3({
    budget: originalBudget,
    now: '2000-01-01T00:00:00.000Z',
  });
  if (!resolved) return fail('invalid_resources');
  const scope = getAutomaticClaimReadScope(resolved.budget);
  const internalStop = () => parentStop;
  const work: WorkState = {
    external: () => {
      // ParentReadStop returns own stop as DATA. Only trusted external callback failures
      // escape here and are latched by externalCheck with their original identity.
      parentStop = getAutonomousPersonalMemoryParentReadStopV4(storageOwner, parentReader);
    },
    internalStop,
    scope,
    aborted: false,
    expired: false,
  };

  const retrievalStop = (): 'budget_exhausted' | 'capacity' | null => {
    if (parentStop === 'resource_exhausted') return 'capacity';
    if (parentStop === 'invalid_reader' || parentStop === 'budget_exhausted')
      return 'budget_exhausted';
    return null;
  };
  let reader: CompositionalRuntimeReaderV3 | undefined;
  try {
    checkWork(work);
    const parent = readAutonomousPersonalMemoryParentCompatibilityDataV4(
      storageOwner,
      parentReader,
      scope,
    );
    if (!parent) {
      // This also distinguishes an expired/closed parent from a valid token whose original
      // scope differs. Neither path may start the legacy factory.
      checkWork(work);
      return fail('invalid_reader');
    }
    checkWork(work);

    const factory = createCompositionalRetrievalSessionFactoryV3(retrievalStop);
    const begun = factory.begin(
      { namespace: parent.namespace, mode: 'current' },
      { budget: resolved.budget, check: () => externalCheck(work) },
    );
    checkWork(work);
    if (begun.status !== 'intake') return begun;

    const factoryScope = factory.getScope(begun.intake);
    checkWork(work);
    if (!factoryScope) return fail('budget_exhausted');
    if (factoryScope !== scope) return fail('invalid_reader');
    work.scope = scope;

    const prepared = factory.prepare(begun.intake, {
      graph: parent.graph,
      backendNow: parent.backendNow,
    });
    checkWork(work);
    if (prepared.status !== 'prepared_data') return prepared;

    let access: OwnedCompositionalRetrievalSnapshotV3 | undefined;
    const inspected = factory.withOwnedSnapshotData(
      prepared.session,
      (owned: OwnedCompositionalRetrievalSnapshotV3) => {
        access = owned;
        return null;
      },
    );
    checkWork(work);
    if (inspected.status !== 'snapshot_data' || !access) return fail('invalid_response');

    reader = Object.freeze(Object.create(null)) as CompositionalRuntimeReaderV3;
    const result = Object.freeze({ status: 'ready' as const, reader });
    checkWork(work);
    readers.set(reader, {
      storage: storageOwner,
      compatibilityParentReader: parentReader,
      namespace: parent.namespace,
      backendNow: parent.backendNow,
      scope,
      work,
      factory,
      session: prepared.session,
      access,
      parents: new Map(),
      budget: resolved.budget,
      conflicts: { remaining: 128 },
    });
    checkWork(work);
    return result;
  } catch (error) {
    if (reader) readers.delete(reader);
    if (work.aborted) throw work.abort;
    if (error instanceof RuntimeFailure) return fail(error.reason);
    try {
      checkWork(work);
    } catch (failure) {
      if (work.aborted) throw work.abort;
      if (failure instanceof RuntimeFailure) return fail(failure.reason);
      throw failure;
    }
    return fail('invalid_response');
  }
}

/** Fake/expired readers are false; an external cancellation retains its exact identity. */
export function isLiveCompositionalRuntimeReaderV3(reader: unknown): boolean {
  const record = known(reader);
  if (!record) return false;
  try {
    checkWork(record.work);
    return true;
  } catch (error) {
    if (record.work.aborted) throw record.work.abort;
    if (error instanceof RuntimeFailure) return false;
    throw error;
  }
}

/**
 * Fixed identity join for the V4 compatibility bridge. The predicate accepts only the
 * exact owner, parent token and runtime reader registered together by that bridge.
 */
export function isCompositionalCompatibilityRuntimeReaderV4(
  storageOwner: IGraphStorage,
  parentReader: PrivateAutonomousPersonalMemoryParentReaderV4,
  reader: unknown,
): boolean {
  const record = known(reader);
  if (
    !record ||
    record.storage !== storageOwner ||
    record.compatibilityParentReader !== parentReader
  ) {
    return false;
  }
  try {
    checkWork(record.work);
    return true;
  } catch (error) {
    if (record.work.aborted) throw record.work.abort;
    if (error instanceof RuntimeFailure) return false;
    throw error;
  }
}

/** Conservative absolute monotonic allowance only; it cannot extend or recreate the original scope. */
export function getCompositionalRuntimeRequestAllowanceV3(
  reader: unknown,
): Readonly<{ deadlineAt: number }> | null {
  const record = known(reader);
  if (!record) return null;
  try {
    checkWork(record.work);
    const sampledBefore = performance.now();
    const remaining = getAutomaticClaimReadScopeRemaining(record.scope);
    if (!remaining) return null;
    const deadlineAt = sampledBefore + remaining.deadlineRemainingMs;
    const allowance = Object.freeze({ deadlineAt });
    checkWork(record.work);
    return performance.now() < deadlineAt ? allowance : null;
  } catch (error) {
    if (record.work.aborted) throw record.work.abort;
    return null;
  }
}

/** Resource accounting only: every opt-in consumer shares this reader's original counters. */
export function getCompositionalRuntimeAutomaticReadContextV3(
  reader: unknown,
  view: unknown = { mode: 'current' },
): AutomaticReadContext | null {
  const record = known(reader);
  if (!record) return null;
  try {
    checkWork(record.work);
    const parsed = z
      .object({
        mode: z.enum(['current', 'historical', 'asOf']),
        at: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .safeParse(cloneBoundedAutomaticCaptureJson(view, 'beginRequest'));
    if (!parsed.success) return null;
    checkWork(record.work);
    return { ...parsed.data, sources: record.budget, conflicts: record.conflicts };
  } catch (error) {
    if (record.work.aborted) throw record.work.abort;
    return null;
  }
}
export function readCompositionalRuntimeFactsV3(
  reader: unknown,
  edgeIds: unknown,
): CompositionalRuntimeFactsResultV3 {
  let record: RuntimeRecord | undefined;
  try {
    record = recordFor(reader);
    checkWork(record.work);
    const result = record.factory.readMany(record.session, edgeIds);
    checkWork(record.work);
    return freeze(result);
  } catch (error) {
    return mapped(error, record);
  }
}
export function readCompositionalRuntimeLiteralContextV3(
  reader: unknown,
  edgeId: unknown,
): CompositionalRuntimeLiteralResultV3 {
  let record: RuntimeRecord | undefined;
  try {
    record = recordFor(reader);
    checkWork(record.work);
    const result = record.factory.readLiteralContextData(record.session, edgeId);
    checkWork(record.work);
    return freeze(result);
  } catch (error) {
    return mapped(error, record);
  }
}
export function getCompositionalRuntimeParentDataV3(
  reader: unknown,
  locator: unknown,
): CompositionalRuntimeParentResultV3 {
  let record: RuntimeRecord | undefined;
  try {
    record = recordFor(reader);
    checkWork(record.work);
    let requested;
    try {
      requested = CompositionalRuntimeParentLocatorV3Schema.safeParse(
        cloneBoundedAutomaticCaptureJson(locator, 'beginRequest'),
      );
    } catch {
      return fail('invalid_input');
    }
    if (!requested.success) return fail('invalid_input');
    if (requested.data.namespace !== record.namespace) return fail('locator_mismatch');
    const id = requested.data.capturedSourceId;
    let cached = record.parents.get(id);
    if (!cached) {
      if (record.parents.size >= 128 || !beginAutomaticClaimReadAttempt(record.scope))
        return fail('budget_exhausted');
      const source = record.access.episode(id);
      const operations = record.access.operationsForSource(id);
      const operation =
        operations.length === 1 && operations[0].version === 3 ? operations[0] : undefined;
      const capturedBinding = operation?.identity.binding;
      const subject = capturedBinding ? record.access.entity(capturedBinding.subjectId) : undefined;
      const currentBinding = operation
        ? record.access.currentBinding(
            operation.identity.namespace,
            operation.identity.issuer,
            operation.identity.actorReference,
          )
        : null;
      const remaining =
        getAutomaticClaimReadScopeRemaining(record.scope)?.contextBytesRemaining ?? 0;
      const limit = Math.min(512 * 1024, remaining);
      const candidate = {
        status: 'parent_data' as const,
        namespace: record.namespace,
        backendNow: record.backendNow,
        source,
        operation,
        subject,
        capturedBinding,
        currentBinding,
      };
      const inspected =
        source && operation && subject && capturedBinding
          ? candidate
          : {
              source: source ?? null,
              operations,
              subject: subject ?? null,
              capturedBinding: capturedBinding ?? null,
              currentBinding,
            };
      const bytes = boundedAutomaticClaimReadJsonBytes(inspected, limit);
      if (
        !chargeAutomaticClaimContextBytes(record.scope, Math.min(bytes, remaining)) ||
        bytes > limit
      )
        cached = fail(remaining < 512 * 1024 ? 'budget_exhausted' : 'capacity');
      else if (!source) cached = fail('missing_source');
      else if (operations.length !== 1)
        cached = fail(operations.length ? 'ambiguous_operation' : 'missing_operation');
      else if (!operation) cached = fail('unsupported_parent');
      else if (!subject || subject.group_id !== record.namespace) cached = fail('missing_subject');
      else {
        const data = CompositionalRuntimeParentDataV3Schema.safeParse(candidate);
        cached = data.success ? freeze(data.data) : fail('invalid_context');
      }
      checkWork(record.work);
      record.parents.set(id, cached);
    }
    checkWork(record.work);
    if (cached.status !== 'parent_data') return cached;
    const identity = cached.operation.identity;
    if (
      identity.sourceId !== id ||
      identity.namespace !== requested.data.namespace ||
      identity.issuer !== requested.data.issuer ||
      identity.actorReference !== requested.data.actorReference ||
      identity.turn !== requested.data.turn ||
      cached.source.group_id !== record.namespace
    )
      return fail('locator_mismatch');
    return cached;
  } catch (error) {
    return mapped(error, record);
  }
}

/** Fixed observations from the owned root. Only the fixed qualifier may turn these into governed hits. */
export function getCompositionalRuntimeCandidateDataV3(
  reader: unknown,
  edgeId: unknown,
): CompositionalRuntimeCandidateResultV3 {
  let record: RuntimeRecord | undefined;
  try {
    record = recordFor(reader);
    checkWork(record.work);
    if (typeof edgeId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(edgeId))
      return fail('invalid_input');
    const edge = record.access.edge(edgeId);
    if (!edge) return fail('missing_edge');
    const subject = record.access.entity(edge.source_node_uuid),
      value = record.access.entity(edge.target_node_uuid);
    if (!subject || !value) return fail('invalid_context');
    const result = Object.freeze({ status: 'candidate_data' as const, edge, subject, value });
    checkWork(record.work);
    return result;
  } catch (error) {
    return mapped(error, record);
  }
}

/** Fixed literal bridge: same cache/reservation as consistency, no caller context or storage facade. */
export function getCompositionalRuntimeLiteralDataV3(
  reader: unknown,
  edgeId: unknown,
): CompositionalRuntimeLiteralDataResultV3 {
  let record: RuntimeRecord | undefined;
  try {
    record = recordFor(reader);
    checkWork(record.work);
    const data = getCompositionalRuntimeCandidateDataV3(reader, edgeId);
    if (data.status !== 'candidate_data') return data;
    const claim = data.edge.attributes.engram_claim_v1;
    if (!claim || typeof claim !== 'object' || (claim as { version?: unknown }).version !== 1)
      return fail('unsupported_family');
    const sourceId = (claim as { sourceId?: unknown }).sourceId;
    const source = typeof sourceId === 'string' ? record.access.episode(sourceId) : undefined;
    const proof = record.factory.readLiteralContextData(record.session, data.edge.uuid);
    checkWork(record.work);
    if (proof.status === 'deferred') return fail('budget_exhausted');
    if (
      proof.status === 'invalid' &&
      ['context_too_large', 'proof_too_large'].includes(proof.reason)
    )
      return fail('capacity');
    if (!source) return fail('missing_source');
    const related = record.access.edgesBetween(
      data.edge.source_node_uuid,
      data.edge.target_node_uuid,
      129,
    );
    const result = Object.freeze({
      status: 'literal_data' as const,
      edge: data.edge,
      subject: data.subject,
      value: data.value,
      source,
      proof,
      related,
    });
    checkWork(record.work);
    return result;
  } catch (error) {
    return mapped(error, record);
  }
}

/** Namespace candidate data only; claim and parent proofs continue to use the unscoped owned root. */
export function getCompositionalRuntimeNamespaceDataV3(
  reader: unknown,
): CompositionalRuntimeNamespaceResultV3 {
  let record: RuntimeRecord | undefined;
  try {
    record = recordFor(reader);
    checkWork(record.work);
    const root = record.access.graph;
    const rows = <T extends { group_id: string }>(actual: readonly T[]): T[] => {
      const selected: T[] = [];
      for (const row of actual) {
        checkWork(record!.work);
        if (row.group_id === record!.namespace) selected.push(row);
      }
      Object.freeze(selected);
      checkWork(record!.work);
      return selected;
    };
    const entities = rows(root.entities),
      edges = rows(root.edges),
      episodes = rows(root.episodes);
    const ledger = root.automatic_operations_v1;
    const operations: NonNullable<typeof ledger>['operations'] = [];
    if (ledger)
      for (const operation of ledger.operations) {
        checkWork(record.work);
        if (operation.identity.namespace === record.namespace) operations.push(operation);
      }
    Object.freeze(operations);
    checkWork(record.work);
    const graph = Object.freeze({
      ...root,
      group_id: record.namespace,
      entities,
      edges,
      episodes,
      ...(ledger ? { automatic_operations_v1: Object.freeze({ ...ledger, operations }) } : {}),
    });
    const result = Object.freeze({ status: 'namespace_data' as const, graph });
    checkWork(record.work);
    return result;
  } catch (error) {
    return mapped(error, record);
  }
}

/** Observed chat data only. The fixed Memory parent guard must run before this accessor. */
export function getCompositionalRuntimeHistoryDataV3(
  reader: unknown,
  locator: unknown,
): CompositionalRuntimeHistoryResultV3 {
  let record: RuntimeRecord | undefined;
  try {
    record = recordFor(reader);
    checkWork(record.work);
    let requested;
    try {
      requested = CompositionalRuntimeHistoryLocatorV3Schema.safeParse(
        cloneBoundedAutomaticCaptureJson(locator, 'beginRequest'),
      );
    } catch {
      return fail('invalid_input');
    }
    if (!requested.success) return fail('invalid_input');
    if (requested.data.namespace !== record.namespace) return fail('locator_mismatch');
    const episodes = [];
    for (const episode of record.access.graph.episodes) {
      checkWork(record.work);
      if (episode.group_id === record.namespace) episodes.push(episode);
    }
    const result = Object.freeze({
      status: 'history_data' as const,
      episodes: Object.freeze(episodes.slice(-requested.data.limit)),
    });
    checkWork(record.work);
    return result;
  } catch (error) {
    return mapped(error, record);
  }
}
