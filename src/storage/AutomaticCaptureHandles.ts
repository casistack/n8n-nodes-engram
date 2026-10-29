import { createHash, randomBytes, randomUUID } from 'crypto';
import { z } from 'zod';
import { AUTOMATIC_LEDGER_LIMITS } from '../schemas/AutomaticLedgerPrimitives.schema';

const purposeSchema = z.enum(['human_turn_memory', 'assistant_final_save']);
export type AutomaticCaptureHandlePurpose = z.infer<typeof purposeSchema>;

const hash64Schema = z.string().regex(/^[a-f0-9]{64}$/);
const uuidSchema = z.string().uuid();
const commonFence = {
  purpose: purposeSchema,
  operationId: uuidSchema,
  sourceId: uuidSchema,
  descriptorHash: hash64Schema,
  identityHash: hash64Schema,
  beginCallHash: hash64Schema,
  retryCount: z.number().int().min(0).max(3),
  lastRetryCallHash: hash64Schema.optional(),
};

/** A strict, bounded view of the persisted leased operation fields used by a handle. */
export const AutomaticCaptureLeaseFenceV2Schema = z
  .object({
    ...commonFence,
    state: z.literal('leased'),
    generation: z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
    token: uuidSchema,
    claimKind: z.enum(['initial', 'resume']),
    // Backend supplies the actual persisted lease.renewedAt, never a caller clock.
    planTimestamp: z.string().datetime(),
  })
  .strict()
  .superRefine((fence, context) => {
    if ((fence.retryCount === 0) !== (fence.lastRetryCallHash === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Retry count and retry-call hash must be present together',
        path: ['retryCount'],
      });
    }
    if (
      (fence.claimKind === 'initial' && fence.generation !== 1) ||
      (fence.claimKind === 'resume' && fence.generation < 2)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lease claim kind does not match its generation or retry state',
        path: ['claimKind'],
      });
    }
    if (fence.purpose === 'assistant_final_save' && fence.retryCount !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Assistant final-save operations cannot have graph-conflict retries',
        path: ['retryCount'],
      });
    }
  });
export type AutomaticCaptureLeaseFenceV2 = z.infer<typeof AutomaticCaptureLeaseFenceV2Schema>;

/** The non-lease operation fields needed to preserve identity across explicit resume. */
export const AutomaticCaptureResumeSourceV2Schema = z
  .object({
    ...commonFence,
    state: z.enum(['failed', 'interrupted']),
    generation: z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
  })
  .strict()
  .superRefine((operation, context) => {
    if ((operation.retryCount === 0) !== (operation.lastRetryCallHash === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Retry count and retry-call hash must be present together',
        path: ['retryCount'],
      });
    }
    if (operation.purpose === 'assistant_final_save' && operation.retryCount !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Assistant final-save operations cannot have graph-conflict retries',
        path: ['retryCount'],
      });
    }
  });
export type AutomaticCaptureResumeSourceV2 = z.infer<typeof AutomaticCaptureResumeSourceV2Schema>;

const invocationDataCommon = {
  boundFence: AutomaticCaptureLeaseFenceV2Schema.readonly(),
  completionCallHash: hash64Schema,
};
const humanCompletionInvocationSchema = z
  .object({
    ...invocationDataCommon,
    purpose: z.literal('human_turn_memory'),
    retryIssueCallHash: hash64Schema,
  })
  .strict();
const assistantCompletionInvocationSchema = z
  .object({
    ...invocationDataCommon,
    purpose: z.literal('assistant_final_save'),
    retryIssueCallHash: z.null(),
  })
  .strict();
type HumanCompletionInvocationData = z.infer<typeof humanCompletionInvocationSchema>;
type AssistantCompletionInvocationData = z.infer<typeof assistantCompletionInvocationSchema>;

declare const handlePurposeBrand: unique symbol;
declare const beginScopeBrand: unique symbol;
declare const resumeScopeBrand: unique symbol;
declare const retryScopeBrand: unique symbol;
declare const consumedInvocationBrand: unique symbol;

/** Runtime handles are empty frozen objects. Their type-only brand prevents accidental mixing. */
export type PrivateOneUseAutomaticLeaseHandle<P extends AutomaticCaptureHandlePurpose> = object & {
  readonly [handlePurposeBrand]: P;
};

/** Same-instance completion capability; it contains no serializable invocation data. */
export type PrivateConsumedAutomaticCaptureInvocation<P extends AutomaticCaptureHandlePurpose> =
  object & {
    readonly [consumedInvocationBrand]: P;
  };

export type AutomaticCaptureBeginCallScope<P extends AutomaticCaptureHandlePurpose> = object & {
  readonly [beginScopeBrand]: P;
};
export type AutomaticCaptureResumeCallScope<P extends AutomaticCaptureHandlePurpose> = object & {
  readonly [resumeScopeBrand]: P;
};
export type AutomaticCaptureRetryIssueScope = object & {
  readonly [retryScopeBrand]: 'human_turn_memory';
};

export type AutomaticCaptureBeginInvocation<P extends AutomaticCaptureHandlePurpose> = Readonly<{
  purpose: P;
  scope: AutomaticCaptureBeginCallScope<P>;
  beginCallHash: string;
  leaseToken: string;
}>;

export type AutomaticCaptureResumeInvocation<P extends AutomaticCaptureHandlePurpose> = Readonly<{
  purpose: P;
  scope: AutomaticCaptureResumeCallScope<P>;
  leaseToken: string;
}>;

export type AutomaticCaptureCompletionInvocationFor<P extends AutomaticCaptureHandlePurpose> =
  P extends 'human_turn_memory'
    ? Readonly<
        HumanCompletionInvocationData & {
          retryScope: AutomaticCaptureRetryIssueScope;
        }
      >
    : Readonly<AssistantCompletionInvocationData>;
export type AutomaticCaptureCompletionInvocation =
  AutomaticCaptureCompletionInvocationFor<AutomaticCaptureHandlePurpose>;

interface HandleRecord {
  readonly owner: symbol;
  readonly fence: AutomaticCaptureLeaseFenceV2;
  consumed: boolean;
}

interface BeginScopeRecord {
  readonly owner: RegistryState;
  readonly kind: 'begin';
  readonly purpose: AutomaticCaptureHandlePurpose;
  readonly beginCallHash: string;
  readonly leaseToken: string;
  boundFence?: AutomaticCaptureLeaseFenceV2;
  handle?: object;
}

interface ResumeScopeRecord {
  readonly owner: RegistryState;
  readonly kind: 'resume';
  readonly purpose: AutomaticCaptureHandlePurpose;
  readonly leaseToken: string;
  readonly previous: AutomaticCaptureResumeSourceV2;
  boundFence?: AutomaticCaptureLeaseFenceV2;
  handle?: object;
}

interface RetryScopeRecord {
  readonly owner: RegistryState;
  readonly kind: 'retry';
  readonly predecessor: HandleRecord;
  readonly retryIssueCallHash: string;
  boundFence?: AutomaticCaptureLeaseFenceV2;
  handle?: object;
}

type ScopeRecord = BeginScopeRecord | ResumeScopeRecord | RetryScopeRecord;

interface RegistryState {
  readonly instanceId: symbol;
  readonly scopes: WeakMap<object, ScopeRecord>;
}

export interface AutomaticCaptureHandleRegistry {
  isLiveHandle<P extends AutomaticCaptureHandlePurpose>(
    handle: unknown,
    purpose: P,
    claimKind?: 'initial' | 'resume',
  ): handle is PrivateOneUseAutomaticLeaseHandle<P>;
  startBegin<P extends AutomaticCaptureHandlePurpose>(
    purpose: P,
  ): AutomaticCaptureBeginInvocation<P>;
  recoverOrIssueInitial<P extends AutomaticCaptureHandlePurpose>(
    scope: AutomaticCaptureBeginCallScope<P>,
    persistedFence: unknown,
  ): PrivateOneUseAutomaticLeaseHandle<P> | null;
  startResume<P extends AutomaticCaptureHandlePurpose>(
    purpose: P,
    previousOperation: unknown,
  ): AutomaticCaptureResumeInvocation<P>;
  recoverOrIssueResume<P extends AutomaticCaptureHandlePurpose>(
    scope: AutomaticCaptureResumeCallScope<P>,
    persistedFence: unknown,
  ): PrivateOneUseAutomaticLeaseHandle<P> | null;
  consumeForCompletion<P extends AutomaticCaptureHandlePurpose>(
    handle: PrivateOneUseAutomaticLeaseHandle<P>,
    expectedPurpose: P,
  ): PrivateConsumedAutomaticCaptureInvocation<P>;
  readConsumedInvocation<P extends AutomaticCaptureHandlePurpose>(
    capability: unknown,
    expectedPurpose: P,
  ): AutomaticCaptureCompletionInvocationFor<P>;
  recoverOrIssueSuccessor(
    scope: AutomaticCaptureRetryIssueScope,
    persistedFence: unknown,
  ): PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'> | null;
}

const handles = new WeakMap<object, HandleRecord>();
const consumedInvocations = new WeakMap<
  object,
  {
    readonly owner: symbol;
    readonly data: AutomaticCaptureCompletionInvocation;
  }
>();

function opaqueObject<T extends object>(): T {
  return Object.freeze(Object.create(null)) as T;
}

function hashCallNonce(prefix: string): string {
  return createHash('sha256')
    .update(prefix, 'utf8')
    .update(Buffer.from([0]))
    .update(randomBytes(32))
    .digest('hex');
}

function parseFence(value: unknown): AutomaticCaptureLeaseFenceV2 | null {
  const parsed = AutomaticCaptureLeaseFenceV2Schema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

function parseResumeSource(value: unknown): AutomaticCaptureResumeSourceV2 | null {
  const parsed = AutomaticCaptureResumeSourceV2Schema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

function sameFence(
  left: AutomaticCaptureLeaseFenceV2,
  right: AutomaticCaptureLeaseFenceV2,
): boolean {
  return (
    left.state === right.state &&
    left.purpose === right.purpose &&
    left.operationId === right.operationId &&
    left.sourceId === right.sourceId &&
    left.descriptorHash === right.descriptorHash &&
    left.identityHash === right.identityHash &&
    left.beginCallHash === right.beginCallHash &&
    left.generation === right.generation &&
    left.token === right.token &&
    left.claimKind === right.claimKind &&
    left.planTimestamp === right.planTimestamp &&
    left.retryCount === right.retryCount &&
    left.lastRetryCallHash === right.lastRetryCallHash
  );
}

function sameResumeIdentity(
  current: AutomaticCaptureLeaseFenceV2,
  previous: AutomaticCaptureResumeSourceV2,
): boolean {
  return (
    current.purpose === previous.purpose &&
    current.operationId === previous.operationId &&
    current.sourceId === previous.sourceId &&
    current.descriptorHash === previous.descriptorHash &&
    current.identityHash === previous.identityHash &&
    current.beginCallHash === previous.beginCallHash &&
    current.retryCount === previous.retryCount &&
    current.lastRetryCallHash === previous.lastRetryCallHash
  );
}

function freezeHandle(owner: symbol, fence: AutomaticCaptureLeaseFenceV2): object {
  const handle = opaqueObject<object>();
  handles.set(handle, { owner, fence, consumed: false });
  return handle;
}

function invalidHandle(): never {
  throw new Error('Engram automatic memory: invalid_handle');
}

/**
 * Create one private registry per backend instance. This utility only manages
 * process-local capabilities; backend code must still validate persistence,
 * current authority, authoritative time, and the stored lease fence.
 */
export function createAutomaticCaptureHandleRegistry(): AutomaticCaptureHandleRegistry {
  const state: RegistryState = {
    instanceId: Symbol(),
    scopes: new WeakMap<object, ScopeRecord>(),
  };

  const registry: AutomaticCaptureHandleRegistry = {
    isLiveHandle<P extends AutomaticCaptureHandlePurpose>(
      handle: unknown,
      purpose: P,
      claimKind?: 'initial' | 'resume',
    ): handle is PrivateOneUseAutomaticLeaseHandle<P> {
      if (handle === null || typeof handle !== 'object') return false;
      const record = handles.get(handle);
      return (
        record !== undefined &&
        record.owner === state.instanceId &&
        !record.consumed &&
        record.fence.purpose === purpose &&
        (claimKind === undefined || record.fence.claimKind === claimKind)
      );
    },
    startBegin<P extends AutomaticCaptureHandlePurpose>(purpose: P) {
      const validatedPurpose = purposeSchema.parse(purpose);
      const beginCallHash = hashCallNonce('automatic-capture-begin-v2');
      const leaseToken = randomUUID();
      const scope = opaqueObject<AutomaticCaptureBeginCallScope<P>>();
      state.scopes.set(scope, {
        owner: state,
        kind: 'begin',
        purpose: validatedPurpose,
        beginCallHash,
        leaseToken,
      });
      return Object.freeze({ purpose: validatedPurpose as P, scope, beginCallHash, leaseToken });
    },

    recoverOrIssueInitial<P extends AutomaticCaptureHandlePurpose>(
      scope: AutomaticCaptureBeginCallScope<P>,
      persistedFence: unknown,
    ) {
      const scopeRecord = state.scopes.get(scope as object);
      const fence = parseFence(persistedFence);
      if (
        !scopeRecord ||
        scopeRecord.owner !== state ||
        scopeRecord.kind !== 'begin' ||
        !fence ||
        scopeRecord.purpose !== fence.purpose ||
        fence.beginCallHash !== scopeRecord.beginCallHash ||
        fence.token !== scopeRecord.leaseToken ||
        fence.generation !== 1 ||
        fence.claimKind !== 'initial' ||
        fence.retryCount !== 0 ||
        fence.lastRetryCallHash !== undefined
      ) {
        return null;
      }
      if (scopeRecord.boundFence && !sameFence(scopeRecord.boundFence, fence)) return null;
      if (scopeRecord.handle) {
        const current = handles.get(scopeRecord.handle);
        return current && !current.consumed
          ? (scopeRecord.handle as PrivateOneUseAutomaticLeaseHandle<P>)
          : null;
      }
      scopeRecord.boundFence = fence;
      scopeRecord.handle = freezeHandle(state.instanceId, fence);
      return scopeRecord.handle as PrivateOneUseAutomaticLeaseHandle<P>;
    },

    startResume<P extends AutomaticCaptureHandlePurpose>(purpose: P, previousOperation: unknown) {
      const validatedPurpose = purposeSchema.parse(purpose);
      const previous = parseResumeSource(previousOperation);
      if (!previous || previous.purpose !== validatedPurpose) {
        throw new Error('Engram automatic memory: invalid_resume_context');
      }
      if (previous.generation >= AUTOMATIC_LEDGER_LIMITS.maxGeneration) {
        throw new Error('Engram automatic memory: invalid_resume_context');
      }
      const leaseToken = randomUUID();
      const scope = opaqueObject<AutomaticCaptureResumeCallScope<P>>();
      state.scopes.set(scope, {
        owner: state,
        kind: 'resume',
        purpose: validatedPurpose,
        leaseToken,
        previous,
      });
      return Object.freeze({ purpose: validatedPurpose as P, scope, leaseToken });
    },

    recoverOrIssueResume<P extends AutomaticCaptureHandlePurpose>(
      scope: AutomaticCaptureResumeCallScope<P>,
      persistedFence: unknown,
    ) {
      const scopeRecord = state.scopes.get(scope as object);
      const fence = parseFence(persistedFence);
      if (
        !scopeRecord ||
        scopeRecord.owner !== state ||
        scopeRecord.kind !== 'resume' ||
        !fence ||
        scopeRecord.purpose !== fence.purpose ||
        fence.token !== scopeRecord.leaseToken ||
        fence.generation !== scopeRecord.previous.generation + 1 ||
        fence.claimKind !== 'resume' ||
        !sameResumeIdentity(fence, scopeRecord.previous)
      ) {
        return null;
      }
      if (scopeRecord.boundFence && !sameFence(scopeRecord.boundFence, fence)) return null;
      if (scopeRecord.handle) {
        const current = handles.get(scopeRecord.handle);
        return current && !current.consumed
          ? (scopeRecord.handle as PrivateOneUseAutomaticLeaseHandle<P>)
          : null;
      }
      scopeRecord.boundFence = fence;
      scopeRecord.handle = freezeHandle(state.instanceId, fence);
      return scopeRecord.handle as PrivateOneUseAutomaticLeaseHandle<P>;
    },

    consumeForCompletion<P extends AutomaticCaptureHandlePurpose>(
      handle: PrivateOneUseAutomaticLeaseHandle<P>,
      expectedPurpose: P,
    ): PrivateConsumedAutomaticCaptureInvocation<P> {
      const record = handles.get(handle as object);
      if (
        !record ||
        record.owner !== state.instanceId ||
        record.consumed ||
        record.fence.purpose !== expectedPurpose ||
        !purposeSchema.safeParse(expectedPurpose).success
      ) {
        return invalidHandle();
      }

      // Consumption is synchronous and occurs before the backend starts any I/O.
      record.consumed = true;
      const completionCallHash = hashCallNonce('automatic-capture-complete-v2');
      if (record.fence.purpose === 'human_turn_memory') {
        const retryIssueCallHash = hashCallNonce('automatic-capture-retry-v2');
        const retryScope = opaqueObject<AutomaticCaptureRetryIssueScope>();
        state.scopes.set(retryScope, {
          owner: state,
          kind: 'retry',
          predecessor: record,
          retryIssueCallHash,
        });
        const data = humanCompletionInvocationSchema.parse({
          purpose: 'human_turn_memory' as const,
          boundFence: record.fence,
          completionCallHash,
          retryIssueCallHash,
        });
        const capability = opaqueObject<PrivateConsumedAutomaticCaptureInvocation<P>>();
        consumedInvocations.set(capability, {
          owner: state.instanceId,
          data: Object.freeze({ ...data, boundFence: Object.freeze(data.boundFence), retryScope }),
        });
        return capability;
      }
      const data = assistantCompletionInvocationSchema.parse({
        purpose: 'assistant_final_save' as const,
        boundFence: record.fence,
        completionCallHash,
        retryIssueCallHash: null,
      });
      const capability = opaqueObject<PrivateConsumedAutomaticCaptureInvocation<P>>();
      consumedInvocations.set(capability, {
        owner: state.instanceId,
        data: Object.freeze({ ...data, boundFence: Object.freeze(data.boundFence) }),
      });
      return capability;
    },

    readConsumedInvocation<P extends AutomaticCaptureHandlePurpose>(
      capability: unknown,
      expectedPurpose: P,
    ): AutomaticCaptureCompletionInvocationFor<P> {
      if (capability === null || typeof capability !== 'object') return invalidHandle();
      const record = consumedInvocations.get(capability);
      if (!record || record.owner !== state.instanceId || record.data.purpose !== expectedPurpose) {
        return invalidHandle();
      }
      // Detach every data object on each read. The original private retry scope
      // retains its identity so managed callback recovery can reuse it safely.
      return Object.freeze({
        ...record.data,
        boundFence: Object.freeze({ ...record.data.boundFence }),
      }) as AutomaticCaptureCompletionInvocationFor<P>;
    },

    recoverOrIssueSuccessor(scope, persistedFence) {
      const scopeRecord = state.scopes.get(scope as object);
      const fence = parseFence(persistedFence);
      if (
        !scopeRecord ||
        scopeRecord.owner !== state ||
        scopeRecord.kind !== 'retry' ||
        !scopeRecord.predecessor.consumed ||
        !fence
      ) {
        return null;
      }
      const predecessor = scopeRecord.predecessor.fence;
      if (
        predecessor.purpose !== 'human_turn_memory' ||
        predecessor.retryCount >= 3 ||
        fence.purpose !== predecessor.purpose ||
        fence.operationId !== predecessor.operationId ||
        fence.sourceId !== predecessor.sourceId ||
        fence.descriptorHash !== predecessor.descriptorHash ||
        fence.identityHash !== predecessor.identityHash ||
        fence.beginCallHash !== predecessor.beginCallHash ||
        fence.generation !== predecessor.generation ||
        fence.token !== predecessor.token ||
        fence.claimKind !== predecessor.claimKind ||
        fence.retryCount !== predecessor.retryCount + 1 ||
        fence.lastRetryCallHash !== scopeRecord.retryIssueCallHash
      ) {
        return null;
      }
      if (scopeRecord.boundFence && !sameFence(scopeRecord.boundFence, fence)) return null;
      if (scopeRecord.handle) {
        const current = handles.get(scopeRecord.handle);
        return current && !current.consumed
          ? (scopeRecord.handle as PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'>)
          : null;
      }
      scopeRecord.boundFence = fence;
      scopeRecord.handle = freezeHandle(state.instanceId, fence);
      return scopeRecord.handle as PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'>;
    },
  };

  return Object.freeze(registry);
}
