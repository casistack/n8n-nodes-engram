import { randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { buildHumanCaptureSourceV2 } from '../../../src/storage/AutomaticCaptureSource';
import { captureEnvelope } from '../../../src/extraction/AutomaticEvidence';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import {
  applyAutomaticBindingCommand,
  automaticWriteOwnerIdempotencyKey,
  prepareAutomaticEpisodeInput,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import type { AutomaticHumanSourceBuildV2 } from '../../../src/schemas/AutomaticCaptureSourceBuild.schema';

function fixture() {
  const original = makeHumanFixture(`source-build-${randomUUID()}`);
  const owner = AutomaticWriteOwnerSchema.parse(original.human.attributes[WRITE_OWNER_ATTRIBUTE]);
  const graph = original.graph;
  graph.entities = graph.entities.filter((entity) => entity.uuid === original.binding.subjectId);
  graph.edges = [];
  graph.episodes = [];
  delete graph.automatic_operations_v1;
  const input: AutomaticHumanSourceBuildV2 = {
    sourceId: randomUUID(),
    storeHash: 'b'.repeat(64),
    capturedAt: '2026-10-25T13:00:00.000Z',
    previousEpisodeId: null,
    request: {
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      namespace: original.human.group_id,
      issuer: owner.issuer,
      actorReference: owner.actor,
      turn: 'new-synthetic-event',
      attemptIdHash: 'c'.repeat(64),
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30000,
      },
      source: {
        content: 'I prefer concise explanations.',
        sourceMessageId: 'synthetic-original-message',
        conversationId: 'synthetic-conversation',
        senderId: 'synthetic-sender',
        senderName: 'Synthetic Display',
        sourceWorkflowId: 'synthetic-original-producer',
        originalSourceExecutionId: 'synthetic-original-execution',
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    },
  };
  return { graph, input, binding: original.binding };
}

describe('pure human V2 source construction', () => {
  it('preserves the exact V1 owner/envelope, original provenance and source bytes without writing', () => {
    const { graph, input, binding } = fixture();
    const before = JSON.stringify(graph);
    const built = buildHumanCaptureSourceV2(graph, input);
    expect(JSON.stringify(graph)).toBe(before);
    const owner = AutomaticWriteOwnerSchema.parse(built.episode.attributes[WRITE_OWNER_ATTRIBUTE]);
    expect(owner.store).toBe(input.storeHash);
    expect(owner.binding).toEqual(binding);
    expect(built.episode.idempotency_key).toBe(automaticWriteOwnerIdempotencyKey(owner));
    const captured = captureEnvelope(
      input.request.source.content,
      input.request.source.content,
      {
        namespace: input.request.namespace,
        issuer: input.request.issuer,
        actorReference: input.request.actorReference,
      },
      binding,
      false,
      owner.policy,
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error('Expected comparison envelope');
    expect(JSON.stringify(built.episode.attributes[SOURCE_ENVELOPE_ATTRIBUTE])).toBe(
      JSON.stringify(captured.envelope),
    );
    expect(built.episode).toMatchObject({
      uuid: input.sourceId,
      role: 'human',
      episode_kind: 'active_human',
      source_type: 'message',
      reference_time: input.capturedAt,
      created_at: input.capturedAt,
      source_execution_id: 'synthetic-original-execution',
      source_workflow_id: 'synthetic-original-producer',
      review_status: 'accepted',
      trust_level: 'standard',
      content: input.request.source.content,
    });
    expect(built.identity.sourceId).toBe(input.sourceId);
    expect(prepareAutomaticEpisodeInput(built.episode)).toEqual(built.episode);
  });

  it('retains exact UTF-16 application mapping and quote regions', () => {
    const { graph, input } = fixture();
    const prefix = '🤖 Synthetic display: ';
    const body = 'I like JSON. A quoted example.';
    input.request.source.content = prefix + body;
    input.request.source.applicationOwnedWrapper = true;
    input.request.source.humanRegion = { start: prefix.length, end: prefix.length + body.length };
    input.request.source.quoteRegions = [{ start: 13, end: body.length }];
    const built = buildHumanCaptureSourceV2(graph, input);
    expect(built.episode.content).toBe(prefix + body);
    expect(built.episode.attributes[SOURCE_ENVELOPE_ATTRIBUTE]).toMatchObject({
      mappingAuthority: 'application_region',
      humanRegion: input.request.source.humanRegion,
      quoteRegions: input.request.source.quoteRegions,
    });
    expect(prepareAutomaticEpisodeInput(built.episode)).toEqual(built.episode);
  });

  it('normalizes explicit event time while using backend time for new record timestamps', () => {
    const { graph, input } = fixture();
    input.request.source.eventTime = { mode: 'explicit', value: '2026-04-01T13:15:00+01:00' };
    const built = buildHumanCaptureSourceV2(graph, input);
    expect(built.episode.reference_time).toBe('2026-04-01T12:15:00.000Z');
    expect(built.episode.created_at).toBe(input.capturedAt);
    expect(built.episode.attributes[WRITE_OWNER_V2_ATTRIBUTE]).toMatchObject({
      eventTimeMode: 'explicit',
    });
  });

  it('does not invent producer provenance when original fields are unavailable', () => {
    const { graph, input } = fixture();
    input.request.source.originalSourceExecutionId = null;
    input.request.source.sourceWorkflowId = null;
    const built = buildHumanCaptureSourceV2(graph, input);
    expect(built.episode.source_execution_id).toBeNull();
    expect(built.episode.source_workflow_id).toBeNull();
  });

  it('requires current active reviewed binding and changes no graph on revocation', () => {
    const { graph, input, binding } = fixture();
    applyAutomaticBindingCommand(
      graph,
      {
        action: 'revoke',
        namespace: input.request.namespace,
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic revoked authority',
      },
      randomUUID(),
      input.capturedAt,
    );
    const before = JSON.stringify(graph);
    expect(() => buildHumanCaptureSourceV2(graph, input)).toThrow();
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects existing IDs across kinds and foreign predecessors without writes', () => {
    const { graph, input } = fixture();
    const before = JSON.stringify(graph);
    expect(() =>
      buildHumanCaptureSourceV2(graph, { ...input, sourceId: graph.entities[0].uuid }),
    ).toThrow('source_id_conflict');
    expect(() =>
      buildHumanCaptureSourceV2(graph, { ...input, previousEpisodeId: randomUUID() }),
    ).toThrow('invalid_predecessor');
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects assistant purpose rather than minting write authority', () => {
    const { graph, input } = fixture();
    input.request.purpose = 'assistant_final_save';
    input.request.settings = {
      profileId: null,
      requestedTrustLevel: null,
      intentSetting: null,
      invocationDeadlineMs: 30000,
    };
    expect(() => buildHumanCaptureSourceV2(graph, input)).toThrow();
    expect(graph.episodes).toHaveLength(0);
  });

  it('honors cooperative cancellation before construction or mutation', () => {
    const { graph, input } = fixture();
    const before = JSON.stringify(graph);
    expect(() =>
      buildHumanCaptureSourceV2(graph, input, () => {
        throw new Error('synthetic-cancel');
      }),
    ).toThrow('synthetic-cancel');
    expect(JSON.stringify(graph)).toBe(before);
  });
});
