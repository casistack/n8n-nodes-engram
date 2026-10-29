import { types as utilTypes } from 'node:util';
import {
  AutonomousPersonalNativeOriginV4OwnedDataSchema,
  type AutonomousPersonalNativeOriginV4,
} from '../schemas/AutonomousPersonalNativeOriginV4.schema';
import {
  AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema,
  type AutonomousPersonalCompletionStorageV4Result,
} from '../schemas/AutonomousPersonalCompletionStorageV4.schema';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import {
  getAutonomousPersonalCompletionAccessV4,
  isAutonomousPersonalCompletionAccessForHandleV4,
  isAutonomousPersonalCompletionHandleOpenV4,
  type PrivateAutonomousPersonalCompletionAccessV4,
  type PrivateAutonomousPersonalCompletionHandleV4,
} from './AutonomousPersonalCaptureHandlesV4';

declare const backendOutcomeBrand: unique symbol;
export type PrivateAutonomousPersonalCompletionBackendOutcomeV4 = object & {
  readonly [backendOutcomeBrand]: 'backend_outcome';
};

export type PrivateAutonomousPersonalCompletionProofViewV4 = Readonly<{
  nativeOrigin: AutonomousPersonalNativeOriginV4;
}>;

export type PrivateAutonomousPersonalCompletionBackendOutcomeViewV4 = Readonly<{
  observation: AutonomousPersonalCompletionStorageV4Result;
  proof: PrivateAutonomousPersonalCompletionProofViewV4 | null;
}>;

export type TrustedAutonomousPersonalCompletionWitnessLinkV4 = Readonly<{
  originalHandle: PrivateAutonomousPersonalCompletionHandleV4;
  completionAccess: PrivateAutonomousPersonalCompletionAccessV4;
  nativeOrigin: AutonomousPersonalNativeOriginV4;
}>;

export type ReadTrustedAutonomousPersonalCompletionWitnessV4 = (
  witness: unknown,
) => TrustedAutonomousPersonalCompletionWitnessLinkV4 | null;

type Verifier = (
  handle: unknown,
  token: unknown,
) => PrivateAutonomousPersonalCompletionBackendOutcomeViewV4 | null;

type OutcomeRecord = {
  readonly handle: PrivateAutonomousPersonalCompletionHandleV4;
  readonly observation: AutonomousPersonalCompletionStorageV4Result;
  readonly link: TrustedAutonomousPersonalCompletionWitnessLinkV4 | null;
};

const verifiers = new WeakMap<object, Verifier>();
const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';
const same = (left: unknown, right: unknown) =>
  canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
const invalidValue = () => new Error('Engram native completion registry: invalid_value');

function deeplyFrozen(value: unknown): boolean {
  if (!isObject(value)) return true;
  if (utilTypes.isProxy(value) || !Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && 'value' in descriptor && deeplyFrozen(descriptor.value));
  });
}

function readOwnLink(value: unknown): TrustedAutonomousPersonalCompletionWitnessLinkV4 | null {
  if (!isObject(value) || utilTypes.isProxy(value)) return null;
  const keys = Reflect.ownKeys(value);
  const required = ['originalHandle', 'completionAccess', 'nativeOrigin'] as const;
  const allowed = new Set<string>(required);
  if (
    keys.length !== required.length ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
  )
    return null;
  const fields = required.map((key) => Object.getOwnPropertyDescriptor(value, key));
  if (fields.some((field) => !field || !field.enumerable || !('value' in field))) return null;
  return Object.freeze({
    originalHandle: fields[0]!.value as PrivateAutonomousPersonalCompletionHandleV4,
    completionAccess: fields[1]!.value as PrivateAutonomousPersonalCompletionAccessV4,
    nativeOrigin: fields[2]!.value as AutonomousPersonalNativeOriginV4,
  });
}

/** Bind an already backend-owned witness to the exact live prepared completion. */
function linkMatches(
  owner: object,
  handle: PrivateAutonomousPersonalCompletionHandleV4,
  link: TrustedAutonomousPersonalCompletionWitnessLinkV4,
): boolean {
  if (
    link.originalHandle !== handle ||
    !isAutonomousPersonalCompletionAccessForHandleV4(owner, handle, link.completionAccess)
  )
    return false;
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(link.nativeOrigin, 'beginRequest');
    const parsed = AutonomousPersonalNativeOriginV4OwnedDataSchema.safeParse(owned);
    if (!parsed.success || !same(owned, parsed.data) || !deeplyFrozen(link.nativeOrigin))
      return false;
    const { view } = getAutonomousPersonalCompletionAccessV4(owner, link.completionAccess);
    const origin = parsed.data;
    const identity = view.stagedFresh.operation.identity;
    const receipt = origin.terminalReceipt;
    const matches =
      same(origin.identity, identity) &&
      origin.instance === view.scope.context.instance &&
      origin.workflow === view.scope.context.workflow &&
      origin.execution === view.scope.context.execution &&
      origin.attemptHash === view.scope.attemptHash &&
      origin.completionCallHash === view.completionCallHash &&
      receipt.operationId === view.scope.operationId &&
      receipt.sourceId === identity.sourceId &&
      receipt.sourceHash === identity.sourceHash &&
      receipt.descriptorHash === identity.descriptorHash &&
      receipt.policyFingerprint === identity.policyFingerprint &&
      Date.parse(receipt.terminalAt) >= Date.parse(view.stagedFresh.operation.lastObservedAt) &&
      view.stagedFresh.operation.state === 'leased' &&
      Date.parse(receipt.terminalAt) < Date.parse(view.stagedFresh.operation.lease.expiresAt);
    return (
      matches &&
      isAutonomousPersonalCompletionAccessForHandleV4(owner, handle, link.completionAccess)
    );
  } catch {
    return false;
  }
}

/** Instance-private registry; only the backend's local witness reader supplies proof links. */
export class AutonomousPersonalCompletionBackendRegistryV4 {
  private readonly records = new WeakMap<object, OutcomeRecord>();

  constructor(
    private readonly owner: object,
    private readonly readTrustedWitness: ReadTrustedAutonomousPersonalCompletionWitnessV4,
  ) {
    if (
      !isObject(owner) ||
      utilTypes.isProxy(owner) ||
      typeof readTrustedWitness !== 'function' ||
      utilTypes.isProxy(readTrustedWitness) ||
      utilTypes.isAsyncFunction(readTrustedWitness)
    )
      throw invalidValue();
  }

  registerCoreOutcome(
    originalHandle: PrivateAutonomousPersonalCompletionHandleV4,
    observationValue: AutonomousPersonalCompletionStorageV4Result,
    witnessOpaqueOrNull: unknown | null,
  ): PrivateAutonomousPersonalCompletionBackendOutcomeV4 {
    if (!isAutonomousPersonalCompletionHandleOpenV4(this.owner, originalHandle))
      throw invalidValue();
    let observation: AutonomousPersonalCompletionStorageV4Result;
    try {
      observation = Object.freeze(
        AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema.parse(
          cloneBoundedAutomaticCaptureJson(observationValue, 'beginRequest'),
        ),
      );
    } catch {
      throw invalidValue();
    }

    let link: TrustedAutonomousPersonalCompletionWitnessLinkV4 | null = null;
    if (witnessOpaqueOrNull !== null) {
      try {
        const read = readOwnLink(this.readTrustedWitness(witnessOpaqueOrNull));
        if (observation.kind === 'matched' && read && linkMatches(this.owner, originalHandle, read))
          link = read;
      } catch {
        // A rejected or broken witness can never upgrade observation DATA.
      }
    }
    const token = Object.freeze(
      Object.create(null),
    ) as PrivateAutonomousPersonalCompletionBackendOutcomeV4;
    this.records.set(token, { handle: originalHandle, observation, link });
    return token;
  }

  consume(
    handle: unknown,
    token: unknown,
  ): PrivateAutonomousPersonalCompletionBackendOutcomeViewV4 | null {
    if (!isObject(token)) return null;
    const record = this.records.get(token);
    if (!record || record.handle !== handle) return null;
    if (!isAutonomousPersonalCompletionHandleOpenV4(this.owner, handle)) {
      this.records.delete(token);
      return null;
    }
    this.records.delete(token);
    const proof =
      record.link && linkMatches(this.owner, record.handle, record.link)
        ? Object.freeze({ nativeOrigin: record.link.nativeOrigin })
        : null;
    return Object.freeze({ observation: record.observation, proof });
  }
}

/** One-time read-only verifier registration; no witness or issuer is accepted here. */
export function registerAutonomousPersonalCompletionBackendVerifierV4(
  owner: object,
  verifier: Verifier,
): void {
  if (
    !isObject(owner) ||
    utilTypes.isProxy(owner) ||
    typeof verifier !== 'function' ||
    utilTypes.isProxy(verifier) ||
    utilTypes.isAsyncFunction(verifier) ||
    verifiers.has(owner)
  )
    throw invalidValue();
  verifiers.set(owner, verifier);
}

export function hasAutonomousPersonalCompletionBackendVerifierV4(owner: object): boolean {
  return isObject(owner) && verifiers.has(owner);
}

export function consumeAutonomousPersonalCompletionBackendOutcomeV4(
  owner: object,
  handle: unknown,
  token: unknown,
): PrivateAutonomousPersonalCompletionBackendOutcomeViewV4 | null {
  if (!isObject(owner)) return null;
  return verifiers.get(owner)?.(handle, token) ?? null;
}
