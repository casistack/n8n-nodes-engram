import { readNativeAutonomousPersonalExecutionBudgetV1 } from '../../utils/autonomousPersonalExecutionBudget';
import { runAutonomousPersonalMemoryPreparationV1 } from '../../utils/AutonomousPersonalMemoryExecutionEntryV1';
import { currentAutonomousPersonalExecutionScopeWorkV1 } from '../../storage/AutonomousPersonalExecutionScopeV1';
import { advancedExtractionProperties, readExtractionPolicy } from '../../utils/advancedExtraction';
import { automaticMemoryProperties, readAutomaticRuntime } from '../../utils/automaticMemory';
import {
  readReplaySafeMemoryNativeContext,
  readReplaySafeMemoryNamespace,
} from '../../utils/replaySafeMemoryNative';
import {
  embeddedAutomaticCaptureStoreHash,
  neo4jAutomaticCaptureStoreHash,
} from '../../storage/AutomaticCaptureStore';
import { fingerprint } from '../../extraction/QueueState';
import { types as utilTypes } from 'node:util';
import {
  CurrentHumanQuerySchema,
  ExtractionTemperatureSchema,
  MemoryPolicySchema,
} from '../../schemas';
/* eslint-disable n8n-nodes-base/node-dirname-against-convention */
import {
  NodeConnectionType,
  type IExecuteFunctions,
  type INodeType,
  type INodeTypeDescription,
  type SupplyData,
  type ILoadOptionsFunctions,
  type INodePropertyOptions,
  type INodeProperties,
  NodeOperationError,
} from 'n8n-workflow';

import { logWrapper } from '../../utils/logWrapper';
import { getConnectionHintNoticeField } from '../../utils/sharedFields';
import {
  sessionIdOption,
  sessionKeyProperty,
  contextWindowLengthProperty,
  customStoragePathProperty,
} from '../../descriptions';
import { getSessionId, resolveStoragePath, migrateStorageIfNeeded } from '../../utils/helpers';

import { EngramChatMemory } from '../../memory/EngramChatMemory';
import { createStorage } from '../../storage/StorageFactory';
import type { IGraphStorage } from '../../storage/IGraphStorage';
import {
  prepareNativeAutonomousPersonalMemoryAdapterV4,
  closePreparedAutonomousPersonalNativeMemoryAdapterV4,
  refreshAutonomousPersonalNativeMemoryAdapterV4,
  type PrivateAutonomousPersonalNativeMemoryAdapterTokenV4,
} from '../../memory/AutonomousPersonalNativeMemoryAdapterV4';
import { cloneBoundedAutomaticCaptureJson } from '../../storage/BoundedAutomaticCaptureJson';
import { registerNativeMemoryWorkflowFinalizerV4 } from '../../utils/nativeMemoryWorkflowLifecycleV4';

type NativeMemoryRunLeaseV4 = {
  active: boolean;
  inFlight: number;
  drainPromise: Promise<void> | null;
  resolveDrain: (() => void) | null;
};

type NativeMemoryContinuationV4 = {
  readonly scopeHash: string;
  readonly settingsHash: string;
  readonly signalRef: WeakRef<AbortSignal>;
  readonly signalState: NativeMemoryContinuationSignalStateV4;
  phase: 'initializing' | 'active' | 'closing' | 'closed';
  lifecycleMode: 'uninitialized' | 'workflow' | 'legacy';
  ready: Promise<boolean>;
  resolveReady: (ready: boolean) => void;
  memory: EngramChatMemory | null;
  storage: IGraphStorage | null;
  backend: string | null;
  storageClosePromise: Promise<void> | null;
  adapterToken: PrivateAutonomousPersonalNativeMemoryAdapterTokenV4 | null;
  abortListener: ((event: Event) => void) | null;
  closePromise: Promise<void> | null;
  operationTail: Promise<void>;
  operationInFlight: number;
  runLease: NativeMemoryRunLeaseV4 | null;
};

type NativeMemoryContinuationSignalStateV4 = {
  readonly records: Map<string, NativeMemoryContinuationV4>;
  readonly spentScopes: Set<string>;
};

const nativeMemoryContinuationsV4 = new WeakMap<
  AbortSignal,
  NativeMemoryContinuationSignalStateV4
>();
const nativeMemoryLeaseMethodsV4 = new Set([
  'loadMemoryVariables',
  'loadMemoryVariablesWithDiagnostics',
  'saveContext',
  'saveContextWithDelivery',
  'saveContextWithOutcome',
  'saveMessagesWithOutcome',
  'saveMessagesWithDelivery',
]);
const nativeHistoryLeaseMethodsV4 = new Set([
  'getMessages',
  'getMessagesWithDiagnostics',
  'addMessages',
  'addMessagesWithOutcome',
  'addMessagesWithDelivery',
  'addMessage',
  'addMessageAndGetEpisodeUuid',
  'addMessageAndGetEpisode',
  'addMessagesAndGetEpisodes',
  'appendMessageWrites',
  'addUserMessage',
  'addAIMessage',
  'addAIChatMessage',
  'clear',
]);
const nativeContinuationAbortedGetterV4 = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;
const MAX_NATIVE_MEMORY_CONTINUATIONS_PER_SIGNAL_V4 = 8;

function createNativeMemoryRunLeaseV4(): NativeMemoryRunLeaseV4 {
  return { active: true, inFlight: 0, drainPromise: null, resolveDrain: null };
}

function finishNativeMemoryRunLeaseOperationV4(lease: NativeMemoryRunLeaseV4): void {
  lease.inFlight = Math.max(0, lease.inFlight - 1);
  if (!lease.active && lease.inFlight === 0) lease.resolveDrain?.();
}

function trackNativeMemoryRunLeaseOperationV4<T>(
  lease: NativeMemoryRunLeaseV4,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!lease.active)
    return Promise.reject(new Error('Engram replay-safe memory: initialization_failed'));
  lease.inFlight += 1;
  let result: T | Promise<T>;
  try {
    result = operation();
  } catch (error) {
    finishNativeMemoryRunLeaseOperationV4(lease);
    return Promise.reject(error);
  }
  return Promise.resolve(result).finally(() => finishNativeMemoryRunLeaseOperationV4(lease));
}

function sealNativeMemoryRunLeaseV4(lease: NativeMemoryRunLeaseV4 | null): Promise<void> {
  if (!lease) return Promise.resolve();
  lease.active = false;
  if (lease.inFlight === 0) return Promise.resolve();
  if (!lease.drainPromise) {
    lease.drainPromise = new Promise<void>((resolve) => {
      lease.resolveDrain = resolve;
    });
  }
  return lease.drainPromise;
}

function guardNativeMemoryLeaseObjectV4<T extends object>(
  target: T,
  lease: NativeMemoryRunLeaseV4,
  methodNames: ReadonlySet<string>,
  historyGetter = false,
): T {
  let history: object | null = null;
  return new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver) as unknown;
      if (
        historyGetter &&
        property === 'chatHistory' &&
        value !== null &&
        typeof value === 'object'
      ) {
        history ??= guardNativeMemoryLeaseObjectV4(value, lease, nativeHistoryLeaseMethodsV4);
        return history;
      }
      if (typeof property === 'string' && methodNames.has(property) && typeof value === 'function')
        return (...args: unknown[]) =>
          trackNativeMemoryRunLeaseOperationV4(lease, () => Reflect.apply(value, current, args));
      return value;
    },
  });
}

function guardNativeMemoryResponseV4<T extends object>(
  response: T,
  lease: NativeMemoryRunLeaseV4,
): T {
  return guardNativeMemoryLeaseObjectV4(response, lease, nativeMemoryLeaseMethodsV4, true);
}

function isNativeAbortSignalV4(value: unknown): value is AbortSignal {
  if (
    !value ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !nativeContinuationAbortedGetterV4
  )
    return false;
  try {
    nativeContinuationAbortedGetterV4.call(value);
    return (
      typeof (value as AbortSignal).addEventListener === 'function' &&
      typeof (value as AbortSignal).removeEventListener === 'function'
    );
  } catch {
    return false;
  }
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Drop only absent optionals from the locally built fingerprint projection. */
function omitAbsentNativeMemorySettingsV4(value: unknown): unknown {
  const active = new WeakSet<object>();
  let visited = 0;
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 32 || ++visited > 16_384)
      throw new Error('Engram replay-safe memory: unsupported_configuration');
    if (current === undefined || current === null || typeof current !== 'object') return current;
    if (utilTypes.isProxy(current) || active.has(current))
      throw new Error('Engram replay-safe memory: unsupported_configuration');
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !('value' in descriptor))
            throw new Error('Engram replay-safe memory: unsupported_configuration');
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('Engram replay-safe memory: unsupported_configuration');
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
          throw new Error('Engram replay-safe memory: unsupported_configuration');
        if (descriptor.value !== undefined) result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(current);
    }
  };
  return visit(value, 0);
}

function nativeMemoryContinuationScopeV4(
  ctx: IExecuteFunctions,
): { signal: AbortSignal; scopeHash: string } | undefined {
  try {
    const signal = ctx.getExecutionCancelSignal();
    if (!isNativeAbortSignalV4(signal) || nativeContinuationAbortedGetterV4?.call(signal) !== false)
      return undefined;

    // n8n 2.12.3's SupplyDataContext exposes this pinned runtime field, but it
    // is intentionally not treated as workflow data or retained in the cache.
    const parentNode = ownDataValue(ctx, 'parentNode');
    if (!parentNode || typeof parentNode !== 'object' || utilTypes.isProxy(parentNode))
      return undefined;
    const parentId = ownDataValue(parentNode, 'id');
    const parentType = ownDataValue(parentNode, 'type');
    const parentVersion = ownDataValue(parentNode, 'typeVersion');
    const parentName = ownDataValue(parentNode, 'name');
    if (
      typeof parentId !== 'string' ||
      !parentId ||
      parentType !== '@n8n/n8n-nodes-langchain.agent' ||
      parentVersion !== 3.1 ||
      typeof parentName !== 'string' ||
      !parentName
    )
      return undefined;

    const node = ctx.getNode();
    if (
      node.type !== 'n8n-nodes-engram.engramMemory' ||
      node.typeVersion !== 3 ||
      typeof node.id !== 'string' ||
      !node.id
    )
      return undefined;

    const instance = ctx.getInstanceId();
    const workflow = ctx.getWorkflow().id;
    const execution = ctx.getExecutionId();
    if (
      typeof instance !== 'string' ||
      !instance ||
      typeof workflow !== 'string' ||
      !workflow ||
      typeof execution !== 'string' ||
      !execution
    )
      return undefined;

    return {
      signal,
      scopeHash: fingerprint({
        native: { instance, workflow, execution },
        memory: { id: node.id, type: node.type, version: node.typeVersion },
        parent: {
          id: parentId,
          type: parentType,
          version: parentVersion,
          name: parentName,
        },
      }),
    };
  } catch {
    return undefined;
  }
}

function removeNativeContinuationFromSignalV4(
  signal: AbortSignal,
  state: NativeMemoryContinuationSignalStateV4,
  record: NativeMemoryContinuationV4,
): void {
  if (state.records.get(record.scopeHash) === record) state.records.delete(record.scopeHash);
  state.spentScopes.add(record.scopeHash);
  const listener = record.abortListener;
  record.abortListener = null;
  if (listener) {
    try {
      signal.removeEventListener('abort', listener);
    } catch {
      // The host signal is only an eviction hint; record close remains authoritative.
    }
  }
}

function makeNativeMemoryContinuationAbortListenerV4(
  reference: WeakRef<NativeMemoryContinuationV4>,
): (event: Event) => void {
  return (event: Event) => {
    const current = reference.deref();
    if (!current) return;
    const eventSignal = event.currentTarget;
    if (!isNativeAbortSignalV4(eventSignal)) {
      void closeNativeMemoryContinuationV4(current, undefined, undefined, true).catch(
        () => undefined,
      );
      return;
    }
    const currentState = nativeMemoryContinuationsV4.get(eventSignal);
    if (currentState) removeNativeContinuationFromSignalV4(eventSignal, currentState, current);
    void closeNativeMemoryContinuationV4(current, undefined, undefined, true).catch(
      () => undefined,
    );
  };
}

function closeNativeContinuationOwnerOnceV4(
  record: NativeMemoryContinuationV4,
  storage: IGraphStorage,
): Promise<void> {
  if (!record.storageClosePromise) {
    try {
      record.storageClosePromise = Promise.resolve(storage.close());
    } catch (error) {
      record.storageClosePromise = Promise.reject(error);
    }
    void record.storageClosePromise.catch(() => undefined);
  }
  return record.storageClosePromise;
}

function closeNativeMemoryContinuationV4(
  record: NativeMemoryContinuationV4,
  signal?: AbortSignal,
  signalState?: NativeMemoryContinuationSignalStateV4,
  aborted = false,
): Promise<void> {
  if (record.phase === 'closed') return record.closePromise ?? Promise.resolve();
  const initializationPending = record.phase === 'initializing';
  if (record.phase !== 'closing') record.phase = 'closing';
  const currentSignal = signal ?? record.signalRef.deref();
  const currentState = signalState ?? record.signalState;
  if (currentSignal && currentState)
    removeNativeContinuationFromSignalV4(currentSignal, currentState, record);
  if (record.closePromise) return record.closePromise;

  const storageBeforeWait = record.storage;
  if (aborted && initializationPending && record.backend === 'neo4j' && storageBeforeWait)
    void closeNativeContinuationOwnerOnceV4(record, storageBeforeWait).catch(() => undefined);

  const pendingOperations = record.operationTail;
  const leaseDrain = sealNativeMemoryRunLeaseV4(record.runLease);
  if (
    !initializationPending &&
    record.operationInFlight === 0 &&
    (record.runLease?.inFlight ?? 0) === 0
  ) {
    const memory = record.memory;
    record.memory = null;
    if (memory) memory.closeNativeMemoryV4();

    const adapterToken = record.adapterToken;
    record.adapterToken = null;
    if (storageBeforeWait && adapterToken)
      closePreparedAutonomousPersonalNativeMemoryAdapterV4(storageBeforeWait, adapterToken);
  }
  record.closePromise = (async () => {
    await pendingOperations;
    await leaseDrain;
    if (record.phase !== 'active') await record.ready;
    const memory = record.memory;
    record.memory = null;
    if (memory) memory.closeNativeMemoryV4();

    const storage = record.storage;
    const backend = record.backend;
    const adapterToken = record.adapterToken;
    record.adapterToken = null;
    if (storage && adapterToken)
      closePreparedAutonomousPersonalNativeMemoryAdapterV4(storage, adapterToken);
    try {
      if (storage && backend === 'neo4j') await closeNativeContinuationOwnerOnceV4(record, storage);
    } finally {
      record.storage = null;
      record.backend = null;
      record.runLease = null;
      record.phase = 'closed';
    }
  })();
  return record.closePromise;
}

function closeNativeMemoryWorkflowContinuationV4(record: object): Promise<void> {
  const continuation = record as NativeMemoryContinuationV4;
  return closeNativeMemoryContinuationV4(
    continuation,
    continuation.signalRef.deref(),
    continuation.signalState,
  );
}

function registerNativeMemoryWorkflowContinuationV4(
  ctx: IExecuteFunctions,
  record: NativeMemoryContinuationV4,
): 'workflow' | 'legacy' {
  const result = registerNativeMemoryWorkflowFinalizerV4(
    ctx,
    record,
    closeNativeMemoryWorkflowContinuationV4,
  );
  return result === 'registered' ? 'workflow' : 'legacy';
}

function nativeMemoryContinuationRunCloseFunctionV4(
  record: NativeMemoryContinuationV4,
  signal: AbortSignal,
  signalState: NativeMemoryContinuationSignalStateV4,
  lease: NativeMemoryRunLeaseV4,
): () => Promise<void> {
  let releasePromise: Promise<void> | null = null;
  return () => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      await sealNativeMemoryRunLeaseV4(lease);
      await record.operationTail;
      if (nativeContinuationAbortedGetterV4?.call(signal))
        await closeNativeMemoryContinuationV4(record, signal, signalState, true).catch(
          () => undefined,
        );
    })();
    void releasePromise.catch(() => undefined);
    return releasePromise;
  };
}

function nativeMemoryContinuationResponseV4(
  record: NativeMemoryContinuationV4,
  ctx: IExecuteFunctions,
): SupplyData {
  if (record.phase !== 'active' || record.lifecycleMode !== 'workflow' || !record.memory)
    throw new Error('Engram replay-safe memory: initialization_failed');
  const lease = createNativeMemoryRunLeaseV4();
  record.runLease = lease;
  const signal = record.signalRef.deref();
  if (!signal) throw new Error('Engram replay-safe memory: initialization_failed');
  const loggedResponse = logWrapper(record.memory, ctx);
  if (!loggedResponse || typeof loggedResponse !== 'object')
    throw new Error('Engram replay-safe memory: initialization_failed');
  return {
    response: guardNativeMemoryResponseV4(loggedResponse, lease),
    closeFunction: nativeMemoryContinuationRunCloseFunctionV4(
      record,
      signal,
      record.signalState,
      lease,
    ),
  };
}

function reserveNativeMemoryContinuationV4(
  signal: AbortSignal,
  scopeHash: string,
  settingsHash: string,
): {
  state: NativeMemoryContinuationSignalStateV4;
  record: NativeMemoryContinuationV4;
  initial: boolean;
} {
  let state = nativeMemoryContinuationsV4.get(signal);
  if (!state) {
    state = { records: new Map(), spentScopes: new Set() };
    nativeMemoryContinuationsV4.set(signal, state);
  }
  const existing = state.records.get(scopeHash);
  if (existing) return { state, record: existing, initial: false };
  if (
    state.spentScopes.has(scopeHash) ||
    state.spentScopes.size >= MAX_NATIVE_MEMORY_CONTINUATIONS_PER_SIGNAL_V4
  )
    throw new Error('Engram replay-safe memory: initialization_failed');

  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  const record: NativeMemoryContinuationV4 = {
    scopeHash,
    settingsHash,
    signalRef: new WeakRef(signal),
    signalState: state,
    phase: 'initializing',
    lifecycleMode: 'uninitialized',
    ready,
    resolveReady,
    memory: null,
    storage: null,
    backend: null,
    storageClosePromise: null,
    adapterToken: null,
    abortListener: null,
    closePromise: null,
    operationTail: Promise.resolve(),
    operationInFlight: 0,
    runLease: null,
  };
  state.records.set(scopeHash, record);
  state.spentScopes.add(scopeHash);

  record.abortListener = makeNativeMemoryContinuationAbortListenerV4(new WeakRef(record));
  signal.addEventListener('abort', record.abortListener, { once: true });
  if (nativeContinuationAbortedGetterV4?.call(signal)) {
    removeNativeContinuationFromSignalV4(signal, state, record);
    record.phase = 'closing';
    resolveNativeMemoryContinuationV4(record, false);
    void closeNativeMemoryContinuationV4(record, signal, state, true).catch(() => undefined);
    throw new Error('Engram replay-safe memory: initialization_failed');
  }
  return { state, record, initial: true };
}

function resolveNativeMemoryContinuationV4(
  record: NativeMemoryContinuationV4,
  ready: boolean,
): void {
  if (record.phase === 'initializing' && ready) record.phase = 'active';
  record.resolveReady(ready);
}

function serializeNativeMemoryContinuationOperationV4<T>(
  record: NativeMemoryContinuationV4,
  operation: () => Promise<T>,
): Promise<T> {
  const current = record.operationTail.then(async () => {
    record.operationInFlight += 1;
    try {
      return await operation();
    } finally {
      record.operationInFlight = Math.max(0, record.operationInFlight - 1);
    }
  });
  record.operationTail = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function nativeMemoryContinuationSettingsHashV4(
  ctx: IExecuteFunctions,
  itemIndex: number,
  sessionId: string,
  nativeCapture: unknown,
  nativeConfiguration: unknown,
): string {
  const node = ctx.getNode();
  const nodeVersion = node.typeVersion ?? 1;
  const usesGovernanceControls = nodeVersion >= 2;
  const get = (name: string, fallback: unknown) =>
    ctx.getNodeParameter(name, itemIndex, fallback as string) as unknown;
  const credentialReference = (name: string) => {
    const reference = node.credentials?.[name];
    return reference ? { id: reference.id ?? null, name: reference.name ?? null } : null;
  };
  const policy = MemoryPolicySchema.parse(
    usesGovernanceControls
      ? {
          historyFilter: get('historyFilter', 'off'),
          maxHistoryScan: get('maxHistoryScan', 1000),
          legacyArtifactHashes: (get('legacyArtifactHashes', '') as string)
            .split(/[\s,]+/)
            .filter(Boolean),
          finalTurnWrites: get('messageWritePolicy', 'legacy') === 'finalTurns',
          storeToolAudit: get('storeToolAudit', 'disabled') === 'enabled',
        }
      : {},
  );
  const attributes = cloneBoundedAutomaticCaptureJson(
    parseEpisodeAttributes(get('episodeAttributes', '{}')),
    'beginRequest',
  );
  const embeddingEnabled = get('enableEmbeddings', 'disabled') === 'enabled';
  const embeddingModel = embeddingEnabled ? get('embeddingModel', '') : '';
  const graphContextPolicy = usesGovernanceControls
    ? get('graphContextPolicy', 'legacy')
    : 'legacy';
  const graphContextAt = usesGovernanceControls ? get('graphContextAt', '') : undefined;
  const graphEvidenceBudgets = usesGovernanceControls
    ? {
        durable: get('graphDurableTokens', 4096),
        historical: get('graphHistoricalTokens', 2048),
      }
    : undefined;
  const currentHumanQuery = usesGovernanceControls ? get('currentHumanQuery', '') : '';
  const nativeCaptureHash = fingerprint(
    cloneBoundedAutomaticCaptureJson(
      omitAbsentNativeMemorySettingsV4(nativeCapture),
      'beginRequest',
    ),
  );
  const nativeConfigurationHash = fingerprint(
    cloneBoundedAutomaticCaptureJson(
      omitAbsentNativeMemorySettingsV4(nativeConfiguration),
      'beginRequest',
    ),
  );
  const currentHumanQueryHash = fingerprint(
    cloneBoundedAutomaticCaptureJson({ currentHumanQuery }, 'beginRequest'),
  );
  const retrievalFilters = usesGovernanceControls
    ? omitAbsentNativeMemorySettingsV4({
        sender_id: (get('retrievalSenderId', '') as string).trim() || undefined,
        episode_kind: get('retrievalEpisodeKind', '') || undefined,
        trust_level: get('retrievalTrustLevel', '') || undefined,
        source_workflow_id: (get('retrievalSourceWorkflowId', '') as string).trim() || undefined,
        source_execution_id: (get('retrievalSourceExecutionId', '') as string).trim() || undefined,
        reference_after: get('retrievalReferenceAfter', '') || undefined,
        reference_before: get('retrievalReferenceBefore', '') || undefined,
      })
    : undefined;
  const workflowId = ctx.getWorkflow().id ?? null;
  const storageBinding =
    get('backend', 'embedded') === 'embedded'
      ? {
          backend: 'embedded',
          persistPath: resolveStoragePath({
            customStoragePath: get('customStoragePath', '') as string,
            workflowId: workflowId ?? 'default',
          }),
        }
      : {
          backend: get('backend', 'embedded'),
          credentialReference: credentialReference('engramNeo4jApi'),
        };

  const executionBudget = readNativeAutonomousPersonalExecutionBudgetV1(node.parameters, get);
  const projection = {
    ...(executionBudget === undefined ? {} : { executionBudget }),
    nativeCaptureHash,
    nativeConfigurationHash,
    storageBinding,
    credentialReferences: {
      neo4j: credentialReference('engramNeo4jApi'),
      extraction: credentialReference('engramExtractionApi'),
    },
    nodeVersion,
    interpreter: node.parameters?.automaticPreferenceInterpreter ?? null,
    sessionId,
    memory: {
      contextWindow: get('contextWindowLength', 10),
      maxFactsPerQuery: get('maxFactsPerQuery', 10),
      minRelevanceScore: get('minRelevanceScore', 0.5),
      requestedExtraction: get('enableExtraction', 'disabled'),
      extractionModel: get('extractionModel', ''),
      extractionRouteId: get('extractionRouteId', ''),
      extractionExecution: usesGovernanceControls
        ? get('extractionExecution', 'synchronous')
        : 'synchronous',
      extractionTemperatureMode: get('extractionTemperatureMode', 'legacy'),
      extractionTemperature: get('extractionTemperature', 0),
      enableEmbeddings: embeddingEnabled,
      embeddingModel,
      embeddingCredentialReference:
        embeddingEnabled && embeddingModel ? credentialReference('engramExtractionApi') : null,
      enableTraversal: get('enableTraversal', 'disabled'),
      traversalHops: get('traversalHops', 1),
      storeHumanEpisodes: get('storeHumanEpisodes', 'enabled'),
      humanEpisodeKind: get('humanEpisodeKind', 'active_human'),
      storeAiEpisodes: get('storeAiEpisodes', 'enabled'),
      extractHuman: get('extractHuman', 'enabled'),
      extractAi: get('extractAi', 'disabled'),
      extractSystemTool: get('extractSystemTool', 'disabled'),
      acceptedOnlyRetrieval: get('memoryFactPolicy', 'acceptedOnly'),
      contextTokenBudget: get('contextTokenBudget', 2000),
      includeProvenanceInContext: usesGovernanceControls,
      retrievalMode: graphContextPolicy,
      retrievalAt: graphContextAt,
      graphEvidenceBudgets,
      retrievalFilters,
      extractionThresholdPolicy: usesGovernanceControls
        ? {
            autoAcceptThreshold: get('autoAcceptConfidence', 0.85),
            rejectBelowThreshold: get('rejectBelowConfidence', 0.3),
          }
        : undefined,
      memoryPolicy: policy,
      currentHumanQueryHash,
      retentionType: get('retentionType', 'forever'),
      retentionValue: get('retentionValue', 30),
      episodeMetadata: usesGovernanceControls
        ? {
            source_message_id: (get('sourceMessageId', '') as string).trim() || null,
            idempotency_key: (get('episodeIdempotencyKey', '') as string).trim() || null,
            conversation_id: (get('conversationId', '') as string).trim() || sessionId,
            sender_id: (get('senderId', '') as string).trim() || null,
            sender_name: (get('senderName', '') as string).trim() || null,
            quoted_message_id: (get('quotedMessageId', '') as string).trim() || null,
            trust_level: get('episodeTrustLevel', 'standard'),
            source_workflow_id: workflowId,
            source_execution_id: ctx.getExecutionId(),
            attributes,
          }
        : undefined,
    },
  };
  return fingerprint(
    cloneBoundedAutomaticCaptureJson(omitAbsentNativeMemorySettingsV4(projection), 'beginRequest'),
  );
}

function nativeMemoryContinuationCloseFunctionV4(
  record: NativeMemoryContinuationV4,
  signal: AbortSignal,
  signalState: NativeMemoryContinuationSignalStateV4,
): () => Promise<void> {
  return async () => {
    await closeNativeMemoryContinuationV4(record, signal, signalState);
  };
}

async function reuseNativeMemoryContinuationV4(
  ctx: IExecuteFunctions,
  itemIndex: number,
  signal: AbortSignal,
  signalState: NativeMemoryContinuationSignalStateV4,
  record: NativeMemoryContinuationV4,
  settingsHash: string,
): Promise<SupplyData> {
  try {
    const lifecycleMode = registerNativeMemoryWorkflowContinuationV4(ctx, record);
    if (record.lifecycleMode !== lifecycleMode) throw new Error('invalid continuation lifecycle');
    if (
      record.settingsHash !== settingsHash ||
      record.phase === 'closing' ||
      record.phase === 'closed'
    )
      throw new Error('Engram replay-safe memory: initialization_failed');
    if (!(await record.ready) || record.phase !== 'active' || !record.memory || !record.storage)
      throw new Error('Engram replay-safe memory: initialization_failed');

    return await serializeNativeMemoryContinuationOperationV4(record, async () => {
      if (record.phase !== 'active' || !record.memory || !record.storage)
        throw new Error('Engram replay-safe memory: initialization_failed');
      if (record.lifecycleMode === 'workflow') await sealNativeMemoryRunLeaseV4(record.runLease);
      if (record.phase !== 'active' || !record.memory || !record.storage)
        throw new Error('Engram replay-safe memory: initialization_failed');
      const memory = record.memory;
      const storage = record.storage;
      const refreshed = await refreshAutonomousPersonalNativeMemoryAdapterV4(
        storage,
        memory,
        ctx as IExecuteFunctions & { getExecutionCancelSignal: () => AbortSignal | undefined },
        itemIndex,
      );
      if (!refreshed || record.phase !== 'active' || record.memory !== memory)
        throw new Error('Engram replay-safe memory: initialization_failed');
      if (record.lifecycleMode === 'workflow')
        return nativeMemoryContinuationResponseV4(record, ctx);
      return {
        response: logWrapper(memory, ctx),
        closeFunction: nativeMemoryContinuationCloseFunctionV4(record, signal, signalState),
      };
    });
  } catch {
    await closeNativeMemoryContinuationV4(record, signal, signalState).catch(() => undefined);
    throw new NodeOperationError(ctx.getNode(), 'Engram replay-safe memory: initialization_failed');
  }
}

/** n8n prunes hidden settings before execution; native reads need their own visible descriptions. */
function withNativeMemorySettings(properties: INodeProperties[]): INodeProperties[] {
  const names = new Set([
    'extractionModel',
    'extractionTemperatureMode',
    'extractionTemperature',
    'extractionRouteId',
    'extractionExecution',
    'maxFactsPerQuery',
    'minRelevanceScore',
    'enableEmbeddings',
    'embeddingModel',
    'enableTraversal',
    'traversalHops',
  ]);
  return properties.flatMap((property) => {
    if (!names.has(property.name)) return [property];
    const nativeShow = { ...property.displayOptions?.show };
    delete nativeShow.enableExtraction;
    if (property.name === 'extractionRouteId') delete nativeShow.extractionExecution;
    return [
      {
        ...property,
        displayOptions: {
          ...property.displayOptions,
          hide: {
            ...property.displayOptions?.hide,
            automaticPreferenceInterpreter: ['autonomousPersonalV1'],
          },
        },
      },
      {
        ...property,
        displayOptions: {
          ...property.displayOptions,
          show: {
            ...nativeShow,
            '@version': [3],
            automaticPreferenceInterpreter: ['autonomousPersonalV1'],
          },
        },
      },
    ];
  });
}

export class EngramMemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Engram Memory',
    name: 'engramMemory',
    icon: 'file:engram.png',
    group: ['transform'],
    version: [1, 2, 3],
    description:
      'Knowledge graph memory for AI agents. Stores conversations as episodes and optionally extracts entities and relationships.',
    defaults: {
      name: 'Engram Memory',
    },
    codex: {
      categories: ['AI'],
      subcategories: {
        AI: ['Memory'],
      },
      resources: {
        primaryDocumentation: [
          {
            url: 'https://github.com/casistack/n8n-nodes-engram',
          },
        ],
      },
    },
    inputs: [],
    outputs: [NodeConnectionType.AiMemory],
    outputNames: ['Memory'],
    credentials: [
      {
        name: 'engramNeo4jApi',
        required: false,
        displayOptions: {
          show: {
            backend: ['neo4j'],
          },
        },
      },
      {
        name: 'engramExtractionApi',
        required: false,
      },
    ],
    properties: withNativeMemorySettings([
      ...automaticMemoryProperties,
      {
        displayName: 'Captured Turn Lifecycle',
        name: 'automaticCaptureLifecycle',
        type: 'options',
        noDataExpression: true,
        default: 'legacy',
        options: [
          { name: 'Existing Behaviour', value: 'legacy' },
          { name: 'Replay-Safe Captured Turn', value: 'replaySafeV2' },
        ],
        displayOptions: { show: { '@version': [3] } },
        description:
          'Reuse a committed Capture Human Memory source and save the final reply once. Requires one event per execution, matching actor and turn settings, Final Turns, filtered history and Keep Forever.',
      },
      getConnectionHintNoticeField([NodeConnectionType.AiAgent]),
      // Session config
      sessionIdOption,
      sessionKeyProperty,
      // Backend selection
      {
        displayName: 'Storage Backend',
        name: 'backend',
        type: 'options',
        options: [
          {
            name: 'Embedded (Graphology)',
            value: 'embedded',
            description:
              'Zero-setup in-memory graph with JSON file persistence. No external services needed.',
          },
          {
            name: 'Neo4j (Remote)',
            value: 'neo4j',
            description: 'Remote Neo4j graph database. Requires Neo4j server and credentials.',
          },
        ],
        default: 'embedded',
        description: 'Where to store the knowledge graph data',
      },
      customStoragePathProperty,
      // Context Window
      {
        ...contextWindowLengthProperty,
        default: 10,
        description: 'Number of recent message episodes to include as context for the AI',
      },
      // Extraction settings
      {
        displayName: 'Knowledge Extraction',
        name: 'enableExtraction',
        type: 'options',
        options: [
          {
            name: 'Disabled',
            value: 'disabled',
            description: 'Only store conversation episodes (no entity/relationship extraction)',
          },
          {
            name: 'Enabled',
            value: 'enabled',
            description: 'Extract entities and relationships from conversations using an LLM',
          },
        ],
        default: 'disabled',
        description:
          'Whether to extract entities and relationships from conversations using an LLM. Requires Engram Extraction LLM credential.',
      },
      {
        displayName: 'Store Human Episodes',
        name: 'storeHumanEpisodes',
        type: 'options',
        options: [
          { name: 'Enabled', value: 'enabled' },
          { name: 'Disabled', value: 'disabled' },
        ],
        default: 'enabled',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Whether human messages should be persisted as episodes',
      },
      {
        displayName: 'Human Episode Kind',
        name: 'humanEpisodeKind',
        type: 'options',
        options: [
          {
            name: 'Active Human',
            value: 'active_human',
            description: 'A message sent directly to the agent in an active conversation',
          },
          {
            name: 'Passive Human',
            value: 'passive_human',
            description: 'A human message observed or curated outside the active conversation',
          },
        ],
        default: 'active_human',
        displayOptions: { show: { '@version': [2, 3] } },
        description:
          'Provenance kind applied to stored human episodes and human extraction sources',
      },
      {
        displayName: 'Store AI Episodes',
        name: 'storeAiEpisodes',
        type: 'options',
        options: [
          { name: 'Enabled', value: 'enabled' },
          { name: 'Disabled', value: 'disabled' },
        ],
        default: 'enabled',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Whether assistant replies should be persisted as episodes',
      },
      {
        displayName: 'Extract from Human Messages',
        name: 'extractHuman',
        type: 'options',
        options: [
          { name: 'Enabled', value: 'enabled' },
          { name: 'Disabled', value: 'disabled' },
        ],
        default: 'enabled',
        displayOptions: {
          show: { '@version': [2, 3], enableExtraction: ['enabled'] },
        },
        description: 'Whether human message content is eligible for knowledge extraction',
      },
      {
        displayName: 'Extract from AI Messages',
        name: 'extractAi',
        type: 'options',
        options: [
          { name: 'Disabled', value: 'disabled' },
          { name: 'Enabled', value: 'enabled' },
        ],
        default: 'disabled',
        displayOptions: {
          show: { '@version': [2, 3], enableExtraction: ['enabled'] },
        },
        description: 'Whether assistant reply content is eligible for knowledge extraction',
      },
      {
        displayName: 'Extract from System and Tool Content',
        name: 'extractSystemTool',
        type: 'options',
        options: [
          { name: 'Disabled', value: 'disabled' },
          { name: 'Enabled', value: 'enabled' },
        ],
        default: 'disabled',
        displayOptions: {
          show: { '@version': [2, 3], enableExtraction: ['enabled'] },
        },
        description:
          'Whether recognized system messages and tool outputs are eligible for knowledge extraction',
      },
      {
        displayName: 'Auto-Accept Confidence',
        name: 'autoAcceptConfidence',
        type: 'number',
        default: 0.85,
        typeOptions: { minValue: 0, maxValue: 1, numberStepSize: 0.05 },
        displayOptions: {
          show: { '@version': [2, 3], enableExtraction: ['enabled'] },
        },
        description:
          'LLM facts at or above this confidence are accepted automatically in Existing / Custom; literal profiles use their source-evidence policy',
      },
      {
        displayName: 'Reject Below Confidence',
        name: 'rejectBelowConfidence',
        type: 'number',
        default: 0.3,
        typeOptions: { minValue: 0, maxValue: 1, numberStepSize: 0.05 },
        displayOptions: {
          show: { '@version': [2, 3], enableExtraction: ['enabled'] },
        },
        description:
          'Existing / Custom LLM facts below this confidence are rejected; literal profiles use their source-evidence policy',
      },
      {
        displayName: 'Memory Fact Policy',
        name: 'memoryFactPolicy',
        type: 'options',
        options: [
          {
            name: 'Accepted Facts Only',
            value: 'acceptedOnly',
            description: 'Inject only accepted facts and manually created graph data',
          },
          {
            name: 'All Facts (Legacy)',
            value: 'all',
            description: 'Allow proposed and rejected extraction records into memory context',
          },
        ],
        default: 'acceptedOnly',
        displayOptions: { show: { '@version': [2, 3], enableExtraction: ['enabled'] } },
        description: 'Which reviewed fact states may be injected into agent memory',
      },
      {
        displayName: 'Context Token Budget',
        name: 'contextTokenBudget',
        type: 'number',
        default: 2000,
        typeOptions: { minValue: 100, maxValue: 32000 },
        displayOptions: { show: { '@version': [2, 3] } },
        description:
          'Approximate total token budget shared by entity, fact, provenance, and traversal context',
      },
      {
        displayName: 'Retrieval Sender ID',
        name: 'retrievalSenderId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Only retrieve facts supported by episodes from this sender',
      },
      {
        displayName: 'Retrieval Episode Kind',
        name: 'retrievalEpisodeKind',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Active Human', value: 'active_human' },
          { name: 'Passive Human', value: 'passive_human' },
          { name: 'Assistant Reply', value: 'assistant_reply' },
          { name: 'Monitor Summary', value: 'monitor_summary' },
          { name: 'Tool Output', value: 'tool_output' },
          { name: 'System', value: 'system' },
          { name: 'Legacy', value: 'legacy' },
        ],
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Only retrieve facts supported by this episode kind',
      },
      {
        displayName: 'Retrieval Trust Level',
        name: 'retrievalTrustLevel',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Trusted', value: 'trusted' },
          { name: 'Standard', value: 'standard' },
          { name: 'Unverified', value: 'unverified' },
          { name: 'Untrusted', value: 'untrusted' },
        ],
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Only retrieve facts supported by episodes at this trust level',
      },
      {
        displayName: 'Retrieval Source Workflow ID',
        name: 'retrievalSourceWorkflowId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Only retrieve facts written by this source workflow',
      },
      {
        displayName: 'Retrieval Source Execution ID',
        name: 'retrievalSourceExecutionId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Only retrieve facts written by this source execution',
      },
      {
        displayName: 'Retrieval Reference Time After',
        name: 'retrievalReferenceAfter',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Only retrieve facts supported at or after this time',
      },
      {
        displayName: 'Retrieval Reference Time Before',
        name: 'retrievalReferenceBefore',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Only retrieve facts supported at or before this time',
      },
      {
        displayName: 'Source Message ID',
        name: 'sourceMessageId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Stable upstream message ID used to deduplicate retried deliveries',
      },
      {
        displayName: 'Idempotency Key',
        name: 'episodeIdempotencyKey',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Optional stable turn key used when no source message ID is available',
      },
      {
        displayName: 'Conversation ID',
        name: 'conversationId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Upstream conversation or thread ID. Defaults to the Engram session ID.',
      },
      {
        displayName: 'Sender ID',
        name: 'senderId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Stable identifier for the human sender',
      },
      {
        displayName: 'Sender Name',
        name: 'senderName',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Display name for the human sender',
      },
      {
        displayName: 'Quoted Message ID',
        name: 'quotedMessageId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Optional identifier of the message being quoted or replied to',
      },
      {
        displayName: 'Episode Trust Level',
        name: 'episodeTrustLevel',
        type: 'options',
        options: [
          { name: 'Standard', value: 'standard' },
          { name: 'Trusted', value: 'trusted' },
          { name: 'Unverified', value: 'unverified' },
          { name: 'Untrusted', value: 'untrusted' },
        ],
        default: 'standard',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Initial trust classification applied to stored human and AI episodes',
      },
      {
        displayName: 'Episode Attributes',
        name: 'episodeAttributes',
        type: 'json',
        default: '{}',
        displayOptions: { show: { '@version': [2, 3] } },
        description: 'Additional source-specific episode metadata as a JSON object',
      },
      {
        // eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
        displayName: 'Extraction Model',
        name: 'extractionModel',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getModels',
        },
        default: '',
        hint: 'Chat/text LLM for entity extraction. Not an embedding model — Engram uses text search.',
        description:
          'Select the model to use for extracting entities and relationships. The list is fetched from your LLM provider. Choose a fast, cheap model — extraction prompts are short.',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        displayName: 'Extraction Temperature Mode',
        name: 'extractionTemperatureMode',
        type: 'options',
        options: [
          {
            name: 'Legacy (0)',
            value: 'legacy',
            description: 'Send temperature 0, preserving existing behavior',
          },
          {
            name: 'Provider Default',
            value: 'providerDefault',
            description: 'Omit temperature and let the provider choose its default',
          },
          {
            name: 'Custom',
            value: 'custom',
            description: 'Send a temperature supported by your provider and model',
          },
        ],
        default: 'legacy',
        description: 'How to set temperature on every extraction request',
        displayOptions: { show: { enableExtraction: ['enabled'] } },
      },
      {
        displayName: 'Extraction Temperature',
        name: 'extractionTemperature',
        type: 'number',
        default: 0,
        description: 'Temperature supported by your provider and model. Supported ranges vary.',
        displayOptions: {
          show: { enableExtraction: ['enabled'], extractionTemperatureMode: ['custom'] },
        },
      },
      {
        displayName: 'History Filter',
        name: 'historyFilter',
        type: 'options',
        default: 'off',
        options: [
          { name: 'Off', value: 'off', description: 'Keep existing episode history behavior' },
          {
            name: 'Provenance',
            value: 'provenance',
            description: 'Exclude tool output, monitor summaries, and audit episodes from context',
          },
          {
            name: 'Provenance and Reviewed Legacy',
            value: 'reviewedLegacy',
            description:
              'Also exclude explicitly reviewed legacy artifact pairs using exact content hashes',
          },
        ],
        description:
          'Non-destructive filtering of conversation context; stored episodes remain intact',
        displayOptions: { show: { '@version': [2, 3] } },
      },
      {
        displayName: 'Maximum History Scan',
        name: 'maxHistoryScan',
        type: 'number',
        default: 1000,
        typeOptions: { minValue: 1, maxValue: 10000 },
        description:
          'Maximum episodes examined while filling the message window. Uses one bounded snapshot with local scan pages.',
        displayOptions: { show: { '@version': [2, 3] } },
      },
      {
        displayName: 'Reviewed Legacy Content Hashes',
        name: 'legacyArtifactHashes',
        type: 'string',
        default: '',
        description:
          'Comma-separated SHA256 hashes of exact operator-reviewed legacy tool payload content. Chain evidence is also required. Ambiguous JSON stays in context.',
        displayOptions: { show: { '@version': [2, 3], historyFilter: ['reviewedLegacy'] } },
      },
      {
        displayName: 'Message Write Policy',
        name: 'messageWritePolicy',
        type: 'options',
        default: 'legacy',
        options: [
          {
            name: 'Legacy',
            value: 'legacy',
            description: 'Keep existing saved workflow write behavior',
          },
          {
            name: 'Final Turns',
            value: 'finalTurns',
            description:
              'Share final human and assistant writes across normal and tool-assisted turns',
          },
        ],
        description:
          'Select Final Turns to apply storage, extraction, and provenance controls to native bulk writes',
        displayOptions: { show: { '@version': [2, 3] } },
      },
      {
        displayName: 'Store Tool Audit',
        name: 'storeToolAudit',
        type: 'options',
        default: 'disabled',
        options: [
          { name: 'Disabled', value: 'disabled' },
          { name: 'Enabled', value: 'enabled' },
        ],
        description:
          'Whether to retain intermediate tool messages as unverified audit episodes outside conversation context',
        displayOptions: { show: { '@version': [2, 3], messageWritePolicy: ['finalTurns'] } },
      },
      {
        displayName: 'Current Human Query',
        name: 'currentHumanQuery',
        type: 'string',
        default:
          "={{ typeof $json.chatInput === 'string' ? $json.chatInput : (typeof $json.input === 'string' ? $json.input : '') }}",
        description:
          'Current human input for graph retrieval when n8n loads memory with empty values. Map this to the same current-message expression as the agent prompt.',
        displayOptions: { show: { '@version': [2, 3] } },
      },
      {
        displayName: 'Max Facts per Query',
        name: 'maxFactsPerQuery',
        type: 'number',
        default: 10,
        typeOptions: {
          minValue: 1,
          maxValue: 50,
        },
        description: 'Maximum number of relevant facts to include as context',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        displayName: 'Min Relevance Score',
        name: 'minRelevanceScore',
        type: 'number',
        default: 0.5,
        typeOptions: {
          minValue: 0,
          maxValue: 1,
          numberStepSize: 0.1,
        },
        description: 'Minimum relevance score (0-1) for facts to be included in context',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        displayName: 'Entity Types',
        name: 'entityTypes',
        type: 'string',
        default: 'person, organization, location, concept, event',
        description: 'Comma-separated list of entity types to extract from conversations',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      // Embedding settings
      {
        displayName: 'Semantic Search (Embeddings)',
        name: 'enableEmbeddings',
        type: 'options',
        options: [
          {
            name: 'Disabled',
            value: 'disabled',
            description: 'Text search only (default). No embedding API calls.',
          },
          {
            name: 'Enabled',
            value: 'enabled',
            description:
              'Generate embeddings for entities/facts and use hybrid text+vector search (RRF). Requires extraction to be enabled.',
          },
        ],
        default: 'disabled',
        description:
          'When enabled, generates vector embeddings for entities and facts during extraction, and uses hybrid text+vector search with Reciprocal Rank Fusion for better semantic matching.',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        // eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
        displayName: 'Embedding Model',
        name: 'embeddingModel',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getModels',
        },
        default: '',
        hint: 'Select an embedding model (e.g. text-embedding-3-small). Uses the same LLM provider credential.',
        description:
          'The embedding model to use for generating vectors. Must be an embedding model, not a chat model. The list is fetched from your LLM provider.',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
            enableEmbeddings: ['enabled'],
          },
        },
      },
      // Graph Traversal
      {
        displayName: 'Graph Traversal (BFS)',
        name: 'enableTraversal',
        type: 'options',
        options: [
          {
            name: 'Disabled',
            value: 'disabled',
            description: 'Standard search only.',
          },
          {
            name: 'Enabled',
            value: 'enabled',
            description:
              'After search, do a shallow BFS from matched entities to enrich context with related facts.',
          },
        ],
        default: 'disabled',
        description:
          'When enabled, enriches memory context by walking the knowledge graph outward from matched entities. Adds related entities and relationships as additional context for the AI.',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        displayName: 'Traversal Hops',
        name: 'traversalHops',
        type: 'number',
        default: 1,
        typeOptions: {
          minValue: 1,
          maxValue: 5,
        },
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
            enableTraversal: ['enabled'],
          },
        },
        description:
          'Number of hops to walk from matched entities. 1 = direct neighbors only, 2 = neighbors of neighbors, etc.',
      },
      ...advancedExtractionProperties,
      {
        displayName: 'Extraction Execution',
        name: 'extractionExecution',
        type: 'options',
        default: 'synchronous',
        options: [
          { name: 'Synchronous', value: 'synchronous' },
          { name: 'Durable Queue', value: 'durable' },
        ],
        description:
          'Durable Queue saves work for a separate scheduled Engram Admin worker; facts become available after processing',
        displayOptions: { show: { '@version': [2, 3], enableExtraction: ['enabled'] } },
      },
      {
        displayName: 'Extraction Route ID',
        name: 'extractionRouteId',
        type: 'string',
        default: '',
        description: 'Nonsecret worker route identifier; must match the worker configuration',
        displayOptions: { show: { '@version': [2, 3], extractionExecution: ['durable'] } },
      },
      {
        displayName: 'Graph Context Policy',
        name: 'graphContextPolicy',
        type: 'options',
        default: 'legacy',
        options: [
          { name: 'Legacy', value: 'legacy' },
          { name: 'Governed Current', value: 'current' },
          { name: 'Governed Historical', value: 'historical' },
          { name: 'Governed As Of', value: 'asOf' },
        ],
        description:
          'Reconcile duplicate relationships and distinguish current from historical evidence',
        displayOptions: { show: { '@version': [2, 3] } },
      },
      {
        displayName: 'Event Time',
        name: 'graphContextAt',
        type: 'string',
        default: '',
        placeholder: '2026-10-24T12:00:00Z',
        description:
          'Explicit timestamp for event-interval relevance, not what was known at that time',
        displayOptions: { show: { '@version': [2, 3], graphContextPolicy: ['asOf'] } },
      },
      {
        displayName: 'Durable Fact Token Allowance',
        name: 'graphDurableTokens',
        type: 'number',
        default: 4096,
        typeOptions: { minValue: 0, maxValue: 100000 },
        description:
          'Estimated token allowance for durable evidence within the overall graph context cap',
        displayOptions: {
          show: { '@version': [2, 3], graphContextPolicy: ['current', 'historical', 'asOf'] },
        },
      },
      {
        displayName: 'Historical Evidence Token Allowance',
        name: 'graphHistoricalTokens',
        type: 'number',
        default: 2048,
        typeOptions: { minValue: 0, maxValue: 100000 },
        description:
          'Estimated token allowance for temporal or legacy evidence within the overall graph context cap',
        displayOptions: {
          show: { '@version': [2, 3], graphContextPolicy: ['current', 'historical', 'asOf'] },
        },
      },
      // Retention settings
      {
        displayName: 'Retention Policy',
        name: 'retentionType',
        type: 'options',
        options: [
          {
            name: 'Keep Forever',
            value: 'forever',
            description: 'Never delete episodes',
          },
          {
            name: 'Keep for N Days',
            value: 'days',
            description: 'Delete episodes older than N days',
          },
          {
            name: 'Keep Last N Episodes',
            value: 'max_episodes',
            description: 'Keep only the most recent N episodes',
          },
        ],
        default: 'forever',
        description: 'How long to keep conversation episodes',
      },
      {
        displayName: 'Retention Value',
        name: 'retentionValue',
        type: 'number',
        default: 30,
        typeOptions: {
          minValue: 1,
        },
        description: 'Number of days or maximum episodes to keep (depends on retention type)',
        displayOptions: {
          hide: {
            retentionType: ['forever'],
          },
        },
      },
    ]),
  };

  methods = {
    loadOptions: {
      async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        let credentials;
        try {
          credentials = await this.getCredentials('engramExtractionApi');
        } catch {
          return [{ name: 'Configure credential first', value: '' }];
        }

        const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
        const apiKey = credentials.apiKey as string;

        try {
          // Try with auth first, fall back to without auth (some providers like OpenRouter don't need it for /models)
          let response;
          try {
            response = await this.helpers.httpRequest({
              method: 'GET',
              url: `${baseUrl}/models`,
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
              timeout: 10000,
            });
          } catch {
            // Retry without auth header
            response = await this.helpers.httpRequest({
              method: 'GET',
              url: `${baseUrl}/models`,
              timeout: 10000,
            });
          }

          // Handle both { data: [...] } (OpenAI) and direct [...] (some providers) formats
          const modelList = response.data || response;
          const models = (Array.isArray(modelList) ? modelList : []) as Array<{
            id: string;
            name?: string;
            owned_by?: string;
          }>;

          if (models.length === 0) {
            return [{ name: 'No models found — check Base URL in credential', value: '' }];
          }

          return models
            .map((m) => ({
              name: m.id,
              value: m.id,
              description: m.owned_by ? `Provider: ${m.owned_by}` : undefined,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
          return [
            {
              name: `Error: ${(error as Error).message.slice(0, 80)}`,
              value: '',
            },
          ];
        }
      },
    },
  };

  async supplyData(this: IExecuteFunctions, itemIndex: number): Promise<SupplyData> {
    return runAutonomousPersonalMemoryPreparationV1(this, itemIndex, (registerFailureCleanup) =>
      supplyMemoryDataWithinPreparationV1.call(this, itemIndex, registerFailureCleanup),
    );
  }
}

function parseEpisodeAttributes(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function supplyMemoryDataWithinPreparationV1(
  this: IExecuteFunctions,
  itemIndex: number,
  registerPreparationFailureCleanup: (cleanup: () => Promise<void>) => void,
): Promise<SupplyData> {
  const nativeCapture = readReplaySafeMemoryNativeContext(this, itemIndex);
  const autonomousPersonal =
    this.getNode().parameters?.automaticPreferenceInterpreter === 'autonomousPersonalV1';
  if (autonomousPersonal && !nativeCapture)
    throw new NodeOperationError(
      this.getNode(),
      'Autonomous Personal Memory requires Replay Safe capture',
    );
  const sessionId = nativeCapture
    ? readReplaySafeMemoryNamespace(this, itemIndex)
    : getSessionId(this, itemIndex);
  const backend = this.getNodeParameter('backend', itemIndex, 'embedded') as string;
  const contextWindow = this.getNodeParameter('contextWindowLength', itemIndex, 10) as number;
  const enableExtraction =
    (this.getNodeParameter('enableExtraction', itemIndex, 'disabled') as string) === 'enabled';
  const maxFactsPerQuery = this.getNodeParameter('maxFactsPerQuery', itemIndex, 10) as number;
  const minRelevanceScore = this.getNodeParameter('minRelevanceScore', itemIndex, 0.5) as number;
  const retentionType = this.getNodeParameter('retentionType', itemIndex, 'forever') as string;
  const retentionValue = this.getNodeParameter('retentionValue', itemIndex, 30) as number;
  const nodeVersion = this.getNode().typeVersion ?? 1;
  const usesGovernanceControls = nodeVersion >= 2;
  const storeHumanEpisodes = usesGovernanceControls
    ? (this.getNodeParameter('storeHumanEpisodes', itemIndex, 'enabled') as string) === 'enabled'
    : true;
  const humanEpisodeKind = usesGovernanceControls
    ? (this.getNodeParameter('humanEpisodeKind', itemIndex, 'active_human') as
        | 'active_human'
        | 'passive_human')
    : 'active_human';
  const storeAiEpisodes = usesGovernanceControls
    ? (this.getNodeParameter('storeAiEpisodes', itemIndex, 'enabled') as string) === 'enabled'
    : true;
  const extractHuman = usesGovernanceControls
    ? (this.getNodeParameter('extractHuman', itemIndex, 'enabled') as string) === 'enabled'
    : true;
  const extractAi = usesGovernanceControls
    ? (this.getNodeParameter('extractAi', itemIndex, 'disabled') as string) === 'enabled'
    : true;
  const extractSystemTool = usesGovernanceControls
    ? (this.getNodeParameter('extractSystemTool', itemIndex, 'disabled') as string) === 'enabled'
    : false;
  const autoAcceptConfidence = usesGovernanceControls
    ? (this.getNodeParameter('autoAcceptConfidence', itemIndex, 0.85) as number)
    : undefined;
  const rejectBelowConfidence = usesGovernanceControls
    ? (this.getNodeParameter('rejectBelowConfidence', itemIndex, 0.3) as number)
    : undefined;
  const acceptedOnlyRetrieval = usesGovernanceControls
    ? (this.getNodeParameter('memoryFactPolicy', itemIndex, 'acceptedOnly') as string) ===
      'acceptedOnly'
    : false;

  const policy = MemoryPolicySchema.parse(
    usesGovernanceControls
      ? {
          historyFilter: this.getNodeParameter('historyFilter', itemIndex, 'off'),
          maxHistoryScan: this.getNodeParameter('maxHistoryScan', itemIndex, 1000),
          legacyArtifactHashes: (
            this.getNodeParameter('legacyArtifactHashes', itemIndex, '') as string
          )
            .split(/[\s,]+/)
            .filter(Boolean),
          finalTurnWrites:
            this.getNodeParameter('messageWritePolicy', itemIndex, 'legacy') === 'finalTurns',
          storeToolAudit:
            this.getNodeParameter('storeToolAudit', itemIndex, 'disabled') === 'enabled',
        }
      : {},
  );
  // Resolve once in this supplyData item's expression context, never from previous history.
  const currentHumanQuery = usesGovernanceControls
    ? (this.getNodeParameter('currentHumanQuery', itemIndex, '') as string)
    : '';

  const nativeConfiguration = (() => {
    if (!nativeCapture) return undefined;
    try {
      const automatic = readAutomaticRuntime(
        (name, fallback) => this.getNodeParameter(name, itemIndex, fallback as string),
        sessionId,
        '0'.repeat(64),
      );
      // The legacy reader retains an own undefined optional. This new typed
      // JSON boundary omits only that known, absent optional field.
      if (automatic && automatic.rawHumanContent === undefined) delete automatic.rawHumanContent;
      return {
        policy: readExtractionPolicy((name, fallback) =>
          this.getNodeParameter(name, itemIndex, fallback as string),
        ),
        automatic,
      };
    } catch {
      throw new Error('Engram replay-safe memory: unsupported_configuration');
    }
  })();
  const nativePolicy = nativeConfiguration?.policy;
  const nativeAutomatic = nativeConfiguration?.automatic;
  if (
    nativeCapture &&
    (!['embedded', 'neo4j'].includes(backend) ||
      !nativeAutomatic?.capturedSourceId ||
      !CurrentHumanQuerySchema.safeParse(currentHumanQuery).success ||
      !currentHumanQuery ||
      nativePolicy?.mode !== 'bounded' ||
      this.getNodeParameter('extractionExecution', itemIndex, 'synchronous') !== 'synchronous' ||
      retentionType !== 'forever' ||
      !policy.finalTurnWrites ||
      policy.historyFilter === 'off' ||
      !storeHumanEpisodes ||
      !storeAiEpisodes ||
      extractAi ||
      extractSystemTool ||
      !acceptedOnlyRetrieval)
  )
    throw new Error('Engram replay-safe memory: unsupported_configuration');

  let continuation:
    | {
        signal: AbortSignal;
        state: NativeMemoryContinuationSignalStateV4;
        record: NativeMemoryContinuationV4;
      }
    | undefined;
  if (nativeCapture && autonomousPersonal) {
    const scope = nativeMemoryContinuationScopeV4(this);
    if (!scope)
      throw new NodeOperationError(
        this.getNode(),
        'Engram replay-safe memory: initialization_failed',
      );
    let settingsHash: string;
    try {
      settingsHash = nativeMemoryContinuationSettingsHashV4(
        this,
        itemIndex,
        sessionId,
        nativeCapture,
        nativeConfiguration,
      );
    } catch {
      throw new NodeOperationError(
        this.getNode(),
        'Engram replay-safe memory: initialization_failed',
      );
    }
    try {
      const reservation = reserveNativeMemoryContinuationV4(
        scope.signal,
        scope.scopeHash,
        settingsHash,
      );
      if (!reservation.initial) {
        const reusedResponse: { value: SupplyData | undefined } = { value: undefined };
        registerPreparationFailureCleanup(async () => {
          await reusedResponse.value?.closeFunction?.();
        });
        reusedResponse.value = await reuseNativeMemoryContinuationV4(
          this,
          itemIndex,
          scope.signal,
          reservation.state,
          reservation.record,
          settingsHash,
        );
        currentAutonomousPersonalExecutionScopeWorkV1();
        return reusedResponse.value;
      }
      if (reservation.record.phase !== 'initializing')
        throw new Error('Engram replay-safe memory: initialization_failed');
      continuation = {
        signal: scope.signal,
        state: reservation.state,
        record: reservation.record,
      };
      reservation.record.lifecycleMode = registerNativeMemoryWorkflowContinuationV4(
        this,
        reservation.record,
      );
    } catch {
      if (continuation) {
        resolveNativeMemoryContinuationV4(continuation.record, false);
        await closeNativeMemoryContinuationV4(
          continuation.record,
          continuation.signal,
          continuation.state,
        ).catch(() => undefined);
      }
      throw new NodeOperationError(
        this.getNode(),
        'Engram replay-safe memory: initialization_failed',
      );
    }
  }

  let autonomousStorage: IGraphStorage | undefined;
  let autonomousAdapter: PrivateAutonomousPersonalNativeMemoryAdapterTokenV4 | undefined;
  let returnedMemory: EngramChatMemory | undefined;
  let preparedForReturn = false;
  registerPreparationFailureCleanup(async () => {
    if (!preparedForReturn) return;
    returnedMemory?.closeNativeMemoryV4();
    if (continuation) {
      await closeNativeMemoryContinuationV4(
        continuation.record,
        continuation.signal,
        continuation.state,
      );
    } else if (autonomousStorage && backend === 'neo4j') {
      await autonomousStorage.close();
    }
  });
  try {
    if (continuation && continuation.record.phase !== 'initializing')
      throw new Error('Engram replay-safe memory: initialization_failed');
    // Get or create storage instance
    let storage;
    let storeIdentity: string;
    if (backend === 'neo4j') {
      const credentials = await this.getCredentials('engramNeo4jApi');
      storeIdentity = fingerprint({
        backend,
        uri: credentials.uri,
        database: credentials.database ?? 'neo4j',
      });
      if (nativeCapture) {
        const identity = neo4jAutomaticCaptureStoreHash(
          credentials.uri as string,
          credentials.database as string | undefined,
        );
        if (!identity) throw new Error('Engram replay-safe memory: unsupported_configuration');
        storeIdentity = identity;
      }
      storage = createStorage({
        backend: 'neo4j',
        uri: credentials.uri as string,
        username: credentials.username as string,
        password: credentials.password as string,
        database: credentials.database as string,
      });
    } else {
      const workflowId = this.getWorkflow().id ?? 'default';
      const customPath = this.getNodeParameter('customStoragePath', itemIndex, '') as string;
      const persistPath = resolveStoragePath({
        customStoragePath: customPath,
        workflowId,
      });
      storeIdentity = fingerprint({ backend: 'embedded', persistPath });
      if (nativeCapture) {
        const identity = embeddedAutomaticCaptureStoreHash(persistPath);
        if (!identity) throw new Error('Engram replay-safe memory: unsupported_configuration');
        storeIdentity = identity;
      }

      if (!nativeCapture)
        migrateStorageIfNeeded({
          newPath: persistPath,
          workflowId,
          staticData: this.getWorkflowStaticData('node'),
          logger: this.logger,
        });

      storage = createStorage({
        backend: 'embedded',
        persistPath,
      });
    }

    if (autonomousPersonal) autonomousStorage = storage;
    if (continuation) {
      continuation.record.storage = storage;
      continuation.record.backend = backend;
    }
    if (continuation && continuation.record.phase !== 'initializing')
      throw new Error('Engram replay-safe memory: initialization_failed');
    await storage.initialize();
    if (continuation && continuation.record.phase !== 'initializing')
      throw new Error('Engram replay-safe memory: initialization_failed');

    const extractionExecution = usesGovernanceControls
      ? (this.getNodeParameter('extractionExecution', itemIndex, 'synchronous') as
          | 'synchronous'
          | 'durable')
      : 'synchronous';
    if (extractionExecution === 'durable' && retentionType !== 'forever')
      throw new Error(
        'Durable extraction requires Keep Forever retention until jobs are explicitly resolved',
      );
    // Apply retention policy before loading
    if (retentionType !== 'forever') {
      await storage.applyRetention(sessionId, {
        type: retentionType as 'days' | 'max_episodes',
        value: retentionValue,
      });
    }

    // Build extraction LLM config if enabled
    let llmConfig;
    let entityTypes;
    let extractionCreds;
    if (enableExtraction && !nativeCapture) {
      extractionCreds = await this.getCredentials('engramExtractionApi');
      const model = this.getNodeParameter('extractionModel', itemIndex, '') as string;
      if (!model) {
        throw new NodeOperationError(
          this.getNode(),
          'Extraction Model is required when Knowledge Extraction is enabled',
          {
            description:
              'Select a model from the dropdown. If the list is empty, verify your Engram Extraction LLM credential has a valid Base URL and API Key.',
          },
        );
      }
      const temperatureMode = this.getNodeParameter(
        'extractionTemperatureMode',
        itemIndex,
        'legacy',
      ) as string;
      const temperature = ExtractionTemperatureSchema.parse(
        temperatureMode === 'custom'
          ? {
              mode: temperatureMode,
              value: this.getNodeParameter('extractionTemperature', itemIndex, 0),
            }
          : { mode: temperatureMode },
      );
      llmConfig = {
        temperature,
        apiKey: extractionCreds.apiKey as string,
        baseUrl: extractionCreds.baseUrl as string,
        model,
      };

      const entityTypesRaw = this.getNodeParameter(
        'entityTypes',
        itemIndex,
        'person, organization, location, concept, event',
      ) as string;
      entityTypes = entityTypesRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }

    // Build embedding config if enabled
    let embeddingConfig;
    if (enableExtraction && llmConfig) {
      const enableEmbeddings =
        (this.getNodeParameter('enableEmbeddings', itemIndex, 'disabled') as string) === 'enabled';

      if (enableEmbeddings) {
        const embeddingModel = this.getNodeParameter('embeddingModel', itemIndex, '') as string;

        if (embeddingModel && extractionCreds) {
          // Reuse the extraction API credential already fetched above
          embeddingConfig = {
            apiKey: extractionCreds.apiKey as string,
            baseUrl: extractionCreds.baseUrl as string,
            model: embeddingModel,
          };
        }
      }
    }
    if (
      nativeCapture &&
      this.getNodeParameter('enableEmbeddings', itemIndex, 'disabled') === 'enabled'
    ) {
      const model = this.getNodeParameter('embeddingModel', itemIndex, '') as string;
      if (model) {
        const credentials = await this.getCredentials('engramExtractionApi');
        embeddingConfig = {
          apiKey: credentials.apiKey as string,
          baseUrl: credentials.baseUrl as string,
          model,
        };
      }
      if (continuation && continuation.record.phase !== 'initializing')
        throw new Error('Engram replay-safe memory: initialization_failed');
    }

    // Build traversal config if enabled
    let enableTraversal = false;
    let traversalHops = 1;
    if (enableExtraction || autonomousPersonal) {
      enableTraversal =
        (this.getNodeParameter('enableTraversal', itemIndex, 'disabled') as string) === 'enabled';
      if (enableTraversal) {
        traversalHops = this.getNodeParameter('traversalHops', itemIndex, 1) as number;
      }
    }

    if (continuation && continuation.record.phase !== 'initializing')
      throw new Error('Engram replay-safe memory: initialization_failed');
    if (autonomousPersonal)
      autonomousAdapter = await prepareNativeAutonomousPersonalMemoryAdapterV4(
        this,
        itemIndex,
        storage,
      );
    if (continuation) {
      continuation.record.adapterToken = autonomousAdapter ?? null;
      if (continuation.record.phase !== 'initializing')
        throw new Error('Engram replay-safe memory: initialization_failed');
    }

    const memory = new EngramChatMemory(
      {
        ...nativeCapture,
        automaticMemory:
          nativeCapture && nativeAutomatic
            ? { ...nativeAutomatic, storeIdentity }
            : nodeVersion >= 3
              ? readAutomaticRuntime(
                  (name, fallback) => this.getNodeParameter(name, itemIndex, fallback as string),
                  sessionId,
                  storeIdentity,
                )
              : undefined,
        storage,
        groupId: sessionId,
        policy,
        currentHumanQuery,
        memoryKey: 'chat_history',
        returnMessages: true,
        inputKey: 'input',
        outputKey: 'output',
        contextWindow,
        maxFactsPerQuery,
        minRelevanceScore,
        enableExtraction: enableExtraction && !!llmConfig,
        llmConfig,
        entityTypes,
        extractionPolicy:
          nativePolicy ??
          (usesGovernanceControls
            ? readExtractionPolicy((name, fallback) =>
                this.getNodeParameter(name, itemIndex, fallback as string),
              )
            : undefined),
        extractionExecution,
        extractionRouteId: usesGovernanceControls
          ? (this.getNodeParameter('extractionRouteId', itemIndex, '') as string)
          : undefined,
        retrievalMode: usesGovernanceControls
          ? (this.getNodeParameter('graphContextPolicy', itemIndex, 'legacy') as
              | 'legacy'
              | 'current'
              | 'historical'
              | 'asOf')
          : 'legacy',
        retrievalAt: usesGovernanceControls
          ? (this.getNodeParameter('graphContextAt', itemIndex, '') as string)
          : undefined,
        graphEvidenceBudgets: usesGovernanceControls
          ? {
              durable: this.getNodeParameter('graphDurableTokens', itemIndex, 4096) as number,
              historical: this.getNodeParameter('graphHistoricalTokens', itemIndex, 2048) as number,
            }
          : undefined,
        embeddingConfig,
        enableTraversal,
        traversalHops,
        storeHumanEpisodes,
        humanEpisodeKind,
        storeAiEpisodes,
        extractHuman,
        extractAi,
        extractSystemTool,
        acceptedOnlyRetrieval,
        contextTokenBudget: usesGovernanceControls
          ? (this.getNodeParameter('contextTokenBudget', itemIndex, 2000) as number)
          : undefined,
        includeProvenanceInContext: usesGovernanceControls,
        retrievalFilters: usesGovernanceControls
          ? {
              sender_id:
                (this.getNodeParameter('retrievalSenderId', itemIndex, '') as string).trim() ||
                undefined,
              episode_kind: ((this.getNodeParameter(
                'retrievalEpisodeKind',
                itemIndex,
                '',
              ) as string) || undefined) as
                | 'active_human'
                | 'passive_human'
                | 'assistant_reply'
                | 'monitor_summary'
                | 'tool_output'
                | 'system'
                | 'legacy'
                | undefined,
              trust_level: ((this.getNodeParameter(
                'retrievalTrustLevel',
                itemIndex,
                '',
              ) as string) || undefined) as
                | 'trusted'
                | 'standard'
                | 'unverified'
                | 'untrusted'
                | undefined,
              source_workflow_id:
                (
                  this.getNodeParameter('retrievalSourceWorkflowId', itemIndex, '') as string
                ).trim() || undefined,
              source_execution_id:
                (
                  this.getNodeParameter('retrievalSourceExecutionId', itemIndex, '') as string
                ).trim() || undefined,
              reference_after:
                (this.getNodeParameter('retrievalReferenceAfter', itemIndex, '') as string) ||
                undefined,
              reference_before:
                (this.getNodeParameter('retrievalReferenceBefore', itemIndex, '') as string) ||
                undefined,
            }
          : undefined,
        requireExtractionConfidence: usesGovernanceControls,
        extractionThresholdPolicy: usesGovernanceControls
          ? {
              autoAcceptThreshold: autoAcceptConfidence!,
              rejectBelowThreshold: rejectBelowConfidence!,
            }
          : undefined,
        episodeMetadata: usesGovernanceControls
          ? {
              source_message_id:
                (this.getNodeParameter('sourceMessageId', itemIndex, '') as string).trim() || null,
              idempotency_key:
                (this.getNodeParameter('episodeIdempotencyKey', itemIndex, '') as string).trim() ||
                null,
              conversation_id:
                (this.getNodeParameter('conversationId', itemIndex, '') as string).trim() ||
                sessionId,
              sender_id:
                (this.getNodeParameter('senderId', itemIndex, '') as string).trim() || null,
              sender_name:
                (this.getNodeParameter('senderName', itemIndex, '') as string).trim() || null,
              quoted_message_id:
                (this.getNodeParameter('quotedMessageId', itemIndex, '') as string).trim() || null,
              trust_level: this.getNodeParameter('episodeTrustLevel', itemIndex, 'standard') as
                | 'trusted'
                | 'standard'
                | 'unverified'
                | 'untrusted',
              source_workflow_id: this.getWorkflow().id ?? null,
              source_execution_id: this.getExecutionId(),
              attributes: parseEpisodeAttributes(
                this.getNodeParameter('episodeAttributes', itemIndex, '{}'),
              ),
            }
          : undefined,
      },
      autonomousAdapter,
    );

    returnedMemory = memory;
    currentAutonomousPersonalExecutionScopeWorkV1();
    if (continuation) {
      if (continuation.record.phase !== 'initializing') {
        memory.closeNativeMemoryV4();
        throw new Error('Engram replay-safe memory: initialization_failed');
      }
      continuation.record.memory = memory;
      continuation.record.adapterToken = null;
      resolveNativeMemoryContinuationV4(continuation.record, true);
    }

    currentAutonomousPersonalExecutionScopeWorkV1();
    preparedForReturn = true;
    if (continuation?.record.lifecycleMode === 'workflow')
      return nativeMemoryContinuationResponseV4(continuation.record, this);

    return {
      response: logWrapper(memory, this),
      ...(autonomousPersonal
        ? {
            closeFunction: continuation
              ? nativeMemoryContinuationCloseFunctionV4(
                  continuation.record,
                  continuation.signal,
                  continuation.state,
                )
              : async () => {
                  memory.closeNativeMemoryV4();
                  // Embedded StorageFactory instances are shared with other
                  // executions. This node owns only its Neo4j connection.
                  if (backend === 'neo4j') await storage.close();
                },
          }
        : {}),
    };
  } catch (error: unknown) {
    preparedForReturn = false;
    returnedMemory?.closeNativeMemoryV4();
    if (autonomousStorage && autonomousAdapter)
      closePreparedAutonomousPersonalNativeMemoryAdapterV4(autonomousStorage, autonomousAdapter);
    if (continuation) {
      continuation.record.adapterToken = null;
      if (autonomousStorage) {
        continuation.record.storage = autonomousStorage;
        continuation.record.backend = backend;
      }
      resolveNativeMemoryContinuationV4(continuation.record, false);
      await closeNativeMemoryContinuationV4(
        continuation.record,
        continuation.signal,
        continuation.state,
      ).catch(() => undefined);
    } else if (autonomousStorage && backend === 'neo4j') {
      try {
        await autonomousStorage.close();
      } catch {
        // Preserve the redacted initialization failure.
      }
    }
    if (nativeCapture)
      throw new NodeOperationError(
        this.getNode(),
        'Engram replay-safe memory: initialization_failed',
      );
    if (error instanceof NodeOperationError) throw error;
    throw new NodeOperationError(
      this.getNode(),
      `Failed to initialize Engram memory: ${(error as Error).message}`,
      {
        description:
          backend === 'neo4j'
            ? 'Check your Neo4j credentials and server connection'
            : 'Check file system permissions for embedded storage',
      },
    );
  }
}
