import type { IExecuteFunctions } from 'n8n-workflow';
import {
  nativeCompositionalProcessingAttemptHashV3 as derive,
  matchesNativeCompositionalOriginalAttemptV3 as matches,
} from '../../../src/utils/nativeCompositionalProcessingV3';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';

const domain = {
  namespace: ' synthetic namespace ',
  issuer: 'synthetic-app',
  actorReference: 'synthetic-human',
  turn: 'synthetic-event',
};
const context = (
  workflow = 'synthetic-workflow',
  execution = 'synthetic-execution',
  instance = 'synthetic-instance',
) =>
  ({
    getWorkflow: () => ({ id: workflow }),
    getExecutionId: () => execution,
    getInstanceId: () => instance,
  }) as Pick<IExecuteFunctions, 'getWorkflow' | 'getExecutionId' | 'getInstanceId'>;

describe('native V3 execution/event processing attempt provenance', () => {
  it('remains stable across same-execution tool loads and preserves exact namespace bytes', () => {
    const first = derive(context(), domain);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(
      derive(context(), {
        turn: domain.turn,
        issuer: domain.issuer,
        namespace: domain.namespace,
        actorReference: domain.actorReference,
      }),
    ).toBe(first);
    expect(derive(context(), { ...domain, namespace: domain.namespace.trim() })).not.toBe(first);
  });
  it.each([
    'instance',
    'workflow',
    'execution',
    'namespace',
    'issuer',
    'actorReference',
    'turn',
  ] as const)('does not reuse processing provenance after a different %s', (field) => {
    const first = derive(context(), domain);
    const changed =
      field === 'instance'
        ? derive(context(undefined, undefined, 'another-instance'), domain)
        : field === 'workflow'
          ? derive(context('another-workflow'), domain)
          : field === 'execution'
            ? derive(context(undefined, 'another-execution'), domain)
            : derive(context(), { ...domain, [field]: 'another-value' });
    expect(changed).not.toBe(first);
  });
  it('rejects caller processing overrides instead of treating them as native metadata', () => {
    expect(() => derive(context(), { ...domain, execution: 'spoofed' })).toThrow(
      'processing_attempt_required',
    );
    expect(() => derive(context(), { ...domain, expectedHash: 'a'.repeat(64) })).toThrow(
      'processing_attempt_required',
    );
    expect(() => derive(context('', ''), domain)).toThrow('processing_attempt_required');
  });
  it('does not inspect untrusted domain getters or proxy traps', () => {
    let traps = 0;
    const value = Object.defineProperty({}, 'namespace', { enumerable: true, get: () => ++traps });
    expect(() => derive(context(), value)).toThrow('processing_attempt_required');
    expect(() => derive(context(), new Proxy({}, { get: () => ++traps }))).toThrow(
      'processing_attempt_required',
    );
    expect(traps).toBe(0);
  });

  it.each(['accepted', 'proposed'] as const)(
    'matches only the original native claim for a %s graph outcome',
    (review) => {
      const { operation } = makeCompositionalCommittedClaimFixture(review);
      const scope = {
        namespace: operation.identity.namespace,
        issuer: operation.identity.issuer,
        actorReference: operation.identity.actorReference,
        turn: operation.identity.turn,
      };
      const first = derive(context(), scope);
      operation.attempts = [
        { attemptHash: first, at: operation.createdAt, disposition: 'claim_won' },
      ];
      expect(matches(operation, first)).toBe(true);
      expect(
        matches(operation, derive(context(undefined, 'cached-json-new-execution'), scope)),
      ).toBe(false);
      expect(matches({ ...operation, state: 'captured', generation: 0 }, first)).toBe(false);
    },
  );

  it('never treats a later replay/resume or second claim observation as original processing ownership', () => {
    const { operation } = makeCompositionalCommittedClaimFixture();
    const expected = 'a'.repeat(64);
    operation.attempts = [
      { attemptHash: 'b'.repeat(64), at: operation.createdAt, disposition: 'claim_won' },
      { attemptHash: expected, at: operation.lastObservedAt, disposition: 'committed_replay' },
    ];
    expect(matches(operation, expected)).toBe(false);
    operation.attempts[0].attemptHash = expected;
    operation.attempts[1] = {
      ...operation.attempts[1],
      attemptHash: 'c'.repeat(64),
      disposition: 'claim_won',
    };
    expect(matches(operation, expected)).toBe(false);
    operation.attempts = [operation.attempts[0]];
    expect(
      matches({ ...operation, retryCount: 1, lastRetryCallHash: 'd'.repeat(64) }, expected),
    ).toBe(true);
    expect(
      matches(
        { ...operation, generation: 2, retryCount: 1, lastRetryCallHash: 'd'.repeat(64) },
        expected,
      ),
    ).toBe(false);
    operation.attempts[0].at = operation.lastObservedAt;
    expect(matches(operation, expected)).toBe(false);
  });

  it('rejects hostile operation data without inspecting getters or proxies', () => {
    let traps = 0;
    const value = Object.defineProperty({}, 'version', { enumerable: true, get: () => ++traps });
    expect(matches(value, 'a'.repeat(64))).toBe(false);
    expect(matches(new Proxy({}, { get: () => ++traps }), 'a'.repeat(64))).toBe(false);
    expect(traps).toBe(0);
  });
});
