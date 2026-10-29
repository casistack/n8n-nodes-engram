import { randomUUID } from 'node:crypto';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
  type AutonomousPersonalReceiptV4,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import type { AutonomousPersonalTerminalOperationV4Input } from '../../../src/schemas/AutonomousPersonalTerminalOperationV4.schema';
import {
  AutonomousPersonalTerminalOperationFailureV4,
  buildCommittedAutonomousPersonalOperationV4,
} from '../../../src/storage/AutonomousPersonalTerminalOperationV4';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

const hashAt = (value: number): string => value.toString(16).padStart(64, '0');

type LeasedOperationV4 = Extract<AutonomousPersonalOperationV4, { state: 'leased' }>;
type NonCancelledReceiptV4 = Exclude<AutonomousPersonalReceiptV4, { kind: 'cancelled' }>;
type FixtureInput = Omit<
  AutonomousPersonalTerminalOperationV4Input,
  'leasedOperation' | 'terminalReceipt'
> & { leasedOperation: LeasedOperationV4; terminalReceipt: NonCancelledReceiptV4 };

async function fixture(profile: 'conservative' | 'reviewFirst' = 'conservative') {
  const sourceFixture = await autonomousPersonalQualifiedClaimFixtureV4({ profile });
  const committed = sourceFixture.operation;
  const {
    state: _state,
    terminalReceipt: _receipt,
    completionCallHash: _completion,
    ...common
  } = committed;
  void _state;
  void _receipt;
  void _completion;
  const leaseDurationMs = Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      committed.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
    ),
  );
  const leasedOperation = AutonomousPersonalOperationV4OwnedDataSchema.parse({
    ...common,
    state: 'leased',
    lastObservedAt: committed.createdAt,
    lease: {
      token: randomUUID(),
      acquiredAt: committed.createdAt,
      renewedAt: committed.createdAt,
      expiresAt: new Date(Date.parse(committed.createdAt) + leaseDurationMs).toISOString(),
      claimKind: 'initial',
    },
  });
  if (leasedOperation.state !== 'leased') throw new Error('Expected a leased Operation4');
  const input: FixtureInput = {
    leasedOperation,
    terminalReceipt: sourceFixture.receipt,
    completionCallHash: 'e'.repeat(64),
    audit: {
      action: 'completion',
      attemptIdHash: 'f'.repeat(64),
      operationId: leasedOperation.operationId,
      sourceId: leasedOperation.identity.sourceId,
    },
  };
  return { sourceFixture, input };
}

function withOperation(input: FixtureInput, operationValue: unknown): FixtureInput {
  return { ...input, leasedOperation: operationValue as LeasedOperationV4 };
}

function receiptFor(
  operation: LeasedOperationV4,
  terminalAt: string,
  kind: 'occurrence' | 'deferred' | 'verdict',
): NonCancelledReceiptV4 | undefined {
  const common = {
    version: 4,
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: operation.identity.descriptorHash,
    policyFingerprint: operation.descriptor.policy.fingerprint,
    terminalAt,
  };
  if (kind === 'occurrence') return undefined;
  if (kind === 'verdict') {
    const receipt = AutonomousPersonalReceiptV4OwnedDataSchema.parse({
      ...common,
      kind: 'human_autonomous_source_verdict_committed',
      interpretationCoverage: 'complete',
      acceptedCoverage: 'none',
      acceptanceSemantics: 'per_item_kind_v1',
      sourceCoverage: {
        status: 'complete',
        scanStatus: 'complete',
        sourceUnitCount: 0,
        candidateUnitCount: 0,
        neutralUnitCount: 0,
        withheldUnitCount: 0,
        unresolvedUnitCount: 0,
        unresolvedReason: null,
      },
      selection: { kind: 'source_verdict', outcome: 'known_no_memory' },
    });
    if (receipt.kind === 'cancelled') throw new Error('Expected a committed receipt');
    return receipt;
  }
  const receipt = AutonomousPersonalReceiptV4OwnedDataSchema.parse({
    ...common,
    kind: 'human_autonomous_source_deferred_committed',
    interpretationCoverage: 'unknown',
    acceptedCoverage: 'none',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage: {
      status: 'not_reported',
      scanStatus: 'resource_limit',
      sourceUnitCount: null,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: null,
      unresolvedReason: 'unit_limit',
    },
    selection: { kind: 'source_only_deferred', reason: 'interpretation_capacity' },
  });
  if (receipt.kind === 'cancelled') throw new Error('Expected a committed receipt');
  return receipt;
}

function cancelledReceiptFor(
  operation: LeasedOperationV4,
  terminalAt: string,
): AutonomousPersonalReceiptV4 {
  return AutonomousPersonalReceiptV4OwnedDataSchema.parse({
    version: 4,
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: operation.identity.descriptorHash,
    policyFingerprint: operation.descriptor.policy.fingerprint,
    terminalAt,
    kind: 'cancelled',
    acceptedCoverage: 'none',
  });
}

function expectFailure(input: unknown, reason: string): void {
  try {
    buildCommittedAutonomousPersonalOperationV4(input, () => undefined);
    throw new Error('Expected a fixed terminal-operation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AutonomousPersonalTerminalOperationFailureV4);
    expect(error).toMatchObject({ reason });
    expect((error as Error).message).not.toContain('I prefer concise explanations');
  }
}

describe('bounded V4 committed Operation4 DATA', () => {
  it.each(['occurrence', 'deferred', 'verdict'] as const)(
    'builds a committed operation for the %s receipt branch',
    async (kind) => {
      const { sourceFixture, input } = await fixture();
      if (kind !== 'occurrence') {
        input.terminalReceipt = receiptFor(
          input.leasedOperation as Extract<typeof input.leasedOperation, { state: 'leased' }>,
          input.terminalReceipt.terminalAt,
          kind,
        )!;
      }
      const operation = buildCommittedAutonomousPersonalOperationV4(input, () => undefined);

      expect(operation).toMatchObject({
        operationId: input.leasedOperation.operationId,
        identity: input.leasedOperation.identity,
        descriptor: input.leasedOperation.descriptor,
        createdAt: input.leasedOperation.createdAt,
        state: 'committed',
        lastObservedAt: input.terminalReceipt.terminalAt,
        completionCallHash: input.completionCallHash,
        terminalReceipt: input.terminalReceipt,
      });
      expect(operation).not.toHaveProperty('lease');
      expect(operation).not.toHaveProperty('eligibleFirstCommit');
      expect(operation).not.toHaveProperty('handle');
      expect(operation.attempts).toEqual([
        ...input.leasedOperation.attempts,
        {
          attemptHash: input.audit.attemptIdHash,
          at: input.terminalReceipt.terminalAt,
          disposition: 'committed',
        },
      ]);
      expect(operation.createdAt).not.toBe(input.terminalReceipt.terminalAt);
      expect(operation.createdAt).not.toBe(sourceFixture.source.reference_time);
      expect(input.terminalReceipt.terminalAt).not.toBe(sourceFixture.source.reference_time);
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Object.isFrozen(operation.attempts)).toBe(true);
      expect(Object.isFrozen(operation.terminalReceipt)).toBe(true);
    },
  );

  it('preserves the original Review First proposal state while committing the operation', async () => {
    const { sourceFixture, input } = await fixture('reviewFirst');
    const receipt = input.terminalReceipt;
    if (receipt.kind !== 'human_autonomous_capture_committed') {
      throw new Error('Expected an occurrence receipt');
    }
    expect(receipt.selection.items[0]?.state).toBe('proposed');
    const operation = buildCommittedAutonomousPersonalOperationV4(input, () => undefined);
    expect(operation.state).toBe('committed');
    expect(operation.terminalReceipt).toEqual(receipt);
    expect(operation.terminalReceipt).toMatchObject({
      kind: 'human_autonomous_capture_committed',
      selection: { items: [expect.objectContaining({ state: 'proposed' })] },
    });
    expect(sourceFixture.source.reference_time).not.toBe(operation.createdAt);
  });

  it('appends a completion audit at slot 32 without trimming the 31-entry prefix', async () => {
    const { input } = await fixture();
    const createdAt = input.leasedOperation.createdAt;
    const attempts = [
      input.leasedOperation.attempts[0]!,
      ...Array.from({ length: AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation - 2 }, (_, index) =>
        AutomaticOperationAttemptSchema.parse({
          attemptHash: hashAt(index + 2),
          at: createdAt,
          disposition: 'in_progress',
        }),
      ),
    ];
    const leasedOperation = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...input.leasedOperation,
      attempts,
      auditTruncated: false,
    });
    const operation = buildCommittedAutonomousPersonalOperationV4(
      withOperation(input, leasedOperation),
      () => undefined,
    );

    expect(operation.attempts.slice(0, attempts.length)).toEqual(attempts);
    expect(operation.attempts).toHaveLength(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation);
    expect(operation.attempts.at(-1)).toEqual({
      attemptHash: input.audit.attemptIdHash,
      at: input.terminalReceipt.terminalAt,
      disposition: 'committed',
    });
    expect(operation.auditTruncated).toBe(false);
  });

  it('preserves all 32 prior audits and sets truncation without incrementing overflow', async () => {
    const { input } = await fixture();
    const createdAt = input.leasedOperation.createdAt;
    const attempts = [
      input.leasedOperation.attempts[0]!,
      ...Array.from({ length: AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation - 1 }, (_, index) =>
        AutomaticOperationAttemptSchema.parse({
          attemptHash: hashAt(index + 2),
          at: createdAt,
          disposition: 'in_progress',
        }),
      ),
    ];
    const leasedOperation = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...input.leasedOperation,
      attempts,
      overflowCount: 7,
      auditTruncated: false,
    });
    const operation = buildCommittedAutonomousPersonalOperationV4(
      withOperation(input, leasedOperation),
      () => undefined,
    );

    expect(operation.attempts).toEqual(attempts);
    expect(operation.attempts).toHaveLength(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation);
    expect(operation.attempts[0]).toEqual(attempts[0]);
    expect(operation.auditTruncated).toBe(true);
    expect(operation.overflowCount).toBe(7);
  });

  it('keeps an existing matching audit observation without appending a second disposition', async () => {
    const { input } = await fixture();
    const createdAt = input.leasedOperation.createdAt;
    const existing = AutomaticOperationAttemptSchema.parse({
      attemptHash: input.audit.attemptIdHash,
      at: createdAt,
      disposition: 'in_progress',
    });
    const leasedOperation = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...input.leasedOperation,
      attempts: [...input.leasedOperation.attempts, existing],
      auditTruncated: false,
    });
    const operation = buildCommittedAutonomousPersonalOperationV4(
      withOperation(input, leasedOperation),
      () => undefined,
    );
    expect(operation.attempts).toEqual(leasedOperation.attempts);
    expect(operation.auditTruncated).toBe(false);
  });

  it('keeps terminal time at last observation and rejects clock and lease boundaries', async () => {
    const { input } = await fixture();
    const atLastObservation = {
      ...input,
      terminalReceipt: {
        ...input.terminalReceipt,
        terminalAt: input.leasedOperation.lastObservedAt,
      },
    };
    expect(
      buildCommittedAutonomousPersonalOperationV4(atLastObservation, () => undefined)
        .lastObservedAt,
    ).toBe(input.leasedOperation.lastObservedAt);

    const beforeExpiry = {
      ...input,
      terminalReceipt: {
        ...input.terminalReceipt,
        terminalAt: new Date(Date.parse(input.leasedOperation.lease.expiresAt) - 1).toISOString(),
      },
    };
    expect(buildCommittedAutonomousPersonalOperationV4(beforeExpiry, () => undefined).state).toBe(
      'committed',
    );

    const atExpiry = {
      ...input,
      terminalReceipt: {
        ...input.terminalReceipt,
        terminalAt: input.leasedOperation.lease.expiresAt,
      },
    };
    expectFailure(atExpiry, 'lease_expired');

    const laterObservation = new Date(
      Date.parse(input.leasedOperation.createdAt) + 2_000,
    ).toISOString();
    const observedOperation = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...input.leasedOperation,
      lastObservedAt: laterObservation,
      attempts: [
        ...input.leasedOperation.attempts,
        AutomaticOperationAttemptSchema.parse({
          attemptHash: hashAt(18),
          at: laterObservation,
          disposition: 'in_progress',
        }),
      ],
    });
    const beforeObservation = {
      ...input,
      leasedOperation: observedOperation,
      terminalReceipt: {
        ...input.terminalReceipt,
        terminalAt: new Date(Date.parse(laterObservation) - 1).toISOString(),
      },
    };
    expectFailure(beforeObservation, 'clock_regression');
  });

  it('rejects resumed generations, invalid initial audit provenance, mismatched receipts and audits', async () => {
    const { input } = await fixture();
    const resumed = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...input.leasedOperation,
      generation: 2,
      lastResumeCause: 'lease_expired',
      lease: { ...input.leasedOperation.lease, claimKind: 'resume' },
    });
    expectFailure(withOperation(input, resumed), 'unsupported_generation');

    const badRenewal = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...input.leasedOperation,
      lastObservedAt: new Date(Date.parse(input.leasedOperation.createdAt) + 1).toISOString(),
      lease: {
        ...input.leasedOperation.lease,
        renewedAt: new Date(Date.parse(input.leasedOperation.createdAt) + 1).toISOString(),
        expiresAt: new Date(Date.parse(input.leasedOperation.lease.expiresAt) + 1).toISOString(),
      },
    });
    expectFailure(withOperation(input, badRenewal), 'invalid_audit');

    const badClaimOrder = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      ...input.leasedOperation,
      attempts: [
        { ...input.leasedOperation.attempts[0]!, disposition: 'in_progress' },
        AutomaticOperationAttemptSchema.parse({
          attemptHash: hashAt(19),
          at: input.leasedOperation.createdAt,
          disposition: 'claim_won',
        }),
      ],
    });
    expectFailure(withOperation(input, badClaimOrder), 'invalid_audit');

    const mismatchedReceipt = {
      ...input,
      terminalReceipt: { ...input.terminalReceipt, operationId: randomUUID() },
    };
    expectFailure(mismatchedReceipt, 'invalid_receipt');
    expectFailure(
      {
        ...input,
        terminalReceipt: cancelledReceiptFor(
          input.leasedOperation,
          input.terminalReceipt.terminalAt,
        ),
      },
      'invalid_receipt',
    );
    expectFailure({ ...input, audit: { ...input.audit, sourceId: randomUUID() } }, 'invalid_audit');
    expectFailure(
      { ...input, audit: { ...input.audit, operationId: randomUUID() } },
      'invalid_audit',
    );

    const duplicateAudits = {
      ...input,
      leasedOperation: {
        ...input.leasedOperation,
        attempts: [
          ...input.leasedOperation.attempts,
          {
            attemptHash: input.audit.attemptIdHash,
            at: input.leasedOperation.createdAt,
            disposition: 'in_progress',
          },
          {
            attemptHash: input.audit.attemptIdHash,
            at: input.leasedOperation.createdAt,
            disposition: 'in_progress',
          },
        ],
      },
    };
    expectFailure(duplicateAudits, 'invalid_audit');
  });

  it('returns frozen detached data without mutating the input', async () => {
    const { input } = await fixture();
    const before = structuredClone(input);
    const operation = buildCommittedAutonomousPersonalOperationV4(input, () => undefined);

    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.identity)).toBe(true);
    expect(Object.isFrozen(operation.terminalReceipt)).toBe(true);
    if (operation.terminalReceipt.kind !== 'cancelled') {
      expect(Object.isFrozen(operation.terminalReceipt.selection)).toBe(true);
    }
  });

  it('rejects hostile JavaScript without invoking getters or proxy traps', async () => {
    const { input } = await fixture();
    let getterCalled = false;
    const accessorInput = Object.defineProperty({ ...input }, 'completionCallHash', {
      enumerable: true,
      get() {
        getterCalled = true;
        return input.completionCallHash;
      },
    });
    expectFailure(accessorInput, 'invalid_input');
    expect(getterCalled).toBe(false);

    const observed: string[] = [];
    const proxied = new Proxy(input, {
      get() {
        observed.push('get');
        throw new Error('input proxy accessed');
      },
      ownKeys() {
        observed.push('ownKeys');
        throw new Error('input proxy accessed');
      },
    });
    expectFailure(proxied, 'invalid_input');
    expect(observed).toEqual([]);

    const nestedProxy = {
      ...input,
      audit: new Proxy(input.audit, {
        get() {
          observed.push('nested-get');
          throw new Error('nested proxy accessed');
        },
        ownKeys() {
          observed.push('nested-ownKeys');
          throw new Error('nested proxy accessed');
        },
      }),
    };
    expectFailure(nestedProxy, 'invalid_input');
    expect(observed).toEqual([]);
  });

  it('maps bounded JSON and ledger ceilings to fixed capacity without leaking input', async () => {
    const { input } = await fixture();
    expectFailure({ ...input, padding: 'private'.repeat(80 * 1024) }, 'capacity');
    expectFailure(
      {
        ...input,
        terminalReceipt: {
          ...input.terminalReceipt,
          padding: 'private'.repeat(AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes),
        },
      },
      'capacity',
    );
    expectFailure(
      {
        ...input,
        leasedOperation: {
          ...input.leasedOperation,
          padding: 'private'.repeat(AUTOMATIC_LEDGER_LIMITS.operationBytes),
        },
      },
      'capacity',
    );
    expectFailure({ leasedOperation: 'private operation' }, 'invalid_input');
  });

  it('preserves callback error identity through malformed-input catches and final freezing', async () => {
    const { input } = await fixture();
    const callbackFailure = new Error('private cancellation');
    const malformed = Object.defineProperty({ ...input }, 'completionCallHash', {
      enumerable: true,
      get() {
        throw new Error('getter should not run');
      },
    });
    let checks = 0;
    const caughtFromClone = (() => {
      try {
        buildCommittedAutonomousPersonalOperationV4(malformed, () => {
          checks += 1;
          if (checks === 2) throw callbackFailure;
        });
      } catch (error) {
        return error;
      }
      throw new Error('Expected callback failure');
    })();
    expect(caughtFromClone).toBe(callbackFailure);

    let dryChecks = 0;
    buildCommittedAutonomousPersonalOperationV4(input, () => {
      dryChecks += 1;
    });
    let finalChecks = 0;
    const caughtDuringFreeze = (() => {
      try {
        buildCommittedAutonomousPersonalOperationV4(input, () => {
          finalChecks += 1;
          if (finalChecks === dryChecks) throw callbackFailure;
        });
      } catch (error) {
        return error;
      }
      throw new Error('Expected final callback failure');
    })();
    expect(caughtDuringFreeze).toBe(callbackFailure);
    expect(finalChecks).toBe(dryChecks);
  });
});
