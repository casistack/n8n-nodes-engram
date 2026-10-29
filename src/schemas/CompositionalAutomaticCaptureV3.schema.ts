import { createHash } from 'crypto';
import { z } from 'zod';
import { isNativePlainAutomaticCaptureObject as isNativePlainObject } from '../storage/BoundedAutomaticCaptureJson';
import { CompositionalBundleDecisionCodeV3Schema } from './CompositionalBundleDecisionCodeV3.schema';
import { AutomaticBindingReferenceSchema } from './AutomaticMemory.schema';
import { EpisodicNodeSchema, type EpisodicNode } from './EpisodicNode.schema';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from './AutomaticLedgerPrimitives.schema';
import {
  AutomaticCaptureEventTimeV2Schema,
  AutomaticCaptureLifecycleV2Schema,
  AutomaticCaptureRegionV2Schema,
  AutomaticCaptureTrustLevelV2Schema,
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from './AutomaticCapture.schema';
import {
  COMPOSITIONAL_AUTOMATIC_LIMITS,
  CompositionalAutomaticClaimMeaningV2Schema,
  CompositionalAutomaticDescriptorInputV3Schema,
  CompositionalAutomaticDescriptorV3Schema,
  CompositionalAutomaticEnvelopeV2Schema,
  CompositionalAutomaticClaimMetadataV2Schema,
  compileCompositionalAutomaticDescriptorV3,
  hashCompositionalAutomaticDescriptorV3,
} from './CompositionalAutomaticMemory.schema';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import {
  CompositionalPreferenceV2BundleSchema,
  CompositionalPreferenceV2ReasonSchema,
  CompositionalPreferenceV2Schema,
  snapshotBoundedCompositionalJson,
  type CompositionalPreferenceV2,
} from './CompositionalPreferenceV2.schema';
import { compositionalAutomaticClaimKeyV2 } from './CompositionalAutomaticMemory.schema';

/**
 * Standalone contracts for the compositional capture family. These schemas do
 * not register the family in GraphData and do not grant storage or processing
 * authority. V1 literal and V2 literal schemas remain separate and unchanged.
 */
export const COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE = 'engram_write_owner_v3';
export const COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE = 'engram_source_envelope_v2';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const profile = z.enum(['conservative', 'explicit', 'reviewFirst']);
const timestamp = z.string().datetime();

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function domainHash(domain: string, value: unknown): string {
  return hashAutomaticCaptureV2({ domain, value });
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isUtf16Boundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return offset >= 0 && offset <= value.length;
  const before = value.charCodeAt(offset - 1);
  const after = value.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function readExactOwnDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isNativePlainObject(value)
  )
    return null;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string'))
      return null;
    const expected = new Set(keys);
    if (ownKeys.some((key) => !expected.has(key as string))) return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !('value' in property)) return null;
      output[key] = property.value;
    }
    return output;
  } catch {
    return null;
  }
}

const requestKeys = [
  'version',
  'lifecycle',
  'purpose',
  'preferenceInterpreter',
  'namespace',
  'issuer',
  'actorReference',
  'turn',
  'settings',
  'source',
  'attemptIdHash',
] as const;
const requestSourceKeys = [
  'content',
  'sourceMessageId',
  'conversationId',
  'senderId',
  'senderName',
  'sourceWorkflowId',
  'originalSourceExecutionId',
  'sourceType',
  'quotedMessageId',
  'eventTime',
  'applicationOwnedWrapper',
  'humanRegion',
  'quoteRegions',
] as const;

/** Copy request metadata safely while keeping the bounded 64 KiB body separate. */
function snapshotBeginRequestV3(value: unknown): unknown | undefined {
  const request = readExactOwnDataRecord(value, requestKeys);
  if (!request) return undefined;
  const source = readExactOwnDataRecord(request.source, requestSourceKeys);
  if (!source || typeof source.content !== 'string') return undefined;
  const content = source.content;
  if (
    content.length > COMPOSITIONAL_AUTOMATIC_LIMITS.sourceBytes ||
    !isWellFormedUnicode(content) ||
    Buffer.byteLength(content, 'utf8') > COMPOSITIONAL_AUTOMATIC_LIMITS.sourceBytes
  )
    return undefined;

  const sourceMetadata = Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== 'content'),
  );
  const metadata = { ...request, source: sourceMetadata };
  const snapshot = snapshotBoundedCompositionalJson(metadata, 16384);
  if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object') return undefined;
  const copied = snapshot as Record<string, unknown>;
  if (copied.source === null || typeof copied.source !== 'object' || Array.isArray(copied.source))
    return undefined;
  return {
    ...copied,
    source: { ...(copied.source as Record<string, unknown>), content },
  };
}

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .superRefine((value, context) => {
      if (value.length > max) return;
      if (value.trim().length === 0 || value.trim() !== value || !isWellFormedUnicode(value)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Value must be canonical text' });
      }
    });
const nullableIdentifier = (max = 512) => boundedText(max).nullable();

const sourceContent = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (value.length > COMPOSITIONAL_AUTOMATIC_LIMITS.sourceBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Raw source exceeds the UTF-16 limit',
      });
      return;
    }
    if (!isWellFormedUnicode(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Raw source is not well-formed Unicode',
      });
      return;
    }
    if (Buffer.byteLength(value, 'utf8') > COMPOSITIONAL_AUTOMATIC_LIMITS.sourceBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Raw source exceeds the UTF-8 limit',
      });
    }
  });

const sourceInputSchema = z
  .object({
    content: sourceContent,
    sourceMessageId: nullableIdentifier(),
    conversationId: nullableIdentifier(),
    senderId: nullableIdentifier(),
    senderName: nullableIdentifier(),
    sourceWorkflowId: nullableIdentifier(),
    originalSourceExecutionId: nullableIdentifier(),
    sourceType: z.literal('message'),
    quotedMessageId: nullableIdentifier(),
    eventTime: AutomaticCaptureEventTimeV2Schema,
    applicationOwnedWrapper: z.literal(true).nullable(),
    humanRegion: AutomaticCaptureRegionV2Schema.nullable(),
    quoteRegions: z.array(AutomaticCaptureRegionV2Schema).max(31),
  })
  .strict();

const requestBodySchema = z
  .object({
    version: z.literal(3),
    lifecycle: AutomaticCaptureLifecycleV2Schema,
    purpose: z.literal('human_turn_memory'),
    preferenceInterpreter: z.literal('compositionalV2'),
    namespace: CompositionalCaptureNamespaceV3Schema,
    issuer: boundedText(256),
    actorReference: boundedText(512),
    turn: boundedText(512),
    settings: z
      .object({
        profileId: profile,
        requestedTrustLevel: AutomaticCaptureTrustLevelV2Schema,
        intentSetting: z.boolean(),
        invocationDeadlineMs: z.number().int().min(100).max(120_000),
      })
      .strict(),
    source: sourceInputSchema,
    attemptIdHash: hash64,
  })
  .strict()
  .superRefine((request, context) => {
    const invalid = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const { source } = request;
    if (
      (source.applicationOwnedWrapper === null && source.humanRegion !== null) ||
      (source.applicationOwnedWrapper === true && source.humanRegion === null)
    ) {
      invalid(['source', 'humanRegion'], 'Wrapper attestation and human region must agree');
    }
    if (source.quoteRegions.length + 1 > 32) {
      invalid(['source', 'quoteRegions'], 'Envelope mapping and quotes exceed 32 spans');
    }
    const bodyStart = source.humanRegion?.start ?? 0;
    const bodyEnd = source.humanRegion?.end ?? source.content.length;
    if (bodyEnd > source.content.length) {
      invalid(['source', 'humanRegion'], 'Human region exceeds the raw source');
      return;
    }
    if (!isUtf16Boundary(source.content, bodyStart) || !isUtf16Boundary(source.content, bodyEnd)) {
      invalid(['source', 'humanRegion'], 'Human region splits a Unicode code point');
      return;
    }
    const body = source.content.slice(bodyStart, bodyEnd);
    for (const [index, quote] of source.quoteRegions.entries()) {
      if (quote.end > body.length) {
        invalid(['source', 'quoteRegions', index], 'Quote region exceeds mapped human content');
      } else if (!isUtf16Boundary(body, quote.start) || !isUtf16Boundary(body, quote.end)) {
        invalid(['source', 'quoteRegions', index], 'Quote region splits a Unicode code point');
      }
      if (index > 0 && quote.start < source.quoteRegions[index - 1].end) {
        invalid(['source', 'quoteRegions', index], 'Quote regions must be ordered and disjoint');
      }
    }
  });

/** Caller producer/settings input only. No caller policy, binding, store or persisted IDs. */
export const CompositionalAutomaticCaptureBeginRequestV3Schema = z.preprocess(
  snapshotBeginRequestV3,
  requestBodySchema,
);
export type CompositionalAutomaticCaptureBeginRequestV3Input = z.input<typeof requestBodySchema>;
export type CompositionalAutomaticCaptureBeginRequestV3 = z.infer<
  typeof CompositionalAutomaticCaptureBeginRequestV3Schema
>;

export const CompositionalAutomaticDescriptorBuildResultV3Schema = z
  .object({ descriptor: CompositionalAutomaticDescriptorV3Schema, descriptorHash: hash64 })
  .strict()
  .superRefine((result, context) => {
    if (result.descriptorHash !== hashCompositionalAutomaticDescriptorV3(result.descriptor)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['descriptorHash'],
        message: 'Descriptor hash mismatch',
      });
    }
  });
export type CompositionalAutomaticDescriptorBuildResultV3 = z.infer<
  typeof CompositionalAutomaticDescriptorBuildResultV3Schema
>;

/** Compile only the closed request settings; this does not mint a capability. */
export function buildCompositionalAutomaticDescriptorForRequestV3(
  requestValue: CompositionalAutomaticCaptureBeginRequestV3,
): CompositionalAutomaticDescriptorBuildResultV3 {
  const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse(requestValue);
  const descriptor = compileCompositionalAutomaticDescriptorV3(
    CompositionalAutomaticDescriptorInputV3Schema.parse({
      profileId: request.settings.profileId,
      requestedTrustLevel: request.settings.requestedTrustLevel,
      intentSetting: request.settings.intentSetting,
      invocationDeadlineMs: request.settings.invocationDeadlineMs,
    }),
  );
  return CompositionalAutomaticDescriptorBuildResultV3Schema.parse({
    descriptor,
    descriptorHash: hashCompositionalAutomaticDescriptorV3(descriptor),
  });
}

const captureEnvelopeWrapperBodySchema = z
  .object({
    version: z.literal(2),
    sourceEnvelope: CompositionalAutomaticEnvelopeV2Schema,
    settingsHash: hash64,
    descriptorHash: hash64,
  })
  .strict();

/** Operational envelope adds descriptor binding without changing the standalone V2 envelope. */
export const CompositionalAutomaticCaptureSourceEnvelopeV2Schema = z
  .preprocess(
    (value) => snapshotBoundedCompositionalJson(value, 16384),
    captureEnvelopeWrapperBodySchema,
  )
  .superRefine((wrapper, context) => {
    if (
      Buffer.byteLength(JSON.stringify(wrapper), 'utf8') >
      COMPOSITIONAL_AUTOMATIC_LIMITS.envelopeBytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Stored V2 envelope exceeds 16 KiB',
      });
    }
  });
export type CompositionalAutomaticCaptureSourceEnvelopeV2 = z.infer<
  typeof CompositionalAutomaticCaptureSourceEnvelopeV2Schema
>;

const sourceOwnerV3BodySchema = z
  .object({
    version: z.literal(3),
    lifecycle: AutomaticCaptureLifecycleV2Schema,
    purpose: z.literal('human_turn_memory'),
    role: z.literal('human'),
    storeHash: hash64,
    namespace: CompositionalCaptureNamespaceV3Schema,
    turn: boundedText(512),
    issuer: boundedText(256),
    actorReference: boundedText(512),
    binding: AutomaticBindingReferenceSchema,
    eventTimeMode: z.enum(['explicit', 'first_capture']),
    eventTimeHash: hash64,
    stableProducerHash: hash64,
    sourceContentHash: hash64,
    settingsHash: hash64,
    descriptorHash: hash64,
    policyFingerprint: hash64,
    requestedTrustLevel: AutomaticCaptureTrustLevelV2Schema,
    intentSetting: z.boolean(),
    intentEvidence: z.boolean(),
  })
  .strict();

export const CompositionalAutomaticCaptureSourceOwnerV3Schema = z
  .preprocess((value) => snapshotBoundedCompositionalJson(value, 16384), sourceOwnerV3BodySchema)
  .superRefine((owner, context) => {
    if (
      Buffer.byteLength(JSON.stringify(owner), 'utf8') >
      COMPOSITIONAL_AUTOMATIC_LIMITS.descriptorBytes
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'V3 owner exceeds 4 KiB' });
    }
  });
export type CompositionalAutomaticCaptureSourceOwnerV3 = z.infer<
  typeof CompositionalAutomaticCaptureSourceOwnerV3Schema
>;

export const CompositionalAutomaticCaptureOwnedSourceV3Schema = z
  .object({
    owner: CompositionalAutomaticCaptureSourceOwnerV3Schema,
    envelope: CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
    descriptor: CompositionalAutomaticDescriptorV3Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { owner, envelope, descriptor } = value;
    const sourceEnvelope = envelope.sourceEnvelope;
    const descriptorHash = hashCompositionalAutomaticDescriptorV3(descriptor);
    if (
      owner.settingsHash !== descriptor.settingsHash ||
      owner.settingsHash !== envelope.settingsHash ||
      owner.descriptorHash !== descriptorHash ||
      owner.descriptorHash !== envelope.descriptorHash ||
      owner.policyFingerprint !== descriptor.policy.fingerprint ||
      owner.policyFingerprint !== sourceEnvelope.policy.fingerprint ||
      owner.requestedTrustLevel !== descriptor.requestedTrustLevel ||
      owner.intentSetting !== descriptor.intentSetting ||
      owner.intentEvidence !== sourceEnvelope.explicitIntent ||
      owner.namespace !== sourceEnvelope.namespace ||
      owner.issuer !== sourceEnvelope.issuer ||
      owner.actorReference !== sourceEnvelope.actorReference ||
      owner.sourceContentHash !== sourceEnvelope.rawContentHash ||
      canonicalAutomaticCaptureV2(owner.binding) !==
        canonicalAutomaticCaptureV2(sourceEnvelope.bindingRef)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'V3 owner, envelope and descriptor disagree',
      });
    }
    if (owner.intentSetting && !owner.intentEvidence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owner', 'intentEvidence'],
        message: 'Configured intent requires captured intent evidence',
      });
    }
  });
export type CompositionalAutomaticCaptureOwnedSourceV3 = z.infer<
  typeof CompositionalAutomaticCaptureOwnedSourceV3Schema
>;

export const CompositionalAutomaticOperationIdentityV3Schema = z
  .object({
    version: z.literal(3),
    lifecycle: AutomaticCaptureLifecycleV2Schema,
    storeHash: hash64,
    namespace: CompositionalCaptureNamespaceV3Schema,
    issuer: boundedText(256),
    actorReference: boundedText(512),
    turn: boundedText(512),
    role: z.literal('human'),
    purpose: z.literal('human_turn_memory'),
    binding: AutomaticBindingReferenceSchema,
    sourceId: uuid,
    sourceContentHash: hash64,
    sourceHash: hash64,
    originalProducerHash: hash64,
    stableProducerHash: hash64,
    eventTimeMode: z.enum(['explicit', 'first_capture']),
    eventTimeHash: hash64,
    settingsHash: hash64,
    requestedAuthorityHash: hash64,
    descriptorHash: hash64,
    policyFingerprint: hash64,
  })
  .strict()
  .superRefine((identity, context) => {
    const authority = {
      lifecycle: identity.lifecycle,
      storeHash: identity.storeHash,
      namespace: identity.namespace,
      issuer: identity.issuer,
      actorReference: identity.actorReference,
      turn: identity.turn,
      role: identity.role,
      purpose: identity.purpose,
      sourceId: identity.sourceId,
      sourceContentHash: identity.sourceContentHash,
      stableProducerHash: identity.stableProducerHash,
      eventTimeMode: identity.eventTimeMode,
      eventTimeHash: identity.eventTimeHash,
      settingsHash: identity.settingsHash,
      descriptorHash: identity.descriptorHash,
      policyFingerprint: identity.policyFingerprint,
      binding: identity.binding,
    };
    if (
      identity.requestedAuthorityHash !== compositionalCaptureRequestedAuthorityHashV3(authority)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedAuthorityHash'],
        message: 'Requested authority hash mismatch',
      });
    }
  });
export type CompositionalAutomaticOperationIdentityV3 = z.infer<
  typeof CompositionalAutomaticOperationIdentityV3Schema
>;

const stableProducerFieldsV3Schema = z
  .object({
    source_workflow_id: nullableIdentifier(),
    source_message_id: nullableIdentifier(),
    conversation_id: nullableIdentifier(),
    sender_id: nullableIdentifier(),
    source_type: z.literal('message'),
    episode_kind: z.literal('active_human'),
    quoted_message_id: nullableIdentifier(),
  })
  .strict();
export type CompositionalAutomaticStableProducerFieldsV3 = z.infer<
  typeof stableProducerFieldsV3Schema
>;

export function compositionalCaptureStableProducerHashV3(
  value: CompositionalAutomaticStableProducerFieldsV3,
): string {
  const checked = stableProducerFieldsV3Schema.parse(value);
  return domainHash('engram-compositional-producer-v3', checked);
}

export function compositionalCaptureSourceContentHashV3(rawContent: string): string {
  if (
    rawContent.length > COMPOSITIONAL_AUTOMATIC_LIMITS.sourceBytes ||
    !isWellFormedUnicode(rawContent) ||
    Buffer.byteLength(rawContent, 'utf8') > COMPOSITIONAL_AUTOMATIC_LIMITS.sourceBytes
  ) {
    throw new Error('Engram compositional capture: invalid source content');
  }
  return sha256(rawContent);
}

export function compositionalCaptureEventTimeHashV3(
  mode: 'explicit' | 'first_capture',
  storedReferenceTime: string,
): string {
  const checked = timestamp.parse(storedReferenceTime);
  const epoch = Date.parse(checked);
  if (!Number.isFinite(epoch)) throw new Error('Engram compositional capture: invalid event time');
  return domainHash('engram-compositional-event-time-v3', {
    mode,
    normalizedReferenceTime: new Date(epoch).toISOString(),
  });
}

const immutableProducerProvenanceV3Schema = z
  .object({
    uuid,
    group_id: CompositionalCaptureNamespaceV3Schema,
    content: sourceContent,
    role: z.literal('human'),
    source_type: z.literal('message'),
    episode_kind: z.literal('active_human'),
    reference_time: timestamp,
    previous_episode_uuid: uuid.nullable(),
    source_message_id: nullableIdentifier(),
    idempotency_key: nullableIdentifier(),
    conversation_id: nullableIdentifier(),
    sender_id: nullableIdentifier(),
    source_workflow_id: nullableIdentifier(),
    source_execution_id: nullableIdentifier(),
    quoted_message_id: nullableIdentifier(),
    created_at: timestamp,
  })
  .strict();

export function compositionalCaptureOriginalProducerHashV3(
  ownerValue: CompositionalAutomaticCaptureSourceOwnerV3,
  envelopeValue: CompositionalAutomaticCaptureSourceEnvelopeV2,
  provenanceValue: z.input<typeof immutableProducerProvenanceV3Schema>,
): string {
  const owner = CompositionalAutomaticCaptureSourceOwnerV3Schema.parse(ownerValue);
  const envelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(envelopeValue);
  const producerProvenance = immutableProducerProvenanceV3Schema.parse(provenanceValue);
  return domainHash('engram-compositional-original-producer-v3', {
    owner,
    envelope,
    producerProvenance,
  });
}

export function compositionalCaptureSourceHashV3(value: EpisodicNode): string {
  const episode = EpisodicNodeSchema.parse(value);
  const attributes = { ...episode.attributes };
  delete attributes.engram_extraction_queue_v1;
  const sourceFields = Object.fromEntries(
    Object.entries({ ...episode, attributes }).filter(([key]) => key !== 'updated_at'),
  );
  return domainHash('engram-compositional-source-v3', sourceFields);
}

const authorityFieldsV3Schema = z
  .object({
    lifecycle: AutomaticCaptureLifecycleV2Schema,
    storeHash: hash64,
    namespace: CompositionalCaptureNamespaceV3Schema,
    issuer: boundedText(256),
    actorReference: boundedText(512),
    turn: boundedText(512),
    role: z.literal('human'),
    purpose: z.literal('human_turn_memory'),
    sourceId: uuid,
    sourceContentHash: hash64,
    stableProducerHash: hash64,
    eventTimeMode: z.enum(['explicit', 'first_capture']),
    eventTimeHash: hash64,
    settingsHash: hash64,
    descriptorHash: hash64,
    policyFingerprint: hash64,
    binding: AutomaticBindingReferenceSchema,
  })
  .strict();

export function compositionalCaptureRequestedAuthorityHashV3(value: unknown): string {
  const checked = authorityFieldsV3Schema.parse(value);
  return domainHash('engram-compositional-authority-v3', checked);
}

export function compositionalCaptureOperationIdentityHashV3(value: unknown): string {
  const identity = CompositionalAutomaticOperationIdentityV3Schema.parse(value);
  return domainHash('engram-compositional-operation-identity-v3', identity);
}

/** Preserve the originally captured source fingerprint across mutable review changes. */
export function reconcileCompositionalCaptureOperationIdentityV3(
  observedValue: CompositionalAutomaticOperationIdentityV3,
  capturedValue: CompositionalAutomaticOperationIdentityV3,
): CompositionalAutomaticOperationIdentityV3 | null {
  const observed = CompositionalAutomaticOperationIdentityV3Schema.parse(observedValue);
  const captured = CompositionalAutomaticOperationIdentityV3Schema.parse(capturedValue);
  const omitSourceHash = (value: CompositionalAutomaticOperationIdentityV3) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'sourceHash'));
  if (
    canonicalAutomaticCaptureV2(omitSourceHash(observed)) !==
    canonicalAutomaticCaptureV2(omitSourceHash(captured))
  )
    return null;
  return CompositionalAutomaticOperationIdentityV3Schema.parse({
    ...observed,
    sourceHash: captured.sourceHash,
  });
}

export const CompositionalAutomaticBundleOutcomeV3Schema = z.enum([
  'accepted',
  'unchanged',
  'proposed',
  'rejected',
  'deferred',
  'not_selected',
]);
export type CompositionalAutomaticBundleOutcomeV3 = z.infer<
  typeof CompositionalAutomaticBundleOutcomeV3Schema
>;

const predicateDependencyV3Schema = z
  .object({ predicateIndex: z.number().int().min(0).max(31), dependencyHash: hash64 })
  .strict();

const bundleReceiptItemV3Schema = z
  .object({
    bundleIndex: z.number().int().min(0).max(31),
    bundleHash: hash64,
    meaningHash: hash64,
    state: CompositionalAutomaticBundleOutcomeV3Schema,
    persisted: z.boolean(),
    mutation: z.enum(['created', 'none']),
    reason: CompositionalBundleDecisionCodeV3Schema.optional(),
    claimId: uuid.optional(),
    predicateDependencies: z.array(predicateDependencyV3Schema).min(1).max(32),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.reason !== undefined) {
      const expected =
        item.state === 'accepted'
          ? ['eligible_create']
          : item.state === 'unchanged'
            ? ['existing_accepted']
            : item.state === 'proposed'
              ? [item.mutation === 'created' ? 'profile_review_required' : 'existing_proposed']
              : item.state === 'rejected'
                ? ['existing_rejected']
                : item.state === 'not_selected'
                  ? [
                      'explicit_intent_required',
                      'existing_ineligible',
                      'legacy_reuse_not_authorized',
                      'possible_overlap',
                      'unknown_overlap_domain',
                    ]
                  : [];
      if (!expected.includes(item.reason))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'Reason disagrees with bundle outcome',
        });
      if (
        ['existing_accepted', 'existing_proposed', 'existing_rejected'].includes(item.reason) &&
        (!item.persisted || !item.claimId || item.mutation !== 'none')
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'Existing reason requires an unchanged persisted claim',
        });
    }
    const acceptedState = item.state === 'accepted' || item.state === 'unchanged';
    if ((item.persisted && !item.claimId) || (!item.persisted && item.claimId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claimId'],
        message: 'Claim ID must match persistence',
      });
    }
    if (acceptedState && !item.persisted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['persisted'],
        message: 'Accepted bundle requires persisted claim evidence',
      });
    }
    if (item.mutation === 'created' && (!item.persisted || !item.claimId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mutation'],
        message: 'Created mutation requires a persisted claim ID',
      });
    }
    if (
      (item.state === 'accepted' && item.mutation !== 'created') ||
      (item.state === 'unchanged' && item.mutation !== 'none') ||
      (['deferred', 'not_selected'].includes(item.state) &&
        (item.persisted || item.mutation !== 'none'))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Bundle state and mutation do not agree',
      });
    }
    const indexes = item.predicateDependencies.map((dependency) => dependency.predicateIndex);
    if (indexes.some((index, position) => index !== position)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['predicateDependencies'],
        message: 'Predicate indexes must be contiguous and ordered',
      });
    }
  });
export type CompositionalAutomaticBundleReceiptItemV3 = z.infer<typeof bundleReceiptItemV3Schema>;

const sourceVerdictV3Schema = z
  .object({
    kind: z.literal('source_verdict'),
    verdict: z.enum(['no_supported_preference_detected', 'unsupported_preference_meaning']),
    interpreterResultHash: hash64,
  })
  .strict();

const bundleSelectionV3Schema = z
  .object({
    kind: z.literal('bundles'),
    items: z.array(bundleReceiptItemV3Schema).min(1).max(32),
  })
  .strict();

const committedReceiptCommonV3 = {
  version: z.literal(3),
  kind: z.literal('human_compositional_capture_committed'),
  operationId: uuid,
  sourceId: uuid,
  sourceHash: hash64,
  descriptorHash: hash64,
  policyFingerprint: hash64,
  terminalAt: timestamp,
  reasons: z.array(CompositionalPreferenceV2ReasonSchema).max(16),
  acceptedCoverage: z.enum(['all', 'partial', 'none']),
};

const nonterminalSourceReasonsV3 = new Set([
  'invalid_envelope',
  'content_mismatch',
  'incomplete_mapping',
  'too_many_bundles',
  'too_many_nodes',
  'nesting_exceeded',
  'object_too_long',
  'clause_too_long',
  'source_too_large',
  'metadata_too_large',
  'invalid_unicode',
  'invalid_ast_integrity',
]);

const committedBundlesReceiptV3Schema = z
  .object({
    ...committedReceiptCommonV3,
    interpretationCoverage: z.literal('complete'),
    selection: bundleSelectionV3Schema,
  })
  .strict();

const committedSourceVerdictReceiptV3Schema = z
  .object({
    ...committedReceiptCommonV3,
    kind: z.literal('human_compositional_source_verdict_committed'),
    interpretationCoverage: z.enum(['none', 'unknown']),
    selection: sourceVerdictV3Schema,
  })
  .strict();

const cancelledReceiptV3Schema = z
  .object({
    version: z.literal(3),
    kind: z.literal('cancelled'),
    operationId: uuid,
    sourceId: uuid,
    sourceHash: hash64,
    descriptorHash: hash64,
    policyFingerprint: hash64,
    terminalAt: timestamp,
    acceptedCoverage: z.literal('none'),
  })
  .strict();

const receiptVariantsV3Schema = z.discriminatedUnion('kind', [
  committedBundlesReceiptV3Schema,
  committedSourceVerdictReceiptV3Schema,
  cancelledReceiptV3Schema,
]);

function preflightReceiptV3(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isNativePlainObject(value)
  )
    return null;
  const version = Object.getOwnPropertyDescriptor(value, 'version');
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!version || !('value' in version) || version.value !== 3) return null;
  if (!kind || !('value' in kind) || typeof kind.value !== 'string') return null;
  if (kind.value === 'cancelled') return snapshotBoundedCompositionalJson(value, 16384);
  const reasonsProperty = Object.getOwnPropertyDescriptor(value, 'reasons');
  const selectionProperty = Object.getOwnPropertyDescriptor(value, 'selection');
  if (
    !reasonsProperty ||
    !('value' in reasonsProperty) ||
    !Array.isArray(reasonsProperty.value) ||
    reasonsProperty.value.length > 16 ||
    !selectionProperty ||
    !('value' in selectionProperty) ||
    selectionProperty.value === null ||
    typeof selectionProperty.value !== 'object' ||
    Array.isArray(selectionProperty.value) ||
    !isNativePlainObject(selectionProperty.value)
  )
    return null;
  const selectionKind = Object.getOwnPropertyDescriptor(selectionProperty.value, 'kind');
  if (!selectionKind || !('value' in selectionKind)) return null;
  if (selectionKind.value === 'bundles') {
    const items = Object.getOwnPropertyDescriptor(selectionProperty.value, 'items');
    if (!items || !('value' in items) || !Array.isArray(items.value) || items.value.length > 32)
      return null;
    let dependencies = 0;
    for (const item of items.value) {
      if (
        item === null ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        !isNativePlainObject(item)
      )
        return null;
      const dep = Object.getOwnPropertyDescriptor(item, 'predicateDependencies');
      if (!dep || !('value' in dep) || !Array.isArray(dep.value)) return null;
      dependencies += dep.value.length;
      if (dependencies > 32) return null;
    }
  } else if (selectionKind.value !== 'source_verdict') return null;
  return snapshotBoundedCompositionalJson(value, 16384);
}

/** Structural receipt evidence only. The actual interpreter witness is private to a future runtime. */
export const CompositionalAutomaticCaptureTerminalReceiptV3Schema = z
  .preprocess(preflightReceiptV3, receiptVariantsV3Schema)
  .superRefine((receipt, context) => {
    if (
      Buffer.byteLength(JSON.stringify(receipt), 'utf8') >
      AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'V3 terminal receipt exceeds 16 KiB',
      });
    }
    if (receipt.kind === 'cancelled') return;
    if (receipt.selection.kind === 'source_verdict') {
      const expectedCoverage =
        receipt.selection.verdict === 'no_supported_preference_detected' ? 'none' : 'unknown';
      const ambiguousUnknownReasons =
        receipt.selection.verdict === 'unsupported_preference_meaning'
          ? new Set(['quoted_content', 'question'])
          : new Set<string>();
      if (
        receipt.interpretationCoverage !== expectedCoverage ||
        receipt.acceptedCoverage !== 'none'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selection'],
          message: 'Source verdict and coverage do not agree',
        });
      }
      if (
        receipt.reasons.some(
          (reason) => nonterminalSourceReasonsV3.has(reason) || ambiguousUnknownReasons.has(reason),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reasons'],
          message: 'Source verdict includes a nonterminal or ambiguous reason',
        });
      }
      return;
    }
    if (receipt.selection.kind !== 'bundles') return;

    const items = receipt.selection.items;
    if (items.some((item, index) => item.bundleIndex !== index)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection', 'items'],
        message: 'Bundle indexes must be contiguous and ordered',
      });
    }
    if (
      receipt.reasons.some((reason) => nonterminalSourceReasonsV3.has(reason)) ||
      items.some((item) => item.state === 'deferred')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection'],
        message: 'Committed bundle receipt contains nonterminal evidence',
      });
    }
    const dependencyCount = items.reduce(
      (total, item) => total + item.predicateDependencies.length,
      0,
    );
    if (dependencyCount > COMPOSITIONAL_AUTOMATIC_LIMITS.predicates) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selection', 'items'],
        message: 'Receipt exceeds the global predicate limit',
      });
    }
    const claimMeaning = new Map<string, string>();
    const semanticItems = new Map<string, Array<CompositionalAutomaticBundleReceiptItemV3>>();
    for (const item of items) {
      semanticItems.set(item.meaningHash, [...(semanticItems.get(item.meaningHash) ?? []), item]);
      if (item.claimId) {
        const priorMeaning = claimMeaning.get(item.claimId);
        if (priorMeaning !== undefined && priorMeaning !== item.meaningHash) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['selection', 'items'],
            message: 'One claim cannot link different meanings',
          });
        }
        claimMeaning.set(item.claimId, item.meaningHash);
      }
    }
    for (const duplicateItems of semanticItems.values()) {
      if (duplicateItems.length < 2) continue;
      const claimIds = new Set(duplicateItems.map((item) => item.claimId));
      const created = duplicateItems.filter((item) => item.mutation === 'created');
      const unselected = duplicateItems.every(
        (item) =>
          item.state === 'not_selected' &&
          !item.persisted &&
          item.claimId === undefined &&
          item.mutation === 'none',
      );
      const persisted =
        claimIds.size === 1 &&
        duplicateItems.every((item) => item.persisted && item.claimId !== undefined) &&
        created.length <= 1;
      const accepted = duplicateItems.every(
        (item) => item.state === (item.mutation === 'created' ? 'accepted' : 'unchanged'),
      );
      const review = duplicateItems[0].state;
      const uniformReview =
        (review === 'proposed' || review === 'rejected') &&
        duplicateItems.every((item) => item.state === review);
      if (!unselected && !(persisted && (accepted || uniformReview))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selection', 'items'],
          message:
            'Duplicate semantic bundles must retain one uniform review/claim or be uniformly not selected',
        });
      }
    }

    const accepted = items.filter(
      (item) => item.persisted && (item.state === 'accepted' || item.state === 'unchanged'),
    ).length;
    const expectedCoverage =
      accepted === 0 ? 'none' : accepted === items.length ? 'all' : 'partial';
    if (receipt.acceptedCoverage !== expectedCoverage) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptedCoverage'],
        message: 'Accepted coverage must follow durable bundle states',
      });
    }
  });
export type CompositionalAutomaticCaptureTerminalReceiptV3 = z.infer<
  typeof CompositionalAutomaticCaptureTerminalReceiptV3Schema
>;

export const CompositionalAutomaticPredicateDependencyV3Schema = predicateDependencyV3Schema;

const predicatePathV3Schema = z
  .string()
  .max(128)
  .regex(
    /^p(?:0|[1-9][0-9]{0,1})(?:\.(?:target|modifier|language|presentation|ordering|first|second|language_use|qualifier|count|quantifier|frequency|condition|scope|included|format|quality|emoji|characteristic))*$/,
  );

export function compositionalCaptureBundleHashV3(value: unknown): string {
  return domainHash(
    'engram-compositional-bundle-v3',
    CompositionalPreferenceV2BundleSchema.parse(value),
  );
}

export function compositionalCaptureMeaningHashV3(value: unknown): string {
  return domainHash(
    'engram-compositional-meaning-v3',
    CompositionalAutomaticClaimMeaningV2Schema.parse(value),
  );
}

export function compositionalCapturePredicateDependencyHashV3(
  meaningHash: string,
  predicateIndex: number,
  predicatePath: string,
): string {
  const checkedHash = hash64.parse(meaningHash);
  const checkedIndex = z.number().int().min(0).max(31).parse(predicateIndex);
  const checkedPath = predicatePathV3Schema.parse(predicatePath);
  return domainHash('engram-compositional-predicate-dependency-v3', {
    meaningHash: checkedHash,
    predicateIndex: checkedIndex,
    predicatePath: checkedPath,
  });
}

/** Exact complete predicate dependency commitments reconstructed from one-bundle meaning. */
export function compositionalCapturePredicateDependenciesV3(
  meaningValue: unknown,
): Array<{ predicateIndex: number; dependencyHash: string }> {
  const meaning = CompositionalAutomaticClaimMeaningV2Schema.parse(meaningValue);
  if (meaning.bundles.length !== 1)
    throw new Error('Engram compositional capture: expected one bundle');
  const bundle = meaning.bundles[0];
  const paths = [...bundle.rootPaths];
  const meaningHash = compositionalCaptureMeaningHashV3(meaning);
  return paths.map((predicatePath, predicateIndex) => ({
    predicateIndex,
    dependencyHash: compositionalCapturePredicateDependencyHashV3(
      meaningHash,
      predicateIndex,
      predicatePath,
    ),
  }));
}

export function compositionalCaptureInterpreterResultHashV3(
  sourceId: string,
  sourceHash: string,
  descriptorHash: string,
  resultValue: CompositionalPreferenceV2,
): string {
  const result = CompositionalPreferenceV2Schema.parse(resultValue);
  return domainHash('engram-compositional-source-verdict-v3', {
    sourceId: uuid.parse(sourceId),
    sourceHash: hash64.parse(sourceHash),
    descriptorHash: hash64.parse(descriptorHash),
    result,
  });
}

const operationGeneration = z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration);
const leaseSchema = z
  .object({
    token: uuid,
    acquiredAt: timestamp,
    renewedAt: timestamp,
    expiresAt: timestamp,
    claimKind: z.enum(['initial', 'resume']),
  })
  .strict();
const operationCommonV3 = {
  version: z.literal(3),
  operationId: uuid,
  identity: CompositionalAutomaticOperationIdentityV3Schema,
  descriptor: CompositionalAutomaticDescriptorV3Schema,
  createdAt: timestamp,
  lastObservedAt: timestamp,
  attempts: z
    .array(AutomaticOperationAttemptSchema)
    .max(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation),
  overflowCount: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.overflowCounterMax),
  auditTruncated: z.boolean().optional(),
  lastResumeCause: z.enum(['lease_expired', 'failed', 'interrupted']).optional(),
  beginCallHash: hash64,
  retryCount: z.number().int().min(0).max(3),
  lastRetryCallHash: hash64.optional(),
};

const operationVariantsV3Schema = z.discriminatedUnion('state', [
  z
    .object({ ...operationCommonV3, state: z.literal('captured'), generation: z.literal(0) })
    .strict(),
  z
    .object({
      ...operationCommonV3,
      state: z.literal('leased'),
      generation: operationGeneration,
      lease: leaseSchema,
    })
    .strict(),
  z
    .object({
      ...operationCommonV3,
      state: z.literal('failed'),
      generation: operationGeneration,
      failedAt: timestamp,
      failureCode: z.enum([
        'graph_conflict',
        'invalid_plan',
        'storage_error',
        'budget_exhausted',
        'capacity',
        'unknown',
      ]),
    })
    .strict(),
  z
    .object({
      ...operationCommonV3,
      state: z.literal('interrupted'),
      generation: operationGeneration,
      interruptedAt: timestamp,
      failureCode: z.enum(['invocation_interrupted', 'lease_expired', 'storage_error', 'unknown']),
    })
    .strict(),
  z
    .object({
      ...operationCommonV3,
      state: z.literal('committed'),
      generation: operationGeneration,
      terminalReceipt: CompositionalAutomaticCaptureTerminalReceiptV3Schema,
      completionCallHash: hash64,
    })
    .strict(),
  z
    .object({
      ...operationCommonV3,
      state: z.literal('cancelled'),
      generation: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
      terminalReceipt: CompositionalAutomaticCaptureTerminalReceiptV3Schema,
    })
    .strict(),
]);

function preflightOperationV3(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isNativePlainObject(value)
  )
    return null;
  const read = (key: string) => Object.getOwnPropertyDescriptor(value, key);
  const version = read('version');
  const state = read('state');
  const identity = read('identity');
  const descriptor = read('descriptor');
  if (
    !version ||
    !('value' in version) ||
    version.value !== 3 ||
    !state ||
    !('value' in state) ||
    typeof state.value !== 'string' ||
    !identity ||
    !('value' in identity) ||
    identity.value === null ||
    typeof identity.value !== 'object' ||
    Array.isArray(identity.value) ||
    !isNativePlainObject(identity.value) ||
    !descriptor ||
    !('value' in descriptor) ||
    descriptor.value === null ||
    typeof descriptor.value !== 'object' ||
    Array.isArray(descriptor.value) ||
    !isNativePlainObject(descriptor.value)
  )
    return null;
  const identityVersion = Object.getOwnPropertyDescriptor(identity.value, 'version');
  const descriptorVersion = Object.getOwnPropertyDescriptor(descriptor.value, 'version');
  if (
    !identityVersion ||
    !('value' in identityVersion) ||
    identityVersion.value !== 3 ||
    !descriptorVersion ||
    !('value' in descriptorVersion) ||
    descriptorVersion.value !== 3
  )
    return null;
  const attempts = read('attempts');
  if (
    !attempts ||
    !('value' in attempts) ||
    !Array.isArray(attempts.value) ||
    attempts.value.length > AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation
  )
    return null;
  if (state.value === 'committed' || state.value === 'cancelled') {
    const terminal = read('terminalReceipt');
    if (!terminal || !('value' in terminal)) return null;
    const bounded = preflightReceiptV3(terminal.value);
    if (bounded === null) return null;
  }
  return snapshotBoundedCompositionalJson(value, 32768);
}

/** Strict human-only V3 state record; it does not grant a handle or current authority. */
export const CompositionalAutomaticCaptureOperationV3Schema = z
  .preprocess(preflightOperationV3, operationVariantsV3Schema)
  .superRefine((operation, context) => {
    const invalid = (message: string, path?: Array<string | number>) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const createdAt = Date.parse(operation.createdAt);
    const lastObservedAt = Date.parse(operation.lastObservedAt);
    const descriptorHash = hashCompositionalAutomaticDescriptorV3(operation.descriptor);
    if (createdAt > lastObservedAt)
      invalid('Observation cannot precede creation', ['lastObservedAt']);
    if (
      operation.identity.descriptorHash !== descriptorHash ||
      operation.identity.policyFingerprint !== operation.descriptor.policy.fingerprint ||
      operation.identity.settingsHash !== operation.descriptor.settingsHash ||
      operation.identity.namespace.length === 0
    )
      invalid('V3 identity and descriptor do not match', ['identity']);
    if ((operation.retryCount === 0) !== (operation.lastRetryCallHash === undefined)) {
      invalid('Retry count and last retry hash must be present together', ['retryCount']);
    }
    if (operation.state === 'captured' && operation.retryCount !== 0) {
      invalid('Captured operation cannot have conflict retries', ['retryCount']);
    }
    if (operation.lastResumeCause !== undefined && operation.generation < 2) {
      invalid('Resume cause requires generation two or later', ['lastResumeCause']);
    }
    let previousAttemptAt = createdAt;
    for (const [index, attempt] of operation.attempts.entries()) {
      const at = Date.parse(attempt.at);
      if (at < previousAttemptAt || at > lastObservedAt) {
        invalid('Attempt times must be monotonic and within observation time', [
          'attempts',
          index,
          'at',
        ]);
      }
      previousAttemptAt = at;
    }
    if (operation.state === 'leased') {
      const acquiredAt = Date.parse(operation.lease.acquiredAt);
      const renewedAt = Date.parse(operation.lease.renewedAt);
      const expiresAt = Date.parse(operation.lease.expiresAt);
      const duration = Math.min(
        AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
        Math.max(
          operation.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
          AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
        ),
      );
      if (
        acquiredAt < createdAt ||
        renewedAt < acquiredAt ||
        renewedAt > lastObservedAt ||
        expiresAt <= renewedAt ||
        expiresAt - renewedAt !== duration ||
        (operation.lease.claimKind === 'initial' && operation.generation !== 1) ||
        (operation.lease.claimKind === 'resume' && operation.generation < 2)
      )
        invalid('Lease times, generation and duration are inconsistent', ['lease']);
    }
    if (
      (operation.state === 'failed' &&
        (Date.parse(operation.failedAt) < createdAt ||
          Date.parse(operation.failedAt) > lastObservedAt)) ||
      (operation.state === 'interrupted' &&
        (Date.parse(operation.interruptedAt) < createdAt ||
          Date.parse(operation.interruptedAt) > lastObservedAt))
    )
      invalid('Terminal failure time is outside observation bounds');
    if (operation.state === 'committed' || operation.state === 'cancelled') {
      const receipt = operation.terminalReceipt;
      const expectedKinds =
        operation.state === 'cancelled'
          ? ['cancelled']
          : [
              'human_compositional_capture_committed',
              'human_compositional_source_verdict_committed',
            ];
      if (
        !expectedKinds.includes(receipt.kind) ||
        receipt.operationId !== operation.operationId ||
        receipt.sourceId !== operation.identity.sourceId ||
        receipt.sourceHash !== operation.identity.sourceHash ||
        receipt.descriptorHash !== descriptorHash ||
        receipt.policyFingerprint !== operation.descriptor.policy.fingerprint ||
        Date.parse(receipt.terminalAt) < createdAt ||
        Date.parse(receipt.terminalAt) > lastObservedAt
      )
        invalid('V3 terminal receipt does not match operation identity and time', [
          'terminalReceipt',
        ]);
    }
    if (
      Buffer.byteLength(JSON.stringify(operation), 'utf8') > AUTOMATIC_LEDGER_LIMITS.operationBytes
    ) {
      invalid('V3 operation exceeds 32 KiB');
    }
  });
export type CompositionalAutomaticCaptureOperationV3 = z.infer<
  typeof CompositionalAutomaticCaptureOperationV3Schema
>;

/** Claim rows remain payload V2 and keep their reviewed semantic-key recipe. */
export function validateCompositionalClaimRowV2ForCaptureV3(value: unknown): string {
  const claim = CompositionalAutomaticClaimMetadataV2Schema.parse(value);
  return compositionalAutomaticClaimKeyV2(claim.meaning);
}
