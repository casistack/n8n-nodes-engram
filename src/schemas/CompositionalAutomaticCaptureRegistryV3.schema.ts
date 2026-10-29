import { types as utilTypes } from 'util';
import { z } from 'zod';
import { hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
} from './CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalCaptureCancelResultV3Schema,
  CompositionalCaptureLeaseFenceV3Schema,
  CompositionalCaptureNonPermitResultV3Schema,
} from './CompositionalAutomaticCaptureLifecycleV3.schema';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from '../storage/LosslessAutomaticCaptureGraph';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const timestamp = z.string().datetime();

declare const v3HandleBrand: unique symbol;
declare const v3BeginScopeBrand: unique symbol;
declare const v3ResumeScopeBrand: unique symbol;
declare const v3ConsumedInvocationBrand: unique symbol;
declare const v3AuditCapBrand: unique symbol;
declare const v3FirstCommitProofBrand: unique symbol;
declare const v3SourceVerdictWitnessBrand: unique symbol;

/** Empty, frozen WeakMap-backed backend capability. */
export type PrivateOneUseCompositionalCaptureLeaseHandleV3 = object & {
  readonly [v3HandleBrand]: 'human_turn_memory';
};
/** Empty, frozen WeakMap-backed start-begin scope. */
export type PrivateCompositionalCaptureBeginScopeV3 = object & {
  readonly [v3BeginScopeBrand]: 'initial';
};
/** Empty, frozen WeakMap-backed explicit-resume scope. */
export type PrivateCompositionalCaptureResumeScopeV3 = object & {
  readonly [v3ResumeScopeBrand]: 'resume';
};
/** Empty, frozen capability returned only after synchronous handle consumption. */
export type PrivateConsumedCompositionalCaptureInvocationV3 = object & {
  readonly [v3ConsumedInvocationBrand]: 'human_turn_memory';
};
/** Empty, frozen, action-specific attempt-observation cap. */
export type PrivateCompositionalCaptureAuditCapV3<
  TAction extends 'initial' | 'resume' | 'completion',
> = object & {
  readonly [v3AuditCapBrand]: TAction;
};
/** Empty, frozen, same-registry proof for the first generation-1 human commit. */
export type PrivateCompositionalCaptureFirstCommitProofV3 = object & {
  readonly [v3FirstCommitProofBrand]: 'initial_first_commit';
};
/** Empty, frozen, same-registry result of a completed source-verdict interpretation. */
export type PrivateCompositionalCaptureSourceVerdictWitnessV3 = object & {
  readonly [v3SourceVerdictWitnessBrand]: 'source_verdict';
};

const attemptAuditShape = z
  .object({
    action: z.enum(['initial', 'resume', 'completion']),
    attemptIdHash: hash64,
    operationId: uuid.optional(),
    sourceId: uuid.optional(),
  })
  .strict();
export type CompositionalCaptureAttemptAuditV3 = z.infer<typeof attemptAuditShape>;
export function parseCompositionalCaptureAttemptAuditV3(
  value: unknown,
): CompositionalCaptureAttemptAuditV3 {
  return attemptAuditShape.parse(value);
}

const actualKeys = ['storeHash', 'namespace', 'backendNow', 'graph', 'operation'] as const;
function isNativePlainObject(value: object): boolean {
  if (utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return true;
    if (utilTypes.isProxy(prototype) || Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function')
      return false;
    const candidate = constructor.value;
    return (
      !utilTypes.isProxy(candidate) &&
      candidate.name === 'Object' &&
      candidate.prototype === prototype &&
      Function.prototype.toString.call(candidate) === 'function Object() { [native code] }'
    );
  } catch {
    return false;
  }
}

function snapshotActual(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isNativePlainObject(value)
  )
    return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== actualKeys.length ||
      keys.some((key) => typeof key !== 'string' || !actualKeys.includes(key as never))
    )
      return undefined;
    const input: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of actualKeys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !('value' in property)) return undefined;
      Object.defineProperty(input, key, {
        value: property.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const metadata = cloneBoundedAutomaticCaptureJson(
      {
        storeHash: input.storeHash,
        namespace: input.namespace,
        backendNow: input.backendNow,
        operation: input.operation,
      },
      'beginRequest',
    );
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
    // Zod inspects then/catch while determining an unknown input's type.
    // Own the graph before that inspection; lossless validation below remains
    // separate and must not normalize persisted records.
    const graph = cloneBoundedAutomaticCaptureJson(input.graph, 'graph');
    return { ...(metadata as Record<string, unknown>), graph };
  } catch {
    return undefined;
  }
}

const actualBody = z
  .object({
    storeHash: hash64,
    namespace: CompositionalCaptureNamespaceV3Schema,
    backendNow: timestamp,
    graph: z.unknown().transform((value, context) => {
      try {
        return parseLosslessAutomaticCaptureGraph(value);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid actual graph snapshot' });
        return z.NEVER;
      }
    }),
    operation: CompositionalAutomaticCaptureOperationV3Schema,
  })
  .strict()
  .superRefine((actual, context) => {
    const { identity, descriptor } = actual.operation;
    if (
      actual.storeHash !== identity.storeHash ||
      actual.namespace !== identity.namespace ||
      descriptor.purpose !== 'human_turn_memory'
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Actual V3 store scope mismatch' });
    }
    const sources = actual.graph.episodes.filter((episode) => episode.uuid === identity.sourceId);
    const recordIdCollision =
      identity.sourceId === actual.operation.operationId ||
      actual.graph.entities.some((entity) => entity.uuid === identity.sourceId) ||
      actual.graph.edges.some((edge) => edge.uuid === identity.sourceId) ||
      actual.graph.entities.some((entity) => entity.uuid === actual.operation.operationId) ||
      actual.graph.edges.some((edge) => edge.uuid === actual.operation.operationId) ||
      actual.graph.episodes.some((episode) => episode.uuid === actual.operation.operationId);
    const ledgerOperations = actual.graph.automatic_operations_v1?.operations ?? [];
    const matchingStoredOperations = ledgerOperations.filter(
      (operation) =>
        operation.version === 3 &&
        operation.operationId === actual.operation.operationId &&
        operation.identity.sourceId === identity.sourceId,
    );
    const storedOperationMatches =
      matchingStoredOperations.length === 1 &&
      hashAutomaticCaptureV2(matchingStoredOperations[0]) ===
        hashAutomaticCaptureV2(actual.operation);
    const collidingOtherOperation = ledgerOperations.some((operation) => {
      if (
        operation.version === 3 &&
        operation.operationId === actual.operation.operationId &&
        operation.identity.sourceId === identity.sourceId &&
        hashAutomaticCaptureV2(operation) === hashAutomaticCaptureV2(actual.operation)
      )
        return false;
      return (
        operation.operationId === actual.operation.operationId ||
        operation.identity.sourceId === identity.sourceId ||
        operation.operationId === identity.sourceId ||
        operation.identity.sourceId === actual.operation.operationId
      );
    });
    if (
      sources.length !== 1 ||
      sources[0]?.group_id !== actual.namespace ||
      recordIdCollision ||
      !storedOperationMatches ||
      collidingOtherOperation ||
      identity.role !== 'human' ||
      identity.purpose !== 'human_turn_memory' ||
      actual.operation.descriptor.purpose !== 'human_turn_memory'
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Actual V3 source scope mismatch' });
    }
    if (!Number.isFinite(Date.parse(actual.backendNow))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid backend timestamp' });
    }
  });

/**
 * Bounded actual-store snapshot input for internal registry calls. Parsing only
 * validates shape; storage adapters must obtain this snapshot under their
 * writer lock after the stated acknowledgment and must supply no caller data.
 */
export const CompositionalCaptureRegistryActualV3Schema = z.preprocess(snapshotActual, actualBody);
export type CompositionalCaptureRegistryActualV3 = z.infer<
  typeof CompositionalCaptureRegistryActualV3Schema
>;

/** Private inferred view of the exact fence and backend-only bindings in a lease. */
const completionInvocationSchema = z
  .object({
    boundFence: CompositionalCaptureLeaseFenceV3Schema,
    storeHash: hash64,
    namespace: CompositionalCaptureNamespaceV3Schema,
    sourceHash: hash64,
    envelopeHash: hash64,
    expiresAt: timestamp,
    acknowledgedBackendNow: timestamp,
    leaseRemainingMsAtMonotonicAnchor: z.number().finite().nonnegative(),
    invocationDeadlineAtMonotonicMs: z.number().finite(),
    claimKind: z.enum(['initial', 'resume']),
    completionCallHash: hash64,
    audit: z.custom<PrivateCompositionalCaptureAuditCapV3<'completion'>>(),
  })
  .strict();
export type CompositionalCaptureCompletionInvocationV3 = z.infer<typeof completionInvocationSchema>;
export function parseCompositionalCaptureCompletionInvocationV3(
  value: unknown,
): CompositionalCaptureCompletionInvocationV3 {
  return completionInvocationSchema.parse(value);
}

const beginInvocationSchema = z
  .object({
    scope: z.custom<PrivateCompositionalCaptureBeginScopeV3>(),
    sourceId: uuid,
    operationId: uuid,
    leaseToken: uuid,
    beginCallHash: hash64,
    audit: z.custom<PrivateCompositionalCaptureAuditCapV3<'initial'>>(),
  })
  .strict();
export type CompositionalCaptureBeginInvocationV3 = z.infer<typeof beginInvocationSchema>;
export function parseCompositionalCaptureBeginInvocationV3(
  value: unknown,
): CompositionalCaptureBeginInvocationV3 {
  return beginInvocationSchema.parse(value);
}

export const CompositionalCaptureInitialBeginScopeSnapshotV3Schema = z
  .object({
    scope: z.custom<PrivateCompositionalCaptureBeginScopeV3>(),
    sourceId: uuid,
    operationId: uuid,
    leaseToken: uuid,
    beginCallHash: hash64,
    descriptorHash: hash64,
    invocationDeadlineMs: z.number().int().min(100).max(120_000),
    audit: z.custom<PrivateCompositionalCaptureAuditCapV3<'initial'>>(),
  })
  .strict();
export type CompositionalCaptureInitialBeginScopeSnapshotV3 = z.infer<
  typeof CompositionalCaptureInitialBeginScopeSnapshotV3Schema
>;
export function parseCompositionalCaptureInitialBeginScopeSnapshotV3(
  value: unknown,
): CompositionalCaptureInitialBeginScopeSnapshotV3 {
  return CompositionalCaptureInitialBeginScopeSnapshotV3Schema.parse(value);
}

const resumeInvocationSchema = z
  .object({
    scope: z.custom<PrivateCompositionalCaptureResumeScopeV3>(),
    operationId: uuid,
    sourceId: uuid,
    leaseToken: uuid,
    audit: z.custom<PrivateCompositionalCaptureAuditCapV3<'resume'>>(),
  })
  .strict();
export type CompositionalCaptureResumeInvocationV3 = z.infer<typeof resumeInvocationSchema>;
export function parseCompositionalCaptureResumeInvocationV3(
  value: unknown,
): CompositionalCaptureResumeInvocationV3 {
  return resumeInvocationSchema.parse(value);
}

/** Registry implementations supply identity predicates; JSON cannot synthesize either cap. */
export interface CompositionalCaptureInternalResultRegistryPredicatesV3 {
  isLiveHandle(value: unknown): value is PrivateOneUseCompositionalCaptureLeaseHandleV3;
  isFirstCommitResult(value: unknown): value is CompositionalCaptureEligibleFirstCommitResultV3;
}

const claimedResultBase = z
  .object({
    kind: z.literal('claimed'),
    claimKind: z.enum(['initial', 'resume']),
    handle: z.custom<PrivateOneUseCompositionalCaptureLeaseHandleV3>(),
    eligibleFirstCommit: z.literal(false),
  })
  .strict();

const firstCommitResultBody = z
  .object({
    kind: z.literal('committed'),
    invocation: z.enum(['initial_owner', 'same_call_ack_recovered']),
    terminalReceipt: CompositionalAutomaticCaptureTerminalReceiptV3Schema.refine(
      (receipt) =>
        receipt.kind === 'human_compositional_capture_committed' ||
        receipt.kind === 'human_compositional_source_verdict_committed',
    ),
    currentAuthority: z.literal('active'),
    eligibleFirstCommit: z.literal(true),
  })
  .strict();
export type CompositionalCaptureEligibleFirstCommitResultV3 = z.infer<typeof firstCommitResultBody>;
export function parseCompositionalCaptureEligibleFirstCommitResultBodyV3(
  value: unknown,
): CompositionalCaptureEligibleFirstCommitResultV3 {
  return firstCommitResultBody.parse(value);
}

export function createCompositionalCaptureInternalResultSchemasV3(
  registry: CompositionalCaptureInternalResultRegistryPredicatesV3,
) {
  const claimedResult = claimedResultBase.extend({
    handle: z.custom<PrivateOneUseCompositionalCaptureLeaseHandleV3>(registry.isLiveHandle),
  });
  const eligibleFirstCommit = z.custom<CompositionalCaptureEligibleFirstCommitResultV3>(
    (value) =>
      registry.isFirstCommitResult(value) && firstCommitResultBody.safeParse(value).success,
  );
  return Object.freeze({
    begin: z.union([CompositionalCaptureNonPermitResultV3Schema, claimedResult]),
    completion: z.union([CompositionalCaptureNonPermitResultV3Schema, eligibleFirstCommit]),
    control: CompositionalCaptureCancelResultV3Schema,
  });
}

export type CompositionalCaptureBeginInternalResultV3 = z.infer<
  ReturnType<typeof createCompositionalCaptureInternalResultSchemasV3>['begin']
>;
export type CompositionalCaptureCompletionInternalResultV3 = z.infer<
  ReturnType<typeof createCompositionalCaptureInternalResultSchemasV3>['completion']
>;
