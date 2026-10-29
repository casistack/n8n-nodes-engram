import { z } from 'zod';
import { AutomaticRuntimeSchema } from './AutomaticRuntime.schema';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import { CompositionalAutomaticCaptureTerminalReceiptV3Schema } from './CompositionalAutomaticCaptureV3.schema';

/** Trusted application configuration; native adapters derive the attempt/store hashes themselves. */
export const CompositionalMemoryParentExpectedV3Schema = z
  .object({
    version: z.literal(3),
    preferenceInterpreter: z.literal('compositionalV2'),
    namespace: CompositionalCaptureNamespaceV3Schema,
    runtime: AutomaticRuntimeSchema,
    currentHumanInput: z.string().min(1).max(65536),
    expectedHumanProcessingAttemptHash: z.string().regex(/^[a-f0-9]{64}$/u),
    invocationDeadlineMs: z.number().int().min(100).max(120000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.runtime.profileId === 'existing' ||
      !value.runtime.capturedSourceId ||
      value.runtime.actor.namespace !== value.namespace
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Explicit captured-parent configuration required',
      });
  });
export type CompositionalMemoryParentExpectedV3 = z.infer<
  typeof CompositionalMemoryParentExpectedV3Schema
>;

export const CompositionalMemoryParentReasonV3Schema = z.enum([
  'invalid_reader',
  'invalid_input',
  'parent_not_found',
  'parent_uncommitted',
  'unsupported_parent',
  'parent_mismatch',
  'policy_changed',
  'authority_changed',
  'processing_attempt_mismatch',
  'clock_regression',
  'budget_exhausted',
  'resource_exhausted',
]);
export type CompositionalMemoryParentReasonV3 = z.infer<
  typeof CompositionalMemoryParentReasonV3Schema
>;

/** Checked observations only; callers cannot submit this representation as authorization. */
export const CompositionalMemoryParentResultV3Schema = z.union([
  z
    .object({
      status: z.literal('valid_parent_data'),
      sourceId: z.string().uuid(),
      operationId: z.string().uuid(),
      terminalReceipt: CompositionalAutomaticCaptureTerminalReceiptV3Schema.refine(
        (receipt) =>
          receipt.kind === 'human_compositional_capture_committed' ||
          receipt.kind === 'human_compositional_source_verdict_committed',
      ),
    })
    .strict(),
  z
    .object({ status: z.literal('rejected'), reason: CompositionalMemoryParentReasonV3Schema })
    .strict(),
]);
export type CompositionalMemoryParentResultV3 = z.infer<
  typeof CompositionalMemoryParentResultV3Schema
>;
