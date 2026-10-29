import { types as utilTypes } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { IExecuteFunctions } from 'n8n-workflow';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema,
  AutonomousPersonalMemoryHandoffNativeTupleV4OwnedDataSchema,
  AutonomousPersonalMemoryHandoffPublishResultV4OwnedDataSchema,
  AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema,
  type AutonomousPersonalMemoryHandoffLocatorV4,
  type AutonomousPersonalMemoryHandoffNativeTupleV4,
  type AutonomousPersonalMemoryHandoffPublishResultV4,
  type AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4,
} from '../schemas/AutonomousPersonalMemoryHandoffV4.schema';
import {
  AutonomousPersonalNativeOriginV4OwnedDataSchema,
  type AutonomousPersonalNativeOriginV4,
} from '../schemas/AutonomousPersonalNativeOriginV4.schema';
import {
  consumeAutonomousPersonalOriginalTurnV4,
  type PrivateAutonomousPersonalOriginalTurnV4,
} from './AutonomousPersonalNativeCompletionV4';
import { projectAutonomousPersonalCaptureReceiptSummaryV4 } from './AutonomousPersonalCaptureReceiptSummaryV4';
import type { IGraphStorage } from './IGraphStorage';

declare const memoryLineageV4Brand: unique symbol;

/** Opaque in-process lineage key. It carries no read or write authority. */
export type PrivateAutonomousPersonalMemoryLineageV4 = object & {
  readonly [memoryLineageV4Brand]: 'native_memory_lineage';
};

export type NativeAutonomousPersonalMemoryContextV4 = Pick<
  IExecuteFunctions,
  'getInstanceId' | 'getWorkflow' | 'getExecutionId'
>;

type NativeTupleV4 = AutonomousPersonalMemoryHandoffNativeTupleV4;

const HANDOFF_DOMAIN = 'engram-autonomous-personal-memory-handoff-v4';
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_HANDOFFS = 128;

// The pending Map retains only frozen origin DATA. WeakMaps hold expiry and
// consumed-lineage metadata without keeping origins or opaque keys alive.
const pendingOrigins = new Map<string, AutonomousPersonalNativeOriginV4>();
const pendingExpiry = new WeakMap<AutonomousPersonalNativeOriginV4, number>();
const lineageOrigins = new WeakMap<object, AutonomousPersonalNativeOriginV4>();
const notPublished = Object.freeze(
  AutonomousPersonalMemoryHandoffPublishResultV4OwnedDataSchema.parse({ kind: 'not_published' }),
);
const notPublishedWithSummary = Object.freeze(
  AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema.parse({
    kind: 'not_published',
  }),
);

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';

function deeplyFrozen(value: unknown): boolean {
  if (!isObject(value)) return true;
  if (utilTypes.isProxy(value) || !Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && 'value' in descriptor && deeplyFrozen(descriptor.value));
  });
}

function ownedOrigin(value: unknown): AutonomousPersonalNativeOriginV4 | null {
  if (!isObject(value) || utilTypes.isProxy(value) || !deeplyFrozen(value)) return null;
  try {
    const parsed = AutonomousPersonalNativeOriginV4OwnedDataSchema.safeParse(value);
    if (!parsed.success) return null;
    if (canonicalAutomaticCaptureV2(value) !== canonicalAutomaticCaptureV2(parsed.data))
      return null;
    return value as AutonomousPersonalNativeOriginV4;
  } catch {
    return null;
  }
}

function readNativeTuple(ctx: NativeAutonomousPersonalMemoryContextV4): NativeTupleV4 | null {
  try {
    if (
      ctx === null ||
      typeof ctx !== 'object' ||
      typeof ctx.getInstanceId !== 'function' ||
      typeof ctx.getWorkflow !== 'function' ||
      typeof ctx.getExecutionId !== 'function'
    ) {
      return null;
    }
    const instance = ctx.getInstanceId();
    const workflowValue = ctx.getWorkflow()?.id;
    const execution = ctx.getExecutionId();
    if (
      typeof instance !== 'string' ||
      (workflowValue !== null &&
        workflowValue !== undefined &&
        typeof workflowValue !== 'string') ||
      typeof execution !== 'string'
    ) {
      return null;
    }
    const parsed = AutonomousPersonalMemoryHandoffNativeTupleV4OwnedDataSchema.safeParse({
      instance,
      workflow: workflowValue ?? null,
      execution,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function originMatchesNativeTuple(
  origin: AutonomousPersonalNativeOriginV4,
  native: NativeTupleV4,
): boolean {
  return (
    origin.instance === native.instance &&
    origin.workflow === native.workflow &&
    origin.execution === native.execution
  );
}

function locatorFromOrigin(
  origin: AutonomousPersonalNativeOriginV4,
): AutonomousPersonalMemoryHandoffLocatorV4 {
  return AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema.parse({
    storeHash: origin.identity.storeHash,
    namespace: origin.identity.namespace,
    issuer: origin.identity.issuer,
    actorReference: origin.identity.actorReference,
    turn: origin.identity.turn,
    sourceId: origin.identity.sourceId,
  });
}

function lookupKey(
  native: NativeTupleV4,
  locator: AutonomousPersonalMemoryHandoffLocatorV4,
): string {
  return canonicalAutomaticCaptureV2({
    domain: HANDOFF_DOMAIN,
    instance: native.instance,
    workflow: native.workflow,
    execution: native.execution,
    storeHash: locator.storeHash,
    namespace: locator.namespace,
    issuer: locator.issuer,
    actorReference: locator.actorReference,
    turn: locator.turn,
    sourceId: locator.sourceId,
  });
}

function pruneExpired(now: number): void {
  for (const [key, origin] of pendingOrigins) {
    const expiresAt = pendingExpiry.get(origin);
    if (expiresAt === undefined || expiresAt <= now) pendingOrigins.delete(key);
  }
}

function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

function publishAutonomousPersonalMemoryHandoffCoreV4(
  ctx: NativeAutonomousPersonalMemoryContextV4,
  originalStorageOwner: IGraphStorage,
  originalTurn: PrivateAutonomousPersonalOriginalTurnV4,
  withSummary: false,
): AutonomousPersonalMemoryHandoffPublishResultV4;
function publishAutonomousPersonalMemoryHandoffCoreV4(
  ctx: NativeAutonomousPersonalMemoryContextV4,
  originalStorageOwner: IGraphStorage,
  originalTurn: PrivateAutonomousPersonalOriginalTurnV4,
  withSummary: true,
): AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4;
function publishAutonomousPersonalMemoryHandoffCoreV4(
  ctx: NativeAutonomousPersonalMemoryContextV4,
  originalStorageOwner: IGraphStorage,
  originalTurn: PrivateAutonomousPersonalOriginalTurnV4,
  withSummary: boolean,
):
  | AutonomousPersonalMemoryHandoffPublishResultV4
  | AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4 {
  const unpublished = withSummary ? notPublishedWithSummary : notPublished;
  const start = performance.now();
  if (!Number.isFinite(start)) return unpublished;
  pruneExpired(start);

  let originValue: AutonomousPersonalNativeOriginV4 | null;
  try {
    originValue = consumeAutonomousPersonalOriginalTurnV4(originalStorageOwner, originalTurn);
  } catch {
    return unpublished;
  }
  if (!originValue) return unpublished;

  const origin = ownedOrigin(originValue);
  const native = readNativeTuple(ctx);
  if (!origin || !native || !originMatchesNativeTuple(origin, native)) return unpublished;

  let locator: AutonomousPersonalMemoryHandoffLocatorV4;
  try {
    locator = locatorFromOrigin(origin);
  } catch {
    return unpublished;
  }

  // The optional display projection is derived only from the authenticated, frozen origin.
  // Complete it before touching the pending handoff map, so an invalid summary cannot publish.
  let publishedWithSummary: AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4 | undefined;
  if (withSummary) {
    try {
      const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(
        origin.terminalReceipt,
        () => {},
      );
      if (summary.kind !== 'committed' || summary.sourceId !== locator.sourceId) return unpublished;
      publishedWithSummary = freezeOwned(
        AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema.parse({
          kind: 'published',
          sourceId: locator.sourceId,
          summary,
        }),
      );
    } catch {
      return unpublished;
    }
  }

  const key = lookupKey(native, locator);
  const publishedAt = performance.now();
  if (!Number.isFinite(publishedAt)) return unpublished;
  pruneExpired(publishedAt);
  if (pendingOrigins.has(key) || pendingOrigins.size >= MAX_PENDING_HANDOFFS) return unpublished;

  pendingOrigins.set(key, origin);
  pendingExpiry.set(origin, publishedAt + HANDOFF_TTL_MS);
  if (withSummary) return publishedWithSummary ?? notPublishedWithSummary;
  return Object.freeze(
    AutonomousPersonalMemoryHandoffPublishResultV4OwnedDataSchema.parse({
      kind: 'published',
      sourceId: locator.sourceId,
    }),
  );
}

/**
 * Consume the genuine C2 bridge before its storage owner closes and publish
 * only bounded, frozen origin DATA for a same-execution Memory lookup.
 */
export function publishAutonomousPersonalMemoryHandoffV4(
  ctx: NativeAutonomousPersonalMemoryContextV4,
  originalStorageOwner: IGraphStorage,
  originalTurn: PrivateAutonomousPersonalOriginalTurnV4,
): AutonomousPersonalMemoryHandoffPublishResultV4 {
  return publishAutonomousPersonalMemoryHandoffCoreV4(
    ctx,
    originalStorageOwner,
    originalTurn,
    false,
  );
}

/** Publish the same one-use lineage together with its bounded creation-time receipt summary. */
export function publishAutonomousPersonalMemoryHandoffWithSummaryV4(
  ctx: NativeAutonomousPersonalMemoryContextV4,
  originalStorageOwner: IGraphStorage,
  originalTurn: PrivateAutonomousPersonalOriginalTurnV4,
): AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4 {
  return publishAutonomousPersonalMemoryHandoffCoreV4(
    ctx,
    originalStorageOwner,
    originalTurn,
    true,
  );
}

/**
 * Match one handoff using the current native execution and strict current
 * storage/source locator DATA, then return a one-use opaque lineage key.
 */
export function consumeAutonomousPersonalMemoryHandoffV4(
  ctx: NativeAutonomousPersonalMemoryContextV4,
  currentStoreHash: string,
  currentNamespace: string,
  currentIssuer: string,
  currentActorReference: string,
  currentTurn: string,
  currentSourceId: string,
): PrivateAutonomousPersonalMemoryLineageV4 | null {
  const now = performance.now();
  if (!Number.isFinite(now)) return null;
  pruneExpired(now);

  const native = readNativeTuple(ctx);
  if (!native) return null;

  let locator: AutonomousPersonalMemoryHandoffLocatorV4;
  try {
    locator = AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema.parse({
      storeHash: currentStoreHash,
      namespace: currentNamespace,
      issuer: currentIssuer,
      actorReference: currentActorReference,
      turn: currentTurn,
      sourceId: currentSourceId,
    });
  } catch {
    return null;
  }

  const key = lookupKey(native, locator);
  let matchingOrigin: AutonomousPersonalNativeOriginV4 | undefined;
  let matchingKey: string | undefined;
  let matchCount = 0;
  for (const [candidateKey, origin] of pendingOrigins) {
    if (candidateKey === key) {
      matchingOrigin = origin;
      matchingKey = candidateKey;
      matchCount += 1;
    }
  }
  if (matchCount !== 1 || !matchingOrigin || !matchingKey) return null;

  pendingOrigins.delete(matchingKey);
  const lineage = Object.freeze(Object.create(null)) as PrivateAutonomousPersonalMemoryLineageV4;
  lineageOrigins.set(lineage, matchingOrigin);
  return lineage;
}

/** Internal DATA read for the separately approved actual-parent validator. */
export function getAutonomousPersonalMemoryLineageOriginV4(
  lineage: unknown,
): AutonomousPersonalNativeOriginV4 | null {
  if (!isObject(lineage) || utilTypes.isProxy(lineage)) return null;
  return lineageOrigins.get(lineage) ?? null;
}
