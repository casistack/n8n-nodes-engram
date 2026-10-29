import { z } from 'zod';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EntityNodeSchema } from './EntityNode.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from './AutomaticCaptureReceipt.schema';
import {
  AutomaticOperationDescriptorV2Schema,
  AutomaticOperationIdentityV2Schema,
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from './AutomaticCapture.schema';

const AutomaticHumanCommitReceiptSchema = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'human_capture_committed',
);

function withinSerializedLimit(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

/** A bounded projection of actual committed V2 operation evidence, not a caller assertion. */
export const AutomaticClaimCommitProofSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('committed_human_capture'),
    operationId: z.string().uuid(),
    identity: AutomaticOperationIdentityV2Schema,
    descriptor: AutomaticOperationDescriptorV2Schema,
    terminalReceipt: AutomaticHumanCommitReceiptSchema,
  })
  .strict()
  .superRefine((proof, context) => {
    if (proof.terminalReceipt.kind !== 'human_capture_committed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Proof needs a human terminal receipt',
      });
      return;
    }
    const receipt = proof.terminalReceipt;
    if (proof.identity.purpose !== 'human_turn_memory' || proof.identity.role !== 'human') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Proof identity is not human capture',
      });
      return;
    }
    if (
      proof.descriptor.purpose !== 'human_turn_memory' ||
      proof.identity.sourceId !== receipt.sourceId ||
      proof.operationId !== receipt.operationId ||
      proof.identity.sourceHash !== receipt.sourceHash ||
      hashAutomaticCaptureV2(proof.descriptor) !== receipt.descriptorHash ||
      canonicalAutomaticCaptureV2(proof.descriptor.policy) !==
        canonicalAutomaticCaptureV2(receipt.receipt.policy)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid committed human proof links',
      });
    }
    if (!withinSerializedLimit(proof, 24 * 1024)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Commit proof exceeds 24 KiB' });
    }
  });
export type AutomaticClaimCommitProof = z.infer<typeof AutomaticClaimCommitProofSchema>;

export const AutomaticClaimReadContextSchema = z
  .object({
    edge: EntityEdgeSchema,
    source: EpisodicNodeSchema,
    subject: EntityNodeSchema,
    value: EntityNodeSchema,
    proof: AutomaticClaimCommitProofSchema,
  })
  .strict()
  .superRefine((context, validation) => {
    if (
      context.edge.source_node_uuid !== context.subject.uuid ||
      context.edge.target_node_uuid !== context.value.uuid ||
      context.edge.group_id !== context.subject.group_id ||
      context.edge.group_id !== context.value.group_id ||
      context.edge.group_id !== context.source.group_id ||
      !context.edge.episodes.includes(context.source.uuid) ||
      context.proof.identity.sourceId !== context.source.uuid ||
      context.proof.identity.namespace !== context.edge.group_id ||
      context.proof.identity.purpose !== 'human_turn_memory' ||
      context.proof.identity.binding.subjectId !== context.subject.uuid
    ) {
      validation.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Claim read context records do not describe the same committed source and edge',
      });
    }
  })
  .refine((context) => withinSerializedLimit(context, 512 * 1024), {
    message: 'Automatic claim read context exceeds 512 KiB',
  });
export type AutomaticClaimReadContext = z.infer<typeof AutomaticClaimReadContextSchema>;

export const AutomaticClaimReadStatusSchema = z.enum([
  'unavailable',
  'uncommitted',
  'ambiguous',
  'invalid',
  'deferred',
]);
export const AutomaticClaimReadReasonSchema = z.enum([
  'budget_exhausted',
  'snapshot_changed',
  'missing_store',
  'recovery_required',
  'invalid_context',
  'context_too_large',
  'proof_too_large',
  'missing_edge',
  'missing_source',
  'missing_subject',
  'missing_value',
  'not_capture_source',
  'missing_operation',
  'capture_not_committed',
  'ambiguous_operation',
  'invalid_operation',
  'invalid_claim',
]);

export const AutomaticClaimReadResultSchema = z.union([
  z.object({ status: z.literal('committed'), context: AutomaticClaimReadContextSchema }).strict(),
  z
    .object({
      status: AutomaticClaimReadStatusSchema,
      reason: AutomaticClaimReadReasonSchema,
    })
    .strict(),
]);
export type AutomaticClaimReadResult = z.infer<typeof AutomaticClaimReadResultSchema>;
