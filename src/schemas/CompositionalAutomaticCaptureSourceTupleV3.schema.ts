import { z } from 'zod';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import {
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  CompositionalAutomaticCaptureSourceOwnerV3Schema,
  CompositionalAutomaticOperationIdentityV3Schema,
} from './CompositionalAutomaticCaptureV3.schema';
import { CompositionalAutomaticDescriptorV3Schema } from './CompositionalAutomaticMemory.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);

const sourceTupleFields = {
  version: z.literal(3),
  sourceId: z.string().uuid(),
  source: EpisodicNodeSchema,
  owner: CompositionalAutomaticCaptureSourceOwnerV3Schema,
  envelope: CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  mappedContent: z.string().min(1).max(65536),
  sourceHash: hash64,
  originalProducerHash: hash64,
  stableProducerHash: hash64,
  eventTimeHash: hash64,
};

/** Structural source validation only; opaque descriptor hashes are not proved. */
export const CompositionalAutomaticSourceTupleV3Schema = z
  .object({
    ...sourceTupleFields,
    descriptorValidation: z.literal('opaque_only'),
  })
  .strict();
export type CompositionalAutomaticSourceTupleV3 = z.infer<
  typeof CompositionalAutomaticSourceTupleV3Schema
>;

/** Descriptor-present structural identity reconstruction; still grants no authority. */
export const CompositionalAutomaticSourceIdentityReconstructionV3Schema = z
  .object({
    ...sourceTupleFields,
    descriptorValidation: z.literal('compiled_descriptor'),
    descriptor: CompositionalAutomaticDescriptorV3Schema,
    descriptorHash: hash64,
    identity: CompositionalAutomaticOperationIdentityV3Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.descriptorHash !== value.owner.descriptorHash ||
      value.identity.sourceId !== value.sourceId ||
      value.identity.sourceHash !== value.sourceHash ||
      value.identity.originalProducerHash !== value.originalProducerHash ||
      value.identity.stableProducerHash !== value.stableProducerHash ||
      value.identity.eventTimeHash !== value.eventTimeHash
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reconstructed identity does not match the validated source tuple',
      });
    }
  });
export type CompositionalAutomaticSourceIdentityReconstructionV3 = z.infer<
  typeof CompositionalAutomaticSourceIdentityReconstructionV3Schema
>;
