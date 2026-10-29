import { z } from 'zod';

/** Internal token DATA; source ownership and geometry are checked by the caller. */
export const AutonomousSourceLexicalTokenV1OwnedDataSchema = z
  .object({
    kind: z.enum(['word', 'punctuation', 'quote']),
    start: z.number().int().min(0).max(65_536),
    end: z.number().int().min(1).max(65_536),
    codePoint: z.number().int().min(0).max(0x10ffff),
  })
  .strict()
  .refine((token) => token.start < token.end);

export type AutonomousSourceLexicalTokenV1 = z.infer<
  typeof AutonomousSourceLexicalTokenV1OwnedDataSchema
>;
