import { z } from 'zod';

export const NativeCaptureAttributeKeysSchema = z.enum([
  'protected',
  'legacy_owned',
  'unowned',
  'uncertain',
]);
export type NativeCaptureAttributeKeys = z.infer<typeof NativeCaptureAttributeKeysSchema>;
