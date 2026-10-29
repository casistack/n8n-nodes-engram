import { compileAutomaticCaptureInitialLeaseFieldsV1 } from '../../../src/storage/AutomaticCaptureStateCoreV1';
import { buildCommittedAutonomousPersonalOperationV4 } from '../../../src/storage/AutonomousPersonalTerminalOperationV4';
import { AutonomousPersonalOperationV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import {
  autonomousPersonalQualifiedClaimFixtureV4,
  type AutonomousPersonalQualifiedClaimFixtureV4,
} from '../../helpers/autonomousPersonalQualifiedClaimV4';

let baseline: AutonomousPersonalQualifiedClaimFixtureV4;
beforeAll(async () => {
  baseline = await autonomousPersonalQualifiedClaimFixtureV4();
});
function input() {
  const operation = structuredClone(baseline.operation);
  const { terminalReceipt, completionCallHash: _completionCallHash, ...common } = operation;
  void _completionCallHash;
  const initial = compileAutomaticCaptureInitialLeaseFieldsV1({
    createdAt: operation.createdAt,
    invocationDeadlineMs: operation.descriptor.invocationDeadlineMs,
    beginCallHash: operation.beginCallHash,
    leaseToken: '90000000-0000-4000-8000-000000000002',
    initialAttemptHash: operation.attempts[0]!.attemptHash,
  });
  const leasedOperation = AutonomousPersonalOperationV4OwnedDataSchema.parse({
    ...common,
    ...initial,
  });
  if (leasedOperation.state !== 'leased') throw new Error('Expected synthetic initial lease');
  return {
    leasedOperation,
    terminalReceipt,
    completionCallHash: 'e'.repeat(64),
    audit: {
      action: 'completion' as const,
      attemptIdHash: 'd'.repeat(64),
      operationId: operation.operationId,
      sourceId: operation.identity.sourceId,
    },
  };
}
it.each(['sourceHash', 'descriptorHash', 'policyFingerprint'] as const)(
  'rejects a structurally valid receipt with different %s',
  (field) => {
    const value = input();
    value.terminalReceipt[field] = 'f'.repeat(64);
    expect(() => buildCommittedAutonomousPersonalOperationV4(value, () => undefined)).toThrow();
  },
);
it('preserves original source time, identity, policy and begin provenance', () => {
  const value = input();
  const before = JSON.stringify(value);
  const result = buildCommittedAutonomousPersonalOperationV4(value, () => undefined);
  expect(result.identity).toEqual(value.leasedOperation.identity);
  expect(result.descriptor).toEqual(value.leasedOperation.descriptor);
  expect(result.createdAt).toBe(baseline.createdAt);
  expect(result.createdAt).not.toBe(baseline.source.reference_time);
  expect(result.lastObservedAt).toBe(baseline.terminalAt);
  expect(result.beginCallHash).toBe(value.leasedOperation.beginCallHash);
  expect(result.attempts.slice(0, value.leasedOperation.attempts.length)).toEqual(
    value.leasedOperation.attempts,
  );
  expect(JSON.stringify(value)).toBe(before);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.descriptor)).toBe(true);
});
it('rejects an evidence getter before it is observed', () => {
  const value = input();
  const getter = jest.fn(() => value.terminalReceipt);
  const unsafe = Object.defineProperty({ ...value }, 'terminalReceipt', {
    get: getter,
    enumerable: true,
  });
  expect(() => buildCommittedAutonomousPersonalOperationV4(unsafe, () => undefined)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it('returns the exact code-owned failure even when it is raised at the final check', () => {
  const value = input();
  let calls = 0;
  buildCommittedAutonomousPersonalOperationV4(value, () => {
    calls++;
  });
  const sentinel = new Error('synthetic private work failure');
  let current = 0;
  let caught: unknown;
  try {
    buildCommittedAutonomousPersonalOperationV4(value, () => {
      current++;
      if (current === calls) throw sentinel;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(sentinel);
});
