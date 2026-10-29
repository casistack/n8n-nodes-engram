import { dirname } from 'node:path';
import type { AutonomousPersonalMemoryHandoffNativeTupleV4 } from '../../src/schemas/AutonomousPersonalMemoryHandoffV4.schema';
import type { AutonomousPersonalNativeMemoryConfigContextV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { resolveStoragePath } from '../../src/utils/helpers';

export type AutonomousPersonalMemorySourceMappingV4 =
  | Readonly<{ mode: 'full_body' }>
  | Readonly<{
      mode: 'application_region';
      humanRegion: Readonly<{ start: number; end: number }>;
    }>;

export interface AutonomousPersonalMemoryContextOptionsV4 {
  readonly persistPath: string;
  readonly storageWorkflowId: string;
  readonly native: AutonomousPersonalMemoryHandoffNativeTupleV4;
  readonly namespace: string;
  readonly issuer: string;
  readonly actorReference: string;
  readonly turn: string;
  readonly sourceId: string;
  readonly profileId?: 'conservative' | 'explicit' | 'reviewFirst';
  readonly explicitIntent?: boolean;
  readonly currentHumanQuery: string;
  readonly rawHumanContent?: string;
  readonly sourceMapping?: AutonomousPersonalMemorySourceMappingV4;
  readonly routeId?: string;
  readonly model?: string;
  readonly requestLimit?: number;
  readonly deadlineMs?: number;
  readonly temperatureMode?: 'legacy' | 'providerDefault' | 'custom';
  readonly temperature?: number;
  readonly itemCount?: number;
  readonly credentialKey?: string;
  readonly endpoint?: string;
}

export function autonomousPersonalMemoryStoreHashV4(persistPath: string): string {
  const storeHash = embeddedAutomaticCaptureStoreHash(persistPath);
  if (!storeHash) throw new Error('Expected an actual embedded Memory store path');
  return storeHash;
}

/** Synthetic IExecuteFunctions surface for the actual Engram Memory v3 reader. */
export function autonomousPersonalMemoryContextV4(
  options: AutonomousPersonalMemoryContextOptionsV4,
): AutonomousPersonalNativeMemoryConfigContextV4 {
  const sourceMapping = options.sourceMapping ?? { mode: 'full_body' as const };
  const wrapperEnabled = sourceMapping.mode === 'application_region';
  const parameters: Record<string, unknown> = {
    sessionIdType: 'customKey',
    sessionKey: options.namespace,
    backend: 'embedded',
    customStoragePath: dirname(options.persistPath),
    extractionExecution: 'synchronous',
    currentHumanQuery: options.currentHumanQuery,
    automaticMemoryProfile: options.profileId ?? 'conservative',
    automaticIssuer: options.issuer,
    automaticActor: options.actorReference,
    automaticTurn: options.turn,
    automaticIntent: options.explicitIntent ? 'enabled' : 'disabled',
    automaticRawHuman: options.rawHumanContent ?? '',
    automaticWrapper: wrapperEnabled ? 'enabled' : 'disabled',
    automaticCapturedSource: options.sourceId,
    advancedExtractionPolicy: 'bounded',
    knowledgeSelection: 'durableTemporal',
    extractionRequestLimit: options.requestLimit ?? 2,
    extractionDeadlineMs: options.deadlineMs ?? 30_000,
    extractionRouteId: options.routeId ?? 'route:parent-reader',
    extractionModel: options.model ?? 'model:parent-reader',
    extractionTemperatureMode: options.temperatureMode ?? 'providerDefault',
    ...(options.temperatureMode === 'custom'
      ? { extractionTemperature: options.temperature ?? 0 }
      : {}),
    ...(wrapperEnabled
      ? {
          automaticRegionStart: sourceMapping.humanRegion.start,
          automaticRegionEnd: sourceMapping.humanRegion.end,
        }
      : {}),
  };
  const node = {
    id: 'synthetic-memory-node',
    type: 'n8n-nodes-engram.engramMemory',
    typeVersion: 3,
    parameters: { automaticCaptureLifecycle: 'replaySafeV2' },
    continueOnFail: false,
    onError: 'stopWorkflow',
  };
  const resolvedPath = resolveStoragePath({
    customStoragePath: dirname(options.persistPath),
    workflowId: options.storageWorkflowId,
  });
  if (resolvedPath !== options.persistPath) {
    throw new Error('Synthetic Memory configuration does not resolve to its Graphology file');
  }

  return {
    getNode: () => node,
    getNodeParameter: (name: string, _itemIndex: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
    getInputData: () =>
      Array.from({ length: options.itemCount ?? 1 }, () => ({
        json: { sessionId: options.namespace },
      })),
    getExecutionId: () => options.native.execution,
    getWorkflow: () => ({ id: options.native.workflow }),
    getInstanceId: () => options.native.instance,
    getCredentials: async () => ({
      apiKey: options.credentialKey ?? 'synthetic-memory-secret',
      baseUrl: options.endpoint ?? 'https://memory.invalid/v1',
    }),
    evaluateExpression: () => options.namespace,
  } as unknown as AutonomousPersonalNativeMemoryConfigContextV4;
}
