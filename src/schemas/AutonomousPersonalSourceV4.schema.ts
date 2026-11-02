import { createHash } from 'crypto';
import { z } from 'zod';
import {
  AutonomousPersonalDescriptorV4OwnedDataSchema,
  compileAutonomousPersonalDescriptorV4,
  hashAutonomousPersonalDescriptorV4,
  type AutonomousPersonalDescriptorV4,
} from './AutonomousPersonalDescriptorV4.schema';
import {
  AutonomousPersonalPolicyV3OwnedDataSchema,
  compileAutonomousPersonalPolicyV3,
  type AutonomousPersonalPolicyV3,
} from './AutonomousPersonalPolicyV3.schema';
import {
  AutonomousSourceGeometryV3OwnedDataSchema,
  compileAutonomousSourceGeometryV3,
  hashAutonomousSourceGeometryV3,
  type AutonomousSourceGeometryV3,
} from './AutonomousSourceGeometryV3.schema';
import { canonicalAutomaticCaptureV2, hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import { AutomaticBindingReferenceSchema } from './AutomaticMemory.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { EpisodicNodeSchema } from './EpisodicNode.schema';

const HASH_64 = /^[a-f0-9]{64}$/u;
const UUID_SCHEMA = z.string().uuid();
const SOURCE_MAX_BYTES = 65_536;
const CHILD_MAX_BYTES = 16 * 1024;
const TUPLE_MAX_BYTES = 32 * 1024;
const STORED_SOURCE_RESULT_MAX_BYTES = 512 * 1024;
export const AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE = 'engram_write_owner_v4';
export const AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE = 'engram_source_envelope_v3';
const STORED_SOURCE_OWNER_ATTRIBUTE = AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE;
const STORED_SOURCE_ENVELOPE_ATTRIBUTE = AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE;
const RESERVED_STORED_SOURCE_ATTRIBUTE_PREFIXES = [
  'engram_write_owner_',
  'engram_source_envelope_',
] as const;

const hashSchema = z.string().regex(HASH_64);

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

function exactNonBlankText(maximumLength: number) {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => value.trim().length > 0 && isWellFormedUnicode(value));
}

const nullableIdentifierSchema = exactNonBlankText(512).nullable();
const namespaceSchema = exactNonBlankText(128);
const issuerSchema = exactNonBlankText(256);
const actorReferenceSchema = exactNonBlankText(512);
const turnSchema = exactNonBlankText(512);

const offsetDateTimeSchema = z
  .string()
  .min(1)
  .max(128)
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));

const canonicalUtcMillisecondsSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });

const utf16OffsetSchema = z.number().int().safe().min(0).max(SOURCE_MAX_BYTES);
const regionSchema = z
  .object({
    start: utf16OffsetSchema,
    end: utf16OffsetSchema,
  })
  .strict()
  .refine((region) => region.start < region.end);

const mappingInputSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('full_body') }).strict(),
  z
    .object({
      mode: z.literal('application_region'),
      humanRegion: regionSchema,
      applicationWrapper: z.object({ configurationFingerprint: hashSchema }).strict(),
    })
    .strict(),
]);

const scopeInputSchema = z
  .object({
    storeHash: hashSchema,
    namespace: namespaceSchema,
    issuer: issuerSchema,
    actorReference: actorReferenceSchema,
    turn: turnSchema,
    binding: AutomaticBindingReferenceSchema,
  })
  .strict();

const producerInputSchema = z
  .object({
    uuid: UUID_SCHEMA,
    group_id: exactNonBlankText(128),
    content: z.string().max(SOURCE_MAX_BYTES),
    role: z.literal('human'),
    source_type: z.literal('message'),
    episode_kind: z.literal('active_human'),
    reference_time: offsetDateTimeSchema,
    previous_episode_uuid: UUID_SCHEMA.nullable(),
    source_message_id: nullableIdentifierSchema,
    idempotency_key: nullableIdentifierSchema,
    conversation_id: nullableIdentifierSchema,
    sender_id: nullableIdentifierSchema,
    source_workflow_id: nullableIdentifierSchema,
    source_execution_id: nullableIdentifierSchema,
    quoted_message_id: nullableIdentifierSchema,
    created_at: canonicalUtcMillisecondsSchema,
  })
  .strict();
/** Strict source producer shape for already-owned source construction DATA. */
export const AutonomousPersonalSourceProducerV4OwnedDataSchema = producerInputSchema;

const sourceTupleInputBaseSchema = z
  .object({
    scope: scopeInputSchema,
    producer: producerInputSchema,
    eventTimeMode: z.enum(['explicit', 'first_capture']),
    mapping: mappingInputSchema,
    quoteRegions: z.array(regionSchema).max(32),
  })
  .strict();

function refineSourceTupleInput(
  input: z.infer<typeof sourceTupleInputBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (input.producer.group_id !== input.scope.namespace) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Producer group must equal the captured namespace',
      path: ['producer', 'group_id'],
    });
  }
  if (
    !isWellFormedUnicode(input.producer.content) ||
    Buffer.byteLength(input.producer.content, 'utf8') > SOURCE_MAX_BYTES
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Source content is not valid bounded Unicode',
      path: ['producer', 'content'],
    });
  }
  if (
    input.eventTimeMode === 'first_capture' &&
    input.producer.reference_time !== input.producer.created_at
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'First-capture reference time must equal canonical creation time',
      path: ['producer', 'reference_time'],
    });
  }
}

const sourceTupleInputSchema = sourceTupleInputBaseSchema
  .extend({ descriptor: AutonomousPersonalDescriptorV4OwnedDataSchema })
  .strict()
  .superRefine((input, context) => refineSourceTupleInput(input, context));

const sourceTupleAssemblyInputSchema = sourceTupleInputBaseSchema
  .extend({
    settingsHash: hashSchema,
    descriptorHash: hashSchema,
    requestedTrustLevel: z.enum(['standard', 'trusted']),
    policy: AutonomousPersonalPolicyV3OwnedDataSchema,
  })
  .strict()
  .superRefine((input, context) => refineSourceTupleInput(input, context));

export type AutonomousPersonalSourceTupleV4Input = z.infer<typeof sourceTupleInputSchema>;
type SourceTupleAssemblyInput = z.infer<typeof sourceTupleAssemblyInputSchema>;

const ownerBodySchema = z
  .object({
    version: z.literal(4),
    family: z.literal('autonomous-personal-v1'),
    lifecycle: z.literal('replaySafeV2'),
    storeHash: hashSchema,
    namespace: namespaceSchema,
    issuer: issuerSchema,
    actorReference: actorReferenceSchema,
    turn: turnSchema,
    role: z.literal('human'),
    purpose: z.literal('human_turn_memory'),
    sourceId: UUID_SCHEMA,
    binding: AutomaticBindingReferenceSchema,
    contentHash: hashSchema,
    producerHash: hashSchema,
    geometryHash: hashSchema,
    eventTimeMode: z.enum(['explicit', 'first_capture']),
    eventTimeHash: hashSchema,
    settingsHash: hashSchema,
    descriptorHash: hashSchema,
    policyFingerprint: hashSchema,
    requestedAuthorityHash: hashSchema,
    requestedTrustLevel: z.enum(['standard', 'trusted']),
  })
  .strict();

const ownerWithoutAuthorityHashSchema = ownerBodySchema.omit({ requestedAuthorityHash: true });
type OwnerV4WithoutAuthorityHash = z.infer<typeof ownerWithoutAuthorityHashSchema>;

function requestedAuthorityHash(owner: OwnerV4WithoutAuthorityHash): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-authority-v1',
    authority: {
      lifecycle: owner.lifecycle,
      storeHash: owner.storeHash,
      namespace: owner.namespace,
      issuer: owner.issuer,
      actorReference: owner.actorReference,
      turn: owner.turn,
      role: owner.role,
      purpose: owner.purpose,
      sourceId: owner.sourceId,
      contentHash: owner.contentHash,
      producerHash: owner.producerHash,
      geometryHash: owner.geometryHash,
      eventTimeMode: owner.eventTimeMode,
      eventTimeHash: owner.eventTimeHash,
      settingsHash: owner.settingsHash,
      descriptorHash: owner.descriptorHash,
      policyFingerprint: owner.policyFingerprint,
      binding: owner.binding,
      requestedTrustLevel: owner.requestedTrustLevel,
    },
  });
}

export const AutonomousPersonalSourceOwnerV4OwnedDataSchema = ownerBodySchema
  .strict()
  .superRefine((owner, context) => {
    if (owner.requestedAuthorityHash !== requestedAuthorityHash(owner)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Owner authority hash mismatch',
        path: ['requestedAuthorityHash'],
      });
    }
    if (Buffer.byteLength(JSON.stringify(owner), 'utf8') > CHILD_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Owner metadata exceeds 16 KiB',
      });
    }
  });

export type AutonomousPersonalSourceOwnerV4 = z.infer<
  typeof AutonomousPersonalSourceOwnerV4OwnedDataSchema
>;

const policyRefSchema = z
  .object({
    version: z.literal(3),
    policyId: z.literal('autonomous-personal-memory'),
    policyVersion: z.literal(1),
    profileId: z.enum(['conservative', 'explicit', 'reviewFirst']),
    profileVersion: z.literal(2),
    fingerprint: hashSchema,
  })
  .strict();

const envelopeBodySchema = z
  .object({
    version: z.literal(3),
    family: z.literal('autonomous-personal-v1'),
    geometry: AutonomousSourceGeometryV3OwnedDataSchema,
    policyRef: policyRefSchema,
    descriptorHash: hashSchema,
    requestedAuthorityHash: hashSchema,
  })
  .strict();

export const AutonomousPersonalSourceEnvelopeV3OwnedDataSchema = envelopeBodySchema
  .strict()
  .superRefine((envelope, context) => {
    let expectedPolicy: AutonomousPersonalPolicyV3;
    try {
      expectedPolicy = compileAutonomousPersonalPolicyV3({
        profileId: envelope.policyRef.profileId,
      });
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Envelope policy reference is invalid',
        path: ['policyRef'],
      });
      return;
    }
    const policyRef = envelope.policyRef;
    if (
      policyRef.version !== expectedPolicy.version ||
      policyRef.policyId !== expectedPolicy.policyId ||
      policyRef.policyVersion !== expectedPolicy.policyVersion ||
      policyRef.profileId !== expectedPolicy.profileId ||
      policyRef.profileVersion !== expectedPolicy.profileVersion ||
      policyRef.fingerprint !== expectedPolicy.fingerprint
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Envelope policy reference does not match policy3',
        path: ['policyRef'],
      });
    }
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > CHILD_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Envelope metadata exceeds 16 KiB',
      });
    }
  });

export type AutonomousPersonalSourceEnvelopeV3 = z.infer<
  typeof AutonomousPersonalSourceEnvelopeV3OwnedDataSchema
>;

const operationIdentityBodySchema = z
  .object({
    version: z.literal(4),
    lifecycle: z.literal('replaySafeV2'),
    storeHash: hashSchema,
    namespace: namespaceSchema,
    issuer: issuerSchema,
    actorReference: actorReferenceSchema,
    turn: turnSchema,
    role: z.literal('human'),
    purpose: z.literal('human_turn_memory'),
    sourceId: UUID_SCHEMA,
    sourceHash: hashSchema,
    contentHash: hashSchema,
    producerHash: hashSchema,
    geometryHash: hashSchema,
    eventTimeMode: z.enum(['explicit', 'first_capture']),
    eventTimeHash: hashSchema,
    settingsHash: hashSchema,
    descriptorHash: hashSchema,
    policyFingerprint: hashSchema,
    requestedAuthorityHash: hashSchema,
    binding: AutomaticBindingReferenceSchema,
  })
  .strict();

export const AutonomousPersonalOperationIdentityV4OwnedDataSchema = operationIdentityBodySchema
  .strict()
  .superRefine((identity, context) => {
    if (Buffer.byteLength(JSON.stringify(identity), 'utf8') > CHILD_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Operation identity exceeds 16 KiB',
      });
    }
  });

export type AutonomousPersonalOperationIdentityV4 = z.infer<
  typeof AutonomousPersonalOperationIdentityV4OwnedDataSchema
>;

const tupleBodySchema = z
  .object({
    owner: AutonomousPersonalSourceOwnerV4OwnedDataSchema,
    envelope: AutonomousPersonalSourceEnvelopeV3OwnedDataSchema,
    identity: AutonomousPersonalOperationIdentityV4OwnedDataSchema,
  })
  .strict();

function geometryHash(geometry: AutonomousSourceGeometryV3): string {
  return hashAutonomousSourceGeometryV3(geometry);
}

function sourceHash(
  owner: AutonomousPersonalSourceOwnerV4,
  envelope: AutonomousPersonalSourceEnvelopeV3,
): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-source-identity-v1',
    sourceIdentity: {
      owner,
      envelope,
      producerHash: owner.producerHash,
      requestedReview: 'accepted',
    },
  });
}

export const AutonomousPersonalSourceTupleV4OwnedDataSchema = tupleBodySchema
  .strict()
  .superRefine((tuple, context) => {
    const { owner, envelope, identity } = tuple;
    const actualGeometryHash = geometryHash(envelope.geometry);
    const authorityMatches =
      owner.requestedAuthorityHash === envelope.requestedAuthorityHash &&
      owner.requestedAuthorityHash === identity.requestedAuthorityHash;
    const sourceHashMatches = identity.sourceHash === sourceHash(owner, envelope);
    const repeatedFieldsMatch =
      owner.lifecycle === identity.lifecycle &&
      owner.storeHash === identity.storeHash &&
      owner.namespace === identity.namespace &&
      owner.issuer === identity.issuer &&
      owner.actorReference === identity.actorReference &&
      owner.turn === identity.turn &&
      owner.sourceId === identity.sourceId &&
      canonicalAutomaticCaptureV2(owner.binding) ===
        canonicalAutomaticCaptureV2(identity.binding) &&
      owner.contentHash === identity.contentHash &&
      owner.producerHash === identity.producerHash &&
      owner.geometryHash === identity.geometryHash &&
      owner.eventTimeMode === identity.eventTimeMode &&
      owner.eventTimeHash === identity.eventTimeHash &&
      owner.settingsHash === identity.settingsHash &&
      owner.descriptorHash === identity.descriptorHash &&
      owner.policyFingerprint === identity.policyFingerprint;
    const policyMatches =
      envelope.policyRef.fingerprint === owner.policyFingerprint &&
      envelope.policyRef.fingerprint === identity.policyFingerprint;

    if (
      actualGeometryHash !== owner.geometryHash ||
      actualGeometryHash !== identity.geometryHash ||
      envelope.geometry.rawContentHash !== owner.contentHash ||
      envelope.geometry.rawContentHash !== identity.contentHash ||
      envelope.descriptorHash !== owner.descriptorHash ||
      envelope.descriptorHash !== identity.descriptorHash ||
      !authorityMatches ||
      !sourceHashMatches ||
      !repeatedFieldsMatch ||
      !policyMatches
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source tuple metadata is internally inconsistent',
      });
    }
    if (Buffer.byteLength(JSON.stringify(tuple), 'utf8') > TUPLE_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source tuple metadata exceeds 32 KiB',
      });
    }
  });

export type AutonomousPersonalSourceTupleV4 = z.infer<
  typeof AutonomousPersonalSourceTupleV4OwnedDataSchema
>;

const storedEpisodicSourceSchema = EpisodicNodeSchema.strict();
const storedSourceResultShape = {
  version: z.literal(4),
  source: storedEpisodicSourceSchema,
  tuple: AutonomousPersonalSourceTupleV4OwnedDataSchema,
};

export const AutonomousPersonalStoredSourceV4OwnedDataSchema = z
  .object({
    ...storedSourceResultShape,
    descriptorValidation: z.literal('opaque_only'),
  })
  .strict()
  .superRefine((result, context) => {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > STORED_SOURCE_RESULT_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Stored source result exceeds the 512 KiB limit',
      });
    }
  });

export type AutonomousPersonalStoredSourceV4 = z.infer<
  typeof AutonomousPersonalStoredSourceV4OwnedDataSchema
>;

export const AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema = z
  .object({
    ...storedSourceResultShape,
    descriptorValidation: z.literal('compiled_descriptor'),
    descriptor: AutonomousPersonalDescriptorV4OwnedDataSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > STORED_SOURCE_RESULT_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Stored source result exceeds the 512 KiB limit',
      });
    }
  });

export type AutonomousPersonalStoredSourceIdentityV4 = z.infer<
  typeof AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema
>;

const storedSourceIdentityInputSchema = z
  .object({
    source: z.unknown(),
    descriptor: AutonomousPersonalDescriptorV4OwnedDataSchema,
  })
  .strict();

function sameCanonicalAutomaticData(left: unknown, right: unknown): boolean {
  try {
    return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function sha256ExactUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalidAutonomousSourceData(): z.ZodError {
  return new z.ZodError([
    { code: z.ZodIssueCode.custom, path: [], message: 'invalid_autonomous_source_data' },
  ]);
}

function invalidAutonomousStoredSourceData(): z.ZodError {
  const error = new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'invalid_autonomous_stored_source_data',
    },
  ]);
  const issue = error.issues[0];
  if (issue) {
    Object.freeze(issue.path);
    Object.freeze(issue);
  }
  Object.freeze(error.issues);
  return Object.freeze(error);
}

function parseBounded<T>(
  value: unknown,
  bound: 'policyData' | 'beginRequest',
  schema: z.ZodType<T>,
): T {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, bound);
  return deepFreeze(schema.parse(owned));
}

export const AutonomousPersonalSourceOwnerV4Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalSourceOwnerV4 {
    try {
      return parseBounded(value, 'policyData', AutonomousPersonalSourceOwnerV4OwnedDataSchema);
    } catch {
      throw invalidAutonomousSourceData();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalSourceOwnerV4> {
    try {
      return {
        success: true,
        data: parseBounded(value, 'policyData', AutonomousPersonalSourceOwnerV4OwnedDataSchema),
      };
    } catch {
      return { success: false, error: invalidAutonomousSourceData() };
    }
  },
});

export const AutonomousPersonalSourceEnvelopeV3Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalSourceEnvelopeV3 {
    try {
      return parseBounded(value, 'policyData', AutonomousPersonalSourceEnvelopeV3OwnedDataSchema);
    } catch {
      throw invalidAutonomousSourceData();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalSourceEnvelopeV3> {
    try {
      return {
        success: true,
        data: parseBounded(value, 'policyData', AutonomousPersonalSourceEnvelopeV3OwnedDataSchema),
      };
    } catch {
      return { success: false, error: invalidAutonomousSourceData() };
    }
  },
});

export const AutonomousPersonalOperationIdentityV4Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalOperationIdentityV4 {
    try {
      return parseBounded(
        value,
        'policyData',
        AutonomousPersonalOperationIdentityV4OwnedDataSchema,
      );
    } catch {
      throw invalidAutonomousSourceData();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalOperationIdentityV4> {
    try {
      return {
        success: true,
        data: parseBounded(
          value,
          'policyData',
          AutonomousPersonalOperationIdentityV4OwnedDataSchema,
        ),
      };
    } catch {
      return { success: false, error: invalidAutonomousSourceData() };
    }
  },
});

export const AutonomousPersonalSourceTupleV4Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalSourceTupleV4 {
    try {
      return parseBounded(value, 'beginRequest', AutonomousPersonalSourceTupleV4OwnedDataSchema);
    } catch {
      throw invalidAutonomousSourceData();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalSourceTupleV4> {
    try {
      return {
        success: true,
        data: parseBounded(value, 'beginRequest', AutonomousPersonalSourceTupleV4OwnedDataSchema),
      };
    } catch {
      return { success: false, error: invalidAutonomousSourceData() };
    }
  },
});

function hashOriginalProducerV4(producer: z.infer<typeof producerInputSchema>): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-producer-v1',
    producer,
  });
}

function hashEventTimeV4(
  mode: SourceTupleAssemblyInput['eventTimeMode'],
  referenceTime: string,
): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-event-time-v1',
    eventTime: {
      mode,
      canonicalUtcInstant: new Date(Date.parse(referenceTime)).toISOString(),
    },
  });
}

function assembleAutonomousPersonalSourceTupleV4(
  input: SourceTupleAssemblyInput,
): AutonomousPersonalSourceTupleV4 {
  const checked = sourceTupleAssemblyInputSchema.parse(input);
  const producer = checked.producer;
  const geometryCompilation = compileAutonomousSourceGeometryV3({
    rawContent: producer.content,
    mapping: checked.mapping,
    quoteRegions: checked.quoteRegions,
  });
  const geometry = AutonomousSourceGeometryV3OwnedDataSchema.parse(geometryCompilation.geometry);
  const contentHash = sha256ExactUtf8(producer.content);
  const producerHash = hashOriginalProducerV4(producer);
  const eventTimeHash = hashEventTimeV4(checked.eventTimeMode, producer.reference_time);
  const policy: AutonomousPersonalPolicyV3 = checked.policy;

  const ownerWithoutAuthorityHash: OwnerV4WithoutAuthorityHash = {
    version: 4,
    family: 'autonomous-personal-v1',
    lifecycle: 'replaySafeV2',
    storeHash: checked.scope.storeHash,
    namespace: checked.scope.namespace,
    issuer: checked.scope.issuer,
    actorReference: checked.scope.actorReference,
    turn: checked.scope.turn,
    role: 'human',
    purpose: 'human_turn_memory',
    sourceId: producer.uuid,
    binding: checked.scope.binding,
    contentHash,
    producerHash,
    geometryHash: geometryCompilation.geometryHash,
    eventTimeMode: checked.eventTimeMode,
    eventTimeHash,
    settingsHash: checked.settingsHash,
    descriptorHash: checked.descriptorHash,
    policyFingerprint: policy.fingerprint,
    requestedTrustLevel: checked.requestedTrustLevel,
  };
  const owner = AutonomousPersonalSourceOwnerV4OwnedDataSchema.parse({
    ...ownerWithoutAuthorityHash,
    requestedAuthorityHash: requestedAuthorityHash(ownerWithoutAuthorityHash),
  });
  const envelope = AutonomousPersonalSourceEnvelopeV3OwnedDataSchema.parse({
    version: 3,
    family: 'autonomous-personal-v1',
    geometry,
    policyRef: {
      version: policy.version,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      profileId: policy.profileId,
      profileVersion: policy.profileVersion,
      fingerprint: policy.fingerprint,
    },
    descriptorHash: checked.descriptorHash,
    requestedAuthorityHash: owner.requestedAuthorityHash,
  });
  const identityWithoutSourceHash = {
    version: 4 as const,
    lifecycle: owner.lifecycle,
    storeHash: owner.storeHash,
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actorReference,
    turn: owner.turn,
    role: owner.role,
    purpose: owner.purpose,
    sourceId: owner.sourceId,
    contentHash: owner.contentHash,
    producerHash: owner.producerHash,
    geometryHash: owner.geometryHash,
    eventTimeMode: owner.eventTimeMode,
    eventTimeHash: owner.eventTimeHash,
    settingsHash: owner.settingsHash,
    descriptorHash: owner.descriptorHash,
    policyFingerprint: owner.policyFingerprint,
    requestedAuthorityHash: owner.requestedAuthorityHash,
    binding: owner.binding,
  };
  const identity = AutonomousPersonalOperationIdentityV4OwnedDataSchema.parse({
    ...identityWithoutSourceHash,
    sourceHash: sourceHash(owner, envelope),
  });
  return deepFreeze(
    AutonomousPersonalSourceTupleV4OwnedDataSchema.parse({
      owner,
      envelope,
      identity,
    }),
  );
}

/** Compile source identity metadata only; this function establishes no authority. */
export function compileAutonomousPersonalSourceTupleV4(
  input: unknown,
): AutonomousPersonalSourceTupleV4 {
  try {
    const ownedInput = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    const checked = sourceTupleInputSchema.parse(ownedInput);
    const descriptor: AutonomousPersonalDescriptorV4 = checked.descriptor;
    return assembleAutonomousPersonalSourceTupleV4({
      scope: checked.scope,
      producer: checked.producer,
      eventTimeMode: checked.eventTimeMode,
      mapping: checked.mapping,
      quoteRegions: checked.quoteRegions,
      settingsHash: descriptor.settingsHash,
      descriptorHash: hashAutonomousPersonalDescriptorV4(descriptor),
      requestedTrustLevel: descriptor.requestedTrustLevel,
      policy: descriptor.policy,
    });
  } catch {
    throw invalidAutonomousSourceData();
  }
}

function reconstructStoredSourceFromOwnedData(sourceValue: unknown) {
  const sourceResult = storedEpisodicSourceSchema.safeParse(sourceValue);
  if (!sourceResult.success || !sameCanonicalAutomaticData(sourceValue, sourceResult.data)) {
    throw invalidAutonomousStoredSourceData();
  }
  const source = sourceResult.data;
  const attributes = source.attributes;
  const attributeNames = Object.keys(attributes);
  if (
    attributeNames.some(
      (key) =>
        RESERVED_STORED_SOURCE_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        key !== STORED_SOURCE_OWNER_ATTRIBUTE &&
        key !== STORED_SOURCE_ENVELOPE_ATTRIBUTE,
    ) ||
    !Object.prototype.hasOwnProperty.call(attributes, STORED_SOURCE_OWNER_ATTRIBUTE) ||
    !Object.prototype.hasOwnProperty.call(attributes, STORED_SOURCE_ENVELOPE_ATTRIBUTE)
  ) {
    throw invalidAutonomousStoredSourceData();
  }

  const ownerResult = AutonomousPersonalSourceOwnerV4OwnedDataSchema.safeParse(
    attributes[STORED_SOURCE_OWNER_ATTRIBUTE],
  );
  const envelopeResult = AutonomousPersonalSourceEnvelopeV3OwnedDataSchema.safeParse(
    attributes[STORED_SOURCE_ENVELOPE_ATTRIBUTE],
  );
  if (!ownerResult.success || !envelopeResult.success) {
    throw invalidAutonomousStoredSourceData();
  }
  const owner = ownerResult.data;
  const envelope = envelopeResult.data;
  if (
    !sameCanonicalAutomaticData(attributes[STORED_SOURCE_OWNER_ATTRIBUTE], owner) ||
    !sameCanonicalAutomaticData(attributes[STORED_SOURCE_ENVELOPE_ATTRIBUTE], envelope)
  ) {
    throw invalidAutonomousStoredSourceData();
  }

  const producerResult = producerInputSchema.safeParse({
    uuid: source.uuid,
    group_id: source.group_id,
    content: source.content,
    role: source.role,
    source_type: source.source_type,
    episode_kind: source.episode_kind,
    reference_time: source.reference_time,
    previous_episode_uuid: source.previous_episode_uuid,
    source_message_id: source.source_message_id,
    idempotency_key: source.idempotency_key,
    conversation_id: source.conversation_id,
    sender_id: source.sender_id,
    source_workflow_id: source.source_workflow_id,
    source_execution_id: source.source_execution_id,
    quoted_message_id: source.quoted_message_id,
    created_at: source.created_at,
  });
  if (!producerResult.success) throw invalidAutonomousStoredSourceData();

  let mapping: z.infer<typeof mappingInputSchema>;
  if (envelope.geometry.mode === 'full_body') {
    mapping = { mode: 'full_body' };
  } else {
    const humanRegion = envelope.geometry.humanRegion;
    const applicationWrapper = envelope.geometry.applicationWrapper;
    if (humanRegion === null || applicationWrapper === null) {
      throw invalidAutonomousStoredSourceData();
    }
    mapping = {
      mode: 'application_region',
      humanRegion,
      applicationWrapper,
    };
  }

  const policy = compileAutonomousPersonalPolicyV3({
    profileId: envelope.policyRef.profileId,
  });
  const assemblyInput = sourceTupleAssemblyInputSchema.parse({
    scope: {
      storeHash: owner.storeHash,
      namespace: owner.namespace,
      issuer: owner.issuer,
      actorReference: owner.actorReference,
      turn: owner.turn,
      binding: owner.binding,
    },
    producer: producerResult.data,
    eventTimeMode: owner.eventTimeMode,
    mapping,
    quoteRegions: envelope.geometry.quoteRegions,
    settingsHash: owner.settingsHash,
    descriptorHash: owner.descriptorHash,
    requestedTrustLevel: owner.requestedTrustLevel,
    policy,
  });
  const tuple = assembleAutonomousPersonalSourceTupleV4(assemblyInput);
  if (
    !sameCanonicalAutomaticData(owner, tuple.owner) ||
    !sameCanonicalAutomaticData(envelope, tuple.envelope)
  ) {
    throw invalidAutonomousStoredSourceData();
  }
  return { source, tuple, assemblyInput };
}

/** Reconstruct Source4 DATA from a stored row without descriptor-origin proof. */
export function reconstructAutonomousPersonalStoredSourceV4(
  sourceValue: unknown,
): AutonomousPersonalStoredSourceV4 {
  try {
    const sourceSnapshot = cloneBoundedAutomaticCaptureJson<unknown>(sourceValue, 'beginRequest');
    const reconstructed = reconstructStoredSourceFromOwnedData(sourceSnapshot);
    return deepFreeze(
      AutonomousPersonalStoredSourceV4OwnedDataSchema.parse({
        version: 4,
        descriptorValidation: 'opaque_only',
        source: reconstructed.source,
        tuple: reconstructed.tuple,
      }),
    );
  } catch {
    throw invalidAutonomousStoredSourceData();
  }
}

function recompileStoredDescriptor(descriptor: AutonomousPersonalDescriptorV4) {
  const provider = descriptor.provider;
  return compileAutonomousPersonalDescriptorV4({
    profileId: descriptor.policy.profileId,
    requestedTrustLevel: descriptor.requestedTrustLevel,
    intentSetting: descriptor.intentSetting,
    invocationDeadlineMs: descriptor.invocationDeadlineMs,
    providerReference: {
      routeId: provider.routeId,
      configurationFingerprint: provider.configurationFingerprint,
      protocol: provider.protocol,
      configuredRequestLimit: provider.configuredRequestLimit,
      configuredTimeoutMs: provider.configuredTimeoutMs,
      configuredRequestBytes: provider.configuredRequestBytes,
      configuredResponseBytes: provider.configuredResponseBytes,
      temperature: provider.temperature,
      responseFormat: provider.responseFormat,
      outputTokenLimit: provider.outputTokenLimit,
    },
    // Exact omission when absent: a legacy descriptor never gains a budget key. When present
    // the body is recompiled, so settings/descriptor hashes bind it and a changed body fails
    // the canonical comparison as a conflict instead of being rewritten.
    ...(descriptor.executionBudget === undefined
      ? {}
      : { executionBudget: descriptor.executionBudget }),
    // Same exact-omission rule: a legacy descriptor never gains a statementContext key.
    ...(descriptor.statementContext === undefined
      ? {}
      : { statementContext: descriptor.statementContext }),
  });
}

/** Reconstruct Source4 DATA with a matching compiled descriptor, still without authority. */
export function reconstructAutonomousPersonalStoredSourceIdentityV4(
  inputValue: unknown,
): AutonomousPersonalStoredSourceIdentityV4 {
  try {
    const inputSnapshot = cloneBoundedAutomaticCaptureJson<unknown>(inputValue, 'beginRequest');
    const checked = storedSourceIdentityInputSchema.parse(inputSnapshot);
    const reconstructed = reconstructStoredSourceFromOwnedData(checked.source);
    const descriptor = checked.descriptor;
    const recompiledDescriptor = recompileStoredDescriptor(descriptor);
    const descriptorHash = hashAutonomousPersonalDescriptorV4(descriptor);
    if (
      !sameCanonicalAutomaticData(descriptor, recompiledDescriptor) ||
      descriptorHash !== reconstructed.tuple.owner.descriptorHash ||
      descriptor.settingsHash !== reconstructed.tuple.owner.settingsHash ||
      descriptor.policy.fingerprint !== reconstructed.tuple.owner.policyFingerprint ||
      descriptor.requestedTrustLevel !== reconstructed.tuple.owner.requestedTrustLevel
    ) {
      throw invalidAutonomousStoredSourceData();
    }

    const descriptorAssemblyInput = sourceTupleAssemblyInputSchema.parse({
      ...reconstructed.assemblyInput,
      settingsHash: descriptor.settingsHash,
      descriptorHash,
      requestedTrustLevel: descriptor.requestedTrustLevel,
      policy: descriptor.policy,
    });
    const descriptorTuple = assembleAutonomousPersonalSourceTupleV4(descriptorAssemblyInput);
    if (!sameCanonicalAutomaticData(descriptorTuple, reconstructed.tuple)) {
      throw invalidAutonomousStoredSourceData();
    }

    return deepFreeze(
      AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema.parse({
        version: 4,
        descriptorValidation: 'compiled_descriptor',
        source: reconstructed.source,
        descriptor,
        tuple: descriptorTuple,
      }),
    );
  } catch {
    throw invalidAutonomousStoredSourceData();
  }
}
