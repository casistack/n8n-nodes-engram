import { randomUUID } from 'crypto';
import { makeCompositionalAssistantHumanParentFixture } from '../../helpers/compositionalAssistantParentFixture';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { CompositionalCompletionStageAuditV3Schema } from '../../../src/schemas/CompositionalCompletionStageV3.schema';
import {
  buildCommittedCompositionalCaptureOperationV3,
  CompositionalCaptureTerminalOperationFailureV3,
} from '../../../src/storage/CompositionalCaptureTerminalOperationV3';

const attemptHash = (value: number): string => value.toString(16).padStart(64, '0');

function fixture(kind: 'accepted_bundle' | 'source_verdict' = 'source_verdict') {
  const parent = makeCompositionalAssistantHumanParentFixture(kind);
  const committed = parent.operation;
  const createdAt = committed.createdAt;
  const leaseDurationMs = Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      committed.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
    ),
  );
  const { terminalReceipt: _receipt, completionCallHash: _completion, ...common } = committed;
  void _receipt;
  void _completion;
  const leasedOperation = CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...common,
    lastObservedAt: createdAt,
    attempts: [
      AutomaticOperationAttemptSchema.parse({
        attemptHash: attemptHash(1),
        at: createdAt,
        disposition: 'claim_won',
      }),
    ],
    state: 'leased',
    lease: {
      token: randomUUID(),
      acquiredAt: createdAt,
      renewedAt: createdAt,
      expiresAt: new Date(Date.parse(createdAt) + leaseDurationMs).toISOString(),
      claimKind: 'initial',
    },
  });
  if (leasedOperation.state !== 'leased') throw new Error('Expected a leased operation');
  const audit = CompositionalCompletionStageAuditV3Schema.parse({
    action: 'completion',
    attemptIdHash: 'f'.repeat(64),
    operationId: leasedOperation.operationId,
    sourceId: leasedOperation.identity.sourceId,
  });
  return {
    leasedOperation,
    terminalReceipt: committed.terminalReceipt,
    completionCallHash: 'e'.repeat(64),
    audit,
  };
}

describe('bounded V3 committed operation candidate', () => {
  it.each(['source_verdict', 'accepted_bundle'] as const)(
    'builds a detached committed operation for a %s receipt',
    (kind) => {
      const input = fixture(kind);
      const operation = buildCommittedCompositionalCaptureOperationV3(input);

      expect(operation).toMatchObject({
        operationId: input.leasedOperation.operationId,
        identity: input.leasedOperation.identity,
        descriptor: input.leasedOperation.descriptor,
        state: 'committed',
        lastObservedAt: input.terminalReceipt.terminalAt,
        completionCallHash: input.completionCallHash,
        terminalReceipt: input.terminalReceipt,
      });
      expect(operation).not.toHaveProperty('lease');
      expect(operation.attempts).toEqual([
        ...input.leasedOperation.attempts,
        {
          attemptHash: input.audit.attemptIdHash,
          at: input.terminalReceipt.terminalAt,
          disposition: 'committed',
        },
      ]);
      expect(operation.attempts[0]).toEqual(input.leasedOperation.attempts[0]);
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Object.isFrozen(operation.attempts)).toBe(true);
      expect(input.leasedOperation.state).toBe('leased');
    },
  );

  it('preserves all 32 prior audits and marks truncation without changing overflow', () => {
    const input = fixture();
    const createdAt = input.leasedOperation.createdAt;
    const attempts = [
      input.leasedOperation.attempts[0],
      ...Array.from({ length: AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation - 1 }, (_, index) =>
        AutomaticOperationAttemptSchema.parse({
          attemptHash: attemptHash(index + 2),
          at: createdAt,
          disposition: 'in_progress',
        }),
      ),
    ];
    const leasedOperation = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...input.leasedOperation,
      attempts,
      auditTruncated: false,
    });
    const operation = buildCommittedCompositionalCaptureOperationV3({
      ...input,
      leasedOperation,
    });

    expect(operation.attempts).toEqual(attempts);
    expect(operation.attempts).toHaveLength(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation);
    expect(operation.attempts[0]).toEqual(attempts[0]);
    expect(operation.auditTruncated).toBe(true);
    expect(operation.overflowCount).toBe(leasedOperation.overflowCount);
  });

  it('adds the completion audit as entry 32 without trimming a 31-entry prefix', () => {
    const input = fixture();
    const createdAt = input.leasedOperation.createdAt;
    const attempts = [
      input.leasedOperation.attempts[0],
      ...Array.from({ length: AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation - 2 }, (_, index) =>
        AutomaticOperationAttemptSchema.parse({
          attemptHash: attemptHash(index + 2),
          at: createdAt,
          disposition: 'in_progress',
        }),
      ),
    ];
    const leasedOperation = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...input.leasedOperation,
      attempts,
      auditTruncated: false,
    });
    const operation = buildCommittedCompositionalCaptureOperationV3({
      ...input,
      leasedOperation,
    });

    expect(operation.attempts.slice(0, attempts.length)).toEqual(attempts);
    expect(operation.attempts).toHaveLength(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation);
    expect(operation.attempts.at(-1)).toMatchObject({
      attemptHash: input.audit.attemptIdHash,
      disposition: 'committed',
    });
    expect(operation.auditTruncated).toBe(false);
  });

  it('does not append a completion audit already present exactly once', () => {
    const input = fixture();
    const existingAudit = AutomaticOperationAttemptSchema.parse({
      attemptHash: input.audit.attemptIdHash,
      at: input.leasedOperation.lastObservedAt,
      disposition: 'committed',
    });
    const leasedOperation = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...input.leasedOperation,
      attempts: [...input.leasedOperation.attempts, existingAudit],
    });
    const operation = buildCommittedCompositionalCaptureOperationV3({
      ...input,
      leasedOperation,
    });
    expect(operation.attempts).toEqual(leasedOperation.attempts);
  });

  it.each([
    [
      'duplicate completion audit',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        leasedOperation: CompositionalAutomaticCaptureOperationV3Schema.parse({
          ...input.leasedOperation,
          attempts: [
            ...input.leasedOperation.attempts,
            {
              attemptHash: input.audit.attemptIdHash,
              at: input.leasedOperation.lastObservedAt,
              disposition: 'committed',
            },
            {
              attemptHash: input.audit.attemptIdHash,
              at: input.leasedOperation.lastObservedAt,
              disposition: 'committed',
            },
          ],
        }),
      }),
    ],
    [
      'audit for another source',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        audit: { ...input.audit, sourceId: randomUUID() },
      }),
    ],
    [
      'receipt for another operation',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        terminalReceipt: { ...input.terminalReceipt, operationId: randomUUID() },
      }),
    ],
    [
      'receipt for another source hash',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        terminalReceipt: { ...input.terminalReceipt, sourceHash: '0'.repeat(64) },
      }),
    ],
    [
      'receipt for another descriptor',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        terminalReceipt: { ...input.terminalReceipt, descriptorHash: '0'.repeat(64) },
      }),
    ],
    [
      'terminal time regression',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        terminalReceipt: {
          ...input.terminalReceipt,
          terminalAt: new Date(Date.parse(input.leasedOperation.createdAt) - 1).toISOString(),
        },
      }),
    ],
    [
      'terminal time at lease expiry',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        terminalReceipt: {
          ...input.terminalReceipt,
          terminalAt: input.leasedOperation.lease.expiresAt,
        },
      }),
    ],
    [
      'missing initial claim audit',
      (input: ReturnType<typeof fixture>) => ({
        ...input,
        leasedOperation: CompositionalAutomaticCaptureOperationV3Schema.parse({
          ...input.leasedOperation,
          attempts: [],
        }),
      }),
    ],
  ] as const)('rejects %s', (_label, mutate) => {
    const input = mutate(fixture());
    try {
      buildCommittedCompositionalCaptureOperationV3(input);
      throw new Error('Expected a bounded terminal operation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionalCaptureTerminalOperationFailureV3);
    }
  });

  it('preserves the exact cancellation error identity from the work check', () => {
    const cancellation = new Error('cancelled');
    expect(() =>
      buildCommittedCompositionalCaptureOperationV3(fixture(), () => {
        throw cancellation;
      }),
    ).toThrow(cancellation);
  });

  it('preserves cancellation at the final post-freeze work check', () => {
    const cancellation = new Error('cancelled after freeze');
    let checks = 0;
    expect(() =>
      buildCommittedCompositionalCaptureOperationV3(fixture(), () => {
        checks += 1;
        if (checks === 8) throw cancellation;
      }),
    ).toThrow(cancellation);
    expect(checks).toBe(8);
  });

  it('rejects accessors and proxies without invoking caller code', () => {
    const input = fixture();
    let getterCalled = false;
    Object.defineProperty(input, 'completionCallHash', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'e'.repeat(64);
      },
    });
    expect(() => buildCommittedCompositionalCaptureOperationV3(input)).toThrow(
      CompositionalCaptureTerminalOperationFailureV3,
    );
    expect(getterCalled).toBe(false);

    const proxied = new Proxy(fixture(), {
      get() {
        throw new Error('Unexpected proxy access');
      },
      ownKeys() {
        throw new Error('Unexpected proxy enumeration');
      },
    });
    expect(() => buildCommittedCompositionalCaptureOperationV3(proxied)).toThrow(
      CompositionalCaptureTerminalOperationFailureV3,
    );
  });
});
