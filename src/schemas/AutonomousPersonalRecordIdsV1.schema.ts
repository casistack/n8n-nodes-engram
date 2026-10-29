import { z } from 'zod';

const namespaceSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0)
  .refine((value) => {
    for (const character of value) {
      const codePoint = character.codePointAt(0)!;
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    }
    return true;
  });

/** Owned scalar DATA only; namespace and subject authority must be checked by the caller. */
export const AutonomousPersonalRecordIdsV1InputOwnedDataSchema = z
  .object({
    namespace: namespaceSchema,
    subjectId: z.string().uuid(),
    key: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type AutonomousPersonalRecordIdsV1Input = z.infer<
  typeof AutonomousPersonalRecordIdsV1InputOwnedDataSchema
>;

export const AutonomousPersonalRecordIdsV1OwnedDataSchema = z
  .object({ claimId: z.string().uuid(), valueId: z.string().uuid() })
  .strict()
  .refine((value) => value.claimId !== value.valueId);

export type AutonomousPersonalRecordIdsV1 = z.infer<
  typeof AutonomousPersonalRecordIdsV1OwnedDataSchema
>;
