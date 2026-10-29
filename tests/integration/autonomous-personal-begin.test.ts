import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { GraphData } from '../../src/schemas';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  dispatchNativeAutonomousPersonalCaptureV4,
  getAutonomousPersonalCaptureBeginV4InternalResultSchema,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import type { AutonomousPersonalCaptureSeed } from '../helpers/autonomousPersonalCaptureBackend';

describe('embedded native Autonomous Personal V4 initial admission', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;
  let providerFetch: jest.SpyInstance;

  beforeEach(async () => {
    providerFetch = jest.spyOn(globalThis, 'fetch');
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-autonomous-v4-begin-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    const providerFetchCalls = providerFetch.mock.calls.length;
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    expect(providerFetchCalls).toBe(0);
  });

  const snapshot = async () => JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
  const begin = (options: Parameters<typeof nativeAutonomousPersonalCaptureContext>[1] = {}) =>
    dispatchNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed, options),
      store,
    );

  it('writes one exact original Source4 episode, initial Operation4, and chained row before one opaque handle', async () => {
    const previous = await store.appendEpisode({
      group_id: seed.request.namespace,
      content: 'Prior synthetic human event.',
      role: 'human',
      reference_time: '2026-01-01T00:00:00.000Z',
    });
    const before = await snapshot();
    const result = await begin({ executionId: 'execution:A' });

    expect(result.kind).toBe('claimed');
    expect(result.eligibleFirstCommit).toBe(false);
    if (result.kind !== 'claimed') throw new Error('Expected initial V4 handle');
    expect(Object.keys(result.handle)).toEqual([]);
    expect(JSON.parse(JSON.stringify(result.handle))).toEqual({});
    const runtimeResultSchema = getAutonomousPersonalCaptureBeginV4InternalResultSchema();
    expect(runtimeResultSchema.safeParse(result).success).toBe(true);
    expect(
      runtimeResultSchema.safeParse({
        ...result,
        handle: { ...result.handle },
      }).success,
    ).toBe(false);
    expect(
      runtimeResultSchema.safeParse({ ...result, sourceId: '20000000-0000-4000-8000-000000000001' })
        .success,
    ).toBe(false);
    expect(
      runtimeResultSchema.safeParse({
        ...result,
        operationId: '20000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(false);
    expect(
      runtimeResultSchema.safeParse({ ...result, descriptorHash: 'f'.repeat(64) }).success,
    ).toBe(false);

    const graph = await snapshot();
    expect(graph.entities).toEqual(before.entities);
    expect(graph.edges).toEqual(before.edges);
    expect(graph.episodes).toHaveLength(2);
    const source = graph.episodes.find((episode) => episode.uuid === result.sourceId)!;
    const operation = graph.automatic_operations_v1!.operations.find(
      (row) => row.operationId === result.operationId,
    )!;
    expect(source).toMatchObject({
      content: 'I prefer concise explanations.',
      group_id: seed.request.namespace,
      source_execution_id: 'execution:A',
      source_workflow_id: 'workflow:source',
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      previous_episode_uuid: previous.episode.uuid,
      review_status: 'accepted',
    });
    expect(source.reference_time).toBe(source.created_at);
    expect(source.updated_at).toBeNull();
    expect(source.attributes).toHaveProperty('engram_write_owner_v4');
    expect(source.attributes).toHaveProperty('engram_source_envelope_v3');
    expect(operation).toMatchObject({
      version: 4,
      operationId: result.operationId,
      state: 'leased',
      generation: 1,
      retryCount: 0,
      identity: {
        sourceId: result.sourceId,
        namespace: seed.request.namespace,
        issuer: seed.request.issuer,
        actorReference: seed.request.actorReference,
        turn: seed.request.turn,
      },
      lease: { claimKind: 'initial' },
      attempts: [{ disposition: 'claim_won', at: operation.createdAt }],
    });
    expect(operation.createdAt).toBe(source.created_at);
    expect(graph.metadata?.extraction_epoch).not.toBe(before.metadata?.extraction_epoch);
  });

  it('redelivery B keeps A source and first claim while appending only a B observation without an epoch bump', async () => {
    const first = await begin({ executionId: 'execution:A' });
    expect(first.kind).toBe('claimed');
    const beforeReplay = await snapshot();
    const sourceA = beforeReplay.episodes[0];
    const opA = beforeReplay.automatic_operations_v1!.operations[0];
    const epochA = beforeReplay.metadata?.extraction_epoch;

    const replay = await begin({ executionId: 'execution:B' });
    expect(replay).toEqual({ kind: 'in_progress', eligibleFirstCommit: false });
    const afterReplay = await snapshot();
    expect(afterReplay.entities).toEqual(beforeReplay.entities);
    expect(afterReplay.edges).toEqual(beforeReplay.edges);
    expect(afterReplay.episodes).toEqual(beforeReplay.episodes);
    expect(afterReplay.metadata?.extraction_epoch).toBe(epochA);
    const opB = afterReplay.automatic_operations_v1!.operations[0];
    expect(opB.operationId).toBe(opA.operationId);
    expect(opB.attempts[0]).toEqual(opA.attempts[0]);
    expect(opB.attempts).toHaveLength(2);
    expect(opB.attempts[1].disposition).toBe('in_progress');
    expect(opB.attempts[1].attemptHash).not.toBe(opA.attempts[0].attemptHash);
    expect(afterReplay.episodes[0].source_execution_id).toBe('execution:A');
    expect(afterReplay.episodes[0]).toEqual(sourceA);
    expect(replay).not.toHaveProperty('handle');
  });

  it.each([
    ['content', { content: 'I prefer a different format.' }],
    ['provider route', { routeId: 'route:changed' }],
  ] as const)(
    'rejects changed %s on the same event without changing rows',
    async (_name, options) => {
      await begin({ executionId: 'execution:A' });
      const before = JSON.stringify(await snapshot());
      const result = await begin({ executionId: 'execution:B', ...options });
      expect(result.kind).not.toBe('claimed');
      expect(JSON.stringify(await snapshot())).toBe(before);
    },
  );

  it('returns authority_changed after binding revocation and leaves the source/op rows unchanged', async () => {
    await begin({ executionId: 'execution:A' });
    const binding = seed.binding;
    await store.automaticBindingCommand!({
      action: 'revoke',
      namespace: binding.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Test current binding revocation',
    });
    const before = JSON.stringify(await snapshot());

    expect(await begin({ executionId: 'execution:B' })).toEqual({
      kind: 'authority_changed',
      eligibleFirstCommit: false,
    });
    expect(JSON.stringify(await snapshot())).toBe(before);
  });

  it('serializes first admissions from independent storage instances to one initial handle', async () => {
    const other = new GraphologyStorage(file);
    await other.initialize();
    try {
      const results = await Promise.all([
        begin({ executionId: 'execution:A' }),
        dispatchNativeAutonomousPersonalCaptureV4(
          nativeAutonomousPersonalCaptureContext(seed, { executionId: 'execution:B' }),
          other,
        ),
      ]);
      expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'in_progress')).toHaveLength(1);
      const graph = await snapshot();
      expect(
        graph.episodes.filter((episode) => episode.episode_kind === 'active_human'),
      ).toHaveLength(1);
      expect(graph.automatic_operations_v1!.operations).toHaveLength(1);
      expect(graph.automatic_operations_v1!.operations[0].attempts).toHaveLength(2);
    } finally {
      await other.close();
    }
  });

  it('rejects a live key on duplicate and foreign storage calls without consuming the original owner', async () => {
    const other = new GraphologyStorage(file);
    await other.initialize();
    const originalBegin = store.beginAndClaimAutonomousPersonalCaptureV4!.bind(store);
    let capturedInput: unknown;
    let capturedAttempt: unknown;
    let releaseAttempt!: () => void;
    const attemptReady = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    jest
      .spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4')
      .mockImplementation((input, attempt) => {
        capturedInput = input;
        capturedAttempt = attempt;
        releaseAttempt();
        return originalBegin(input, attempt);
      });
    const otherInternal = other as unknown as {
      runMutation: (...args: unknown[]) => Promise<unknown>;
    };
    const otherMutation = jest.spyOn(otherInternal, 'runMutation');
    const original = begin({ executionId: 'execution:A' });
    await attemptReady;

    const ownerInternal = store as unknown as {
      runMutation: (...args: unknown[]) => Promise<unknown>;
    };
    const ownerMutation = jest.spyOn(ownerInternal, 'runMutation');
    const ownerCallsBeforeDuplicate = ownerMutation.mock.calls.length;
    expect(
      await store.beginAndClaimAutonomousPersonalCaptureV4!(capturedInput, capturedAttempt),
    ).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
    expect(ownerMutation).toHaveBeenCalledTimes(ownerCallsBeforeDuplicate);

    expect(
      await other.beginAndClaimAutonomousPersonalCaptureV4!(capturedInput, capturedAttempt),
    ).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
    expect(otherMutation).not.toHaveBeenCalled();
    expect((await original).kind).toBe('claimed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).episodes).toHaveLength(1);
    await other.close();
  });

  it('reopens with A provenance and refuses a reused attempt key before storage reads', async () => {
    const originalBegin = store.beginAndClaimAutonomousPersonalCaptureV4!.bind(store);
    let capturedInput: unknown;
    let capturedAttempt: unknown;
    jest
      .spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4')
      .mockImplementation(async (input, attempt) => {
        capturedInput = input;
        capturedAttempt = attempt;
        return originalBegin(input, attempt);
      });
    const first = await begin({ executionId: 'execution:A' });
    expect(first.kind).toBe('claimed');
    await store.close();
    store = new GraphologyStorage(file);
    await store.initialize();
    const replay = await dispatchNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed, { executionId: 'execution:B' }),
      store,
    );
    expect(replay.kind).toBe('in_progress');
    const graph = await snapshot();
    expect(graph.episodes[0].source_execution_id).toBe('execution:A');
    expect(graph.automatic_operations_v1!.operations[0].attempts[0].disposition).toBe('claim_won');

    const readSpy = jest.spyOn(store, 'exportGraph');
    expect(
      await store.beginAndClaimAutonomousPersonalCaptureV4!(capturedInput, capturedAttempt),
    ).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
    expect(
      await store.beginAndClaimAutonomousPersonalCaptureV4!(capturedInput, {
        ...(capturedAttempt as object),
      }),
    ).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('rolls back a known embedded snapshot failure without leaving source, operation, or epoch changes', async () => {
    const before = JSON.stringify(await snapshot());
    const internal = store as unknown as {
      writeSnapshotUnderLock: (...args: unknown[]) => Promise<unknown>;
    };
    jest
      .spyOn(internal, 'writeSnapshotUnderLock')
      .mockRejectedValueOnce(new Error('known pre-rename failure'));

    const result = await begin({ executionId: 'execution:A' });
    expect(result).toEqual({ kind: 'storage_error', eligibleFirstCommit: false });
    expect(JSON.stringify(await snapshot())).toBe(before);
  });

  it('keeps a committed initial pair but returns no handle when commit finishes after the deadline', async () => {
    const internal = store as unknown as {
      writeSnapshotUnderLock: (...args: unknown[]) => Promise<unknown>;
    };
    const write = internal.writeSnapshotUnderLock.bind(store);
    jest.spyOn(internal, 'writeSnapshotUnderLock').mockImplementation(async (...args) => {
      await write(...args);
      await new Promise((resolve) => setTimeout(resolve, 1_150));
    });

    const result = await begin({ executionId: 'execution:late-commit', deadlineMs: 1_000 });
    expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
    const graph = await snapshot();
    expect(graph.episodes).toHaveLength(1);
    expect(graph.episodes[0].source_execution_id).toBe('execution:late-commit');
    expect(graph.automatic_operations_v1!.operations).toHaveLength(1);
    expect(graph.automatic_operations_v1!.operations[0].attempts[0].disposition).toBe('claim_won');
  });

  it('keeps the existing V2 API usable for ordinary callers', async () => {
    const legacy = await store.beginAndClaimAutomaticCaptureV2(seed.request);
    expect(legacy.kind).toBe('claimed');
  });
});
