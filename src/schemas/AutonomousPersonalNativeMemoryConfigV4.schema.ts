import { z } from 'zod';
import { AutomaticRuntimeSchema } from './AutomaticRuntime.schema';
import { AutonomousPersonalDescriptorV4InputOwnedDataSchema } from './AutonomousPersonalDescriptorV4.schema';
import { AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema } from './AutonomousPersonalExecutionBudgetV1.schema';
import { CurrentHumanQuerySchema } from './MemoryPolicy.schema';
import { AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema } from './AutonomousPersonalMemoryHandoffV4.schema';
import { AutonomousPersonalMemoryHandoffNativeTupleV4OwnedDataSchema } from './AutonomousPersonalMemoryHandoffV4.schema';

const MAX_SOURCE_BYTES = 65_536;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const sourceOffset = z.number().int().safe().min(0).max(MAX_SOURCE_BYTES);
const humanRegionSchema = z
  .object({ start: sourceOffset, end: sourceOffset })
  .strict()
  .refine((region) => region.start < region.end);

const sourceMappingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('full_body') }).strict(),
  z
    .object({
      mode: z.literal('application_region'),
      humanRegion: humanRegionSchema,
    })
    .strict(),
]);

const boundedCurrentHumanQuerySchema = CurrentHumanQuerySchema.min(1)
  .max(MAX_SOURCE_BYTES)
  .refine(isWellFormedUnicode)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_BYTES);

const boundedRawHumanContentSchema = AutomaticRuntimeSchema.shape.rawHumanContent;

/** Strict native DATA captured from the actual Memory node context. */
export const AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema = z
  .object({
    version: z.literal(4),
    native: AutonomousPersonalMemoryHandoffNativeTupleV4OwnedDataSchema,
    ...AutonomousPersonalMemoryHandoffLocatorV4OwnedDataSchema.shape,
    profileId: AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.profileId,
    explicitIntent: z.boolean(),
    currentHumanQuery: boundedCurrentHumanQuerySchema,
    rawHumanContent: boundedRawHumanContentSchema,
    sourceMapping: sourceMappingSchema,
    quoteRegions: z.array(humanRegionSchema).max(32),
    invocationDeadlineMs:
      AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.invocationDeadlineMs,
    providerReference: AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.providerReference,
    // Absence means legacy; the key is only present for a configured body.
    executionBudget: AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema.optional(),
    // Absent unless explicitly opted in; never defaulted.
    statementContext: AutonomousPersonalDescriptorV4InputOwnedDataSchema.shape.statementContext,
  })
  .strict();

export type AutonomousPersonalNativeMemoryConfigV4 = z.infer<
  typeof AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema
>;
