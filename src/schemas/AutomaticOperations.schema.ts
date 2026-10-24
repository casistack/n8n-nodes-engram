import { z } from 'zod';

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0);
const namespace = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const revision = z.number().int().min(1).max(2147483647);
const authorization = {
  authorizedBy: identity,
  reason: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value.trim().length > 0),
};

export const AutomaticBindingAuditSchema = z
  .object({
    action: z.enum(['create', 'reassign', 'revoke']),
    ...authorization,
    at: z.string().datetime(),
    previousSubjectId: z.string().uuid().optional(),
  })
  .strict();
export type AutomaticBindingAudit = z.infer<typeof AutomaticBindingAuditSchema>;

export const AutomaticBindingRecordSchema = z
  .object({
    version: z.literal(1),
    bindingId: z.string().uuid(),
    namespace,
    issuer: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0),
    actorReference: identity,
    subjectId: z.string().uuid(),
    revision,
    state: z.enum(['active', 'revoked']),
    audit: z.array(AutomaticBindingAuditSchema).min(1).max(20),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AutomaticBindingRecord = z.infer<typeof AutomaticBindingRecordSchema>;
export const AutomaticSubjectBindingsSchema = z.array(AutomaticBindingRecordSchema).max(32);

export const AutomaticBindingCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      namespace,
      issuer: z
        .string()
        .min(1)
        .max(256)
        .refine((value) => value.trim().length > 0),
      actorReference: identity,
      subjectId: z.string().uuid(),
      ...authorization,
    })
    .strict(),
  z
    .object({
      action: z.literal('revoke'),
      namespace,
      bindingId: z.string().uuid(),
      expectedRevision: revision,
      ...authorization,
    })
    .strict(),
  z
    .object({
      action: z.literal('reassign'),
      namespace,
      bindingId: z.string().uuid(),
      expectedRevision: revision,
      subjectId: z.string().uuid(),
      ...authorization,
    })
    .strict(),
]);
export type AutomaticBindingCommand = z.input<typeof AutomaticBindingCommandSchema>;
