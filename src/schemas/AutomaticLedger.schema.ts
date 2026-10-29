import { createHash } from 'crypto';
import { z } from 'zod';
import { compileAutomaticPolicy } from '../extraction/AutomaticEvidence';
import { AutomaticReceiptReasonSchema, AutomaticReceiptSchema } from './AutomaticClaim.schema';
import { AutomaticBindingReferenceSchema, AutomaticPolicySchema } from './AutomaticMemory.schema';
import { AutomaticWriteOwnerSchema } from './AutomaticClaim.schema';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from './AutomaticLedgerPrimitives.schema';
export {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptDispositionSchema,
  AutomaticOperationAttemptSchema,
} from './AutomaticLedgerPrimitives.schema';
export type { AutomaticOperationAttempt } from './AutomaticLedgerPrimitives.schema';
import {
  AutomaticCaptureOperationV2Schema,
  type AutomaticCaptureOperationV2,
} from './AutomaticCaptureOperation.schema';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  type CompositionalAutomaticCaptureOperationV3,
} from './CompositionalAutomaticCaptureV3.schema';
import {
  AutonomousPersonalOperationV4Schema,
  type AutonomousPersonalOperationV4,
} from './AutonomousPersonalOperationV4.schema';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);
const generation = z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const AutomaticOperationIdentitySchema = z
  .object({
    storeHash: hash,
    namespace: nonBlank(128),
    issuer: nonBlank(256),
    actorReference: nonBlank(512),
    turn: nonBlank(512),
    role: z.enum(['human', 'assistant']),
    sourceId: z.string().uuid(),
    sourceHash: hash,
    originalProducerHash: hash,
    binding: AutomaticBindingReferenceSchema.nullable(),
  })
  .strict();
export type AutomaticOperationIdentity = z.infer<typeof AutomaticOperationIdentitySchema>;

export const AutomaticOperationDescriptorSchema = z
  .object({
    version: z.literal(1),
    interpreterId: z.enum(['literal-parser-v1', 'compositional-preferences']),
    executionMode: z.enum(['synchronous', 'durable_memory_only']),
    semanticVersion: z.literal(1),
    grammarVersion: z.literal(1),
    lexiconVersion: z.literal(1),
    invocationDeadlineMs: z
      .number()
      .int()
      .min(AUTOMATIC_LEDGER_LIMITS.minInvocationDeadlineMs)
      .max(AUTOMATIC_LEDGER_LIMITS.maxInvocationDeadlineMs),
    routeConfigHash: hash,
    policy: AutomaticPolicySchema,
  })
  .strict()
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8') <= AUTOMATIC_LEDGER_LIMITS.descriptorBytes &&
      canonical(value.policy) ===
        canonical(compileAutomaticPolicy({ profileId: value.policy.profileId })),
    {
      message: 'Automatic operation descriptor must be bounded and use a code-owned policy',
    },
  );
export type AutomaticOperationDescriptor = z.infer<typeof AutomaticOperationDescriptorSchema>;

export const AutomaticLedgerCoverageSchema = z.enum(['all', 'partial', 'none', 'unknown']);

export const AutomaticLedgerDependencySchema = z
  .object({
    dependencyHash: hash,
    claimId: z.string().uuid().optional(),
    itemIndex: z.number().int().min(0).max(31),
    state: z.enum([
      'accepted',
      'proposed',
      'rejected',
      'deferred',
      'not_selected',
      'unchanged',
      'unknown',
    ]),
    persisted: z.boolean(),
    reasons: z.array(AutomaticReceiptReasonSchema).max(8),
  })
  .strict();
export type AutomaticLedgerDependency = z.infer<typeof AutomaticLedgerDependencySchema>;

export const AutomaticLedgerTerminalReceiptSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    sourceId: z.string().uuid(),
    sourceHash: hash,
    descriptorHash: hash,
    terminalAt: z.string().datetime(),
    coverage: AutomaticLedgerCoverageSchema,
    dependencies: z.array(AutomaticLedgerDependencySchema).max(32),
    receipt: AutomaticReceiptSchema,
  })
  .strict()
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8') <=
      AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes,
    { message: 'Automatic terminal receipt must not exceed 16 KiB serialized' },
  );
export type AutomaticLedgerTerminalReceipt = z.infer<typeof AutomaticLedgerTerminalReceiptSchema>;

const common = {
  version: z.literal(1),
  operationId: z.string().uuid(),
  identity: AutomaticOperationIdentitySchema,
  descriptor: AutomaticOperationDescriptorSchema.nullable(),
  createdAt: z.string().datetime(),
  lastObservedAt: z.string().datetime(),
  attempts: z
    .array(AutomaticOperationAttemptSchema)
    .max(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation),
  overflowCount: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.overflowCounterMax),
};

const captured = z
  .object({ ...common, state: z.literal('captured'), generation: z.literal(0) })
  .strict();

const leased = z
  .object({
    ...common,
    state: z.literal('leased'),
    generation,
    lease: z
      .object({
        token: z.string().uuid(),
        acquiredAt: z.string().datetime(),
        renewedAt: z.string().datetime(),
        expiresAt: z.string().datetime(),
        claimKind: z.enum(['initial', 'resume']),
      })
      .strict(),
  })
  .strict();

const failed = z
  .object({
    ...common,
    state: z.literal('failed'),
    generation,
    failedAt: z.string().datetime(),
    failureCode: z.enum([
      'graph_conflict',
      'invalid_plan',
      'provider_error',
      'storage_error',
      'budget_exhausted',
      'capacity',
      'unknown',
    ]),
  })
  .strict();

const interrupted = z
  .object({
    ...common,
    state: z.literal('interrupted'),
    generation,
    interruptedAt: z.string().datetime(),
    failureCode: z.enum(['invocation_interrupted', 'lease_expired', 'storage_error', 'unknown']),
  })
  .strict();

const committed = z
  .object({
    ...common,
    state: z.literal('committed'),
    generation,
    terminalReceipt: AutomaticLedgerTerminalReceiptSchema,
  })
  .strict();

const cancelled = z
  .object({
    ...common,
    state: z.literal('cancelled'),
    generation: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
    terminalReceipt: AutomaticLedgerTerminalReceiptSchema,
  })
  .strict();

const legacyUnconfirmed = z
  .object({
    ...common,
    descriptor: z.null(),
    state: z.literal('legacy_unconfirmed'),
    generation: z.literal(0),
  })
  .strict();

const AutomaticOperationVariantSchema = z.discriminatedUnion('state', [
  captured,
  leased,
  failed,
  interrupted,
  committed,
  cancelled,
  legacyUnconfirmed,
]);

export const AutomaticOperationSchema = AutomaticOperationVariantSchema.superRefine(
  (operation, context) => {
    const serialized = JSON.stringify(operation);
    if (Buffer.byteLength(serialized, 'utf8') > AUTOMATIC_LEDGER_LIMITS.operationBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Automatic operation must not exceed 32 KiB serialized',
      });
    }

    const createdAtMs = Date.parse(operation.createdAt);
    const lastObservedAtMs = Date.parse(operation.lastObservedAt);
    if (createdAtMs > lastObservedAtMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Last observed operation time must not precede creation',
        path: ['lastObservedAt'],
      });
    }
    let previousAttemptAt = createdAtMs;
    for (const [index, attempt] of operation.attempts.entries()) {
      const attemptAtMs = Date.parse(attempt.at);
      if (attemptAtMs < previousAttemptAt || attemptAtMs > lastObservedAtMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Attempt times must be monotonic and no later than last observation',
          path: ['attempts', index, 'at'],
        });
      }
      previousAttemptAt = attemptAtMs;
    }

    if (operation.state === 'legacy_unconfirmed') return;

    if (
      operation.state === 'leased' &&
      (Date.parse(operation.lease.expiresAt) <= Date.parse(operation.lease.renewedAt) ||
        Date.parse(operation.lease.acquiredAt) < createdAtMs ||
        Date.parse(operation.lease.renewedAt) < Date.parse(operation.lease.acquiredAt) ||
        Date.parse(operation.lease.renewedAt) > lastObservedAtMs)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lease times must follow creation and remain within last observation',
        path: ['lease', 'expiresAt'],
      });
    }

    if (!operation.descriptor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only legacy-unconfirmed operations may omit their descriptor',
        path: ['descriptor'],
      });
      return;
    }

    if (operation.state === 'leased') {
      const expectedLeaseMs = Math.min(
        AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
        Math.max(
          operation.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
          AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
        ),
      );
      if (
        Date.parse(operation.lease.expiresAt) - Date.parse(operation.lease.renewedAt) !==
        expectedLeaseMs
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Lease duration must match the captured invocation deadline',
          path: ['lease', 'expiresAt'],
        });
      }
    }

    if (
      (operation.state === 'failed' &&
        (Date.parse(operation.failedAt) < createdAtMs ||
          Date.parse(operation.failedAt) > lastObservedAtMs)) ||
      (operation.state === 'interrupted' &&
        (Date.parse(operation.interruptedAt) < createdAtMs ||
          Date.parse(operation.interruptedAt) > lastObservedAtMs))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Failure time must follow creation and not exceed last observation',
        path: [operation.state === 'failed' ? 'failedAt' : 'interruptedAt'],
      });
    }

    if (operation.state === 'committed' || operation.state === 'cancelled') {
      const terminal = operation.terminalReceipt;
      if (
        Date.parse(terminal.terminalAt) < createdAtMs ||
        Date.parse(terminal.terminalAt) > lastObservedAtMs
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Terminal time must follow creation and not exceed last observation',
          path: ['terminalReceipt', 'terminalAt'],
        });
      }
      if (operation.identity.role !== 'human') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Assistant write-owner receipts require a dedicated write-only schema',
          path: ['identity', 'role'],
        });
      }
      if (operation.descriptor.interpreterId !== 'literal-parser-v1') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Compositional receipts are unsupported until their schema is reviewed',
          path: ['descriptor'],
        });
      }
      if (operation.descriptor.policy.profileId === 'existing') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Existing-policy operations cannot produce automatic terminal acceptance',
          path: ['descriptor', 'policy', 'profileId'],
        });
      }
      if (
        terminal.operationId !== operation.operationId ||
        terminal.sourceId !== operation.identity.sourceId ||
        terminal.sourceHash !== operation.identity.sourceHash ||
        terminal.descriptorHash !== automaticOperationDescriptorHash(operation.descriptor)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Terminal receipt does not bind to the immutable operation identity',
          path: ['terminalReceipt'],
        });
      }
      if (
        terminal.receipt.sourceIds.length !== 1 ||
        terminal.receipt.sourceIds[0] !== operation.identity.sourceId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Terminal receipt must reference exactly the owned source',
          path: ['terminalReceipt', 'receipt', 'sourceIds'],
        });
      }
      if (canonical(terminal.receipt.policy) !== canonical(operation.descriptor.policy)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Terminal receipt policy must match the captured descriptor',
          path: ['terminalReceipt', 'receipt', 'policy'],
        });
      }
      if (
        operation.state === 'cancelled' &&
        terminal.receipt.items.some(
          (item) => item.state === 'accepted' || item.state === 'unchanged',
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cancelled operations require an incomplete, non-accepted receipt',
          path: ['terminalReceipt', 'receipt'],
        });
      }
      if (terminal.coverage === 'all' && !terminal.receipt.coverageComplete) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'All coverage requires a complete underlying receipt',
          path: ['terminalReceipt', 'coverage'],
        });
      }
      if (
        terminal.coverage === 'all' &&
        (terminal.dependencies.length === 0 || terminal.receipt.items.length === 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'All coverage requires explicit dependencies and receipt items',
          path: ['terminalReceipt', 'coverage'],
        });
      }
      if (
        terminal.coverage !== 'unknown' &&
        terminal.dependencies.length !== terminal.receipt.items.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Every receipt item must have exactly one dependency reference',
          path: ['terminalReceipt', 'dependencies'],
        });
      }
      if (
        terminal.coverage === 'all' &&
        terminal.receipt.items.some(
          (item) =>
            (item.state !== 'accepted' && item.state !== 'unchanged') ||
            !item.persisted ||
            (item.state === 'accepted' && item.mutation !== 'created') ||
            (item.state === 'unchanged' && item.mutation !== 'none'),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'All coverage requires every receipt item to be durably accepted or unchanged',
          path: ['terminalReceipt', 'receipt', 'items'],
        });
      }
      if (
        terminal.coverage === 'all' &&
        terminal.dependencies.length !== terminal.receipt.items.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'All coverage must account for every receipt item',
          path: ['terminalReceipt', 'dependencies'],
        });
      }
      const completedDependencies = terminal.dependencies.filter(
        (dependency) => dependency.state === 'accepted' || dependency.state === 'unchanged',
      );
      const receiptItemsById = new Map<string, (typeof terminal.receipt.items)[number]>();
      terminal.receipt.items.forEach((item, index) => {
        if (!item.claimId) return;
        if (receiptItemsById.has(item.claimId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Receipt claim IDs must be unique',
            path: ['terminalReceipt', 'receipt', 'items', index, 'claimId'],
          });
        }
        receiptItemsById.set(item.claimId, item);
      });
      const dependencyItemIndexes = new Set<number>();
      const dependencyClaimIds = new Set<string>();
      for (const [index, dependency] of terminal.dependencies.entries()) {
        const item = terminal.receipt.items[dependency.itemIndex];
        if (dependencyItemIndexes.has(dependency.itemIndex)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Dependency item references must be unique',
            path: ['terminalReceipt', 'dependencies', index, 'itemIndex'],
          });
        }
        dependencyItemIndexes.add(dependency.itemIndex);
        if (
          !item ||
          dependency.claimId !== item.claimId ||
          dependency.state !== item.state ||
          dependency.persisted !== item.persisted
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Dependency must match its referenced receipt item',
            path: ['terminalReceipt', 'dependencies', index],
          });
        }
        if (dependency.claimId && dependencyClaimIds.has(dependency.claimId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Dependency claim references must be unique',
            path: ['terminalReceipt', 'dependencies', index, 'claimId'],
          });
        }
        if (dependency.claimId) dependencyClaimIds.add(dependency.claimId);
        if (dependency.state === 'accepted' || dependency.state === 'unchanged') {
          if (
            !item ||
            item.state !== dependency.state ||
            !item.persisted ||
            (dependency.state === 'accepted' && item.mutation !== 'created') ||
            (dependency.state === 'unchanged' && item.mutation !== 'none')
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Covered dependencies must match persisted receipt items',
              path: ['terminalReceipt', 'dependencies', index],
            });
          }
        }
      }
      if (
        terminal.coverage === 'all' &&
        terminal.dependencies.some(
          (dependency) => dependency.state !== 'accepted' && dependency.state !== 'unchanged',
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'All coverage requires every dependency to be durably covered',
          path: ['terminalReceipt', 'dependencies'],
        });
      }
      if (
        terminal.coverage === 'partial' &&
        (completedDependencies.length === 0 ||
          completedDependencies.length === terminal.dependencies.length)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Partial coverage requires both covered and uncovered dependencies',
          path: ['terminalReceipt', 'dependencies'],
        });
      }
      if (
        terminal.coverage === 'none' &&
        (completedDependencies.length > 0 ||
          terminal.receipt.items.some(
            (item) => item.state === 'accepted' || item.state === 'unchanged',
          ))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'None coverage cannot include a covered dependency',
          path: ['terminalReceipt', 'coverage'],
        });
      }
      if (
        terminal.coverage === 'unknown' &&
        (terminal.dependencies.length > 0 || terminal.receipt.items.length > 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unknown coverage may only reference unknown dependencies',
          path: ['terminalReceipt', 'dependencies'],
        });
      }
      if (
        !terminal.receipt.persisted ||
        terminal.receipt.commitAt === null ||
        terminal.receipt.commitAt !== terminal.terminalAt
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Terminal receipts require a durably persisted result and matching commit time',
          path: ['terminalReceipt', 'receipt'],
        });
      }
      const dependencyHashes = new Set<string>();
      for (const [index, dependency] of terminal.dependencies.entries()) {
        if (dependencyHashes.has(dependency.dependencyHash)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Dependency references must be unique',
            path: ['terminalReceipt', 'dependencies', index, 'dependencyHash'],
          });
        }
        dependencyHashes.add(dependency.dependencyHash);
      }
      if (
        terminal.coverage !== 'unknown' &&
        (terminal.dependencies.length !== terminal.receipt.items.length ||
          dependencyItemIndexes.size !== terminal.receipt.items.length)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Every receipt item must be paired with exactly one dependency',
          path: ['terminalReceipt', 'dependencies'],
        });
      }
    }
  },
);
export type AutomaticOperation = z.infer<typeof AutomaticOperationSchema>;

/** Explicit names for the unchanged version-1 operation schema and inferred type. */
export const LegacyAutomaticOperationSchema = AutomaticOperationSchema;
export type LegacyAutomaticOperation = AutomaticOperation;

export type StoredAutomaticOperation =
  | LegacyAutomaticOperation
  | AutomaticCaptureOperationV2
  | CompositionalAutomaticCaptureOperationV3
  | AutonomousPersonalOperationV4;

/**
 * Parse exactly one operation version. This avoids trying the full legacy schema
 * against v2 records and keeps version-specific fields out of v1 transitions.
 */
const StoredAutomaticOperationParserSchema = z.unknown().transform((value, context) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid automatic operation' });
    return z.NEVER;
  }
  const version = (value as Record<string, unknown>).version;
  const parsed =
    version === 1
      ? LegacyAutomaticOperationSchema.safeParse(value)
      : version === 2
        ? AutomaticCaptureOperationV2Schema.safeParse(value)
        : version === 3
          ? CompositionalAutomaticCaptureOperationV3Schema.safeParse(value)
          : version === 4
            ? AutonomousPersonalOperationV4Schema.safeParse(value)
            : null;
  if (!parsed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unsupported automatic operation version',
      path: ['version'],
    });
    return z.NEVER;
  }
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue(issue);
    return z.NEVER;
  }
  // Zod's strict schemas are validation only. Return the caller's record after
  // validation so native v2 snapshots retain their original JSON key ordering.
  return version === 2 || version === 3 || version === 4
    ? (value as StoredAutomaticOperation)
    : parsed.data;
});

// Keep GraphData/import types precise while runtime parse remains able to inspect
// arbitrary JSON supplied to a public parser.
export const StoredAutomaticOperationSchema =
  StoredAutomaticOperationParserSchema as unknown as z.ZodType<
    StoredAutomaticOperation,
    z.ZodTypeDef,
    StoredAutomaticOperation
  >;

const AutomaticLedgerObjectSchema = z
  .object({
    version: z.literal(1),
    operations: z
      .array(StoredAutomaticOperationSchema)
      .max(AUTOMATIC_LEDGER_LIMITS.operationsPerStore),
  })
  .strict();

const AutomaticLedgerSchemaWithPreflight = z
  .preprocess((value, context) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const raw = value as Record<string, unknown>;
    if (raw.version !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unsupported automatic ledger version',
        path: ['version'],
      });
      return { version: 1, operations: [] };
    }
    if (
      Array.isArray(raw.operations) &&
      raw.operations.length > AUTOMATIC_LEDGER_LIMITS.operationsPerStore
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Automatic ledger exceeds the store operation limit',
        path: ['operations'],
      });
      return { version: 1, operations: [] };
    }
    return value;
  }, AutomaticLedgerObjectSchema)
  .superRefine((ledger, context) => {
    if (Buffer.byteLength(JSON.stringify(ledger), 'utf8') > AUTOMATIC_LEDGER_LIMITS.storeBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Automatic ledger must not exceed 100 MiB serialized per store',
        path: ['operations'],
      });
    }

    const operationIds = new Set<string>();
    const sourceIds = new Set<string>();
    const locators = new Set<string>();
    const namespaceOperations = new Map<string, StoredAutomaticOperation[]>();
    ledger.operations.forEach((operation, index) => {
      if (!operation || typeof operation !== 'object' || !operation.identity) return;
      if (operationIds.has(operation.operationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Operation IDs must be unique within a store ledger',
          path: ['operations', index, 'operationId'],
        });
      }
      operationIds.add(operation.operationId);

      if (sourceIds.has(operation.identity.sourceId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Source IDs must be unique within a store ledger',
          path: ['operations', index, 'identity', 'sourceId'],
        });
      }
      sourceIds.add(operation.identity.sourceId);

      const locator = JSON.stringify([
        operation.identity.namespace,
        operation.identity.turn,
        operation.identity.role,
      ]);
      if (locators.has(locator)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Namespace, turn, and role locators must be unique',
          path: ['operations', index, 'identity'],
        });
      }
      locators.add(locator);

      const records = namespaceOperations.get(operation.identity.namespace) ?? [];
      records.push(operation);
      namespaceOperations.set(operation.identity.namespace, records);
    });

    for (const operations of namespaceOperations.values()) {
      if (operations.length > AUTOMATIC_LEDGER_LIMITS.operationsPerNamespace) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Namespace exceeds 10,000 automatic operations',
          path: ['operations'],
        });
      }
      const namespaceState = JSON.stringify({ version: 1, operations });
      if (Buffer.byteLength(namespaceState, 'utf8') > AUTOMATIC_LEDGER_LIMITS.namespaceBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Namespace exceeds 10 MiB of automatic operation state',
          path: ['operations'],
        });
      }
    }
  });

// Keep the validated object's inferred input shape for GraphData/import typing while
// preflighting arbitrary runtime input before nested operation validation.
export const AutomaticLedgerSchema = AutomaticLedgerSchemaWithPreflight as unknown as z.ZodType<
  z.infer<typeof AutomaticLedgerObjectSchema>,
  z.ZodTypeDef,
  z.input<typeof AutomaticLedgerObjectSchema>
>;
export type AutomaticLedger = z.infer<typeof AutomaticLedgerSchema>;

export const AutomaticOperationAttemptInputSchema = z
  .object({
    attemptHash: hash,
  })
  .strict();
export type AutomaticOperationAttemptInput = z.infer<typeof AutomaticOperationAttemptInputSchema>;

export const AutomaticOperationAdmissionInputSchema = z
  .object({
    operationId: z.string().uuid(),
    identity: AutomaticOperationIdentitySchema,
    descriptor: AutomaticOperationDescriptorSchema,
    attempt: AutomaticOperationAttemptInputSchema,
  })
  .strict();
export type AutomaticOperationAdmissionInput = z.infer<
  typeof AutomaticOperationAdmissionInputSchema
>;

export const AutomaticOperationFenceSchema = z
  .object({
    generation,
    token: z.string().uuid(),
  })
  .strict();
export type AutomaticOperationFence = z.infer<typeof AutomaticOperationFenceSchema>;

export const AutomaticOperationControlInputSchema = z
  .object({
    operationId: z.string().uuid(),
    attempt: AutomaticOperationAttemptInputSchema,
  })
  .strict();
export type AutomaticOperationControlInput = z.infer<typeof AutomaticOperationControlInputSchema>;

export const AutomaticOperationLeaseInputSchema = AutomaticOperationControlInputSchema.extend({
  token: z.string().uuid(),
}).strict();
export type AutomaticOperationLeaseInput = z.infer<typeof AutomaticOperationLeaseInputSchema>;

export const AutomaticOperationFencedInputSchema = AutomaticOperationControlInputSchema.extend({
  fence: AutomaticOperationFenceSchema,
}).strict();
export type AutomaticOperationFencedInput = z.infer<typeof AutomaticOperationFencedInputSchema>;

export const AutomaticOperationResumeInputSchema = AutomaticOperationControlInputSchema.extend({
  expectedGeneration: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
  token: z.string().uuid(),
}).strict();
export type AutomaticOperationResumeInput = z.infer<typeof AutomaticOperationResumeInputSchema>;

export const AutomaticOperationCompletionInputSchema = AutomaticOperationFencedInputSchema.extend({
  coverage: AutomaticLedgerCoverageSchema,
  dependencies: z.array(AutomaticLedgerDependencySchema).max(32),
  receipt: AutomaticReceiptSchema,
}).strict();
export type AutomaticOperationCompletionInput = z.infer<
  typeof AutomaticOperationCompletionInputSchema
>;

export const AutomaticOperationFailureInputSchema = AutomaticOperationFencedInputSchema.extend({
  state: z.enum(['failed', 'interrupted']),
  failureCode: z.enum([
    'graph_conflict',
    'invalid_plan',
    'provider_error',
    'storage_error',
    'budget_exhausted',
    'capacity',
    'unknown',
    'invocation_interrupted',
    'lease_expired',
  ]),
}).strict();
export type AutomaticOperationFailureInput = z.infer<typeof AutomaticOperationFailureInputSchema>;

export const AutomaticOperationCancellationInputSchema =
  AutomaticOperationControlInputSchema.extend({
    expectedGeneration: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
    fence: AutomaticOperationFenceSchema.optional(),
    coverage: AutomaticLedgerCoverageSchema,
    dependencies: z.array(AutomaticLedgerDependencySchema).max(32),
    receipt: AutomaticReceiptSchema,
  }).strict();
export type AutomaticOperationCancellationInput = z.infer<
  typeof AutomaticOperationCancellationInputSchema
>;

export const AutomaticLegacyUnconfirmedInputSchema = z
  .object({
    operationId: z.string().uuid(),
    identity: AutomaticOperationIdentitySchema,
    attempt: AutomaticOperationAttemptInputSchema,
  })
  .strict();
export type AutomaticLegacyUnconfirmedInput = z.infer<typeof AutomaticLegacyUnconfirmedInputSchema>;

export const AutomaticLegacyObservationRequestSchema = z
  .object({
    sourceId: z.string().uuid(),
    expectedOwner: AutomaticWriteOwnerSchema,
    attemptIdHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type AutomaticLegacyObservationRequest = z.infer<
  typeof AutomaticLegacyObservationRequestSchema
>;

export const AutomaticLegacyObservationResultSchema = z
  .object({
    status: z.enum([
      'observed',
      'already_unconfirmed',
      'already_recorded',
      'unavailable',
      'conflict',
      'capacity',
      'invalid_ledger',
      'invalid_input',
    ]),
    state: z.literal('legacy_unconfirmed').nullable(),
    shouldProcess: z.literal(false),
    attemptAudit: z.enum(['recorded', 'capacity_reached', 'not_recorded']),
  })
  .strict();
export type AutomaticLegacyObservationResult = z.infer<
  typeof AutomaticLegacyObservationResultSchema
>;

export const AutomaticLedgerResultSchema = z
  .object({
    kind: z.enum([
      'created',
      'existing',
      'conflict',
      'capacity',
      'invalid_ledger',
      'invalid_input',
      'clock_regression',
      'original_receipt_unavailable',
      'not_found',
      'in_progress',
      'resume_available',
      'committed_replay',
      'cancelled',
      'fenced',
      'expired',
      'unsupported_durable_linkage',
      'generation_exhausted',
      'claimed',
      'renewed',
      'committed',
      'invalid_or_unsupported_receipt',
      'failed',
      'interrupted',
      'resumed',
      'resume_unavailable',
    ]),
    ledger: AutomaticLedgerSchema.nullable(),
    operation: AutomaticOperationSchema.nullable(),
    shouldProcess: z.literal(false),
    eligibleFirstCommit: z.boolean(),
    attemptAudit: z.enum(['recorded', 'capacity_reached', 'not_recorded']).optional(),
    terminalReceipt: AutomaticLedgerTerminalReceiptSchema.nullable().optional(),
    currentAuthority: z.literal('not_evaluated').optional(),
    leaseFence: AutomaticOperationFenceSchema.optional(),
    saved: z.boolean().optional(),
    sourcePersistence: z.literal('caller_must_handle').optional(),
  })
  .strict();
export type AutomaticLedgerResult = z.infer<typeof AutomaticLedgerResultSchema>;

export function automaticOperationDescriptorHash(descriptor: AutomaticOperationDescriptor): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  };
  return createHash('sha256').update(canonical(descriptor), 'utf8').digest('hex');
}
