import { z } from 'zod';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const HASH_64 = /^[a-f0-9]{64}$/u;
const DATA_MAX_BYTES = 16 * 1024;

const providerCategorySchema = z.enum([
  'preference',
  'work_role',
  'work_affiliation',
  'project',
  'skill',
  'interest',
  'broad_location',
  'self_description',
  'personal_assertion',
  'unknown',
]);
export type AutonomousPersonalProviderCategoryV1 = z.infer<typeof providerCategorySchema>;

const providerRiskSchema = z.enum(['ordinary', 'sensitive', 'unknown']);
export type AutonomousPersonalProviderRiskV1 = z.infer<typeof providerRiskSchema>;

const providerUsefulnessSchema = z.enum(['personal_memory', 'not_memory', 'unknown']);
export type AutonomousPersonalProviderUsefulnessV1 = z.infer<typeof providerUsefulnessSchema>;

const providerDowngradeSchema = z.enum([
  'sensitive',
  'uncertain',
  'conditional',
  'reported',
  'quoted',
  'third_party',
  'transient',
  'ambiguous_scope',
]);
export type AutonomousPersonalProviderDowngradeV1 = z.infer<typeof providerDowngradeSchema>;

const unitIdSchema = z.string().regex(HASH_64);
const unitSchema = z
  .object({
    unitId: unitIdSchema,
    category: providerCategorySchema,
    risk: providerRiskSchema,
    usefulness: providerUsefulnessSchema,
    downgrade: z
      .array(providerDowngradeSchema)
      .max(8)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

export type AutonomousPersonalProviderUnitV1 = z.infer<typeof unitSchema>;

const responseBodySchema = z
  .object({
    version: z.literal(1),
    units: z.array(unitSchema).max(32),
  })
  .strict()
  .superRefine((response, context) => {
    const unitIds = response.units.map((unit) => unit.unitId);
    if (new Set(unitIds).size !== unitIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider unit IDs must be unique',
        path: ['units'],
      });
    }
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > DATA_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider classification data exceeds 16 KiB',
      });
    }
  });

/**
 * Strict Zod schema for classification data that has already crossed a bounded
 * ownership boundary. The values are untrusted interpretation data only.
 */
export const AutonomousPersonalProviderResponseV1OwnedDataSchema = responseBodySchema;

export type AutonomousPersonalProviderResponseV1 = z.infer<
  typeof AutonomousPersonalProviderResponseV1OwnedDataSchema
>;

const registeredUnitIdsSchema = z
  .array(unitIdSchema)
  .max(32)
  .refine((unitIds) => new Set(unitIds).size === unitIds.length);

const validationInputSchema = z
  .object({
    response: AutonomousPersonalProviderResponseV1OwnedDataSchema,
    unitIds: registeredUnitIdsSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const registered = new Set(input.unitIds);
    const returned = new Set(input.response.units.map((unit) => unit.unitId));
    if (
      registered.size !== returned.size ||
      [...registered].some((unitId) => !returned.has(unitId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider unit IDs must match the registered set',
      });
    }
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > DATA_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider validation data exceeds 16 KiB',
      });
    }
  });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function invalidAutonomousProviderData(): z.ZodError {
  return new z.ZodError([
    { code: z.ZodIssueCode.custom, path: [], message: 'invalid_autonomous_provider_data' },
  ]);
}

function ownResponse(value: unknown): AutonomousPersonalProviderResponseV1 {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'policyData');
  return deepFreeze(AutonomousPersonalProviderResponseV1OwnedDataSchema.parse(owned));
}

/** Bounded facade for the strict response DATA shape; it does not grant acceptance. */
export const AutonomousPersonalProviderResponseV1Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalProviderResponseV1 {
    try {
      return ownResponse(value);
    } catch {
      throw invalidAutonomousProviderData();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalProviderResponseV1> {
    try {
      return { success: true, data: ownResponse(value) };
    } catch {
      return { success: false, error: invalidAutonomousProviderData() };
    }
  },
});

/**
 * Validate a provider DATA response against the supplied unit ID set.
 * The complete wrapper fits the existing policyData ownership profile, then
 * receives an explicit aggregate 16 KiB serialized-size check before Zod.
 * Returned units follow supplied-ID order. The scanner must defer rather
 * than truncate a source requiring more than 32 classifications.
 */
export function validateAutonomousPersonalProviderResponseV1(
  input: unknown,
): AutonomousPersonalProviderResponseV1 {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'policyData');
    if (Buffer.byteLength(JSON.stringify(owned), 'utf8') > DATA_MAX_BYTES) {
      throw invalidAutonomousProviderData();
    }
    const checked = validationInputSchema.parse(owned);
    const responseById = new Map(
      checked.response.units.map((unit) => [unit.unitId, unit] as const),
    );
    const response: AutonomousPersonalProviderResponseV1 = {
      version: 1,
      units: checked.unitIds.map((unitId) => {
        const unit = responseById.get(unitId);
        if (!unit) throw invalidAutonomousProviderData();
        return {
          unitId: unit.unitId,
          category: unit.category,
          risk: unit.risk,
          usefulness: unit.usefulness,
          downgrade: [...unit.downgrade],
        };
      }),
    };
    return deepFreeze(AutonomousPersonalProviderResponseV1OwnedDataSchema.parse(response));
  } catch {
    throw invalidAutonomousProviderData();
  }
}
