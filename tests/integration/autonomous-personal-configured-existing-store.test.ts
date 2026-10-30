import * as completionPlanner from '../../src/storage/AutonomousPersonalCompletionPlanV4';
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

describe('configured capture on existing embedded stores', () => {
  let fixture: AutonomousPersonalPersistedExistingStoreFixture | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await fixture?.close();
  });

  it.each([1, 5] as const)(
    'preserves original records and completes after five seconds of planning at scale %s',
    async (scale) => {
      const wallNow = performance.now.bind(performance);
      const setupStarted = wallNow();
      fixture = await createAutonomousPersonalPersistedExistingStoreFixture({ scale });
      const store = fixture.storage;
      const seed = await seedAutonomousPersonalCaptureSubject(store, fixture.graph.group_id);
      const before = await store.exportGraph(fixture.graph.group_id);
      const setupMs = wallNow() - setupStarted;
      const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
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
      const actualNow = performance.now.bind(performance);
      let offset = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => actualNow() + offset);
      const originalPlan = completionPlanner.planAutonomousPersonalCaptureCompletionV4;
      let shifted = false;
      jest
        .spyOn(completionPlanner, 'planAutonomousPersonalCaptureCompletionV4')
        .mockImplementation((...args) => {
          if (!shifted) {
            shifted = true;
            offset += 6000;
          }
          return originalPlan(...args);
        });
      const contextFor = (executionId: string) => {
        const ctx = nativeAutonomousPersonalCaptureContext(seed, {
          executionId,
          deadlineMs: 90_000,
          content: 'I prefer concise explanations.',
          extraParameters: { automaticMemoryProfile: 'explicit', automaticIntent: 'enabled' },
        });
        const node = ctx.getNode();
        Object.assign(ctx, {
          getNode: () => ({
            ...node,
            parameters: { ...node.parameters, automaticExecutionBudgetMode: 'configuredV1' },
          }),
        });
        return ctx;
      };
      const captureStarted = wallNow();
      const completed = await completeNativeAutonomousPersonalCaptureV4(
        contextFor('synthetic:first'),
        store,
      );
      const captureMs = wallNow() - captureStarted;
      expect(completed).toMatchObject({ kind: 'original_turn' });
      expect(shifted).toBe(true);
      const readbackStarted = wallNow();
      const after = await store.exportGraph(fixture.graph.group_id);
      for (const key of ['episodes', 'entities', 'edges'] as const) {
        const indexed = rowsByUuid<{ uuid: string }>(after[key]);
        for (const row of before[key]) expect(indexed.get(row.uuid)).toEqual(row);
      }
      expect(personalClaimEdges(after)).toHaveLength(personalClaimEdges(before).length + 1);
      const readbackMs = wallNow() - readbackStarted;
      const providerCalls = provider.mock.calls.length;
      const replayStarted = wallNow();
      const replay = await completeNativeAutonomousPersonalCaptureV4(
        contextFor('synthetic:replay'),
        store,
      );
      expect(replay).toMatchObject({ kind: 'decision', result: { kind: 'committed_observed' } });
      expect(provider.mock.calls).toHaveLength(providerCalls);
      const afterReplay = await store.exportGraph(fixture.graph.group_id);
      expect(afterReplay.episodes).toEqual(after.episodes);
      expect(afterReplay.entities).toEqual(after.entities);
      expect(afterReplay.edges).toEqual(after.edges);
      console.info('configured_existing_store_timings', {
        scale,
        setup_ms: setupMs,
        capture_ms: captureMs,
        readback_ms: readbackMs,
        replay_ms: wallNow() - replayStarted,
      });
    },
    // This new acceptance case includes fixture construction, a 90-second product
    // invocation, persisted readback and replay. The product deadlines are unchanged.
    120_000,
  );
});
