import { ZodError } from 'zod';
import { BoundedAutomaticCaptureJsonError } from './BoundedAutomaticCaptureJson';

/** Classify fixed local validation failures without returning storage/provider text. */
export function autonomousPersonalCaptureStorageFailureV4(
  error: unknown,
): 'conflict' | 'resource_exhausted' | null {
  if (error instanceof BoundedAutomaticCaptureJsonError)
    return error.reason === 'invalid_json' ? 'conflict' : 'resource_exhausted';
  if (error instanceof ZodError || error instanceof SyntaxError) return 'conflict';
  if (!(error instanceof Error)) return null;
  switch (error.message) {
    case 'Engram queue: snapshot_limit':
    case 'Engram automatic capture: native_attributes_too_large':
      return 'resource_exhausted';
    case 'Engram automatic capture: record_normalization':
    case 'Engram automatic ledger: invalid_native_record':
    case 'Engram automatic ledger: invalid_native_format':
    case 'Engram automatic ledger: unregistered_native_format':
    case 'Engram automatic ledger: native_root_missing':
    case 'Engram automatic memory: invalid_source_owner':
    case 'Engram automatic memory: invalid_source_reference':
    case 'Engram automatic memory: duplicate_global_id':
    case 'Engram automatic memory: duplicate_binding':
    case 'Engram automatic memory: invalid_binding':
      return 'conflict';
    default:
      return null;
  }
}
