import { GraphDataSchema, type GraphData } from '../schemas/GraphData.schema';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';

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
    if (
      canonicalAutomaticCaptureV2(beforeRoot[key]) !== canonicalAutomaticCaptureV2(afterRoot[key])
    )
      throw new Error('Engram automatic capture: record_normalization');
  }
  for (const key of ['entities', 'edges', 'episodes'] as const) {
    if (bounded[key].length !== parsed[key].length)
      throw new Error('Engram automatic capture: record_normalization');
    for (let index = 0; index < bounded[key].length; index++) {
      if (
        canonicalAutomaticCaptureV2(bounded[key][index]) !==
        canonicalAutomaticCaptureV2(parsed[key][index])
      )
        throw new Error('Engram automatic capture: record_normalization');
    }
  }
  const beforeOperations = bounded.automatic_operations_v1?.operations ?? [];
  const afterOperations = parsed.automatic_operations_v1?.operations ?? [];
  if (beforeOperations.length !== afterOperations.length)
    throw new Error('Engram automatic capture: record_normalization');
  for (let index = 0; index < beforeOperations.length; index++) {
    if (
      canonicalAutomaticCaptureV2(beforeOperations[index]) !==
      canonicalAutomaticCaptureV2(afterOperations[index])
    )
      throw new Error('Engram automatic capture: record_normalization');
  }
  return parsed;
}
