import { z } from 'zod';
import {
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject as nativePlainObject,
} from '../storage/BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from '../storage/LosslessAutomaticCaptureGraph';
import type { GraphData } from './GraphData.schema';

const invalidSnapshot = { status: 'invalid', reason: 'invalid_snapshot' } as const;
const validGraphs = new WeakSet<object>();
const resourceIssueMessages = new Set([
  'resource_exhausted',
  'Ledger-bearing graph snapshot exceeds 100,000 graph records',
  'Ledger-bearing graph snapshot must not exceed 100 MiB serialized',
]);

function exactOwnDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !nativePlainObject(value)
  )
    return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    )
      return null;
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !('value' in property)) return null;
      output[key] = property.value;
    }
    return output;
  } catch {
    return null;
  }
}

function ownData(value: unknown, key: string): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !nativePlainObject(value)
  )
    return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && property.enumerable && 'value' in property ? property.value : undefined;
  } catch {
    return undefined;
  }
}

function resourceBoundedGraphFailure(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === 'object' &&
    'reason' in error &&
    ['bytes', 'nodes', 'depth'].includes(String(error.reason))
  )
    return true;
  if (error instanceof z.ZodError)
    return error.issues.some((issue) => resourceIssueMessages.has(issue.message));
  return false;
}

const canonicalUtcMillisSchema = z
  .string()
  .length(24)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export const CompositionalRetrievalSnapshotBackendTimeV3Schema = canonicalUtcMillisSchema;
export type CompositionalRetrievalSnapshotBackendTimeV3 = z.infer<
  typeof CompositionalRetrievalSnapshotBackendTimeV3Schema
>;

const unscopedGraphBodySchema = z.custom<Omit<GraphData, 'group_id'>>(
  (value): value is Omit<GraphData, 'group_id'> =>
    value !== null && typeof value === 'object' && validGraphs.has(value),
);

export type CompositionalUnscopedGraphDataV3 = z.infer<typeof unscopedGraphBodySchema>;

type SafeParseResult<T> = { success: true; data: T } | { success: false; error: z.ZodError };

function fixedSchemaError(message: string): z.ZodError {
  return new z.ZodError([{ code: z.ZodIssueCode.custom, path: [], message }]);
}

function asSchemaError(error: unknown, fallback = 'invalid_snapshot'): z.ZodError {
  return error instanceof z.ZodError ? error : fixedSchemaError(fallback);
}

/** Own the raw value before entering Zod, whose type inspection reads `then`. */
function parseUnscopedGraph(value: unknown): CompositionalUnscopedGraphDataV3 {
  let graph: GraphData;
  try {
    graph = parseLosslessAutomaticCaptureGraph(value);
  } catch (error) {
    throw fixedSchemaError(
      resourceBoundedGraphFailure(error) ? 'resource_exhausted' : 'invalid_snapshot',
    );
  }

  if (graph.group_id !== undefined) throw fixedSchemaError('invalid_snapshot');

  const unscoped = Object.fromEntries(
    Object.entries(graph).filter(([key]) => key !== 'group_id'),
  ) as CompositionalUnscopedGraphDataV3;
  validGraphs.add(unscoped);
  return unscopedGraphBodySchema.parse(unscoped);
}

/** Safe Zod-backed entry point: snapshots raw own-data before Zod inspects `then`. */
export const CompositionalUnscopedGraphDataV3Schema = Object.freeze({
  parse: parseUnscopedGraph,
  safeParse(value: unknown): SafeParseResult<CompositionalUnscopedGraphDataV3> {
    try {
      return { success: true, data: parseUnscopedGraph(value) };
    } catch (error) {
      return { success: false, error: asSchemaError(error) };
    }
  },
});

export const CompositionalRetrievalSnapshotFailureReasonV3Schema = z.enum([
  'invalid_scope',
  'budget_exhausted',
  'resource_exhausted',
  'missing_store',
  'recovery_required',
  'invalid_snapshot',
  'concurrent_snapshot',
  'storage_error',
]);
export type CompositionalRetrievalSnapshotFailureReasonV3 = z.infer<
  typeof CompositionalRetrievalSnapshotFailureReasonV3Schema
>;

const deferredResultSchema = z
  .object({
    status: z.literal('deferred'),
    reason: z.enum(['budget_exhausted', 'resource_exhausted', 'concurrent_snapshot']),
  })
  .strict();
const unavailableResultSchema = z
  .object({
    status: z.literal('unavailable'),
    reason: z.enum(['missing_store', 'recovery_required', 'storage_error']),
  })
  .strict();
const invalidResultSchema = z
  .object({
    status: z.literal('invalid'),
    reason: z.enum(['invalid_scope', 'invalid_snapshot']),
  })
  .strict();
const failureResultSchema = z.discriminatedUnion('status', [
  deferredResultSchema,
  unavailableResultSchema,
  invalidResultSchema,
]);
const snapshotResultSchema = z
  .object({
    status: z.literal('snapshot'),
    graph: unscopedGraphBodySchema,
    backendNow: CompositionalRetrievalSnapshotBackendTimeV3Schema,
  })
  .strict();
const resultBodySchema = z.discriminatedUnion('status', [
  snapshotResultSchema,
  deferredResultSchema,
  unavailableResultSchema,
  invalidResultSchema,
]);

function ownResultBeforeZod(value: unknown): unknown {
  const status = ownData(value, 'status');
  if (status === 'snapshot') {
    const record = exactOwnDataRecord(value, ['status', 'graph', 'backendNow']);
    if (!record) return invalidSnapshot;

    let metadata: unknown;
    try {
      metadata = cloneBoundedAutomaticCaptureJson(
        { status: record.status, backendNow: record.backendNow },
        'beginRequest',
      );
    } catch {
      return invalidSnapshot;
    }
    const parsedTime = CompositionalRetrievalSnapshotBackendTimeV3Schema.safeParse(
      (metadata as Record<string, unknown>).backendNow,
    );
    if (!parsedTime.success) return invalidSnapshot;

    const parsedGraph = CompositionalUnscopedGraphDataV3Schema.safeParse(record.graph);
    if (!parsedGraph.success) {
      return parsedGraph.error.issues.some((issue) => issue.message === 'resource_exhausted')
        ? { status: 'deferred', reason: 'resource_exhausted' }
        : invalidSnapshot;
    }
    return { status: 'snapshot', graph: parsedGraph.data, backendNow: parsedTime.data };
  }

  if (status === 'deferred' || status === 'unavailable' || status === 'invalid') {
    const record = exactOwnDataRecord(value, ['status', 'reason']);
    if (!record) return invalidSnapshot;
    try {
      const owned = cloneBoundedAutomaticCaptureJson(record, 'beginRequest');
      const parsed = failureResultSchema.safeParse(owned);
      return parsed.success ? parsed.data : invalidSnapshot;
    } catch {
      return invalidSnapshot;
    }
  }
  return invalidSnapshot;
}

export type CompositionalRetrievalSnapshotResultV3 = z.infer<typeof resultBodySchema>;

function parseRetrievalSnapshot(value: unknown): CompositionalRetrievalSnapshotResultV3 {
  const owned = ownResultBeforeZod(value);
  return resultBodySchema.parse(owned);
}

/** Strict Zod-backed result entry point; raw wrappers are owned before any Zod call. */
export const CompositionalRetrievalSnapshotV3Schema = Object.freeze({
  parse: parseRetrievalSnapshot,
  safeParse(value: unknown): SafeParseResult<CompositionalRetrievalSnapshotResultV3> {
    try {
      return { success: true, data: parseRetrievalSnapshot(value) };
    } catch (error) {
      return { success: false, error: asSchemaError(error) };
    }
  },
});
