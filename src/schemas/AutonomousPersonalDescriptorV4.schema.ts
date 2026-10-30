import { z } from 'zod';
import {
  AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS,
  AutonomousPersonalPolicyV3OwnedDataSchema,
  compileAutonomousPersonalPolicyV3,
  type AutonomousPersonalPolicyV3,
} from './AutonomousPersonalPolicyV3.schema';
import { hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  CompositionalPreferenceV2DescriptorSchema,
} from './CompositionalPreferenceV2.schema';
import { ExtractionTemperatureSchema } from './ExtractionOutcome.schema';
import { AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema } from './AutonomousPersonalExecutionBudgetV1.schema';
import { resolveAutonomousPersonalExecutionBudgetV1 } from '../storage/AutonomousPersonalExecutionBudgetV1';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const HASH_64 = /^[a-f0-9]{64}$/u;
const POLICY_LIMITS = AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS;
const DESCRIPTOR_MAX_BYTES = POLICY_LIMITS.descriptorBytes;

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

const hashSchema = z.string().regex(HASH_64);
const profileIdSchema = z.enum(['conservative', 'explicit', 'reviewFirst']);
const routeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0 && isWellFormedUnicode(value));

// The existing branches intentionally remain untouched. The V4 descriptor
// closes each branch so nested unknown keys cannot disappear during parsing.
const StrictExtractionTemperatureSchema = z.discriminatedUnion('mode', [
  ExtractionTemperatureSchema.options[0].strict(),
  ExtractionTemperatureSchema.options[1].strict(),
  ExtractionTemperatureSchema.options[2].strict(),
]);

const OutputTokenLimitSchema = z.object({ mode: z.literal('omit') }).strict();

const ProviderReferenceSchema = z
  .object({
    routeId: routeIdSchema,
    configurationFingerprint: hashSchema,
    protocol: z.literal('openai-compatible-json-v1'),
    configuredRequestLimit: z.number().int().min(1).max(256),
    configuredTimeoutMs: z.number().int().positive().safe(),
    configuredRequestBytes: z.number().int().positive().safe(),
    configuredResponseBytes: z.number().int().positive().safe(),
    temperature: StrictExtractionTemperatureSchema,
    responseFormat: z.literal('json_object'),
    outputTokenLimit: OutputTokenLimitSchema,
  })
  .strict();

const DescriptorInputSchema = z
  .object({
    profileId: profileIdSchema,
    requestedTrustLevel: z.enum(['standard', 'trusted']),
    intentSetting: z.boolean(),
    invocationDeadlineMs: z.number().int().min(100).max(120_000),
    providerReference: ProviderReferenceSchema,
    // Absence means legacy; the public bounded entry rejects explicit undefined.
    executionBudget: AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema.optional(),
  })
  .strict();
/** Strict Zod shape for descriptor request DATA after the caller has owned its outer input. */
export const AutonomousPersonalDescriptorV4InputOwnedDataSchema = DescriptorInputSchema;
export type AutonomousPersonalDescriptorV4Input = z.infer<typeof DescriptorInputSchema>;

const providerOutputSchema = ProviderReferenceSchema.extend({
  structuredContractVersion: z.literal(1),
  promptVersion: z.literal(1),
  effectiveRequestLimit: z.number().int().min(1).max(POLICY_LIMITS.providerMaxAttempts),
  effectiveTimeoutMs: z.number().int().min(1).max(120_000),
  effectiveRequestBytes: z.number().int().min(1).max(POLICY_LIMITS.providerRequestBytes),
  effectiveResponseBytes: z.number().int().min(1).max(POLICY_LIMITS.providerResponseBytes),
}).strict();

const descriptorBodySchema = z
  .object({
    version: z.literal(4),
    lifecycle: z.literal('replaySafeV2'),
    executionMode: z.literal('synchronous'),
    purpose: z.literal('human_turn_memory'),
    interpreterId: z.literal('autonomous-personal-memory'),
    interpretationFamily: z.literal('autonomous-personal-v1'),
    interpretationVersion: z.literal(1),
    preferenceInterpreter: CompositionalPreferenceV2DescriptorSchema,
    statementGrammarVersion: z.literal(1),
    compositionVersion: z.literal(1),
    providerContractVersion: z.literal(1),
    policy: AutonomousPersonalPolicyV3OwnedDataSchema,
    requestedTrustLevel: z.enum(['standard', 'trusted']),
    intentSetting: z.boolean(),
    invocationDeadlineMs: z.number().int().min(100).max(120_000),
    provider: providerOutputSchema,
    // Structural bound admits valid fixed reserves; refinement enforces the exact recipe.
    finalizationReserveMs: z.number().int().min(20).max(5000),
    assistantWriteAuthority: z.null(),
    executionBudget: AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema.optional(),
  })
  .strict();

/**
 * Reserve for a configured budget, taken as DATA from the pure resolver with
 * synthetic anchors. No clock is read and no execution deadline is invented.
 */
function configuredFinalizationReserveMs(
  executionBudget: unknown,
  invocationDeadlineMs: number,
): number {
  return resolveAutonomousPersonalExecutionBudgetV1(executionBudget, {
    originalStartedAt: 0,
    configuredOverallMs: invocationDeadlineMs,
    originalOverallDeadlineAt: invocationDeadlineMs,
    existingLeaseDeadlineAt: invocationDeadlineMs,
  }).finalizationReserveMs;
}

const descriptorWithoutHashSchema = descriptorBodySchema;
const descriptorWithHashSchema = descriptorBodySchema.extend({ settingsHash: hashSchema }).strict();

/**
 * Zod composition for data that is already owned by a bounded plain-data
 * boundary. This validates structure and recipe consistency only; it does not
 * establish route origin, provider permission, or processing authority.
 */
export const AutonomousPersonalDescriptorV4OwnedDataSchema = descriptorWithHashSchema
  .strict()
  .superRefine((descriptor, context) => {
    const { settingsHash, ...body } = descriptor;
    let expectedPolicy: AutonomousPersonalPolicyV3;
    try {
      expectedPolicy = compileAutonomousPersonalPolicyV3({
        profileId: descriptor.policy.profileId,
      });
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Descriptor policy is invalid',
        path: ['policy'],
      });
      return;
    }

    let expectedReserve: number;
    if (descriptor.executionBudget === undefined) {
      expectedReserve = Math.min(
        descriptor.policy.finalizationReserve.maxMs,
        Math.max(
          descriptor.policy.finalizationReserve.minMs,
          Math.ceil(
            (descriptor.invocationDeadlineMs * descriptor.policy.finalizationReserve.numerator) /
              descriptor.policy.finalizationReserve.denominator,
          ),
        ),
      );
    } else {
      try {
        expectedReserve = configuredFinalizationReserveMs(
          descriptor.executionBudget,
          descriptor.invocationDeadlineMs,
        );
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Descriptor execution budget is invalid',
          path: ['executionBudget'],
        });
        return;
      }
    }
    const expectedRequestLimit = Math.min(
      descriptor.provider.configuredRequestLimit,
      descriptor.policy.limits.providerMaxAttempts,
    );
    const expectedTimeout = Math.min(
      descriptor.provider.configuredTimeoutMs,
      descriptor.invocationDeadlineMs,
    );
    const expectedRequestBytes = Math.min(
      descriptor.provider.configuredRequestBytes,
      descriptor.policy.limits.providerRequestBytes,
    );
    const expectedResponseBytes = Math.min(
      descriptor.provider.configuredResponseBytes,
      descriptor.policy.limits.providerResponseBytes,
    );

    let expectedSettingsHash: string;
    try {
      expectedSettingsHash = hashAutomaticCaptureV2({
        domain: 'engram-autonomous-settings-v1',
        settings: body,
      });
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Descriptor settings hash is invalid',
        path: ['settingsHash'],
      });
      return;
    }

    if (
      descriptor.preferenceInterpreter.interpreterId !==
        COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR.interpreterId ||
      descriptor.preferenceInterpreter.semanticVersion !==
        COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR.semanticVersion ||
      descriptor.preferenceInterpreter.grammarVersion !==
        COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR.grammarVersion ||
      descriptor.preferenceInterpreter.lexiconVersion !==
        COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR.lexiconVersion ||
      hashAutomaticCaptureV2(descriptor.policy) !== hashAutomaticCaptureV2(expectedPolicy) ||
      descriptor.provider.effectiveRequestLimit !== expectedRequestLimit ||
      descriptor.provider.effectiveTimeoutMs !== expectedTimeout ||
      descriptor.provider.effectiveRequestBytes !== expectedRequestBytes ||
      descriptor.provider.effectiveResponseBytes !== expectedResponseBytes ||
      descriptor.finalizationReserveMs !== expectedReserve ||
      settingsHash !== expectedSettingsHash ||
      Buffer.byteLength(JSON.stringify(descriptor), 'utf8') > DESCRIPTOR_MAX_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Descriptor data does not match its compiled policy and settings',
      });
    }
  });

export type AutonomousPersonalDescriptorV4 = z.infer<
  typeof AutonomousPersonalDescriptorV4OwnedDataSchema
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function invalidDescriptorData(): z.ZodError {
  return new z.ZodError([
    { code: z.ZodIssueCode.custom, path: [], message: 'invalid_descriptor_data' },
  ]);
}

function ownInput(value: unknown): AutonomousPersonalDescriptorV4Input {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'policyData');
  return DescriptorInputSchema.parse(owned);
}

function parseOwnedDescriptor(value: unknown): AutonomousPersonalDescriptorV4 {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'policyData');
    return deepFreeze(AutonomousPersonalDescriptorV4OwnedDataSchema.parse(owned));
  } catch {
    throw invalidDescriptorData();
  }
}

/** Bounded facade: clone hostile JavaScript objects before running Zod. */
export const AutonomousPersonalDescriptorV4Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalDescriptorV4 {
    return parseOwnedDescriptor(value);
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalDescriptorV4> {
    try {
      return { success: true, data: parseOwnedDescriptor(value) };
    } catch {
      return { success: false, error: invalidDescriptorData() };
    }
  },
});

/** Compile a closed, immutable descriptor. Provider fields remain opaque data. */
export function compileAutonomousPersonalDescriptorV4(
  input: unknown,
): AutonomousPersonalDescriptorV4 {
  try {
    const checked = ownInput(input);
    const policy = compileAutonomousPersonalPolicyV3({ profileId: checked.profileId });
    const reserve = policy.finalizationReserve;
    const finalizationReserveMs =
      checked.executionBudget === undefined
        ? Math.min(
            reserve.maxMs,
            Math.max(
              reserve.minMs,
              Math.ceil((checked.invocationDeadlineMs * reserve.numerator) / reserve.denominator),
            ),
          )
        : configuredFinalizationReserveMs(checked.executionBudget, checked.invocationDeadlineMs);
    const provider = {
      ...checked.providerReference,
      structuredContractVersion: 1 as const,
      promptVersion: 1 as const,
      effectiveRequestLimit: Math.min(
        checked.providerReference.configuredRequestLimit,
        policy.limits.providerMaxAttempts,
      ),
      effectiveTimeoutMs: Math.min(
        checked.providerReference.configuredTimeoutMs,
        checked.invocationDeadlineMs,
      ),
      effectiveRequestBytes: Math.min(
        checked.providerReference.configuredRequestBytes,
        policy.limits.providerRequestBytes,
      ),
      effectiveResponseBytes: Math.min(
        checked.providerReference.configuredResponseBytes,
        policy.limits.providerResponseBytes,
      ),
    };
    const body = descriptorWithoutHashSchema.parse({
      version: 4,
      lifecycle: 'replaySafeV2',
      executionMode: 'synchronous',
      purpose: 'human_turn_memory',
      interpreterId: 'autonomous-personal-memory',
      interpretationFamily: 'autonomous-personal-v1',
      interpretationVersion: 1,
      preferenceInterpreter: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
      statementGrammarVersion: 1,
      compositionVersion: 1,
      providerContractVersion: 1,
      policy,
      requestedTrustLevel: checked.requestedTrustLevel,
      intentSetting: checked.intentSetting,
      invocationDeadlineMs: checked.invocationDeadlineMs,
      provider,
      finalizationReserveMs,
      assistantWriteAuthority: null,
      // Spread only when configured so legacy bodies never gain a key.
      ...(checked.executionBudget === undefined
        ? {}
        : { executionBudget: checked.executionBudget }),
    });
    const settingsHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-settings-v1',
      settings: body,
    });
    const descriptor = AutonomousPersonalDescriptorV4OwnedDataSchema.parse({
      ...body,
      settingsHash,
    });
    return deepFreeze(descriptor);
  } catch {
    throw invalidDescriptorData();
  }
}

/** Hash a complete, validated descriptor without proving route authenticity. */
export function hashAutonomousPersonalDescriptorV4(input: unknown): string {
  const descriptor = AutonomousPersonalDescriptorV4Schema.parse(input);
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-descriptor-v1',
    descriptor,
  });
}
