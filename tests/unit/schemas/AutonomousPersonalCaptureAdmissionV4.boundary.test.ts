import {
  AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema,
  AutonomousPersonalCaptureBeginV4ResultProjectionSchema,
  AutonomousPersonalCaptureFenceV4OwnedDataSchema,
  AutonomousPersonalCaptureFenceV4Schema,
} from '../../../src/schemas/AutonomousPersonalCaptureAdmissionV4.schema';
import {
  AutonomousPersonalReceiptV4OwnedDataSchema,
  AutonomousPersonalReceiptV4Schema,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';

const T0 = '2026-10-27T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const uuidAt = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const hashAt = (value: number) => value.toString(16).padStart(64, '0');

function fence() {
  return {
    version: 4,
    purpose: 'human_turn_memory',
    operationId: uuidAt(1),
    sourceId: uuidAt(2),
    descriptorHash: HASH,
    identityHash: hashAt(3),
    sourceHash: hashAt(4),
    envelopeHash: hashAt(5),
    beginCallHash: hashAt(6),
    state: 'leased',
    generation: 1,
    token: uuidAt(7),
    claimKind: 'initial',
    retryCount: 0,
    planTimestamp: T0,
  };
}

function commonReceiptFields() {
  return {
    version: 4,
    operationId: uuidAt(1),
    sourceId: uuidAt(2),
    sourceHash: hashAt(4),
    descriptorHash: hashAt(8),
    policyFingerprint: hashAt(9),
    terminalAt: T0,
  };
}

function occurrenceReceipt() {
  return {
    ...commonReceiptFields(),
    kind: 'human_autonomous_capture_committed',
    interpretationCoverage: 'complete',
    acceptedCoverage: 'all',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage: {
      status: 'complete',
      scanStatus: 'complete',
      sourceUnitCount: 1,
      candidateUnitCount: 1,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    },
    selection: {
      kind: 'occurrences',
      items: [
        {
          occurrenceIndex: 0,
          kind: 'typed_preference',
          evidenceHash: hashAt(100),
          meaningHash: hashAt(200),
          dependencies: [{ index: 0, dependencyHash: hashAt(300) }],
          state: 'accepted',
          effect: 'created',
          claimId: uuidAt(20),
          reason: 'eligible_create',
        },
      ],
    },
  };
}

function sourceVerdictReceipt() {
  return {
    ...commonReceiptFields(),
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
  };
}

function deferredReceipt() {
  return {
    ...commonReceiptFields(),
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
  };
}

function cancelledReceipt() {
  return {
    ...commonReceiptFields(),
    kind: 'cancelled',
    acceptedCoverage: 'none',
  };
}

function projection(kind: string, terminalReceipt: unknown) {
  return { kind, terminalReceipt, eligibleFirstCommit: false };
}

function expectFixedResultError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const zodError = error as {
    issues?: Array<{ message?: string; path?: unknown[] }>;
  };
  expect(zodError.issues).toHaveLength(1);
  expect(zodError.issues?.[0]).toMatchObject({
    message: 'invalid_autonomous_capture_begin_v4_result_data',
    path: [],
  });
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(zodError.issues)).toBe(true);
  expect(Object.isFrozen(zodError.issues?.[0])).toBe(true);
  expect(Object.isFrozen(zodError.issues?.[0]?.path)).toBe(true);
}

function expectFixedReceiptError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const zodError = error as {
    issues?: Array<{ message?: string; path?: unknown[] }>;
  };
  expect(zodError.issues).toHaveLength(1);
  expect(zodError.issues?.[0]).toMatchObject({
    message: 'invalid_autonomous_receipt_data',
    path: [],
  });
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(zodError.issues)).toBe(true);
  expect(Object.isFrozen(zodError.issues?.[0])).toBe(true);
  expect(Object.isFrozen(zodError.issues?.[0]?.path)).toBe(true);
}

describe('AutonomousPersonalCaptureAdmissionV4 ownership boundaries', () => {
  it('owns raw fence and result values before invoking their strict Zod schemas', () => {
    const fenceParse = jest.spyOn(AutonomousPersonalCaptureFenceV4OwnedDataSchema, 'parse');
    const resultParse = jest.spyOn(
      AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema,
      'parse',
    );

    try {
      const accessor = Object.defineProperty({}, 'version', {
        enumerable: true,
        get() {
          throw new Error('accessor must not run');
        },
      });
      const proxy = new Proxy(
        {},
        {
          get() {
            throw new Error('proxy property read must not run');
          },
          ownKeys() {
            throw new Error('proxy key enumeration must not run');
          },
        },
      );

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      let deepFence: unknown = fence();
      for (let index = 0; index < 18; index += 1) deepFence = { child: deepFence };
      let deepResult: unknown = { kind: 'invalid_input', eligibleFirstCommit: false };
      for (let index = 0; index < 34; index += 1) deepResult = { child: deepResult };

      const fenceInputs: unknown[] = [
        accessor,
        proxy,
        cyclic,
        deepFence,
        { ...fence(), extra: Array.from({ length: 1024 }, () => 0) },
        { ...fence(), extra: 'x'.repeat(17 * 1024) },
      ];
      for (const input of fenceInputs) {
        expect(AutonomousPersonalCaptureFenceV4Schema.safeParse(input).success).toBe(false);
      }

      const resultInputs: unknown[] = [
        accessor,
        proxy,
        cyclic,
        deepResult,
        {
          kind: 'invalid_input',
          eligibleFirstCommit: false,
          extra: Array.from({ length: 16_384 }, () => 0),
        },
        { kind: 'invalid_input', eligibleFirstCommit: false, extra: 'x'.repeat(33 * 1024) },
      ];
      for (const input of resultInputs) {
        expect(
          AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(input).success,
        ).toBe(false);
      }

      expect(fenceParse).not.toHaveBeenCalled();
      expect(resultParse).not.toHaveBeenCalled();
    } finally {
      fenceParse.mockRestore();
      resultParse.mockRestore();
    }
  });

  it('accepts each receipt family only on its corresponding observed-result branch', () => {
    const committedReceipts = [occurrenceReceipt(), sourceVerdictReceipt(), deferredReceipt()];
    for (const terminalReceipt of committedReceipts) {
      expect(AutonomousPersonalReceiptV4Schema.safeParse(terminalReceipt).success).toBe(true);
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(
          projection('committed_observed', terminalReceipt),
        ).success,
      ).toBe(true);
      expect(
        AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(
          projection('cancelled_observed', terminalReceipt),
        ).success,
      ).toBe(false);
    }

    const cancelled = cancelledReceipt();
    expect(AutonomousPersonalReceiptV4Schema.safeParse(cancelled).success).toBe(true);
    expect(
      AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(
        projection('cancelled_observed', cancelled),
      ).success,
    ).toBe(true);
    expect(
      AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(
        projection('committed_observed', cancelled),
      ).success,
    ).toBe(false);
  });

  it('rejects failure codes from the other operation state and requires the exact code field', () => {
    for (const input of [
      { kind: 'failed', failureCode: 'invocation_interrupted', eligibleFirstCommit: false },
      { kind: 'interrupted', failureCode: 'graph_conflict', eligibleFirstCommit: false },
      { kind: 'failed', eligibleFirstCommit: false },
      { kind: 'interrupted', eligibleFirstCommit: false },
    ]) {
      const result = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) expectFixedResultError(result.error);
    }
  });

  it('checks the standalone receipt cap before Zod and rejects an oversized nested receipt', () => {
    const receiptParse = jest.spyOn(AutonomousPersonalReceiptV4OwnedDataSchema, 'parse');
    try {
      const oversized = {
        ...deferredReceipt(),
        diagnostic: 'x'.repeat(17 * 1024),
      };
      expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeLessThan(32 * 1024);

      const standalone = AutonomousPersonalReceiptV4Schema.safeParse(oversized);
      expect(standalone.success).toBe(false);
      if (!standalone.success) expectFixedReceiptError(standalone.error);
      expect(receiptParse).not.toHaveBeenCalled();

      const nested = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.safeParse(
        projection('committed_observed', oversized),
      );
      expect(nested.success).toBe(false);
      if (!nested.success) expectFixedResultError(nested.error);
    } finally {
      receiptParse.mockRestore();
    }
  });

  it('detaches and deeply freezes nested receipt data', () => {
    const input = projection('committed_observed', occurrenceReceipt());
    const parsed = AutonomousPersonalCaptureBeginV4ResultProjectionSchema.parse(input);
    if (parsed.kind !== 'committed_observed') throw new Error('Expected committed observation');
    const parsedReceipt = parsed.terminalReceipt;
    expect(parsed).not.toBe(input);
    expect(parsedReceipt).not.toBe(input.terminalReceipt);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsedReceipt)).toBe(true);
    if (parsedReceipt.kind !== 'human_autonomous_capture_committed') {
      throw new Error('Expected occurrence receipt');
    }
    expect(Object.isFrozen(parsedReceipt.selection)).toBe(true);
    expect(Object.isFrozen(parsedReceipt.selection.items)).toBe(true);
    expect(Object.isFrozen(parsedReceipt.selection.items[0])).toBe(true);
    expect(Object.isFrozen(parsedReceipt.selection.items[0]?.dependencies)).toBe(true);

    const original = parsedReceipt.selection.items[0]?.claimId;
    const inputReceipt = input.terminalReceipt as ReturnType<typeof occurrenceReceipt>;
    inputReceipt.selection.items[0]!.claimId = uuidAt(99);
    expect(parsedReceipt.selection.items[0]?.claimId).toBe(original);
  });
});
