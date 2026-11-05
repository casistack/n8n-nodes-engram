import { types as utilTypes } from 'util';
import { z } from 'zod';
import type { GraphData } from '../schemas/GraphData.schema';
import { AUTOMATIC_CAPTURE_JSON_BOUNDS } from './BoundedAutomaticCaptureJson';
import {
  parseLosslessAutomaticCaptureGraph,
  provenIdenticalLosslessGraphData,
} from './LosslessAutomaticCaptureGraph';

/**
 * Roots this module itself fully parsed and deep-froze. Membership is DATA immutability
 * only: never authority, currency, namespace, binding, or integrity. Caller objects are
 * never added, whatever their frozen state, flags, or contents.
 */
const ownedRoots = new WeakSet<object>();

const FREEZE_MAX_NODES = AUTOMATIC_CAPTURE_JSON_BOUNDS.graph.maxNodes * 2;

class ImmutableGraphSnapshotError extends Error {
  constructor() {
    super('Engram immutable graph: unsupported_value');
    this.name = 'ImmutableGraphSnapshotError';
  }
}

/** Freezes this module's fresh parser output. Rejects anything but plain data. */
function deepFreezeOwnedParse(root: object): void {
  const pending: object[] = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (seen.size > FREEZE_MAX_NODES || utilTypes.isProxy(current))
      throw new ImmutableGraphSnapshotError();
    const isArray = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (!isArray && prototype !== Object.prototype && prototype !== null)
      throw new ImmutableGraphSnapshotError();
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (!('value' in descriptor)) throw new ImmutableGraphSnapshotError();
      const child: unknown = descriptor.value;
      if (child !== null && typeof child === 'object') pending.push(child);
      else if (typeof child === 'function') throw new ImmutableGraphSnapshotError();
    }
    Object.freeze(current);
  }
}

/**
 * Returns `value` only if it is a root this module registered; never parses.
 * Callers must still run every semantic check on the result.
 */
export function getOwnedImmutableGraphData(value: unknown): GraphData | undefined {
  return value !== null && typeof value === 'object' && ownedRoots.has(value)
    ? (value as GraphData)
    : undefined;
}

/**
 * Explicit immutable entry. An owned root is returned as-is (no schema reparse); any other
 * input, frozen or not, is fully parsed by parseLosslessAutomaticCaptureGraph, and that
 * fresh output is deep-frozen and registered. The default parser stays fresh and mutable.
 */
export function parseImmutableGraphData(value: unknown): GraphData {
  const owned = getOwnedImmutableGraphData(value);
  if (owned) return owned;
  const parsed = parseLosslessAutomaticCaptureGraph(value);
  deepFreezeOwnedParse(parsed);
  ownedRoots.add(parsed);
  return parsed;
}

function cloneOwnedValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value; // Keeps -0.
  if (Array.isArray(value)) return value.map(cloneOwnedValue);
  // Same prototype (null or this realm's Object.prototype) and own key order as the
  // parser output, unlike structuredClone, which always yields Object.prototype.
  const copy = Object.create(Object.getPrototypeOf(value) as object | null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(value)) {
    // defineProperty, not assignment, so a `__proto__` data key stays a data key.
    Object.defineProperty(copy, key, {
      value: cloneOwnedValue((value as Record<string, unknown>)[key]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Fresh, fully mutable copy of an owned root, shaped like the original parser output.
 * Accepts only roots this module registered (frozen caller data is rejected), never
 * registers the copy, and shares no object with the immutable root.
 */
export function cloneOwnedImmutableGraphData(root: GraphData): GraphData {
  if (!getOwnedImmutableGraphData(root)) throw new ImmutableGraphSnapshotError();
  return cloneOwnedValue(root) as GraphData;
}

const REBASE_ROOT_KEYS = new Set([
  'version',
  'exported_at',
  'entities',
  'edges',
  'episodes',
  'metadata',
  'automatic_operations_v1',
  'group_id',
]);
const CANONICAL_EXPORTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXPORTED_AT_SCHEMA = z.string().datetime();

function ownDataValue(value: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && descriptor.enumerable && 'value' in descriptor
    ? { value: descriptor.value }
    : undefined;
}

/** Plain enumerable data string, canonical 24-char ISO, accepted by the schema. */
function canonicalExportedAt(value: object): string | undefined {
  const text = ownDataValue(value, 'exported_at')?.value;
  return typeof text === 'string' &&
    text.length === 24 &&
    CANONICAL_EXPORTED_AT.test(text) &&
    EXPORTED_AT_SCHEMA.safeParse(text).success &&
    new Date(text).toISOString() === text
    ? text
    : undefined;
}

/**
 * Data-only rebase of an owned root onto a current export that differs at most in
 * exported_at. Returns an owned immutable root, never authority; callers must still run
 * every semantic check. Built only from the owned root's frozen children (nothing from
 * currentExport is referenced), then proven identical to currentExport before use.
 * Any unsupported shape returns undefined; exceptions from check propagate.
 */
export function tryRebaseOwnedGraphExport(
  root: unknown,
  currentExport: unknown,
  check: () => void,
): GraphData | undefined {
  check();
  const owned = getOwnedImmutableGraphData(root);
  if (
    !owned ||
    currentExport === null ||
    typeof currentExport !== 'object' ||
    Array.isArray(currentExport) ||
    utilTypes.isProxy(currentExport)
  )
    return undefined;
  const candidate: Record<string, unknown> = {};
  try {
    const keys = Reflect.ownKeys(owned);
    if (keys.length > REBASE_ROOT_KEYS.size) return undefined;
    if (Object.getPrototypeOf(owned) !== Object.prototype) return undefined;
    const exportedAt = canonicalExportedAt(currentExport);
    if (!canonicalExportedAt(owned) || !exportedAt) return undefined;
    for (const key of keys) {
      if (typeof key !== 'string' || !REBASE_ROOT_KEYS.has(key)) return undefined;
      const entry = ownDataValue(owned, key);
      if (!entry) return undefined;
      Object.defineProperty(candidate, key, {
        value: key === 'exported_at' ? exportedAt : entry.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  } catch {
    return undefined;
  }
  check();
  Object.freeze(candidate);
  const rebased = candidate as unknown as GraphData;
  if (!provenIdenticalLosslessGraphData(rebased, currentExport as GraphData, { check }))
    return undefined;
  check();
  ownedRoots.add(rebased);
  return rebased;
}
