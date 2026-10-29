import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { readNativeCompositionalHumanCaptureRequestV3 as read } from '../../../src/utils/nativeCompositionalCaptureV3';
import { readReplaySafeHumanCaptureRequest } from '../../../src/utils/replaySafeAutomaticAdmin';
import { nativeCompositionalProcessingAttemptHashV3 } from '../../../src/utils/nativeCompositionalProcessingV3';

function fixture() {
  const node: INode = {
    id: 'synthetic-capture',
    name: 'Synthetic Capture',
    type: 'n8n-nodes-engram.engramAdmin',
    typeVersion: 3,
    position: [0, 0],
    parameters: {
      resource: 'automaticMemory',
      operation: 'captureHuman',
      automaticCaptureLifecycle: 'replaySafeV2',
      automaticPreferenceInterpreter: 'compositionalV2',
      automaticMemoryProfile: 'conservative',
      automaticNamespace: ' synthetic namespace ',
      automaticIssuer: 'synthetic-issuer',
      automaticActor: 'synthetic-actor',
      automaticTurn: 'synthetic-event',
      automaticInput: 'I prefer British English.',
    },
  };
  let execution = 'synthetic-execution';
  const ctx = {
    getNode: () => node,
    getNodeParameter: (name: string, _index: number, fallback: unknown) =>
      node.parameters[name] ?? fallback,
    getExecutionId: () => execution,
    getWorkflow: () => ({ id: 'synthetic-workflow' }),
    getInstanceId: () => 'synthetic-instance',
    getInputData: () => [{ json: { executionId: 'fake', attemptIdHash: 'f'.repeat(64) } }],
  } as unknown as IExecuteFunctions;
  return {
    node,
    ctx,
    changeExecution: (value: string) => {
      execution = value;
    },
  };
}

describe('native extended-preference capture request mapping (data only)', () => {
  it('preserves the exact event/source mapping and changes only the explicit family/attempt fields', () => {
    const { ctx } = fixture();
    const old = readReplaySafeHumanCaptureRequest(ctx, 0);
    const value = read(ctx, 0);
    expect(value).toEqual({
      ...old,
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      attemptIdHash: nativeCompositionalProcessingAttemptHashV3(ctx, {
        namespace: old.namespace,
        issuer: old.issuer,
        actorReference: old.actorReference,
        turn: old.turn,
      }),
    });
    expect(value.namespace).toBe(' synthetic namespace ');
    expect(value.source.originalSourceExecutionId).toBeNull();
    expect(readReplaySafeHumanCaptureRequest(ctx, 0)).toEqual(old);
  });

  it('uses actual execution provenance while leaving stable event/source data unchanged', () => {
    const f = fixture();
    const first = read(f.ctx, 0);
    f.changeExecution('synthetic-redelivery');
    const second = read(f.ctx, 0);
    expect(second.attemptIdHash).not.toBe(first.attemptIdHash);
    expect({ ...second, attemptIdHash: first.attemptIdHash }).toEqual(first);
    expect(first.attemptIdHash).not.toBe('f'.repeat(64));
  });

  it.each([undefined, 'literalV1', '={{ "compositionalV2" }}'])(
    'requires deliberate fixed family selection: %s',
    (selection) => {
      const f = fixture();
      if (selection === undefined) delete f.node.parameters.automaticPreferenceInterpreter;
      else f.node.parameters.automaticPreferenceInterpreter = selection;
      expect(() => read(f.ctx, 0)).toThrow('unsupported_configuration');
    },
  );

  it('preserves exact UTF-16 protected wrapper boundaries without stripping human text', () => {
    const f = fixture();
    const prefix = 'Human: ';
    const body = '🙂 I prefer British English.';
    Object.assign(f.node.parameters, {
      automaticInput: prefix + body,
      automaticRawHuman: body,
      automaticWrapper: 'enabled',
      automaticRegionStart: prefix.length,
      automaticRegionEnd: prefix.length + body.length,
    });
    const value = read(f.ctx, 0);
    expect(value.source.content).toBe(prefix + body);
    expect(value.source.humanRegion).toEqual({
      start: prefix.length,
      end: prefix.length + body.length,
    });
    f.node.parameters.automaticRegionEnd = prefix.length + body.length - 1;
    expect(() => read(f.ctx, 0)).toThrow();
  });

  it('retains native lifecycle/version/synchronous/error-path restrictions', () => {
    for (const kind of ['version', 'continue', 'durable'] as const) {
      const f = fixture();
      if (kind === 'version') f.node.typeVersion = 2;
      if (kind === 'continue') f.node.continueOnFail = true;
      if (kind === 'durable') f.node.parameters.automaticExecution = 'durable';
      expect(() => read(f.ctx, 0)).toThrow('unsupported_mode');
    }
  });
});
