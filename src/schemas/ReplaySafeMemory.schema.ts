import { z } from 'zod';
import { AutomaticCaptureTerminalReceiptV2Schema } from './AutomaticCaptureReceipt.schema';

/** Optional runtime field; absence does not add serialized settings to existing workflows. */
export const MemoryCaptureLifecycleSchema = z.enum(['legacy', 'replaySafeV2']);
export type MemoryCaptureLifecycle = z.infer<typeof MemoryCaptureLifecycleSchema>;
export const MemoryProcessingAttemptHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const REPLAY_SAFE_AUDIT_LIMITS = Object.freeze({
  perSave: 32,
  payloadBytes: 65_536,
  aggregateBytes: 524_288,
  identifierUnits: 512,
});
const reason = z.enum([
  'invalid_input',
  'unsupported_mode',
  'authority_changed',
  'fenced',
  'capacity',
  'budget_exhausted',
  'interrupted',
  'storage_error',
  'acknowledgement_unknown',
]);
const count = z.number().int().min(0).max(REPLAY_SAFE_AUDIT_LIMITS.perSave);
const assistantReceipt = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'assistant_final_saved',
);
export const ReplaySafeFinalAssistantDiagnosticsSchema = z
  .union([
    z.object({ state: z.literal('not_requested') }).strict(),
    z.object({ state: z.literal('persisted'), terminalReceipt: assistantReceipt }).strict(),
    z.object({ state: z.literal('deferred'), reason: z.literal('in_progress') }).strict(),
    z.object({ state: z.enum(['failed', 'unconfirmed']), reason }).strict(),
  ])
  .superRefine((final, context) => {
    if (
      (final.state === 'failed' && final.reason === 'acknowledgement_unknown') ||
      (final.state === 'unconfirmed' && final.reason !== 'acknowledgement_unknown')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Final persistence uncertainty must be explicit',
      });
    }
  });
export const ReplaySafeAuditDiagnosticsSchema = z
  .object({
    state: z.enum(['not_requested', 'complete', 'partial', 'failed', 'unknown']),
    requested: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    confirmedNew: count,
    confirmedExisting: count,
    unconfirmed: count,
    reason: reason.nullable(),
  })
  .strict()
  .superRefine((audit, context) => {
    const confirmed = audit.confirmedNew + audit.confirmedExisting;
    const invalid = () =>
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Audit state and confirmed counts disagree',
      });
    if (
      confirmed + audit.unconfirmed > audit.requested ||
      confirmed + audit.unconfirmed > REPLAY_SAFE_AUDIT_LIMITS.perSave
    )
      invalid();
    if (
      audit.requested > REPLAY_SAFE_AUDIT_LIMITS.perSave &&
      (audit.state !== 'failed' ||
        audit.reason !== 'capacity' ||
        confirmed !== 0 ||
        audit.unconfirmed !== 0)
    )
      invalid();
    if (audit.state === 'not_requested') {
      if (
        audit.requested !== 0 ||
        confirmed !== 0 ||
        audit.unconfirmed !== 0 ||
        audit.reason !== null
      )
        invalid();
    } else if (audit.requested === 0) invalid();
    if (
      audit.state === 'complete' &&
      (confirmed !== audit.requested || audit.unconfirmed !== 0 || audit.reason !== null)
    )
      invalid();
    if (
      audit.state === 'partial' &&
      (confirmed === 0 ||
        confirmed >= audit.requested ||
        audit.unconfirmed !== 0 ||
        audit.reason === null ||
        audit.reason === 'acknowledgement_unknown')
    )
      invalid();
    if (
      audit.state === 'failed' &&
      (confirmed !== 0 ||
        audit.unconfirmed !== 0 ||
        audit.reason === null ||
        audit.reason === 'acknowledgement_unknown')
    )
      invalid();
    if (
      audit.state === 'unknown' &&
      (audit.unconfirmed === 0 || audit.reason !== 'acknowledgement_unknown')
    )
      invalid();
  });

/** Invocation-scoped diagnostics. Audit failure never erases a confirmed final receipt. */
export const ReplaySafeMemoryWriteDiagnosticsSchema = z
  .object({
    version: z.literal(2),
    should_process: z.literal(false),
    finalAssistant: ReplaySafeFinalAssistantDiagnosticsSchema,
    audit: ReplaySafeAuditDiagnosticsSchema,
  })
  .strict();
export type ReplaySafeMemoryWriteDiagnostics = z.infer<
  typeof ReplaySafeMemoryWriteDiagnosticsSchema
>;
