import { createHash } from 'crypto';
import { z } from 'zod';
import { compileAutomaticPolicy } from '../extraction/AutomaticEvidence';
import {
  AutomaticBindingReferenceSchema,
  AutomaticPolicySchema,
  AutomaticProfileIdSchema,
  type AutomaticPolicy,
} from './AutomaticMemory.schema';
import { AssistantWriteAuthorityReferenceV4Schema } from './AssistantWriteAuthorityReferenceV4.schema';

const HASH_64 = /^[a-f0-9]{64}$/;
const hash64 = z.string().regex(HASH_64);
const uuid = z.string().uuid();
const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .superRefine((value, context) => {
      if (value.length > max) return;
      if (value.trim().length === 0) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Value must not be blank' });
      }
    });

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

function isUtf16CodePointBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return offset >= 0 && offset <= value.length;
  const left = value.charCodeAt(offset - 1);
  const right = value.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}

/** Stable JSON encoding used only by the v2 capture descriptor/hash recipes. */
export function canonicalAutomaticCaptureV2(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAutomaticCaptureV2).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAutomaticCaptureV2(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function hashAutomaticCaptureV2(value: unknown): string {
  return createHash('sha256').update(canonicalAutomaticCaptureV2(value), 'utf8').digest('hex');
}

export const AutomaticCaptureLifecycleV2Schema = z.literal('replaySafeV2');
export const AutomaticCapturePurposeV2Schema = z.enum([
  'human_turn_memory',
  'assistant_final_save',
]);
export const AutomaticCaptureRoleV2Schema = z.enum(['human', 'assistant']);
export const AutomaticCaptureTrustLevelV2Schema = z.enum(['trusted', 'standard']);

export const AssistantWriteAuthorityReferenceV2Schema = z
  .object({
    kind: z.literal('owned_human_turn'),
    sourceId: uuid,
    sourceHash: hash64,
    descriptorHash: hash64,
    requestedAuthorityHash: hash64,
  })
  .strict();
export type AssistantWriteAuthorityReferenceV2 = z.infer<
  typeof AssistantWriteAuthorityReferenceV2Schema
>;

const StoredAssistantWriteAuthorityReferenceSchema = z.union([
  AssistantWriteAuthorityReferenceV2Schema,
  AssistantWriteAuthorityReferenceV4Schema,
]);

const policyIsCodeOwned = (policy: AutomaticPolicy): boolean => {
  try {
    return (
      canonicalAutomaticCaptureV2(policy) ===
      canonicalAutomaticCaptureV2(compileAutomaticPolicy({ profileId: policy.profileId }))
    );
  } catch {
    return false;
  }
};

const descriptorCommon = {
  version: z.literal(2),
  lifecycle: AutomaticCaptureLifecycleV2Schema,
  executionMode: z.literal('synchronous'),
  semanticVersion: z.literal(1),
  invocationDeadlineMs: z.number().int().min(100).max(120_000),
  settingsHash: hash64,
};

const humanDescriptor = z
  .object({
    ...descriptorCommon,
    purpose: z.literal('human_turn_memory'),
    interpreterId: z.literal('literal-parser-v1'),
    grammarVersion: z.literal(1),
    lexiconVersion: z.literal(1),
    requestedTrustLevel: AutomaticCaptureTrustLevelV2Schema,
    intentSetting: z.boolean(),
    policy: AutomaticPolicySchema,
    assistantWriteAuthority: z.null(),
  })
  .strict();

const assistantDescriptor = z
  .object({
    ...descriptorCommon,
    purpose: z.literal('assistant_final_save'),
    interpreterId: z.literal('assistant-final-write-v1'),
    grammarVersion: z.null(),
    lexiconVersion: z.null(),
    requestedTrustLevel: z.null(),
    intentSetting: z.null(),
    policy: z.null(),
    assistantWriteAuthority: AssistantWriteAuthorityReferenceV2Schema,
  })
  .strict();

const storedAssistantDescriptor = z
  .object({
    ...descriptorCommon,
    purpose: z.literal('assistant_final_save'),
    interpreterId: z.literal('assistant-final-write-v1'),
    grammarVersion: z.null(),
    lexiconVersion: z.null(),
    requestedTrustLevel: z.null(),
    intentSetting: z.null(),
    policy: z.null(),
    assistantWriteAuthority: StoredAssistantWriteAuthorityReferenceSchema,
  })
  .strict();

const descriptorSettingsKeys = {
  lifecycle: true,
  purpose: true,
  interpreterId: true,
  semanticVersion: true,
  grammarVersion: true,
  lexiconVersion: true,
  requestedTrustLevel: true,
  intentSetting: true,
  invocationDeadlineMs: true,
  policy: true,
  assistantWriteAuthority: true,
} as const;

export const AutomaticOperationDescriptorSettingsV2Schema = z
  .discriminatedUnion('purpose', [
    humanDescriptor.pick(descriptorSettingsKeys),
    assistantDescriptor.pick(descriptorSettingsKeys),
  ])
  .superRefine((settings, context) => {
    if (
      settings.purpose === 'human_turn_memory' &&
      (settings.policy.profileId === 'existing' || !policyIsCodeOwned(settings.policy))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Human descriptor settings must use an exact compiled non-existing profile',
        path: ['policy'],
      });
    }
  });
export type AutomaticOperationDescriptorSettingsV2 = z.infer<
  typeof AutomaticOperationDescriptorSettingsV2Schema
>;

const StoredAutomaticOperationDescriptorSettingsV2Schema = z.discriminatedUnion('purpose', [
  humanDescriptor.pick(descriptorSettingsKeys),
  storedAssistantDescriptor.pick(descriptorSettingsKeys),
]);

function automaticOperationStoredDescriptorSettingsHashV2(
  descriptor: z.infer<typeof humanDescriptor> | z.infer<typeof storedAssistantDescriptor>,
): string {
  const checked = StoredAutomaticOperationDescriptorSettingsV2Schema.parse({
    lifecycle: descriptor.lifecycle,
    purpose: descriptor.purpose,
    interpreterId: descriptor.interpreterId,
    semanticVersion: descriptor.semanticVersion,
    grammarVersion: descriptor.grammarVersion,
    lexiconVersion: descriptor.lexiconVersion,
    requestedTrustLevel: descriptor.requestedTrustLevel,
    intentSetting: descriptor.intentSetting,
    invocationDeadlineMs: descriptor.invocationDeadlineMs,
    policy: descriptor.policy,
    assistantWriteAuthority: descriptor.assistantWriteAuthority,
  });
  return hashAutomaticCaptureV2(checked);
}

export function automaticOperationDescriptorSettingsHashV2(
  descriptor: AutomaticOperationDescriptorSettingsV2,
): string {
  const checked = AutomaticOperationDescriptorSettingsV2Schema.parse({
    lifecycle: descriptor.lifecycle,
    purpose: descriptor.purpose,
    interpreterId: descriptor.interpreterId,
    semanticVersion: descriptor.semanticVersion,
    grammarVersion: descriptor.grammarVersion,
    lexiconVersion: descriptor.lexiconVersion,
    requestedTrustLevel: descriptor.requestedTrustLevel,
    intentSetting: descriptor.intentSetting,
    invocationDeadlineMs: descriptor.invocationDeadlineMs,
    policy: descriptor.policy,
    assistantWriteAuthority: descriptor.assistantWriteAuthority,
  });
  return hashAutomaticCaptureV2(checked);
}

/** Structural descriptor validation is not a capability or authority check. */
export const AutomaticOperationDescriptorV2Schema = z
  .discriminatedUnion('purpose', [humanDescriptor, storedAssistantDescriptor])
  .superRefine((descriptor, context) => {
    if (
      descriptor.purpose === 'human_turn_memory' &&
      (descriptor.policy.profileId === 'existing' || !policyIsCodeOwned(descriptor.policy))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Human descriptor policy must be an exact compiled non-existing profile',
        path: ['policy'],
      });
    }
    let expectedSettingsHash: string;
    try {
      expectedSettingsHash = automaticOperationStoredDescriptorSettingsHashV2(descriptor);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Descriptor settings are not a valid closed settings tuple',
        path: ['settingsHash'],
      });
      return;
    }
    if (descriptor.settingsHash !== expectedSettingsHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Descriptor settings hash does not match its closed settings',
        path: ['settingsHash'],
      });
    }
    if (Buffer.byteLength(JSON.stringify(descriptor), 'utf8') > 4 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Automatic capture descriptor exceeds 4 KiB serialized',
      });
    }
  });
export type AutomaticOperationDescriptorV2 = z.infer<typeof AutomaticOperationDescriptorV2Schema>;

export const AutomaticCaptureDescriptorBuildResultV2Schema = z
  .object({
    descriptor: AutomaticOperationDescriptorV2Schema,
    descriptorHash: hash64,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.descriptorHash !== hashAutomaticCaptureV2(result.descriptor)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Descriptor hash does not match the canonical descriptor',
        path: ['descriptorHash'],
      });
    }
  });
export type AutomaticCaptureDescriptorBuildResultV2 = z.infer<
  typeof AutomaticCaptureDescriptorBuildResultV2Schema
>;

const sourceContent = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (value.length > 65_536) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source content exceeds 65,536 UTF-16 code units',
      });
      return;
    }
    if (!isWellFormedUnicode(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source content has invalid Unicode',
      });
    }
    if (Buffer.byteLength(value, 'utf8') > 65_536) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source content exceeds 65,536 UTF-8 bytes',
      });
    }
  });

// EpisodicNodeSchema trims these fields when storing them. Reject noncanonical
// input so a hash cannot be computed over a value the backend later changes.
const boundedNullableString = (label: string) =>
  z
    .string()
    .min(1)
    .max(512)
    .superRefine((value, context) => {
      if (value.length > 512) return;
      if (!isWellFormedUnicode(value)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} has invalid Unicode` });
        return;
      }
      if (value.trim().length === 0 || value.trim() !== value) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must use the stored trimmed form`,
        });
      }
    })
    .nullable();
const nullableProducerIdentifier = boundedNullableString('Identifier');
const nullableDisplay = boundedNullableString('Display value');

export const AutomaticCaptureRegionV2Schema = z
  .object({
    start: z.number().int().min(0).max(65_536),
    end: z.number().int().min(1).max(65_536),
  })
  .strict()
  .refine((region) => region.start < region.end, 'Region must be non-empty');
export type AutomaticCaptureRegionV2 = z.infer<typeof AutomaticCaptureRegionV2Schema>;

const explicitEventTime = z
  .object({
    mode: z.literal('explicit'),
    value: z
      .string()
      .datetime({ offset: true })
      // Zod's datetime regex accepts some out-of-range offsets; validate before
      // calling toISOString so safeParse cannot throw during normalization.
      .superRefine((value, context) => {
        if (!Number.isFinite(Date.parse(value))) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Explicit event time must be a valid date-time',
          });
          return;
        }
        const offset = /[+-](\d{2}):?(\d{2})$/.exec(value);
        if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Explicit event time has an invalid UTC offset',
          });
        } else if (!offset && !value.endsWith('Z')) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Explicit event time must include a supported UTC offset',
          });
        }
      })
      .transform((value) => new Date(value).toISOString()),
  })
  .strict();
const firstCaptureEventTime = z.object({ mode: z.literal('first_capture') }).strict();
export const AutomaticCaptureEventTimeV2Schema = z.discriminatedUnion('mode', [
  explicitEventTime,
  firstCaptureEventTime,
]);

const settings = z
  .object({
    profileId: AutomaticProfileIdSchema.nullable(),
    requestedTrustLevel: AutomaticCaptureTrustLevelV2Schema.nullable(),
    intentSetting: z.boolean().nullable(),
    invocationDeadlineMs: z.number().int().min(100).max(120_000),
  })
  .strict();

const source = z
  .object({
    content: sourceContent,
    sourceMessageId: nullableProducerIdentifier,
    conversationId: nullableProducerIdentifier,
    senderId: nullableProducerIdentifier,
    senderName: nullableDisplay,
    sourceWorkflowId: nullableProducerIdentifier,
    originalSourceExecutionId: nullableProducerIdentifier,
    sourceType: z.literal('message'),
    quotedMessageId: nullableProducerIdentifier,
    eventTime: AutomaticCaptureEventTimeV2Schema,
    applicationOwnedWrapper: z.literal(true).nullable(),
    humanRegion: AutomaticCaptureRegionV2Schema.nullable(),
    quoteRegions: z.array(AutomaticCaptureRegionV2Schema).max(32),
  })
  .strict();

/** Caller data contains producer/source inputs only; it has no authority/hash/ID fields. */
export const AutomaticCaptureBeginRequestV2Schema = z
  .object({
    version: z.literal(2),
    lifecycle: AutomaticCaptureLifecycleV2Schema,
    purpose: AutomaticCapturePurposeV2Schema,
    namespace: nonBlank(128),
    issuer: nonBlank(256),
    actorReference: nonBlank(512),
    turn: nonBlank(512),
    settings,
    source,
    attemptIdHash: hash64,
  })
  .strict()
  .superRefine((request, context) => {
    const invalid = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (request.purpose === 'human_turn_memory') {
      if (request.settings.profileId === null || request.settings.profileId === 'existing') {
        invalid(
          ['settings', 'profileId'],
          'Human capture requires a code-owned non-existing profile',
        );
      }
      if (
        request.settings.requestedTrustLevel === null ||
        request.settings.intentSetting === null
      ) {
        invalid(['settings'], 'Human capture requires trust and intent settings');
      }
      if (
        (request.source.applicationOwnedWrapper === null && request.source.humanRegion !== null) ||
        (request.source.applicationOwnedWrapper === true && request.source.humanRegion === null)
      ) {
        invalid(['source', 'humanRegion'], 'Wrapper and human region must form a complete mapping');
      }
      // The v1 envelope counts its one body mapping together with quote spans.
      if (request.source.quoteRegions.length + 1 > 32) {
        invalid(
          ['source', 'quoteRegions'],
          'Human mapping and quote regions exceed 32 total spans',
        );
      }
    } else {
      if (
        request.settings.profileId !== null ||
        request.settings.requestedTrustLevel !== null ||
        request.settings.intentSetting !== null
      ) {
        invalid(['settings'], 'Assistant final save requires null human capture settings');
      }
      if (
        request.source.applicationOwnedWrapper !== null ||
        request.source.humanRegion !== null ||
        request.source.quoteRegions.length !== 0
      ) {
        invalid(['source'], 'Assistant final save requires the full unwrapped source');
      }
    }

    const content = request.source.content;
    if (content.length > 65_536) return;
    if (!isWellFormedUnicode(content)) return;
    const region = request.source.humanRegion;
    const bodyStart = region?.start ?? 0;
    const bodyEnd = region?.end ?? content.length;
    if (bodyEnd > content.length) {
      invalid(['source', 'humanRegion'], 'Human region exceeds source content');
      return;
    }
    if (
      !isUtf16CodePointBoundary(content, bodyStart) ||
      !isUtf16CodePointBoundary(content, bodyEnd)
    ) {
      invalid(['source', 'humanRegion'], 'Human region splits a Unicode code point');
      return;
    }
    const body = content.slice(bodyStart, bodyEnd);
    for (const [index, quote] of request.source.quoteRegions.entries()) {
      if (quote.end > body.length) {
        invalid(['source', 'quoteRegions', index], 'Quote region exceeds mapped human content');
      } else if (
        !isUtf16CodePointBoundary(body, quote.start) ||
        !isUtf16CodePointBoundary(body, quote.end)
      ) {
        invalid(['source', 'quoteRegions', index], 'Quote region splits a Unicode code point');
      }
      if (index > 0 && quote.start < request.source.quoteRegions[index - 1].end) {
        invalid(
          ['source', 'quoteRegions', index],
          'Quote regions must be ordered and non-overlapping',
        );
      }
    }
  });
export type AutomaticCaptureBeginRequestV2Input = z.input<
  typeof AutomaticCaptureBeginRequestV2Schema
>;
export type AutomaticCaptureBeginRequestV2 = z.infer<typeof AutomaticCaptureBeginRequestV2Schema>;

const sourceOwnerCommon = {
  version: z.literal(2),
  lifecycle: AutomaticCaptureLifecycleV2Schema,
  storeHash: hash64,
  namespace: nonBlank(128),
  turn: nonBlank(512),
  issuer: nonBlank(256),
  actorReference: nonBlank(512),
  binding: AutomaticBindingReferenceSchema.nullable(),
  eventTimeMode: z.enum(['explicit', 'first_capture']),
  eventTimeHash: hash64,
  stableProducerHash: hash64,
  sourceContentHash: hash64,
  settingsHash: hash64,
};

const humanSourceOwner = z
  .object({
    ...sourceOwnerCommon,
    binding: AutomaticBindingReferenceSchema,
    role: z.literal('human'),
    purpose: z.literal('human_turn_memory'),
    assistantWriteAuthority: z.null(),
    requestedTrustLevel: AutomaticCaptureTrustLevelV2Schema,
    intentSetting: z.boolean(),
    intentEvidence: z.boolean(),
    policy: AutomaticPolicySchema,
  })
  .strict();
const assistantSourceOwner = z
  .object({
    ...sourceOwnerCommon,
    role: z.literal('assistant'),
    purpose: z.literal('assistant_final_save'),
    binding: z.null(),
    assistantWriteAuthority: AssistantWriteAuthorityReferenceV2Schema,
    requestedTrustLevel: z.null(),
    intentSetting: z.null(),
    intentEvidence: z.null(),
    policy: z.null(),
  })
  .strict();

const storedAssistantSourceOwner = z
  .object({
    ...sourceOwnerCommon,
    role: z.literal('assistant'),
    purpose: z.literal('assistant_final_save'),
    binding: z.null(),
    assistantWriteAuthority: StoredAssistantWriteAuthorityReferenceSchema,
    requestedTrustLevel: z.null(),
    intentSetting: z.null(),
    intentEvidence: z.null(),
    policy: z.null(),
  })
  .strict();

function sourceOwnerSchema<T extends z.AnyZodObject>(assistantOwner: T) {
  return z
    .discriminatedUnion('purpose', [humanSourceOwner, assistantOwner] as const)
    .superRefine((owner, context) => {
      if (owner.purpose === 'human_turn_memory') {
        if (owner.policy.profileId === 'existing' || !policyIsCodeOwned(owner.policy)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Human source owner policy must be an exact compiled non-existing profile',
            path: ['policy'],
          });
        }
      }
      if (Buffer.byteLength(JSON.stringify(owner), 'utf8') > 4 * 1024) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Automatic capture source owner exceeds 4 KiB serialized',
        });
      }
    });
}

export const AutomaticCaptureSourceOwnerV2Schema = sourceOwnerSchema(assistantSourceOwner);
/** Strict stored owner shape; V2 authorization parsers intentionally stay V2-only. */
export const AutomaticCaptureSourceOwnerStoredV2Schema = sourceOwnerSchema(
  storedAssistantSourceOwner,
);

/*
 * Keep the public V2 owner type tied to its V2-only schema. The stored schema
 * above is used only where the graph reader must retain and inspect a V4 ref.
 */
export type AutomaticCaptureSourceOwnerV2 = z.infer<typeof AutomaticCaptureSourceOwnerV2Schema>;

const identityCommon = {
  lifecycle: AutomaticCaptureLifecycleV2Schema,
  storeHash: hash64,
  namespace: nonBlank(128),
  issuer: nonBlank(256),
  actorReference: nonBlank(512),
  turn: nonBlank(512),
  sourceId: uuid,
  sourceHash: hash64,
  originalProducerHash: hash64,
  stableProducerHash: hash64,
  requestedAuthorityHash: hash64,
};
const humanOperationIdentity = z
  .object({
    ...identityCommon,
    role: z.literal('human'),
    purpose: z.literal('human_turn_memory'),
    binding: AutomaticBindingReferenceSchema,
  })
  .strict();
const assistantOperationIdentity = z
  .object({
    ...identityCommon,
    role: z.literal('assistant'),
    purpose: z.literal('assistant_final_save'),
    binding: z.null(),
  })
  .strict();

export const AutomaticOperationIdentityV2Schema = z.discriminatedUnion('purpose', [
  humanOperationIdentity,
  assistantOperationIdentity,
]);
export type AutomaticOperationIdentityV2 = z.infer<typeof AutomaticOperationIdentityV2Schema>;
