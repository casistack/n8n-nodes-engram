import { z } from 'zod';
import { AUTOMATIC_LEDGER_LIMITS } from './AutomaticLedgerPrimitives.schema';
import {
  AutomaticCapturePurposeV2Schema,
  AutomaticCaptureRoleV2Schema,
} from './AutomaticCapture.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from './AutomaticCaptureReceipt.schema';
import type {
  AutomaticCaptureHandleRegistry,
  AutomaticCaptureHandlePurpose,
  PrivateOneUseAutomaticLeaseHandle,
} from '../storage/AutomaticCaptureHandles';

export {
  AutomaticCaptureBeginRequestV2Schema,
  type AutomaticCaptureBeginRequestV2,
  type AutomaticCaptureBeginRequestV2Input,
} from './AutomaticCapture.schema';

const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);
const locator = {
  version: z.literal(2),
  namespace: nonBlank(128),
  issuer: nonBlank(256),
  actorReference: nonBlank(512),
  turn: nonBlank(512),
  role: AutomaticCaptureRoleV2Schema,
};
export const AutomaticCaptureReadRequestV2Schema = z.object(locator).strict();
export type AutomaticCaptureReadRequestV2 = z.infer<typeof AutomaticCaptureReadRequestV2Schema>;
export const AutomaticCaptureAdminFenceRequestV2Schema = z
  .object({
    ...locator,
    expectedGeneration: z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
    attemptIdHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AutomaticCaptureAdminFenceRequestV2 = z.infer<
  typeof AutomaticCaptureAdminFenceRequestV2Schema
>;

const sourcePersistence = z.enum(['persisted', 'not_persisted', 'unknown']);
const currentAuthority = z.enum(['active', 'changed', 'revoked', 'unknown']);
const invocation = z.enum(['initial_owner', 'same_call_ack_recovered', 'explicit_resume']);
const noPermission = { eligibleFirstCommit: z.literal(false) };

/** Handle-free decisions only. Claimed/resumed branches require a registry-bound schema factory. */
export const AutomaticCaptureBeginDecisionV2Schema = z.union([
  z
    .object({
      kind: z.enum([
        'in_progress',
        'committed_replay',
        'cancelled_replay',
        'legacy_unconfirmed',
        'source_only_unconfirmed',
        'conflict',
        'authority_changed',
        'invalid_input',
        'unsupported_mode',
        'resume_available',
        'clock_regression',
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('capacity'), sourcePersistence }).strict(),
]);
export type AutomaticCaptureBeginDecisionV2 = z.infer<typeof AutomaticCaptureBeginDecisionV2Schema>;
export const AutomaticCaptureResumeDecisionV2Schema = z
  .object({
    kind: z.enum([
      'in_progress',
      'committed_replay',
      'cancelled',
      'legacy_unconfirmed',
      'source_only_unconfirmed',
      'conflict',
      'authority_changed',
      'capacity',
      'not_found',
      'invalid_input',
      'fenced',
      'clock_regression',
      'unsupported_mode',
    ]),
  })
  .strict();
export type AutomaticCaptureResumeDecisionV2 = z.infer<
  typeof AutomaticCaptureResumeDecisionV2Schema
>;

// Refine the existing persisted schema; do not reconstruct persisted receipt shapes.
const humanReceipt = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'human_capture_committed',
);
const assistantReceipt = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'assistant_final_saved',
);
const cancelledReceipt = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'cancelled',
);

/** Data validation is not commit authority or processing permission. No handle branch is accepted here. */
export const AutomaticHumanCompletionDataResultV2Schema = z.union([
  z
    .object({
      kind: z.literal('committed'),
      invocation: z.enum(['initial_owner', 'same_call_ack_recovered']),
      terminalReceipt: humanReceipt,
      currentAuthority: z.literal('active'),
      eligibleFirstCommit: z.literal(true),
    })
    .strict()
    .superRefine((value, context) => {
      const receipt = value.terminalReceipt;
      if (
        receipt.kind !== 'human_capture_committed' ||
        !receipt.receipt.persisted ||
        !receipt.receiptInspectionComplete ||
        receipt.acceptedCoverage === 'unknown'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Initial eligibility requires a complete persisted human receipt',
        });
      }
    }),
  z
    .object({
      kind: z.literal('committed'),
      invocation,
      terminalReceipt: humanReceipt,
      currentAuthority,
      ...noPermission,
    })
    .strict(),
  z
    .object({ kind: z.literal('cancelled'), terminalReceipt: cancelledReceipt, ...noPermission })
    .strict(),
  z
    .object({
      kind: z.enum([
        'fenced',
        'invalid_plan',
        'authority_changed',
        'capacity',
        'resource_exhausted',
        'budget_exhausted',
        'interrupted',
        'storage_error',
        'invalid_input',
        'invalid_handle',
      ]),
      ...noPermission,
    })
    .strict(),
]);
export type AutomaticHumanCompletionDataResultV2 = z.infer<
  typeof AutomaticHumanCompletionDataResultV2Schema
>;

const claimedCaptureDataSchema = z
  .object({
    kind: z.literal('claimed'),
    sourceId: z.string().uuid(),
    operationId: z.string().uuid(),
    descriptorHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourcePersistence: z.literal('persisted'),
  })
  .strict();
const resumedCaptureDataSchema = z
  .object({
    kind: z.literal('resumed'),
    sourceId: z.string().uuid(),
    operationId: z.string().uuid(),
  })
  .strict();
const retryCaptureDataSchema = z
  .object({
    kind: z.literal('graph_conflict_retry'),
    ...noPermission,
  })
  .strict();
type CaptureHandleData<P extends AutomaticCaptureHandlePurpose, D> = D & {
  purpose: P;
  leaseHandle: PrivateOneUseAutomaticLeaseHandle<P>;
};
type ClaimedCaptureData<P extends AutomaticCaptureHandlePurpose> = CaptureHandleData<
  P,
  z.infer<typeof claimedCaptureDataSchema>
>;
type ResumedCaptureData<P extends AutomaticCaptureHandlePurpose> = CaptureHandleData<
  P,
  z.infer<typeof resumedCaptureDataSchema>
>;
type BeginInternalData =
  | AutomaticCaptureBeginDecisionV2
  | ClaimedCaptureData<'human_turn_memory'>
  | ClaimedCaptureData<'assistant_final_save'>;
type ResumeInternalData =
  | AutomaticCaptureResumeDecisionV2
  | ResumedCaptureData<'human_turn_memory'>
  | ResumedCaptureData<'assistant_final_save'>;
type HumanCompletionInternalData =
  | AutomaticHumanCompletionDataResultV2
  | (z.infer<typeof retryCaptureDataSchema> & {
      retryHandle: PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'>;
    });
type HumanCompletionInternalInput =
  | z.input<typeof AutomaticHumanCompletionDataResultV2Schema>
  | (z.input<typeof retryCaptureDataSchema> & {
      retryHandle: PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'>;
    });
export type AutomaticCaptureInternalResultSchemas = Readonly<{
  AutomaticCaptureBeginInternalResultV2Schema: z.ZodType<BeginInternalData>;
  AutomaticCaptureResumeInternalResultV2Schema: z.ZodType<ResumeInternalData>;
  AutomaticHumanCompletionInternalResultV2Schema: z.ZodType<
    HumanCompletionInternalData,
    z.ZodTypeDef,
    HumanCompletionInternalInput
  >;
}>;

/**
 * Bind internal data validation to the backend's actual private registry.
 * z.custom preserves the original handle identity. Validation neither consumes
 * nor reserves a handle: the backend must still consume synchronously and check
 * its persisted fence/current authority. A parse result is never a write permit.
 */
export function createAutomaticCaptureInternalResultSchemas(
  registry: AutomaticCaptureHandleRegistry,
): AutomaticCaptureInternalResultSchemas {
  const handleSchema = <P extends AutomaticCaptureHandlePurpose>(
    purpose: P,
    claimKind?: 'initial' | 'resume',
  ): z.ZodType<PrivateOneUseAutomaticLeaseHandle<P>> =>
    z.custom<PrivateOneUseAutomaticLeaseHandle<P>>(
      (handle) => registry.isLiveHandle(handle, purpose, claimKind),
      'Invalid private capture handle',
    );
  const claimed = <P extends AutomaticCaptureHandlePurpose>(purpose: P) =>
    claimedCaptureDataSchema
      .extend({
        purpose: z.literal(purpose),
        leaseHandle: handleSchema(purpose, 'initial'),
      })
      .strict();
  const resumed = <P extends AutomaticCaptureHandlePurpose>(purpose: P) =>
    resumedCaptureDataSchema
      .extend({
        purpose: z.literal(purpose),
        leaseHandle: handleSchema(purpose, 'resume'),
      })
      .strict();
  return Object.freeze({
    AutomaticCaptureBeginInternalResultV2Schema: z.union([
      claimed('human_turn_memory'),
      claimed('assistant_final_save'),
      AutomaticCaptureBeginDecisionV2Schema,
    ]),
    AutomaticCaptureResumeInternalResultV2Schema: z.union([
      resumed('human_turn_memory'),
      resumed('assistant_final_save'),
      AutomaticCaptureResumeDecisionV2Schema,
    ]),
    AutomaticHumanCompletionInternalResultV2Schema: z.union([
      AutomaticHumanCompletionDataResultV2Schema,
      retryCaptureDataSchema
        .extend({
          retryHandle: handleSchema('human_turn_memory'),
        })
        .strict(),
    ]),
  });
}
export type AutomaticCaptureBeginInternalResultV2 = z.infer<
  AutomaticCaptureInternalResultSchemas['AutomaticCaptureBeginInternalResultV2Schema']
>;
export type AutomaticCaptureResumeInternalResultV2 = z.infer<
  AutomaticCaptureInternalResultSchemas['AutomaticCaptureResumeInternalResultV2Schema']
>;
export type AutomaticHumanCompletionInternalResultV2 = z.infer<
  AutomaticCaptureInternalResultSchemas['AutomaticHumanCompletionInternalResultV2Schema']
>;

export const AutomaticAssistantCompletionInternalResultV2Schema = z.union([
  z
    .object({
      kind: z.literal('committed'),
      invocation,
      terminalReceipt: assistantReceipt,
      currentAuthority,
      ...noPermission,
    })
    .strict(),
  z
    .object({
      kind: z.enum([
        'fenced',
        'authority_changed',
        'capacity',
        'resource_exhausted',
        'interrupted',
        'storage_error',
        'invalid_input',
        'invalid_handle',
      ]),
      ...noPermission,
    })
    .strict(),
]);
export type AutomaticAssistantCompletionInternalResultV2 = z.infer<
  typeof AutomaticAssistantCompletionInternalResultV2Schema
>;

export const AutomaticCaptureCancelDecisionKindV2Schema = z.enum([
  'already_terminal',
  'fenced',
  'conflict',
  'not_found',
  'authority_changed',
  'capacity',
  'invalid_input',
  'legacy_unconfirmed',
  'source_only_unconfirmed',
  'clock_regression',
  'unsupported_mode',
]);
export const AutomaticCaptureCancelInternalResultV2Schema = z.union([
  z
    .object({ kind: z.literal('cancelled'), terminalReceipt: cancelledReceipt, ...noPermission })
    .strict(),
  z
    .object({
      kind: AutomaticCaptureCancelDecisionKindV2Schema,
      ...noPermission,
    })
    .strict(),
]);
export type AutomaticCaptureCancelInternalResultV2 = z.infer<
  typeof AutomaticCaptureCancelInternalResultV2Schema
>;

const itemCount = z.number().int().min(0).max(32);
export const AutomaticCaptureReceiptSummaryV2Schema = z
  .object({
    persisted: z.boolean(),
    commitAt: z.string().datetime().nullable(),
    receiptInspectionComplete: z.boolean(),
    interpretationCoverage: z.enum(['complete', 'partial', 'none', 'unknown']),
    acceptedCoverage: z.enum(['all', 'partial', 'none', 'unknown']),
    itemCounts: z
      .object({
        accepted: itemCount,
        proposed: itemCount,
        rejected: itemCount,
        deferred: itemCount,
        not_selected: itemCount,
        unchanged: itemCount,
      })
      .strict(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.persisted !== (summary.commitAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Persisted summary requires its actual commit time',
      });
    }
    const total = Object.values(summary.itemCounts).reduce((sum, count) => sum + count, 0);
    const accepted = summary.itemCounts.accepted + summary.itemCounts.unchanged;
    if (total > 32) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Receipt item total exceeds 32' });
    }
    if (
      (summary.acceptedCoverage === 'all' && (accepted === 0 || accepted !== total)) ||
      (summary.acceptedCoverage === 'partial' && (accepted === 0 || accepted >= total)) ||
      (summary.acceptedCoverage === 'none' && accepted !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted coverage must agree with item counts',
      });
    }
    if (summary.interpretationCoverage === 'unknown' && summary.acceptedCoverage !== 'none') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unknown interpretation cannot imply accepted facts',
      });
    }
  });
export type AutomaticCaptureReceiptSummaryV2 = z.infer<
  typeof AutomaticCaptureReceiptSummaryV2Schema
>;

/** Strict public data projection. Parsing this object never authenticates a backend result. */
export const AutomaticCapturePublicResultV2Schema = z
  .object({
    version: z.literal(2),
    purpose: AutomaticCapturePurposeV2Schema.nullable(),
    status: z.enum([
      'first_capture_committed',
      'assistant_final_saved',
      'in_progress',
      'committed_replay',
      'legacy_unconfirmed',
      'source_only_unconfirmed',
      'cancelled',
      'resume_available',
      'conflict',
      'capacity',
      'authority_changed',
      'not_found',
      'invalid_input',
      'unsupported_mode',
      'failed',
      'clock_regression',
    ]),
    sourceId: z.string().uuid().nullable(),
    sourcePersistence,
    should_process: z.boolean(),
    currentAuthority: z.enum(['active', 'changed', 'revoked', 'unknown', 'not_evaluated']),
    receiptSummary: AutomaticCaptureReceiptSummaryV2Schema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (result.should_process !== (result.status === 'first_capture_committed')) {
      invalid('Only the first committed human capture can have processing eligibility');
    }
    if (result.should_process) {
      const summary = result.receiptSummary;
      if (
        result.purpose !== 'human_turn_memory' ||
        result.sourcePersistence !== 'persisted' ||
        result.sourceId === null ||
        result.currentAuthority !== 'active' ||
        !summary ||
        !summary.persisted ||
        !summary.receiptInspectionComplete ||
        summary.acceptedCoverage === 'unknown' ||
        Object.values(summary.itemCounts).reduce((total, count) => total + count, 0) === 0
      ) {
        invalid(
          'Processing eligibility requires the first durable human commit with active authority',
        );
      }
    }
    if (
      ['conflict', 'not_found', 'invalid_input', 'capacity'].includes(result.status) &&
      result.sourceId !== null
    ) {
      invalid('This outcome cannot disclose a source identifier');
    }
    if (
      ['conflict', 'not_found', 'invalid_input', 'capacity'].includes(result.status) &&
      result.receiptSummary !== null
    )
      invalid('Unconfirmed outcomes cannot disclose a receipt');
    if (result.purpose === 'assistant_final_save' && result.receiptSummary !== null)
      invalid('Assistant saves have no human claim receipt summary');
    if (result.status === 'conflict' && result.sourcePersistence !== 'unknown')
      invalid('Conflict cannot disclose source persistence');
    if (
      ['not_found', 'invalid_input'].includes(result.status) &&
      result.sourcePersistence !== 'not_persisted'
    )
      invalid('Known no-source outcomes must report no persistence');
    if (result.status === 'assistant_final_saved' && result.purpose !== 'assistant_final_save')
      invalid('Assistant save requires assistant purpose');
    if (
      ['assistant_final_saved', 'committed_replay'].includes(result.status) &&
      (result.sourceId === null || result.sourcePersistence !== 'persisted')
    )
      invalid('Committed source outcomes require an exact persisted caller source');
  });
export type AutomaticCapturePublicResultV2 = z.infer<typeof AutomaticCapturePublicResultV2Schema>;

/** Read-only projection never reports an initial invocation or grants processing. */
export const AutomaticCaptureReadResultV2Schema = AutomaticCapturePublicResultV2Schema.refine(
  (result) => !result.should_process && result.status !== 'first_capture_committed',
  'Outcome inspection cannot grant processing eligibility',
);
export type AutomaticCaptureReadResultV2 = z.infer<typeof AutomaticCaptureReadResultV2Schema>;
