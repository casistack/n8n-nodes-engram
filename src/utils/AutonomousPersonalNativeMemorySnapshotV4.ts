import type { IExecuteFunctions } from 'n8n-workflow';
import {
  AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema,
  type AutonomousPersonalAssistantNativeSnapshotV4,
} from '../schemas/AutonomousPersonalAssistantFinalV4.schema';
import { AutonomousPersonalMemoryHandoffNativeTupleV4OwnedDataSchema } from '../schemas/AutonomousPersonalMemoryHandoffV4.schema';
import {
  embeddedAutomaticCaptureStoreHash,
  neo4jAutomaticCaptureStoreHash,
} from '../storage/AutomaticCaptureStore';
import {
  AutonomousPersonalNativeMemoryConfigV4Error,
  readAutonomousPersonalNativeMemoryConfigV4,
  type AutonomousPersonalNativeMemoryConfigContextV4,
} from './AutonomousPersonalNativeMemoryConfigV4';
import { resolveStoragePath } from './helpers';
import { readReplaySafeMemoryNativeContext } from './replaySafeMemoryNative';

type NativeSnapshotReaderContextV4 = AutonomousPersonalNativeMemoryConfigContextV4;
type ContextMethodNameV4 = keyof NativeSnapshotReaderContextV4;

type MutableBoundContextMethodsV4 = {
  [K in ContextMethodNameV4]: NativeSnapshotReaderContextV4[K] | null;
};

type NativeStoreIdentityV4 = Readonly<{
  backend: 'embedded' | 'neo4j';
  storeHash: string;
}>;

export type AutonomousPersonalNativeMemorySnapshotFailureReasonV4 =
  | 'unsupported_configuration'
  | 'invalid_input'
  | 'capacity';

export class AutonomousPersonalNativeMemorySnapshotV4Error extends Error {
  constructor(readonly reason: AutonomousPersonalNativeMemorySnapshotFailureReasonV4) {
    super(`Engram native Memory snapshot: ${reason}`);
    this.name = 'AutonomousPersonalNativeMemorySnapshotV4Error';
  }
}

export interface AutonomousPersonalNativeMemorySnapshotReaderV4 {
  read(): Promise<AutonomousPersonalAssistantNativeSnapshotV4>;
  close(): void;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function closedFailure(): AutonomousPersonalNativeMemorySnapshotV4Error {
  return new AutonomousPersonalNativeMemorySnapshotV4Error('unsupported_configuration');
}

/**
 * Creates a fixed Memory-native DATA reader. It retains only the bound host
 * methods needed by the existing strict config reader; close drops those
 * references, and each read resolves the current store identity again.
 */
export function createAutonomousPersonalNativeMemorySnapshotReaderV4(
  ctx: NativeSnapshotReaderContextV4,
  itemIndex: number,
): AutonomousPersonalNativeMemorySnapshotReaderV4 {
  if (itemIndex !== 0 || !ctx || typeof ctx !== 'object') throw closedFailure();

  let liveMethods: MutableBoundContextMethodsV4 | null;
  try {
    const requiredNames: ContextMethodNameV4[] = [
      'getNode',
      'getNodeParameter',
      'getInputData',
      'getExecutionId',
      'getWorkflow',
      'getInstanceId',
      'getCredentials',
      'evaluateExpression',
    ];
    const captured: Partial<MutableBoundContextMethodsV4> = {};
    for (const name of requiredNames) {
      const method = ctx[name];
      if (typeof method !== 'function') throw closedFailure();
      // Binding is the explicitly approved narrow retention of native host
      // methods. No raw context object or values are stored alongside them.
      captured[name] = method.bind(ctx) as never;
    }
    liveMethods = captured as MutableBoundContextMethodsV4;
  } catch {
    throw closedFailure();
  }

  const invoke = (name: ContextMethodNameV4, args: unknown[]): unknown => {
    const method = liveMethods?.[name];
    if (!method) throw closedFailure();
    return Reflect.apply(method, undefined, args);
  };

  const makeReaderContext = (): NativeSnapshotReaderContextV4 =>
    ({
      getNode: (...args: unknown[]) => invoke('getNode', args),
      getNodeParameter: (...args: unknown[]) => invoke('getNodeParameter', args),
      getInputData: (...args: unknown[]) => invoke('getInputData', args),
      getExecutionId: (...args: unknown[]) => invoke('getExecutionId', args),
      getWorkflow: (...args: unknown[]) => invoke('getWorkflow', args),
      getInstanceId: (...args: unknown[]) => invoke('getInstanceId', args),
      getCredentials: (...args: unknown[]) => invoke('getCredentials', args),
      evaluateExpression: (...args: unknown[]) => invoke('evaluateExpression', args),
    }) as unknown as NativeSnapshotReaderContextV4;

  const readStoreIdentity = async (): Promise<NativeStoreIdentityV4> => {
    const readerContext = makeReaderContext();
    const backendValue = readerContext.getNodeParameter('backend', 0, 'embedded');
    if (backendValue === 'embedded') {
      const workflowValue = readerContext.getWorkflow().id;
      const workflowId = workflowValue ?? 'default';
      if (typeof workflowId !== 'string') throw closedFailure();
      const customStoragePath = readerContext.getNodeParameter('customStoragePath', 0, '');
      if (typeof customStoragePath !== 'string') throw closedFailure();
      const persistPath = resolveStoragePath({ customStoragePath, workflowId });
      const storeHash = embeddedAutomaticCaptureStoreHash(persistPath);
      if (!storeHash) throw closedFailure();
      return { backend: 'embedded', storeHash };
    }

    if (backendValue === 'neo4j') {
      const credentials = (await readerContext.getCredentials('engramNeo4jApi')) as unknown;
      if (!credentials || typeof credentials !== 'object') throw closedFailure();
      const credentialData = credentials as {
        uri?: unknown;
        database?: unknown;
        username?: unknown;
        password?: unknown;
      };
      if (
        typeof credentialData.uri !== 'string' ||
        (credentialData.database !== undefined && typeof credentialData.database !== 'string') ||
        typeof credentialData.username !== 'string' ||
        typeof credentialData.password !== 'string'
      ) {
        throw closedFailure();
      }
      const storeHash = neo4jAutomaticCaptureStoreHash(credentialData.uri, credentialData.database);
      if (!storeHash) throw closedFailure();
      return { backend: 'neo4j', storeHash };
    }

    throw closedFailure();
  };

  const readNativeState = () => {
    const readerContext = makeReaderContext();
    const admission = readReplaySafeMemoryNativeContext(readerContext as IExecuteFunctions, 0);
    if (!admission) throw closedFailure();
    const native = AutonomousPersonalMemoryHandoffNativeTupleV4OwnedDataSchema.parse({
      instance: readerContext.getInstanceId(),
      workflow: readerContext.getWorkflow().id ?? null,
      execution: readerContext.getExecutionId(),
    });
    return { native, processingAttemptHash: admission.processingAttemptHash };
  };

  return {
    async read(): Promise<AutonomousPersonalAssistantNativeSnapshotV4> {
      try {
        if (!liveMethods) throw closedFailure();
        const beforeStore = await readStoreIdentity();
        const beforeNative = readNativeState();
        const config = await readAutonomousPersonalNativeMemoryConfigV4(
          makeReaderContext(),
          0,
          beforeStore.storeHash,
        );
        if (!liveMethods) throw closedFailure();
        const afterStore = await readStoreIdentity();
        const afterNative = readNativeState();
        if (
          beforeStore.backend !== afterStore.backend ||
          beforeStore.storeHash !== afterStore.storeHash ||
          beforeNative.processingAttemptHash !== afterNative.processingAttemptHash ||
          JSON.stringify(beforeNative.native) !== JSON.stringify(config.native) ||
          JSON.stringify(afterNative.native) !== JSON.stringify(config.native)
        ) {
          throw closedFailure();
        }
        const snapshot = AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema.parse({
          config,
          memoryAttemptHash: beforeNative.processingAttemptHash,
        });
        return deepFreeze(snapshot);
      } catch (error) {
        if (!liveMethods) throw closedFailure();
        if (error instanceof AutonomousPersonalNativeMemorySnapshotV4Error) throw error;
        if (error instanceof AutonomousPersonalNativeMemoryConfigV4Error) {
          throw new AutonomousPersonalNativeMemorySnapshotV4Error(error.reason);
        }
        throw closedFailure();
      }
    },
    close(): void {
      if (!liveMethods) return;
      for (const name of Object.keys(liveMethods) as ContextMethodNameV4[]) {
        liveMethods[name] = null as never;
      }
      liveMethods = null;
    },
  };
}
