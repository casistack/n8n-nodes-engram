import { z } from 'zod';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptDispositionSchema,
} from './AutomaticLedgerPrimitives.schema';
import {
  AutonomousPersonalDescriptorV4OwnedDataSchema,
  hashAutonomousPersonalDescriptorV4,
} from './AutonomousPersonalDescriptorV4.schema';
import { AutonomousPersonalOperationIdentityV4OwnedDataSchema } from './AutonomousPersonalSourceV4.schema';

const HASH_64 = /^[a-f0-9]{64}$/u;
const UUID = z.string().uuid();
const HASH = z.string().regex(HASH_64);
const RECEIPT_MAX_BYTES = AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes;
const OPERATION_MAX_BYTES = AUTOMATIC_LEDGER_LIMITS.operationBytes;

const canonicalUtcMilliseconds = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  });

const coverageReason = z.enum([
  'ambiguous_scope',
  'retroactive_correction',
  'unsupported_scope',
  'provider_unknown',
  'provider_failure',
  'policy_not_selected',
  'interpretation_capacity',
  'indeterminate_suffix',
  'unmatched_quote',
  'mismatched_quote',
  'unmatched_bracket',
  'mismatched_bracket',
  'unsupported_quote_escape',
  'nesting_limit',
  'ambiguous_period_boundary',
  'multiple',
]);

const resourceReason = z.enum(['lexical_token_limit', 'unit_limit']);
const frameReason = new Set([
  'indeterminate_suffix',
  'unmatched_quote',
  'mismatched_quote',
  'unmatched_bracket',
  'mismatched_bracket',
  'unsupported_quote_escape',
  'nesting_limit',
  'ambiguous_period_boundary',
]);

const sourceCoverageSchema = z
  .object({
    status: z.enum(['complete', 'partial', 'unknown', 'not_reported']),
    scanStatus: z.enum(['complete', 'indeterminate_suffix', 'resource_limit']),
    sourceUnitCount: z.number().int().min(0).max(128).nullable(),
    candidateUnitCount: z.number().int().min(0).max(128),
    neutralUnitCount: z.number().int().min(0).max(128),
    withheldUnitCount: z.number().int().min(0).max(128),
    unresolvedUnitCount: z.number().int().min(0).max(128).nullable(),
    unresolvedReason: z.union([coverageReason, resourceReason]).nullable(),
  })
  .strict()
  .superRefine((coverage, context) => {
    const invalid = (path: Array<string | number> = []) =>
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'Invalid source coverage summary',
      });
    const known =
      coverage.candidateUnitCount + coverage.neutralUnitCount + coverage.withheldUnitCount;

    if (coverage.status === 'complete' || coverage.status === 'partial') {
      if (
        coverage.scanStatus !== 'complete' ||
        coverage.sourceUnitCount === null ||
        coverage.unresolvedUnitCount === null ||
        known + coverage.unresolvedUnitCount !== coverage.sourceUnitCount
      ) {
        invalid();
        return;
      }
      if (coverage.status === 'complete') {
        if (coverage.unresolvedUnitCount !== 0 || coverage.unresolvedReason !== null) invalid();
      } else if (
        known === 0 ||
        coverage.unresolvedUnitCount === 0 ||
        coverage.unresolvedReason === null ||
        (typeof coverage.unresolvedReason === 'string' &&
          (frameReason.has(coverage.unresolvedReason) ||
            coverage.unresolvedReason === 'indeterminate_suffix' ||
            coverage.unresolvedReason === 'provider_failure' ||
            coverage.unresolvedReason === 'interpretation_capacity' ||
            coverage.unresolvedReason === 'policy_not_selected' ||
            coverage.unresolvedReason === 'lexical_token_limit' ||
            coverage.unresolvedReason === 'unit_limit'))
      ) {
        invalid();
      }
      return;
    }

    if (coverage.status === 'unknown') {
      if (
        coverage.candidateUnitCount !== 0 ||
        coverage.neutralUnitCount !== 0 ||
        coverage.withheldUnitCount !== 0 ||
        coverage.unresolvedReason === null
      ) {
        invalid();
        return;
      }
      if (coverage.scanStatus === 'complete') {
        if (
          coverage.sourceUnitCount === null ||
          coverage.sourceUnitCount < 1 ||
          coverage.unresolvedUnitCount !== coverage.sourceUnitCount ||
          coverage.unresolvedReason === 'indeterminate_suffix' ||
          coverage.unresolvedReason === 'unmatched_quote' ||
          coverage.unresolvedReason === 'mismatched_quote' ||
          coverage.unresolvedReason === 'unmatched_bracket' ||
          coverage.unresolvedReason === 'mismatched_bracket' ||
          coverage.unresolvedReason === 'unsupported_quote_escape' ||
          coverage.unresolvedReason === 'nesting_limit' ||
          coverage.unresolvedReason === 'ambiguous_period_boundary' ||
          coverage.unresolvedReason === 'lexical_token_limit' ||
          coverage.unresolvedReason === 'unit_limit'
        )
          invalid();
      } else if (coverage.scanStatus === 'indeterminate_suffix') {
        if (
          coverage.sourceUnitCount !== null ||
          coverage.unresolvedUnitCount !== null ||
          (typeof coverage.unresolvedReason !== 'string' &&
            coverage.unresolvedReason !== 'indeterminate_suffix') ||
          (typeof coverage.unresolvedReason === 'string' &&
            !frameReason.has(coverage.unresolvedReason))
        )
          invalid();
      } else invalid();
      return;
    }

    if (
      coverage.scanStatus !== 'resource_limit' ||
      coverage.sourceUnitCount !== null ||
      coverage.unresolvedUnitCount !== null ||
      coverage.candidateUnitCount !== 0 ||
      coverage.neutralUnitCount !== 0 ||
      coverage.withheldUnitCount !== 0 ||
      (coverage.unresolvedReason !== 'lexical_token_limit' &&
        coverage.unresolvedReason !== 'unit_limit')
    )
      invalid();
  });

/** Reused by bounded selection DATA; no source or lifecycle authority is implied. */
export const AutonomousPersonalSourceCoverageV4OwnedDataSchema = sourceCoverageSchema;

export type AutonomousPersonalSourceCoverageV4 = z.infer<typeof sourceCoverageSchema>;

const notSelectedReason = z.enum([
  'explicit_intent_required',
  'existing_ineligible',
  'legacy_reuse_not_authorized',
  'possible_overlap',
  'unknown_overlap_domain',
]);
const occurrenceStateSchema = z.enum(['accepted', 'proposed', 'rejected', 'not_selected']);
const occurrenceEffectSchema = z.enum(['created', 'reference', 'none']);
const occurrenceReasonSchema = z.enum([
  'eligible_create',
  'existing_accepted',
  'profile_review_required',
  'existing_proposed',
  'existing_rejected',
  'explicit_intent_required',
  'existing_ineligible',
  'legacy_reuse_not_authorized',
  'possible_overlap',
  'unknown_overlap_domain',
]);

type OccurrenceStateEffectDataV4 = {
  state: z.infer<typeof occurrenceStateSchema>;
  effect: z.infer<typeof occurrenceEffectSchema>;
  claimId: string | null;
  reason: z.infer<typeof occurrenceReasonSchema>;
};

/** Shared by persisted occurrence items and their minimal summary projection. */
export function addAutonomousPersonalOccurrenceStateEffectIssuesV4(
  item: OccurrenceStateEffectDataV4,
  context: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
): void {
  const invalid = (message: string) =>
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, 'reason'],
      message,
    });
  const expectedReason =
    item.state === 'accepted'
      ? item.effect === 'created'
        ? 'eligible_create'
        : item.effect === 'reference'
          ? 'existing_accepted'
          : null
      : item.state === 'proposed'
        ? item.effect === 'created'
          ? 'profile_review_required'
          : item.effect === 'reference'
            ? 'existing_proposed'
            : null
        : item.state === 'rejected'
          ? item.effect === 'reference'
            ? 'existing_rejected'
            : null
          : item.effect === 'none' && item.claimId === null
            ? item.reason
            : null;
  if (item.state === 'not_selected') {
    if (
      item.effect !== 'none' ||
      item.claimId !== null ||
      !notSelectedReason.safeParse(item.reason).success
    ) {
      invalid('Not-selected items require a fixed reason and no claim');
    }
  } else if (item.effect === 'none' || item.claimId === null || expectedReason !== item.reason) {
    invalid('State, effect, claim and reason do not agree');
  }
}

const occurrenceItemSchema = z
  .object({
    occurrenceIndex: z.number().int().min(0).max(31),
    kind: z.enum(['typed_preference', 'source_statement_record']),
    evidenceHash: HASH,
    meaningHash: HASH,
    dependencies: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(31),
            dependencyHash: HASH,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    state: occurrenceStateSchema,
    effect: occurrenceEffectSchema,
    claimId: UUID.nullable(),
    reason: occurrenceReasonSchema,
  })
  .strict()
  .superRefine((item, context) => {
    const invalid = (path: Array<string | number>, message = 'Invalid occurrence item') =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (item.dependencies.some((dependency, index) => dependency.index !== index)) {
      invalid(['dependencies'], 'Dependency indexes must be contiguous and ordered');
    }
    if (
      item.kind === 'source_statement_record' &&
      (item.dependencies.length !== 1 || item.dependencies[0].index !== 0)
    ) {
      invalid(['dependencies'], 'A source statement has exactly one dependency at index zero');
    }
    addAutonomousPersonalOccurrenceStateEffectIssuesV4(item, context);
  });

type AutonomousPersonalOccurrenceItemV4 = z.infer<typeof occurrenceItemSchema>;

const receiptCommonV4 = {
  version: z.literal(4),
  operationId: UUID,
  sourceId: UUID,
  sourceHash: HASH,
  descriptorHash: HASH,
  policyFingerprint: HASH,
  terminalAt: canonicalUtcMilliseconds,
};

const occurrenceReceiptBranch = z
  .object({
    ...receiptCommonV4,
    kind: z.literal('human_autonomous_capture_committed'),
    interpretationCoverage: z.enum(['complete', 'partial']),
    acceptedCoverage: z.enum(['all', 'partial', 'none']),
    acceptanceSemantics: z.literal('per_item_kind_v1'),
    sourceCoverage: sourceCoverageSchema,
    selection: z
      .object({
        kind: z.literal('occurrences'),
        items: z.array(occurrenceItemSchema).min(1).max(32),
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const invalid = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const coverage = receipt.sourceCoverage;
    const items = receipt.selection.items;
    if (
      receipt.interpretationCoverage !== coverage.status ||
      (coverage.status !== 'complete' && coverage.status !== 'partial') ||
      coverage.scanStatus !== 'complete' ||
      coverage.sourceUnitCount === null ||
      coverage.sourceUnitCount < 1 ||
      coverage.sourceUnitCount > 32 ||
      coverage.candidateUnitCount < 1 ||
      coverage.candidateUnitCount > items.length
    ) {
      invalid(['sourceCoverage'], 'Occurrence receipt coverage does not match its items');
    }
    if (items.some((item, index) => item.occurrenceIndex !== index)) {
      invalid(['selection', 'items'], 'Occurrence indexes must be contiguous and ordered');
    }
    if (new Set(items.map((item) => item.evidenceHash)).size !== items.length) {
      invalid(['selection', 'items'], 'Occurrence evidence hashes must be unique');
    }
    const dependencyCount = items.reduce((total, item) => total + item.dependencies.length, 0);
    if (dependencyCount > 32) {
      invalid(['selection', 'items'], 'Receipt exceeds the global dependency limit');
    }
    const accepted = items.filter((item) => item.state === 'accepted').length;
    const expectedCoverage =
      accepted === 0 ? 'none' : accepted === items.length ? 'all' : 'partial';
    if (receipt.acceptedCoverage !== expectedCoverage) {
      invalid(['acceptedCoverage'], 'Accepted coverage must match the listed items');
    }

    const groups = new Map<string, AutonomousPersonalOccurrenceItemV4[]>();
    const claimMeaning = new Map<string, string>();
    const meaningClaim = new Map<string, string>();
    for (const item of items) {
      const logicalPair = `${item.kind}:${item.meaningHash}`;
      const group = groups.get(logicalPair) ?? [];
      group.push(item);
      groups.set(logicalPair, group);
      if (item.claimId !== null) {
        const priorMeaning = claimMeaning.get(item.claimId);
        if (priorMeaning !== undefined && priorMeaning !== logicalPair) {
          invalid(['selection', 'items'], 'One claim ID cannot link different meanings');
        }
        claimMeaning.set(item.claimId, logicalPair);
        const priorClaim = meaningClaim.get(logicalPair);
        if (priorClaim !== undefined && priorClaim !== item.claimId) {
          invalid(['selection', 'items'], 'One meaning cannot link multiple claim IDs');
        }
        meaningClaim.set(logicalPair, item.claimId);
      }
    }

    for (const duplicateItems of groups.values()) {
      if (duplicateItems.length < 2) continue;
      const first = duplicateItems[0];
      const sameDependencies = JSON.stringify(first.dependencies);
      if (
        duplicateItems.some(
          (item) =>
            item.state !== first.state ||
            item.claimId !== first.claimId ||
            JSON.stringify(item.dependencies) !== sameDependencies,
        )
      ) {
        invalid(
          ['selection', 'items'],
          'Duplicate meaning items must agree on state, ID and dependencies',
        );
        continue;
      }
      if (first.state === 'not_selected') {
        if (
          duplicateItems.some(
            (item) =>
              item.effect !== 'none' || item.reason !== first.reason || item.claimId !== null,
          )
        )
          invalid(['selection', 'items'], 'Not-selected duplicates must use one consistent reason');
        continue;
      }
      const createdCount = duplicateItems.filter((item) => item.effect === 'created').length;
      if (createdCount > 1 || duplicateItems.some((item) => item.effect === 'none')) {
        invalid(['selection', 'items'], 'A meaning group may have at most one creator');
      }
    }
  });

/** Existing Receipt4 branch schemas, exported for strict DATA-only projections. */
export const AutonomousPersonalOccurrenceReceiptV4OwnedDataSchema = occurrenceReceiptBranch;

const sourceVerdictOutcomeSchema = z.enum([
  'known_no_memory',
  'unsupported_source',
  'unknown_source',
  'policy_not_selected',
]);

type SourceVerdictCoverageDataV4 = {
  interpretationCoverage: string;
  sourceCoverage: z.infer<typeof sourceCoverageSchema>;
  selection: { outcome: z.infer<typeof sourceVerdictOutcomeSchema> };
};

/** Shared by the full Receipt4 branch and its bounded summary projection. */
export function addAutonomousPersonalSourceVerdictCoverageIssuesV4(
  receipt: SourceVerdictCoverageDataV4,
  context: z.RefinementCtx,
  interpretationMismatchPath: Array<string | number> = ['sourceCoverage'],
  interpretationMismatchMessage = 'Source verdict and coverage do not agree',
): void {
  const invalid = () =>
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceCoverage'],
      message: 'Source verdict and coverage do not agree',
    });
  const coverage = receipt.sourceCoverage;
  if (receipt.interpretationCoverage !== coverage.status) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: interpretationMismatchPath,
      message: interpretationMismatchMessage,
    });
  }
  if (coverage.status === 'not_reported') invalid();

  switch (receipt.selection.outcome) {
    case 'known_no_memory':
      if (
        coverage.status !== 'complete' ||
        coverage.scanStatus !== 'complete' ||
        coverage.sourceUnitCount === null ||
        coverage.sourceUnitCount > 32 ||
        coverage.candidateUnitCount !== 0 ||
        coverage.withheldUnitCount !== 0 ||
        coverage.unresolvedUnitCount !== 0 ||
        coverage.neutralUnitCount !== coverage.sourceUnitCount
      )
        invalid();
      break;
    case 'unsupported_source':
      if (
        coverage.status !== 'complete' ||
        coverage.scanStatus !== 'complete' ||
        coverage.sourceUnitCount === null ||
        coverage.sourceUnitCount < 1 ||
        coverage.sourceUnitCount > 32 ||
        coverage.candidateUnitCount !== 0 ||
        coverage.withheldUnitCount < 1 ||
        coverage.unresolvedUnitCount !== 0
      )
        invalid();
      break;
    case 'policy_not_selected':
      if (
        coverage.status !== 'unknown' ||
        coverage.scanStatus !== 'complete' ||
        coverage.sourceUnitCount === null ||
        coverage.sourceUnitCount < 1 ||
        coverage.sourceUnitCount > 32 ||
        coverage.candidateUnitCount !== 0 ||
        coverage.neutralUnitCount !== 0 ||
        coverage.withheldUnitCount !== 0 ||
        coverage.unresolvedUnitCount !== coverage.sourceUnitCount ||
        coverage.unresolvedReason !== 'policy_not_selected'
      )
        invalid();
      break;
    case 'unknown_source':
      if (
        coverage.candidateUnitCount !== 0 ||
        (coverage.status !== 'partial' && coverage.status !== 'unknown') ||
        coverage.unresolvedReason === 'provider_failure' ||
        coverage.unresolvedReason === 'interpretation_capacity' ||
        coverage.unresolvedReason === 'policy_not_selected'
      )
        invalid();
      if (
        coverage.scanStatus === 'complete' &&
        (coverage.sourceUnitCount === null || coverage.sourceUnitCount > 32)
      )
        invalid();
      break;
  }
}

const sourceVerdictReceiptBranch = z
  .object({
    ...receiptCommonV4,
    kind: z.literal('human_autonomous_source_verdict_committed'),
    interpretationCoverage: z.enum(['complete', 'partial', 'unknown']),
    acceptedCoverage: z.literal('none'),
    acceptanceSemantics: z.literal('per_item_kind_v1'),
    sourceCoverage: sourceCoverageSchema,
    selection: z
      .object({
        kind: z.literal('source_verdict'),
        outcome: sourceVerdictOutcomeSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    addAutonomousPersonalSourceVerdictCoverageIssuesV4(receipt, context);
  });

/** Existing Receipt4 branch schemas, exported for strict DATA-only projections. */
export const AutonomousPersonalSourceVerdictReceiptV4OwnedDataSchema = sourceVerdictReceiptBranch;

const fixedExtractionFailure = z.enum([
  'provider_invalid_request',
  'provider_auth',
  'provider_rate_limit',
  'provider_unavailable',
  'provider_network',
  'provider_invalid_response',
  'provider_subdeadline',
  'provider_request_bytes',
  'provider_response_bytes',
  'interpretation_capacity',
]);

type DeferredCoverageDataV4 = {
  selection: { reason: z.infer<typeof fixedExtractionFailure> };
  sourceCoverage: z.infer<typeof sourceCoverageSchema>;
};

/** Shared by the full deferred Receipt4 branch and its bounded summary projection. */
export function addAutonomousPersonalDeferredCoverageIssuesV4(
  receipt: DeferredCoverageDataV4,
  context: z.RefinementCtx,
): void {
  const coverage = receipt.sourceCoverage;
  const invalid = () =>
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceCoverage'],
      message: 'Deferred receipt and coverage do not agree',
    });
  if (
    coverage.candidateUnitCount !== 0 ||
    coverage.neutralUnitCount !== 0 ||
    coverage.withheldUnitCount !== 0
  ) {
    invalid();
    return;
  }
  if (coverage.status === 'not_reported') {
    if (
      coverage.scanStatus !== 'resource_limit' ||
      receipt.selection.reason !== 'interpretation_capacity'
    )
      invalid();
    return;
  }
  if (
    coverage.status !== 'unknown' ||
    coverage.scanStatus !== 'complete' ||
    coverage.sourceUnitCount === null ||
    coverage.sourceUnitCount < 1 ||
    coverage.unresolvedUnitCount !== coverage.sourceUnitCount
  ) {
    invalid();
    return;
  }
  const providerFailure = receipt.selection.reason !== 'interpretation_capacity';
  if (
    (providerFailure &&
      (coverage.sourceUnitCount > 32 || coverage.unresolvedReason !== 'provider_failure')) ||
    (!providerFailure && coverage.unresolvedReason !== 'interpretation_capacity')
  )
    invalid();
}

const deferredReceiptBranch = z
  .object({
    ...receiptCommonV4,
    kind: z.literal('human_autonomous_source_deferred_committed'),
    interpretationCoverage: z.literal('unknown'),
    acceptedCoverage: z.literal('none'),
    acceptanceSemantics: z.literal('per_item_kind_v1'),
    sourceCoverage: sourceCoverageSchema,
    selection: z
      .object({ kind: z.literal('source_only_deferred'), reason: fixedExtractionFailure })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    addAutonomousPersonalDeferredCoverageIssuesV4(receipt, context);
  });

/** Existing Receipt4 branch schemas, exported for strict DATA-only projections. */
export const AutonomousPersonalDeferredReceiptV4OwnedDataSchema = deferredReceiptBranch;

const cancelledReceiptBranch = z
  .object({
    ...receiptCommonV4,
    kind: z.literal('cancelled'),
    acceptedCoverage: z.literal('none'),
  })
  .strict();

/** Existing Receipt4 branch schema, exported for strict DATA-only projections. */
export const AutonomousPersonalCancelledReceiptV4OwnedDataSchema = cancelledReceiptBranch;

export const AutonomousPersonalReceiptV4OwnedDataSchema = z
  .union([
    occurrenceReceiptBranch,
    sourceVerdictReceiptBranch,
    deferredReceiptBranch,
    cancelledReceiptBranch,
  ])
  .superRefine((receipt, context) => {
    if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > RECEIPT_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Receipt exceeds the 16 KiB limit',
      });
    }
  });

export type AutonomousPersonalReceiptV4 = z.infer<
  typeof AutonomousPersonalReceiptV4OwnedDataSchema
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function invalidData(code: string): z.ZodError {
  const path: Array<string | number> = [];
  Object.freeze(path);
  const issue = Object.freeze({ code: z.ZodIssueCode.custom, path, message: code }) as z.ZodIssue;
  const error = new z.ZodError([issue]);
  Object.freeze(error.issues);
  return Object.freeze(error);
}

function parseBoundedReceipt(value: unknown): AutonomousPersonalReceiptV4 {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'policyData');
  const serialized = JSON.stringify(owned);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > RECEIPT_MAX_BYTES) {
    throw invalidData('invalid_autonomous_receipt_data');
  }
  return deepFreeze(AutonomousPersonalReceiptV4OwnedDataSchema.parse(owned));
}

export const AutonomousPersonalReceiptV4Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalReceiptV4 {
    try {
      return parseBoundedReceipt(value);
    } catch {
      throw invalidData('invalid_autonomous_receipt_data');
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalReceiptV4> {
    try {
      return { success: true, data: parseBoundedReceipt(value) };
    } catch {
      return { success: false, error: invalidData('invalid_autonomous_receipt_data') };
    }
  },
});

const generation = z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration);

const attemptV4Schema = z
  .object({
    attemptHash: HASH,
    at: canonicalUtcMilliseconds,
    disposition: AutomaticOperationAttemptDispositionSchema,
  })
  .strict()
  .refine(
    (attempt) =>
      Buffer.byteLength(JSON.stringify(attempt), 'utf8') <= AUTOMATIC_LEDGER_LIMITS.attemptBytes,
    { message: 'Operation attempt exceeds the 256-byte limit' },
  );

export type AutonomousPersonalOperationAttemptV4 = z.infer<typeof attemptV4Schema>;

const leaseV4Schema = z
  .object({
    token: UUID,
    acquiredAt: canonicalUtcMilliseconds,
    renewedAt: canonicalUtcMilliseconds,
    expiresAt: canonicalUtcMilliseconds,
    claimKind: z.enum(['initial', 'resume']),
  })
  .strict();

const operationCommonV4 = {
  version: z.literal(4),
  operationId: UUID,
  identity: AutonomousPersonalOperationIdentityV4OwnedDataSchema,
  descriptor: AutonomousPersonalDescriptorV4OwnedDataSchema,
  createdAt: canonicalUtcMilliseconds,
  lastObservedAt: canonicalUtcMilliseconds,
  attempts: z.array(attemptV4Schema).max(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation),
  overflowCount: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.overflowCounterMax),
  auditTruncated: z.boolean().optional(),
  lastResumeCause: z.enum(['lease_expired', 'failed', 'interrupted']).optional(),
  beginCallHash: HASH,
  retryCount: z.number().int().min(0).max(3),
  lastRetryCallHash: HASH.optional(),
};

/** Existing V4 failed-operation codes, also reused by handle-free Begin4 result DATA. */
export const AutonomousPersonalOperationV4FailedFailureCodeSchema = z.enum([
  'graph_conflict',
  'invalid_plan',
  'storage_error',
  'budget_exhausted',
  'capacity',
  'unknown',
]);
export type AutonomousPersonalOperationV4FailedFailureCode = z.infer<
  typeof AutonomousPersonalOperationV4FailedFailureCodeSchema
>;

/** Existing V4 interrupted-operation codes, also reused by handle-free Begin4 result DATA. */
export const AutonomousPersonalOperationV4InterruptedFailureCodeSchema = z.enum([
  'invocation_interrupted',
  'lease_expired',
  'storage_error',
  'unknown',
]);
export type AutonomousPersonalOperationV4InterruptedFailureCode = z.infer<
  typeof AutonomousPersonalOperationV4InterruptedFailureCodeSchema
>;

const operationVariantsV4 = z.discriminatedUnion('state', [
  z
    .object({ ...operationCommonV4, state: z.literal('captured'), generation: z.literal(0) })
    .strict(),
  z
    .object({
      ...operationCommonV4,
      state: z.literal('leased'),
      generation,
      lease: leaseV4Schema,
    })
    .strict(),
  z
    .object({
      ...operationCommonV4,
      state: z.literal('failed'),
      generation,
      failedAt: canonicalUtcMilliseconds,
      failureCode: AutonomousPersonalOperationV4FailedFailureCodeSchema,
    })
    .strict(),
  z
    .object({
      ...operationCommonV4,
      state: z.literal('interrupted'),
      generation,
      interruptedAt: canonicalUtcMilliseconds,
      failureCode: AutonomousPersonalOperationV4InterruptedFailureCodeSchema,
    })
    .strict(),
  z
    .object({
      ...operationCommonV4,
      state: z.literal('committed'),
      generation,
      terminalReceipt: AutonomousPersonalReceiptV4OwnedDataSchema,
      completionCallHash: HASH,
    })
    .strict(),
  z
    .object({
      ...operationCommonV4,
      state: z.literal('cancelled'),
      generation: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
      terminalReceipt: AutonomousPersonalReceiptV4OwnedDataSchema,
    })
    .strict(),
]);

export const AutonomousPersonalOperationV4OwnedDataSchema = operationVariantsV4.superRefine(
  (operation, context) => {
    const invalid = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const createdAt = Date.parse(operation.createdAt);
    const lastObservedAt = Date.parse(operation.lastObservedAt);
    if (createdAt > lastObservedAt) invalid(['lastObservedAt'], 'Observation precedes creation');

    const descriptorHash = hashAutonomousPersonalDescriptorV4(operation.descriptor);
    if (
      operation.identity.descriptorHash !== descriptorHash ||
      operation.identity.settingsHash !== operation.descriptor.settingsHash ||
      operation.identity.policyFingerprint !== operation.descriptor.policy.fingerprint
    ) {
      invalid(['identity'], 'Operation identity and descriptor do not agree');
    }
    if ((operation.retryCount === 0) !== (operation.lastRetryCallHash === undefined)) {
      invalid(['retryCount'], 'Retry count and retry hash must appear together');
    }
    if (operation.state === 'captured' && operation.retryCount !== 0) {
      invalid(['retryCount'], 'Captured operations have no conflict retries');
    }
    if (operation.lastResumeCause !== undefined && operation.generation < 2) {
      invalid(['lastResumeCause'], 'Resume cause requires generation two or later');
    }

    const attemptHashes = new Set<string>();
    let previousAttemptAt = createdAt;
    for (const [index, attempt] of operation.attempts.entries()) {
      const attemptAt = Date.parse(attempt.at);
      if (attemptHashes.has(attempt.attemptHash)) {
        invalid(['attempts', index, 'attemptHash'], 'Attempt hashes must be unique');
      }
      attemptHashes.add(attempt.attemptHash);
      if (attemptAt < previousAttemptAt || attemptAt > lastObservedAt) {
        invalid(
          ['attempts', index, 'at'],
          'Attempt times must be monotonic and within observation time',
        );
      }
      previousAttemptAt = attemptAt;
    }

    if (operation.state === 'leased') {
      const acquiredAt = Date.parse(operation.lease.acquiredAt);
      const renewedAt = Date.parse(operation.lease.renewedAt);
      const expiresAt = Date.parse(operation.lease.expiresAt);
      const duration = Math.min(
        AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
        Math.max(
          operation.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
          AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
        ),
      );
      if (
        acquiredAt < createdAt ||
        renewedAt < acquiredAt ||
        renewedAt > lastObservedAt ||
        expiresAt <= renewedAt ||
        expiresAt - renewedAt !== duration ||
        (operation.lease.claimKind === 'initial' && operation.generation !== 1) ||
        (operation.lease.claimKind === 'resume' && operation.generation < 2)
      ) {
        invalid(['lease'], 'Lease timestamps, generation and duration do not agree');
      }
    }

    if (
      (operation.state === 'failed' &&
        (Date.parse(operation.failedAt) < createdAt ||
          Date.parse(operation.failedAt) > lastObservedAt)) ||
      (operation.state === 'interrupted' &&
        (Date.parse(operation.interruptedAt) < createdAt ||
          Date.parse(operation.interruptedAt) > lastObservedAt))
    ) {
      invalid([], 'Failure time is outside the operation interval');
    }

    if (operation.state === 'committed' || operation.state === 'cancelled') {
      const receipt = operation.terminalReceipt;
      const descriptorHashMatches = receipt.descriptorHash === descriptorHash;
      const expectedKind =
        operation.state === 'cancelled'
          ? receipt.kind === 'cancelled'
          : receipt.kind !== 'cancelled';
      if (
        !expectedKind ||
        receipt.operationId !== operation.operationId ||
        receipt.sourceId !== operation.identity.sourceId ||
        receipt.sourceHash !== operation.identity.sourceHash ||
        !descriptorHashMatches ||
        receipt.policyFingerprint !== operation.descriptor.policy.fingerprint ||
        Date.parse(receipt.terminalAt) < createdAt ||
        Date.parse(receipt.terminalAt) > lastObservedAt
      ) {
        invalid(['terminalReceipt'], 'Terminal receipt does not match operation identity and time');
      }
    }

    if (Buffer.byteLength(JSON.stringify(operation), 'utf8') > OPERATION_MAX_BYTES) {
      invalid([], 'Operation exceeds the 32 KiB limit');
    }
  },
);

export type AutonomousPersonalOperationV4 = z.infer<
  typeof AutonomousPersonalOperationV4OwnedDataSchema
>;

function parseBoundedOperation(value: unknown): AutonomousPersonalOperationV4 {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  const serialized = JSON.stringify(owned);
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > OPERATION_MAX_BYTES
  ) {
    throw invalidData('invalid_autonomous_operation_data');
  }
  if (owned !== null && typeof owned === 'object' && !Array.isArray(owned)) {
    const terminal = Object.getOwnPropertyDescriptor(owned, 'terminalReceipt');
    if (terminal && 'value' in terminal) {
      const serializedReceipt = JSON.stringify(terminal.value);
      if (
        typeof serializedReceipt !== 'string' ||
        Buffer.byteLength(serializedReceipt, 'utf8') > RECEIPT_MAX_BYTES
      )
        throw invalidData('invalid_autonomous_operation_data');
    }
  }
  return deepFreeze(AutonomousPersonalOperationV4OwnedDataSchema.parse(owned));
}

export const AutonomousPersonalOperationV4Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalOperationV4 {
    try {
      return parseBoundedOperation(value);
    } catch {
      throw invalidData('invalid_autonomous_operation_data');
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalOperationV4> {
    try {
      return { success: true, data: parseBoundedOperation(value) };
    } catch {
      return { success: false, error: invalidData('invalid_autonomous_operation_data') };
    }
  },
});
