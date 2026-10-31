import { types as utilTypes } from 'util';
import { GraphDataSchema, type GraphData } from '../schemas/GraphData.schema';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AUTOMATIC_CAPTURE_JSON_BOUNDS,
  cloneBoundedAutomaticCaptureJson,
} from './BoundedAutomaticCaptureJson';

const FAST_EQUAL_MAX_DEPTH = 64;
/** One more than the bounded clone depth, so a graph the clone accepts always fits. */
const PROOF_MAX_DEPTH = AUTOMATIC_CAPTURE_JSON_BOUNDS.graph.maxDepth + 1;
const PROOF_CHECK_INTERVAL = 1024;

interface ProofState {
  visited: number;
  readonly cap: number;
  readonly check: () => void;
}

function proofDataValue(value: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
  return { value: descriptor.value };
}

/**
 * Separate descriptor walker for whole-graph proof. It has NO identity shortcut: every
 * object on both sides is inspected, including references shared by both graphs.
 */
function proveEqual(left: unknown, right: unknown, depth: number, state: ProofState): boolean {
  if (depth > PROOF_MAX_DEPTH) return false;
  state.visited += 1;
  if (state.visited > state.cap) return false;
  if (state.visited % PROOF_CHECK_INTERVAL === 0) state.check();

  if (left === null) return right === null;
  if (typeof left === 'string' || typeof left === 'boolean') return left === right;
  if (typeof left === 'number') {
    // `-0 === 0` is intended: both have the canonical form "0".
    return typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right)
      ? left === right
      : false;
  }
  if (typeof left !== 'object') return false;
  if (right === null || typeof right !== 'object') return false;
  if (utilTypes.isProxy(left) || utilTypes.isProxy(right)) return false;

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const leftArray = left as unknown[];
    const rightArray = right as unknown[];
    if (leftArray.length !== rightArray.length) return false;
    if (Reflect.ownKeys(leftArray).length !== leftArray.length + 1) return false;
    if (Reflect.ownKeys(rightArray).length !== rightArray.length + 1) return false;
    for (let index = 0; index < leftArray.length; index += 1) {
      const key = String(index);
      const leftEntry = proofDataValue(leftArray, key);
      const rightEntry = proofDataValue(rightArray, key);
      if (!leftEntry || !rightEntry) return false;
      if (!proveEqual(leftEntry.value, rightEntry.value, depth + 1, state)) return false;
    }
    return true;
  }

  for (const side of [left, right]) {
    const prototype = Object.getPrototypeOf(side);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (typeof key !== 'string' || key === '__proto__') return false;
    const leftEntry = proofDataValue(left, key);
    const rightEntry = proofDataValue(right, key);
    if (!leftEntry || !rightEntry) return false;
    if (!proveEqual(leftEntry.value, rightEntry.value, depth + 1, state)) return false;
  }
  return true;
}

/**
 * Structural identity proof of two whole graphs at call time. Not an authority token and
 * says nothing about the future: callers must use it synchronously with call-local data.
 * `true` only when every root field (no exclusions) and every nested value is identical.
 * Hostile or unsupported input returns false and never throws; an exception from `check`
 * propagates so cancellation and deadlines stay authoritative. Options can only lower the
 * node cap, which is derived from the existing bounded graph limit.
 */
export function provenIdenticalLosslessGraphData(
  left: GraphData,
  right: GraphData,
  options: { check?: () => void; maxNodes?: number } = {},
): boolean {
  const limit = AUTOMATIC_CAPTURE_JSON_BOUNDS.graph.maxNodes;
  const cap =
    typeof options.maxNodes === 'number' &&
    Number.isSafeInteger(options.maxNodes) &&
    options.maxNodes >= 0
      ? Math.min(options.maxNodes, limit)
      : limit;
  const userCheck = options.check;
  // A flag, not an identity comparison: any thrown value (NaN, undefined, null, 0, '',
  // false) must propagate.
  let checkThrew = false;
  let checkThrown: unknown;
  const check = () => {
    try {
      userCheck?.();
    } catch (error) {
      checkThrew = true;
      checkThrown = error;
      throw error;
    }
  };
  check();
  let proven = false;
  try {
    const roots = [left, right] as unknown[];
    proven =
      roots.every(
        (root) =>
          root !== null &&
          typeof root === 'object' &&
          !Array.isArray(root) &&
          !utilTypes.isProxy(root),
      ) && proveEqual(left, right, 0, { visited: 0, cap, check });
  } catch {
    if (checkThrew) throw checkThrown;
    proven = false;
  }
  check();
  return proven;
}

function fastDataDescriptorValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * Module-private and never exported. `true` implies the canonical recipe is
 * equal for both values, including `-0`/`0`. `false` only means "unknown":
 * the caller must fall back to the canonical comparison, which keeps the
 * verdict. Only own enumerable plain data properties are compared; accessors,
 * proxies, non-plain prototypes, symbols, `__proto__`, `undefined` and depth
 * beyond the bounded clone limit are all unknown.
 */
function losslessFastEqual(before: unknown, after: unknown, depth: number): boolean {
  if (before === after) return before !== undefined;
  if (depth > FAST_EQUAL_MAX_DEPTH) return false;
  if (
    before === null ||
    after === null ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    utilTypes.isProxy(before) ||
    utilTypes.isProxy(after)
  )
    return false;
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || before.length !== after.length) return false;
    if (Reflect.ownKeys(before).length !== before.length + 1) return false;
    if (Reflect.ownKeys(after).length !== after.length + 1) return false;
    for (let index = 0; index < before.length; index += 1) {
      const key = String(index);
      const left = fastDataDescriptorValue(before, key);
      const right = fastDataDescriptorValue(after, key);
      if (left === undefined || right === undefined) return false;
      if (!losslessFastEqual(left, right, depth + 1)) return false;
    }
    return true;
  }
  if (Array.isArray(after)) return false;
  for (const value of [before, after]) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  const beforeKeys = Reflect.ownKeys(before);
  const afterKeys = Reflect.ownKeys(after);
  if (beforeKeys.length !== afterKeys.length) return false;
  for (const key of beforeKeys) {
    if (typeof key !== 'string' || key === '__proto__') return false;
    const left = fastDataDescriptorValue(before, key);
    const right = fastDataDescriptorValue(after, key);
    if (left === undefined || right === undefined) return false;
    if (!losslessFastEqual(left, right, depth + 1)) return false;
  }
  return true;
}

function losslessCanonicalEqual(before: unknown, after: unknown): boolean {
  let fast = false;
  try {
    fast = losslessFastEqual(before, after, 0);
  } catch {
    fast = false;
  }
  return fast || canonicalAutomaticCaptureV2(before) === canonicalAutomaticCaptureV2(after);
}

/**
 * New capture writes must not normalize existing records as a side effect.
 * Schema validation may reject a representation, but may not silently drop
 * metadata or add defaults to a stored record while admitting a new capture.
 * This is separate from the unchanged legacy migration/read behavior.
 */
export function parseLosslessAutomaticCaptureGraph(value: unknown): GraphData {
  const bounded = cloneBoundedAutomaticCaptureJson<GraphData>(value, 'graph');
  const parsed = GraphDataSchema.parse(bounded);
  const beforeRoot = bounded as unknown as Record<string, unknown>;
  const afterRoot = parsed as unknown as Record<string, unknown>;
  if (
    canonicalAutomaticCaptureV2(Object.keys(beforeRoot).sort()) !==
    canonicalAutomaticCaptureV2(Object.keys(afterRoot).sort())
  )
    throw new Error('Engram automatic capture: record_normalization');
  for (const key of Object.keys(beforeRoot)) {
    if (['entities', 'edges', 'episodes', 'automatic_operations_v1'].includes(key)) continue;
    if (!losslessCanonicalEqual(beforeRoot[key], afterRoot[key]))
      throw new Error('Engram automatic capture: record_normalization');
  }
  for (const key of ['entities', 'edges', 'episodes'] as const) {
    if (bounded[key].length !== parsed[key].length)
      throw new Error('Engram automatic capture: record_normalization');
    for (let index = 0; index < bounded[key].length; index++) {
      if (!losslessCanonicalEqual(bounded[key][index], parsed[key][index]))
        throw new Error('Engram automatic capture: record_normalization');
    }
  }
  const beforeOperations = bounded.automatic_operations_v1?.operations ?? [];
  const afterOperations = parsed.automatic_operations_v1?.operations ?? [];
  if (beforeOperations.length !== afterOperations.length)
    throw new Error('Engram automatic capture: record_normalization');
  for (let index = 0; index < beforeOperations.length; index++) {
    if (!losslessCanonicalEqual(beforeOperations[index], afterOperations[index]))
      throw new Error('Engram automatic capture: record_normalization');
  }
  return parsed;
}
