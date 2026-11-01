import {
  currentAutonomousPersonalExecutionScopeWorkV1,
  runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1,
} from '../storage/AutonomousPersonalExecutionScopeV1';
import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { AutonomousPersonalClaimV3OwnedDataSchema } from '../schemas/AutonomousPersonalClaimV3.schema';
import { AutonomousPersonalQualifiedClaimEdgeIdV4Schema } from '../schemas/AutonomousPersonalQualifiedClaimV4.schema';
import {
  AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema,
  type AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data,
} from '../schemas/AutonomousPersonalMemoryParentQualifiedClaimCandidateV4.schema';
import { extractionMetadataFromAttributes } from '../schemas/ExtractionMetadata.schema';
import {
  AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema,
  type AutonomousPersonalNativeMemoryConfigV4,
} from '../schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalNativeOriginV4 } from '../schemas/AutonomousPersonalNativeOriginV4.schema';
import {
  AutonomousPersonalMemoryParentReaderV4RejectedDataSchema,
  type AutonomousPersonalMemoryParentReaderV4Reason,
  type AutonomousPersonalMemoryParentReaderV4RejectedData,
} from '../schemas/AutonomousPersonalMemoryParentReaderV4.schema';
import {
  compileAutonomousPersonalDescriptorV4,
  hashAutonomousPersonalDescriptorV4,
} from '../schemas/AutonomousPersonalDescriptorV4.schema';
import { InternalImmutableCompositionalRetrievalSnapshotV3Schema as CompositionalRetrievalSnapshotV3Schema } from '../schemas/CompositionalRetrievalSnapshotV3.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { GraphData } from '../schemas/GraphData.schema';
import type {
  AutonomousPersonalMemoryCompatibilityDataV4,
  AutonomousPersonalMemoryReadStopV4,
} from '../schemas/AutonomousPersonalMemoryCompatibilityV4.schema';
import type { AutonomousPersonalCaptureReceiptSummaryV4 } from '../schemas/AutonomousPersonalCaptureReceiptSummaryV4.schema';
import { boundedAutomaticClaimReadJsonBytes } from '../extraction/AutomaticClaimCommitProof';
import {
  getAutonomousPersonalClaimIndexCandidateRowsV4,
  getAutonomousPersonalClaimIndexGraphV4,
  qualifyAutonomousPersonalClaimCreatorV4,
  type AutonomousPersonalClaimIndexV4,
} from '../extraction/AutonomousPersonalQualifiedClaimV4';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../extraction/AutonomousPersonalTypedSyntaxV1';
import {
  canUseAutomaticClaimReadScope,
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScopeRemaining,
  type AutomaticClaimReadScope,
} from '../storage/AutomaticClaimReadScope';
import { assertAutomaticLedgerSourceIntegrity } from '../storage/AutomaticIdentity';
import {
  AutonomousPersonalRecordIntegrityV4Error,
  createIntegrityCheckedAutonomousPersonalClaimIndexV4,
} from '../storage/AutonomousPersonalRecordIntegrityV4';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject,
} from '../storage/BoundedAutomaticCaptureJson';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  getAutonomousPersonalMemoryLineageOriginV4,
  type PrivateAutonomousPersonalMemoryLineageV4,
} from './AutonomousPersonalNativeMemoryHandoffV4';
import { projectAutonomousPersonalCaptureReceiptSummaryV4 } from './AutonomousPersonalCaptureReceiptSummaryV4';
import {
  assertAutonomousPersonalMemoryCurrentParentGraphV4,
  AutonomousPersonalMemoryParentIntegrityV4Error,
} from '../storage/AutonomousPersonalMemoryParentIntegrityV4';

declare const memoryParentReaderV4Brand: unique symbol;

/** Opaque, empty, owner-bound token. It is DATA access only, never model/write permission. */
export type PrivateAutonomousPersonalMemoryParentReaderV4 = object & {
  readonly [memoryParentReaderV4Brand]: 'memory_parent_reader';
};

export type AutonomousPersonalMemoryParentOpenV4Result =
  | Readonly<{ kind: 'reader_ready'; reader: PrivateAutonomousPersonalMemoryParentReaderV4 }>
  | AutonomousPersonalMemoryParentReaderV4RejectedData;

export interface AutonomousPersonalMemoryParentReaderV4Resources {
  readonly scope: AutomaticClaimReadScope;
  readonly work: AutonomousPersonalTypedSyntaxWorkV1;
  readonly check: () => void;
}

type Reason = AutonomousPersonalMemoryParentReaderV4Reason;

/** One record per live reader: the exact checked index and its already-frozen owned root. */
interface ParentReaderRecord {
  readonly index: AutonomousPersonalClaimIndexV4;
  readonly graph: GraphData;
  readonly backendNow: string;
  readonly origin: AutonomousPersonalNativeOriginV4;
  readonly config: AutonomousPersonalNativeMemoryConfigV4;
  readonly work: AutonomousPersonalTypedSyntaxWorkV1;
  readonly check: () => void;
  readonly scope: AutomaticClaimReadScope;
  readonly counter: ParentReaderCounter;
}

/** Code-owned mutable resource counter; the record holding it stays frozen. */
interface ParentReaderCounter {
  remaining: number;
  bytesRemaining: number;
  stopReason: null | 'resource_exhausted';
  preimageRemaining: number;
  readonly rowHashes: Map<string, string>;
}

const CANDIDATE_READ_LIMIT = 200;
const CANDIDATE_AGGREGATE_BYTES = 512 * 1024;
const CANDIDATE_MAX_BYTES = 48 * 1024;
const ROW_PREIMAGE_MAX_BYTES = 512 * 1024;
const ROW_PREIMAGE_AGGREGATE_BYTES = 8 * 1024 * 1024;
const REFERENCE_TIME_MAX_LENGTH = 64;
const EDGE_CLAIM_ATTRIBUTE = 'engram_claim_v1';

interface CheckState {
  failed: boolean;
  failure: unknown;
}

const nativeAbortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

// owner -> reader -> record. The owner is only a WeakMap key; no second graph copy is kept.
const recordsByOwner = new WeakMap<object, WeakMap<object, ParentReaderRecord>>();

class ParentReject {
  constructor(readonly reason: Reason) {}
}

function reject(reason: Reason): never {
  throw new ParentReject(reason);
}

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';

function rejected(reason: Reason): AutonomousPersonalMemoryParentOpenV4Result {
  return Object.freeze(
    AutonomousPersonalMemoryParentReaderV4RejectedDataSchema.parse({ kind: 'rejected', reason }),
  );
}

function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function isBoundedCapacity(error: unknown): boolean {
  return (
    error instanceof BoundedAutomaticCaptureJsonError &&
    (error.reason === 'bytes' || error.reason === 'nodes' || error.reason === 'depth')
  );
}

/**
 * Map an unexpected failure. A trusted external check failure always wins and is
 * rethrown with its exact identity (including a thrown `undefined`).
 */
function mapFailure(state: CheckState, error: unknown, fallback: Reason): never {
  if (state.failed) throw state.failure;
  if (error instanceof AutonomousPersonalMemoryParentIntegrityV4Error) reject(error.reason);
  if (error instanceof ParentReject) throw error;
  if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) {
    if (error.reason === 'internal') reject('invalid_configuration');
    reject(
      String(error.reason) === 'cancelled' || String(error.reason) === 'deadline'
        ? 'budget_exhausted'
        : fallback,
    );
  }
  if (error instanceof AutonomousPersonalRecordIntegrityV4Error) {
    reject(error.reason === 'snapshot_capacity' ? 'resource_exhausted' : 'invalid_snapshot');
  }
  if (isBoundedCapacity(error)) reject('resource_exhausted');
  return reject(fallback);
}

interface WorkView {
  readonly deadline: number;
  readonly signal: AbortSignal;
}

function readWork(value: unknown): WorkView | null {
  try {
    if (
      !isObject(value) ||
      utilTypes.isProxy(value) ||
      !isNativePlainAutomaticCaptureObject(value) ||
      nativeAbortedGetter === undefined
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal')
    ) {
      return null;
    }
    const deadline = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
    const signal = Object.getOwnPropertyDescriptor(value, 'signal');
    if (
      !deadline ||
      !signal ||
      !('value' in deadline) ||
      !('value' in signal) ||
      typeof deadline.value !== 'number' ||
      !Number.isFinite(deadline.value) ||
      !isObject(signal.value) ||
      utilTypes.isProxy(signal.value)
    ) {
      return null;
    }
    nativeAbortedGetter.call(signal.value);
    return { deadline: deadline.value, signal: signal.value as AbortSignal };
  } catch {
    return null;
  }
}

/** True when the native signal or absolute work deadline is known to be spent. */
function workSpent(view: WorkView): boolean {
  try {
    if (nativeAbortedGetter === undefined || nativeAbortedGetter.call(view.signal)) return true;
    const now = performance.now();
    return !Number.isFinite(now) || now >= view.deadline;
  } catch {
    return true;
  }
}

function scopeSpent(scope: AutomaticClaimReadScope): boolean {
  try {
    return !canUseAutomaticClaimReadScope(scope);
  } catch {
    return true;
  }
}

/** One sticky check over the original scope, work and trusted resource callback. */
function createStickyCheck(
  state: CheckState,
  view: WorkView,
  scope: AutomaticClaimReadScope,
  trusted: () => void,
): () => void {
  // Own budget stops latch separately from the external-failure flag in `state`.
  let budgetSpent = false;
  const nativeCheck = () => {
    if (budgetSpent || workSpent(view) || scopeSpent(scope)) {
      budgetSpent = true;
      reject('budget_exhausted');
    }
  };
  return () => {
    if (state.failed) throw state.failure;
    nativeCheck();
    try {
      trusted();
    } catch (error) {
      state.failed = true;
      state.failure = error;
      throw error;
    }
    nativeCheck();
  };
}

function tuplesMatch(
  origin: AutonomousPersonalNativeOriginV4,
  config: AutonomousPersonalNativeMemoryConfigV4,
): boolean {
  const identity = origin.identity;
  return (
    origin.instance === config.native.instance &&
    origin.workflow === config.native.workflow &&
    origin.execution === config.native.execution &&
    identity.storeHash === config.storeHash &&
    identity.namespace === config.namespace &&
    identity.issuer === config.issuer &&
    identity.actorReference === config.actorReference &&
    identity.turn === config.turn &&
    identity.sourceId === config.sourceId
  );
}

function ownConfig(value: unknown): AutonomousPersonalNativeMemoryConfigV4 {
  let owned: unknown;
  try {
    owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  } catch (error) {
    return reject(isBoundedCapacity(error) ? 'resource_exhausted' : 'invalid_configuration');
  }
  const parsed = AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.safeParse(owned);
  if (!parsed.success) return reject('invalid_configuration');
  return deepFreeze(parsed.data);
}

function compileCurrentDescriptor(config: AutonomousPersonalNativeMemoryConfigV4) {
  try {
    return compileAutonomousPersonalDescriptorV4({
      profileId: config.profileId,
      requestedTrustLevel: 'standard',
      intentSetting: config.explicitIntent,
      invocationDeadlineMs: config.invocationDeadlineMs,
      ...(config.executionBudget === undefined ? {} : { executionBudget: config.executionBudget }),
      providerReference: config.providerReference,
    });
  } catch {
    return reject('invalid_configuration');
  }
}

function mapSnapshotFailure(
  result: Exclude<
    ReturnType<typeof CompositionalRetrievalSnapshotV3Schema.parse>,
    { status: 'snapshot' }
  >,
): never {
  if (result.status === 'deferred') {
    reject(result.reason === 'budget_exhausted' ? 'budget_exhausted' : 'resource_exhausted');
  }
  if (result.status === 'unavailable') reject('storage_unavailable');
  return reject(result.reason === 'invalid_scope' ? 'invalid_configuration' : 'invalid_snapshot');
}

async function openInner(
  storageOwner: IGraphStorage,
  lineage: PrivateAutonomousPersonalMemoryLineageV4,
  configValue: AutonomousPersonalNativeMemoryConfigV4,
  resourcesValue: AutonomousPersonalMemoryParentReaderV4Resources,
  state: CheckState,
): Promise<AutonomousPersonalMemoryParentOpenV4Result> {
  // 1. Authenticate the lineage before inspecting config, resources or backend.
  const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
  if (!origin) return reject('invalid_lineage');

  const config = ownConfig(configValue);
  if (!tuplesMatch(origin, config)) return reject('parent_mismatch');
  const wrapper = config.sourceMapping.mode === 'application_region';
  if (
    (wrapper && config.rawHumanContent === undefined) ||
    (config.rawHumanContent !== undefined && config.rawHumanContent !== config.currentHumanQuery)
  ) {
    return reject('parent_mismatch');
  }
  // Zero-I/O authority join: the current route/settings must compile to the origin descriptor.
  const currentDescriptor = processMemoryParentSyntaxV1(() => compileCurrentDescriptor(config));
  let currentDescriptorHash: string;
  try {
    currentDescriptorHash = processMemoryParentSyntaxV1(() =>
      hashAutonomousPersonalDescriptorV4(currentDescriptor),
    );
  } catch {
    return reject('invalid_configuration');
  }
  if (
    currentDescriptorHash !== origin.identity.descriptorHash ||
    currentDescriptor.settingsHash !== origin.identity.settingsHash ||
    currentDescriptor.policy.fingerprint !== origin.identity.policyFingerprint
  ) {
    return reject('authority_changed');
  }

  // 2. Validate the existing scope/work/check and start the sticky check.
  let scope: AutomaticClaimReadScope;
  let suppliedWork: unknown;
  let trusted: () => void;
  try {
    if (!isObject(resourcesValue)) return reject('invalid_configuration');
    scope = resourcesValue.scope;
    suppliedWork = resourcesValue.work;
    trusted = resourcesValue.check;
  } catch {
    return reject('invalid_configuration');
  }
  const view = readWork(suppliedWork);
  if (
    typeof trusted !== 'function' ||
    !view ||
    !isObject(scope) ||
    getAutomaticClaimReadScopeRemaining(scope) === null
  ) {
    return reject('invalid_configuration');
  }
  // Own the initially validated deadline/native signal before the first await; the caller's
  // mutable work object is never read again.
  const configuredWork = currentAutonomousPersonalExecutionScopeWorkV1();
  const ownedWork: AutonomousPersonalTypedSyntaxWorkV1 =
    configuredWork !== undefined && configuredWork === suppliedWork
      ? configuredWork
      : Object.freeze({
          absoluteMonotonicDeadlineMs: view.deadline,
          signal: view.signal,
        });
  const stickyCheck = createStickyCheck(state, view, scope, trusted);
  const counter: ParentReaderCounter = {
    remaining: CANDIDATE_READ_LIMIT,
    bytesRemaining: CANDIDATE_AGGREGATE_BYTES,
    stopReason: null,
    preimageRemaining: ROW_PREIMAGE_AGGREGATE_BYTES,
    rowHashes: new Map(),
  };
  // The existing sticky check always runs first; a latched resource stop then fails closed.
  const check = () => {
    stickyCheck();
    if (counter.stopReason !== null) reject('resource_exhausted');
  };
  check();

  const readSnapshot = (storageOwner as Partial<IGraphStorage> | null)
    ?.readCompositionalRetrievalSnapshotV3;
  if (typeof readSnapshot !== 'function') return reject('unsupported_mode');

  // Exactly one bounded backend read; the backend reserves its own attempt.
  let raw: unknown;
  try {
    raw = await readSnapshot.call(storageOwner, scope);
  } catch (error) {
    check();
    return mapFailure(state, error, 'storage_unavailable');
  }
  check();

  const parsedSnapshot = processMemoryParentSyntaxV1(() =>
    CompositionalRetrievalSnapshotV3Schema.safeParse(raw),
  );
  raw = undefined;
  if (!parsedSnapshot.success) return reject('invalid_snapshot');
  const snapshot = parsedSnapshot.data;
  if (snapshot.status !== 'snapshot') return mapSnapshotFailure(snapshot);
  check();

  // 3. Exactly one checked index, then only its own frozen graph.
  let index: AutonomousPersonalClaimIndexV4;
  let graph: GraphData;
  try {
    ({ index, graph } = processMemoryParentSyntaxV1(() => {
      const checkedIndex = createIntegrityCheckedAutonomousPersonalClaimIndexV4(
        snapshot.graph,
        ownedWork,
        check,
      );
      check();
      const checkedGraph = getAutonomousPersonalClaimIndexGraphV4(checkedIndex);
      check();
      return { index: checkedIndex, graph: checkedGraph };
    }));
    processMemoryParentSyntaxV1(() => assertAutomaticLedgerSourceIntegrity(graph, check));
    check();
  } catch (error) {
    return mapFailure(state, error, 'invalid_snapshot');
  }
  const backendNow = snapshot.backendNow;

  try {
    processMemoryParentSyntaxV1(() =>
      assertAutonomousPersonalMemoryCurrentParentGraphV4(graph, origin, config, backendNow, check),
    );
    check();
  } catch (error) {
    return mapFailure(state, error, 'invalid_snapshot');
  }

  // 8. Final original-work check, then publish the empty owner-bound token.
  check();
  const reader = Object.freeze(
    Object.create(null),
  ) as PrivateAutonomousPersonalMemoryParentReaderV4;
  const owned = recordsByOwner.get(storageOwner) ?? new WeakMap<object, ParentReaderRecord>();
  owned.set(
    reader,
    Object.freeze({
      index,
      graph,
      backendNow,
      origin,
      config,
      work: ownedWork,
      check,
      scope,
      counter,
    }),
  );
  recordsByOwner.set(storageOwner, owned);
  return Object.freeze({ kind: 'reader_ready' as const, reader });
}

/**
 * Open one reader for the actual current-turn parent. The reader grants no model,
 * delivery or write permission and exposes no graph, receipt or proof.
 */
export async function openAutonomousPersonalMemoryParentReaderV4(
  storageOwner: IGraphStorage,
  lineage: PrivateAutonomousPersonalMemoryLineageV4,
  config: AutonomousPersonalNativeMemoryConfigV4,
  resources: AutonomousPersonalMemoryParentReaderV4Resources,
): Promise<AutonomousPersonalMemoryParentOpenV4Result> {
  const state: CheckState = { failed: false, failure: undefined };
  try {
    if (!isObject(storageOwner)) return rejected('unsupported_mode');
    return await openInner(storageOwner, lineage, config, resources, state);
  } catch (error) {
    if (state.failed) throw state.failure;
    if (error instanceof ParentReject) return rejected(error.reason);
    return rejected('invalid_snapshot');
  }
}

function recordFor(storageOwner: unknown, reader: unknown): ParentReaderRecord | undefined {
  if (!isObject(storageOwner) || !isObject(reader) || utilTypes.isProxy(reader)) return undefined;
  return recordsByOwner.get(storageOwner)?.get(reader);
}

/** Delete a reader even if its work has expired. Unknown readers are ignored. */
export function closeAutonomousPersonalMemoryParentReaderV4(
  storageOwner: object,
  reader: unknown,
): void {
  if (!isObject(storageOwner) || !isObject(reader) || utilTypes.isProxy(reader)) return;
  recordsByOwner.get(storageOwner)?.delete(reader);
}

/**
 * Non-consuming membership/liveness predicate; it performs no backend read. It runs the
 * stored sticky check: its own budget stop is `false`, a trusted failure is rethrown exactly.
 */
export function isLiveAutonomousPersonalMemoryParentReaderV4(
  storageOwner: object,
  reader: unknown,
): boolean {
  const record = recordFor(storageOwner, reader);
  if (!record) return false;
  try {
    record.check();
  } catch (error) {
    if (error instanceof ParentReject) return false;
    throw error;
  }
  return true;
}

/** Creation-time display DATA from the actual validated parent, never a current fact permit. */
export function getAutonomousPersonalMemoryParentReceiptSummaryV4(
  storageOwner: object,
  reader: unknown,
): AutonomousPersonalCaptureReceiptSummaryV4 | null {
  const record = recordFor(storageOwner, reader);
  if (!record) return null;
  try {
    record.check();
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(
      record.origin.terminalReceipt,
      record.check,
    );
    record.check();
    return summary;
  } catch (error) {
    if (error instanceof ParentReject) return null;
    throw error;
  }
}

/**
 * Namespace DATA for fixed, read-only history/search adapters. Rows come from this
 * reader's one checked root; callers cannot select another namespace or supply a graph.
 * This projection is never processing/write authority or workflow output.
 */
export function getAutonomousPersonalMemoryParentNamespaceGraphV4(
  storageOwner: object,
  reader: unknown,
): GraphData | null {
  const record = recordFor(storageOwner, reader);
  if (!record) return null;
  try {
    return processMemoryParentSyntaxV1(() => {
      record.check();
      const rows = <T extends { group_id: string }>(input: readonly T[]): T[] => {
        const selected: T[] = [];
        for (const row of input) {
          record.check();
          if (row.group_id === record.config.namespace) selected.push(row);
        }
        Object.freeze(selected);
        record.check();
        return selected;
      };
      const root = record.graph;
      const entities = rows(root.entities);
      const edges = rows(root.edges);
      const episodes = rows(root.episodes);
      const ledger = root.automatic_operations_v1;
      const operations: NonNullable<typeof ledger>['operations'] = [];
      if (ledger) {
        for (const operation of ledger.operations) {
          record.check();
          if (operation.identity.namespace === record.config.namespace) operations.push(operation);
        }
      }
      Object.freeze(operations);
      // A full-root checksum/count cannot describe a namespace projection.
      const { metadata, ...contents } = root;
      const graph: GraphData = Object.freeze({
        ...contents,
        ...(metadata?.extraction_epoch
          ? { metadata: Object.freeze({ extraction_epoch: metadata.extraction_epoch }) }
          : {}),
        group_id: record.config.namespace,
        entities,
        edges,
        episodes,
        ...(ledger ? { automatic_operations_v1: Object.freeze({ ...ledger, operations }) } : {}),
      });
      record.check();
      return graph;
    }, record.work);
  } catch (error) {
    if (error instanceof ParentReject) return null;
    throw error;
  }
}

/** Recursive freeze that runs the original record check at every traversal boundary. */
function checkedFreeze<T>(value: T, check: () => void): T {
  check();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      checkedFreeze(child, check);
    Object.freeze(value);
  }
  return value;
}

function latchResourceExhausted(record: ParentReaderRecord): null {
  record.counter.stopReason = 'resource_exhausted';
  return null;
}

/** Bounded own-stop DATA; trusted callback failures still propagate with exact identity. */
export function getAutonomousPersonalMemoryParentReadStopV4(
  storageOwner: object,
  reader: unknown,
): AutonomousPersonalMemoryReadStopV4 {
  const record = recordFor(storageOwner, reader);
  if (!record) return 'invalid_reader';
  try {
    record.check();
    return null;
  } catch (error) {
    if (error instanceof ParentReject) {
      return error.reason === 'resource_exhausted' ? 'resource_exhausted' : 'budget_exhausted';
    }
    throw error;
  }
}

/** Fixed same-scope compatibility bridge. No caller graph, namespace or clock is admitted. */
export function readAutonomousPersonalMemoryParentCompatibilityDataV4(
  storageOwner: object,
  reader: unknown,
  scope: AutomaticClaimReadScope,
): AutonomousPersonalMemoryCompatibilityDataV4 | null {
  const record = recordFor(storageOwner, reader);
  if (!record) return null;
  try {
    record.check();
    if (record.scope !== scope) return null;
    const graph = getAutonomousPersonalMemoryParentNamespaceGraphV4(storageOwner, reader);
    if (!graph) return null;
    record.check();
    return Object.freeze({
      namespace: record.config.namespace,
      backendNow: record.backendNow,
      graph,
    });
  } catch (error) {
    if (error instanceof ParentReject) return null;
    throw error;
  }
}

/**
 * One compact, already-qualified older Claim3 candidate for fixed read-only adapters.
 * DATA only: never a creator, parent, model or write permit. Every call is counted.
 */
export function readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4(
  storageOwner: object,
  reader: unknown,
  edgeId: unknown,
): AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data | null {
  const record = recordFor(storageOwner, reader);
  if (!record) return null;
  try {
    return processMemoryParentSyntaxV1(() => {
      record.check();
      if (record.counter.remaining < 1) return latchResourceExhausted(record);
      record.counter.remaining -= 1;

      if (typeof edgeId !== 'string' || edgeId.length > 64) return null;
      let id: string;
      try {
        id = AutonomousPersonalQualifiedClaimEdgeIdV4Schema.parse(edgeId);
      } catch {
        return null;
      }
      record.check();

      const { config, origin } = record;
      const qualified = qualifyAutonomousPersonalClaimCreatorV4(record.index, {
        storeHash: config.storeHash,
        namespace: config.namespace,
        edgeId: id,
        backendNow: record.backendNow,
      });
      record.check();
      if (qualified.status === 'capacity') return latchResourceExhausted(record);
      if (qualified.status !== 'qualified') return null;
      const proof = qualified.proof;
      if (
        proof.claimId !== id ||
        proof.reviewState !== 'accepted' ||
        proof.storeHash !== config.storeHash ||
        proof.namespace !== config.namespace ||
        proof.subjectId !== origin.identity.binding.subjectId
      ) {
        return null;
      }

      const rows = getAutonomousPersonalClaimIndexCandidateRowsV4(record.index, id);
      record.check();
      if (!rows) return null;
      const { edge, subject, value, source, operation } = rows;
      if (
        edge.uuid !== proof.claimId ||
        value.uuid !== proof.valueId ||
        source.uuid !== proof.sourceId ||
        subject.uuid !== proof.subjectId ||
        operation.operationId !== proof.operationId ||
        operation.state !== 'committed' ||
        operation.identity.sourceId !== source.uuid ||
        operation.identity.storeHash !== config.storeHash ||
        operation.identity.namespace !== config.namespace ||
        operation.identity.issuer !== config.issuer ||
        operation.identity.actorReference !== config.actorReference ||
        !same(operation.identity.binding, origin.identity.binding) ||
        source.review_status !== 'accepted' ||
        source.trust_level !== operation.descriptor.requestedTrustLevel
      ) {
        return null;
      }
      const receipt = operation.terminalReceipt;
      if (
        receipt.kind !== 'human_autonomous_capture_committed' ||
        receipt.selection.kind !== 'occurrences'
      ) {
        return null;
      }
      if (source.reference_time.length > REFERENCE_TIME_MAX_LENGTH) {
        return latchResourceExhausted(record);
      }

      const claimParsed = AutonomousPersonalClaimV3OwnedDataSchema.safeParse(
        edge.attributes[EDGE_CLAIM_ATTRIBUTE],
      );
      record.check();
      if (!claimParsed.success) return null;
      const claim = claimParsed.data;
      if (
        claim.kind !== proof.kind ||
        claim.key !== proof.key ||
        claim.sourceId !== proof.sourceId ||
        claim.subjectId !== proof.subjectId ||
        claim.namespace !== proof.namespace ||
        claim.evidence.unitId !== proof.unitId ||
        claim.evidence.evidenceHash !== proof.evidenceHash ||
        (claim.kind === 'source_statement_record' &&
          claim.sourceEventTime !== proof.sourceEventTime)
      ) {
        return null;
      }

      let creators = 0;
      let creationReviewState: 'accepted' | 'proposed' | null = null;
      for (const item of receipt.selection.items) {
        record.check();
        if (item.claimId === proof.claimId && item.effect === 'created') {
          creators += 1;
          if (item.state === 'accepted' || item.state === 'proposed') {
            creationReviewState = item.state;
          }
        }
      }
      if (creators !== 1 || creationReviewState === null) return null;

      // Bounded preflight of the actual row triple BEFORE any hashing; cached per checked root.
      let rowHash = record.counter.rowHashes.get(id);
      if (rowHash === undefined) {
        const triple = { edge, subject, value };
        const limit = Math.min(ROW_PREIMAGE_MAX_BYTES, record.counter.preimageRemaining);
        record.check();
        const preimageBytes = boundedAutomaticClaimReadJsonBytes(triple, limit);
        record.check();
        if (preimageBytes > limit) return latchResourceExhausted(record);
        record.counter.preimageRemaining -= preimageBytes;
        rowHash = hashAutomaticCaptureV2(triple);
        record.check();
        record.counter.rowHashes.set(id, rowHash);
      }
      const common = {
        version: 4,
        rowHash,
        proof,
        terminalAt: receipt.terminalAt,
        creationReviewState,
        confidence: extractionMetadataFromAttributes(edge.attributes)?.confidence ?? null,
        source: {
          sourceMessageId: source.source_message_id,
          conversationId: source.conversation_id,
          senderId: source.sender_id,
          senderName: source.sender_name,
          episodeKind: source.episode_kind,
          trustLevel: source.trust_level,
          reviewStatus: source.review_status,
          referenceTime: source.reference_time,
          sourceWorkflowId: source.source_workflow_id,
          sourceExecutionId: source.source_execution_id,
        },
      };
      const input =
        claim.kind === 'typed_preference'
          ? { ...common, kind: claim.kind, meaning: claim.meaning }
          : {
              ...common,
              kind: claim.kind,
              statementLiteral: claim.evidence.literal,
              sourceEventTime: claim.sourceEventTime,
            };

      // Serialized once: this exact length is the per-candidate and aggregate charge.
      const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
      if (bytes > CANDIDATE_MAX_BYTES || bytes > record.counter.bytesRemaining) {
        return latchResourceExhausted(record);
      }
      const parsed =
        AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(input);
      record.check();
      if (!parsed.success) return null;

      if (!chargeAutomaticClaimContextBytes(record.scope, bytes)) {
        // A spent original scope/time/signal keeps its budget_exhausted mapping.
        record.check();
        return latchResourceExhausted(record);
      }
      record.counter.bytesRemaining -= bytes;
      record.check();
      const frozen = checkedFreeze(parsed.data, record.check);
      record.check();
      return frozen;
    }, record.work);
  } catch (error) {
    if (error instanceof ParentReject) return null;
    // A sticky trusted failure is rethrown with its exact identity by the check;
    // anything else is an internal inconsistency and yields no candidate.
    try {
      record.check();
    } catch (checkError) {
      if (checkError instanceof ParentReject) return null;
      throw checkError;
    }
    return null;
  }
}

function processMemoryParentSyntaxV1<T>(
  body: () => T,
  work: unknown = currentAutonomousPersonalExecutionScopeWorkV1(),
): T {
  return work ? runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1(work, body) : body();
}
