import type { IExecuteFunctions, INode } from 'n8n-workflow';
import {
  readReplaySafeMemoryNativeContext,
  readReplaySafeMemoryNamespace,
} from '../../../src/utils/replaySafeMemoryNative';

function context(parameters: INode['parameters'] = {}, extra: Partial<INode> = {}) {
  const node = {
    id: 'synthetic-memory-node',
    type: 'n8n-nodes-engram.engramMemory',
    typeVersion: 3,
    parameters,
    ...extra,
  } as INode;
  return {
    getNode: jest.fn(() => node),
    getExecutionId: jest.fn(() => 'synthetic-execution-one'),
    getWorkflow: jest.fn(() => ({ id: 'synthetic-workflow' })),
    getInputData: jest.fn(() => [{ json: {} }]),
    getNodeParameter: jest.fn(() => {
      throw new Error('Unexpected expression resolution');
    }),
    getCredentials: jest.fn(() => {
      throw new Error('Unexpected credential access');
    }),
  };
}
const read = (ctx: ReturnType<typeof context>) =>
  readReplaySafeMemoryNativeContext(ctx as unknown as IExecuteFunctions);

describe('native Memory lifecycle admission before side effects', () => {
  test.each(['customKey', 'fromInput'])(
    'preserves exact namespace whitespace from %s',
    (selection) => {
      const ctx = context();
      const namespace = ' synthetic namespace ';
      ctx.getNodeParameter.mockImplementation(((name: string) =>
        name === 'sessionIdType' ? selection : namespace) as never);
      const native = { ...ctx, evaluateExpression: jest.fn(() => namespace) };
      expect(readReplaySafeMemoryNamespace(native as unknown as IExecuteFunctions, 0)).toBe(
        namespace,
      );
    },
  );

  test.each([undefined, 'legacy'])('preserves the old path for %s', (lifecycle) => {
    const ctx = context(lifecycle === undefined ? {} : { automaticCaptureLifecycle: lifecycle });
    expect(read(ctx)).toBeUndefined();
    expect(ctx.getExecutionId).not.toHaveBeenCalled();
    expect(ctx.getNodeParameter).not.toHaveBeenCalled();
    expect(ctx.getCredentials).not.toHaveBeenCalled();
  });
  test.each([null, 'unknown', '={{ "replaySafeV2" }}'])(
    'rejects raw opt-in %s without resolving it',
    (lifecycle) => {
      const ctx = context({ automaticCaptureLifecycle: lifecycle });
      expect(() => read(ctx)).toThrow('unsupported_configuration');
      expect(ctx.getNodeParameter).not.toHaveBeenCalled();
      expect(ctx.getCredentials).not.toHaveBeenCalled();
      expect(ctx.getExecutionId).not.toHaveBeenCalled();
    },
  );
  test.each([
    { typeVersion: 2 },
    { type: 'n8n-nodes-engram.engramMemoryTool' },
    { continueOnFail: true },
    { onError: 'continueRegularOutput' as const },
    { onError: 'continueErrorOutput' as const },
  ])('rejects an unsupported node or continuation mode %j', (extra) => {
    const ctx = context({ automaticCaptureLifecycle: 'replaySafeV2' }, extra);
    expect(() => read(ctx)).toThrow('unsupported_configuration');
    expect(ctx.getExecutionId).not.toHaveBeenCalled();
  });
  test('binds processing attempts to native execution/workflow/node while leaving source identity absent', () => {
    const ctx = context({ automaticCaptureLifecycle: 'replaySafeV2' });
    const first = read(ctx)!;
    expect(first).toEqual({
      captureLifecycle: 'replaySafeV2',
      processingAttemptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(read(ctx)).toEqual(first);
    ctx.getExecutionId.mockReturnValue('synthetic-execution-two');
    expect(read(ctx)!.processingAttemptHash).not.toBe(first.processingAttemptHash);
    expect(ctx.getNodeParameter).not.toHaveBeenCalled();
    expect(ctx.getCredentials).not.toHaveBeenCalled();
  });
  test('requires actual processing execution metadata', () => {
    const ctx = context({ automaticCaptureLifecycle: 'replaySafeV2' });
    ctx.getExecutionId.mockReturnValue(' ');
    expect(() => read(ctx)).toThrow('processing_attempt_required');
  });

  test.each([0, 2])(
    'rejects parent main input count %s before processing or credentials',
    (count) => {
      const ctx = context({ automaticCaptureLifecycle: 'replaySafeV2' });
      ctx.getInputData.mockReturnValue(Array.from({ length: count }, () => ({ json: {} })));
      expect(() => read(ctx)).toThrow('single_event_required');
      expect(ctx.getInputData).toHaveBeenCalledWith(0, 'main');
      expect(ctx.getExecutionId).not.toHaveBeenCalled();
      expect(ctx.getCredentials).not.toHaveBeenCalled();
    },
  );
});
