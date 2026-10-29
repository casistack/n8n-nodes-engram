import { z } from 'zod';

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/**
 * V3 namespaces preserve exact identity bytes, including leading/trailing
 * whitespace. They must still be nonblank, well-formed Unicode, and bounded.
 */
export const CompositionalCaptureNamespaceV3Schema = z
  .string()
  .min(1)
  .max(128)
  .superRefine((value, context) => {
    if (value.length > 128) return;
    if (value.trim().length === 0 || !isWellFormedUnicode(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'V3 namespace must be nonblank well-formed Unicode',
      });
    }
  });
export type CompositionalCaptureNamespaceV3 = z.infer<typeof CompositionalCaptureNamespaceV3Schema>;
