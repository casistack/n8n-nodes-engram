import { z } from 'zod';
import {
  AutonomousPersonalDescriptorV4InputOwnedDataSchema,
  AutonomousPersonalDescriptorV4OwnedDataSchema,
} from './AutonomousPersonalDescriptorV4.schema';
import { AutonomousSourceGeometryInputV3OwnedDataSchema } from './AutonomousSourceGeometryV3.schema';
import { AutomaticBindingReferenceSchema } from './AutomaticMemory.schema';
import {
  AutonomousPersonalSourceProducerV4OwnedDataSchema,
  AutonomousPersonalSourceTupleV4OwnedDataSchema,
  type AutonomousPersonalSourceTupleV4Input,
} from './AutonomousPersonalSourceV4.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const HASH_64 = /^[a-f0-9]{64}$/u;
const UUID_SCHEMA = z.string().uuid();
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

function exactNonBlankText(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim().length > 0 && isWellFormedUnicode(value));
}

function nullableIdentifier(maxLength: number) {
  return exactNonBlankText(maxLength).nullable();
}

const hashSchema = z.string().regex(HASH_64);
const canonicalUtcMillisecondsSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });

const sourceContentSchema = z
  .string()
  .max(MAX_SOURCE_BYTES)
  .refine(
    (value) => isWellFormedUnicode(value) && Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_BYTES,
    'Source content must be well-formed Unicode within the UTF-8 byte limit',
  );

const eventTimeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('explicit'), value: canonicalUtcMillisecondsSchema }).strict(),
  z.object({ mode: z.literal('first_capture') }).strict(),
]);

const sourceRequestSchema = z
  .object({
    content: sourceContentSchema,
    sourceMessageId: nullableIdentifier(512),
    conversationId: nullableIdentifier(512),
    senderId: nullableIdentifier(512),
    sourceWorkflowId: nullableIdentifier(512),
    quotedMessageId: nullableIdentifier(512),
    sourceType: z.literal('message'),
    eventTime: eventTimeSchema,
    mapping: AutonomousSourceGeometryInputV3OwnedDataSchema.shape.mapping,
    quoteRegions: AutonomousSourceGeometryInputV3OwnedDataSchema.shape.quoteRegions,
  })
  .strict();

/** Strict, owned-only settings shape shared with the Descriptor4 request schema. */
export const AutonomousPersonalBeginV4SettingsOwnedDataSchema =
  AutonomousPersonalDescriptorV4InputOwnedDataSchema;

/** Strict request DATA. Raw callers must use parseAutonomousPersonalBeginV4Input. */
export const AutonomousPersonalBeginV4RequestOwnedDataSchema = z
  .object({
    version: z.literal(4),
    lifecycle: z.literal('replaySafeV2'),
    purpose: z.literal('human_turn_memory'),
    interpretationFamily: z.literal('autonomous-personal-v1'),
    namespace: exactNonBlankText(128),
    issuer: exactNonBlankText(256),
    actorReference: exactNonBlankText(512),
    turn: exactNonBlankText(512),
    settings: AutonomousPersonalBeginV4SettingsOwnedDataSchema,
    source: sourceRequestSchema,
  })
  .strict();

export type AutonomousPersonalBeginV4Request = z.infer<
  typeof AutonomousPersonalBeginV4RequestOwnedDataSchema
>;

/** Plain context DATA only; callers cannot use it to prove native origin or authority. */
export const AutonomousPersonalBeginV4ContextOwnedDataSchema = z
  .object({
    storeHash: hashSchema,
    namespace: exactNonBlankText(128),
    issuer: exactNonBlankText(256),
    actorReference: exactNonBlankText(512),
    turn: exactNonBlankText(512),
    binding: AutomaticBindingReferenceSchema,
    instance: exactNonBlankText(512),
    workflow: exactNonBlankText(512).nullable(),
    execution: exactNonBlankText(512),
  })
  .strict();

export type AutonomousPersonalBeginV4Context = z.infer<
  typeof AutonomousPersonalBeginV4ContextOwnedDataSchema
>;

/** Strict, already-owned input for the pure stable-request hash helper. */
export const AutonomousPersonalStableRequestV4InputOwnedDataSchema = z
  .object({
    request: AutonomousPersonalBeginV4RequestOwnedDataSchema,
    context: AutonomousPersonalBeginV4ContextOwnedDataSchema,
  })
  .strict();

export type AutonomousPersonalStableRequestV4Input = z.infer<
  typeof AutonomousPersonalStableRequestV4InputOwnedDataSchema
>;

/** Strict, already-owned input for the pure fresh-source DATA compiler. */
export const AutonomousPersonalFreshSourceV4InputOwnedDataSchema = z
  .object({
    request: AutonomousPersonalBeginV4RequestOwnedDataSchema,
    context: AutonomousPersonalBeginV4ContextOwnedDataSchema,
    sourceId: UUID_SCHEMA,
    previousEpisodeUuid: UUID_SCHEMA.nullable(),
    createdAt: canonicalUtcMillisecondsSchema,
  })
  .strict();

export type AutonomousPersonalFreshSourceV4Input = z.infer<
  typeof AutonomousPersonalFreshSourceV4InputOwnedDataSchema
>;

/** Frozen result DATA from the pure fresh-source compiler; it is not a graph row or operation. */
export const AutonomousPersonalFreshSourceV4OwnedDataSchema = z
  .object({
    version: z.literal(4),
    descriptor: AutonomousPersonalDescriptorV4OwnedDataSchema,
    producer: AutonomousPersonalSourceProducerV4OwnedDataSchema,
    tuple: AutonomousPersonalSourceTupleV4OwnedDataSchema,
  })
  .strict();

export type AutonomousPersonalFreshSourceV4 = z.infer<
  typeof AutonomousPersonalFreshSourceV4OwnedDataSchema
>;

export type AutonomousPersonalFreshSourceProducerV4 =
  AutonomousPersonalSourceTupleV4Input['producer'];

const outerInputOwnedDataSchema = z
  .object({
    mode: z.string().min(1).max(64),
    request: z.unknown(),
  })
  .strict();

const inputResultShape = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ready'),
      mode: z.literal('existingStore'),
      request: AutonomousPersonalBeginV4RequestOwnedDataSchema,
    })
    .strict(),
  z.object({ kind: z.literal('unsupported_mode') }).strict(),
  z.object({ kind: z.literal('invalid_input') }).strict(),
]);

export const AutonomousPersonalBeginV4InputResultOwnedDataSchema = inputResultShape;
export type AutonomousPersonalBeginV4InputResult = z.infer<
  typeof AutonomousPersonalBeginV4InputResultOwnedDataSchema
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function inputResult(value: unknown): AutonomousPersonalBeginV4InputResult {
  return deepFreeze(AutonomousPersonalBeginV4InputResultOwnedDataSchema.parse(value));
}

/**
 * Own the full outer input before property access or Zod. This only classifies
 * request DATA; it cannot establish storage initialization, native context, or authority.
 */
export function parseAutonomousPersonalBeginV4Input(
  input: unknown,
): AutonomousPersonalBeginV4InputResult {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    const wrapper = outerInputOwnedDataSchema.parse(owned);
    if (wrapper.mode !== 'existingStore') return inputResult({ kind: 'unsupported_mode' });
    const request = AutonomousPersonalBeginV4RequestOwnedDataSchema.parse(wrapper.request);
    return inputResult({ kind: 'ready', mode: 'existingStore', request });
  } catch {
    return inputResult({ kind: 'invalid_input' });
  }
}
