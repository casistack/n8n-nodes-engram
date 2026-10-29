import {
  AutonomousPersonalReceiptV4OwnedDataSchema,
  type AutonomousPersonalReceiptV4,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import { AutonomousPersonalCaptureReceiptSummaryV4Schema } from '../../../src/schemas/AutonomousPersonalCaptureReceiptSummaryV4.schema';
import { projectAutonomousPersonalCaptureReceiptSummaryV4 } from '../../../src/memory/AutonomousPersonalCaptureReceiptSummaryV4';
import { AUTOMATIC_CAPTURE_JSON_BOUNDS } from '../../../src/storage/BoundedAutomaticCaptureJson';

const uuidAt = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const hashAt = (value: number) => value.toString(16).padStart(64, '0');
const TERMINAL_AT = '2026-10-27T12:00:00.000Z';

function commonReceiptFields() {
  return {
    version: 4,
    operationId: uuidAt(1),
    sourceId: uuidAt(2),
    sourceHash: hashAt(3),
    descriptorHash: hashAt(4),
    policyFingerprint: hashAt(5),
    terminalAt: TERMINAL_AT,
  };
}

function occurrenceItems() {
  return [
    {
      occurrenceIndex: 0,
      kind: 'source_statement_record',
      evidenceHash: hashAt(10),
      meaningHash: hashAt(20),
      dependencies: [{ index: 0, dependencyHash: hashAt(30) }],
      state: 'accepted',
      effect: 'created',
      claimId: uuidAt(10),
      reason: 'eligible_create',
    },
    {
      occurrenceIndex: 1,
      kind: 'source_statement_record',
      evidenceHash: hashAt(11),
      meaningHash: hashAt(20),
      dependencies: [{ index: 0, dependencyHash: hashAt(30) }],
      state: 'accepted',
      effect: 'reference',
      claimId: uuidAt(10),
      reason: 'existing_accepted',
    },
    {
      occurrenceIndex: 2,
      kind: 'typed_preference',
      evidenceHash: hashAt(12),
      meaningHash: hashAt(22),
      dependencies: [{ index: 0, dependencyHash: hashAt(32) }],
      state: 'proposed',
      effect: 'reference',
      claimId: uuidAt(11),
      reason: 'existing_proposed',
    },
    {
      occurrenceIndex: 3,
      kind: 'typed_preference',
      evidenceHash: hashAt(13),
      meaningHash: hashAt(23),
      dependencies: [{ index: 0, dependencyHash: hashAt(33) }],
      state: 'rejected',
      effect: 'reference',
      claimId: uuidAt(12),
      reason: 'existing_rejected',
    },
    {
      occurrenceIndex: 4,
      kind: 'typed_preference',
      evidenceHash: hashAt(14),
      meaningHash: hashAt(24),
      dependencies: [{ index: 0, dependencyHash: hashAt(34) }],
      state: 'not_selected',
      effect: 'none',
      claimId: null,
      reason: 'possible_overlap',
    },
  ] as const;
}

function receipt(
  value:
    | Record<string, unknown>
    | ((fields: ReturnType<typeof commonReceiptFields>) => Record<string, unknown>),
): AutonomousPersonalReceiptV4 {
  const fields = commonReceiptFields();
  return AutonomousPersonalReceiptV4OwnedDataSchema.parse(
    typeof value === 'function' ? value(fields) : { ...fields, ...value },
  );
}

function occurrenceReceipt(): AutonomousPersonalReceiptV4 {
  const items = occurrenceItems();
  return receipt((fields) => ({
    ...fields,
    kind: 'human_autonomous_capture_committed',
    interpretationCoverage: 'complete',
    acceptedCoverage: 'partial',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage: {
      status: 'complete',
      scanStatus: 'complete',
      sourceUnitCount: 6,
      candidateUnitCount: 5,
      neutralUnitCount: 0,
      withheldUnitCount: 1,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    },
    selection: { kind: 'occurrences', items },
  }));
}

function verdictReceipt(): AutonomousPersonalReceiptV4 {
  return receipt((fields) => ({
    ...fields,
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
  }));
}

function deferredReceipt(): AutonomousPersonalReceiptV4 {
  return receipt((fields) => ({
    ...fields,
    kind: 'human_autonomous_source_deferred_committed',
    interpretationCoverage: 'unknown',
    acceptedCoverage: 'none',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage: {
      status: 'unknown',
      scanStatus: 'complete',
      sourceUnitCount: 2,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 2,
      unresolvedReason: 'provider_failure',
    },
    selection: { kind: 'source_only_deferred', reason: 'provider_invalid_response' },
  }));
}

function cancelledReceipt(): AutonomousPersonalReceiptV4 {
  return receipt((fields) => ({ ...fields, kind: 'cancelled', acceptedCoverage: 'none' }));
}

describe('AutonomousPersonalCaptureReceiptSummaryV4', () => {
  it('projects minimal occurrence DATA and counts duplicate, proposed and rejected claim references once', () => {
    const input = occurrenceReceipt();
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(input, () => {});

    expect(summary).toEqual({
      version: 4,
      kind: 'committed',
      sourceId: uuidAt(2),
      terminalAt: TERMINAL_AT,
      acceptanceSemantics: 'per_item_kind_v1',
      acceptedCoverage: 'partial',
      interpretationCoverage: 'complete',
      sourceCoverage:
        input.kind === 'human_autonomous_capture_committed' ? input.sourceCoverage : null,
      selection: {
        kind: 'occurrences',
        items: [
          {
            occurrenceIndex: 0,
            kind: 'source_statement_record',
            state: 'accepted',
            effect: 'created',
            claimId: uuidAt(10),
            reason: 'eligible_create',
          },
          {
            occurrenceIndex: 1,
            kind: 'source_statement_record',
            state: 'accepted',
            effect: 'reference',
            claimId: uuidAt(10),
            reason: 'existing_accepted',
          },
          {
            occurrenceIndex: 2,
            kind: 'typed_preference',
            state: 'proposed',
            effect: 'reference',
            claimId: uuidAt(11),
            reason: 'existing_proposed',
          },
          {
            occurrenceIndex: 3,
            kind: 'typed_preference',
            state: 'rejected',
            effect: 'reference',
            claimId: uuidAt(12),
            reason: 'existing_rejected',
          },
          {
            occurrenceIndex: 4,
            kind: 'typed_preference',
            state: 'not_selected',
            effect: 'none',
            claimId: null,
            reason: 'possible_overlap',
          },
        ],
      },
      counts: {
        occurrenceCount: 5,
        byState: { accepted: 2, proposed: 1, rejected: 1, not_selected: 1 },
        createdOccurrenceCount: 1,
        referenceOccurrenceCount: 3,
        distinctPersistedClaimCount: 3,
      },
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /evidenceHash|meaningHash|dependencies|sourceHash|descriptorHash/,
    );
    expect(Buffer.byteLength(JSON.stringify(summary), 'utf8')).toBeLessThanOrEqual(
      AUTOMATIC_CAPTURE_JSON_BOUNDS.policyData.maxBytes,
    );
    expect(Object.isFrozen(summary)).toBe(true);
    if (summary.kind === 'committed' && summary.selection.kind === 'occurrences') {
      expect(Object.isFrozen(summary.selection)).toBe(true);
      expect(Object.isFrozen(summary.selection.items)).toBe(true);
      expect(Object.isFrozen(summary.selection.items[0])).toBe(true);
    }
  });

  it('projects a source verdict with exact outcome and zero occurrence counts', () => {
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(verdictReceipt(), () => {});
    expect(summary).toMatchObject({
      version: 4,
      kind: 'committed',
      acceptedCoverage: 'none',
      selection: { kind: 'source_verdict', outcome: 'known_no_memory' },
      counts: {
        occurrenceCount: 0,
        byState: { accepted: 0, proposed: 0, rejected: 0, not_selected: 0 },
        createdOccurrenceCount: 0,
        referenceOccurrenceCount: 0,
        distinctPersistedClaimCount: 0,
      },
    });
    expect(summary).not.toHaveProperty('occurrences');
  });

  it('projects deferred status and fixed reason with zero occurrence counts', () => {
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(deferredReceipt(), () => {});
    expect(summary).toMatchObject({
      kind: 'committed',
      interpretationCoverage: 'unknown',
      acceptedCoverage: 'none',
      selection: { kind: 'source_only_deferred', reason: 'provider_invalid_response' },
      counts: { occurrenceCount: 0, createdOccurrenceCount: 0, referenceOccurrenceCount: 0 },
    });
  });

  it('preserves partial interpretation coverage and its fixed unresolved reason', () => {
    const value = receipt((fields) => ({
      ...fields,
      kind: 'human_autonomous_capture_committed',
      interpretationCoverage: 'partial',
      acceptedCoverage: 'partial',
      acceptanceSemantics: 'per_item_kind_v1',
      sourceCoverage: {
        status: 'partial',
        scanStatus: 'complete',
        sourceUnitCount: 6,
        candidateUnitCount: 5,
        neutralUnitCount: 0,
        withheldUnitCount: 0,
        unresolvedUnitCount: 1,
        unresolvedReason: 'ambiguous_scope',
      },
      selection: { kind: 'occurrences', items: occurrenceItems() },
    }));
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(value, () => {});
    expect(summary).toMatchObject({
      kind: 'committed',
      interpretationCoverage: 'partial',
      sourceCoverage: { status: 'partial', unresolvedReason: 'ambiguous_scope' },
    });
  });

  it('keeps cancellation separate from all committed-only fields', () => {
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(cancelledReceipt(), () => {});
    expect(summary).toEqual({
      version: 4,
      kind: 'cancelled',
      sourceId: uuidAt(2),
      terminalAt: TERMINAL_AT,
      counts: {
        occurrenceCount: 0,
        byState: { accepted: 0, proposed: 0, rejected: 0, not_selected: 0 },
        createdOccurrenceCount: 0,
        referenceOccurrenceCount: 0,
        distinctPersistedClaimCount: 0,
      },
    });
    expect(summary).not.toHaveProperty('selection');
    expect(summary).not.toHaveProperty('sourceCoverage');
    expect(summary).not.toHaveProperty('acceptanceSemantics');
  });

  it('rejects inconsistent counters and extra or raw receipt fields in summary DATA', () => {
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(occurrenceReceipt(), () => {});
    expect(
      AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse({
        ...summary,
        counts: { ...summary.counts, distinctPersistedClaimCount: 4 },
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse({
        ...summary,
        secret: 'not allowed',
      }).success,
    ).toBe(false);
    if (summary.kind === 'committed' && summary.selection.kind === 'occurrences') {
      expect(
        AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse({
          ...summary,
          selection: {
            ...summary.selection,
            items: [{ ...summary.selection.items[0], evidenceHash: hashAt(99) }],
          },
        }).success,
      ).toBe(false);
    }
  });

  it('applies Receipt4 occurrence state/effect/claim/reason semantics to standalone summary items', () => {
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(occurrenceReceipt(), () => {});
    if (summary.kind !== 'committed' || summary.selection.kind !== 'occurrences') {
      throw new Error('Expected occurrence summary');
    }

    const acceptedWithoutEffect = structuredClone(summary);
    if (
      acceptedWithoutEffect.kind !== 'committed' ||
      acceptedWithoutEffect.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected cloned occurrence summary');
    }
    acceptedWithoutEffect.selection.items[0] = {
      ...acceptedWithoutEffect.selection.items[0]!,
      effect: 'none',
      claimId: null,
      reason: 'possible_overlap',
    };
    acceptedWithoutEffect.counts.createdOccurrenceCount = 0;
    expect(
      AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse(acceptedWithoutEffect).success,
    ).toBe(false);

    const referenceWithoutClaim = structuredClone(summary);
    if (
      referenceWithoutClaim.kind !== 'committed' ||
      referenceWithoutClaim.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected cloned occurrence summary');
    }
    referenceWithoutClaim.selection.items[2] = {
      ...referenceWithoutClaim.selection.items[2]!,
      claimId: null,
    };
    referenceWithoutClaim.counts.distinctPersistedClaimCount = 2;
    expect(
      AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse(referenceWithoutClaim).success,
    ).toBe(false);

    const invalidNotSelectedReason = structuredClone(summary);
    if (
      invalidNotSelectedReason.kind !== 'committed' ||
      invalidNotSelectedReason.selection.kind !== 'occurrences'
    ) {
      throw new Error('Expected cloned occurrence summary');
    }
    invalidNotSelectedReason.selection.items[4] = {
      ...invalidNotSelectedReason.selection.items[4]!,
      reason: 'existing_accepted',
    };
    expect(
      AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse(invalidNotSelectedReason).success,
    ).toBe(false);
  });

  it('applies the complete source-verdict and deferred coverage joins to standalone summaries', () => {
    const verdict = projectAutonomousPersonalCaptureReceiptSummaryV4(verdictReceipt(), () => {});
    if (verdict.kind !== 'committed' || verdict.selection.kind !== 'source_verdict') {
      throw new Error('Expected source-verdict summary');
    }
    expect(
      AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse({
        ...verdict,
        selection: { ...verdict.selection, outcome: 'unsupported_source' },
      }).success,
    ).toBe(false);

    const deferred = projectAutonomousPersonalCaptureReceiptSummaryV4(deferredReceipt(), () => {});
    if (deferred.kind !== 'committed' || deferred.selection.kind !== 'source_only_deferred') {
      throw new Error('Expected deferred summary');
    }
    expect(
      AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse({
        ...deferred,
        selection: { ...deferred.selection, reason: 'interpretation_capacity' },
      }).success,
    ).toBe(false);
  });

  it('accepts every valid summary branch projected from a validated Receipt4', () => {
    for (const input of [
      occurrenceReceipt(),
      verdictReceipt(),
      deferredReceipt(),
      cancelledReceipt(),
    ]) {
      const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(input, () => {});
      expect(AutonomousPersonalCaptureReceiptSummaryV4Schema.safeParse(summary).success).toBe(true);
    }
  });

  it('keeps the original Receipt4 cross-field rejection semantics', () => {
    const occurrence = occurrenceReceipt();
    if (occurrence.kind !== 'human_autonomous_capture_committed') {
      throw new Error('Expected occurrence Receipt4');
    }
    const impossibleOccurrence = structuredClone(occurrence);
    impossibleOccurrence.selection.items[0] = {
      ...impossibleOccurrence.selection.items[0]!,
      effect: 'none',
      claimId: null,
      reason: 'possible_overlap',
    };
    expect(AutonomousPersonalReceiptV4OwnedDataSchema.safeParse(impossibleOccurrence).success).toBe(
      false,
    );

    const verdict = verdictReceipt();
    if (verdict.kind !== 'human_autonomous_source_verdict_committed') {
      throw new Error('Expected source-verdict Receipt4');
    }
    expect(
      AutonomousPersonalReceiptV4OwnedDataSchema.safeParse({
        ...verdict,
        selection: { ...verdict.selection, outcome: 'unsupported_source' },
      }).success,
    ).toBe(false);

    const deferred = deferredReceipt();
    if (deferred.kind !== 'human_autonomous_source_deferred_committed') {
      throw new Error('Expected deferred Receipt4');
    }
    expect(
      AutonomousPersonalReceiptV4OwnedDataSchema.safeParse({
        ...deferred,
        selection: { ...deferred.selection, reason: 'interpretation_capacity' },
      }).success,
    ).toBe(false);
  });

  it('bounds and rejects malformed, accessor-backed and proxied receipt input', () => {
    let getterRead = false;
    const getterReceipt = Object.defineProperty({}, 'version', {
      enumerable: true,
      get() {
        getterRead = true;
        return 4;
      },
    });
    expect(() =>
      projectAutonomousPersonalCaptureReceiptSummaryV4(getterReceipt, () => {}),
    ).toThrow();
    expect(getterRead).toBe(false);

    let proxyTrapRan = false;
    const proxied = new Proxy(occurrenceReceipt(), {
      getOwnPropertyDescriptor() {
        proxyTrapRan = true;
        throw new Error('untrusted proxy trap');
      },
    });
    expect(() => projectAutonomousPersonalCaptureReceiptSummaryV4(proxied, () => {})).toThrow();
    expect(proxyTrapRan).toBe(false);

    expect(() =>
      projectAutonomousPersonalCaptureReceiptSummaryV4(
        { ...verdictReceipt(), version: 3 },
        () => {},
      ),
    ).toThrow();

    expect(() =>
      projectAutonomousPersonalCaptureReceiptSummaryV4(
        { ...verdictReceipt(), unknown: 'x'.repeat(17 * 1024) },
        () => {},
      ),
    ).toThrow();
  });

  it('preserves the original trusted-check error before parsing and between occurrence items', () => {
    const beforeParse = new Error('trusted check failed first');
    let firstError: unknown;
    try {
      projectAutonomousPersonalCaptureReceiptSummaryV4(occurrenceReceipt(), () => {
        throw beforeParse;
      });
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBe(beforeParse);

    const afterInvalidReceipt = new Error('trusted check failed after parse rejection');
    let rejectionCheckCount = 0;
    let rejectionError: unknown;
    try {
      projectAutonomousPersonalCaptureReceiptSummaryV4({ version: 3 }, () => {
        rejectionCheckCount += 1;
        if (rejectionCheckCount === 2) throw afterInvalidReceipt;
      });
    } catch (error) {
      rejectionError = error;
    }
    expect(rejectionError).toBe(afterInvalidReceipt);

    const betweenItems = new Error('trusted check failed during projection');
    let checkCount = 0;
    let caught: unknown;
    try {
      projectAutonomousPersonalCaptureReceiptSummaryV4(occurrenceReceipt(), () => {
        checkCount += 1;
        if (checkCount === 5) throw betweenItems;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(betweenItems);
    expect(checkCount).toBe(5);
  });
});
