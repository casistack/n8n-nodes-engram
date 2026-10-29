import { z } from 'zod';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from './CompositionalAutomaticCaptureV3.schema';
import { CompositionalCaptureNonPermitDecisionV3Schema } from './CompositionalAutomaticCaptureLifecycleV3.schema';
import type { CompositionalCaptureBeginInvocationV3 } from './CompositionalAutomaticCaptureRegistryV3.schema';

/** Private adapter plumbing type only; parsing this data authenticates no scope. */
const invocation: z.ZodType<CompositionalCaptureBeginInvocationV3> =
  z.custom<CompositionalCaptureBeginInvocationV3>();
const ready: z.ZodObject<
  {
    kind: z.ZodLiteral<'ready'>;
    request: typeof CompositionalAutomaticCaptureBeginRequestV3Schema;
    begin: z.ZodType<CompositionalCaptureBeginInvocationV3>;
    check: z.ZodType<() => void>;
  },
  'strict'
> = z
  .object({
    kind: z.literal('ready'),
    request: CompositionalAutomaticCaptureBeginRequestV3Schema,
    begin: invocation,
    check: z.custom<() => void>(),
  })
  .strict();
const decision = z
  .object({ kind: z.literal('decision'), decision: CompositionalCaptureNonPermitDecisionV3Schema })
  .strict();
export const CompositionalCaptureBackendBeginSetupV3Schema: z.ZodUnion<
  [typeof ready, typeof decision]
> = z.union([ready, decision]);
export type CompositionalCaptureBackendBeginSetupV3 = z.infer<
  typeof CompositionalCaptureBackendBeginSetupV3Schema
>;
