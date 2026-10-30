import type { IExecuteFunctions } from 'n8n-workflow';
import type { IGraphStorage } from './IGraphStorage';
import type { AutonomousPersonalNativeOriginV4 } from '../schemas/AutonomousPersonalNativeOriginV4.schema';
import type { AutonomousPersonalCompletionStorageV4Result } from '../schemas/AutonomousPersonalCompletionStorageV4.schema';
import {
  checkAutonomousPersonalCompletionV4,
  closeAutonomousPersonalCompletionV4,
  completionFailureResultV4,
  completionFalseResultV4,
  prepareNativeAutonomousPersonalCompletionV4,
  recheckAutonomousPersonalNativeContextV4,
  type AutonomousPersonalCompletionDecisionV4Result,
} from './AutonomousPersonalCaptureHandlesV4';
import { runWithAutonomousPersonalExecutionEntryV1 } from '../utils/AutonomousPersonalExecutionEntryV1';
import {
  consumeAutonomousPersonalCompletionBackendOutcomeV4,
  hasAutonomousPersonalCompletionBackendVerifierV4,
} from './AutonomousPersonalCompletionBackendRegistryV4';

declare const originalTurnBrand: unique symbol;
export type PrivateAutonomousPersonalOriginalTurnV4 = object & {
  readonly [originalTurnBrand]: 'original_turn';
};

export type PrivateAutonomousPersonalNativeCompletionV4 =
  | Readonly<{ kind: 'decision'; result: AutonomousPersonalCompletionDecisionV4Result }>
  | Readonly<{
      kind: 'no_origin';
      observation:
        | Readonly<{ kind: 'unconfirmed' }>
        | Extract<AutonomousPersonalCompletionStorageV4Result, { kind: 'no_write' }>;
    }>
  | Readonly<{ kind: 'original_turn'; origin: PrivateAutonomousPersonalOriginalTurnV4 }>;

// Neither a bridge nor its value retains the owner or the completion lifetime.
const origins = new WeakMap<object, WeakMap<object, AutonomousPersonalNativeOriginV4>>();
const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';

function issueOriginalTurn(
  owner: object,
  origin: AutonomousPersonalNativeOriginV4,
): PrivateAutonomousPersonalOriginalTurnV4 {
  let records = origins.get(owner);
  if (!records) {
    records = new WeakMap();
    origins.set(owner, records);
  }
  const token = Object.freeze(Object.create(null)) as PrivateAutonomousPersonalOriginalTurnV4;
  records.set(token, origin);
  return token;
}

/** Local lineage only. A fixed consumer must independently validate actual storage. */
export function consumeAutonomousPersonalOriginalTurnV4(
  storageOwner: object,
  token: unknown,
): AutonomousPersonalNativeOriginV4 | null {
  if (!isObject(storageOwner) || !isObject(token)) return null;
  const records = origins.get(storageOwner);
  const origin = records?.get(token);
  if (!origin) return null;
  records!.delete(token);
  return origin;
}

const decision = (
  result: AutonomousPersonalCompletionDecisionV4Result,
): PrivateAutonomousPersonalNativeCompletionV4 => Object.freeze({ kind: 'decision', result });
const unconfirmed = (): PrivateAutonomousPersonalNativeCompletionV4 =>
  Object.freeze({ kind: 'no_origin', observation: Object.freeze({ kind: 'unconfirmed' }) });

/** Fixed native entry; no caller DATA can substitute for a backend's confirmed write. */
export async function completeNativeAutonomousPersonalCaptureV4(
  ctx: IExecuteFunctions,
  storageOwner: IGraphStorage,
): Promise<PrivateAutonomousPersonalNativeCompletionV4> {
  try {
    // Reuses the current Admin entry (identical-config assertion, no restart); a direct
    // supported call opens the same fixed entry. Legacy/missing mode runs the original path.
    return await runWithAutonomousPersonalExecutionEntryV1(ctx, () =>
      completeWithinEntryV4(ctx, storageOwner),
    );
  } catch (error) {
    return decision(completionFailureResultV4(error));
  }
}

async function completeWithinEntryV4(
  ctx: IExecuteFunctions,
  storageOwner: IGraphStorage,
): Promise<PrivateAutonomousPersonalNativeCompletionV4> {
  try {
    if (
      !hasAutonomousPersonalCompletionBackendVerifierV4(storageOwner) ||
      typeof storageOwner.beginAndClaimAutonomousPersonalCaptureV4 !== 'function' ||
      typeof storageOwner.prepareAutonomousPersonalCaptureProviderV4 !== 'function' ||
      typeof storageOwner.completeAutonomousPersonalCaptureForNativeV4 !== 'function'
    ) {
      return decision(completionFalseResultV4('unsupported_mode'));
    }

    const prepared = await prepareNativeAutonomousPersonalCompletionV4(ctx, storageOwner);
    if (prepared.kind !== 'completion_prepared') return decision(prepared);

    const { handle } = prepared;
    try {
      checkAutonomousPersonalCompletionV4(storageOwner, handle);
      const token = await storageOwner.completeAutonomousPersonalCaptureForNativeV4(handle);
      const authenticated = consumeAutonomousPersonalCompletionBackendOutcomeV4(
        storageOwner,
        handle,
        token,
      );
      if (!authenticated) return unconfirmed();
      if (authenticated.observation.kind !== 'matched') {
        return Object.freeze({ kind: 'no_origin', observation: authenticated.observation });
      }
      if (!authenticated.proof) return unconfirmed();

      checkAutonomousPersonalCompletionV4(storageOwner, handle);
      const current = await recheckAutonomousPersonalNativeContextV4(ctx, storageOwner, handle);
      if (current.kind === 'decision') return decision(current.result);
      checkAutonomousPersonalCompletionV4(storageOwner, handle);
      return Object.freeze({
        kind: 'original_turn',
        origin: issueOriginalTurn(storageOwner, authenticated.proof.nativeOrigin),
      });
    } finally {
      closeAutonomousPersonalCompletionV4(storageOwner, handle);
    }
  } catch (error) {
    return decision(completionFailureResultV4(error));
  }
}
