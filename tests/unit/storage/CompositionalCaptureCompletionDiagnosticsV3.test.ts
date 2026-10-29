import { compositionalCaptureCompletionDecisionKindV3 as kind } from '../../../src/storage/CompositionalCaptureCompletionDiagnosticsV3';
import { CompositionalCompletionStageDeferredReasonV3Schema } from '../../../src/schemas/CompositionalCompletionStageV3.schema';
import { CompositionalCaptureNonPermitDecisionV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';

describe('V3 completion backend diagnostic parity', () => {
  it.each(CompositionalCompletionStageDeferredReasonV3Schema.options)(
    'maps every closed stage reason to a false-only public decision: %s',
    (reason) => {
      expect(
        CompositionalCaptureNonPermitDecisionV3Schema.parse({
          kind: kind(reason),
          eligibleFirstCommit: false,
        }).eligibleFirstCommit,
      ).toBe(false);
    },
  );
  it('keeps expiry fenced and resource limits distinct from invalid plans', () => {
    expect(kind('lease_expired')).toBe('fenced');
    expect(kind('operation_not_leased')).toBe('fenced');
    for (const reason of ['inspection_incomplete', 'plan_too_large', 'invalid_resources'])
      expect(kind(reason)).toBe('resource_exhausted');
    expect(kind('invalid_plan')).toBe('invalid_plan');
    expect(kind('storage_error')).toBe('storage_error');
  });
  it('never inspects arbitrary diagnostic objects or exposes their text', () => {
    let traps = 0;
    const hostile = Object.defineProperty({}, 'then', { get: () => ++traps });
    expect(kind(hostile)).toBe('invalid_plan');
    expect(kind(new Proxy({}, { get: () => ++traps }))).toBe('invalid_plan');
    expect(kind('arbitrary upstream private error')).toBe('invalid_plan');
    expect(traps).toBe(0);
  });
});
