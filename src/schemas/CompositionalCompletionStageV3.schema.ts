import { z } from 'zod';
import { hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import {
  AutomaticOperationAttemptSchema,
  AUTOMATIC_LEDGER_LIMITS,
} from './AutomaticLedgerPrimitives.schema';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  CompositionalAutomaticOperationIdentityV3Schema,
} from './CompositionalAutomaticCaptureV3.schema';
import { CompositionalAutomaticDescriptorV3Schema } from './CompositionalAutomaticMemory.schema';
import { CompositionalCaptureLeaseFenceV3Schema } from './CompositionalAutomaticCaptureLifecycleV3.schema';
import { SourceHydrationBudgetSchema, type SourceHydrationBudget } from './ExtractionPolicy.schema';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import { CompositionalMaterializationInterpretationV3Schema } from './CompositionalMaterializationV3.schema';
import { CompositionalMaterializationPreparedV3Schema } from './CompositionalMaterializationPreparedV3.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const timestamp = z.string().datetime();

export const CompositionalCompletionStageDeferredReasonV3Schema = z.enum([
  'invalid_capability',
  'invalid_input',
  'invalid_resources',
  'invalid_snapshot',
  'missing_operation',
  'ambiguous_operation',
  'unsupported_mode',
  'operation_not_leased',
  'clock_regression',
  'lease_expired',
  'invalid_source',
  'authority_changed',
  'source_verdict_required',
  'identity_collision',
  'inspection_incomplete',
  'budget_exhausted',
  'plan_too_large',
  'invalid_plan',
  'invalid_stage',
  'invalid_receipt',
  'invalid_audit',
  'capacity',
  'acknowledgement_mismatch',
  'deadline_exceeded',
]);
export type CompositionalCompletionStageDeferredReasonV3 = z.infer<
  typeof CompositionalCompletionStageDeferredReasonV3Schema
>;

export const CompositionalCompletionRowGuardV3Schema = z
  .object({
    kind: z.enum(['entity', 'edge', 'episode', 'operation']),
    id: uuid,
    expectedHash: hash,
  })
  .strict();
export type CompositionalCompletionRowGuardV3 = z.infer<
  typeof CompositionalCompletionRowGuardV3Schema
>;

export const CompositionalCompletionOperationAuditGuardV3Schema = z
  .object({
    operationId: uuid,
    prefixCount: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation),
    prefixHash: hash,
    overflowCount: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.overflowCounterMax),
    auditTruncated: z.boolean().optional(),
    lastObservedAt: timestamp,
  })
  .strict();
export type CompositionalCompletionOperationAuditGuardV3 = z.infer<
  typeof CompositionalCompletionOperationAuditGuardV3Schema
>;

export const CompositionalCompletionStageAuditV3Schema = z
  .object({
    action: z.literal('completion'),
    attemptIdHash: hash,
    operationId: uuid,
    sourceId: uuid,
  })
  .strict();
export type CompositionalCompletionStageAuditV3 = z.infer<
  typeof CompositionalCompletionStageAuditV3Schema
>;

/** The terminal receipt is stored separately to avoid caching a second copy. */
export const CompositionalCompletionOperationProjectionV3Schema = z
  .object({
    version: z.literal(3),
    operationId: uuid,
    identity: CompositionalAutomaticOperationIdentityV3Schema,
    descriptor: CompositionalAutomaticDescriptorV3Schema,
    createdAt: timestamp,
    lastObservedAt: timestamp,
    attempts: z
      .array(AutomaticOperationAttemptSchema)
      .max(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation),
    overflowCount: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.overflowCounterMax),
    auditTruncated: z.boolean().optional(),
    beginCallHash: hash,
    retryCount: z.number().int().min(0).max(3),
    lastRetryCallHash: hash.optional(),
    lastResumeCause: z.enum(['lease_expired', 'failed', 'interrupted']).optional(),
    state: z.literal('committed'),
    generation: z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
    completionCallHash: hash,
  })
  .strict();
export type CompositionalCompletionOperationProjectionV3 = z.infer<
  typeof CompositionalCompletionOperationProjectionV3Schema
>;

const metadataSchema = z
  .object({
    version: z.literal(1),
    operationId: uuid,
    sourceId: uuid,
    namespace: CompositionalCaptureNamespaceV3Schema,
    storeHash: hash,
    completionCallHash: hash,
    audit: CompositionalCompletionStageAuditV3Schema,
    fence: CompositionalCaptureLeaseFenceV3Schema,
    expiresAt: timestamp,
    acknowledgedBackendNow: timestamp,
    leaseRemainingMsAtMonotonicAnchor: z.number().finite().nonnegative(),
    invocationDeadlineAtMonotonicMs: z.number().finite(),
    invocationDeadlineMs: z.number().int().min(100).max(120_000),
    claimKind: z.enum(['initial', 'resume']),
    stagedBackendNow: timestamp,
    planTimestamp: timestamp,
    planHash: hash,
    bindingHash: hash,
  })
  .strict();
export const CompositionalCompletionStageMetadataV3Schema = metadataSchema;
export type CompositionalCompletionStageMetadataV3 = z.infer<typeof metadataSchema>;

const stageCacheBody = z
  .object({
    version: z.literal(1),
    kind: z.literal('compositional_completion_stage'),
    metadata: metadataSchema,
    interpretation: CompositionalMaterializationInterpretationV3Schema,
    plan: CompositionalMaterializationPreparedV3Schema,
    guards: z.array(CompositionalCompletionRowGuardV3Schema).max(130),
    operationAudits: z.array(CompositionalCompletionOperationAuditGuardV3Schema).max(33),
    expectedReceipt: CompositionalAutomaticCaptureTerminalReceiptV3Schema.optional(),
    expectedOperation: CompositionalCompletionOperationProjectionV3Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.expectedReceipt === undefined) !== (value.expectedOperation === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedReceipt'],
        message: 'Expected completion data must be stored together',
      });
    }
    if (
      value.plan.sourceGuard.operationId !== value.metadata.operationId ||
      value.plan.sourceGuard.sourceId !== value.metadata.sourceId ||
      value.plan.sourceGuard.namespace !== value.metadata.namespace ||
      value.plan.sourceGuard.storeHash !== value.metadata.storeHash ||
      value.metadata.fence.operationId !== value.metadata.operationId ||
      value.metadata.fence.sourceId !== value.metadata.sourceId ||
      value.metadata.fence.claimKind !== value.metadata.claimKind ||
      value.metadata.fence.planTimestamp !== value.metadata.planTimestamp ||
      Date.parse(value.metadata.expiresAt) <= Date.parse(value.metadata.acknowledgedBackendNow) ||
      Date.parse(value.metadata.stagedBackendNow) <
        Date.parse(value.metadata.acknowledgedBackendNow) ||
      value.plan.planTimestamp !== value.metadata.planTimestamp ||
      value.plan.snapshotHash.length !== 64
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metadata'],
        message: 'Stage metadata does not bind the prepared plan',
      });
    }
    if (
      value.metadata.planHash !== hashAutomaticCaptureV2(value.plan) ||
      value.metadata.bindingHash !==
        hashAutomaticCaptureV2({
          domain: 'engram-compositional-completion-stage-v3',
          planHash: value.metadata.planHash,
          interpretation: value.interpretation,
          sourceGuard: value.plan.sourceGuard,
          fence: value.metadata.fence,
          completionCallHash: value.metadata.completionCallHash,
        })
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metadata', 'bindingHash'],
        message: 'Stage binding hashes do not match owned data',
      });
    }
    if (value.expectedReceipt && value.expectedOperation) {
      const receipt = value.expectedReceipt;
      const operation = value.expectedOperation;
      if (
        receipt.kind !== 'human_compositional_capture_committed' ||
        operation.operationId !== value.metadata.operationId ||
        operation.identity.sourceId !== value.metadata.sourceId ||
        operation.identity.namespace !== value.metadata.namespace ||
        operation.completionCallHash !== value.metadata.completionCallHash ||
        value.metadata.audit.operationId !== operation.operationId ||
        value.metadata.audit.sourceId !== operation.identity.sourceId ||
        receipt.operationId !== operation.operationId ||
        receipt.sourceId !== operation.identity.sourceId ||
        receipt.sourceHash !== operation.identity.sourceHash ||
        receipt.descriptorHash !== operation.identity.descriptorHash ||
        receipt.policyFingerprint !== operation.identity.policyFingerprint
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expectedReceipt'],
          message: 'Stored terminal expectation does not match its operation',
        });
      }
    }
    const seen = new Set<string>();
    for (const [index, guard] of value.guards.entries()) {
      if (seen.has(guard.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['guards', index],
          message: 'Duplicate selected row guard',
        });
      }
      seen.add(guard.id);
    }
    const operationIds = new Set<string>();
    for (const [index, audit] of value.operationAudits.entries()) {
      if (operationIds.has(audit.operationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operationAudits', index],
          message: 'Duplicate operation audit guard',
        });
      }
      operationIds.add(audit.operationId);
    }
    if (value.expectedOperation) {
      const currentAudit = value.operationAudits.find(
        (audit) => audit.operationId === value.metadata.operationId,
      );
      const expectedAttempts = value.expectedOperation.attempts;
      const expectedAuditTruncated = value.expectedOperation.auditTruncated;
      const storedPrefix = currentAudit ? expectedAttempts.slice(0, currentAudit.prefixCount) : [];
      const addedCompletionAttempt =
        !!currentAudit && currentAudit.prefixCount + 1 === expectedAttempts.length;
      const alreadyObservedCompletionAttempt =
        !!currentAudit && currentAudit.prefixCount === expectedAttempts.length;
      if (
        !currentAudit ||
        currentAudit.overflowCount !== value.expectedOperation.overflowCount ||
        hashAutomaticCaptureV2(storedPrefix) !== currentAudit.prefixHash ||
        (expectedAuditTruncated !== currentAudit.auditTruncated &&
          !(
            (currentAudit.auditTruncated === undefined || currentAudit.auditTruncated === false) &&
            expectedAuditTruncated === true &&
            expectedAttempts.length === AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation
          )) ||
        (!addedCompletionAttempt && !alreadyObservedCompletionAttempt) ||
        (addedCompletionAttempt &&
          (expectedAttempts.at(-1)?.attemptHash !== value.metadata.audit.attemptIdHash ||
            expectedAttempts.at(-1)?.disposition !== 'committed')) ||
        (alreadyObservedCompletionAttempt &&
          !expectedAttempts.some(
            (attempt) => attempt.attemptHash === value.metadata.audit.attemptIdHash,
          ) &&
          !(
            expectedAttempts.length === AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation &&
            value.expectedOperation.auditTruncated === true
          ))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operationAudits'],
          message: 'Committed operation audit must extend the leased prefix by at most one attempt',
        });
      }
    }
  });

export const CompositionalCompletionPreparedStageDataV3Schema = z
  .unknown()
  .transform((value, context) => {
    let snapshot: unknown;
    let serialized: string;
    try {
      snapshot = cloneBoundedAutomaticCaptureJson(value, 'assistantIntent');
      serialized = JSON.stringify(snapshot);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid completion stage data' });
      return z.NEVER;
    }
    if (Buffer.byteLength(serialized, 'utf8') > 576 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completion stage capacity exceeded',
      });
      return z.NEVER;
    }
    const parsed = stageCacheBody.safeParse(snapshot);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    const metadataBytes = Buffer.byteLength(JSON.stringify(parsed.data.metadata), 'utf8');
    const planBytes = Buffer.byteLength(JSON.stringify(parsed.data.plan), 'utf8');
    const receiptBytes = parsed.data.expectedReceipt
      ? Buffer.byteLength(JSON.stringify(parsed.data.expectedReceipt), 'utf8')
      : 0;
    const operationBytes = parsed.data.expectedOperation
      ? Buffer.byteLength(JSON.stringify(parsed.data.expectedOperation), 'utf8')
      : 0;
    if (
      metadataBytes > 4 * 1024 ||
      planBytes > 512 * 1024 ||
      Buffer.byteLength(
        JSON.stringify({
          guards: parsed.data.guards,
          operationAudits: parsed.data.operationAudits,
        }),
        'utf8',
      ) >
        24 * 1024 ||
      receiptBytes > AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes ||
      operationBytes > AUTOMATIC_LEDGER_LIMITS.operationBytes ||
      Buffer.byteLength(
        JSON.stringify({
          metadata: parsed.data.metadata,
          interpretation: parsed.data.interpretation,
        }),
        'utf8',
      ) >
        4 * 1024
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completion stage component capacity exceeded',
      });
      return z.NEVER;
    }
    return parsed.data;
  });
export type CompositionalCompletionPreparedStageDataV3 = z.infer<
  typeof CompositionalCompletionPreparedStageDataV3Schema
>;

const applyCandidateBody = z
  .object({
    plan: CompositionalMaterializationPreparedV3Schema,
    receipt: CompositionalAutomaticCaptureTerminalReceiptV3Schema,
    operation: CompositionalAutomaticCaptureOperationV3Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const operation = value.operation;
    if (
      operation.state !== 'committed' ||
      operation.terminalReceipt.kind !== 'human_compositional_capture_committed' ||
      JSON.stringify(operation.terminalReceipt) !== JSON.stringify(value.receipt) ||
      operation.operationId !== value.plan.sourceGuard.operationId ||
      operation.identity.sourceId !== value.plan.sourceGuard.sourceId ||
      operation.completionCallHash.length !== 64
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completion candidate links disagree',
      });
    }
  });

export const CompositionalCompletionPreparedApplyCandidateV3Schema = z
  .unknown()
  .transform((value, context) => {
    let snapshot: unknown;
    let serialized: string;
    try {
      snapshot = cloneBoundedAutomaticCaptureJson(value, 'assistantIntent');
      serialized = JSON.stringify(snapshot);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid completion apply candidate',
      });
      return z.NEVER;
    }
    if (Buffer.byteLength(serialized, 'utf8') > 576 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completion apply candidate capacity exceeded',
      });
      return z.NEVER;
    }
    const parsed = applyCandidateBody.safeParse(snapshot);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    return parsed.data;
  });
export type CompositionalCompletionPreparedApplyCandidateV3 = z.infer<
  typeof CompositionalCompletionPreparedApplyCandidateV3Schema
>;

declare const stageBrand: unique symbol;
/** Empty, frozen token whose private WeakMap record belongs to one factory/cap. */
export type CompositionalCompletionStageV3 = Readonly<{
  [stageBrand]: 'compositional_completion_stage';
}>;

const stageTokenSchema = z.custom<CompositionalCompletionStageV3>(
  (value) => value !== null && typeof value === 'object',
);

const deferredResult = z
  .object({
    status: z.literal('deferred'),
    reason: CompositionalCompletionStageDeferredReasonV3Schema,
  })
  .strict();
export const CompositionalCompletionPreparedStageResultV3Schema = z.union([
  z.object({ status: z.literal('prepared_stage'), stage: stageTokenSchema }).strict(),
  deferredResult,
]);
export type CompositionalCompletionPreparedStageResultV3 = z.infer<
  typeof CompositionalCompletionPreparedStageResultV3Schema
>;

export const CompositionalCompletionPreparedApplyResultV3Schema = z.union([
  z
    .object({
      status: z.literal('prepared_apply'),
      candidate: CompositionalCompletionPreparedApplyCandidateV3Schema,
    })
    .strict(),
  deferredResult,
]);
export type CompositionalCompletionPreparedApplyResultV3 = z.infer<
  typeof CompositionalCompletionPreparedApplyResultV3Schema
>;

export type CompositionalCompletionStageFactoryCallbacksV3 = Readonly<{
  authenticate(capability: unknown): void;
  resolve(
    capability: unknown,
    actualValue: unknown,
    expectedState: 'leased' | 'committed',
  ): {
    actual: import('./CompositionalAutomaticCaptureRegistryV3.schema').CompositionalCaptureRegistryActualV3;
    invocation: import('./CompositionalAutomaticCaptureRegistryV3.schema').CompositionalCaptureCompletionInvocationV3;
  } | null;
  readCompletionAudit(
    capability: unknown,
  ): import('./CompositionalAutomaticCaptureRegistryV3.schema').CompositionalCaptureAttemptAuditV3;
}>;

export { SourceHydrationBudgetSchema as CompositionalCompletionStageBudgetV3Schema };
export type CompositionalCompletionStageBudgetV3 = SourceHydrationBudget;

export { CompositionalAutomaticCaptureOperationV3Schema as CompletionCommittedOperationV3Schema };
