// Frozen 0.8.1 compatibility oracle for bounded JSON regression tests.
// Keep unchanged when optimizing production code; intentional contract changes need review.
import { types as utilTypes } from 'util';

export const AUTOMATIC_CAPTURE_JSON_BOUNDS = Object.freeze({
  policyData: Object.freeze({ maxBytes: 16 * 1024, maxNodes: 1024, maxDepth: 16 }),
  // A 65,536-byte UTF-8 source may expand when JSON escapes control characters.
  beginRequest: Object.freeze({ maxBytes: 512 * 1024, maxNodes: 16_384, maxDepth: 32 }),
  // Assistant-final intents carry both the human raw turn and the final AI source.
  // Two individually valid 65,536-byte strings can each expand sixfold in JSON.
  assistantIntent: Object.freeze({ maxBytes: 1024 * 1024, maxNodes: 16_384, maxDepth: 32 }),
  plan: Object.freeze({ maxBytes: 512 * 1024, maxNodes: 100_000, maxDepth: 48 }),
  graph: Object.freeze({ maxBytes: 100 * 1024 * 1024, maxNodes: 8_000_000, maxDepth: 64 }),
});
export type AutomaticCaptureJsonBound = keyof typeof AUTOMATIC_CAPTURE_JSON_BOUNDS;
export type BoundedAutomaticCaptureJsonFailureReason = 'bytes' | 'nodes' | 'depth' | 'invalid_json';

export class BoundedAutomaticCaptureJsonError extends Error {
  constructor(readonly reason: BoundedAutomaticCaptureJsonFailureReason) {
    super('Engram automatic memory: bounded_json_invalid');
    this.name = 'BoundedAutomaticCaptureJsonError';
  }
}

interface CloneBudget {
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  bytes: number;
  nodes: number;
  readonly active: WeakSet<object>;
}

function boundedInvalid(reason: BoundedAutomaticCaptureJsonFailureReason = 'invalid_json'): never {
  throw new BoundedAutomaticCaptureJsonError(reason);
}

function addBudgetBytes(budget: CloneBudget, bytes: number): void {
  budget.bytes += bytes;
  if (budget.bytes > budget.maxBytes) boundedInvalid('bytes');
}

function addBudgetNodes(budget: CloneBudget, nodes = 1): void {
  budget.nodes += nodes;
  if (budget.nodes > budget.maxNodes) boundedInvalid('nodes');
}

function encodedJsonStringBytes(value: string, remainingBytes: number): number {
  // UTF-16 length is a lower bound on JSON UTF-8 bytes. Reject oversized input
  // before scanning its code units or allocating a UTF-8 buffer.
  if (value.length > remainingBytes) boundedInvalid('bytes');
  let bytes = 2; // JSON quotes
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes +=
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // JSON.stringify emits the pair as the corresponding four-byte UTF-8 point.
        bytes += 4;
        index += 1;
      } else {
        // Well-formed JSON stringification escapes an unpaired surrogate.
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code === 0x2028 || code === 0x2029) {
      // Count these conservatively in case the runtime serializer escapes them.
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > remainingBytes) boundedInvalid('bytes');
  }
  return bytes;
}

/** Prototype classification only; this does not establish data or source authority. */
export function isNativePlainAutomaticCaptureObject(value: object): boolean {
  if (utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return true;

    // Values produced by structuredClone (and JSON parsed in another realm)
    // have that realm's Object.prototype. Admit only a genuine native Object
    // prototype: custom prototypes and class instances remain rejected.
    if (utilTypes.isProxy(prototype) || Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function')
      return false;
    const nativeObject = constructor.value;
    if (utilTypes.isProxy(nativeObject)) return false;
    const name = Object.getOwnPropertyDescriptor(nativeObject, 'name');
    const objectPrototype = Object.getOwnPropertyDescriptor(nativeObject, 'prototype');
    return (
      name !== undefined &&
      'value' in name &&
      name.value === 'Object' &&
      objectPrototype !== undefined &&
      'value' in objectPrototype &&
      objectPrototype.value === prototype &&
      Function.prototype.toString.call(nativeObject) === 'function Object() { [native code] }'
    );
  } catch {
    return false;
  }
}

function ownArrayLength(value: unknown): number | null {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return null;
  return value.length;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || !isNativePlainAutomaticCaptureObject(value))
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function preflightNamedBound(value: unknown, bound: AutomaticCaptureJsonBound): void {
  if (!isNativePlainAutomaticCaptureObject(value as object)) boundedInvalid();
  if (bound === 'beginRequest' || bound === 'assistantIntent' || bound === 'policyData') return;
  if (bound === 'plan') {
    const sourceGuards = ownArrayLength(ownDataProperty(value, 'source_guards'));
    const entities = ownArrayLength(ownDataProperty(value, 'entities'));
    const edges = ownArrayLength(ownDataProperty(value, 'edges'));
    if (sourceGuards === null || entities === null || edges === null) boundedInvalid();
    if (sourceGuards === 0) boundedInvalid();
    if (sourceGuards > 1 || entities > 64 || edges > 128) boundedInvalid('nodes');
    return;
  }

  const recordCounts = ['entities', 'edges', 'episodes'].map((key) =>
    ownArrayLength(ownDataProperty(value, key)),
  );
  if (recordCounts.some((count) => count === null)) boundedInvalid();
  const totalRecords = (recordCounts as number[]).reduce((sum, count) => sum + count, 0);
  if (totalRecords > 100_000) boundedInvalid('nodes');
}

/** Clone JSON data without invoking accessors/toJSON or serializing before bounds checks. */
export function cloneBoundedAutomaticCaptureJson<T>(
  value: unknown,
  bound: AutomaticCaptureJsonBound,
): T {
  preflightNamedBound(value, bound);
  const limits = AUTOMATIC_CAPTURE_JSON_BOUNDS[bound];
  const budget: CloneBudget = { ...limits, bytes: 0, nodes: 0, active: new WeakSet() };

  const clone = (current: unknown, depth: number): unknown => {
    if (depth > budget.maxDepth) boundedInvalid('depth');
    addBudgetNodes(budget);

    if (current === null) {
      addBudgetBytes(budget, 4);
      return null;
    }
    if (typeof current === 'string') {
      addBudgetBytes(budget, encodedJsonStringBytes(current, budget.maxBytes - budget.bytes));
      return current;
    }
    if (typeof current === 'boolean') {
      addBudgetBytes(budget, current ? 4 : 5);
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) boundedInvalid();
      const serialized = JSON.stringify(current);
      if (typeof serialized !== 'string') boundedInvalid();
      addBudgetBytes(budget, serialized.length);
      return current;
    }
    if (typeof current !== 'object' || utilTypes.isProxy(current)) boundedInvalid();
    if (budget.active.has(current)) boundedInvalid();
    budget.active.add(current);

    if (Array.isArray(current)) {
      if (current.length > budget.maxNodes - budget.nodes) boundedInvalid('nodes');
      addBudgetBytes(budget, 2);
      const keys = Reflect.ownKeys(current);
      addBudgetNodes(budget, keys.length);
      if (keys.length !== current.length + 1) boundedInvalid();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length');
      if (
        !lengthDescriptor ||
        lengthDescriptor.enumerable ||
        !('value' in lengthDescriptor) ||
        lengthDescriptor.value !== current.length
      ) {
        boundedInvalid();
      }
      const cloned: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !('value' in descriptor) ||
          typeof descriptor.get === 'function' ||
          typeof descriptor.set === 'function'
        ) {
          boundedInvalid();
        }
        if (index > 0) addBudgetBytes(budget, 1);
        cloned.push(clone(descriptor.value, depth + 1));
      }
      for (const key of keys) {
        if (typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key)))
          boundedInvalid();
      }
      budget.active.delete(current);
      return cloned;
    }

    if (!isNativePlainAutomaticCaptureObject(current)) boundedInvalid();
    addBudgetBytes(budget, 2);
    const keys = Reflect.ownKeys(current);
    addBudgetNodes(budget, keys.length);
    const cloned: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let propertyIndex = 0;
    for (const key of keys) {
      if (typeof key !== 'string' || key === 'toJSON') boundedInvalid();
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        typeof descriptor.get === 'function' ||
        typeof descriptor.set === 'function'
      ) {
        boundedInvalid();
      }
      if (propertyIndex > 0) addBudgetBytes(budget, 1);
      addBudgetBytes(budget, encodedJsonStringBytes(key, budget.maxBytes - budget.bytes));
      addBudgetBytes(budget, 1); // colon
      const child = clone(descriptor.value, depth + 1);
      Object.defineProperty(cloned, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      propertyIndex += 1;
    }
    budget.active.delete(current);
    return cloned;
  };

  return clone(value, 0) as T;
}
