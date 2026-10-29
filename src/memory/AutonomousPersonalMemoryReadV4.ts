/// <reference lib="es2021.weakref" />

import { performance } from 'node:perf_hooks';
import type { BaseMessage } from '@langchain/core/messages';
import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import { RequestBudget } from '../extraction/RequestBudget';
import type { EmbeddingConfig } from '../embeddings/EmbeddingService';
import { EmbeddingService } from '../embeddings/EmbeddingService';
import type { HistoryReadDiagnostics, MemoryPolicyInput } from '../schemas';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import { SourceHydrationBudgetSchema } from '../schemas/ExtractionPolicy.schema';
import type { AutonomousPersonalNativeMemoryConfigV4 } from '../schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalAssistantNativeSnapshotV4 } from '../schemas/AutonomousPersonalAssistantFinalV4.schema';
import type { AutonomousPersonalCaptureReceiptSummaryV4 } from '../schemas/AutonomousPersonalCaptureReceiptSummaryV4.schema';
import type { AutonomousPersonalMemoryParentReaderV4Reason } from '../schemas/AutonomousPersonalMemoryParentReaderV4.schema';
import type { CompositionalRuntimeReaderV3 } from '../schemas/CompositionalRuntimeReaderV3.schema';
import type { AutomaticClaimReadScope } from '../storage/AutomaticClaimReadScope';
import {
  canUseAutomaticClaimReadScope,
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
} from '../storage/AutomaticClaimReadScope';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  AutonomousPersonalNativeMemoryAdapterV4Error,
  getAutonomousPersonalNativeMemoryAdapterAccessV4,
  type AutonomousPersonalNativeMemoryAdapterAccessV4,
} from './AutonomousPersonalNativeMemoryAdapterV4';
import { EngramChatMessageHistory, type HumanEpisodeKind } from './EngramChatMessageHistory';
import {
  closeAutonomousPersonalMemoryParentReaderV4,
  getAutonomousPersonalMemoryParentReadStopV4,
  getAutonomousPersonalMemoryParentReceiptSummaryV4,
  openAutonomousPersonalMemoryParentReaderV4,
  type PrivateAutonomousPersonalMemoryParentReaderV4,
} from './AutonomousPersonalMemoryParentReaderV4';
import type { PrivateAutonomousPersonalMemoryLineageV4 } from './AutonomousPersonalNativeMemoryHandoffV4';
import { createAutonomousPersonalNativeMemoryWorkV4 } from '../utils/AutonomousPersonalNativeMemoryWorkV4';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import { loadCompositionalCompatibilityRuntimeReaderV4 } from '../search/CompositionalRuntimeReaderV3';
import { HybridSearchEngine } from '../search/HybridSearchEngine';

const EMBEDDING_CALLS = 1;
const EMBEDDING_WINDOW_MS = 5_000;
const EMBEDDING_REQUEST_BYTES = 256 * 1024;
const EMBEDDING_RESPONSE_BYTES = 256 * 1024;

export type AutonomousPersonalMemoryReadFailureReasonV4 =
  | 'invalid_adapter'
  | 'invalid_frame'
  | 'invalid_configuration'
  | 'invalid_snapshot'
  | 'unsupported_mode'
  | 'parent_not_found'
  | 'parent_mismatch'
  | 'authority_changed'
  | 'clock_regression'
  | 'budget_exhausted'
  | 'resource_exhausted'
  | 'storage_unavailable';

export class AutonomousPersonalMemoryReadV4Error extends Error {
  constructor(readonly reason: AutonomousPersonalMemoryReadFailureReasonV4) {
    super(`Engram native Memory read: ${reason}`);
    this.name = 'AutonomousPersonalMemoryReadV4Error';
  }
}

export type AutonomousPersonalMemoryReadFrameV4 = Readonly<{
  readonly owner: IGraphStorage | null;
  readonly parentReader: PrivateAutonomousPersonalMemoryParentReaderV4 | null;
  readonly compatibilityReader: CompositionalRuntimeReaderV3 | null;
  readonly storage: IGraphStorage | null;
  readonly engine: HybridSearchEngine | null;
  readonly config: AutonomousPersonalNativeMemoryConfigV4 | null;
  readonly snapshot: AutonomousPersonalAssistantNativeSnapshotV4 | null;
  readonly receiptSummary: AutonomousPersonalCaptureReceiptSummaryV4 | null;
  check(): void;
  close(): void;
}>;

export type AutonomousPersonalMemoryReadOpenV4Result =
  | Readonly<{ kind: 'read_ready'; frame: AutonomousPersonalMemoryReadFrameV4 }>
  | Readonly<{ kind: 'rejected'; reason: AutonomousPersonalMemoryReadFailureReasonV4 }>;

export interface AutonomousPersonalConversationReadOptionsV4 {
  readonly contextWindow: number;
  readonly humanEpisodeKind: HumanEpisodeKind;
  readonly policy: MemoryPolicyInput;
}

type TrustedFailureV4 = { failed: boolean; failure: unknown };

type ReadFrameStateV4 = {
  closed: boolean;
  readonly failure: TrustedFailureV4;
  owner: IGraphStorage | null;
  parentReader: PrivateAutonomousPersonalMemoryParentReaderV4 | null;
  compatibilityReader: CompositionalRuntimeReaderV3 | null;
  storage: IGraphStorage | null;
  engine: HybridSearchEngine | null;
  config: AutonomousPersonalNativeMemoryConfigV4 | null;
  snapshot: AutonomousPersonalAssistantNativeSnapshotV4 | null;
  receiptSummary: AutonomousPersonalCaptureReceiptSummaryV4 | null;
  access: AutonomousPersonalNativeMemoryAdapterAccessV4 | null;
  budget: SourceHydrationBudget | null;
  scope: AutomaticClaimReadScope | null;
  work: AutonomousPersonalTypedSyntaxWorkV1 | null;
  check: (() => void) | null;
  embeddingBudget: NativeMemoryEmbeddingBudgetV4 | null;
  embeddingService: EmbeddingService | null;
};

class NativeMemoryReadFailureV4 extends Error {
  constructor(readonly reason: AutonomousPersonalMemoryReadFailureReasonV4) {
    super(reason);
  }
}

const framesV4 = new WeakMap<object, ReadFrameStateV4>();
const nativeWorkHostV4 = (signal: AbortSignal | null, available: boolean) => ({
  getExecutionCancelSignal: () => (available && signal ? signal : undefined),
});

function reject(reason: AutonomousPersonalMemoryReadFailureReasonV4): never {
  throw new NativeMemoryReadFailureV4(reason);
}

function resultRejected(
  reason: AutonomousPersonalMemoryReadFailureReasonV4,
): AutonomousPersonalMemoryReadOpenV4Result {
  return Object.freeze({ kind: 'rejected', reason });
}

function mapParentReason(
  reason: AutonomousPersonalMemoryParentReaderV4Reason,
): AutonomousPersonalMemoryReadFailureReasonV4 {
  switch (reason) {
    case 'invalid_lineage':
      return 'invalid_adapter';
    case 'invalid_configuration':
      return 'invalid_configuration';
    case 'unsupported_mode':
      return 'unsupported_mode';
    case 'parent_not_found':
      return 'parent_not_found';
    case 'parent_mismatch':
      return 'parent_mismatch';
    case 'authority_changed':
      return 'authority_changed';
    case 'clock_regression':
      return 'clock_regression';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'resource_exhausted':
      return 'resource_exhausted';
    case 'invalid_snapshot':
      return 'invalid_snapshot';
    case 'storage_unavailable':
      return 'storage_unavailable';
  }
}

function mapCompatibilityReason(reason: string): AutonomousPersonalMemoryReadFailureReasonV4 {
  if (reason === 'budget_exhausted') return 'budget_exhausted';
  if (['resource_exhausted', 'capacity', 'context_too_large'].includes(reason))
    return 'resource_exhausted';
  if (['storage_error', 'missing_capability'].includes(reason)) return 'storage_unavailable';
  if (reason === 'invalid_reader') return 'invalid_adapter';
  return 'unsupported_mode';
}

function readState(frame: unknown): ReadFrameStateV4 | undefined {
  return frame !== null && typeof frame === 'object' ? framesV4.get(frame) : undefined;
}

/** Keep the callback retained by ParentReader limited to its fixed owned resources. */
function createReadCheckV4(
  access: AutonomousPersonalNativeMemoryAdapterAccessV4,
  work: ReturnType<typeof createAutonomousPersonalNativeMemoryWorkV4>,
  scope: AutomaticClaimReadScope,
  failure: TrustedFailureV4,
): () => void {
  return () => {
    if (failure.failed) throw failure.failure;
    try {
      access.checkOpen();
      work.check();
      if (!canUseAutomaticClaimReadScope(scope)) throw new ExtractionBudgetError('deadline');
    } catch (error) {
      failure.failed = true;
      failure.failure = error;
      throw error;
    }
  };
}

function closeFrameState(state: ReadFrameStateV4): void {
  if (state.closed) return;
  state.closed = true;
  const owner = state.owner;
  const parentReader = state.parentReader;
  const embeddingBudget = state.embeddingBudget;
  if (owner && parentReader) closeAutonomousPersonalMemoryParentReaderV4(owner, parentReader);
  try {
    embeddingBudget?.dispose();
  } catch {
    // Closing a read frame is idempotent and must not obscure the caller's failure.
  }
  state.owner = null;
  state.parentReader = null;
  state.compatibilityReader = null;
  state.storage = null;
  state.engine = null;
  state.config = null;
  state.snapshot = null;
  state.receiptSummary = null;
  state.access = null;
  state.budget = null;
  state.scope = null;
  state.work = null;
  state.check = null;
  state.embeddingBudget = null;
  state.embeddingService = null;
}

function stateFailure(state: ReadFrameStateV4): Error {
  return new AutonomousPersonalMemoryReadV4Error(
    state.closed ? 'invalid_frame' : 'budget_exhausted',
  );
}

function checkFrameState(state: ReadFrameStateV4): void {
  if (state.failure.failed) {
    const failure = state.failure.failure;
    closeFrameState(state);
    throw failure;
  }
  if (state.closed) throw stateFailure(state);
  const check = state.check;
  const owner = state.owner;
  const parentReader = state.parentReader;
  if (!check || !owner || !parentReader) throw stateFailure(state);
  try {
    check();
    const stop = getAutonomousPersonalMemoryParentReadStopV4(owner, parentReader);
    if (stop === 'resource_exhausted') reject('resource_exhausted');
    if (stop === 'invalid_reader') reject('invalid_frame');
    if (stop === 'budget_exhausted') reject('budget_exhausted');
  } catch (error) {
    const failure = state.failure.failed ? state.failure.failure : error;
    closeFrameState(state);
    if (failure instanceof NativeMemoryReadFailureV4) throw failure;
    if (error instanceof ExtractionBudgetError) {
      if (!state.failure.failed) {
        state.failure.failed = true;
        state.failure.failure = error;
      }
      throw failure;
    }
    throw failure;
  }
}

function makeFrame(state: ReadFrameStateV4): AutonomousPersonalMemoryReadFrameV4 {
  const reference = new WeakRef(state);
  const frame: AutonomousPersonalMemoryReadFrameV4 = {
    get owner(): IGraphStorage | null {
      const current = reference.deref();
      return current && !current.closed ? current.owner : null;
    },
    get parentReader(): PrivateAutonomousPersonalMemoryParentReaderV4 | null {
      const current = reference.deref();
      return current && !current.closed ? current.parentReader : null;
    },
    get compatibilityReader(): CompositionalRuntimeReaderV3 | null {
      const current = reference.deref();
      return current && !current.closed ? current.compatibilityReader : null;
    },
    get storage(): IGraphStorage | null {
      const current = reference.deref();
      return current && !current.closed ? current.storage : null;
    },
    get engine(): HybridSearchEngine | null {
      const current = reference.deref();
      return current && !current.closed ? current.engine : null;
    },
    get config(): AutonomousPersonalNativeMemoryConfigV4 | null {
      const current = reference.deref();
      return current && !current.closed ? current.config : null;
    },
    get snapshot(): AutonomousPersonalAssistantNativeSnapshotV4 | null {
      const current = reference.deref();
      return current && !current.closed ? current.snapshot : null;
    },
    get receiptSummary(): AutonomousPersonalCaptureReceiptSummaryV4 | null {
      const current = reference.deref();
      return current && !current.closed ? current.receiptSummary : null;
    },
    check(): void {
      const current = reference.deref();
      if (!current) reject('invalid_frame');
      checkFrameState(current);
    },
    close(): void {
      const current = reference.deref();
      if (current) closeFrameState(current);
    },
  };
  for (const key of [
    'owner',
    'parentReader',
    'compatibilityReader',
    'storage',
    'engine',
    'config',
    'snapshot',
    'receiptSummary',
    'check',
    'close',
  ] as const) {
    Object.defineProperty(frame, key, { enumerable: false });
  }
  return Object.freeze(frame);
}

class NativeMemoryEmbeddingBudgetV4 extends RequestBudget {
  constructor(
    private readonly frameReference: WeakRef<ReadFrameStateV4>,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ) {
    super(
      EMBEDDING_CALLS,
      EMBEDDING_WINDOW_MS,
      EMBEDDING_REQUEST_BYTES,
      EMBEDDING_RESPONSE_BYTES,
      signal,
      deadlineAt,
    );
  }

  override check(): void {
    try {
      const state = this.frameReference.deref();
      if (!state) throw new AutonomousPersonalMemoryReadV4Error('invalid_frame');
      checkFrameState(state);
      super.check();
    } catch (error) {
      this.controller.abort();
      throw error;
    }
  }
}

function createEmbeddingBudget(
  state: ReadFrameStateV4,
  reference: WeakRef<ReadFrameStateV4>,
): NativeMemoryEmbeddingBudgetV4 {
  const scope = state.scope;
  const work = state.work;
  if (!scope || !work) reject('invalid_frame');
  checkFrameState(state);
  const sampledAt = performance.now();
  const remaining = getAutomaticClaimReadScopeRemaining(scope);
  if (!remaining || !Number.isFinite(sampledAt)) reject('budget_exhausted');
  const scopeDeadlineAt = sampledAt + remaining.deadlineRemainingMs;
  const deadlineAt = Math.min(work.absoluteMonotonicDeadlineMs, scopeDeadlineAt);
  if (!Number.isFinite(deadlineAt) || sampledAt >= deadlineAt) reject('budget_exhausted');
  const signal = state.access?.nativeCancellationAvailable ? state.access.signal : null;
  if (state.access?.nativeCancellationAvailable && !signal) reject('invalid_adapter');
  return new NativeMemoryEmbeddingBudgetV4(reference, signal ?? undefined, deadlineAt);
}

/** Open one actual ParentReader load and retain its bounded read resources in a private frame. */
export async function openAutonomousPersonalMemoryReadV4(
  memoryInstance: unknown,
  embeddingConfig?: EmbeddingConfig,
): Promise<AutonomousPersonalMemoryReadOpenV4Result> {
  const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(memoryInstance);
  if (!access) return resultRejected('invalid_adapter');

  let owner: IGraphStorage | null = null;
  let lineage: PrivateAutonomousPersonalMemoryLineageV4 | null = null;
  let parentReader: PrivateAutonomousPersonalMemoryParentReaderV4 | null = null;
  let compatibilityReader: CompositionalRuntimeReaderV3 | null = null;
  let embeddingBudget: NativeMemoryEmbeddingBudgetV4 | null = null;
  let state: ReadFrameStateV4 | null = null;
  let completed = false;
  const failure: TrustedFailureV4 = { failed: false, failure: undefined };

  try {
    access.checkOpen();
    owner = access.owner;
    lineage = access.lineage;
    const initialSnapshot = access.initialSnapshot;
    const signal = access.signal;
    const nativeCancellationAvailable = access.nativeCancellationAvailable;
    if (!owner || !lineage || !initialSnapshot) reject('invalid_adapter');
    if (nativeCancellationAvailable && !signal) reject('invalid_adapter');

    const nativeWork = createAutonomousPersonalNativeMemoryWorkV4(
      nativeWorkHostV4(signal, nativeCancellationAvailable),
      initialSnapshot.config.invocationDeadlineMs,
    );
    const budget = SourceHydrationBudgetSchema.parse({ remaining: 512, deferred: 0 });
    const scope = getAutomaticClaimReadScope(budget);
    const check = createReadCheckV4(access, nativeWork, scope, failure);

    check();
    let snapshot: AutonomousPersonalAssistantNativeSnapshotV4;
    try {
      snapshot = await access.readSnapshot();
    } catch (error) {
      try {
        check();
      } catch {
        if (failure.failed) throw failure.failure;
      }
      if (error instanceof ExtractionBudgetError) throw error;
      reject('invalid_snapshot');
    }
    check();

    const parent = await openAutonomousPersonalMemoryParentReaderV4(
      owner,
      lineage,
      snapshot.config,
      { scope, work: nativeWork.work, check },
    );
    if (parent.kind === 'reader_ready') parentReader = parent.reader;
    lineage = null;
    check();
    if (parent.kind === 'rejected') reject(mapParentReason(parent.reason));
    const liveParentReader = parent.reader;

    const compatibility = await loadCompositionalCompatibilityRuntimeReaderV4(
      owner,
      liveParentReader,
      budget,
    );
    check();
    if (compatibility.status !== 'ready') reject(mapCompatibilityReason(compatibility.reason));
    compatibilityReader = compatibility.reader;

    state = {
      closed: false,
      failure,
      owner,
      parentReader: liveParentReader,
      compatibilityReader,
      storage: null,
      engine: null,
      config: snapshot.config,
      snapshot,
      receiptSummary: null,
      access,
      budget,
      scope,
      work: nativeWork.work,
      check,
      embeddingBudget: null,
      embeddingService: null,
    };

    const reference = new WeakRef(state);
    if (embeddingConfig) {
      embeddingBudget = createEmbeddingBudget(state, reference);
      state.embeddingBudget = embeddingBudget;
      state.embeddingService = new EmbeddingService(embeddingConfig, undefined, embeddingBudget);
    }

    const engineBinding = HybridSearchEngine.forAutonomousPersonalMemoryV4(
      owner,
      liveParentReader,
      compatibilityReader,
      state.embeddingService ?? undefined,
    );
    check();
    if (!engineBinding) {
      const stop = getAutonomousPersonalMemoryParentReadStopV4(owner, parentReader);
      reject(stop === 'resource_exhausted' ? 'resource_exhausted' : 'invalid_snapshot');
    }
    state.storage = engineBinding.storage;
    state.engine = engineBinding.engine;

    const receiptSummary = getAutonomousPersonalMemoryParentReceiptSummaryV4(owner, parentReader);
    check();
    if (!receiptSummary) reject('invalid_snapshot');
    state.receiptSummary = receiptSummary;

    check();
    const frame = makeFrame(state);
    framesV4.set(frame, state);
    completed = true;
    return Object.freeze({ kind: 'read_ready', frame });
  } catch (error) {
    if (failure.failed) throw failure.failure;
    if (error instanceof NativeMemoryReadFailureV4) return resultRejected(error.reason);
    if (error instanceof AutonomousPersonalNativeMemoryAdapterV4Error) {
      return resultRejected(
        error.reason === 'invalid_input' ? 'invalid_configuration' : 'invalid_adapter',
      );
    }
    if (error instanceof ExtractionBudgetError) {
      return resultRejected('budget_exhausted');
    }
    return resultRejected('invalid_configuration');
  } finally {
    if (!completed) {
      if (state) {
        closeFrameState(state);
      } else {
        if (owner && parentReader) closeAutonomousPersonalMemoryParentReaderV4(owner, parentReader);
        try {
          embeddingBudget?.dispose();
        } catch {
          // Setup failure is already fixed and redacted.
        }
      }
    }
  }
}

/** Fixed conversation-only read over the exact staged projection owned by one live frame. */
export async function readAutonomousPersonalConversationV4(
  frame: AutonomousPersonalMemoryReadFrameV4,
  options: AutonomousPersonalConversationReadOptionsV4,
): Promise<{ messages: BaseMessage[]; history: HistoryReadDiagnostics }> {
  const state = readState(frame);
  if (!state || state.closed) throw new AutonomousPersonalMemoryReadV4Error('invalid_frame');
  checkFrameState(state);
  const storage = state.storage;
  const config = state.config;
  if (!storage || !config) throw new AutonomousPersonalMemoryReadV4Error('invalid_frame');

  const history = new EngramChatMessageHistory({
    storage,
    groupId: config.namespace,
    contextWindow: options.contextWindow,
    humanEpisodeKind: options.humanEpisodeKind,
    policy: options.policy,
  });
  history.excludeCurrentSource(config.sourceId);

  checkFrameState(state);
  let result: { messages: BaseMessage[]; history: HistoryReadDiagnostics };
  try {
    result = await history.getMessagesWithDiagnostics();
  } catch {
    checkFrameState(state);
    closeFrameState(state);
    throw new AutonomousPersonalMemoryReadV4Error('storage_unavailable');
  }
  checkFrameState(state);
  return { messages: result.messages, history: result.history };
}
