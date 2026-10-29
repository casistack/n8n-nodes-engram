import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import {
  AutonomousPersonalAssistantFinalIntentV4Schema,
  AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema,
  AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema,
  type AutonomousPersonalAssistantFinalPlanDataV4,
} from '../schemas/AutonomousPersonalAssistantFinalV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import { generateUuid } from '../utils/uuid';
import {
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject,
} from './BoundedAutomaticCaptureJson';
import { getAutonomousPersonalMemoryLineageOriginV4 } from './AutonomousPersonalNativeMemoryHandoffV4';

declare const invocationBrand: unique symbol;
declare const consumedBrand: unique symbol;

/** Internal, empty, owner-bound key. Serializing it cannot preserve authority. */
export type PrivateAutonomousPersonalAssistantFinalInvocationV4 = object & {
  readonly [invocationBrand]: true;
};
export type PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4 = object & {
  readonly [consumedBrand]: true;
};

type RecordV4 = {
  owner: object;
  data: AutonomousPersonalAssistantFinalPlanDataV4;
  work: AutonomousPersonalTypedSyntaxWorkV1;
  check: () => void;
  candidateReturned: boolean;
  reconciliationUsed: boolean;
};
const issued = new WeakMap<object, RecordV4>();
const consumed = new WeakMap<object, RecordV4>();
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const object = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !utilTypes.isProxy(value);

function fixed(): Error {
  return new Error('Engram automatic memory: invalid_assistant_final_invocation');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownedWork(value: unknown, maximumDeadline: number): AutonomousPersonalTypedSyntaxWorkV1 {
  if (!object(value) || !isNativePlainAutomaticCaptureObject(value) || !aborted) throw fixed();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal')
  )
    throw fixed();
  const deadline = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
  const signal = Object.getOwnPropertyDescriptor(value, 'signal');
  if (
    !deadline ||
    !signal ||
    !deadline.enumerable ||
    !signal.enumerable ||
    !('value' in deadline) ||
    !('value' in signal) ||
    typeof deadline.value !== 'number' ||
    !Number.isFinite(deadline.value) ||
    !object(signal.value)
  )
    throw fixed();
  aborted.call(signal.value);
  return Object.freeze({
    absoluteMonotonicDeadlineMs: Math.min(deadline.value, maximumDeadline),
    signal: signal.value as AbortSignal,
  });
}

/**
 * Fixed native adapter entry only. The late reader is consumed here and is never
 * retained in a record. Neither caller origin nor planner DATA can issue a key.
 */
export async function issueAutonomousPersonalAssistantFinalInvocationV4(
  owner: object,
  lineage: unknown,
  intentValue: unknown,
  rereadNativeSnapshot: () => Promise<unknown>,
  workValue: AutonomousPersonalTypedSyntaxWorkV1,
  trustedCheck: () => void,
): Promise<PrivateAutonomousPersonalAssistantFinalInvocationV4 | null> {
  if (!object(owner)) return null;
  const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
  if (!origin) return null;
  const started = performance.now();
  if (!Number.isFinite(started)) return null;
  const intent = AutonomousPersonalAssistantFinalIntentV4Schema.parse(intentValue);
  const work = ownedWork(workValue, started + intent.invocationDeadlineMs);
  if (typeof trustedCheck !== 'function' || typeof rereadNativeSnapshot !== 'function') return null;
  let failure: { value: unknown } | undefined;
  const check = () => {
    if (failure) throw failure.value;
    try {
      trustedCheck();
      const now = performance.now();
      if (aborted?.call(work.signal)) throw new ExtractionBudgetError('cancelled');
      if (!aborted || !Number.isFinite(now) || now >= work.absoluteMonotonicDeadlineMs)
        throw new ExtractionBudgetError('deadline');
    } catch (error) {
      failure = { value: error };
      throw error;
    }
  };
  check();
  let snapshotValue: unknown;
  try {
    snapshotValue = await rereadNativeSnapshot();
  } catch (error) {
    check();
    throw error;
  }
  check();
  const nativeSnapshot = AutonomousPersonalAssistantNativeSnapshotV4OwnedDataSchema.parse(
    cloneBoundedAutomaticCaptureJson(snapshotValue, 'assistantIntent'),
  );
  const data = freeze(
    AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema.parse({
      origin,
      nativeSnapshot,
      intent,
      sourceId: generateUuid(),
      operationId: generateUuid(),
      beginCallHash: randomBytes(32).toString('hex'),
      completionCallHash: randomBytes(32).toString('hex'),
    }),
  );
  check();
  const token = Object.freeze(
    Object.create(null),
  ) as PrivateAutonomousPersonalAssistantFinalInvocationV4;
  issued.set(token, {
    owner,
    data,
    work,
    check,
    candidateReturned: false,
    reconciliationUsed: false,
  });
  return token;
}

/** Synchronous one-use consumption must happen before the backend's first await. */
export function consumeAutonomousPersonalAssistantFinalInvocationV4(
  owner: object,
  token: unknown,
): PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4 | null {
  if (!object(token)) return null;
  const record = issued.get(token);
  if (!record || record.owner !== owner) return null;
  issued.delete(token);
  record.check();
  const key = Object.freeze(
    Object.create(null),
  ) as PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4;
  consumed.set(key, record);
  return key;
}

function recordFor(owner: object, key: unknown): RecordV4 {
  const record = object(key) ? consumed.get(key) : undefined;
  if (!record || record.owner !== owner) throw fixed();
  record.check();
  return record;
}

/** Original immutable plan/work only; a backend must still validate its actual store/graph. */
export function readAutonomousPersonalAssistantFinalInvocationV4(owner: object, key: unknown) {
  const record = recordFor(owner, key);
  return Object.freeze({ data: record.data, work: record.work, check: record.check });
}

/** Driver retries before staging may reuse the same plan; a returned candidate is fenced. */
export function canStageAutonomousPersonalAssistantFinalV4(owner: object, key: unknown): boolean {
  return !recordFor(owner, key).candidateReturned;
}

export function markAutonomousPersonalAssistantFinalCandidateReturnedV4(
  owner: object,
  key: unknown,
): void {
  const record = recordFor(owner, key);
  if (record.candidateReturned) throw fixed();
  record.candidateReturned = true;
}

/** A readback never resets the original time budget and can be claimed only once. */
export function claimAutonomousPersonalAssistantFinalReconciliationV4(
  owner: object,
  key: unknown,
): boolean {
  const record = recordFor(owner, key);
  if (!record.candidateReturned || record.reconciliationUsed) return false;
  record.reconciliationUsed = true;
  return true;
}

export function closeAutonomousPersonalAssistantFinalInvocationV4(
  owner: object,
  key: unknown,
): void {
  if (!object(key)) return;
  if (issued.get(key)?.owner === owner) issued.delete(key);
  if (consumed.get(key)?.owner === owner) consumed.delete(key);
}
