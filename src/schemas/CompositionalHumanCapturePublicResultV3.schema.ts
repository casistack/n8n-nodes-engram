import { z } from 'zod';
import { CompositionalBundleDecisionCodeV3Schema } from './CompositionalBundleDecisionCodeV3.schema';
import { CompositionalPreferenceV2ReasonSchema } from './CompositionalPreferenceV2.schema';

const uuid = z.string().uuid();
const canonicalUtcMillis = z
  .string()
  .length(24)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const count = z.number().int().min(0).max(32);

const countsSchema = z
  .object({
    bundleCount: count,
    persistedBundleCount: count,
    distinctPersistedClaimCount: count,
    byState: z
      .object({
        accepted: count,
        unchanged: count,
        proposed: count,
        rejected: count,
        not_selected: count,
      })
      .strict(),
  })
  .strict();

const bundleState = z.enum(['accepted', 'unchanged', 'proposed', 'rejected', 'not_selected']);
const bundleReasonByState = {
  accepted: ['eligible_create'],
  unchanged: ['existing_accepted'],
  proposed: ['profile_review_required', 'existing_proposed'],
  rejected: ['existing_rejected'],
  not_selected: [
    'explicit_intent_required',
    'existing_ineligible',
    'legacy_reuse_not_authorized',
    'possible_overlap',
    'unknown_overlap_domain',
  ],
} as const;

const bundleItemSchema = z
  .object({
    bundleIndex: z.number().int().min(0).max(31),
    state: bundleState,
    persisted: z.boolean(),
    reason: CompositionalBundleDecisionCodeV3Schema.optional(),
    claimId: uuid.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.persisted !== (item.claimId !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claimId'],
        message: 'Claim ID must match persistence',
      });
    }
    if ((item.state === 'accepted' || item.state === 'unchanged') && !item.persisted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['persisted'],
        message: 'Accepted state requires persistence',
      });
    }
    if (item.state === 'not_selected' && item.persisted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['persisted'],
        message: 'Not-selected state cannot be persisted',
      });
    }
    if (item.reason && !bundleReasonByState[item.state].includes(item.reason as never)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'Reason disagrees with bundle state',
      });
    }
  });

const sourceVerdictSelectionSchema = z
  .object({
    kind: z.literal('source_verdict'),
    verdict: z.enum(['no_supported_preference_detected', 'unsupported_preference_meaning']),
  })
  .strict();
const bundleSelectionSchema = z
  .object({ kind: z.literal('bundles'), items: z.array(bundleItemSchema).min(1).max(32) })
  .strict();

const committedReceiptSummarySchema = z
  .object({
    kind: z.literal('committed'),
    persisted: z.literal(true),
    terminalAt: canonicalUtcMillis,
    interpretationCoverage: z.enum(['complete', 'none', 'unknown']),
    acceptedCoverage: z.enum(['all', 'partial', 'none']),
    reasons: z.array(CompositionalPreferenceV2ReasonSchema).max(16),
    selection: z.discriminatedUnion('kind', [sourceVerdictSelectionSchema, bundleSelectionSchema]),
    counts: countsSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    const zeroCounts = Object.values(summary.counts.byState).every((value) => value === 0);
    const distinctClaims = new Set(
      summary.selection.kind === 'bundles'
        ? summary.selection.items.filter((item) => item.persisted).map((item) => item.claimId)
        : [],
    ).size;

    if (
      summary.counts.distinctPersistedClaimCount !== distinctClaims ||
      summary.counts.distinctPersistedClaimCount > summary.counts.persistedBundleCount ||
      summary.counts.persistedBundleCount > summary.counts.bundleCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counts'],
        message: 'Persisted claim counts disagree',
      });
    }

    if (summary.selection.kind === 'source_verdict') {
      const expectedCoverage =
        summary.selection.verdict === 'no_supported_preference_detected' ? 'none' : 'unknown';
      if (
        summary.interpretationCoverage !== expectedCoverage ||
        summary.acceptedCoverage !== 'none' ||
        summary.counts.bundleCount !== 0 ||
        summary.counts.persistedBundleCount !== 0 ||
        !zeroCounts
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selection'],
          message: 'Source verdict summary must have no bundle facts',
        });
      }
      return;
    }

    const items = summary.selection.items;
    const byState = {
      accepted: items.filter((item) => item.state === 'accepted').length,
      unchanged: items.filter((item) => item.state === 'unchanged').length,
      proposed: items.filter((item) => item.state === 'proposed').length,
      rejected: items.filter((item) => item.state === 'rejected').length,
      not_selected: items.filter((item) => item.state === 'not_selected').length,
    };
    const persistedBundles = items.filter((item) => item.persisted).length;
    const accepted = items.filter(
      (item) => item.persisted && (item.state === 'accepted' || item.state === 'unchanged'),
    ).length;
    const expectedAcceptedCoverage =
      accepted === 0 ? 'none' : accepted === items.length ? 'all' : 'partial';
    if (
      summary.interpretationCoverage !== 'complete' ||
      summary.counts.bundleCount !== items.length ||
      summary.counts.persistedBundleCount !== persistedBundles ||
      summary.counts.byState.accepted !== byState.accepted ||
      summary.counts.byState.unchanged !== byState.unchanged ||
      summary.counts.byState.proposed !== byState.proposed ||
      summary.counts.byState.rejected !== byState.rejected ||
      summary.counts.byState.not_selected !== byState.not_selected ||
      summary.acceptedCoverage !== expectedAcceptedCoverage ||
      items.some((item, index) => item.bundleIndex !== index)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counts'],
        message: 'Bundle summary does not match receipt items',
      });
    }
  });

const cancelledReceiptSummarySchema = z
  .object({
    kind: z.literal('cancelled'),
    persisted: z.literal(true),
    terminalAt: canonicalUtcMillis,
    acceptedCoverage: z.literal('none'),
    counts: z
      .object({
        bundleCount: z.literal(0),
        persistedBundleCount: z.literal(0),
        distinctPersistedClaimCount: z.literal(0),
        byState: z
          .object({
            accepted: z.literal(0),
            unchanged: z.literal(0),
            proposed: z.literal(0),
            rejected: z.literal(0),
            not_selected: z.literal(0),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const CompositionalHumanCaptureReceiptSummaryV3Schema = z.union([
  committedReceiptSummarySchema,
  cancelledReceiptSummarySchema,
]);
export type CompositionalHumanCaptureReceiptSummaryV3 = z.infer<
  typeof CompositionalHumanCaptureReceiptSummaryV3Schema
>;

export const CompositionalHumanCapturePublicStatusV3Schema = z.enum([
  'first_capture_committed',
  'committed_replay',
  'cancelled',
  'in_progress',
  'legacy_unconfirmed',
  'source_only_unconfirmed',
  'conflict',
  'authority_changed',
  'clock_regression',
  'capacity',
  'resource_exhausted',
  'budget_exhausted',
  'interrupted',
  'acknowledgement_unknown',
  'not_found',
  'invalid_input',
  'unsupported_mode',
  'failed',
]);
export type CompositionalHumanCapturePublicStatusV3 = z.infer<
  typeof CompositionalHumanCapturePublicStatusV3Schema
>;

export const CompositionalHumanCapturePublicResultV3Schema = z
  .object({
    version: z.literal(3),
    purpose: z.literal('human_turn_memory').nullable(),
    status: CompositionalHumanCapturePublicStatusV3Schema,
    sourceId: uuid.nullable(),
    should_process: z.boolean(),
    currentAuthority: z.enum(['active', 'changed', 'revoked', 'unknown', 'not_evaluated']),
    receiptSummary: CompositionalHumanCaptureReceiptSummaryV3Schema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const hasCommittedReceipt = result.receiptSummary?.kind === 'committed';
    const hasCancelledReceipt = result.receiptSummary?.kind === 'cancelled';
    const terminal =
      result.status === 'first_capture_committed' || result.status === 'committed_replay';
    const cancelled = result.status === 'cancelled';
    const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });

    if (result.should_process !== (result.status === 'first_capture_committed')) {
      invalid('Only the actual first human commit may set should_process');
    }
    if (terminal) {
      if (
        result.purpose !== 'human_turn_memory' ||
        result.sourceId === null ||
        !hasCommittedReceipt
      )
        invalid('Committed outcomes require their actual persisted receipt');
    } else if (cancelled) {
      if (
        result.purpose !== 'human_turn_memory' ||
        result.sourceId === null ||
        !hasCancelledReceipt ||
        result.currentAuthority !== 'not_evaluated'
      )
        invalid('Cancelled outcomes require their actual cancellation receipt');
    } else if (result.sourceId !== null || result.receiptSummary !== null) {
      invalid('Nonterminal outcomes cannot disclose source or receipt details');
    }

    if (result.status === 'first_capture_committed' && result.currentAuthority !== 'active') {
      invalid('First commit requires active current authority');
    }
    if (result.status === 'authority_changed' && result.currentAuthority !== 'unknown') {
      invalid('Authority-change decisions do not disclose detailed authority state');
    }
    if (
      result.status !== 'first_capture_committed' &&
      result.status !== 'committed_replay' &&
      result.status !== 'cancelled' &&
      result.status !== 'authority_changed' &&
      result.currentAuthority !== 'not_evaluated'
    ) {
      invalid('Nonterminal outcome must not claim evaluated authority');
    }
  });
export type CompositionalHumanCapturePublicResultV3 = z.infer<
  typeof CompositionalHumanCapturePublicResultV3Schema
>;
