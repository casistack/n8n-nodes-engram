/// <reference lib="es2021.weakref" />

import { types as utilTypes } from 'node:util';
import {
  runAutonomousPersonalMemoryPreparationV1,
  assertAutonomousPersonalMemoryPreparationConfigV1,
} from '../utils/AutonomousPersonalMemoryExecutionEntryV1';
import type { IExecuteFunctions } from 'n8n-workflow';
import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import {
  AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema,
  type AutonomousPersonalNativeMemoryConfigV4,
} from '../schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalAssistantNativeSnapshotV4 } from '../schemas/AutonomousPersonalAssistantFinalV4.schema';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  type PrivateAutonomousPersonalMemoryLineageV4,
} from '../storage/AutonomousPersonalNativeMemoryHandoffV4';
import { createAutonomousPersonalNativeMemoryWorkV4 } from '../utils/AutonomousPersonalNativeMemoryWorkV4';
import {
  createAutonomousPersonalNativeMemorySnapshotReaderV4,
  type AutonomousPersonalNativeMemorySnapshotReaderV4,
} from '../utils/AutonomousPersonalNativeMemorySnapshotV4';
import { readReplaySafeMemoryNativeContext } from '../utils/replaySafeMemoryNative';
import type { AutonomousPersonalNativeMemoryConfigContextV4 } from '../utils/AutonomousPersonalNativeMemoryConfigV4';

declare const adapterTokenV4Brand: unique symbol;

/** Opaque one-use constructor handoff. Its value contains no configuration or authority DATA. */
export type PrivateAutonomousPersonalNativeMemoryAdapterTokenV4 = object & {
  readonly [adapterTokenV4Brand]: 'native_memory_adapter';
};

export type AutonomousPersonalNativeMemoryAdapterContextV4 =
  AutonomousPersonalNativeMemoryConfigContextV4 &
    Pick<IExecuteFunctions, 'getExecutionCancelSignal'>;

export type AutonomousPersonalNativeMemoryAdapterAccessV4 = Readonly<{
  readonly owner: IGraphStorage | null;
  readonly lineage: PrivateAutonomousPersonalMemoryLineageV4 | null;
  readonly initialSnapshot: AutonomousPersonalAssistantNativeSnapshotV4 | null;
  readonly signal: AbortSignal | null;
  readonly nativeCancellationAvailable: boolean;
  readSnapshot(): Promise<AutonomousPersonalAssistantNativeSnapshotV4>;
  checkOpen(): void;
}>;

export type AutonomousPersonalNativeMemoryAdapterFailureReasonV4 =
  | 'unsupported_configuration'
  | 'invalid_input';

export class AutonomousPersonalNativeMemoryAdapterV4Error extends Error {
  constructor(readonly reason: AutonomousPersonalNativeMemoryAdapterFailureReasonV4) {
    super(`Engram native Memory adapter: ${reason}`);
    this.name = 'AutonomousPersonalNativeMemoryAdapterV4Error';
  }
}

type WorkV4 = ReturnType<typeof createAutonomousPersonalNativeMemoryWorkV4>;

type AdapterStateV4 = {
  closed: boolean;
  closeReason: 'closed' | 'cancelled' | null;
  owner: IGraphStorage | null;
  lineage: PrivateAutonomousPersonalMemoryLineageV4 | null;
  initialSnapshot: AutonomousPersonalAssistantNativeSnapshotV4 | null;
  reader: AutonomousPersonalNativeMemorySnapshotReaderV4 | null;
  readonly pendingReaders: Set<AutonomousPersonalNativeMemorySnapshotReaderV4>;
  readerQueue: Promise<void>;
  signal: AbortSignal | null;
  nativeCancellationAvailable: boolean;
  abortListener: (() => void) | null;
  access: AutonomousPersonalNativeMemoryAdapterAccessV4 | null;
  cancellationFailure: ExtractionBudgetError | null;
};

const issuedTokensV4 = new WeakMap<object, AdapterStateV4>();
const tokenStatesV4 = new WeakMap<object, AdapterStateV4>();
const memoryStatesV4 = new WeakMap<object, AdapterStateV4>();
const nativeAbortedGetterV4 = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

function unsupported(): AutonomousPersonalNativeMemoryAdapterV4Error {
  return new AutonomousPersonalNativeMemoryAdapterV4Error('unsupported_configuration');
}

function readOwnerStoreHash(owner: IGraphStorage, check: () => void): string {
  check();
  let value: unknown;
  try {
    const reader = owner.getNativeAutomaticCaptureStoreIdentityV4;
    if (typeof reader !== 'function') throw unsupported();
    value = reader.call(owner);
  } catch (error) {
    check();
    if (error instanceof AutonomousPersonalNativeMemoryAdapterV4Error) throw error;
    throw unsupported();
  }
  check();
  if (typeof value !== 'string') throw unsupported();
  try {
    return AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.shape.storeHash.parse(value);
  } catch {
    throw unsupported();
  }
}

function closeState(state: AdapterStateV4, reason: 'closed' | 'cancelled' = 'closed'): void {
  if (state.closed) return;
  state.closed = true;
  state.closeReason = reason;
  state.cancellationFailure =
    reason === 'cancelled' ? new ExtractionBudgetError('cancelled') : null;

  const signal = state.signal;
  const abortListener = state.abortListener;
  state.abortListener = null;
  if (signal && abortListener) {
    try {
      signal.removeEventListener('abort', abortListener);
    } catch {
      // Cleanup remains best-effort and never exposes a host signal error.
    }
  }

  const readers = new Set(state.pendingReaders);
  const reader = state.reader;
  if (reader) readers.add(reader);
  state.reader = null;
  state.pendingReaders.clear();
  for (const pending of readers) {
    try {
      pending.close();
    } catch {
      // Snapshot readers have a fixed, idempotent close contract.
    }
  }

  state.owner = null;
  state.lineage = null;
  state.initialSnapshot = null;
  state.signal = null;
  state.access = null;
}

function closedStateFailure(state: AdapterStateV4): Error {
  if (state.closeReason === 'cancelled') {
    return state.cancellationFailure ?? new ExtractionBudgetError('cancelled');
  }
  return unsupported();
}

function assertStateOpen(state: AdapterStateV4): void {
  if (state.closed) throw closedStateFailure(state);
  if (state.nativeCancellationAvailable) {
    const signal = state.signal;
    if (!signal || !nativeAbortedGetterV4) {
      closeState(state);
      throw unsupported();
    }
    let cancelled: boolean;
    try {
      cancelled = nativeAbortedGetterV4.call(signal);
    } catch {
      closeState(state);
      throw unsupported();
    }
    if (cancelled) {
      closeState(state, 'cancelled');
      throw closedStateFailure(state);
    }
  }
  if (state.closed || !state.owner || !state.lineage || !state.initialSnapshot) {
    throw state.closed ? closedStateFailure(state) : unsupported();
  }
}

function checkStateOpen(state: AdapterStateV4): void {
  try {
    assertStateOpen(state);
  } catch (error) {
    closeState(state);
    throw error;
  }
}

async function readFreshSnapshot(
  state: AdapterStateV4,
): Promise<AutonomousPersonalAssistantNativeSnapshotV4> {
  checkStateOpen(state);
  const reader = state.reader;
  const owner = state.owner;
  const initialSnapshot = state.initialSnapshot;
  if (!reader || !owner || !initialSnapshot) throw unsupported();

  try {
    assertStateOpen(state);
    const snapshot = await reader.read();
    assertStateOpen(state);

    const currentOwnerHash = readOwnerStoreHash(owner, () => assertStateOpen(state));
    if (
      snapshot.config.storeHash !== currentOwnerHash ||
      snapshot.config.storeHash !== initialSnapshot.config.storeHash ||
      snapshot.config.profileId === 'reviewFirst' ||
      JSON.stringify(snapshot) !== JSON.stringify(initialSnapshot)
    ) {
      throw unsupported();
    }
    assertStateOpen(state);
    return snapshot;
  } catch (error) {
    if (state.closeReason === 'cancelled') throw closedStateFailure(state);
    closeState(state);
    throw error;
  }
}

function serializeReaderOperationV4<T>(
  state: AdapterStateV4,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = state.readerQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.readerQueue = previous.then(() => current);
  return previous.then(async () => {
    try {
      return await operation();
    } finally {
      release();
    }
  });
}

function makeAbortListener(reference: WeakRef<AdapterStateV4>): () => void {
  return () => {
    const state = reference.deref();
    if (state) closeState(state, 'cancelled');
  };
}

function makeAccess(state: AdapterStateV4): AutonomousPersonalNativeMemoryAdapterAccessV4 {
  const reference = new WeakRef(state);
  return Object.freeze({
    get owner(): IGraphStorage | null {
      const current = reference.deref();
      return current && !current.closed ? current.owner : null;
    },
    get lineage(): PrivateAutonomousPersonalMemoryLineageV4 | null {
      const current = reference.deref();
      return current && !current.closed ? current.lineage : null;
    },
    get initialSnapshot(): AutonomousPersonalAssistantNativeSnapshotV4 | null {
      const current = reference.deref();
      return current && !current.closed ? current.initialSnapshot : null;
    },
    get signal(): AbortSignal | null {
      const current = reference.deref();
      return current && !current.closed ? current.signal : null;
    },
    get nativeCancellationAvailable(): boolean {
      const current = reference.deref();
      return Boolean(current && !current.closed && current.nativeCancellationAvailable);
    },
    async readSnapshot(): Promise<AutonomousPersonalAssistantNativeSnapshotV4> {
      const current = reference.deref();
      if (!current) throw unsupported();
      return serializeReaderOperationV4(current, () => readFreshSnapshot(current));
    },
    checkOpen(): void {
      const current = reference.deref();
      if (!current) throw unsupported();
      checkStateOpen(current);
    },
  });
}

function readMemoryAdmission(
  ctx: AutonomousPersonalNativeMemoryAdapterContextV4,
  itemIndex: number,
  check: () => void,
): void {
  check();
  let admission: ReturnType<typeof readReplaySafeMemoryNativeContext>;
  try {
    admission = readReplaySafeMemoryNativeContext(ctx as IExecuteFunctions, itemIndex);
  } catch {
    check();
    throw unsupported();
  }
  check();
  if (!admission) throw unsupported();

  let interpreter: unknown;
  try {
    const node = ctx.getNode();
    interpreter = node.parameters?.automaticPreferenceInterpreter;
  } catch {
    check();
    throw unsupported();
  }
  check();
  if (interpreter !== 'autonomousPersonalV1') throw unsupported();
}

/**
 * Prepare a fixed native Memory adapter from one genuine same-execution
 * handoff. It retains no raw context and performs no graph read or write.
 */
export async function prepareNativeAutonomousPersonalMemoryAdapterV4(
  ctx: AutonomousPersonalNativeMemoryAdapterContextV4,
  itemIndex: number,
  currentMemoryStorage: IGraphStorage,
): Promise<PrivateAutonomousPersonalNativeMemoryAdapterTokenV4> {
  return runAutonomousPersonalMemoryPreparationV1(ctx, itemIndex, (registerFailureCleanup) =>
    prepareNativeAdapterWithinPreparationV1(
      ctx,
      itemIndex,
      currentMemoryStorage,
      registerFailureCleanup,
    ),
  );
}

async function prepareNativeAdapterWithinPreparationV1(
  ctx: AutonomousPersonalNativeMemoryAdapterContextV4,
  itemIndex: number,
  currentMemoryStorage: IGraphStorage,
  registerFailureCleanup: (cleanup: () => Promise<void>) => void,
): Promise<PrivateAutonomousPersonalNativeMemoryAdapterTokenV4> {
  if (
    itemIndex !== 0 ||
    !ctx ||
    typeof ctx !== 'object' ||
    utilTypes.isProxy(ctx) ||
    !currentMemoryStorage ||
    typeof currentMemoryStorage !== 'object' ||
    utilTypes.isProxy(currentMemoryStorage)
  ) {
    throw unsupported();
  }

  let reader: AutonomousPersonalNativeMemorySnapshotReaderV4 | null = null;
  let state: AdapterStateV4 | null = null;
  try {
    let deadline: unknown;
    try {
      deadline = ctx.getNodeParameter('extractionDeadlineMs', itemIndex, 30_000);
    } catch {
      throw unsupported();
    }
    const work: WorkV4 = createAutonomousPersonalNativeMemoryWorkV4(ctx, deadline, ctx);
    const check = work.check;

    readMemoryAdmission(ctx, itemIndex, check);
    const ownerHashBefore = readOwnerStoreHash(currentMemoryStorage, check);

    reader = createAutonomousPersonalNativeMemorySnapshotReaderV4(ctx, itemIndex);
    check();
    const initialSnapshot = await reader.read();
    assertAutonomousPersonalMemoryPreparationConfigV1(ctx, initialSnapshot.config);
    check();

    const ownerHashAfter = readOwnerStoreHash(currentMemoryStorage, check);
    if (
      initialSnapshot.config.storeHash !== ownerHashBefore ||
      initialSnapshot.config.storeHash !== ownerHashAfter ||
      initialSnapshot.config.profileId === 'reviewFirst'
    ) {
      throw unsupported();
    }

    state = {
      closed: false,
      closeReason: null,
      owner: currentMemoryStorage,
      lineage: null,
      initialSnapshot,
      reader,
      pendingReaders: new Set(),
      readerQueue: Promise.resolve(),
      signal:
        initialSnapshot.config.executionBudget === undefined
          ? work.work.signal
          : (work.nativeSignal ?? null),
      nativeCancellationAvailable: work.nativeCancellationAvailable,
      abortListener: null,
      access: null,
      cancellationFailure: null,
    };
    const preparedState = state;
    registerFailureCleanup(async () => {
      closeState(preparedState);
    });
    state.access = makeAccess(state);

    if (state.nativeCancellationAvailable) {
      const weakState = new WeakRef(state);
      const abortListener = makeAbortListener(weakState);
      state.abortListener = abortListener;
      state.signal!.addEventListener('abort', abortListener, { once: true });
      check();
    }

    const config: AutonomousPersonalNativeMemoryConfigV4 = initialSnapshot.config;
    check();
    const lineage = consumeAutonomousPersonalMemoryHandoffV4(
      ctx,
      config.storeHash,
      config.namespace,
      config.issuer,
      config.actorReference,
      config.turn,
      config.sourceId,
    );
    check();
    if (!lineage) throw unsupported();

    state.lineage = lineage;
    check();
    const token = Object.freeze(
      Object.create(null),
    ) as PrivateAutonomousPersonalNativeMemoryAdapterTokenV4;
    issuedTokensV4.set(token, state);
    tokenStatesV4.set(token, state);
    reader = null;
    state = null;
    return token;
  } catch (error) {
    if (state) closeState(state);
    else {
      try {
        reader?.close();
      } catch {
        // Preserve the setup failure.
      }
    }
    throw error;
  }
}

/** Synchronously consume one prepared token and bind its state to a Memory instance. */
export function consumeAutonomousPersonalNativeMemoryAdapterV4(
  owner: IGraphStorage,
  tokenValue: unknown,
  memoryInstance: unknown,
): boolean {
  if (
    !isObject(owner) ||
    utilTypes.isProxy(owner) ||
    !isObject(tokenValue) ||
    utilTypes.isProxy(tokenValue) ||
    !isObject(memoryInstance) ||
    utilTypes.isProxy(memoryInstance)
  ) {
    return false;
  }

  const existing = memoryStatesV4.get(memoryInstance);
  if (existing && !existing.closed) return false;
  if (existing?.closed) memoryStatesV4.delete(memoryInstance);

  const state = issuedTokensV4.get(tokenValue);
  if (!state || state.closed || state.owner !== owner) return false;

  try {
    checkStateOpen(state);
  } catch (error) {
    closeState(state);
    throw error;
  }
  issuedTokensV4.delete(tokenValue);
  memoryStatesV4.set(memoryInstance, state);
  return true;
}

/** Return only the fixed frozen access view for an open Memory instance. */
export function getAutonomousPersonalNativeMemoryAdapterAccessV4(
  memoryInstance: unknown,
): AutonomousPersonalNativeMemoryAdapterAccessV4 | null {
  if (!isObject(memoryInstance) || utilTypes.isProxy(memoryInstance)) return null;
  const state = memoryStatesV4.get(memoryInstance);
  if (!state || state.closed || !state.access) return null;
  return state.access;
}

/** Rebind the retained reader for this exact Memory after a fresh equal host read. */
export async function refreshAutonomousPersonalNativeMemoryAdapterV4(
  owner: IGraphStorage,
  memoryInstance: unknown,
  ctx: AutonomousPersonalNativeMemoryAdapterContextV4,
  itemIndex: number,
): Promise<boolean> {
  return runAutonomousPersonalMemoryPreparationV1(ctx, itemIndex, (registerFailureCleanup) =>
    refreshNativeAdapterWithinPreparationV1(
      owner,
      memoryInstance,
      ctx,
      itemIndex,
      registerFailureCleanup,
    ),
  );
}

async function refreshNativeAdapterWithinPreparationV1(
  owner: IGraphStorage,
  memoryInstance: unknown,
  ctx: AutonomousPersonalNativeMemoryAdapterContextV4,
  itemIndex: number,
  registerFailureCleanup: (cleanup: () => Promise<void>) => void,
): Promise<boolean> {
  if (
    !isObject(owner) ||
    utilTypes.isProxy(owner) ||
    !isObject(memoryInstance) ||
    utilTypes.isProxy(memoryInstance)
  )
    return false;

  const state = memoryStatesV4.get(memoryInstance);
  if (!state) return false;
  if (state.closed) return false;
  if (state.owner !== owner) {
    closeState(state);
    return false;
  }

  registerFailureCleanup(async () => {
    closeState(state);
  });
  const candidateReader: { value: AutonomousPersonalNativeMemorySnapshotReaderV4 | null } = {
    value: null,
  };
  try {
    if (!ctx || typeof ctx !== 'object' || utilTypes.isProxy(ctx) || itemIndex !== 0)
      throw unsupported();
    let deadline: unknown;
    try {
      deadline = ctx.getNodeParameter('extractionDeadlineMs', itemIndex, 30_000);
    } catch {
      throw unsupported();
    }
    const work = createAutonomousPersonalNativeMemoryWorkV4(ctx, deadline, ctx);
    work.check();
    assertStateOpen(state);
    if (
      !state.nativeCancellationAvailable ||
      !work.nativeCancellationAvailable ||
      work.nativeSignal !== state.signal
    ) {
      throw unsupported();
    }

    return await serializeReaderOperationV4(state, async () => {
      assertStateOpen(state);
      work.check();
      const originalSnapshot = state.initialSnapshot;
      if (!originalSnapshot || state.owner !== owner || state.reader === null) throw unsupported();

      readMemoryAdmission(ctx, itemIndex, work.check);
      const ownerHashBefore = readOwnerStoreHash(owner, work.check);
      if (ownerHashBefore !== originalSnapshot.config.storeHash) throw unsupported();

      candidateReader.value = createAutonomousPersonalNativeMemorySnapshotReaderV4(ctx, itemIndex);
      state.pendingReaders.add(candidateReader.value);
      work.check();
      const candidateSnapshot = await candidateReader.value.read();
      assertAutonomousPersonalMemoryPreparationConfigV1(ctx, candidateSnapshot.config);
      work.check();
      assertStateOpen(state);

      const ownerHashAfter = readOwnerStoreHash(owner, work.check);
      if (
        ownerHashAfter !== originalSnapshot.config.storeHash ||
        candidateSnapshot.config.storeHash !== ownerHashAfter ||
        JSON.stringify(candidateSnapshot) !== JSON.stringify(originalSnapshot)
      ) {
        throw unsupported();
      }

      work.check();
      assertStateOpen(state);
      const previousReader = state.reader;
      if (
        !previousReader ||
        !candidateReader.value ||
        !state.pendingReaders.delete(candidateReader.value)
      )
        throw unsupported();
      state.reader = candidateReader.value;
      candidateReader.value = null;
      try {
        previousReader.close();
      } catch {
        // A validated reader is already installed; old-reader cleanup is best-effort.
      }
      return true;
    });
  } catch (error) {
    if (candidateReader.value) {
      state.pendingReaders.delete(candidateReader.value);
      try {
        candidateReader.value.close();
      } catch {
        // The candidate reader is private and its close is idempotent.
      }
    }
    if (state.closeReason === 'cancelled') throw closedStateFailure(state);
    closeState(state);
    if (error instanceof ExtractionBudgetError) throw error;
    return false;
  }
}

/** Close one Memory instance's adapter without clearing or writing memory data. */
export function closeAutonomousPersonalNativeMemoryAdapterV4(memoryInstance: unknown): void {
  if (!isObject(memoryInstance) || utilTypes.isProxy(memoryInstance)) return;
  const state = memoryStatesV4.get(memoryInstance);
  if (!state) return;
  memoryStatesV4.delete(memoryInstance);
  closeState(state);
}

/** Close either an issued token or a token already consumed by its owner. */
export function closePreparedAutonomousPersonalNativeMemoryAdapterV4(
  owner: IGraphStorage,
  tokenValue: unknown,
): void {
  if (
    !isObject(owner) ||
    utilTypes.isProxy(owner) ||
    !isObject(tokenValue) ||
    utilTypes.isProxy(tokenValue)
  ) {
    return;
  }
  const state = tokenStatesV4.get(tokenValue);
  if (!state || state.owner !== owner) return;
  issuedTokensV4.delete(tokenValue);
  tokenStatesV4.delete(tokenValue);
  closeState(state);
}
