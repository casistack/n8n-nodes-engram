import {
  AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema,
  AutonomousPersonalCaptureBeginV4ResultProjectionSchema,
  AutonomousPersonalCaptureFenceV4OwnedDataSchema,
  AutonomousPersonalCaptureFenceV4Schema,
} from '../../../src/schemas/AutonomousPersonalCaptureAdmissionV4.schema';
import {
  AutonomousPersonalOperationV4FailedFailureCodeSchema,
  AutonomousPersonalOperationV4InterruptedFailureCodeSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';

const T0 = '2026-10-27T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const uuidAt = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const hashAt = (value: number) => value.toString(16).padStart(64, '0');

function fence() {
  return {
    version: 4 as const,
    purpose: 'human_turn_memory' as const,
    operationId: uuidAt(1),
    sourceId: uuidAt(2),
    descriptorHash: HASH,
    identityHash: hashAt(3),
    sourceHash: hashAt(4),
    envelopeHash: hashAt(5),
    beginCallHash: hashAt(6),
    state: 'leased' as const,
    generation: 1 as const,
    token: uuidAt(7),
    claimKind: 'initial' as const,
    retryCount: 0 as const,
    planTimestamp: T0,
  };
}

function claimedProjection() {
  return {
    kind: 'claimed' as const,
    purpose: 'human_turn_memory' as const,
    sourceId: uuidAt(2),
    operationId: uuidAt(1),
    descriptorHash: HASH,
    sourcePersistence: 'persisted' as const,
    claimKind: 'initial' as const,
    eligibleFirstCommit: false as const,
  };
}

function commonReceiptFields() {
  return {
    version: 4 as const,
    operationId: uuidAt(1),
    sourceId: uuidAt(2),
    sourceHash: hashAt(4),
    descriptorHash: hashAt(8),
    policyFingerprint: hashAt(9),
    terminalAt: T0,
  };
}

function committedReceipt() {
  return {
    ...commonReceiptFields(),
    kind: 'human_autonomous_source_verdict_committed' as const,
    interpretationCoverage: 'complete' as const,
    acceptedCoverage: 'none' as const,
    acceptanceSemantics: 'per_item_kind_v1' as const,
    sourceCoverage: {
      status: 'complete' as const,
      scanStatus: 'complete' as const,
      sourceUnitCount: 0,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    },
    selection: { kind: 'source_verdict' as const, outcome: 'known_no_memory' as const },
  };
}

function cancelledReceipt() {
  return {
    ...commonReceiptFields(),
    kind: 'cancelled' as const,
    acceptedCoverage: 'none' as const,
  };
}

function maximumShapedOccurrenceReceipt() {
  return {
    ...commonReceiptFields(),
    kind: 'human_autonomous_capture_committed' as const,
    interpretationCoverage: 'complete' as const,
    acceptedCoverage: 'all' as const,
    acceptanceSemantics: 'per_item_kind_v1' as const,
    sourceCoverage: {
      status: 'complete' as const,
      scanStatus: 'complete' as const,
      sourceUnitCount: 32,
      candidateUnitCount: 32,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    },
    selection: {
      kind: 'occurrences' as const,
      items: Array.from({ length: 32 }, (_, index) => ({
        occurrenceIndex: index,
        kind: 'source_statement_record' as const,
        evidenceHash: hashAt(100 + index),
        meaningHash: hashAt(200 + index),
        dependencies: [{ index: 0, dependencyHash: hashAt(300 + index) }],
        state: 'accepted' as const,
        effect: 'created' as const,
        claimId: uuidAt(400 + index),
        reason: 'eligible_create' as const,
      })),
    },
  };
}

function expectFixedError(error: unknown, expectedCode: string) {
  expect(error).toBeInstanceOf(Error);
  const zodError = error as {
    issues?: Array<{ message?: string; path?: unknown[] }>;
  };
  expect(zodError.issues).toHaveLength(1);
  expect(zodError.issues?.[0]).toMatchObject({ message: expectedCode, path: [] });
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(zodError.issues)).toBe(true);
  expect(Object.isFrozen(zodError.issues?.[0])).toBe(true);
  expect(Object.isFrozen(zodError.issues?.[0]?.path)).toBe(true);
}

describe('AutonomousPersonalCaptureAdmissionV4 schemas', () => {
  describe('fence DATA', () => {
    it('accepts only a frozen generation-one initial lease fence', () => {
      const input = fence();
      const parsed = AutonomousPersonalCaptureFenceV4Schema.parse(input);

      expect(parsed).toEqual(input);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(input)).toBe(false);
      input.sourceId = uuidAt(20);
      expect(parsed.sourceId).toBe(uuidAt(2));
      expect(AutonomousPersonalCaptureFenceV4OwnedDataSchema.safeParse(parsed).success).toBe(true);
    });

    it.each([
      ['offset timestamp', { planTimestamp: '2026-10-27T12:00:00.000+00:00' }],
      ['non-millisecond timestamp', { planTimestamp: '2026-10-27T12:00:00Z' }],
      ['invalid calendar timestamp', { planTimestamp: '2026-02-30T12:00:00.000Z' }],
      ['wrong generation', { generation: 2 }],
      ['wrong retry count', { retryCount: 1 }],
      ['resume claim', { claimKind: 'resume' }],
      ['wrong state', { state: 'captured' }],
      ['last retry hash', { lastRetryCallHash: HASH }],
      ['extra handle', { handle: {} }],
    ])('rejects %s', (_label, mutation) => {
      expect(
        AutonomousPersonalCaptureFenceV4Schema.safeParse({ ...fence(), ...mutation }).success,
      ).toBe(false);
    });

    it('returns the same fixed redacted error from parse and safeParse', () => {
      try {
        AutonomousPersonalCaptureFenceV4Schema.parse({ secret: 'do not expose' });
        throw new Error('expected parse to reject');
      } catch (error) {
        expectFixedError(error, 'invalid_autonomous_capture_fence_v4_data');
      }

      const result = AutonomousPersonalCaptureFenceV4Schema.safeParse({ secret: 'do not expose' });
      expect(result.success).toBe(false);
      if (!result.success)
        expectFixedError(result.error, 'invalid_autonomous_capture_fence_v4_data');
    });
  });

  describe('result projection DATA', () => {
    it('accepts a handle-free claimed data projection without implying permission', () => {
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema.safeParse(
          claimedProjection(),
        ).success,
      ).toBe(true);
      const parsed =
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.parse(claimedProjection());
      expect(parsed).toEqual(claimedProjection());
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(parsed.kind).toBe('claimed');
      expect(parsed.eligibleFirstCommit).toBe(false);
    });

    it('rejects any handle, capability, or authority field on the claimed projection', () => {
      for (const key of ['handle', 'leaseHandle', 'capability', 'token', 'authority', 'fence']) {
        const input = { ...claimedProjection(), [key]: {} };
        expect(
          AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema.safeParse(input).success,
        ).toBe(false);
        expect(
          AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(input).success,
        ).toBe(false);
      }
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
          ...claimedProjection(),
          eligibleFirstCommit: true,
        }).success,
      ).toBe(false);
    });

    it('requires committed and cancelled observations to carry the matching actual receipt kind', () => {
      const committed = {
        kind: 'committed_observed' as const,
        terminalReceipt: committedReceipt(),
        eligibleFirstCommit: false as const,
      };
      const cancelled = {
        kind: 'cancelled_observed' as const,
        terminalReceipt: cancelledReceipt(),
        eligibleFirstCommit: false as const,
      };

      expect(
        AutonomousPersonalReceiptV4OwnedDataSchema.safeParse(committed.terminalReceipt).success,
      ).toBe(true);
      expect(
        AutonomousPersonalReceiptV4OwnedDataSchema.safeParse(cancelled.terminalReceipt).success,
      ).toBe(true);
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(committed).success,
      ).toBe(true);
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(cancelled).success,
      ).toBe(true);
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
          ...committed,
          terminalReceipt: cancelledReceipt(),
        }).success,
      ).toBe(false);
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
          ...cancelled,
          terminalReceipt: committedReceipt(),
        }).success,
      ).toBe(false);
    });

    it('reuses the exact existing Operation4 failure-code enums', () => {
      const failedCodes = [
        'graph_conflict',
        'invalid_plan',
        'storage_error',
        'budget_exhausted',
        'capacity',
        'unknown',
      ] as const;
      const interruptedCodes = [
        'invocation_interrupted',
        'lease_expired',
        'storage_error',
        'unknown',
      ] as const;

      for (const failureCode of failedCodes) {
        expect(AutonomousPersonalOperationV4FailedFailureCodeSchema.parse(failureCode)).toBe(
          failureCode,
        );
        expect(
          AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
            kind: 'failed',
            failureCode,
            eligibleFirstCommit: false,
          }).success,
        ).toBe(true);
      }
      for (const failureCode of interruptedCodes) {
        expect(AutonomousPersonalOperationV4InterruptedFailureCodeSchema.parse(failureCode)).toBe(
          failureCode,
        );
        expect(
          AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
            kind: 'interrupted',
            failureCode,
            eligibleFirstCommit: false,
          }).success,
        ).toBe(true);
      }
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
          kind: 'failed',
          failureCode: 'unexpected',
          eligibleFirstCommit: false,
        }).success,
      ).toBe(false);
    });

    it('keeps every other false outcome to kind and false eligibility only', () => {
      const kinds = [
        'in_progress',
        'resume_available',
        'source_only_unconfirmed',
        'unsupported_mode',
        'invalid_handle',
        'invalid_input',
        'conflict',
        'authority_changed',
        'budget_exhausted',
        'resource_exhausted',
        'capacity',
        'clock_regression',
        'acknowledgement_unknown',
        'storage_error',
      ] as const;

      for (const kind of kinds) {
        expect(
          AutonomousPersonalCaptureBeginV4ResultProjectionSchema.parse({
            kind,
            eligibleFirstCommit: false,
          }),
        ).toEqual({ kind, eligibleFirstCommit: false });
        expect(
          AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
            kind,
            eligibleFirstCommit: false,
            operationId: uuidAt(1),
          }).success,
        ).toBe(false);
      }
    });

    it('distinguishes a known storage failure from a persisted failed operation', () => {
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.parse({
          kind: 'storage_error',
          eligibleFirstCommit: false,
        }),
      ).toEqual({ kind: 'storage_error', eligibleFirstCommit: false });
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.parse({
          kind: 'failed',
          failureCode: 'storage_error',
          eligibleFirstCommit: false,
        }),
      ).toEqual({ kind: 'failed', failureCode: 'storage_error', eligibleFirstCommit: false });
      for (const fields of [
        { failureCode: 'storage_error' },
        { handle: {} },
        { sourceId: uuidAt(2) },
      ]) {
        const result = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
          kind: 'storage_error',
          eligibleFirstCommit: false,
          ...fields,
        });
        expect(result.success).toBe(false);
        if (!result.success)
          expectFixedError(result.error, 'invalid_autonomous_capture_begin_v4_result_data');
      }
    });

    it('accepts a maximum-shaped legal receipt within the aggregate result cap', () => {
      const receipt = maximumShapedOccurrenceReceipt();
      expect(AutonomousPersonalReceiptV4OwnedDataSchema.safeParse(receipt).success).toBe(true);
      const input = {
        kind: 'committed_observed' as const,
        terminalReceipt: receipt,
        eligibleFirstCommit: false as const,
      };
      const parsed = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.parse(input);
      expect(parsed).toEqual(input);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen((parsed as typeof input).terminalReceipt.selection)).toBe(true);
    });

    it('rejects over-cap aggregate data with a fixed error before accepting a branch', () => {
      const result = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
        ...claimedProjection(),
        extra: 'x'.repeat(33 * 1024),
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expectFixedError(result.error, 'invalid_autonomous_capture_begin_v4_result_data');
    });

    it('returns fixed redacted errors for strict-shape failures', () => {
      const result = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
        ...claimedProjection(),
        handle: { secret: 'do not expose' },
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expectFixedError(result.error, 'invalid_autonomous_capture_begin_v4_result_data');
    });
  });

  describe('raw ownership boundaries', () => {
    it('rejects accessors without invoking them', () => {
      let getterCalls = 0;
      const accessor = Object.defineProperty({}, 'version', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 4;
        },
      });

      const fenceResult = AutonomousPersonalCaptureFenceV4Schema.safeParse(accessor);
      expect(fenceResult.success).toBe(false);
      if (!fenceResult.success)
        expectFixedError(fenceResult.error, 'invalid_autonomous_capture_fence_v4_data');
      expect(getterCalls).toBe(0);

      const resultResult =
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(accessor);
      expect(resultResult.success).toBe(false);
      if (!resultResult.success)
        expectFixedError(resultResult.error, 'invalid_autonomous_capture_begin_v4_result_data');
      expect(getterCalls).toBe(0);
    });

    it('rejects proxy inputs without reading properties', () => {
      let propertyReads = 0;
      const proxied = new Proxy(
        {},
        {
          get() {
            propertyReads += 1;
            throw new Error('unexpected property read');
          },
          ownKeys() {
            propertyReads += 1;
            throw new Error('unexpected key enumeration');
          },
        },
      );

      expect(AutonomousPersonalCaptureFenceV4Schema.safeParse(proxied).success).toBe(false);
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(proxied).success,
      ).toBe(false);
      expect(propertyReads).toBe(0);
    });

    it('rejects cycles, excessive depth, node count, and bytes with fixed errors', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const fenceCycle = AutonomousPersonalCaptureFenceV4Schema.safeParse(cyclic);
      expect(fenceCycle.success).toBe(false);
      if (!fenceCycle.success)
        expectFixedError(fenceCycle.error, 'invalid_autonomous_capture_fence_v4_data');

      let deep: unknown = fence();
      for (let index = 0; index < 18; index += 1) deep = { child: deep };
      const depthResult = AutonomousPersonalCaptureFenceV4Schema.safeParse(deep);
      expect(depthResult.success).toBe(false);

      const nodeResult = AutonomousPersonalCaptureFenceV4Schema.safeParse({
        ...fence(),
        extra: Array.from({ length: 1024 }, () => 0),
      });
      expect(nodeResult.success).toBe(false);

      const byteResult = AutonomousPersonalCaptureFenceV4Schema.safeParse({
        ...fence(),
        extra: 'x'.repeat(17 * 1024),
      });
      expect(byteResult.success).toBe(false);

      const resultNodeLimit = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
        ...claimedProjection(),
        extra: Array.from({ length: 16_384 }, () => 0),
      });
      expect(resultNodeLimit.success).toBe(false);

      const resultByteLimit = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse({
        ...claimedProjection(),
        extra: 'x'.repeat(513 * 1024),
      });
      expect(resultByteLimit.success).toBe(false);
    });
  });
});
