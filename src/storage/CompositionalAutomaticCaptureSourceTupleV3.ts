import { createHash } from 'crypto';
import { captureEnvelope } from '../extraction/AutomaticEvidence';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { EpisodicNodeSchema } from '../schemas/EpisodicNode.schema';
import { AutomaticBindingReferenceSchema } from '../schemas/AutomaticMemory.schema';
import {
  CompositionalAutomaticCaptureOwnedSourceV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  CompositionalAutomaticCaptureSourceOwnerV3Schema,
  CompositionalAutomaticOperationIdentityV3Schema,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  compositionalCaptureEventTimeHashV3,
  compositionalCaptureOriginalProducerHashV3,
  compositionalCaptureRequestedAuthorityHashV3,
  compositionalCaptureSourceContentHashV3,
  compositionalCaptureSourceHashV3,
  compositionalCaptureStableProducerHashV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticDescriptorInputV3Schema,
  CompositionalAutomaticDescriptorV3Schema,
  CompositionalAutomaticEnvelopeV2Schema,
  compileCompositionalAutomaticDescriptorV3,
  compileCompositionalAutomaticPolicyV2,
  hashCompositionalAutomaticDescriptorV3,
} from '../schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalAutomaticSourceIdentityReconstructionV3Schema,
  CompositionalAutomaticSourceTupleV3Schema,
  type CompositionalAutomaticSourceIdentityReconstructionV3,
  type CompositionalAutomaticSourceTupleV3,
} from '../schemas/CompositionalAutomaticCaptureSourceTupleV3.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';

const RESERVED_CAPTURE_ATTRIBUTE_PREFIXES = [
  'engram_write_owner_',
  'engram_source_envelope_',
] as const;
const CURRENT_CAPTURE_ATTRIBUTES = new Set([
  COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
]);

function fail(code: string): never {
  throw new Error(`Engram compositional capture: ${code}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((nested) => deepFreeze(nested));
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function codePointBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return offset >= 0 && offset <= value.length;
  const left = value.charCodeAt(offset - 1);
  const right = value.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
}

function withoutVersionAndPolicy(value: Record<string, unknown>): Record<string, unknown> {
  const output = { ...value };
  delete output.version;
  delete output.policy;
  return output;
}

function withoutMappingAuthority(value: Record<string, unknown>): Record<string, unknown> {
  const output = { ...value };
  delete output.mappingAuthority;
  return output;
}

function validateClonedSourceTupleV3(
  sourceValue: unknown,
  check: () => void,
): CompositionalAutomaticSourceTupleV3 {
  check();
  const parsedSource = EpisodicNodeSchema.safeParse(sourceValue);
  if (!parsedSource.success) fail('invalid_source_tuple');
  const source = parsedSource.data;
  if (!sameCanonical(sourceValue, source)) fail('invalid_source_tuple');

  const attributes = source.attributes;
  if (
    Object.keys(attributes).some(
      (key) =>
        RESERVED_CAPTURE_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        !CURRENT_CAPTURE_ATTRIBUTES.has(key),
    )
  ) {
    fail('mixed_source_versions');
  }
  if (
    !Object.prototype.hasOwnProperty.call(attributes, COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE) ||
    !Object.prototype.hasOwnProperty.call(attributes, COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE)
  ) {
    fail('invalid_source_tuple');
  }

  check();
  const ownerResult = CompositionalAutomaticCaptureSourceOwnerV3Schema.safeParse(
    attributes[COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE],
  );
  const envelopeResult = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.safeParse(
    attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
  );
  if (!ownerResult.success || !envelopeResult.success) fail('invalid_source_tuple');
  const owner = ownerResult.data;
  const envelope = envelopeResult.data;
  const sourceEnvelopeResult = CompositionalAutomaticEnvelopeV2Schema.safeParse(
    envelope.sourceEnvelope,
  );
  if (!sourceEnvelopeResult.success) fail('invalid_source_tuple');
  const sourceEnvelope = sourceEnvelopeResult.data;

  if (
    owner.role !== 'human' ||
    owner.purpose !== 'human_turn_memory' ||
    source.role !== 'human' ||
    source.episode_kind !== 'active_human' ||
    source.source_type !== 'message' ||
    source.group_id !== owner.namespace ||
    owner.namespace !== sourceEnvelope.namespace ||
    owner.issuer !== sourceEnvelope.issuer ||
    owner.actorReference !== sourceEnvelope.actorReference ||
    owner.settingsHash !== envelope.settingsHash ||
    owner.descriptorHash !== envelope.descriptorHash ||
    owner.policyFingerprint !== sourceEnvelope.policy.fingerprint ||
    owner.intentEvidence !== sourceEnvelope.explicitIntent ||
    !sameCanonical(owner.binding, sourceEnvelope.bindingRef)
  ) {
    fail('invalid_source_tuple');
  }

  check();
  const compiledPolicy = compileCompositionalAutomaticPolicyV2({
    profileId: sourceEnvelope.policy.profileId,
  });
  if (!sameCanonical(compiledPolicy, sourceEnvelope.policy)) fail('invalid_source_tuple');

  const rawContent = source.content;
  const humanRegion = sourceEnvelope.humanRegion;
  if (
    humanRegion.end > rawContent.length ||
    !codePointBoundary(rawContent, humanRegion.start) ||
    !codePointBoundary(rawContent, humanRegion.end)
  ) {
    fail('invalid_source_tuple');
  }
  const mappedContent = rawContent.slice(humanRegion.start, humanRegion.end);
  const onlyMapping = sourceEnvelope.mappings[0];
  if (
    sourceEnvelope.mappings.length !== 1 ||
    !onlyMapping ||
    onlyMapping.contentStart !== 0 ||
    onlyMapping.contentEnd !== mappedContent.length ||
    onlyMapping.rawStart !== humanRegion.start ||
    onlyMapping.rawEnd !== humanRegion.end ||
    mappedContent.length === 0 ||
    sourceEnvelope.contentHash !== compositionalCaptureSourceContentHashV3(mappedContent) ||
    sourceEnvelope.rawContentHash !== compositionalCaptureSourceContentHashV3(rawContent) ||
    owner.sourceContentHash !== compositionalCaptureSourceContentHashV3(rawContent)
  ) {
    fail('invalid_source_tuple');
  }
  if (
    sourceEnvelope.mappingAuthority === 'whole_source' &&
    (humanRegion.start !== 0 ||
      humanRegion.end !== rawContent.length ||
      mappedContent !== rawContent)
  ) {
    fail('invalid_source_tuple');
  }

  const binding = AutomaticBindingReferenceSchema.parse(sourceEnvelope.bindingRef);
  const actor = {
    namespace: sourceEnvelope.namespace,
    issuer: sourceEnvelope.issuer,
    actorReference: sourceEnvelope.actorReference,
    quoteRegions: sourceEnvelope.quoteRegions,
    ...(sourceEnvelope.mappingAuthority === 'application_region'
      ? { applicationOwnedWrapper: true as const, humanRegion }
      : {}),
  };
  check();
  const intentProjection = captureEnvelope(
    mappedContent,
    rawContent,
    actor,
    binding,
    owner.intentSetting,
  );
  if (!intentProjection.ok) fail('invalid_source_tuple');
  const actualSyntaxFields = withoutVersionAndPolicy(intentProjection.envelope);
  const storedSyntaxFields = withoutVersionAndPolicy(sourceEnvelope);
  const fullSourceRegion =
    humanRegion.start === 0 &&
    humanRegion.end === rawContent.length &&
    mappedContent === rawContent;
  const mappingAuthorityMatches =
    intentProjection.envelope.mappingAuthority === sourceEnvelope.mappingAuthority ||
    (fullSourceRegion &&
      sourceEnvelope.mappingAuthority === 'application_region' &&
      intentProjection.envelope.mappingAuthority === 'whole_source');
  if (
    !sameCanonical(
      withoutMappingAuthority(actualSyntaxFields),
      withoutMappingAuthority(storedSyntaxFields),
    ) ||
    !mappingAuthorityMatches ||
    intentProjection.envelope.explicitIntent !== owner.intentEvidence ||
    intentProjection.envelope.explicitIntent !== sourceEnvelope.explicitIntent
  ) {
    fail('invalid_source_tuple');
  }

  check();
  const stableProducerHash = compositionalCaptureStableProducerHashV3({
    source_workflow_id: source.source_workflow_id,
    source_message_id: source.source_message_id,
    conversation_id: source.conversation_id,
    sender_id: source.sender_id,
    source_type: source.source_type,
    episode_kind: source.episode_kind,
    quoted_message_id: source.quoted_message_id,
  });
  const eventTimeHash = compositionalCaptureEventTimeHashV3(
    owner.eventTimeMode,
    source.reference_time,
  );
  if (stableProducerHash !== owner.stableProducerHash || eventTimeHash !== owner.eventTimeHash) {
    fail('invalid_source_tuple');
  }

  const expectedIdempotencyKey = `automatic:${sha256(owner.turn)}:human`;
  if (source.idempotency_key !== expectedIdempotencyKey) fail('invalid_source_tuple');

  check();
  const sourceHash = compositionalCaptureSourceHashV3(source);
  const originalProducerHash = compositionalCaptureOriginalProducerHashV3(owner, envelope, {
    uuid: source.uuid,
    group_id: source.group_id,
    content: source.content,
    role: 'human',
    source_type: 'message',
    episode_kind: 'active_human',
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
  check();

  return deepFreeze(
    CompositionalAutomaticSourceTupleV3Schema.parse({
      version: 3,
      descriptorValidation: 'opaque_only',
      sourceId: source.uuid,
      source,
      owner,
      envelope,
      mappedContent,
      sourceHash,
      originalProducerHash,
      stableProducerHash,
      eventTimeHash,
    }),
  );
}

/** Validate the actual source tuple while leaving descriptor/settings hashes opaque. */
export function validateCompositionalAutomaticSourceTupleV3(
  sourceValue: unknown,
  check: () => void = () => {},
): CompositionalAutomaticSourceTupleV3 {
  check();
  const sourceSnapshot = cloneBoundedAutomaticCaptureJson(sourceValue, 'beginRequest');
  check();
  return validateClonedSourceTupleV3(sourceSnapshot, check);
}

/** Recompile a supplied descriptor, then derive structural identity from the source. */
export function reconstructCompositionalAutomaticSourceIdentityV3(
  sourceValue: unknown,
  descriptorValue: unknown,
  check: () => void = () => {},
): CompositionalAutomaticSourceIdentityReconstructionV3 {
  check();
  const snapshot = cloneBoundedAutomaticCaptureJson<{ source: unknown; descriptor: unknown }>(
    { source: sourceValue, descriptor: descriptorValue },
    'beginRequest',
  );
  check();
  const tuple = validateClonedSourceTupleV3(snapshot.source, check);

  const descriptorResult = CompositionalAutomaticDescriptorV3Schema.safeParse(snapshot.descriptor);
  if (!descriptorResult.success) fail('descriptor_mismatch');
  const descriptor = descriptorResult.data;
  const recompiled = compileCompositionalAutomaticDescriptorV3(
    CompositionalAutomaticDescriptorInputV3Schema.parse({
      profileId: descriptor.policy.profileId,
      requestedTrustLevel: descriptor.requestedTrustLevel,
      intentSetting: descriptor.intentSetting,
      invocationDeadlineMs: descriptor.invocationDeadlineMs,
    }),
  );
  if (!sameCanonical(recompiled, descriptor)) fail('descriptor_mismatch');
  const descriptorHash = hashCompositionalAutomaticDescriptorV3(descriptor);
  if (
    descriptorHash !== tuple.owner.descriptorHash ||
    descriptor.settingsHash !== tuple.owner.settingsHash
  ) {
    fail('descriptor_mismatch');
  }

  const ownedSource = CompositionalAutomaticCaptureOwnedSourceV3Schema.safeParse({
    owner: tuple.owner,
    envelope: tuple.envelope,
    descriptor,
  });
  if (!ownedSource.success) fail('descriptor_mismatch');

  const owner = tuple.owner;
  const identityBase = {
    version: 3 as const,
    lifecycle: owner.lifecycle,
    storeHash: owner.storeHash,
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actorReference,
    turn: owner.turn,
    role: 'human' as const,
    purpose: 'human_turn_memory' as const,
    binding: owner.binding,
    sourceId: tuple.sourceId,
    sourceContentHash: owner.sourceContentHash,
    sourceHash: tuple.sourceHash,
    originalProducerHash: tuple.originalProducerHash,
    stableProducerHash: tuple.stableProducerHash,
    eventTimeMode: owner.eventTimeMode,
    eventTimeHash: tuple.eventTimeHash,
    settingsHash: owner.settingsHash,
    descriptorHash,
    policyFingerprint: owner.policyFingerprint,
  };
  const requestedAuthorityHash = compositionalCaptureRequestedAuthorityHashV3({
    lifecycle: identityBase.lifecycle,
    storeHash: identityBase.storeHash,
    namespace: identityBase.namespace,
    issuer: identityBase.issuer,
    actorReference: identityBase.actorReference,
    turn: identityBase.turn,
    role: identityBase.role,
    purpose: identityBase.purpose,
    sourceId: identityBase.sourceId,
    sourceContentHash: identityBase.sourceContentHash,
    stableProducerHash: identityBase.stableProducerHash,
    eventTimeMode: identityBase.eventTimeMode,
    eventTimeHash: identityBase.eventTimeHash,
    settingsHash: identityBase.settingsHash,
    descriptorHash: identityBase.descriptorHash,
    policyFingerprint: identityBase.policyFingerprint,
    binding: identityBase.binding,
  });
  const identity = CompositionalAutomaticOperationIdentityV3Schema.parse({
    ...identityBase,
    requestedAuthorityHash,
  });
  check();

  return deepFreeze(
    CompositionalAutomaticSourceIdentityReconstructionV3Schema.parse({
      ...tuple,
      descriptorValidation: 'compiled_descriptor',
      descriptor,
      descriptorHash,
      identity,
    }),
  );
}
