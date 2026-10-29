import { randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { prepareHumanCaptureBeginV2 } from '../../../src/storage/AutomaticCaptureBegin';
import {
  AutomaticHumanCaptureBeginPreparationV2Schema,
  type AutomaticHumanCaptureBeginInputV2,
} from '../../../src/schemas/AutomaticCaptureBegin.schema';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  automaticCaptureOperationIdentityForOwnedSource,
  automaticWriteOwnerIdempotencyKey,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
  applyAutomaticBindingCommand,
} from '../../../src/storage/AutomaticIdentity';

function fixture(committed = false) {
  const original = makeHumanFixture(`begin-${randomUUID()}`);
  const human = original.human;
  const owner = AutomaticWriteOwnerSchema.parse(human.attributes[WRITE_OWNER_ATTRIBUTE]);
  const input: AutomaticHumanCaptureBeginInputV2 = {
    storeHash: owner.store,
    sourceId: randomUUID(),
    operationId: randomUUID(),
    previousEpisodeId: null,
    backendNow: '2026-10-25T13:00:00.000Z',
    beginCallHash: 'b'.repeat(64),
    leaseToken: randomUUID(),
    request: {
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      namespace: human.group_id,
      issuer: owner.issuer,
      actorReference: owner.actor,
      turn: committed ? owner.turn : 'new-event',
      attemptIdHash: 'c'.repeat(64),
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30000,
      },
      source: {
        content: human.content,
        sourceMessageId: human.source_message_id,
        conversationId: human.conversation_id,
        senderId: human.sender_id,
        senderName: human.sender_name,
        sourceWorkflowId: human.source_workflow_id,
        originalSourceExecutionId: human.source_execution_id,
        sourceType: 'message',
        quotedMessageId: human.quoted_message_id,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    },
  };
  const graph = original.graph;
  if (!committed) {
    graph.entities = graph.entities.filter((entity) => entity.uuid === original.binding.subjectId);
    graph.edges = [];
    graph.episodes = [];
    delete graph.automatic_operations_v1;
  }
  return { graph, input, original };
}
function claim() {
  const setup = fixture();
  const prepared = prepareHumanCaptureBeginV2(setup.graph, setup.input);
  if (prepared.kind !== 'prepared_claim')
    throw new Error(`Expected claim: ${JSON.stringify(prepared)}`);
  return { ...setup, prepared };
}

describe('pure human capture begin admission', () => {
  it('prepares one bounded atomic source and initial lease without mutating or minting a handle', () => {
    const { graph, input } = fixture();
    const before = JSON.stringify(graph);
    const result = prepareHumanCaptureBeginV2(graph, input);
    expect(JSON.stringify(graph)).toBe(before);
    expect(AutomaticHumanCaptureBeginPreparationV2Schema.safeParse(result).success).toBe(true);
    expect(result.kind).toBe('prepared_claim');
    if (result.kind !== 'prepared_claim') return;
    expect(result.writeRequired).toBe(true);
    expect(result.graph.episodes).toHaveLength(1);
    expect(result.graph.automatic_operations_v1!.operations).toHaveLength(1);
    expect(result.operation.lease).toMatchObject({
      renewedAt: input.backendNow,
      expiresAt: '2026-10-25T13:01:00.000Z',
      claimKind: 'initial',
    });
    expect(result.leaseFence.planTimestamp).toBe(result.operation.lease.renewedAt);
    expect(result.operation).toMatchObject({ auditTruncated: false, overflowCount: 0 });
    expect(result).not.toHaveProperty('leaseHandle');
    expect(result).not.toHaveProperty('should_process');
  });

  it('recovers only exact same private invocation IDs, nonce, token and unexpired initial fence', () => {
    const { prepared, input } = claim();
    const later = {
      ...input,
      backendNow: '2026-10-25T13:00:01.000Z',
      previousEpisodeId: prepared.graph.episodes[0].uuid,
    };
    later.request = {
      ...input.request,
      source: { ...input.request.source, senderName: 'Changed display' },
    };
    const recovered = prepareHumanCaptureBeginV2(prepared.graph, later);
    expect(recovered.kind).toBe('prepared_claim');
    if (recovered.kind !== 'prepared_claim') return;
    expect(recovered.writeRequired).toBe(false);
    expect(recovered.graph.episodes[0]).toEqual(prepared.graph.episodes[0]);
    expect(recovered.leaseFence.planTimestamp).toBe(input.backendNow);
    for (const changed of [
      { sourceId: randomUUID() },
      { operationId: randomUUID() },
      { beginCallHash: 'd'.repeat(64) },
      { leaseToken: randomUUID() },
    ]) {
      expect(prepareHumanCaptureBeginV2(prepared.graph, { ...later, ...changed }).kind).not.toBe(
        'prepared_claim',
      );
    }
  });

  it.each(['content', 'execution', 'actor', 'store', 'policy', 'mapping'] as const)(
    'rejects immutable %s conflicts without audit or mutation',
    (field) => {
      const { prepared, input } = claim();
      const changed = structuredClone(input);
      changed.request.attemptIdHash = 'e'.repeat(64);
      if (field === 'content') changed.request.source.content += ' changed';
      if (field === 'execution')
        changed.request.source.originalSourceExecutionId = 'another-original';
      if (field === 'actor') changed.request.actorReference = 'other-actor';
      if (field === 'store') changed.storeHash = 'f'.repeat(64);
      if (field === 'policy') changed.request.settings.profileId = 'reviewFirst';
      if (field === 'mapping') {
        changed.request.source.applicationOwnedWrapper = true;
        changed.request.source.humanRegion = {
          start: 1,
          end: changed.request.source.content.length,
        };
      }
      const before = JSON.stringify(prepared.graph);
      expect(prepareHumanCaptureBeginV2(prepared.graph, changed)).toEqual({
        kind: 'decision',
        decision: { kind: 'conflict' },
      });
      expect(JSON.stringify(prepared.graph)).toBe(before);
    },
  );

  it('keeps explicit event time immutable and first_capture independent of retry wall time', () => {
    const { prepared, input } = claim();
    const changed = {
      ...input,
      backendNow: '2026-10-25T13:00:01.000Z',
      request: {
        ...input.request,
        source: {
          ...input.request.source,
          eventTime: { mode: 'explicit' as const, value: input.backendNow },
        },
      },
    };
    expect(prepareHumanCaptureBeginV2(prepared.graph, changed)).toMatchObject({
      decision: { kind: 'conflict' },
    });
    expect(
      prepareHumanCaptureBeginV2(prepared.graph, { ...input, backendNow: changed.backendNow }),
    ).toMatchObject({ kind: 'prepared_claim', writeRequired: false });
  });

  it('uses canonical full-body mapping equivalence for redundant wrapper attestations', () => {
    const { prepared, input } = claim();
    const redundant = {
      ...input,
      request: {
        ...input.request,
        source: {
          ...input.request.source,
          applicationOwnedWrapper: true as const,
          humanRegion: { start: 0, end: input.request.source.content.length },
        },
      },
    };
    expect(prepareHumanCaptureBeginV2(prepared.graph, redundant)).toMatchObject({
      kind: 'prepared_claim',
      writeRequired: false,
    });
    const fresh = fixture();
    fresh.input.request.source.applicationOwnedWrapper = true;
    fresh.input.request.source.humanRegion = {
      start: 0,
      end: fresh.input.request.source.content.length,
    };
    const initial = prepareHumanCaptureBeginV2(fresh.graph, fresh.input);
    if (initial.kind !== 'prepared_claim') throw new Error('Expected attested full-body capture');
    expect(prepareHumanCaptureBeginV2(initial.graph, fresh.input)).toMatchObject({
      kind: 'prepared_claim',
      writeRequired: false,
    });
    expect(
      prepareHumanCaptureBeginV2(prepared.graph, {
        ...input,
        request: {
          ...input.request,
          source: { ...input.request.source, quoteRegions: [{ start: 0, end: 1 }] },
        },
      }),
    ).toMatchObject({ decision: { kind: 'conflict' } });
  });

  it('admits the frozen raw-content bound even when JSON escaping expands it', () => {
    const { graph, input } = fixture();
    input.request.source.content = '\u0001'.repeat(65_536);
    expect(prepareHumanCaptureBeginV2(graph, input).kind).toBe('prepared_claim');
  });

  it('preserves missing legacy V2 audit fields on parse and keeps terminal replay readable after truncation', () => {
    const { graph, input } = fixture(true);
    const operation = graph.automatic_operations_v1!.operations[0];
    expect(
      Object.prototype.hasOwnProperty.call(
        AutomaticCaptureOperationV2Schema.parse(operation),
        'auditTruncated',
      ),
    ).toBe(false);
    if (operation.version !== 2) throw new Error('Expected V2 fixture');
    operation.auditTruncated = true;
    const before = JSON.stringify(graph);
    expect(prepareHumanCaptureBeginV2(graph, input)).toEqual({
      kind: 'decision',
      decision: { kind: 'committed_replay' },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('never adopts legacy or source-only owned sources', () => {
    const { prepared, input } = claim();
    const sourceOnly = structuredClone(prepared.graph);
    delete sourceOnly.automatic_operations_v1;
    expect(prepareHumanCaptureBeginV2(sourceOnly, input)).toEqual({
      kind: 'decision',
      decision: { kind: 'source_only_unconfirmed' },
    });
    delete sourceOnly.episodes[0].attributes[WRITE_OWNER_V2_ATTRIBUTE];
    expect(prepareHumanCaptureBeginV2(sourceOnly, input)).toEqual({
      kind: 'decision',
      decision: { kind: 'legacy_unconfirmed' },
    });
  });

  it('honors source-message/kind collisions and never adopts an unowned idempotency row', () => {
    const { prepared, input } = claim();
    expect(
      prepareHumanCaptureBeginV2(prepared.graph, {
        ...input,
        request: { ...input.request, turn: 'different-turn' },
      }),
    ).toMatchObject({ decision: { kind: 'conflict' } });
    const unowned = structuredClone(prepared.graph);
    delete unowned.automatic_operations_v1;
    unowned.episodes[0].attributes = {};
    expect(prepareHumanCaptureBeginV2(unowned, input)).toMatchObject({
      decision: { kind: 'conflict' },
    });
  });

  it('rejects actor-unfiltered source ambiguity and backend UUID collisions without writes', () => {
    const { prepared, input } = claim();
    const ambiguous = structuredClone(prepared.graph);
    const duplicate = structuredClone(ambiguous.episodes[0]);
    duplicate.uuid = randomUUID();
    ambiguous.episodes.push(duplicate);
    expect(prepareHumanCaptureBeginV2(ambiguous, input)).toEqual({
      kind: 'decision',
      decision: { kind: 'conflict' },
    });
    const fresh = fixture();
    for (const collision of [
      { sourceId: fresh.graph.entities[0].uuid },
      { operationId: fresh.graph.entities[0].uuid },
      { operationId: fresh.input.sourceId },
    ]) {
      expect(prepareHumanCaptureBeginV2(fresh.graph, { ...fresh.input, ...collision })).toEqual({
        kind: 'decision',
        decision: { kind: 'conflict' },
      });
    }
  });

  it('returns resume_available at expiry equality and clock_regression without mutation', () => {
    const { prepared, input } = claim();
    expect(
      prepareHumanCaptureBeginV2(prepared.graph, {
        ...input,
        backendNow: prepared.operation.lease.expiresAt,
      }),
    ).toMatchObject({ decision: { kind: 'resume_available' } });
    expect(
      prepareHumanCaptureBeginV2(prepared.graph, {
        ...input,
        backendNow: '2026-10-25T12:59:59.999Z',
      }),
    ).toEqual({ kind: 'decision', decision: { kind: 'clock_regression' } });
  });

  it.each(['failed', 'interrupted'] as const)(
    'offers explicit resume for %s without claiming',
    (state) => {
      const { prepared, input } = claim();
      const base: Record<string, unknown> = { ...prepared.operation };
      delete base.lease;
      prepared.graph.automatic_operations_v1!.operations[0] =
        AutomaticCaptureOperationV2Schema.parse({
          ...base,
          state,
          ...(state === 'failed'
            ? { failedAt: input.backendNow, failureCode: 'provider_error' }
            : { interruptedAt: input.backendNow, failureCode: 'lease_expired' }),
        });
      expect(prepareHumanCaptureBeginV2(prepared.graph, input)).toMatchObject({
        decision: { kind: 'resume_available' },
      });
    },
  );

  it('checks exact current pending trust/review and binding authority separately from identity', () => {
    for (const mutation of ['trust', 'review', 'binding']) {
      const { prepared, input, original } = claim();
      if (mutation === 'trust') prepared.graph.episodes[0].trust_level = 'trusted';
      if (mutation === 'review') prepared.graph.episodes[0].review_status = 'rejected';
      if (mutation === 'binding')
        applyAutomaticBindingCommand(
          prepared.graph,
          {
            action: 'revoke',
            namespace: input.request.namespace,
            bindingId: original.binding.bindingId,
            expectedRevision: original.binding.revision,
            authorizedBy: 'synthetic',
            reason: 'test revocation',
          },
          randomUUID(),
          input.backendNow,
        );
      expect(prepareHumanCaptureBeginV2(prepared.graph, input)).toEqual({
        kind: 'decision',
        decision: { kind: 'authority_changed' },
      });
    }
  });

  it('records the first 32 unique hashes then truncates monotonically without fabricated counts', () => {
    const { prepared, input } = claim();
    let graph = prepared.graph;
    for (let index = 0; index < 31; index++) {
      const result = prepareHumanCaptureBeginV2(graph, {
        ...input,
        beginCallHash: 'd'.repeat(64),
        request: { ...input.request, attemptIdHash: index.toString(16).padStart(64, '0') },
      });
      if (result.kind !== 'prepared_decision') throw new Error('Expected bounded audit append');
      graph = result.graph;
    }
    const duplicate = prepareHumanCaptureBeginV2(graph, {
      ...input,
      beginCallHash: 'd'.repeat(64),
    });
    expect(duplicate.kind).toBe('decision');
    const truncated = prepareHumanCaptureBeginV2(graph, {
      ...input,
      beginCallHash: 'd'.repeat(64),
      request: { ...input.request, attemptIdHash: 'a'.repeat(64) },
    });
    if (truncated.kind !== 'prepared_decision') throw new Error('Expected truncation marker');
    expect(truncated.graph.automatic_operations_v1!.operations[0]).toMatchObject({
      auditTruncated: true,
      overflowCount: 0,
      attempts: expect.any(Array),
    });
    expect(truncated.graph.automatic_operations_v1!.operations[0].attempts).toHaveLength(32);
    expect(
      prepareHumanCaptureBeginV2(truncated.graph, {
        ...input,
        beginCallHash: 'd'.repeat(64),
        request: { ...input.request, attemptIdHash: 'f'.repeat(64) },
      }).kind,
    ).toBe('decision');
  });

  it('preserves mutable source fields and the original captured hash on terminal replay', () => {
    const { graph, input, original } = fixture(true);
    const before = JSON.stringify(original.humanOperation);
    graph.episodes[0].sender_name = 'Updated display';
    graph.episodes[0].trust_level = 'untrusted';
    graph.episodes[0].review_status = 'rejected';
    const result = prepareHumanCaptureBeginV2(graph, input);
    expect(result).toMatchObject({ decision: { kind: 'committed_replay' } });
    if (result.kind !== 'prepared_decision') throw new Error('Expected owned replay audit');
    expect(result.graph.automatic_operations_v1!.operations[0].identity.sourceHash).toBe(
      original.humanOperation.identity.sourceHash,
    );
    expect(JSON.stringify(original.humanOperation)).toBe(before);
  });

  it('checks current binding before even a terminal owned audit without rewriting historical receipts', () => {
    const { graph, input, original } = fixture(true);
    applyAutomaticBindingCommand(
      graph,
      {
        action: 'revoke',
        namespace: input.request.namespace,
        bindingId: original.binding.bindingId,
        expectedRevision: original.binding.revision,
        authorizedBy: 'synthetic',
        reason: 'test revocation after commit',
      },
      randomUUID(),
      input.backendNow,
    );
    const before = JSON.stringify(graph);
    expect(prepareHumanCaptureBeginV2(graph, input)).toEqual({
      kind: 'decision',
      decision: { kind: 'authority_changed' },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('reserves full active V2 operation growth and falls back to a raw source-only capacity candidate', () => {
    const { prepared, input } = claim();
    const graph = prepared.graph;
    for (let index = 1; index < 319; index++) {
      const source = structuredClone(graph.episodes[0]);
      const turn = `reserved-${index}`;
      source.uuid = randomUUID();
      source.source_message_id = `reserved-message-${index}`;
      source.idempotency_key = automaticWriteOwnerIdempotencyKey({ turn, role: 'human' });
      source.attributes[WRITE_OWNER_ATTRIBUTE] = {
        ...(source.attributes[WRITE_OWNER_ATTRIBUTE] as object),
        turn,
      };
      source.attributes[WRITE_OWNER_V2_ATTRIBUTE] = {
        ...(source.attributes[WRITE_OWNER_V2_ATTRIBUTE] as object),
        turn,
        stableProducerHash: hashAutomaticCaptureV2({
          source_workflow_id: source.source_workflow_id,
          source_message_id: source.source_message_id,
          conversation_id: source.conversation_id,
          sender_id: source.sender_id,
          source_type: source.source_type,
          episode_kind: source.episode_kind,
          quoted_message_id: source.quoted_message_id,
        }),
      };
      graph.episodes.push(source);
      graph.automatic_operations_v1!.operations.push(
        AutomaticCaptureOperationV2Schema.parse({
          ...prepared.operation,
          operationId: randomUUID(),
          identity: automaticCaptureOperationIdentityForOwnedSource(
            source,
            prepared.operation.descriptor,
          ),
        }),
      );
    }
    const next = {
      ...input,
      sourceId: randomUUID(),
      operationId: randomUUID(),
      request: {
        ...input.request,
        turn: 'capacity-new',
        source: { ...input.request.source, sourceMessageId: 'capacity-new-message' },
      },
    };
    const result = prepareHumanCaptureBeginV2(graph, next);
    expect(result.kind).toBe('prepared_source_only');
    if (result.kind !== 'prepared_source_only') return;
    expect(result.graph.automatic_operations_v1!.operations).toHaveLength(319);
    expect(result.graph.episodes).toHaveLength(320);
    expect(result).not.toHaveProperty('sourcePersistence');
    expect(prepareHumanCaptureBeginV2(result.graph, next)).toMatchObject({
      decision: { kind: 'source_only_unconfirmed' },
    });
  });

  it('prebounds accessor/malformed input and propagates cooperative cancellation unchanged', () => {
    const { graph, input } = fixture();
    let visits = 0;
    const hostile = {
      ...input,
      request: Object.defineProperty({}, 'source', {
        enumerable: true,
        get() {
          visits++;
          throw new Error('private');
        },
      }),
    };
    expect(prepareHumanCaptureBeginV2(graph, hostile as never)).toEqual({
      kind: 'decision',
      decision: { kind: 'invalid_input' },
    });
    expect(visits).toBe(0);
    const cancel = new Error('synthetic cancellation');
    expect(() =>
      prepareHumanCaptureBeginV2(graph, input, () => {
        throw cancel;
      }),
    ).toThrow(cancel);
    let checks = 0;
    expect(() =>
      prepareHumanCaptureBeginV2(graph, input, () => {
        if (++checks === 6) throw cancel;
      }),
    ).toThrow(cancel);
  });
});
