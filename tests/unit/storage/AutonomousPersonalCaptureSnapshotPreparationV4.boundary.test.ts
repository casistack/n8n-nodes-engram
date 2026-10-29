import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { applyAutomaticBindingCommand } from '../../../src/storage/AutomaticIdentity';
import type { AutonomousPersonalBeginV4Request } from '../../../src/schemas/AutonomousPersonalBeginV4.schema';
import type { AutonomousPersonalCaptureSnapshotPreparationV4Input } from '../../../src/schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import {
  compileAutonomousPersonalFreshSourceV4,
  hashAutonomousPersonalAttemptV4,
  hashAutonomousPersonalStableRequestV4,
  prepareAutonomousPersonalCaptureSnapshotV4,
} from '../../../src/storage/AutonomousPersonalCaptureBeginV4';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';

const id = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-10-27T12:00:00.000Z';
const T1 = '2026-10-27T12:00:01.000Z';
const T2 = '2026-10-27T12:00:02.000Z';

function fixture() {
  const old = makeCompositionalCaptureFixture();
  const graph = structuredClone(old.graph);
  if (graph.group_id === undefined) delete graph.group_id;
  const request: AutonomousPersonalBeginV4Request = {
    version: 4,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    interpretationFamily: 'autonomous-personal-v1',
    namespace: old.source.group_id,
    issuer: old.input.request.issuer,
    actorReference: old.input.request.actorReference,
    turn: 'independent-event',
    settings: {
      profileId: 'conservative',
      requestedTrustLevel: 'standard',
      intentSetting: false,
      invocationDeadlineMs: 30_000,
      providerReference: {
        routeId: 'synthetic-route',
        configurationFingerprint: 'a'.repeat(64),
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
      content: 'I prefer one practical example before technical terminology.',
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
    instance: 'synthetic-instance',
    workflow: 'synthetic-workflow',
    execution: 'execution-a',
  };
  const input: AutonomousPersonalCaptureSnapshotPreparationV4Input = {
    request,
    context,
    sourceId: id(101),
    operationId: id(102),
    leaseToken: id(103),
    stableBeginHash: hashAutonomousPersonalStableRequestV4({ request, context }),
    attemptHash: hashAutonomousPersonalAttemptV4(context),
    backendNow: T0,
    previousEpisodeId: old.source.uuid,
  };
  return { graph, input };
}

function capturedFixture() {
  const { graph, input } = fixture();
  const candidate = prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {});
  if (candidate.kind !== 'initial_candidate') throw new Error('Expected initial candidate DATA');
  graph.episodes.push(structuredClone(candidate.episode));
  graph.automatic_operations_v1 = {
    version: 1,
    operations: [structuredClone(candidate.operation)],
  };
  const replay = structuredClone(input);
  replay.context.execution = 'execution-b';
  replay.sourceId = id(201);
  replay.operationId = id(202);
  replay.leaseToken = id(203);
  replay.attemptHash = hashAutonomousPersonalAttemptV4(replay.context);
  replay.backendNow = T1;
  replay.previousEpisodeId = candidate.episode.uuid;
  return { graph, input, replay, candidate };
}

describe('AutonomousPersonal snapshot preparation independent boundaries', () => {
  it('keeps old records intact and detaches fresh candidate rows', () => {
    const { graph, input } = fixture();
    const before = JSON.stringify(graph);
    const candidate = prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {});
    expect(candidate.kind).toBe('initial_candidate');
    expect(JSON.stringify(graph)).toBe(before);
    expect(Object.isFrozen(graph)).toBe(false);
    if (candidate.kind !== 'initial_candidate') throw new Error('Expected initial candidate');
    expect(candidate.episode.previous_episode_uuid).toBe(input.previousEpisodeId);
    expect(candidate.episode.source_execution_id).toBe('execution-a');
    expect(candidate.episode.review_status).toBe('accepted');
    expect(candidate.episode.trust_level).toBe('standard');
    expect(Object.isFrozen(candidate.episode.attributes)).toBe(true);
    expect(candidate).not.toHaveProperty('resultProjection');
    expect(candidate).not.toHaveProperty('handle');
  });

  it('preserves a concurrent B audit during A readback with A now at the tail', () => {
    const { graph, input, replay, candidate } = capturedFixture();
    const sourceBefore = JSON.stringify(graph.episodes);
    const observed = prepareAutonomousPersonalCaptureSnapshotV4(replay, graph, () => {});
    expect(observed.kind).toBe('audit_candidate');
    if (observed.kind !== 'audit_candidate') throw new Error('Expected B audit candidate');
    expect(observed.resultProjection).toEqual({ kind: 'in_progress', eligibleFirstCommit: false });
    graph.automatic_operations_v1!.operations = [structuredClone(observed.operation)];
    const readback = {
      ...input,
      backendNow: T2,
      previousEpisodeId: candidate.episode.uuid,
    };
    const actual = prepareAutonomousPersonalCaptureSnapshotV4(readback, graph, () => {});
    expect(actual.kind).toBe('same_initial_scope_candidate');
    if (actual.kind !== 'same_initial_scope_candidate') throw new Error('Expected A scope DATA');
    expect(actual.operation).toEqual(observed.operation);
    expect(actual.operation.attempts.map((attempt) => attempt.attemptHash)).toEqual([
      input.attemptHash,
      replay.attemptHash,
    ]);
    expect(actual.episode).toEqual(candidate.episode);
    expect(actual.fence).toEqual(candidate.fence);
    expect(JSON.stringify(graph.episodes)).toBe(sourceBefore);
    expect(actual).not.toHaveProperty('handle');
  });

  it('checks replay hashes against processing context before creating an audit candidate', () => {
    const { graph, replay } = capturedFixture();
    const before = JSON.stringify(graph);
    for (const mutation of [{ attemptHash: 'f'.repeat(64) }, { stableBeginHash: 'e'.repeat(64) }]) {
      expect(
        prepareAutonomousPersonalCaptureSnapshotV4({ ...replay, ...mutation }, graph, () => {}),
      ).toEqual({
        kind: 'no_write',
        resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
      });
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects a self-consistent rewritten source whose begin hash still describes the old text', () => {
    const { graph, input, replay, candidate } = capturedFixture();
    const changedRequest = structuredClone(input.request);
    changedRequest.source.content = 'I prefer a completely different style.';
    const changed = compileAutonomousPersonalFreshSourceV4({
      request: changedRequest,
      context: input.context,
      sourceId: input.sourceId,
      previousEpisodeUuid: candidate.episode.previous_episode_uuid,
      createdAt: candidate.episode.created_at,
    });
    const row = graph.episodes.find((episode) => episode.uuid === input.sourceId)!;
    row.content = changed.producer.content;
    row.attributes[AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE] = structuredClone(changed.tuple.owner);
    row.attributes[AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE] = structuredClone(
      changed.tuple.envelope,
    );
    const operation = graph.automatic_operations_v1!.operations[0]!;
    if (operation.version !== 4) throw new Error('Expected V4 operation');
    operation.identity = structuredClone(changed.tuple.identity);
    expect(operation.beginCallHash).toBe(input.stableBeginHash);
    expect(
      reconstructAutonomousPersonalStoredSourceIdentityV4({
        source: row,
        descriptor: operation.descriptor,
      }).tuple.identity,
    ).toEqual(operation.identity);
    const before = JSON.stringify(graph);
    expect(prepareAutonomousPersonalCaptureSnapshotV4(replay, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects raw accessors and proxies without triggering them', () => {
    const { graph, input } = fixture();
    let reads = 0;
    const accessor = Object.defineProperty({}, 'request', {
      enumerable: true,
      get() {
        reads += 1;
        return input.request;
      },
    });
    expect(prepareAutonomousPersonalCaptureSnapshotV4(accessor, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'invalid_input', eligibleFirstCommit: false },
    });
    const proxy = new Proxy(graph, {
      get() {
        reads += 1;
        throw new Error('Must not read proxy');
      },
      ownKeys() {
        reads += 1;
        throw new Error('Must not enumerate proxy');
      },
    });
    expect(prepareAutonomousPersonalCaptureSnapshotV4(input, proxy, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'conflict', eligibleFirstCommit: false },
    });
    expect(reads).toBe(0);
  });

  it('reports revoked current binding before replay audit or terminal observation', () => {
    const { graph, replay } = capturedFixture();
    const binding = replay.context.binding;
    applyAutomaticBindingCommand(
      graph,
      {
        action: 'revoke',
        namespace: replay.context.namespace,
        bindingId: binding.bindingId,
        expectedRevision: binding.revision,
        authorizedBy: 'synthetic-operator',
        reason: 'synthetic revocation',
      },
      id(999),
      T1,
    );
    const before = JSON.stringify(graph);
    expect(prepareAutonomousPersonalCaptureSnapshotV4(replay, graph, () => {})).toEqual({
      kind: 'no_write',
      resultProjection: { kind: 'authority_changed', eligibleFirstCommit: false },
    });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('classifies changed route or binding commitments as changed authority', () => {
    const { graph, replay } = capturedFixture();
    const routeChanged = structuredClone(replay);
    routeChanged.request.settings.providerReference.routeId = 'different-synthetic-route';
    const bindingChanged = structuredClone(replay);
    bindingChanged.context.binding.revision += 1;
    bindingChanged.context.binding.fingerprint = 'f'.repeat(64);
    const before = JSON.stringify(graph);
    for (const input of [routeChanged, bindingChanged]) {
      input.stableBeginHash = hashAutonomousPersonalStableRequestV4({
        request: input.request,
        context: input.context,
      });
      expect(prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {})).toEqual({
        kind: 'no_write',
        resultProjection: { kind: 'authority_changed', eligibleFirstCommit: false },
      });
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects producer metadata that the episode schema would normalize', () => {
    const { graph, input } = fixture();
    const before = JSON.stringify(graph);
    for (const field of ['sourceMessageId', 'sourceWorkflowId'] as const) {
      const changed = structuredClone(input);
      changed.request.source[field] = ' exact identifier with outer spaces ';
      changed.stableBeginHash = hashAutonomousPersonalStableRequestV4({
        request: changed.request,
        context: changed.context,
      });
      expect(prepareAutonomousPersonalCaptureSnapshotV4(changed, graph, () => {})).toEqual({
        kind: 'no_write',
        resultProjection: { kind: 'invalid_input', eligibleFirstCommit: false },
      });
    }
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('propagates the original work-check exception even if the next check would succeed', () => {
    const { graph, input } = fixture();
    const stopped = new Error('synthetic cancellation');
    let checks = 0;
    let thrown: unknown;
    try {
      prepareAutonomousPersonalCaptureSnapshotV4(input, graph, () => {
        checks += 1;
        if (checks === 3) throw stopped;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(stopped);
  });
});
