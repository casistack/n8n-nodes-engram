import type { IExecuteFunctions } from 'n8n-workflow';
import { readNativeCompositionalMemoryContextV3 as read } from '../../../src/utils/nativeCompositionalMemoryV3';
import { readReplaySafeMemoryNativeContext } from '../../../src/utils/replaySafeMemoryNative';
import { nativeCompositionalProcessingAttemptHashV3 } from '../../../src/utils/nativeCompositionalProcessingV3';

function context() {
  return {
    getNode: jest.fn(() => ({
      id: 'synthetic-memory',
      type: 'n8n-nodes-engram.engramMemory',
      typeVersion: 3,
      parameters: {
        automaticCaptureLifecycle: 'replaySafeV2',
        automaticPreferenceInterpreter: 'compositionalV2',
      },
    })),
    getExecutionId: jest.fn(() => 'synthetic-execution'),
    getWorkflow: jest.fn(() => ({ id: 'synthetic-workflow' })),
    getInstanceId: jest.fn(() => 'synthetic-instance'),
    getInputData: jest.fn(() => [{ json: { expectedHumanProcessingAttemptHash: 'spoofed' } }]),
  };
}
const runtime = {
  profileId: 'conservative',
  actor: { namespace: ' synthetic namespace ', issuer: 'synthetic-app', actorReference: 'actor' },
  storeIdentity: 'a'.repeat(64),
  turnId: 'synthetic-event',
  capturedSourceId: '00000000-0000-4000-8000-000000000001',
};
const native = (ctx: ReturnType<typeof context>) => ctx as unknown as IExecuteFunctions;

describe('standalone compositional native Memory configuration', () => {
  test('derives the same human attempt as capture and preserves the assistant attempt', () => {
    const ctx = context();
    const result = read(native(ctx), runtime);
    expect(result.processingAttemptHash).toBe(
      readReplaySafeMemoryNativeContext(native(ctx))!.processingAttemptHash,
    );
    expect(result.expectedHumanProcessingAttemptHash).toBe(
      nativeCompositionalProcessingAttemptHashV3(native(ctx), {
        namespace: runtime.actor.namespace,
        issuer: runtime.actor.issuer,
        actorReference: runtime.actor.actorReference,
        turn: runtime.turnId,
      }),
    );
    expect(read(native(ctx), runtime)).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    ctx.getExecutionId.mockReturnValue('another-execution');
    expect(read(native(ctx), runtime).expectedHumanProcessingAttemptHash).not.toBe(
      result.expectedHumanProcessingAttemptHash,
    );
  });
  test.each(['literalV1', '={{ "compositionalV2" }}', 'unknown'])(
    'rejects an unfixed selection %s',
    (value) => {
      const ctx = context();
      const node = ctx.getNode();
      node.parameters.automaticPreferenceInterpreter = value;
      ctx.getNode.mockReturnValue(node);
      expect(() => read(native(ctx), runtime)).toThrow('unsupported_configuration');
      expect(ctx.getInputData).not.toHaveBeenCalled();
    },
  );
  test('requires native v3 admission, the safe lifecycle and single main input', () => {
    const ctx = context();
    ctx.getInputData.mockReturnValue([]);
    expect(() => read(native(ctx), runtime)).toThrow('single_event_required');
    ctx.getInputData.mockReturnValue([{ json: { expectedHumanProcessingAttemptHash: 'spoofed' } }]);
    const node = ctx.getNode();
    node.typeVersion = 2;
    ctx.getNode.mockReturnValue(node);
    expect(() => read(native(ctx), runtime)).toThrow('unsupported_configuration');
    node.typeVersion = 3;
    node.parameters.automaticCaptureLifecycle = 'legacy';
    expect(() => read(native(ctx), runtime)).toThrow('unsupported_configuration');
  });
  test('rejects injected runtime hashes and unsafe raw runtime access without traps', () => {
    const ctx = context();
    expect(() =>
      read(native(ctx), { ...runtime, expectedHumanProcessingAttemptHash: 'a'.repeat(64) }),
    ).toThrow('unsupported_configuration');
    let traps = 0;
    expect(() => read(native(ctx), new Proxy({}, { get: () => ++traps }))).toThrow(
      'unsupported_configuration',
    );
    expect(traps).toBe(0);
    expect(() => read(native(ctx), { ...runtime, profileId: 'existing' })).toThrow(
      'unsupported_configuration',
    );
    expect(() => read(native(ctx), { ...runtime, capturedSourceId: undefined })).toThrow(
      'unsupported_configuration',
    );
  });
});
