import { z } from 'zod';
import { AutonomousPersonalNativeOriginV4OwnedDataSchema } from './AutonomousPersonalNativeOriginV4.schema';
import { AutonomousPersonalOperationIdentityV4OwnedDataSchema } from './AutonomousPersonalSourceV4.schema';
import { AutonomousPersonalCaptureReceiptSummaryV4Schema } from './AutonomousPersonalCaptureReceiptSummaryV4.schema';

const identityObjectSchema = AutonomousPersonalOperationIdentityV4OwnedDataSchema.innerType();

export const AutonomousPersonalMemoryHandoffNativeTupleV4OwnedDataSchema = z
  .object({
    instance: AutonomousPersonalNativeOriginV4OwnedDataSchema.shape.instance,
    workflow: AutonomousPersonalNativeOriginV4OwnedDataSchema.shape.workflow,
    execution: AutonomousPersonalNativeOriginV4OwnedDataSchema.shape.execution,
  })
  .strict();

/** Exact current-store and source locator required to consume a private D handoff. */
export const AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema = identityObjectSchema
  .pick({
    storeHash: true,
    namespace: true,
    issuer: true,
    actorReference: true,
    turn: true,
    sourceId: true,
  })
  .strict();

export const AutonomousPersonalMemoryHandoffPublishResultV4OwnedDataSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({ kind: z.literal('published'), sourceId: identityObjectSchema.shape.sourceId })
      .strict(),
    z.object({ kind: z.literal('not_published') }).strict(),
  ],
);

const publishedWithSummary = z
  .object({
    kind: z.literal('published'),
    sourceId: identityObjectSchema.shape.sourceId,
    summary: AutonomousPersonalCaptureReceiptSummaryV4Schema,
  })
  .strict();

export const AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema = z
  .discriminatedUnion('kind', [
    publishedWithSummary,
    z.object({ kind: z.literal('not_published') }).strict(),
  ])
  .superRefine((result, context) => {
    if (
      result.kind === 'published' &&
      (result.summary.kind !== 'committed' || result.summary.sourceId !== result.sourceId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'Published receipt summary must be committed for the published source',
      });
    }
  });

export type AutonomousPersonalMemoryHandoffLocatorV4 = z.infer<
  typeof AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema
>;

export type AutonomousPersonalMemoryHandoffNativeTupleV4 = z.infer<
  typeof AutonomousPersonalMemoryHandoffNativeTupleV4OwnedDataSchema
>;

export type AutonomousPersonalMemoryHandoffPublishResultV4 = z.infer<
  typeof AutonomousPersonalMemoryHandoffPublishResultV4OwnedDataSchema
>;

export type AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4 = z.infer<
  typeof AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema
>;
