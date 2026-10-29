import type { IExecuteFunctions } from 'n8n-workflow';
import type { AutonomousPersonalBeginV4Request } from '../../src/schemas/AutonomousPersonalBeginV4.schema';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import { seedAutomaticCaptureSubject } from './automaticCaptureBackend';
import { readNativeAutonomousPersonalCaptureConfigV4 } from '../../src/utils/AutonomousPersonalCaptureNativeConfigV4';

export type AutonomousPersonalCaptureSeed = Awaited<ReturnType<typeof seedAutomaticCaptureSubject>>;

export interface NativeAutonomousPersonalCaptureOptions {
  executionId?: string;
  workflowId?: string;
  instanceId?: string;
  content?: string;
  sourceWorkflowId?: string;
  routeId?: string;
  model?: string;
  requestLimit?: number;
  deadlineMs?: number;
  interpreter?: string;
  credentials?: { apiKey: string; baseUrl: string };
  extraParameters?: Record<string, unknown>;
}

/** Seeds the subject and binding through the same public APIs as the older backend fixtures. */
export async function seedAutonomousPersonalCaptureSubject(
  storage: IGraphStorage,
  namespace?: string,
): Promise<AutonomousPersonalCaptureSeed> {
  return seedAutomaticCaptureSubject(storage, namespace);
}

/** Synthetic n8n context that exercises the fixed V4 factory entry, not a generic cap mint. */
export function nativeAutonomousPersonalCaptureContext(
  seed: AutonomousPersonalCaptureSeed,
  options: NativeAutonomousPersonalCaptureOptions = {},
): IExecuteFunctions {
  const parameters: Record<string, unknown> = {
    automaticCaptureLifecycle: 'replaySafeV2',
    automaticPreferenceInterpreter: options.interpreter ?? 'autonomousPersonalV1',
    automaticExecution: 'synchronous',
    automaticMemoryProfile: 'conservative',
    automaticNamespace: seed.request.namespace,
    automaticIssuer: seed.request.issuer,
    automaticActor: seed.request.actorReference,
    automaticTurn: seed.request.turn,
    automaticInput: options.content ?? seed.request.source.content,
    automaticRawHuman: '',
    automaticWrapper: 'disabled',
    automaticIntent: 'disabled',
    automaticOriginalExecution: '',
    automaticOriginalWorkflow: options.sourceWorkflowId ?? 'workflow:source',
    automaticCapturedSource: '',
    extractionRouteId: options.routeId ?? 'route:synthetic',
    queueModel: options.model ?? 'model:synthetic-memory',
    queueTemperatureMode: 'providerDefault',
    extractionRequestLimit: options.requestLimit ?? 2,
    extractionDeadlineMs: options.deadlineMs ?? 30_000,
    ...options.extraParameters,
  };

  const context = {
    getNode: () => ({
      id: 'synthetic-admin-node',
      type: 'n8n-nodes-engram.engramAdmin',
      typeVersion: 3,
      parameters: {
        resource: 'automaticMemory',
        operation: 'captureHuman',
        automaticCaptureLifecycle: 'replaySafeV2',
        automaticPreferenceInterpreter: options.interpreter ?? 'autonomousPersonalV1',
      },
    }),
    getNodeParameter: (name: string, _itemIndex: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
    getInputData: () => [{ json: {} }],
    getExecutionId: () => options.executionId ?? 'execution:A',
    getWorkflow: () => ({ id: options.workflowId ?? 'workflow:current' }),
    getInstanceId: () => options.instanceId ?? 'instance:synthetic',
    getCredentials: async () =>
      options.credentials ?? { apiKey: 'synthetic-only-key', baseUrl: 'https://memory.invalid/v1' },
  };
  return context as unknown as IExecuteFunctions;
}

export async function readNativeAutonomousRequest(
  context: IExecuteFunctions,
): Promise<AutonomousPersonalBeginV4Request> {
  const config = await readNativeAutonomousPersonalCaptureConfigV4(context);
  if (config.kind !== 'ready') throw new Error(`native_config_${config.kind}`);
  return config.request;
}
