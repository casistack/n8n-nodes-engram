import { z } from 'zod';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import {
  CompositionalRetrievalSessionReasonV3Schema,
  CompositionalRetrievalDataV3Schema,
} from './CompositionalRetrievalSessionV3.schema';
import { CompositionalRetrievalSnapshotFailureReasonV3Schema } from './CompositionalRetrievalSnapshotV3.schema';
import {
  AutomaticClaimReadReasonSchema,
  AutomaticClaimReadResultSchema,
} from './AutomaticClaimRead.schema';
import { AutomaticBindingReferenceSchema } from './AutomaticMemory.schema';
import { AutomaticBindingRecordSchema } from './AutomaticOperations.schema';
import { EntityNodeSchema } from './EntityNode.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { GraphDataSchema } from './GraphData.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import { CompositionalAutomaticCaptureOperationV3Schema } from './CompositionalAutomaticCaptureV3.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

export const CompositionalRuntimeReadReasonV3Schema = z.union([
  CompositionalRetrievalSessionReasonV3Schema,
  CompositionalRetrievalSnapshotFailureReasonV3Schema,
  AutomaticClaimReadReasonSchema,
  z.enum([
    'missing_capability',
    'invalid_response',
    'invalid_reader',
    'locator_mismatch',
    'unsupported_parent',
  ]),
]);
export type CompositionalRuntimeReadReasonV3 = z.infer<
  typeof CompositionalRuntimeReadReasonV3Schema
>;
export const CompositionalRuntimeReadFailureV3Schema = z
  .object({ status: z.literal('deferred'), reason: CompositionalRuntimeReadReasonV3Schema })
  .strict();
export type CompositionalRuntimeReadFailureV3 = z.infer<
  typeof CompositionalRuntimeReadFailureV3Schema
>;
declare const runtimeReaderBrand: unique symbol;
/** Identity belongs to the loader's private registry; data/schema parsing never establishes it. */
export type CompositionalRuntimeReaderV3 = Readonly<{
  [runtimeReaderBrand]: 'actual_runtime_read';
}>;
const loadResult = z.union([
  z
    .object({ status: z.literal('ready'), reader: z.custom<CompositionalRuntimeReaderV3>() })
    .strict(),
  CompositionalRuntimeReadFailureV3Schema,
]);
export type CompositionalRuntimeLoadResultV3 = z.infer<typeof loadResult>;
export const CompositionalRuntimeFactsResultV3Schema = z.union([
  CompositionalRetrievalDataV3Schema,
  CompositionalRuntimeReadFailureV3Schema,
]);
export type CompositionalRuntimeFactsResultV3 = z.infer<
  typeof CompositionalRuntimeFactsResultV3Schema
>;

export const CompositionalRuntimeParentLocatorV3Schema = z
  .object({
    capturedSourceId: z.string().uuid(),
    namespace: CompositionalCaptureNamespaceV3Schema,
    issuer: z.string().min(1).max(256),
    actorReference: z.string().min(1).max(512),
    turn: z.string().min(1).max(512),
  })
  .strict();
export type CompositionalRuntimeParentLocatorV3 = z.infer<
  typeof CompositionalRuntimeParentLocatorV3Schema
>;
const parentBody = z
  .object({
    status: z.literal('parent_data'),
    namespace: CompositionalCaptureNamespaceV3Schema,
    backendNow: z.string().datetime(),
    source: EpisodicNodeSchema.strict(),
    operation: CompositionalAutomaticCaptureOperationV3Schema,
    subject: EntityNodeSchema.strict(),
    capturedBinding: AutomaticBindingReferenceSchema,
    currentBinding: AutomaticBindingRecordSchema.nullable(),
  })
  .strict();
/** Immutable observations only; the fixed parent validator must obtain these through a live reader. */
export const CompositionalRuntimeParentDataV3Schema = z
  .unknown()
  .transform((value, context): z.infer<typeof parentBody> => {
    let owned: unknown;
    try {
      owned = cloneBoundedAutomaticCaptureJson(value, 'beginRequest');
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded parent data' });
      return z.NEVER;
    }
    const parsed = parentBody.safeParse(owned);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    return parsed.data;
  });
export type CompositionalRuntimeParentDataV3 = z.infer<
  typeof CompositionalRuntimeParentDataV3Schema
>;
export const CompositionalRuntimeParentResultV3Schema = z.union([
  CompositionalRuntimeParentDataV3Schema,
  CompositionalRuntimeReadFailureV3Schema,
]);
export type CompositionalRuntimeParentResultV3 = z.infer<
  typeof CompositionalRuntimeParentResultV3Schema
>;
export const CompositionalRuntimeLiteralResultV3Schema = z.union([
  AutomaticClaimReadResultSchema,
  CompositionalRuntimeReadFailureV3Schema,
]);
export type CompositionalRuntimeLiteralResultV3 = z.infer<
  typeof CompositionalRuntimeLiteralResultV3Schema
>;
const candidateData = z
  .object({
    status: z.literal('candidate_data'),
    edge: EntityEdgeSchema,
    subject: EntityNodeSchema,
    value: EntityNodeSchema,
  })
  .strict();
export type CompositionalRuntimeCandidateDataV3 = z.infer<typeof candidateData>;
export type CompositionalRuntimeCandidateResultV3 =
  | CompositionalRuntimeCandidateDataV3
  | CompositionalRuntimeReadFailureV3;
const literalData = candidateData
  .extend({
    status: z.literal('literal_data'),
    source: EpisodicNodeSchema,
    proof: AutomaticClaimReadResultSchema,
    related: z.array(EntityEdgeSchema).max(129).readonly(),
  })
  .strict();
export type CompositionalRuntimeLiteralDataV3 = z.infer<typeof literalData>;
export type CompositionalRuntimeLiteralDataResultV3 =
  | CompositionalRuntimeLiteralDataV3
  | CompositionalRuntimeReadFailureV3;
export const CompositionalRuntimeHistoryLocatorV3Schema = z
  .object({
    namespace: CompositionalCaptureNamespaceV3Schema,
    limit: z.number().int().min(1).max(10002),
  })
  .strict();
const historyData = z
  .object({
    status: z.literal('history_data'),
    episodes: z.array(EpisodicNodeSchema).max(10002).readonly(),
  })
  .strict();
export type CompositionalRuntimeHistoryDataV3 = z.infer<typeof historyData>;
export const CompositionalRuntimeHistoryResultV3Schema = z.union([
  historyData,
  CompositionalRuntimeReadFailureV3Schema,
]);
export type CompositionalRuntimeHistoryResultV3 = z.infer<
  typeof CompositionalRuntimeHistoryResultV3Schema
>;
/** Namespace candidate observations only. Parsing this data establishes no reader identity or authority. */
export const CompositionalRuntimeNamespaceDataV3Schema = z
  .object({
    status: z.literal('namespace_data'),
    graph: GraphDataSchema.readonly(),
  })
  .strict();
export const CompositionalRuntimeNamespaceResultV3Schema = z.union([
  CompositionalRuntimeNamespaceDataV3Schema,
  CompositionalRuntimeReadFailureV3Schema,
]);
export type CompositionalRuntimeNamespaceDataV3 = z.infer<
  typeof CompositionalRuntimeNamespaceDataV3Schema
>;
export type CompositionalRuntimeNamespaceResultV3 = z.infer<
  typeof CompositionalRuntimeNamespaceResultV3Schema
>;
