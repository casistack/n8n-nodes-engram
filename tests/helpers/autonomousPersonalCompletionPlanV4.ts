import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'node:perf_hooks';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { randomUUID } from 'node:crypto';
import { EntityEdgeSchema } from '../../src/schemas/EntityEdge.schema';
import { EntityNodeSchema } from '../../src/schemas/EntityNode.schema';
import {
  closeAutonomousPersonalCaptureProviderStageAccessV4,
  consumeAutonomousPersonalCaptureProviderStageV4,
  getAutonomousPersonalCaptureProviderStageAccessV4,
  prepareNativeAutonomousPersonalCaptureProviderV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../src/storage/AutomaticClaimReadScope';
import type { GraphData } from '../../src/schemas';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from './autonomousPersonalCaptureBackend';

type StageOptions = {
  content?: string;
  profile?: 'conservative' | 'explicit' | 'reviewFirst';
  intent?: 'enabled' | 'disabled';
  providerAuthFailure?: boolean;
  executionId?: string;
  turn?: string;
};

async function openPlanStage(
  store: GraphologyStorage,
  seed: AutonomousPersonalCaptureSeed,
  options: StageOptions = {},
) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = JSON.parse(body.messages[1]!.content) as {
      units: Array<{ unitId: string }>;
    };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                version: 1,
                units: user.units.map(({ unitId }) => ({
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
  };
  let prepared: Awaited<ReturnType<typeof prepareNativeAutonomousPersonalCaptureProviderV4>>;
  try {
    prepared = await prepareNativeAutonomousPersonalCaptureProviderV4(
      nativeAutonomousPersonalCaptureContext(seed, {
        content: options.content ?? 'I prefer concise explanations.',
        deadlineMs: 30_000,
        executionId: options.executionId,
        credentials: options.providerAuthFailure
          ? { apiKey: '', baseUrl: 'https://memory.invalid/v1' }
          : undefined,
        extraParameters: {
          automaticMemoryProfile: options.profile ?? 'conservative',
          automaticIntent:
            options.intent ?? (options.profile === 'explicit' ? 'enabled' : 'disabled'),
          automaticTurn: options.turn ?? seed.request.turn,
        },
      }),
      store,
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
  if (prepared.kind !== 'prepared')
    throw new Error(`Expected a private provider stage: ${JSON.stringify(prepared)}`);
  const access = consumeAutonomousPersonalCaptureProviderStageV4(store, prepared.stage);
  try {
    const stage = getAutonomousPersonalCaptureProviderStageAccessV4(store, access);
    // This one post-provider start is shared by work and the legacy read scope.
    const planningStarted = performance.now();
    const exported = await store.exportGraph();
    const graph = JSON.parse(JSON.stringify(exported)) as GraphData;
    const budget = { remaining: 512, deferred: 0 };
    const readScope = getAutomaticClaimReadScope(budget);
    const snapshotBytes = Buffer.byteLength(JSON.stringify(graph), 'utf8');
    if (!reserveAutomaticClaimSnapshotBytes(readScope, snapshotBytes))
      throw new Error('Unable to reserve synthetic snapshot bytes');
    const stagedOperation = stage.view.stagedFresh.operation;
    const backendNow = new Date(
      Math.max(Date.now(), Date.parse(stagedOperation.lastObservedAt)),
    ).toISOString();
    const input = {
      scope: stage.view.scope,
      stagedFresh: stage.view.stagedFresh,
      outcome:
        stage.view.outcome.kind === 'response' ? { kind: 'response' as const } : stage.view.outcome,
      backendNow,
      completionCallHash: 'b'.repeat(64),
      audit: {
        action: 'completion',
        attemptIdHash: 'c'.repeat(64),
        operationId: stagedOperation.operationId,
        sourceId: stagedOperation.identity.sourceId,
      },
    };
    const work: AutonomousPersonalTypedSyntaxWorkV1 = {
      absoluteMonotonicDeadlineMs: Math.min(
        stage.view.overallDeadlineAtMonotonicMs,
        planningStarted + 5_000,
      ),
      signal: stage.signal,
    };
    return {
      graph,
      input,
      response: stage.view.outcome.kind === 'response' ? stage.view.outcome.response : null,
      selection: stage.view.selection,
      work,
      check: stage.check,
      budget,
      close: () => closeAutonomousPersonalCaptureProviderStageAccessV4(store, access),
    };
  } catch (error) {
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, access);
    throw error;
  }
}

export async function autonomousPersonalCompletionPlanFixtureV4(options: StageOptions = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-completion-plan-'));
  const store = new GraphologyStorage(join(directory, 'store.json'));
  await store.initialize();
  try {
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    const stage = await openPlanStage(store, seed, options);
    return {
      ...stage,
      store,
      directory,
      seed,
      close: async () => {
        stage.close();
        await store.close();
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Opens a second actual entry in the same store/namespace/actor fixture. */
export function autonomousPersonalCompletionPlanNextStageV4(
  store: GraphologyStorage,
  seed: AutonomousPersonalCaptureSeed,
  options: StageOptions,
) {
  return openPlanStage(store, seed, options);
}

/** Adds unowned PREFERS candidates that must remain in the legacy universe. */
export function appendManualLegacyPreferenceCandidatesV4(
  graph: GraphData,
  namespace: string,
  subjectId: string,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const valueId = randomUUID();
    const timestamp = graph.exported_at;
    graph.entities.push(
      EntityNodeSchema.parse({
        uuid: valueId,
        group_id: namespace,
        name: `Unowned legacy preference ${index}`,
        entity_type: 'concept',
        created_at: timestamp,
        updated_at: timestamp,
      }),
    );
    graph.edges.push(
      EntityEdgeSchema.parse({
        uuid: randomUUID(),
        group_id: namespace,
        source_node_uuid: subjectId,
        target_node_uuid: valueId,
        name: 'PREFERS',
        fact: `Unowned legacy preference ${index}`,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    );
  }
}

export type AutonomousPersonalCompletionPlanFixtureV4 = Awaited<
  ReturnType<typeof autonomousPersonalCompletionPlanFixtureV4>
>;
