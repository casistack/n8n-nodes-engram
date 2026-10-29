import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import type { AutonomousPersonalBeginV4Request } from '../../../src/schemas/AutonomousPersonalBeginV4.schema';
import type { AutonomousPersonalCaptureSnapshotPreparationV4Input } from '../../../src/schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import { AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import {
  hashAutonomousPersonalAttemptV4,
  hashAutonomousPersonalStableRequestV4,
  compileAutonomousPersonalFreshSourceV4,
  prepareAutonomousPersonalCaptureSnapshotV4,
} from '../../../src/storage/AutonomousPersonalCaptureBeginV4';
import { automaticWriteOwnerIdempotencyKey } from '../../../src/storage/AutomaticIdentity';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import type { GraphData } from '../../../src/schemas/GraphData.schema';

const uuidAt = (value: number) => `30000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const hashAt = (value: number) => value.toString(16).padStart(64, '0');
const T0 = '2026-10-27T12:00:00.000Z';
const T1 = '2026-10-27T12:00:01.000Z';
const T2 = '2026-10-27T12:00:02.000Z';

function fixture() {
  const old = makeCompositionalCaptureFixture();
  const graph = structuredClone(old.graph);
  const request: AutonomousPersonalBeginV4Request = {
    version: 4,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    interpretationFamily: 'autonomous-personal-v1',
    namespace: old.source.group_id,
    issuer: old.input.request.issuer,
    actorReference: old.input.request.actorReference,
    turn: 'review-event',
    settings: {
      profileId: 'conservative',
      requestedTrustLevel: 'standard',
      intentSetting: false,
      invocationDeadlineMs: 30_000,
      providerReference: {
        routeId: 'synthetic-route',
        configurationFingerprint: 'e'.repeat(64),
        protocol: 'openai-compatible-json-v1',
        configuredRequestLimit: 32,
        configuredTimeoutMs: 30_000,
        configuredRequestBytes: 262_144,
        configuredResponseBytes: 65_536,
        temperature: { mode: 'providerDefault' },
        responseFormat: 'json_object',
        outputTokenLimit: { mode: 'omit' },
      },
    },
    source: {
      content: 'I prefer concise, concrete explanations.',
      sourceMessageId: null,
      conversationId: null,
      senderId: null,
      sourceWorkflowId: null,
      quotedMessageId: null,
      sourceType: 'message',
      eventTime: { mode: 'first_capture' },
      mapping: { mode: 'full_body' },
      quoteRegions: [],
    },
  };
  const context = {
    storeHash: old.input.storeHash,
    namespace: request.namespace,
    issuer: request.issuer,
    actorReference: request.actorReference,
    turn: request.turn,
    binding: old.operation.identity.binding,
    instance: 'snapshot-review-instance',
    workflow: 'snapshot-review-workflow',
    execution: 'snapshot-review-execution-a',
  };
  const input: AutonomousPersonalCaptureSnapshotPreparationV4Input = {
    request,
    context,
    sourceId: uuidAt(1),
    operationId: uuidAt(2),
    leaseToken: uuidAt(3),
    stableBeginHash: hashAutonomousPersonalStableRequestV4({ request, context }),
    attemptHash: hashAutonomousPersonalAttemptV4(context),
    backendNow: T0,
    previousEpisodeId: old.source.uuid,
  };
  graph.automatic_operations_v1 = { version: 1, operations: [] };
  return { graph, input, old };
}

function prepareFresh(
  graph: GraphData,
  input: AutonomousPersonalCaptureSnapshotPreparationV4Input,
) {
  const output = prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {});
  if (output.kind !== 'initial_candidate') throw new Error('Expected an initial candidate');
  return output;
}

function installFresh(
  graph: GraphData,
  input: AutonomousPersonalCaptureSnapshotPreparationV4Input,
) {
  const candidate = prepareFresh(graph, input);
  graph.episodes.push(structuredClone(candidate.episode));
  graph.automatic_operations_v1 = {
    version: 1,
    operations: [structuredClone(candidate.operation)],
  };
  return candidate;
}

function leasedOperation(operation: AutonomousPersonalOperationV4) {
  if (operation.state !== 'leased') throw new Error('Expected initial leased operation');
  return operation;
}

function replayInput(input: AutonomousPersonalCaptureSnapshotPreparationV4Input) {
  const replay = structuredClone(input);
  replay.context.execution = 'snapshot-review-execution-b';
  replay.sourceId = uuidAt(11);
  replay.operationId = uuidAt(12);
  replay.leaseToken = uuidAt(13);
  replay.attemptHash = hashAutonomousPersonalAttemptV4(replay.context);
  replay.backendNow = T1;
  replay.previousEpisodeId = replay.sourceId;
  return replay;
}

function setStoredOperation(graph: GraphData, operation: unknown): void {
  graph.automatic_operations_v1 = {
    version: 1,
    operations: [AutonomousPersonalOperationV4OwnedDataSchema.parse(operation)],
  };
}

function terminalReceipt(
  operation: Extract<
    ReturnType<typeof AutonomousPersonalOperationV4OwnedDataSchema.parse>,
    { state: 'leased' }
  >,
  cancelled = false,
) {
  const common = {
    version: 4,
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: operation.identity.descriptorHash,
    policyFingerprint: operation.identity.policyFingerprint,
    terminalAt: T1,
    acceptedCoverage: 'none',
  };
  if (cancelled) return { ...common, kind: 'cancelled' };
  return {
    ...common,
    kind: 'human_autonomous_source_verdict_committed',
    interpretationCoverage: 'complete',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage: {
      status: 'complete',
      scanStatus: 'complete',
      sourceUnitCount: 0,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    },
    selection: { kind: 'source_verdict', outcome: 'known_no_memory' },
  };
}

function withoutLease(
  operation: Extract<
    ReturnType<typeof AutonomousPersonalOperationV4OwnedDataSchema.parse>,
    { state: 'leased' }
  >,
) {
  const { lease: _lease, ...common } = operation;
  void _lease;
  return common;
}

describe('AutonomousPersonal snapshot preparation independent review cases', () => {
  it('uses message IDs only to locate human episodes and exact idempotency keys across roles', () => {
    const messageFixture = fixture();
    const messageInput = structuredClone(messageFixture.input);
    messageInput.request.source.sourceMessageId = 'shared-message-id';
    messageInput.stableBeginHash = hashAutonomousPersonalStableRequestV4({
      request: messageInput.request,
      context: messageInput.context,
    });
    const assistantEpisode = {
      ...structuredClone(messageFixture.old.source),
      uuid: uuidAt(30),
      group_id: messageInput.request.namespace,
      content: 'A tool produced this message.',
      role: 'ai' as const,
      source_type: 'message' as const,
      reference_time: T0,
      previous_episode_uuid: null,
      created_at: T0,
      updated_at: null,
      source_message_id: 'shared-message-id',
      idempotency_key: null,
      conversation_id: null,
      sender_id: null,
      sender_name: null,
      episode_kind: 'tool_output' as const,
      quoted_message_id: null,
      trust_level: 'untrusted' as const,
      confidence: null,
      review_status: 'proposed' as const,
      source_workflow_id: null,
      source_execution_id: null,
      attributes: {},
    };
    messageFixture.graph.episodes.push(assistantEpisode);
    const before = JSON.stringify(messageFixture.graph);
    const output = prepareAutonomousPersonalCaptureSnapshotV4(
      messageInput,
      messageFixture.graph,
      () => {},
    );
    expect(output.kind).toBe('initial_candidate');
    expect(JSON.stringify(messageFixture.graph)).toBe(before);

    const keyFixture = fixture();
    const keyEpisode = {
      ...structuredClone(keyFixture.old.source),
      uuid: uuidAt(31),
      group_id: keyFixture.input.request.namespace,
      role: 'ai' as const,
      source_type: 'message' as const,
      previous_episode_uuid: null,
      idempotency_key: automaticWriteOwnerIdempotencyKey({
        turn: keyFixture.input.request.turn,
        role: 'human',
      }),
      episode_kind: 'tool_output' as const,
      attributes: {},
    };
    keyFixture.graph.episodes.push(keyEpisode);
    const keyBefore = JSON.stringify(keyFixture.graph);
    expect(
      prepareAutonomousPersonalCaptureSnapshotV4(keyFixture.input, keyFixture.graph, () => {}),
    ).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(keyFixture.graph)).toBe(keyBefore);
  });

  it('rejects generated source and operation UUID collisions across graph kinds', () => {
    for (const collidedField of ['sourceId', 'operationId'] as const) {
      const { graph, input } = fixture();
      input[collidedField] = graph.entities[0]!.uuid;
      const before = JSON.stringify(graph);
      expect(prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {})).toEqual({
        kind: 'no_write',
        resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
      });
      expect(JSON.stringify(graph)).toBe(before);
    }

    const { graph, input } = fixture();
    input.operationId = input.sourceId;
    expect(prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
    });
  });

  it('reports a descriptor change on an existing Source4-only row as changed authority', () => {
    const { graph, input } = fixture();
    installFresh(graph, input);
    graph.automatic_operations_v1 = { version: 1, operations: [] };
    const changedRequest = structuredClone(input.request);
    changedRequest.settings.providerReference.routeId = 'changed-synthetic-route';
    const changed = {
      ...input,
      request: changedRequest,
      stableBeginHash: hashAutonomousPersonalStableRequestV4({
        request: changedRequest,
        context: input.context,
      }),
    };
    const before = JSON.stringify(graph);
    expect(prepareAutonomousPersonalCaptureSnapshotV4(changed, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'authority_changed', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects a recomputed first-capture timestamp that diverges from the original Operation4 time', () => {
    const { graph, input } = fixture();
    const initial = installFresh(graph, input);
    const changedTime = compileAutonomousPersonalFreshSourceV4({
      request: input.request,
      context: input.context,
      sourceId: input.sourceId,
      previousEpisodeUuid: initial.episode.previous_episode_uuid,
      createdAt: T1,
    });
    const storedEpisode = graph.episodes.find((episode) => episode.uuid === input.sourceId)!;
    storedEpisode.created_at = T1;
    storedEpisode.reference_time = T1;
    storedEpisode.attributes[AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE] = structuredClone(
      changedTime.tuple.owner,
    );
    storedEpisode.attributes[AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE] = structuredClone(
      changedTime.tuple.envelope,
    );
    const storedOperation = graph.automatic_operations_v1!.operations[0]!;
    if (storedOperation.version !== 4) throw new Error('Expected Operation4');
    storedOperation.identity = structuredClone(changedTime.tuple.identity);

    const replay = replayInput(input);
    const before = JSON.stringify(graph);
    expect(prepareAutonomousPersonalCaptureSnapshotV4(replay, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('returns state-specific false outcomes and exact terminal receipts for a new replay attempt', () => {
    for (const state of ['failed', 'interrupted'] as const) {
      const { graph, input } = fixture();
      const initial = installFresh(graph, input);
      const operationA = leasedOperation(initial.operation);
      const base = withoutLease(operationA);
      const operation = AutonomousPersonalOperationV4OwnedDataSchema.parse(
        state === 'failed'
          ? {
              ...base,
              state,
              generation: 1,
              lastObservedAt: T1,
              failedAt: T1,
              failureCode: 'storage_error',
            }
          : {
              ...base,
              state,
              generation: 1,
              lastObservedAt: T1,
              interruptedAt: T1,
              failureCode: 'lease_expired',
            },
      );
      setStoredOperation(graph, operation);
      const replay = replayInput(input);
      replay.backendNow = T2;
      const before = JSON.stringify(graph);
      expect(prepareAutonomousPersonalCaptureSnapshotV4(replay, graph, () => {})).toEqual({
        kind: 'no_write',
        resultProjection:
          state === 'failed'
            ? { kind: 'failed', failureCode: 'storage_error', eligibleFirstCommit: false }
            : { kind: 'interrupted', failureCode: 'lease_expired', eligibleFirstCommit: false },
      });
      expect(JSON.stringify(graph)).toBe(before);
    }

    for (const cancelled of [false, true]) {
      const { graph, input } = fixture();
      const initial = installFresh(graph, input);
      const operationA = leasedOperation(initial.operation);
      const base = withoutLease(operationA);
      const receipt = terminalReceipt(operationA, cancelled);
      const rawOperation = cancelled
        ? {
            ...base,
            state: 'cancelled',
            generation: 1,
            lastObservedAt: T1,
            terminalReceipt: receipt,
          }
        : {
            ...base,
            state: 'committed',
            generation: 1,
            lastObservedAt: T1,
            terminalReceipt: receipt,
            completionCallHash: hashAt(90),
          };
      const operation = AutonomousPersonalOperationV4OwnedDataSchema.parse(rawOperation);
      setStoredOperation(graph, operation);
      const replay = replayInput(input);
      replay.backendNow = T2;
      const before = JSON.stringify(graph);
      const output = prepareAutonomousPersonalCaptureSnapshotV4(replay, graph, () => {});
      expect(output.kind).toBe('audit_candidate');
      if (output.kind !== 'audit_candidate') throw new Error('Expected terminal audit data');
      expect(output.resultProjection).toEqual(
        cancelled
          ? { kind: 'cancelled_observed', terminalReceipt: receipt, eligibleFirstCommit: false }
          : { kind: 'committed_observed', terminalReceipt: receipt, eligibleFirstCommit: false },
      );
      if (output.operation.state === 'cancelled' || output.operation.state === 'committed') {
        expect(output.operation.terminalReceipt).toEqual(receipt);
      } else {
        throw new Error('Expected terminal Operation4');
      }
      expect(JSON.stringify(graph)).toBe(before);
    }
  });

  it('pairs audit candidates with the exact Operation4 state and receipt', () => {
    const { graph, input } = fixture();
    const initial = prepareFresh(graph, input);
    const leased = {
      kind: 'audit_candidate',
      operation: initial.operation,
      resultProjection: { kind: 'in_progress', eligibleFirstCommit: false },
    };
    expect(
      AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema.safeParse(leased).success,
    ).toBe(true);

    for (const resultProjection of [
      { kind: 'failed', failureCode: 'storage_error', eligibleFirstCommit: false },
      {
        kind: 'committed_observed',
        terminalReceipt: terminalReceipt(leasedOperation(initial.operation)),
        eligibleFirstCommit: false,
      },
    ]) {
      expect(
        AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema.safeParse({
          kind: 'audit_candidate',
          operation: initial.operation,
          resultProjection,
        }).success,
      ).toBe(false);
    }
  });

  it('requires every paired source and operation to retain the original claim_won attempt', () => {
    const corruptAttempts = [
      (_operation: AutonomousPersonalOperationV4) => ({ attempts: [] }),
      (operation: AutonomousPersonalOperationV4) => ({
        attempts: [
          {
            ...operation.attempts[0]!,
            disposition: 'in_progress' as const,
          },
        ],
      }),
      (operation: AutonomousPersonalOperationV4) => ({
        lastObservedAt: T1,
        attempts: [
          ...operation.attempts,
          { attemptHash: hashAt(92), at: T1, disposition: 'claim_won' as const },
        ],
      }),
    ];

    for (const corrupt of corruptAttempts) {
      const { graph, input } = fixture();
      const initial = installFresh(graph, input);
      const operation = leasedOperation(initial.operation);

      // Operation4 permits these standalone DATA rows, but a paired row used
      // by Begin4 must retain exactly one immutable original claim_won entry.
      setStoredOperation(graph, { ...operation, ...corrupt(operation) });
      const replay = replayInput(input);
      replay.backendNow = T2;
      const before = JSON.stringify(graph);

      expect(prepareAutonomousPersonalCaptureSnapshotV4(replay, graph, () => {})).toEqual({
        kind: 'no_write',
        resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
      });
      expect(JSON.stringify(graph)).toBe(before);
    }
  });
});
