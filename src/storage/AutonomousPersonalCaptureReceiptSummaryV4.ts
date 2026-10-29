import {
  AutonomousPersonalReceiptV4Schema,
  type AutonomousPersonalReceiptV4,
} from '../schemas/AutonomousPersonalOperationV4.schema';
import {
  AutonomousPersonalCaptureReceiptSummaryV4Schema,
  type AutonomousPersonalCaptureReceiptSummaryV4,
} from '../schemas/AutonomousPersonalCaptureReceiptSummaryV4.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';

type SummaryOccurrenceBranch = Extract<
  AutonomousPersonalCaptureReceiptSummaryV4,
  { selection: { kind: 'occurrences' } }
>;
type SummaryOccurrenceItem = SummaryOccurrenceBranch['selection']['items'][number];

function runCheckedPhase<T>(work: () => T, trustedCheck: () => void): T {
  let result: T;
  try {
    result = work();
  } catch (error) {
    trustedCheck();
    throw error;
  }
  trustedCheck();
  return result;
}

function emptyCounts() {
  return {
    occurrenceCount: 0,
    byState: { accepted: 0, proposed: 0, rejected: 0, not_selected: 0 },
    createdOccurrenceCount: 0,
    referenceOccurrenceCount: 0,
    distinctPersistedClaimCount: 0,
  } as const;
}

function projectOccurrenceItems(
  receipt: Extract<AutonomousPersonalReceiptV4, { kind: 'human_autonomous_capture_committed' }>,
  check: () => void,
): {
  readonly items: SummaryOccurrenceItem[];
  readonly counts: {
    occurrenceCount: number;
    byState: { accepted: number; proposed: number; rejected: number; not_selected: number };
    createdOccurrenceCount: number;
    referenceOccurrenceCount: number;
    distinctPersistedClaimCount: number;
  };
} {
  if (receipt.selection.kind !== 'occurrences') throw new Error('Expected occurrence receipt');

  const items: SummaryOccurrenceItem[] = [];
  for (const item of receipt.selection.items) {
    check();
    items.push({
      occurrenceIndex: item.occurrenceIndex,
      kind: item.kind,
      state: item.state,
      effect: item.effect,
      claimId: item.claimId,
      reason: item.reason,
    });
    check();
  }

  const byState = { accepted: 0, proposed: 0, rejected: 0, not_selected: 0 };
  let createdOccurrenceCount = 0;
  let referenceOccurrenceCount = 0;
  const claimIds = new Set<string>();
  for (const item of items) {
    check();
    byState[item.state] += 1;
    if (item.effect === 'created') createdOccurrenceCount += 1;
    if (item.effect === 'reference') referenceOccurrenceCount += 1;
    if (item.claimId !== null) claimIds.add(item.claimId);
    check();
  }

  return {
    items,
    counts: {
      occurrenceCount: items.length,
      byState,
      createdOccurrenceCount,
      referenceOccurrenceCount,
      distinctPersistedClaimCount: claimIds.size,
    },
  };
}

function deepFreezeChecked<T>(value: T, check: () => void): T {
  check();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeChecked(child, check);
    }
    Object.freeze(value);
  }
  check();
  return value;
}

/**
 * Project a bounded Receipt4 into small, strict display DATA. This validates
 * structure only and does not authenticate a stored receipt or grant authority.
 */
export function projectAutonomousPersonalCaptureReceiptSummaryV4(
  receiptValue: unknown,
  trustedCheck: () => void,
): AutonomousPersonalCaptureReceiptSummaryV4 {
  trustedCheck();
  const receipt = runCheckedPhase(
    () => AutonomousPersonalReceiptV4Schema.parse(receiptValue),
    trustedCheck,
  );

  let candidate: unknown;
  if (receipt.kind === 'cancelled') {
    trustedCheck();
    candidate = {
      version: 4,
      kind: 'cancelled',
      sourceId: receipt.sourceId,
      terminalAt: receipt.terminalAt,
      counts: emptyCounts(),
    };
    trustedCheck();
  } else {
    trustedCheck();
    if (receipt.kind === 'human_autonomous_capture_committed') {
      const { items, counts } = projectOccurrenceItems(receipt, trustedCheck);
      candidate = {
        version: 4,
        kind: 'committed',
        sourceId: receipt.sourceId,
        terminalAt: receipt.terminalAt,
        acceptanceSemantics: receipt.acceptanceSemantics,
        acceptedCoverage: receipt.acceptedCoverage,
        interpretationCoverage: receipt.interpretationCoverage,
        sourceCoverage: receipt.sourceCoverage,
        selection: { kind: receipt.selection.kind, items },
        counts,
      };
    } else if (receipt.selection.kind === 'source_verdict') {
      candidate = {
        version: 4,
        kind: 'committed',
        sourceId: receipt.sourceId,
        terminalAt: receipt.terminalAt,
        acceptanceSemantics: receipt.acceptanceSemantics,
        acceptedCoverage: receipt.acceptedCoverage,
        interpretationCoverage: receipt.interpretationCoverage,
        sourceCoverage: receipt.sourceCoverage,
        selection: receipt.selection,
        counts: emptyCounts(),
      };
    } else {
      candidate = {
        version: 4,
        kind: 'committed',
        sourceId: receipt.sourceId,
        terminalAt: receipt.terminalAt,
        acceptanceSemantics: receipt.acceptanceSemantics,
        acceptedCoverage: receipt.acceptedCoverage,
        interpretationCoverage: receipt.interpretationCoverage,
        sourceCoverage: receipt.sourceCoverage,
        selection: receipt.selection,
        counts: emptyCounts(),
      };
    }
    trustedCheck();
  }

  trustedCheck();
  const boundedCandidate = runCheckedPhase(
    () => cloneBoundedAutomaticCaptureJson<unknown>(candidate, 'policyData'),
    trustedCheck,
  );
  const summary = runCheckedPhase(
    () => AutonomousPersonalCaptureReceiptSummaryV4Schema.parse(boundedCandidate),
    trustedCheck,
  );
  deepFreezeChecked(summary, trustedCheck);
  trustedCheck();
  return summary;
}
