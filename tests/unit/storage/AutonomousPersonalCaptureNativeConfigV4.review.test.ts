import type { IExecuteFunctions } from 'n8n-workflow';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';
import { dispatchNativeAutonomousPersonalCaptureV4 } from '../../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { readNativeAutonomousPersonalCaptureConfigV4 } from '../../../src/utils/AutonomousPersonalCaptureNativeConfigV4';

function makeContext(
  overrides: {
    parameters?: Record<string, unknown>;
    instance?: string;
    workflow?: string | null;
    execution?: string;
  } = {},
): IExecuteFunctions {
  const parameters: Record<string, unknown> = {
    automaticCaptureLifecycle: 'replaySafeV2',
    automaticPreferenceInterpreter: 'autonomousPersonalV1',
    automaticExecution: 'synchronous',
    automaticMemoryProfile: 'conservative',
    automaticNamespace: 'workflow:family',
    automaticIssuer: 'application:chat',
    automaticActor: 'user:42',
    automaticTurn: 'turn:17',
    automaticInput: 'I prefer concise explanations.',
    automaticRawHuman: '',
    automaticWrapper: 'disabled',
    automaticIntent: 'disabled',
    automaticOriginalExecution: '',
    automaticOriginalWorkflow: 'workflow:producer',
    automaticCapturedSource: '',
    extractionRouteId: 'route:primary',
    queueModel: 'model:memory',
    queueTemperatureMode: 'providerDefault',
    extractionRequestLimit: 2,
    extractionDeadlineMs: 45_000,
    ...overrides.parameters,
  };

  return {
    getNode: jest.fn(() => ({
      id: 'admin-node',
      type: 'n8n-nodes-engram.engramAdmin',
      typeVersion: 3,
      parameters: {
        resource: 'automaticMemory',
        operation: 'captureHuman',
        automaticCaptureLifecycle: 'replaySafeV2',
        automaticPreferenceInterpreter: 'autonomousPersonalV1',
      },
    })),
    getNodeParameter: jest.fn((name: string, _index: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
    ),
    getInputData: jest.fn(() => [{ json: {} }]),
    getExecutionId: jest.fn(() => overrides.execution ?? 'execution:A'),
    getWorkflow: jest.fn(() => ({
      id: Object.prototype.hasOwnProperty.call(overrides, 'workflow')
        ? overrides.workflow
        : 'workflow:current',
    })),
    getInstanceId: jest.fn(() => overrides.instance ?? 'instance:local'),
    getCredentials: jest.fn(async () => ({
      apiKey: 'synthetic-secret',
      baseUrl: 'https://memory.invalid/v1',
    })),
  } as unknown as IExecuteFunctions;
}

describe('Autonomous Personal V4 native config independent boundary cases', () => {
  it.each([
    ['unknown wrapper mode', { automaticWrapper: 'unexpected' }],
    ['unknown intent mode', { automaticIntent: 'maybe' }],
    ['numeric raw human field', { automaticRawHuman: 0 }],
    ['boolean raw human field', { automaticRawHuman: false }],
    ['null raw human field', { automaticRawHuman: null }],
    ['numeric original workflow', { automaticOriginalWorkflow: 0 }],
    ['boolean original workflow', { automaticOriginalWorkflow: false }],
  ] as const)('rejects %s instead of coercing it', async (_name, parameters) => {
    const result = await readNativeAutonomousPersonalCaptureConfigV4(makeContext({ parameters }));
    expect(result).toEqual({ kind: 'invalid_input' });
  });

  it.each([
    ['blank instance', { instance: '   ' }],
    ['unpaired surrogate instance', { instance: '\uD800' }],
    ['blank execution', { execution: '   ' }],
    ['unpaired surrogate execution', { execution: '\uD800' }],
    ['blank workflow', { workflow: '   ' }],
    ['unpaired surrogate workflow', { workflow: '\uD800' }],
  ] as const)('rejects %s before dispatching to storage', async (_name, contextOverrides) => {
    const begin = jest.fn(async () => ({ kind: 'in_progress', eligibleFirstCommit: false }));
    const storage = { beginAndClaimAutonomousPersonalCaptureV4: begin } as unknown as IGraphStorage;
    const result = await dispatchNativeAutonomousPersonalCaptureV4(
      makeContext(contextOverrides),
      storage,
    );

    expect(result).toEqual({ kind: 'invalid_input', eligibleFirstCommit: false });
    expect(begin).not.toHaveBeenCalled();
  });

  it('preserves the supported absent workflow form as null', async () => {
    const result = await readNativeAutonomousPersonalCaptureConfigV4(
      makeContext({ parameters: { automaticOriginalWorkflow: '' }, workflow: null }),
    );

    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.request.source.sourceWorkflowId).toBeNull();
      expect(result.nativeContext.workflow).toBeNull();
    }
  });
});
