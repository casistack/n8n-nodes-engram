import { z } from 'zod';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
/** A record selector only; no source, subject, lease or storage authority. */
export const CompositionalOperationSnapshotIndexRequestV3Schema = z
  .object({ namespace: CompositionalCaptureNamespaceV3Schema, operationId: z.string().uuid() })
  .strict();
export type CompositionalOperationSnapshotIndexRequestV3 = z.infer<
  typeof CompositionalOperationSnapshotIndexRequestV3Schema
>;
export const CompositionalSnapshotIndexFailureReasonV3Schema = z.enum([
  'invalid_snapshot',
  'invalid_scope',
  'budget_exhausted',
  'missing_operation',
  'ambiguous_operation',
  'unsupported_mode',
]);
export type CompositionalSnapshotIndexFailureReasonV3 = z.infer<
  typeof CompositionalSnapshotIndexFailureReasonV3Schema
>;
