import { z } from 'zod';
import { EntityNodeSchema } from './EntityNode.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import {
  CompositionalAutomaticOperationIdentityV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
} from './CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticDescriptorV3Schema,
  hashCompositionalAutomaticDescriptorV3,
} from './CompositionalAutomaticMemory.schema';
import { canonicalAutomaticCaptureV2 } from './AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

// Public representations of checked data only: no successful parse authenticates
// an actual storage snapshot, creates a row, or grants a processing/write permit.
function boundedLossless<S extends z.ZodTypeAny>(body: S, maxBytes: number) {
  return z.unknown().transform((value, ctx): z.infer<S> => {
    let cloned: unknown;
    try {
      cloned = cloneBoundedAutomaticCaptureJson(value, 'beginRequest');
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded read data' });
      return z.NEVER;
    }
    if (Buffer.byteLength(JSON.stringify(cloned), 'utf8') > maxBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Read data capacity exceeded' });
      return z.NEVER;
    }
    const parsed = body.safeParse(cloned);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue);
      return z.NEVER;
    }
    if (canonicalAutomaticCaptureV2(cloned) !== canonicalAutomaticCaptureV2(parsed.data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Read record normalization forbidden' });
      return z.NEVER;
    }
    return parsed.data;
  });
}
const proofBody = z
  .object({
    version: z.literal(1),
    kind: z.literal('committed_compositional_human_creation'),
    operationId: z.string().uuid(),
    identity: CompositionalAutomaticOperationIdentityV3Schema,
    descriptor: CompositionalAutomaticDescriptorV3Schema,
    terminalReceipt: CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  })
  .strict()
  .superRefine((p, ctx) => {
    const r = p.terminalReceipt;
    if (
      r.kind !== 'human_compositional_capture_committed' ||
      p.operationId !== r.operationId ||
      p.identity.sourceId !== r.sourceId ||
      p.identity.sourceHash !== r.sourceHash ||
      hashCompositionalAutomaticDescriptorV3(p.descriptor) !== r.descriptorHash ||
      p.identity.descriptorHash !== r.descriptorHash ||
      p.identity.policyFingerprint !== r.policyFingerprint ||
      p.descriptor.policy.fingerprint !== r.policyFingerprint ||
      p.identity.settingsHash !== p.descriptor.settingsHash
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Creation proof identity links disagree',
      });
    }
  });
export const CompositionalQualifiedClaimCommitProofV3Schema = boundedLossless(proofBody, 24 * 1024);
export type CompositionalQualifiedClaimCommitProofV3 = z.infer<
  typeof CompositionalQualifiedClaimCommitProofV3Schema
>;
const contextBody = z
  .object({
    version: z.literal(1),
    namespace: CompositionalCaptureNamespaceV3Schema,
    edge: EntityEdgeSchema.strict(),
    subject: EntityNodeSchema.strict(),
    value: EntityNodeSchema.strict(),
    source: EpisodicNodeSchema.strict(),
    proof: CompositionalQualifiedClaimCommitProofV3Schema,
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      [
        c.subject.group_id,
        c.value.group_id,
        c.source.group_id,
        c.edge.group_id,
        c.proof.identity.namespace,
      ].some((n) => n !== c.namespace) ||
      c.edge.source_node_uuid !== c.subject.uuid ||
      c.edge.target_node_uuid !== c.value.uuid ||
      c.edge.episodes.length !== 1 ||
      c.edge.episodes[0] !== c.source.uuid ||
      c.proof.identity.sourceId !== c.source.uuid ||
      c.proof.identity.binding.subjectId !== c.subject.uuid
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Read context endpoint/namespace/source links disagree',
      });
  });
export const CompositionalQualifiedClaimReadContextV3Schema = boundedLossless(
  contextBody,
  512 * 1024,
);
export type CompositionalQualifiedClaimReadContextV3 = z.infer<
  typeof CompositionalQualifiedClaimReadContextV3Schema
>;
export const CompositionalQualifiedClaimReadRequestV3Schema = z
  .object({
    namespace: CompositionalCaptureNamespaceV3Schema,
    edgeId: z.string().uuid(),
    now: z.string().datetime(),
  })
  .strict();
export type CompositionalQualifiedClaimReadRequestV3 = z.infer<
  typeof CompositionalQualifiedClaimReadRequestV3Schema
>;
export const CompositionalQualifiedClaimReadReasonV3Schema = z.enum([
  'invalid_context',
  'context_too_large',
  'proof_too_large',
  'missing_edge',
  'missing_source',
  'missing_subject',
  'missing_value',
  'missing_operation',
  'capture_not_committed',
  'ambiguous_operation',
  'invalid_operation',
  'invalid_claim',
  'authority_inactive',
  'invalid_review_pair',
]);
export const CompositionalQualifiedClaimReadResultV3Schema = z.union([
  z
    .object({
      status: z.literal('valid_data'),
      context: CompositionalQualifiedClaimReadContextV3Schema,
      creationReview: z.enum(['accepted', 'proposed']),
      currentReview: z.enum(['accepted', 'proposed', 'rejected']),
    })
    .strict(),
  z
    .object({
      status: z.enum(['invalid', 'uncommitted']),
      reason: CompositionalQualifiedClaimReadReasonV3Schema,
    })
    .strict(),
]);
export type CompositionalQualifiedClaimReadResultV3 = z.infer<
  typeof CompositionalQualifiedClaimReadResultV3Schema
>;
