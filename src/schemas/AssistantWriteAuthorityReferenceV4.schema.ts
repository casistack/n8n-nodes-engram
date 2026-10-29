import { z } from 'zod';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();

/** Stored structural reference to a committed autonomous human-turn operation. */
export const AssistantWriteAuthorityReferenceV4Schema = z
  .object({
    kind: z.literal('owned_human_turn_v4'),
    parentFamily: z.literal('autonomous-personal-v1'),
    parentOperationId: uuid,
    sourceId: uuid,
    sourceHash: hash64,
    descriptorHash: hash64,
    requestedAuthorityHash: hash64,
  })
  .strict();

export type AssistantWriteAuthorityReferenceV4 = z.infer<
  typeof AssistantWriteAuthorityReferenceV4Schema
>;
