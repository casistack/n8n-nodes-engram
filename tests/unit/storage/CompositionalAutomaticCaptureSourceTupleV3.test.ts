import { randomUUID, createHash } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import {
  reconstructCompositionalAutomaticSourceIdentityV3,
  validateCompositionalAutomaticSourceTupleV3,
} from '../../../src/storage/CompositionalAutomaticCaptureSourceTupleV3';
import {
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  type CompositionalAutomaticCaptureSourceEnvelopeV2,
  type CompositionalAutomaticCaptureSourceOwnerV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { GraphDataSchema, type GraphData } from '../../../src/schemas/GraphData.schema';
import {
  WRITE_OWNER_ATTRIBUTE,
  automaticWriteOwnerIdempotencyKey,
} from '../../../src/storage/AutomaticIdentity';
import type { CompositionalAutomaticHumanSourceBuildV3 } from '../../../src/schemas/CompositionalAutomaticCaptureSourceBuildV3.schema';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture() {
  const original = makeHumanFixture(`compositional-v3-tuple-${randomUUID()}`);
  const oldOwner = AutomaticWriteOwnerSchema.parse(
    original.human.attributes[WRITE_OWNER_ATTRIBUTE],
  );
  const graph: GraphData = GraphDataSchema.parse({
    version: '2.0',
    exported_at: '2026-10-25T13:00:00.000Z',
    group_id: original.human.group_id,
    entities: original.graph.entities.filter(
      (entity) => entity.uuid === original.binding.subjectId,
    ),
    edges: [],
    episodes: [],
  });
  const input: CompositionalAutomaticHumanSourceBuildV3 = {
    sourceId: randomUUID(),
    storeHash: 'b'.repeat(64),
    capturedAt: '2026-10-25T13:00:00.000Z',
    previousEpisodeId: null,
    request: {
      version: 3,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      preferenceInterpreter: 'compositionalV2',
      namespace: original.human.group_id,
      issuer: oldOwner.issuer,
      actorReference: oldOwner.actor,
      turn: `compositional-v3-turn-${randomUUID()}`,
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30_000,
      },
      source: {
        content: 'I prefer concise explanations.',
        sourceMessageId: 'synthetic-v3-message',
        conversationId: 'synthetic-v3-conversation',
        senderId: 'synthetic-v3-sender',
        senderName: 'Synthetic V3 display',
        sourceWorkflowId: 'synthetic-v3-producer',
        originalSourceExecutionId: 'synthetic-v3-original-execution',
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
      attemptIdHash: sha('private audit attempt'),
    },
  };
  const built = buildCompositionalHumanCaptureSourceV3(graph, input);
  return { ...built, graph, input };
}

function copyEpisode<T>(episode: T): T {
  return JSON.parse(JSON.stringify(episode)) as T;
}

function protectedParts(episode: { attributes: Record<string, unknown> }): {
  owner: CompositionalAutomaticCaptureSourceOwnerV3;
  envelope: CompositionalAutomaticCaptureSourceEnvelopeV2;
} {
  return {
    owner: episode.attributes[
      COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE
    ] as CompositionalAutomaticCaptureSourceOwnerV3,
    envelope: episode.attributes[
      COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE
    ] as CompositionalAutomaticCaptureSourceEnvelopeV2,
  };
}

describe('compositional V3 actual-source tuple validation', () => {
  it('validates an owner/envelope-only tuple without claiming descriptor proof or returning identity', () => {
    const built = fixture();
    const result = validateCompositionalAutomaticSourceTupleV3(built.episode);

    expect(result).toMatchObject({
      version: 3,
      descriptorValidation: 'opaque_only',
      sourceId: built.episode.uuid,
      mappedContent: built.input.request.source.content,
      sourceHash: expect.any(String),
      originalProducerHash: expect.any(String),
      stableProducerHash: expect.any(String),
      eventTimeHash: expect.any(String),
    });
    expect(result).not.toHaveProperty('descriptor');
    expect(result).not.toHaveProperty('identity');
    expect(result.owner.descriptorHash).toBe(result.envelope.descriptorHash);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(Object.isFrozen(result.envelope.sourceEnvelope.mappings)).toBe(true);
  });

  it('recompiles the exact descriptor and reconstructs operation identity from the actual source', () => {
    const built = fixture();
    const result = reconstructCompositionalAutomaticSourceIdentityV3(
      built.episode,
      built.descriptor,
    );

    expect(result.descriptorValidation).toBe('compiled_descriptor');
    expect(result.identity).toMatchObject({
      sourceId: built.episode.uuid,
      sourceHash: result.sourceHash,
      originalProducerHash: result.originalProducerHash,
      stableProducerHash: result.stableProducerHash,
      eventTimeHash: result.eventTimeHash,
      descriptorHash: result.descriptorHash,
      settingsHash: built.descriptor.settingsHash,
      turn: built.input.request.turn,
    });
    expect(result.identity.requestedAuthorityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.identity)).toBe(true);
    expect(Object.isFrozen(result.descriptor.policy)).toBe(true);
  });

  it('rederives intent evidence from mapped bytes and quote offsets even when stored booleans agree', () => {
    const { graph, input } = fixture();
    input.request.source.content = 'Remember this: use short answers.';
    const built = buildCompositionalHumanCaptureSourceV3(graph, input);
    const tampered = copyEpisode(built.episode);
    const { owner, envelope } = protectedParts(tampered);
    owner.intentEvidence = false;
    envelope.sourceEnvelope.explicitIntent = false;
    expect(() => validateCompositionalAutomaticSourceTupleV3(tampered)).toThrow(
      'invalid_source_tuple',
    );

    input.request.source.quoteRegions = [{ start: 0, end: 7 }];
    const quoted = buildCompositionalHumanCaptureSourceV3(graph, input);
    const tamperedQuoted = copyEpisode(quoted.episode);
    const quotedParts = protectedParts(tamperedQuoted);
    quotedParts.owner.intentEvidence = true;
    quotedParts.envelope.sourceEnvelope.explicitIntent = true;
    expect(() => validateCompositionalAutomaticSourceTupleV3(tamperedQuoted)).toThrow(
      'invalid_source_tuple',
    );
  });

  it('checks the source body, producer provenance, event time and human-turn idempotency key', () => {
    const built = fixture();
    const changedBody = copyEpisode(built.episode);
    changedBody.content = 'A different human source.';
    expect(() => validateCompositionalAutomaticSourceTupleV3(changedBody)).toThrow(
      'invalid_source_tuple',
    );

    const originalTuple = validateCompositionalAutomaticSourceTupleV3(built.episode);
    const changedProducer = copyEpisode(built.episode);
    changedProducer.source_execution_id = 'a-different-execution';
    const changedProducerTuple = validateCompositionalAutomaticSourceTupleV3(changedProducer);
    expect(changedProducerTuple.originalProducerHash).not.toBe(originalTuple.originalProducerHash);
    expect(changedProducerTuple.sourceHash).not.toBe(originalTuple.sourceHash);

    const changedEventTime = copyEpisode(built.episode);
    changedEventTime.reference_time = '2026-10-25T13:00:01.000Z';
    expect(() => validateCompositionalAutomaticSourceTupleV3(changedEventTime)).toThrow(
      'invalid_source_tuple',
    );

    const changedIdempotency = copyEpisode(built.episode);
    changedIdempotency.idempotency_key = 'automatic:wrong:human';
    expect(changedIdempotency.idempotency_key).not.toBe(
      automaticWriteOwnerIdempotencyKey({ turn: built.input.request.turn, role: 'human' }),
    );
    expect(() => validateCompositionalAutomaticSourceTupleV3(changedIdempotency)).toThrow(
      'invalid_source_tuple',
    );
  });

  it('requires a single exact raw-to-mapped region and preserves its UTF-16 slice', () => {
    const { graph, input } = fixture();
    const prefix = 'Synthetic wrapper 🤖: ';
    const body = 'I prefer JSON examples.';
    input.request.source.content = `${prefix}${body}\nsynthetic footer`;
    input.request.source.applicationOwnedWrapper = true;
    input.request.source.humanRegion = { start: prefix.length, end: prefix.length + body.length };
    const built = buildCompositionalHumanCaptureSourceV3(graph, input);
    expect(validateCompositionalAutomaticSourceTupleV3(built.episode).mappedContent).toBe(body);

    const split = copyEpisode(built.episode);
    const { envelope } = protectedParts(split);
    envelope.sourceEnvelope.humanRegion.start = prefix.length - 1;
    expect(() => validateCompositionalAutomaticSourceTupleV3(split)).toThrow(
      'invalid_source_tuple',
    );

    const extraMapping = copyEpisode(built.episode);
    const extraParts = protectedParts(extraMapping);
    extraParts.envelope.sourceEnvelope.mappings.push({
      contentStart: body.length,
      contentEnd: body.length + 1,
      rawStart: prefix.length + body.length,
      rawEnd: prefix.length + body.length + 1,
    });
    expect(() => validateCompositionalAutomaticSourceTupleV3(extraMapping)).toThrow(
      'invalid_source_tuple',
    );
  });

  it('preserves an application-region attestation when its declared region is the full source', () => {
    const { graph, input } = fixture();
    input.request.source.applicationOwnedWrapper = true;
    input.request.source.humanRegion = { start: 0, end: input.request.source.content.length };
    const built = buildCompositionalHumanCaptureSourceV3(graph, input);
    const { envelope } = protectedParts(built.episode);
    expect(envelope.sourceEnvelope.mappingAuthority).toBe('application_region');

    const opaque = validateCompositionalAutomaticSourceTupleV3(built.episode);
    expect(opaque.descriptorValidation).toBe('opaque_only');
    expect(opaque.envelope.sourceEnvelope.mappingAuthority).toBe('application_region');
    const compiled = reconstructCompositionalAutomaticSourceIdentityV3(
      built.episode,
      built.descriptor,
    );
    expect(compiled.descriptorValidation).toBe('compiled_descriptor');
    expect(compiled.envelope.sourceEnvelope.mappingAuthority).toBe('application_region');
  });

  it('requires the operational policy to equal its code-owned profile compiler', () => {
    const built = fixture();
    const tampered = copyEpisode(built.episode);
    const { envelope } = protectedParts(tampered);
    envelope.sourceEnvelope.policy.autoAccept = false;
    expect(() => validateCompositionalAutomaticSourceTupleV3(tampered)).toThrow(
      'invalid_source_tuple',
    );
  });

  it('keeps descriptor hashes opaque in source-only validation and rejects them with a mismatched descriptor', () => {
    const built = fixture();
    const tampered = copyEpisode(built.episode);
    const { owner, envelope } = protectedParts(tampered);
    const opaqueHash = 'c'.repeat(64);
    owner.descriptorHash = opaqueHash;
    envelope.descriptorHash = opaqueHash;
    const opaque = validateCompositionalAutomaticSourceTupleV3(tampered);
    expect(opaque.owner.descriptorHash).toBe(opaqueHash);
    expect(opaque.descriptorValidation).toBe('opaque_only');
    expect(() =>
      reconstructCompositionalAutomaticSourceIdentityV3(tampered, built.descriptor),
    ).toThrow('descriptor_mismatch');
  });

  it('rejects mixed literal-owner versions, missing protected metadata and schema normalization', () => {
    const built = fixture();
    const withLegacyOwner = copyEpisode(built.episode);
    withLegacyOwner.attributes.engram_write_owner_v1 = {};
    expect(() => validateCompositionalAutomaticSourceTupleV3(withLegacyOwner)).toThrow(
      'mixed_source_versions',
    );

    const withFutureOwner = copyEpisode(built.episode);
    withFutureOwner.attributes.engram_write_owner_v4 = {};
    expect(() => validateCompositionalAutomaticSourceTupleV3(withFutureOwner)).toThrow(
      'mixed_source_versions',
    );

    const withFutureEnvelope = copyEpisode(built.episode);
    withFutureEnvelope.attributes.engram_source_envelope_v3 = {};
    expect(() => validateCompositionalAutomaticSourceTupleV3(withFutureEnvelope)).toThrow(
      'mixed_source_versions',
    );

    const withoutEnvelope = copyEpisode(built.episode);
    delete withoutEnvelope.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE];
    expect(() => validateCompositionalAutomaticSourceTupleV3(withoutEnvelope)).toThrow(
      'invalid_source_tuple',
    );

    const withUnknownEpisodeKey = copyEpisode(built.episode) as typeof built.episode & {
      injected: string;
    };
    withUnknownEpisodeKey.injected = 'would be stripped by Zod';
    expect(() => validateCompositionalAutomaticSourceTupleV3(withUnknownEpisodeKey)).toThrow(
      'invalid_source_tuple',
    );
  });

  it('ignores only the established mutable updated time and extraction queue in sourceHash', () => {
    const built = fixture();
    const original = validateCompositionalAutomaticSourceTupleV3(built.episode);
    const mutable = copyEpisode(built.episode);
    mutable.updated_at = '2026-10-25T13:10:00.000Z';
    mutable.attributes.engram_extraction_queue_v1 = { status: 'pending' };
    const changed = validateCompositionalAutomaticSourceTupleV3(mutable);
    expect(changed.sourceHash).toBe(original.sourceHash);
    expect(changed.originalProducerHash).toBe(original.originalProducerHash);
  });

  it('rejects oversized, accessor, proxy and cyclic inputs before source parsing', () => {
    const built = fixture();
    const accessor = copyEpisode(built.episode) as Record<string, unknown>;
    Object.defineProperty(accessor, 'content', {
      enumerable: true,
      get: () => built.episode.content,
    });
    expect(() => validateCompositionalAutomaticSourceTupleV3(accessor)).toThrow();
    expect(() =>
      validateCompositionalAutomaticSourceTupleV3(new Proxy(built.episode, {})),
    ).toThrow();

    const cyclic = copyEpisode(built.episode) as Record<string, unknown>;
    cyclic.loop = cyclic;
    expect(() => validateCompositionalAutomaticSourceTupleV3(cyclic)).toThrow();

    const oversized = copyEpisode(built.episode);
    oversized.attributes.extra = 'x'.repeat(600 * 1024);
    expect(() => validateCompositionalAutomaticSourceTupleV3(oversized)).toThrow();
  });

  it('runs cooperative checks around bounded parsing, source scans and hash derivation', () => {
    const built = fixture();
    let checks = 0;
    const cancellation = new Error('synthetic cancellation');
    expect(() =>
      validateCompositionalAutomaticSourceTupleV3(built.episode, () => {
        checks += 1;
        if (checks === 5) throw cancellation;
      }),
    ).toThrow(cancellation);
    expect(checks).toBe(5);
  });
});
