import { createHash, randomUUID } from 'crypto';
import { captureEnvelope, compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { buildAutomaticOperationDescriptorV2 } from '../../../src/extraction/AutomaticCaptureDescriptor';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  AutomaticOperationDescriptorV2Schema,
  automaticOperationDescriptorSettingsHashV2,
  hashAutomaticCaptureV2,
} from '../../../src/schemas/AutomaticCapture.schema';
import { EpisodicNodeSchema } from '../../../src/schemas/EpisodicNode.schema';
import {
  automaticCaptureOperationIdentityForOwnedSource,
  automaticOperationIdentityForOwnedSource,
  automaticWriteOwnerIdempotencyKey,
  assertAutomaticEpisodeTrustedPath,
  prepareAutomaticEpisodeInput,
  prepareAutomaticEpisodeUpdate,
  prepareAutomaticImport,
  reconcileAutomaticCaptureOperationIdentity,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import { GraphDataSchema, EntityNodeSchema } from '../../../src/schemas';
import { assertAutomaticLedgerSourceIntegrity } from '../../../src/storage/AutomaticIdentity';

const now = '2026-10-25T12:00:00.000Z';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture(
  options: {
    content?: string;
    intentSetting?: boolean;
    quoteRegions?: Array<{ start: number; end: number }>;
  } = {},
) {
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const binding = {
    bindingId: randomUUID(),
    revision: 1,
    subjectId: randomUUID(),
    fingerprint: 'b'.repeat(64),
  };
  const content = options.content ?? 'I prefer concise explanations.';
  const intentSetting = options.intentSetting ?? false;
  const captured = captureEnvelope(
    content,
    content,
    {
      namespace: 'synthetic',
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      quoteRegions: options.quoteRegions ?? [],
    },
    binding,
    intentSetting,
    policy,
  );
  if (!captured.ok) throw new Error('Synthetic envelope fixture failed');
  const legacyOwner = {
    version: 1 as const,
    store: 'a'.repeat(64),
    namespace: 'synthetic',
    turn: 'synthetic-event',
    role: 'human' as const,
    actor: 'synthetic-actor',
    issuer: 'synthetic-app',
    binding,
    policy,
    contentHash: digest(content),
  };
  const descriptor = buildAutomaticOperationDescriptorV2({
    purpose: 'human_turn_memory',
    profileId: 'conservative',
    requestedTrustLevel: 'standard',
    intentSetting,
    invocationDeadlineMs: 30000,
  }).descriptor;
  const episode = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: 'synthetic',
    content,
    role: 'human',
    source_type: 'message',
    reference_time: now,
    created_at: now,
    source_message_id: 'synthetic-message',
    source_workflow_id: 'synthetic-producer',
    source_execution_id: 'synthetic-original',
    conversation_id: 'synthetic-conversation',
    sender_id: 'synthetic-sender',
    sender_name: 'Synthetic display',
    idempotency_key: automaticWriteOwnerIdempotencyKey(legacyOwner),
    episode_kind: 'active_human',
    trust_level: 'standard',
    review_status: 'accepted',
    attributes: {
      [SOURCE_ENVELOPE_ATTRIBUTE]: captured.envelope,
      [WRITE_OWNER_ATTRIBUTE]: legacyOwner,
    },
  });
  const owner = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: legacyOwner.store,
    namespace: legacyOwner.namespace,
    turn: legacyOwner.turn,
    role: 'human',
    issuer: legacyOwner.issuer,
    actorReference: legacyOwner.actor,
    binding,
    assistantWriteAuthority: null,
    purpose: 'human_turn_memory',
    requestedTrustLevel: 'standard',
    intentSetting,
    intentEvidence: captured.envelope.explicitIntent,
    eventTimeMode: 'first_capture',
    eventTimeHash: hashAutomaticCaptureV2({ mode: 'first_capture', normalizedReferenceTime: now }),
    stableProducerHash: hashAutomaticCaptureV2({
      source_workflow_id: episode.source_workflow_id,
      source_message_id: episode.source_message_id,
      conversation_id: episode.conversation_id,
      sender_id: episode.sender_id,
      source_type: episode.source_type,
      episode_kind: episode.episode_kind,
      quoted_message_id: episode.quoted_message_id,
    }),
    sourceContentHash: digest(content),
    settingsHash: descriptor.settingsHash,
    policy,
  });
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = owner;
  return { episode, descriptor, owner, legacyOwner };
}

describe('native v2 source structure and identity, without a creation capability', () => {
  it('preserves exact legacy envelope/owner while binding the actual v2 owner', () => {
    const { episode, descriptor, legacyOwner } = fixture();
    const before = structuredClone(episode);
    expect(prepareAutomaticEpisodeInput(episode)).toEqual(before);
    const identity = automaticCaptureOperationIdentityForOwnedSource(episode, descriptor);
    expect(identity).toMatchObject({
      sourceId: episode.uuid,
      purpose: 'human_turn_memory',
      role: 'human',
      binding: legacyOwner.binding,
    });
    expect(episode).toEqual(before);
    expect(() => automaticOperationIdentityForOwnedSource(episode, legacyOwner)).toThrow(
      'unsupported_capture_version',
    );
  });

  it('retains captured hash and original provenance through explicit mutable review changes', () => {
    const { episode, descriptor } = fixture();
    const original = automaticCaptureOperationIdentityForOwnedSource(episode, descriptor);
    const changed = structuredClone(episode);
    changed.review_status = 'rejected';
    changed.trust_level = 'untrusted';
    changed.confidence = 0.1;
    changed.sender_name = 'Changed display';
    changed.updated_at = '2026-10-25T12:01:00.000Z';
    const observed = automaticCaptureOperationIdentityForOwnedSource(changed, descriptor);
    expect(observed.originalProducerHash).toBe(original.originalProducerHash);
    expect(observed.sourceHash).not.toBe(original.sourceHash);
    expect(reconcileAutomaticCaptureOperationIdentity(observed, original)).toEqual(original);
  });

  it.each(['created_at', 'source_execution_id', 'previous_episode_uuid'] as const)(
    'does not reconcile changed immutable %s',
    (field) => {
      const { episode, descriptor } = fixture();
      const original = automaticCaptureOperationIdentityForOwnedSource(episode, descriptor);
      const changed = structuredClone(episode);
      changed[field] =
        field === 'created_at'
          ? '2026-10-25T12:01:00.000Z'
          : field === 'previous_episode_uuid'
            ? randomUUID()
            : 'different-original';
      expect(
        reconcileAutomaticCaptureOperationIdentity(
          automaticCaptureOperationIdentityForOwnedSource(changed, descriptor),
          original,
        ),
      ).toBeNull();
    },
  );

  it('binds the descriptor settings and immutable v2 intent independently of textual confidence', () => {
    const { episode, descriptor } = fixture();
    const changed = structuredClone(episode);
    (changed.attributes[WRITE_OWNER_V2_ATTRIBUTE] as { settingsHash: string }).settingsHash =
      'f'.repeat(64);
    expect(() => automaticCaptureOperationIdentityForOwnedSource(changed, descriptor)).toThrow(
      'invalid_source_owner',
    );
    const withoutEnvelope = structuredClone(episode);
    delete withoutEnvelope.attributes[SOURCE_ENVELOPE_ATTRIBUTE];
    expect(() => prepareAutomaticEpisodeInput(withoutEnvelope)).toThrow('invalid_write_owner');
  });

  it.each([
    { intentSetting: true, forgedEvidence: false },
    { intentSetting: false, forgedEvidence: true },
  ])(
    'rejects intent evidence not derivable from setting $intentSetting and the exact source',
    ({ intentSetting, forgedEvidence }) => {
      const episode = structuredClone(fixture({ intentSetting }).episode);
      (episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] as { intentEvidence: boolean }).intentEvidence =
        forgedEvidence;
      (
        episode.attributes[SOURCE_ENVELOPE_ATTRIBUTE] as { explicitIntent: boolean }
      ).explicitIntent = forgedEvidence;
      expect(() => prepareAutomaticEpisodeInput(episode)).toThrow('invalid_write_owner');
    },
  );

  it('reconstructs optional anchored intent while preserving quoted intent and explicit app intent', () => {
    const content = 'Remember this: I prefer concise explanations.';
    const anchored = fixture({ content });
    expect(anchored.owner.intentEvidence).toBe(true);
    expect(() => prepareAutomaticEpisodeInput(anchored.episode)).not.toThrow();
    const quoted = fixture({ content, quoteRegions: [{ start: 0, end: 14 }] });
    expect(quoted.owner.intentEvidence).toBe(false);
    expect(() => prepareAutomaticEpisodeInput(quoted.episode)).not.toThrow();
    const explicit = fixture({ intentSetting: true });
    expect(explicit.owner.intentEvidence).toBe(true);
    expect(() => prepareAutomaticEpisodeInput(explicit.episode)).not.toThrow();
  });

  it.each([false, true])('rejects v2 sources through the old trusted-path flag %s', (trusted) => {
    const { episode } = fixture();
    expect(() => assertAutomaticEpisodeTrustedPath(episode, trusted)).toThrow(
      'trusted_capture_writer_required',
    );
  });

  it('rejects every old embedded append entry point before writing valid-looking v2 data', async () => {
    const { episode } = fixture();
    const storage = new GraphologyStorage();
    await storage.initialize();
    try {
      await expect(storage.appendEpisodes([episode])).rejects.toThrow(
        'trusted_capture_writer_required',
      );
      await expect(storage.appendAutomaticEpisodes([episode])).rejects.toThrow(
        'trusted_capture_writer_required',
      );
      expect(await storage.getEpisodeCount('synthetic')).toBe(0);
    } finally {
      await storage.close();
    }
  });

  it('preserves protected v2 owner on ordinary metadata updates and rejects unknown versions', () => {
    const { episode } = fixture();
    const updated = prepareAutomaticEpisodeUpdate(episode, {
      attributes: { note: 'synthetic annotation' } as Record<string, unknown>,
    });
    expect(updated.attributes?.[WRITE_OWNER_V2_ATTRIBUTE]).toEqual(
      episode.attributes[WRITE_OWNER_V2_ATTRIBUTE],
    );
    expect(() =>
      prepareAutomaticEpisodeUpdate(episode, { attributes: { engram_write_owner_v99: {} } }),
    ).toThrow('invalid_write_owner');
    expect(() =>
      prepareAutomaticEpisodeInput({
        ...episode,
        attributes: { ...episode.attributes, engram_source_envelope_v99: {} },
      }),
    ).toThrow('invalid_write_owner');
  });

  it('rejects generic imports even if a v2 owner is omitted from the incoming existing row', () => {
    const { episode } = fixture();
    const graph = {
      version: '2.0' as const,
      exported_at: now,
      entities: [],
      edges: [],
      episodes: [episode],
    };
    expect(() => prepareAutomaticImport(graph, graph)).toThrow('owned_source_import_forbidden');
    const incoming = structuredClone(graph);
    delete incoming.episodes[0].attributes[WRITE_OWNER_V2_ATTRIBUTE];
    expect(() => prepareAutomaticImport(incoming, graph)).toThrow('owned_source_import_forbidden');
  });

  it('checks native ledger linkage while preserving current review changes as history', () => {
    const { episode, descriptor, owner } = fixture();
    const identity = automaticCaptureOperationIdentityForOwnedSource(episode, descriptor);
    const operation = AutomaticCaptureOperationV2Schema.parse({
      version: 2,
      operationId: randomUUID(),
      identity,
      descriptor,
      createdAt: now,
      lastObservedAt: now,
      attempts: [],
      overflowCount: 0,
      beginCallHash: 'd'.repeat(64),
      retryCount: 0,
      state: 'leased',
      generation: 1,
      lease: {
        token: randomUUID(),
        acquiredAt: now,
        renewedAt: now,
        expiresAt: '2026-10-25T12:01:00.000Z',
        claimKind: 'initial',
      },
    });
    const graph = GraphDataSchema.parse({
      version: '2.0',
      exported_at: now,
      entities: [
        EntityNodeSchema.parse({
          uuid: owner.binding!.subjectId,
          group_id: 'synthetic',
          name: 'Synthetic historical subject',
          entity_type: 'person',
          summary: '',
          created_at: now,
          updated_at: now,
        }),
      ],
      edges: [],
      episodes: [episode],
      automatic_operations_v1: { version: 1, operations: [operation] },
    });
    expect(() => assertAutomaticLedgerSourceIntegrity(graph)).not.toThrow();
    graph.episodes[0].review_status = 'rejected';
    graph.episodes[0].trust_level = 'untrusted';
    graph.episodes[0].sender_name = 'Different current display';
    expect(() => assertAutomaticLedgerSourceIntegrity(graph)).not.toThrow();
    graph.episodes[0].created_at = '2026-10-25T12:01:00.000Z';
    expect(() => assertAutomaticLedgerSourceIntegrity(graph)).toThrow('invalid_source_owner');
  });

  it('allows native human source-only preservation but not an orphaned subject reference', () => {
    const { episode, owner } = fixture();
    const graph = GraphDataSchema.parse({
      version: '2.0',
      exported_at: now,
      entities: [
        EntityNodeSchema.parse({
          uuid: owner.binding!.subjectId,
          group_id: 'synthetic',
          name: 'Synthetic historical subject',
          entity_type: 'person',
          summary: '',
          created_at: now,
          updated_at: now,
        }),
      ],
      edges: [],
      episodes: [episode],
    });
    expect(() => assertAutomaticLedgerSourceIntegrity(graph)).not.toThrow();
    graph.entities = [];
    expect(() => assertAutomaticLedgerSourceIntegrity(graph)).toThrow('invalid_source_reference');
  });

  it('validates assistant-only provenance without inventing a human envelope or permission', () => {
    const { episode: human, descriptor: humanDescriptor } = fixture();
    const humanIdentity = automaticCaptureOperationIdentityForOwnedSource(human, humanDescriptor);
    const authority = {
      kind: 'owned_human_turn' as const,
      sourceId: human.uuid,
      sourceHash: humanIdentity.sourceHash,
      descriptorHash: hashAutomaticCaptureV2(humanDescriptor),
      requestedAuthorityHash: humanIdentity.requestedAuthorityHash,
    };
    const settings = {
      lifecycle: 'replaySafeV2' as const,
      purpose: 'assistant_final_save' as const,
      interpreterId: 'assistant-final-write-v1' as const,
      semanticVersion: 1 as const,
      grammarVersion: null,
      lexiconVersion: null,
      requestedTrustLevel: null,
      intentSetting: null,
      invocationDeadlineMs: 30000,
      policy: null,
      assistantWriteAuthority: authority,
    };
    const descriptor = AutomaticOperationDescriptorV2Schema.parse({
      version: 2,
      executionMode: 'synchronous',
      ...settings,
      settingsHash: automaticOperationDescriptorSettingsHashV2(settings),
    });
    const episode = EpisodicNodeSchema.parse({
      ...human,
      uuid: randomUUID(),
      content: 'Synthetic final answer.',
      role: 'ai',
      episode_kind: 'assistant_reply',
      idempotency_key: automaticWriteOwnerIdempotencyKey({
        turn: 'synthetic-event',
        role: 'assistant',
      }),
      attributes: {},
    });
    const owner = AutomaticCaptureSourceOwnerV2Schema.parse({
      ...(human.attributes[WRITE_OWNER_V2_ATTRIBUTE] as object),
      role: 'assistant',
      purpose: 'assistant_final_save',
      binding: null,
      requestedTrustLevel: null,
      intentSetting: null,
      intentEvidence: null,
      policy: null,
      assistantWriteAuthority: authority,
      settingsHash: descriptor.settingsHash,
      sourceContentHash: digest(episode.content),
      stableProducerHash: hashAutomaticCaptureV2({
        source_workflow_id: episode.source_workflow_id,
        source_message_id: episode.source_message_id,
        conversation_id: episode.conversation_id,
        sender_id: episode.sender_id,
        source_type: episode.source_type,
        episode_kind: episode.episode_kind,
        quoted_message_id: episode.quoted_message_id,
      }),
    });
    episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = owner;
    expect(prepareAutomaticEpisodeInput(episode)).toEqual(episode);
    expect(automaticCaptureOperationIdentityForOwnedSource(episode, descriptor)).toMatchObject({
      role: 'assistant',
      purpose: 'assistant_final_save',
      binding: null,
    });
    expect(() => assertAutomaticEpisodeTrustedPath(episode, true)).toThrow(
      'trusted_capture_writer_required',
    );
    expect(episode.attributes).not.toHaveProperty(SOURCE_ENVELOPE_ATTRIBUTE);
    expect(episode.attributes).not.toHaveProperty(WRITE_OWNER_ATTRIBUTE);
  });
});
