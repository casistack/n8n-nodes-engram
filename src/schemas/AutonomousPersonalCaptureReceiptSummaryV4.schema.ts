import { z } from 'zod';
import {
  addAutonomousPersonalDeferredCoverageIssuesV4,
  addAutonomousPersonalOccurrenceStateEffectIssuesV4,
  addAutonomousPersonalSourceVerdictCoverageIssuesV4,
  AutonomousPersonalCancelledReceiptV4OwnedDataSchema,
  AutonomousPersonalDeferredReceiptV4OwnedDataSchema,
  AutonomousPersonalOccurrenceReceiptV4OwnedDataSchema,
  AutonomousPersonalSourceVerdictReceiptV4OwnedDataSchema,
} from './AutonomousPersonalOperationV4.schema';

const occurrenceReceipt = AutonomousPersonalOccurrenceReceiptV4OwnedDataSchema.innerType();
const sourceVerdictReceipt = AutonomousPersonalSourceVerdictReceiptV4OwnedDataSchema.innerType();
const deferredReceipt = AutonomousPersonalDeferredReceiptV4OwnedDataSchema.innerType();
const cancelledReceipt = AutonomousPersonalCancelledReceiptV4OwnedDataSchema;

const occurrenceItem = occurrenceReceipt.shape.selection.shape.items.element.innerType();
const occurrenceSummaryItem = occurrenceItem
  .pick({
    occurrenceIndex: true,
    kind: true,
    state: true,
    effect: true,
    claimId: true,
    reason: true,
  })
  .strict()
  .superRefine((item, context) => {
    addAutonomousPersonalOccurrenceStateEffectIssuesV4(item, context);
  });

const occurrenceSummarySelection = occurrenceReceipt.shape.selection
  .extend({
    items: z.array(occurrenceSummaryItem).min(1).max(32),
  })
  .strict();

const count = z.number().int().min(0).max(32);
const countsSchema = z
  .object({
    occurrenceCount: count,
    byState: z
      .object({
        accepted: count,
        proposed: count,
        rejected: count,
        not_selected: count,
      })
      .strict(),
    createdOccurrenceCount: count,
    referenceOccurrenceCount: count,
    distinctPersistedClaimCount: count,
  })
  .strict();

const zeroCountsSchema = z
  .object({
    occurrenceCount: z.literal(0),
    byState: z
      .object({
        accepted: z.literal(0),
        proposed: z.literal(0),
        rejected: z.literal(0),
        not_selected: z.literal(0),
      })
      .strict(),
    createdOccurrenceCount: z.literal(0),
    referenceOccurrenceCount: z.literal(0),
    distinctPersistedClaimCount: z.literal(0),
  })
  .strict();

const occurrenceSummarySchema = z
  .object({
    version: occurrenceReceipt.shape.version,
    kind: z.literal('committed'),
    sourceId: occurrenceReceipt.shape.sourceId,
    terminalAt: occurrenceReceipt.shape.terminalAt,
    acceptanceSemantics: occurrenceReceipt.shape.acceptanceSemantics,
    acceptedCoverage: occurrenceReceipt.shape.acceptedCoverage,
    interpretationCoverage: occurrenceReceipt.shape.interpretationCoverage,
    sourceCoverage: occurrenceReceipt.shape.sourceCoverage,
    selection: occurrenceSummarySelection,
    counts: countsSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.interpretationCoverage !== summary.sourceCoverage.status) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interpretationCoverage'],
        message: 'Interpretation coverage must match source coverage',
      });
    }

    const items = summary.selection.items;
    const byState = {
      accepted: items.filter((item) => item.state === 'accepted').length,
      proposed: items.filter((item) => item.state === 'proposed').length,
      rejected: items.filter((item) => item.state === 'rejected').length,
      not_selected: items.filter((item) => item.state === 'not_selected').length,
    };
    const createdOccurrenceCount = items.filter((item) => item.effect === 'created').length;
    const referenceOccurrenceCount = items.filter((item) => item.effect === 'reference').length;
    const distinctPersistedClaimCount = new Set(
      items.flatMap((item) => (item.claimId === null ? [] : [item.claimId])),
    ).size;
    const acceptedCoverage =
      byState.accepted === 0 ? 'none' : byState.accepted === items.length ? 'all' : 'partial';

    if (
      items.some((item, index) => item.occurrenceIndex !== index) ||
      summary.counts.occurrenceCount !== items.length ||
      summary.counts.byState.accepted !== byState.accepted ||
      summary.counts.byState.proposed !== byState.proposed ||
      summary.counts.byState.rejected !== byState.rejected ||
      summary.counts.byState.not_selected !== byState.not_selected ||
      summary.counts.createdOccurrenceCount !== createdOccurrenceCount ||
      summary.counts.referenceOccurrenceCount !== referenceOccurrenceCount ||
      summary.counts.distinctPersistedClaimCount !== distinctPersistedClaimCount ||
      summary.acceptedCoverage !== acceptedCoverage
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counts'],
        message: 'Occurrence summary counts do not match its items',
      });
    }
  });

const sourceVerdictSummarySchema = z
  .object({
    version: sourceVerdictReceipt.shape.version,
    kind: z.literal('committed'),
    sourceId: sourceVerdictReceipt.shape.sourceId,
    terminalAt: sourceVerdictReceipt.shape.terminalAt,
    acceptanceSemantics: sourceVerdictReceipt.shape.acceptanceSemantics,
    acceptedCoverage: sourceVerdictReceipt.shape.acceptedCoverage,
    interpretationCoverage: sourceVerdictReceipt.shape.interpretationCoverage,
    sourceCoverage: sourceVerdictReceipt.shape.sourceCoverage,
    selection: sourceVerdictReceipt.shape.selection,
    counts: zeroCountsSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    addAutonomousPersonalSourceVerdictCoverageIssuesV4(
      summary,
      context,
      ['interpretationCoverage'],
      'Interpretation coverage must match source coverage',
    );
  });

const deferredSummarySchema = z
  .object({
    version: deferredReceipt.shape.version,
    kind: z.literal('committed'),
    sourceId: deferredReceipt.shape.sourceId,
    terminalAt: deferredReceipt.shape.terminalAt,
    acceptanceSemantics: deferredReceipt.shape.acceptanceSemantics,
    acceptedCoverage: deferredReceipt.shape.acceptedCoverage,
    interpretationCoverage: deferredReceipt.shape.interpretationCoverage,
    sourceCoverage: deferredReceipt.shape.sourceCoverage,
    selection: deferredReceipt.shape.selection,
    counts: zeroCountsSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    addAutonomousPersonalDeferredCoverageIssuesV4(summary, context);
  });

const cancelledSummarySchema = z
  .object({
    version: cancelledReceipt.shape.version,
    kind: z.literal('cancelled'),
    sourceId: cancelledReceipt.shape.sourceId,
    terminalAt: cancelledReceipt.shape.terminalAt,
    counts: zeroCountsSchema,
  })
  .strict();

/** Strict bounded summary DATA; parsing this schema never authenticates a receipt. */
export const AutonomousPersonalCaptureReceiptSummaryV4Schema = z.union([
  occurrenceSummarySchema,
  sourceVerdictSummarySchema,
  deferredSummarySchema,
  cancelledSummarySchema,
]);

export type AutonomousPersonalCaptureReceiptSummaryV4 = z.infer<
  typeof AutonomousPersonalCaptureReceiptSummaryV4Schema
>;
