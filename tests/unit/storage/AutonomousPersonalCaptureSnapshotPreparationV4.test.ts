import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import type { AutonomousPersonalBeginV4Request } from '../../../src/schemas/AutonomousPersonalBeginV4.schema';
import type { AutonomousPersonalDescriptorV4Input } from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import type { AutonomousPersonalCaptureSnapshotPreparationV4Input } from '../../../src/schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import {
  hashAutonomousPersonalAttemptV4,
  hashAutonomousPersonalStableRequestV4,
  prepareAutonomousPersonalCaptureSnapshotV4,
} from '../../../src/storage/AutonomousPersonalCaptureBeginV4';
import { AutonomousPersonalOperationV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';

const ids = {
  source: '20000000-0000-4000-8000-000000000001',
  operation: '20000000-0000-4000-8000-000000000002',
  token: '20000000-0000-4000-8000-000000000003',
  replaySource: '20000000-0000-4000-8000-000000000004',
  replayOperation: '20000000-0000-4000-8000-000000000005',
  replayToken: '20000000-0000-4000-8000-000000000006',
};

const T0 = '2026-10-27T12:00:00.000Z';
const T1 = '2026-10-27T12:00:01.000Z';
const T2 = '2026-10-27T12:00:02.000Z';

const settings = (): AutonomousPersonalDescriptorV4Input => ({
  profileId: 'conservative',
  requestedTrustLevel: 'standard',
  intentSetting: false,
  invocationDeadlineMs: 30_000,
  providerReference: {
    routeId: 'synthetic-route',
    configurationFingerprint: 'd'.repeat(64),
    protocol: 'openai-compatible-json-v1',
    configuredRequestLimit: 2,
    configuredTimeoutMs: 30_000,
    configuredRequestBytes: 262_144,
    configuredResponseBytes: 65_536,
    temperature: { mode: 'providerDefault' },
    responseFormat: 'json_object',
    outputTokenLimit: { mode: 'omit' },
  },
});

function makeFixture(content = 'I prefer precise examples before technical detail.') {
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
    turn: 'source4-independent-event',
    settings: settings(),
    source: {
      content,
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
    binding: old.operation.identity.binding!,
    instance: 'synthetic-instance',
    workflow: 'synthetic-workflow',
    execution: 'execution-a',
  };
  const input: AutonomousPersonalCaptureSnapshotPreparationV4Input = {
    request,
    context,
    sourceId: ids.source,
    operationId: ids.operation,
    leaseToken: ids.token,
    stableBeginHash: hashAutonomousPersonalStableRequestV4({ request, context }),
    attemptHash: hashAutonomousPersonalAttemptV4(context),
    backendNow: T0,
    previousEpisodeId: old.source.uuid,
  };
  return { graph, request, context, input, previous: structuredClone(old.source) };
}

function installInitial(
  graph: ReturnType<typeof makeFixture>['graph'],
  input: AutonomousPersonalCaptureSnapshotPreparationV4Input,
) {
  const prepared = prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {});
  if (prepared.kind !== 'initial_candidate') throw new Error('Expected initial candidate DATA');
  graph.episodes.push(structuredClone(prepared.episode));
  graph.automatic_operations_v1 = {
    version: 1,
    operations: [structuredClone(prepared.operation)],
  };
  return prepared;
}

describe('AutonomousPersonalCaptureSnapshotPreparationV4', () => {
  it('prepares one complete fresh source and lease without mutating its snapshot', () => {
    const { graph, input, previous } = makeFixture();
    const before = JSON.stringify(graph);
    const prepared = prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {});
    expect(prepared.kind).toBe('initial_candidate');
    expect(JSON.stringify(graph)).toBe(before);
    if (prepared.kind !== 'initial_candidate') throw new Error('Expected initial candidate');
    expect(prepared.episode.previous_episode_uuid).toBe(previous.uuid);
    expect(prepared.episode.source_execution_id).toBe('execution-a');
    expect(prepared.episode.created_at).toBe(T0);
    expect(prepared.episode.reference_time).toBe(T0);
    expect(prepared.episode.updated_at).toBeNull();
    expect(prepared.episode.review_status).toBe('accepted');
    expect(prepared.operation.state).toBe('leased');
    expect(prepared.operation.generation).toBe(1);
    expect(prepared.operation.attempts).toHaveLength(1);
    expect(prepared.operation.attempts[0]?.attemptHash).toBe(input.attemptHash);
    expect(prepared.fence.operationId).toBe(input.operationId);
    expect(prepared.fence.sourceId).toBe(input.sourceId);
    expect(prepared).not.toHaveProperty('resultProjection');
    expect(prepared).not.toHaveProperty('handle');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(
      Object.isFrozen(prepared.episode.attributes[AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE]),
    ).toBe(true);
    expect(
      Object.isFrozen(prepared.episode.attributes[AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE]),
    ).toBe(true);
  });

  it('rejects an impossible fresh predecessor and detects a wrong initial lease token', () => {
    const { graph, input } = makeFixture();
    expect(
      prepareAutonomousPersonalCaptureSnapshotV4(
        { ...input, previousEpisodeId: null },
        graph,
        () => {},
      ),
    ).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
    });

    const installed = installInitial(graph, input);
    expect(installed.kind).toBe('initial_candidate');
    expect(
      prepareAutonomousPersonalCaptureSnapshotV4(
        { ...input, leaseToken: ids.replayToken },
        graph,
        () => {},
      ),
    ).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
    });
  });

  it('keeps A source fields and the B audit prefix on same-scope A readback', () => {
    const { graph, input } = makeFixture();
    const initial = installInitial(graph, input);
    const replayContext = { ...input.context, execution: 'execution-b' };
    const replay: AutonomousPersonalCaptureSnapshotPreparationV4Input = {
      ...input,
      context: replayContext,
      sourceId: ids.replaySource,
      operationId: ids.replayOperation,
      leaseToken: ids.replayToken,
      attemptHash: hashAutonomousPersonalAttemptV4(replayContext),
      backendNow: T1,
      previousEpisodeId: initial.episode.uuid,
    };
    const observed = prepareAutonomousPersonalCaptureSnapshotV4(replay, graph, () => {});
    expect(observed.kind).toBe('audit_candidate');
    if (observed.kind !== 'audit_candidate') throw new Error('Expected replay audit DATA');
    expect(observed.resultProjection).toEqual({
      kind: 'in_progress',
      eligibleFirstCommit: false,
    });
    graph.automatic_operations_v1!.operations = [structuredClone(observed.operation)];

    const readback = {
      ...input,
      backendNow: T2,
      previousEpisodeId: initial.episode.uuid,
    };
    const sameScope = prepareAutonomousPersonalCaptureSnapshotV4(readback, graph, () => {});
    expect(sameScope.kind).toBe('same_initial_scope_candidate');
    if (sameScope.kind !== 'same_initial_scope_candidate') {
      throw new Error('Expected same-scope candidate DATA');
    }
    expect(sameScope.operation.attempts).toHaveLength(2);
    expect(sameScope.operation.attempts[0]?.attemptHash).toBe(input.attemptHash);
    expect(sameScope.operation.attempts[1]?.attemptHash).toBe(replay.attemptHash);
    expect(sameScope.episode.source_execution_id).toBe('execution-a');
    expect(sameScope.episode.previous_episode_uuid).toBe(initial.episode.previous_episode_uuid);
    expect(sameScope.operation.lastObservedAt).toBe(T1);
    expect(sameScope.fence).toEqual(initial.fence);
  });

  it('retains a valid source-only orphan as unconfirmed without adopting it', () => {
    const { graph, input } = makeFixture();
    const initial = prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {});
    if (initial.kind !== 'initial_candidate') throw new Error('Expected initial candidate DATA');
    graph.episodes.push(structuredClone(initial.episode));
    const before = JSON.stringify(graph);
    expect(prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'source_only_unconfirmed', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('returns authority_changed when an existing operation has a different request descriptor or binding', () => {
    const { graph, input } = makeFixture();
    installInitial(graph, input);

    const changedRouteRequest = structuredClone(input.request);
    changedRouteRequest.settings.providerReference.configurationFingerprint = 'e'.repeat(64);
    const changedRoute = {
      ...input,
      request: changedRouteRequest,
      stableBeginHash: hashAutonomousPersonalStableRequestV4({
        request: changedRouteRequest,
        context: input.context,
      }),
    };
    expect(prepareAutonomousPersonalCaptureSnapshotV4(changedRoute, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'authority_changed', eligibleFirstCommit: false },
    });

    const changedContext = {
      ...input.context,
      binding: { ...input.context.binding, revision: input.context.binding.revision + 1 },
    };
    const changedBinding = {
      ...input,
      context: changedContext,
      stableBeginHash: hashAutonomousPersonalStableRequestV4({
        request: input.request,
        context: changedContext,
      }),
      attemptHash: hashAutonomousPersonalAttemptV4(changedContext),
    };
    expect(prepareAutonomousPersonalCaptureSnapshotV4(changedBinding, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'authority_changed', eligibleFirstCommit: false },
    });
  });

  it('classifies malformed snapshot data as conflict and returns resource bounds without throwing', () => {
    const { graph, input } = makeFixture();
    const malformed = new Proxy(graph, {
      ownKeys() {
        throw new Error('opaque proxy');
      },
    });
    expect(prepareAutonomousPersonalCaptureSnapshotV4(input, malformed, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
    });
    const oversized = {
      ...graph,
      episodes: [...graph.episodes, ...Array.from({ length: 100_001 }, (_, index) => ({ index }))],
    };
    expect(prepareAutonomousPersonalCaptureSnapshotV4(input, oversized, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'resource_exhausted', eligibleFirstCommit: false },
    });
  });

  it('keeps the complete legal escaped source and candidate below the existing 512 KiB bound', () => {
    const { graph, input } = makeFixture('\u0001'.repeat(65_536));
    const candidate = prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {});
    expect(candidate.kind).toBe('initial_candidate');
    expect(Buffer.byteLength(JSON.stringify(candidate), 'utf8')).toBeLessThanOrEqual(512 * 1024);
    if (candidate.kind !== 'initial_candidate') throw new Error('Expected initial candidate DATA');
    expect(candidate.episode.content).toBe('\u0001'.repeat(65_536));
    expect(AutonomousPersonalOperationV4OwnedDataSchema.parse(candidate.operation)).toEqual(
      candidate.operation,
    );
  });

  it('propagates and latches the original work-check exception', () => {
    const { graph, input } = makeFixture();
    const stopped = new Error('work cancelled');
    let calls = 0;
    let actual: unknown;
    try {
      prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {
        calls += 1;
        if (calls === 3) throw stopped;
      });
    } catch (error) {
      actual = error;
    }
    expect(actual).toBe(stopped);
    expect(calls).toBe(3);
  });
});
