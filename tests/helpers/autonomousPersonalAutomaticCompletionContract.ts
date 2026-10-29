import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import type { GraphData } from '../../src/schemas/GraphData.schema';
import { extractionMetadataFromAttributes } from '../../src/schemas/ExtractionMetadata.schema';
import {
  closeAutonomousPersonalCompletionV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  nativeAutonomousPersonalCaptureContext,
  type AutonomousPersonalCaptureSeed,
} from './autonomousPersonalCaptureBackend';

export interface AutonomousPersonalAutomaticCompletionFixture {
  readonly storage: IGraphStorage;
  readonly seed: AutonomousPersonalCaptureSeed;
  readPersisted(): Promise<GraphData>;
  reopen(): Promise<void>;
  cleanup(): Promise<void>;
}

export type AutonomousPersonalAutomaticCompletionFixtureFactory =
  () => Promise<AutonomousPersonalAutomaticCompletionFixture>;

function scopedGraph(graph: GraphData, namespace: string): GraphData {
  const snapshot = { ...graph };
  delete snapshot.group_id;
  return {
    ...snapshot,
    entities: graph.entities.filter((row) => row.group_id === namespace),
    edges: graph.edges.filter((row) => row.group_id === namespace),
    episodes: graph.episodes.filter((row) => row.group_id === namespace),
    ...(graph.automatic_operations_v1
      ? {
          automatic_operations_v1: {
            ...graph.automatic_operations_v1,
            operations: graph.automatic_operations_v1.operations.filter(
              (row) => row.identity.namespace === namespace,
            ),
          },
        }
      : {}),
  };
}

function byUuid<T extends { uuid: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.uuid.localeCompare(right.uuid));
}

/** Same native provider→completion→reopen→redelivery contract for both stores. */
export function autonomousPersonalAutomaticCompletionContract(
  createFixture: AutonomousPersonalAutomaticCompletionFixtureFactory,
): void {
  jest.setTimeout(90_000);
  it('automatically persists the complete ordinary preference and reuses its event across executions', async () => {
    const fixture = await createFixture();
    let store = fixture.storage;
    let handle: unknown;
    let handleOwner: IGraphStorage | undefined;
    try {
      const namespace = fixture.seed.request.namespace;
      const before = scopedGraph(await store.exportGraph(namespace), namespace);
      const content =
        'I prefer explanations in plain British English, with one practical example before any technical terminology.';
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        expect(body).not.toHaveProperty('temperature');
        const prompt = JSON.parse(body.messages[1]!.content) as {
          units: Array<{ unitId: string }>;
        };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    units: prompt.units.map(({ unitId }) => ({
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
      const prepared = await prepareNativeAutonomousPersonalCompletionV4(
        nativeAutonomousPersonalCaptureContext(fixture.seed, {
          content,
          executionId: 'synthetic:first',
        }),
        store,
      );
      expect(prepared.kind).toBe('completion_prepared');
      if (prepared.kind !== 'completion_prepared') throw new Error('Expected native preparation');
      handle = prepared.handle;
      handleOwner = store;
      const result = await store.completeAutonomousPersonalCaptureV4!(handle);
      expect(result).toEqual({ kind: 'matched' });
      expect(result).not.toHaveProperty('eligibleFirstCommit');
      closeAutonomousPersonalCompletionV4(handleOwner, handle);
      handle = undefined;
      handleOwner = undefined;

      const persisted = scopedGraph(await fixture.readPersisted(), namespace);
      const operation = persisted.automatic_operations_v1!.operations.find(
        (row) => row.version === 4 && row.state === 'committed',
      );
      if (!operation || operation.version !== 4 || operation.state !== 'committed')
        throw new Error('Expected a real stored terminal operation');
      expect(operation.descriptor.policy.profileId).toBe('conservative');
      expect(operation.descriptor.intentSetting).toBe(false);
      const receipt = operation.terminalReceipt;
      expect(receipt.kind).toBe('human_autonomous_capture_committed');
      if (receipt.kind !== 'human_autonomous_capture_committed')
        throw new Error('Expected persisted preference occurrences');
      expect(receipt.acceptedCoverage).toBe('all');
      expect(receipt.selection.items.every((item) => item.state === 'accepted')).toBe(true);
      const created = receipt.selection.items.filter((item) => item.effect === 'created');
      expect(created.length).toBeGreaterThan(0);
      for (const item of created) {
        const edge = persisted.edges.find((row) => row.uuid === item.claimId);
        expect(edge).toBeDefined();
        expect(extractionMetadataFromAttributes(edge!.attributes)?.review_status).toBe('accepted');
      }
      const source = persisted.episodes.find((row) => row.uuid === operation.identity.sourceId)!;
      expect(source.content).toBe(content);
      expect(source.source_execution_id).toBe('synthetic:first');
      const claims = JSON.stringify(persisted.edges);
      for (const term of ['British', 'English', 'practical', 'example', 'before', 'terminology'])
        expect(claims).toContain(term);
      for (const entity of before.entities)
        expect(persisted.entities.find((row) => row.uuid === entity.uuid)).toEqual(entity);
      for (const edge of before.edges)
        expect(persisted.edges.find((row) => row.uuid === edge.uuid)).toEqual(edge);

      await fixture.reopen();
      store = fixture.storage;
      const replay = await prepareNativeAutonomousPersonalCompletionV4(
        nativeAutonomousPersonalCaptureContext(fixture.seed, {
          content,
          executionId: 'synthetic:redelivery',
        }),
        store,
      );
      expect(replay).toEqual({
        kind: 'committed_observed',
        terminalReceipt: receipt,
        eligibleFirstCommit: false,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const afterReplay = scopedGraph(await fixture.readPersisted(), namespace);
      expect(byUuid(afterReplay.episodes)).toEqual(byUuid(persisted.episodes));
      expect(byUuid(afterReplay.entities)).toEqual(byUuid(persisted.entities));
      expect(byUuid(afterReplay.edges)).toEqual(byUuid(persisted.edges));
      expect(afterReplay.automatic_operations_v1!.operations).toHaveLength(
        persisted.automatic_operations_v1!.operations.length,
      );
      expect(afterReplay.episodes.find((row) => row.uuid === source.uuid)).toEqual(source);
    } finally {
      if (handle && handleOwner) closeAutonomousPersonalCompletionV4(handleOwner, handle);
      jest.restoreAllMocks();
      await fixture.cleanup();
    }
  });
}
