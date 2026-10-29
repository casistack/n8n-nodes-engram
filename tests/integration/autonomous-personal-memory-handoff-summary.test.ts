import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  completeNativeAutonomousPersonalCaptureV4,
  type PrivateAutonomousPersonalOriginalTurnV4,
} from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  getAutonomousPersonalMemoryLineageOriginV4,
  publishAutonomousPersonalMemoryHandoffV4,
  publishAutonomousPersonalMemoryHandoffWithSummaryV4,
  type NativeAutonomousPersonalMemoryContextV4,
} from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import { projectAutonomousPersonalCaptureReceiptSummaryV4 as memoryProjector } from '../../src/memory/AutonomousPersonalCaptureReceiptSummaryV4';
import { projectAutonomousPersonalCaptureReceiptSummaryV4 as storageProjector } from '../../src/storage/AutonomousPersonalCaptureReceiptSummaryV4';
import * as receiptSummaryProjector from '../../src/storage/AutonomousPersonalCaptureReceiptSummaryV4';
import { AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema } from '../../src/schemas/AutonomousPersonalMemoryHandoffV4.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

type ProviderBody = {
  messages: Array<{ role: string; content: string }>;
};

type ReceiptKind =
  | 'human_autonomous_capture_committed'
  | 'human_autonomous_source_deferred_committed'
  | 'human_autonomous_source_verdict_committed';

describe('native personal Memory handoff summary V4', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-memory-handoff-summary-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function contextFor(
    turn: string,
    intent: 'enabled' | 'disabled' = 'enabled',
    executionId = `execution:${turn}`,
  ) {
    return nativeAutonomousPersonalCaptureContext(seed, {
      executionId,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content: 'I prefer concise explanations.',
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: intent,
        automaticTurn: turn,
      },
    });
  }

  function installProvider(mode: 'success' | 'unavailable' | 'unexpected') {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (mode === 'unexpected') throw new Error('unexpected_native_provider_dispatch');
      if (mode === 'unavailable') return new Response('synthetic unavailable', { status: 503 });

      const body = JSON.parse(String(init?.body)) as ProviderBody;
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
    });
  }

  async function prepareRealBridge(
    turn: string,
    intent: 'enabled' | 'disabled',
    providerMode: 'success' | 'unavailable' | 'unexpected',
  ) {
    const fetchSpy = installProvider(providerMode);
    const ctx = contextFor(turn, intent);
    let completed: Awaited<ReturnType<typeof completeNativeAutonomousPersonalCaptureV4>>;
    try {
      completed = await completeNativeAutonomousPersonalCaptureV4(ctx, store);
    } finally {
      fetchSpy.mockRestore();
    }
    if (completed.kind !== 'original_turn')
      throw new Error(`Expected a genuine original-turn bridge, got ${completed.kind}`);

    const graph = await store.exportGraph(seed.request.namespace);
    const operation = graph.automatic_operations_v1?.operations.find(
      (candidate) =>
        candidate.version === 4 &&
        candidate.state === 'committed' &&
        candidate.identity.turn === turn,
    );
    if (!operation || operation.version !== 4 || operation.state !== 'committed')
      throw new Error('Expected the actual committed Operation4 for the handoff source');
    return { ctx, bridge: completed.origin, operation };
  }

  function locator(identity: {
    storeHash: string;
    namespace: string;
    issuer: string;
    actorReference: string;
    turn: string;
    sourceId: string;
  }) {
    return identity;
  }

  function consume(
    ctx: NativeAutonomousPersonalMemoryContextV4,
    identity: Parameters<typeof locator>[0],
  ) {
    return consumeAutonomousPersonalMemoryHandoffV4(
      ctx,
      identity.storeHash,
      identity.namespace,
      identity.issuer,
      identity.actorReference,
      identity.turn,
      identity.sourceId,
    );
  }

  it.each([
    ['occurrence', 'enabled', 'success', 'human_autonomous_capture_committed', 'occurrences'],
    [
      'provider-deferred',
      'enabled',
      'unavailable',
      'human_autonomous_source_deferred_committed',
      'source_only_deferred',
    ],
    [
      'source-verdict',
      'disabled',
      'unexpected',
      'human_autonomous_source_verdict_committed',
      'source_verdict',
    ],
  ] as const)(
    'publishes a strict summary for the real %s receipt and consumes the same one-use lineage',
    async (name, intent, providerMode, receiptKind: ReceiptKind, selectionKind) => {
      const turn = `summary-${name}-${randomUUID()}`;
      const { ctx, bridge, operation } = await prepareRealBridge(turn, intent, providerMode);
      expect(operation.terminalReceipt.kind).toBe(receiptKind);

      const result = publishAutonomousPersonalMemoryHandoffWithSummaryV4(ctx, store, bridge);
      expect(result.kind).toBe('published');
      if (result.kind !== 'published') throw new Error('Expected a published summary handoff');
      expect(result.sourceId).toBe(operation.identity.sourceId);
      expect(result.summary.kind).toBe('committed');
      if (result.summary.kind !== 'committed')
        throw new Error('Expected a committed receipt summary');
      expect(result.summary.sourceId).toBe(result.sourceId);
      expect(result.summary.selection.kind).toBe(selectionKind);
      expect(
        AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema.safeParse(result)
          .success,
      ).toBe(true);
      expect(
        AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema.safeParse({
          ...result,
          sourceId: randomUUID(),
        }).success,
      ).toBe(false);
      expect(
        AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema.safeParse({
          ...result,
          proof: {},
        }).success,
      ).toBe(false);
      expect(
        AutonomousPersonalMemoryHandoffPublishWithSummaryResultV4OwnedDataSchema.safeParse({
          ...result,
          summary: { ...result.summary, sourceId: randomUUID() },
        }).success,
      ).toBe(false);
      expect(Reflect.ownKeys(result).sort()).toEqual(['kind', 'sourceId', 'summary']);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.summary)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('I prefer concise explanations.');
      expect(result).not.toHaveProperty('origin');
      expect(result).not.toHaveProperty('proof');
      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('nativeTuple');

      const key = locator(operation.identity);
      const memoryContext = {
        getInstanceId: () => ctx.getInstanceId(),
        getWorkflow: () => ctx.getWorkflow(),
        getExecutionId: () => ctx.getExecutionId(),
      } as NativeAutonomousPersonalMemoryContextV4;
      const lineage = consume(memoryContext, key);
      expect(lineage).not.toBeNull();
      const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
      expect(origin?.identity).toEqual(operation.identity);
      expect(origin?.terminalReceipt).toEqual(operation.terminalReceipt);
      expect(consume(memoryContext, key)).toBeNull();
    },
  );

  it('keeps the existing publisher result shape and returns one shared projector from both paths', async () => {
    expect(memoryProjector).toBe(storageProjector);

    const turn = `summary-legacy-${randomUUID()}`;
    const { ctx, bridge, operation } = await prepareRealBridge(turn, 'disabled', 'unexpected');
    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'published',
      sourceId: operation.identity.sourceId,
    });
  });

  it('rejects copied and foreign-owner tokens without spending the real token', async () => {
    const turn = `summary-token-${randomUUID()}`;
    const { ctx, bridge, operation } = await prepareRealBridge(turn, 'disabled', 'unexpected');
    const foreignOwner = new GraphologyStorage();
    await foreignOwner.initialize();
    try {
      expect(
        publishAutonomousPersonalMemoryHandoffWithSummaryV4(ctx, foreignOwner, bridge),
      ).toEqual({ kind: 'not_published' });
    } finally {
      await foreignOwner.close();
    }
    expect(
      publishAutonomousPersonalMemoryHandoffWithSummaryV4(ctx, store, {
        ...(bridge as object),
      } as PrivateAutonomousPersonalOriginalTurnV4),
    ).toEqual({ kind: 'not_published' });

    const result = publishAutonomousPersonalMemoryHandoffWithSummaryV4(ctx, store, bridge);
    expect(result.kind).toBe('published');
    expect(result.kind === 'published' && result.sourceId).toBe(operation.identity.sourceId);
  });

  it('rejects a mismatched native tuple without publishing summary or pending lineage', async () => {
    const turn = `summary-native-mismatch-${randomUUID()}`;
    const { ctx, bridge, operation } = await prepareRealBridge(turn, 'disabled', 'unexpected');
    const wrongContext = {
      getInstanceId: () => ctx.getInstanceId(),
      getWorkflow: () => ctx.getWorkflow(),
      getExecutionId: () => `foreign:${turn}`,
    } as NativeAutonomousPersonalMemoryContextV4;

    expect(
      publishAutonomousPersonalMemoryHandoffWithSummaryV4(wrongContext, store, bridge),
    ).toEqual({ kind: 'not_published' });
    expect(consume(ctx, locator(operation.identity))).toBeNull();
  });

  it('does not create a pending lineage when strict summary projection fails', async () => {
    const turn = `summary-projection-failure-${randomUUID()}`;
    const { ctx, bridge, operation } = await prepareRealBridge(turn, 'disabled', 'unexpected');
    jest
      .spyOn(receiptSummaryProjector, 'projectAutonomousPersonalCaptureReceiptSummaryV4')
      .mockImplementation(() => {
        throw new Error('synthetic_summary_projection_failure');
      });

    expect(publishAutonomousPersonalMemoryHandoffWithSummaryV4(ctx, store, bridge)).toEqual({
      kind: 'not_published',
    });
    expect(consume(ctx, locator(operation.identity))).toBeNull();
  });
});
