import { performance } from 'node:perf_hooks';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  createAutonomousPersonalPersistedExistingStoreFixture,
  type AutonomousPersonalPersistedExistingStoreFixture,
} from '../helpers/autonomousPersonalExistingStoreFixture';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

function rowsByUuid<T extends { uuid: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.uuid, row]));
}

function personalClaimEdges(graph: Awaited<ReturnType<GraphologyStorage['exportGraph']>>) {
  return graph.edges.filter((edge) => {
    const claim = edge.attributes.engram_claim_v1;
    return (
      claim !== null && typeof claim === 'object' && (claim as { version?: unknown }).version === 3
    );
  });
}

describe('native completion after durable acknowledgement', () => {
  let fixture: AutonomousPersonalPersistedExistingStoreFixture | undefined;
  let reopened: GraphologyStorage | undefined;

  afterEach(async () => {
    jest.restoreAllMocks();
    await reopened?.close();
    await fixture?.close();
  });

  it('keeps a durable completion readable when its verification scope expires after acknowledgement', async () => {
    fixture = await createAutonomousPersonalPersistedExistingStoreFixture();
    const store = fixture.storage;
    const seed = await seedAutonomousPersonalCaptureSubject(store, fixture.graph.group_id);
    const beforeCompletion = await store.exportGraph(fixture.graph.group_id);
    const content = 'I prefer concise explanations.';
    const turn = seed.request.turn;
    const contextFor = (executionId: string) =>
      nativeAutonomousPersonalCaptureContext(seed, {
        executionId,
        deadlineMs: 90_000,
        content,
        extraParameters: {
          automaticMemoryProfile: 'explicit',
          automaticIntent: 'enabled',
          automaticTurn: turn,
        },
      });

    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const promptData = JSON.parse(requestBody.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: promptData.units.map(({ unitId }) => ({
                    unitId,
                    category: 'preference',
                    risk: 'ordinary',
                    usefulness: 'personal_memory',
                    downgrade: [],
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const actualNow = performance.now.bind(performance);
    let syntheticOffsetMs = 0;
    const clock = jest
      .spyOn(performance, 'now')
      .mockImplementation(() => actualNow() + syntheticOffsetMs);
    let acknowledgedCompletionCount = 0;
    const result = await store.withExtractionDiagnostics(
      (observation) => {
        if (observation.backend !== 'embedded' || !observation.acknowledged) return;
        const diagnostic = store.getLastMutationDiagnostics();
        if (
          diagnostic?.operation === 'autonomous_personal_completion_v4' &&
          diagnostic.success &&
          diagnostic.snapshot_written
        ) {
          acknowledgedCompletionCount += 1;
          syntheticOffsetMs += 6_000;
        }
      },
      () => completeNativeAutonomousPersonalCaptureV4(contextFor('execution:ack-timeout'), store),
    );
    expect(acknowledgedCompletionCount).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: 'no_origin', observation: { kind: 'unconfirmed' } });

    clock.mockRestore();
    let sameOwnerGraph: Awaited<ReturnType<GraphologyStorage['exportGraph']>> | undefined;
    let sameOwnerExportError: unknown;
    try {
      sameOwnerGraph = await store.exportGraph(fixture.graph.group_id);
    } catch (error) {
      sameOwnerExportError = error;
    }

    await store.close();
    reopened = new GraphologyStorage(fixture.file);
    await reopened.initialize();
    const persisted = await reopened.exportGraph(fixture.graph.group_id);
    const committedOperations =
      persisted.automatic_operations_v1?.operations.filter(
        (operation) => operation.identity.turn === turn && operation.state === 'committed',
      ) ?? [];
    expect(committedOperations).toHaveLength(1);
    const committedOperation = committedOperations[0];
    if (!committedOperation) throw new Error('Expected the committed turn operation');
    const persistedReceipt = Reflect.get(committedOperation, 'terminalReceipt') as unknown;
    expect(committedOperations[0]).toMatchObject({
      terminalReceipt: { kind: 'human_autonomous_capture_committed' },
    });
    expect(personalClaimEdges(persisted).length).toBeGreaterThan(0);
    const persistedOperationCount = persisted.automatic_operations_v1?.operations.length ?? 0;

    const persistedEpisodes = rowsByUuid(persisted.episodes);
    const persistedEntities = rowsByUuid(persisted.entities);
    const persistedEdges = rowsByUuid(persisted.edges);
    for (const row of beforeCompletion.episodes) {
      expect(persistedEpisodes.get(row.uuid)).toEqual(row);
    }
    for (const row of beforeCompletion.entities) {
      expect(persistedEntities.get(row.uuid)).toEqual(row);
    }
    for (const row of beforeCompletion.edges) {
      expect(persistedEdges.get(row.uuid)).toEqual(row);
    }
    for (const row of fixture.graph.episodes) {
      expect(persistedEpisodes.get(row.uuid)).toEqual(row);
    }
    for (const row of fixture.graph.entities) {
      expect(persistedEntities.get(row.uuid)).toEqual(row);
    }
    for (const row of fixture.graph.edges) {
      expect(persistedEdges.get(row.uuid)).toEqual(row);
    }

    const replay = await completeNativeAutonomousPersonalCaptureV4(
      contextFor('execution:ack-timeout-redelivery'),
      reopened,
    );
    expect(replay).toMatchObject({ kind: 'decision', result: { kind: 'committed_observed' } });
    expect(provider).toHaveBeenCalledTimes(1);
    const afterReplay = await reopened.exportGraph(fixture.graph.group_id);
    expect(afterReplay.episodes).toEqual(persisted.episodes);
    expect(afterReplay.entities).toEqual(persisted.entities);
    expect(afterReplay.edges).toEqual(persisted.edges);
    const replayedCommittedOperations =
      afterReplay.automatic_operations_v1?.operations.filter(
        (operation) => operation.identity.turn === turn && operation.state === 'committed',
      ) ?? [];
    expect(replayedCommittedOperations).toHaveLength(1);
    const replayedCommittedOperation = replayedCommittedOperations[0];
    if (!replayedCommittedOperation) throw new Error('Expected the replayed turn operation');
    expect(replayedCommittedOperation.operationId).toBe(committedOperation.operationId);
    expect(Reflect.get(replayedCommittedOperation, 'terminalReceipt')).toEqual(persistedReceipt);
    expect(afterReplay.automatic_operations_v1?.operations).toHaveLength(persistedOperationCount);

    // This is the regression assertion: the current implementation marks the owner
    // recovery-required when post-ACK verification times out, despite the durable receipt.
    expect(sameOwnerExportError).toBeUndefined();
    expect(sameOwnerGraph).toBeDefined();
  }, 30_000);
});
