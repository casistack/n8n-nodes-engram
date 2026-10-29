import { randomUUID, createHash } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import { hashCompositionalAutomaticDescriptorV3 } from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  compositionalCaptureEventTimeHashV3,
  compositionalCaptureSourceHashV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { EpisodicNodeSchema, GraphDataSchema, type GraphData } from '../../../src/schemas';
import {
  applyAutomaticBindingCommand,
  automaticWriteOwnerIdempotencyKey,
  BINDINGS_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import type { CompositionalAutomaticHumanSourceBuildV3 } from '../../../src/schemas/CompositionalAutomaticCaptureSourceBuildV3.schema';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture() {
  const original = makeHumanFixture(`compositional-v3-source-${randomUUID()}`);
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
  return { graph, input, original };
}

describe('pure compositional V3 human source construction', () => {
  it('builds a V3 owner and V2 compositional envelope without manufacturing V1 protected attributes', () => {
    const { graph, input } = fixture();
    const before = JSON.stringify(graph);
    const built = buildCompositionalHumanCaptureSourceV3(graph, input);
    expect(JSON.stringify(graph)).toBe(before);
    expect(built.episode.attributes).toEqual({
      [COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE]: expect.any(Object),
      [COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE]: expect.any(Object),
    });
    expect(built.episode.attributes).not.toHaveProperty(WRITE_OWNER_ATTRIBUTE);
    expect(built.episode.attributes).not.toHaveProperty('engram_source_envelope_v1');
    expect(built.episode.attributes).not.toHaveProperty('engram_write_owner_v2');
    expect(JSON.stringify(built.episode)).not.toContain(input.request.attemptIdHash);
    expect(built.episode).toMatchObject({
      uuid: input.sourceId,
      group_id: input.request.namespace,
      content: input.request.source.content,
      role: 'human',
      episode_kind: 'active_human',
      source_type: 'message',
      reference_time: input.capturedAt,
      created_at: input.capturedAt,
      updated_at: input.capturedAt,
      previous_episode_uuid: null,
      source_execution_id: 'synthetic-v3-original-execution',
      source_workflow_id: 'synthetic-v3-producer',
      review_status: 'accepted',
      trust_level: 'standard',
    });
    expect(built.episode.idempotency_key).toBe(
      automaticWriteOwnerIdempotencyKey({ turn: input.request.turn, role: 'human' }),
    );
    expect(built.descriptorHash).toBe(hashCompositionalAutomaticDescriptorV3(built.descriptor));
    expect(built.identity.sourceId).toBe(input.sourceId);
    expect(built.identity.sourceHash).toBe(compositionalCaptureSourceHashV3(built.episode));
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.episode)).toBe(true);
    expect(
      Object.isFrozen(built.episode.attributes[COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE]),
    ).toBe(true);
    expect(Object.isFrozen(built.identity)).toBe(true);
    expect(Object.isFrozen(built.descriptor)).toBe(true);

    input.request.source.content = 'changed after build';
    expect(built.episode.content).toBe('I prefer concise explanations.');
  });

  it('preserves exact application-region UTF-16 geometry and mapped quote offsets', () => {
    const { graph, input } = fixture();
    const prefix = 'Synthetic wrapper 🤖: ';
    const body = 'I prefer JSON examples.';
    input.request.source.content = prefix + body + '\nsynthetic footer';
    input.request.source.applicationOwnedWrapper = true;
    input.request.source.humanRegion = { start: prefix.length, end: prefix.length + body.length };
    input.request.source.quoteRegions = [{ start: 9, end: 13 }];

    const built = buildCompositionalHumanCaptureSourceV3(graph, input);
    const envelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
      built.episode.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
    );
    expect(envelope.sourceEnvelope).toMatchObject({
      mappingAuthority: 'application_region',
      humanRegion: input.request.source.humanRegion,
      mappings: [
        {
          contentStart: 0,
          contentEnd: body.length,
          rawStart: prefix.length,
          rawEnd: prefix.length + body.length,
        },
      ],
      quoteRegions: [{ start: 9, end: 13 }],
      contentHash: sha(body),
      rawContentHash: sha(input.request.source.content),
    });
    expect(built.episode.content).toBe(input.request.source.content);
  });

  it('uses the existing anchored intent cue and quote-overlap behavior', () => {
    const { graph, input } = fixture();
    input.request.source.content = 'Remember this: use short answers.';
    const unquoted = buildCompositionalHumanCaptureSourceV3(graph, input);
    const unquotedEnvelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
      unquoted.episode.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
    );
    expect(unquotedEnvelope.sourceEnvelope.explicitIntent).toBe(true);

    input.request.source.quoteRegions = [{ start: 0, end: 7 }];
    const quoted = buildCompositionalHumanCaptureSourceV3(graph, input);
    const quotedEnvelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
      quoted.episode.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
    );
    expect(quotedEnvelope.sourceEnvelope.explicitIntent).toBe(false);
  });

  it('uses the canonical explicit event time and backend capture time consistently', () => {
    const { graph, input } = fixture();
    input.request.source.eventTime = {
      mode: 'explicit',
      value: '2026-04-01T13:15:00+01:00',
    };
    const built = buildCompositionalHumanCaptureSourceV3(graph, input);
    expect(built.episode.reference_time).toBe('2026-04-01T12:15:00.000Z');
    expect(built.episode.created_at).toBe(input.capturedAt);
    expect(built.identity.eventTimeHash).toBe(
      compositionalCaptureEventTimeHashV3('explicit', '2026-04-01T12:15:00.000Z'),
    );
  });

  it('separates producer provenance from per-attempt audit input', () => {
    const { graph, input } = fixture();
    const first = buildCompositionalHumanCaptureSourceV3(graph, input);
    const auditRetry = JSON.parse(
      JSON.stringify(input),
    ) as CompositionalAutomaticHumanSourceBuildV3;
    auditRetry.request.attemptIdHash = sha('different audit attempt');
    const sameProducer = buildCompositionalHumanCaptureSourceV3(graph, auditRetry);
    expect(sameProducer.identity).toEqual(first.identity);
    expect(sameProducer.episode).toEqual(first.episode);

    const changedProducer = JSON.parse(
      JSON.stringify(input),
    ) as CompositionalAutomaticHumanSourceBuildV3;
    changedProducer.request.source.originalSourceExecutionId = 'different-original-execution';
    const differentSource = buildCompositionalHumanCaptureSourceV3(graph, changedProducer);
    expect(differentSource.identity.originalProducerHash).not.toBe(
      first.identity.originalProducerHash,
    );
    expect(differentSource.identity.sourceHash).not.toBe(first.identity.sourceHash);
    expect(differentSource.identity.sourceContentHash).toBe(first.identity.sourceContentHash);
  });

  it('requires canonical millisecond UTC backend time', () => {
    const { graph, input } = fixture();
    for (const capturedAt of [
      '2026-10-25T13:00:00Z',
      '2026-10-25T13:00:00.0Z',
      '2026-10-25T13:00:00.000+00:00',
      '2026-10-25T13:00:00.0000Z',
    ]) {
      expect(() =>
        buildCompositionalHumanCaptureSourceV3(graph, { ...input, capturedAt }),
      ).toThrow();
    }
  });

  it('requires an active exact binding and accepted subject without mutating the graph', () => {
    const { graph, input, original } = fixture();
    const subject = graph.entities[0];
    expect(buildCompositionalHumanCaptureSourceV3(graph, input).episode.uuid).toBe(input.sourceId);

    const missing = JSON.parse(JSON.stringify(graph)) as GraphData;
    delete missing.entities[0].attributes[BINDINGS_ATTRIBUTE];
    expect(() => buildCompositionalHumanCaptureSourceV3(missing, input)).toThrow();

    for (const field of ['namespace', 'issuer', 'actorReference'] as const) {
      const mismatched = JSON.parse(
        JSON.stringify(input),
      ) as CompositionalAutomaticHumanSourceBuildV3;
      mismatched.request[field] = `synthetic-other-${field}`;
      expect(() => buildCompositionalHumanCaptureSourceV3(graph, mismatched)).toThrow();
    }

    const duplicate = JSON.parse(JSON.stringify(graph)) as GraphData;
    const records = duplicate.entities[0].attributes[BINDINGS_ATTRIBUTE] as Array<
      Record<string, unknown>
    >;
    records.push(JSON.parse(JSON.stringify(records[0])) as Record<string, unknown>);
    expect(() => buildCompositionalHumanCaptureSourceV3(duplicate, input)).toThrow();

    const rejected = JSON.parse(JSON.stringify(graph)) as GraphData;
    const extraction = rejected.entities[0].attributes.engram_extraction as Record<string, unknown>;
    extraction.review_status = 'rejected';
    expect(() => buildCompositionalHumanCaptureSourceV3(rejected, input)).toThrow();

    const revoked = JSON.parse(JSON.stringify(graph)) as GraphData;
    applyAutomaticBindingCommand(
      revoked,
      {
        action: 'revoke',
        namespace: input.request.namespace,
        bindingId: original.binding.bindingId,
        expectedRevision: original.binding.revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic binding revocation',
      },
      randomUUID(),
      input.capturedAt,
    );
    const revokedBefore = JSON.stringify(revoked);
    expect(() => buildCompositionalHumanCaptureSourceV3(revoked, input)).toThrow();
    expect(JSON.stringify(revoked)).toBe(revokedBefore);
    expect(subject.uuid).toBe(original.binding.subjectId);
  });

  it('rejects source UUID collisions with every record kind and stored operation IDs', () => {
    const { graph, input, original } = fixture();
    const fullGraph = original.graph;
    const collisionIds = [
      fullGraph.entities[0].uuid,
      fullGraph.edges[0].uuid,
      fullGraph.episodes[0].uuid,
      original.humanOperation.operationId,
    ];
    for (const sourceId of collisionIds) {
      const before = JSON.stringify(fullGraph);
      expect(() =>
        buildCompositionalHumanCaptureSourceV3(fullGraph, { ...input, sourceId }),
      ).toThrow('source_id_conflict');
      expect(JSON.stringify(fullGraph)).toBe(before);
    }
  });

  it('requires an existing same-namespace predecessor and leaves graph input untouched', () => {
    const { graph, input, original } = fixture();
    expect(() =>
      buildCompositionalHumanCaptureSourceV3(graph, { ...input, previousEpisodeId: randomUUID() }),
    ).toThrow('invalid_predecessor');

    const predecessor = EpisodicNodeSchema.parse({
      uuid: randomUUID(),
      group_id: input.request.namespace,
      content: 'Synthetic prior source',
      role: 'human',
      source_type: 'message',
      reference_time: input.capturedAt,
      created_at: input.capturedAt,
      previous_episode_uuid: null,
    });
    graph.episodes.push(predecessor);
    const before = JSON.stringify(graph);
    const built = buildCompositionalHumanCaptureSourceV3(graph, {
      ...input,
      previousEpisodeId: predecessor.uuid,
    });
    expect(built.episode.previous_episode_uuid).toBe(predecessor.uuid);
    expect(JSON.stringify(graph)).toBe(before);

    const crossNamespace = JSON.parse(JSON.stringify(graph)) as GraphData;
    crossNamespace.episodes[0].group_id = 'synthetic-other-namespace';
    expect(() =>
      buildCompositionalHumanCaptureSourceV3(crossNamespace, {
        ...input,
        previousEpisodeId: predecessor.uuid,
      }),
    ).toThrow('invalid_predecessor');
    expect(original.binding.subjectId).toBe(graph.entities[0].uuid);
  });

  it('rejects a modified request shape before construction and honors cooperative cancellation', () => {
    const { graph, input } = fixture();
    const before = JSON.stringify(graph);
    const tampered = {
      ...input,
      request: { ...input.request, policy: { autoAccept: true } },
    } as unknown as CompositionalAutomaticHumanSourceBuildV3;
    expect(() => buildCompositionalHumanCaptureSourceV3(graph, tampered)).toThrow();
    expect(() =>
      buildCompositionalHumanCaptureSourceV3(graph, input, () => {
        throw new Error('synthetic-cancel');
      }),
    ).toThrow('synthetic-cancel');
    expect(JSON.stringify(graph)).toBe(before);
  });
});
