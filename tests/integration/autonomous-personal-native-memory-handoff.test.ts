import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import type { AutonomousPersonalNativeOriginV4 } from '../../src/schemas/AutonomousPersonalNativeOriginV4.schema';
import * as nativeCompletion from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  getAutonomousPersonalMemoryLineageOriginV4,
  publishAutonomousPersonalMemoryHandoffV4,
  type NativeAutonomousPersonalMemoryContextV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import { getAutonomousPersonalMemoryLineageOriginV4 as getStorageLineageOrigin } from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

const HANDOFF_TTL_MS = 10 * 60 * 1000;

describe('native personal Memory handoff V4 foundation', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let storeOpen: boolean;
  let seed: AutonomousPersonalCaptureSeed;

  beforeEach(async () => {
    // Handoff tests exercise a real committed origin with provider failure, not DNS.
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('synthetic_provider_unavailable'));
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-memory-handoff-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    storeOpen = false;
    await store.initialize();
    storeOpen = true;
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      if (storeOpen) await store?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function contextFor(turn: string, executionId = `execution:${turn}`) {
    return nativeAutonomousPersonalCaptureContext(seed, {
      executionId,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content: 'I prefer concise explanations.',
      extraParameters: {
        automaticMemoryProfile: 'conservative',
        automaticIntent: 'disabled',
        automaticTurn: turn,
      },
    });
  }

  async function prepareRealBridge(turn: string) {
    const ctx = contextFor(turn);
    const completed = await nativeCompletion.completeNativeAutonomousPersonalCaptureV4(ctx, store);
    expect(globalThis.fetch).toHaveBeenCalled();
    if (completed.kind !== 'original_turn') {
      throw new Error(`Expected a real C2 original-turn bridge, got ${completed.kind}`);
    }

    const graph = await store.exportGraph();
    const operation = graph.automatic_operations_v1?.operations.find(
      (candidate) =>
        candidate.version === 4 &&
        candidate.state === 'committed' &&
        candidate.identity.turn === turn,
    );
    if (!operation || operation.version !== 4 || operation.state !== 'committed') {
      throw new Error('Expected a real committed Operation4 for the handoff source');
    }
    return { ctx, bridge: completed.origin, operation };
  }

  function tupleContext(
    base: NativeAutonomousPersonalMemoryContextV4,
    overrides: Partial<{
      instance: string;
      workflow: string | null;
      execution: string;
    }> = {},
  ): NativeAutonomousPersonalMemoryContextV4 {
    return {
      getInstanceId: () => overrides.instance ?? base.getInstanceId(),
      getWorkflow: () => ({ id: overrides.workflow ?? base.getWorkflow().id }),
      getExecutionId: () => overrides.execution ?? base.getExecutionId(),
    } as NativeAutonomousPersonalMemoryContextV4;
  }

  function locatorFor(
    identity: Pick<
      AutonomousPersonalNativeOriginV4['identity'],
      'storeHash' | 'namespace' | 'issuer' | 'actorReference' | 'turn' | 'sourceId'
    >,
  ) {
    return {
      storeHash: identity.storeHash,
      namespace: identity.namespace,
      issuer: identity.issuer,
      actorReference: identity.actorReference,
      turn: identity.turn,
      sourceId: identity.sourceId,
    };
  }

  it('publishes before owner close and consumes once through a reopened logical store owner', async () => {
    const { ctx, bridge, operation } = await prepareRealBridge('handoff-reopen');

    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'published',
      sourceId: operation.identity.sourceId,
    });
    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'not_published',
    });

    await store.close();
    storeOpen = false;
    const memoryStore = new GraphologyStorage(file);
    await memoryStore.initialize();
    store = memoryStore;
    storeOpen = true;

    const locator = locatorFor(operation.identity);
    const lineage = consumeAutonomousPersonalMemoryHandoffV4(
      ctx,
      locator.storeHash,
      locator.namespace,
      locator.issuer,
      locator.actorReference,
      locator.turn,
      locator.sourceId,
    );

    expect(lineage).not.toBeNull();
    expect(
      consumeAutonomousPersonalMemoryHandoffV4(
        ctx,
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ),
    ).toBeNull();
    const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
    expect(origin).not.toBeNull();
    expect(Object.isFrozen(origin)).toBe(true);
    expect(getAutonomousPersonalMemoryLineageOriginV4(lineage)).toBe(origin);
    expect(getStorageLineageOrigin(lineage)).toBe(origin);
    expect(origin?.identity.sourceId).toBe(operation.identity.sourceId);
    expect(getAutonomousPersonalMemoryLineageOriginV4({})).toBeNull();
    expect(getAutonomousPersonalMemoryLineageOriginV4(new Proxy(lineage as object, {}))).toBeNull();
  });

  it('rejects foreign, copied, proxied, and serialized C2 tokens without spending the real bridge', async () => {
    const { ctx, bridge, operation } = await prepareRealBridge('handoff-token-boundary');
    const foreignOwner = new GraphologyStorage();
    await foreignOwner.initialize();
    try {
      expect(publishAutonomousPersonalMemoryHandoffV4(ctx, foreignOwner, bridge)).toEqual({
        kind: 'not_published',
      });
    } finally {
      await foreignOwner.close();
    }
    expect(
      publishAutonomousPersonalMemoryHandoffV4(ctx, store, { ...(bridge as object) } as never),
    ).toEqual({ kind: 'not_published' });
    expect(
      publishAutonomousPersonalMemoryHandoffV4(
        ctx,
        store,
        new Proxy(bridge as object, {}) as never,
      ),
    ).toEqual({ kind: 'not_published' });
    expect(
      publishAutonomousPersonalMemoryHandoffV4(
        ctx,
        store,
        JSON.parse(JSON.stringify(bridge)) as never,
      ),
    ).toEqual({ kind: 'not_published' });

    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'published',
      sourceId: operation.identity.sourceId,
    });
    const locator = locatorFor(operation.identity);
    const lineage = consumeAutonomousPersonalMemoryHandoffV4(
      ctx,
      locator.storeHash,
      locator.namespace,
      locator.issuer,
      locator.actorReference,
      locator.turn,
      locator.sourceId,
    );
    expect(lineage).not.toBeNull();
  });

  it('fails closed when the publishing native execution tuple differs from the C2 origin', async () => {
    const { ctx, bridge } = await prepareRealBridge('handoff-wrong-native-tuple');
    const wrong = {
      getInstanceId: ctx.getInstanceId,
      getWorkflow: ctx.getWorkflow,
      getExecutionId: () => 'execution:foreign',
    } as NativeAutonomousPersonalMemoryContextV4;

    expect(publishAutonomousPersonalMemoryHandoffV4(wrong, store, bridge)).toEqual({
      kind: 'not_published',
    });
    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'not_published',
    });
  });

  it('keeps a pending handoff for exact lookup after wrong context and locator attempts', async () => {
    const { ctx, bridge, operation } = await prepareRealBridge('handoff-scope-joins');
    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'published',
      sourceId: operation.identity.sourceId,
    });
    const locator = locatorFor(operation.identity);

    const mismatches: Array<
      [
        string,
        NativeAutonomousPersonalMemoryContextV4,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    > = [
      [
        'store',
        ctx,
        'f'.repeat(64),
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ],
      [
        'namespace',
        ctx,
        locator.storeHash,
        `${locator.namespace}:other`,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ],
      [
        'issuer',
        ctx,
        locator.storeHash,
        locator.namespace,
        `${locator.issuer}:other`,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ],
      [
        'actor',
        ctx,
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        `${locator.actorReference}:other`,
        locator.turn,
        locator.sourceId,
      ],
      [
        'turn',
        ctx,
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        `${locator.turn}:other`,
        locator.sourceId,
      ],
      [
        'source',
        ctx,
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        randomUUID(),
      ],
      [
        'instance',
        tupleContext(ctx, { instance: 'instance:foreign' }),
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ],
      [
        'workflow',
        tupleContext(ctx, { workflow: 'workflow:foreign' }),
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ],
      [
        'execution',
        tupleContext(ctx, { execution: 'execution:foreign' }),
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ],
    ];

    for (const [
      ,
      wrongContext,
      storeHash,
      namespace,
      issuer,
      actorReference,
      turn,
      sourceId,
    ] of mismatches) {
      expect(
        consumeAutonomousPersonalMemoryHandoffV4(
          wrongContext,
          storeHash,
          namespace,
          issuer,
          actorReference,
          turn,
          sourceId,
        ),
      ).toBeNull();
    }
    expect(
      consumeAutonomousPersonalMemoryHandoffV4(
        ctx,
        '',
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ),
    ).toBeNull();
    expect(
      consumeAutonomousPersonalMemoryHandoffV4(
        ctx,
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ),
    ).not.toBeNull();
  });

  it('expires a pending handoff without extending the closed C2 lifetime', async () => {
    const { ctx, bridge, operation } = await prepareRealBridge('handoff-ttl');
    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'published',
      sourceId: operation.identity.sourceId,
    });
    const locator = locatorFor(operation.identity);
    const now = performance.now();
    jest.spyOn(performance, 'now').mockReturnValue(now + HANDOFF_TTL_MS + 1);

    expect(
      consumeAutonomousPersonalMemoryHandoffV4(
        ctx,
        locator.storeHash,
        locator.namespace,
        locator.issuer,
        locator.actorReference,
        locator.turn,
        locator.sourceId,
      ),
    ).toBeNull();
  });

  it('enforces the 128-entry bound and duplicate collision using test-injected C2 DATA only', async () => {
    // This control test isolates map limits. Its C2 consumer is stubbed and
    // makes no claim that these synthetic origins are authentic proofs.
    const { ctx, bridge } = await prepareRealBridge('handoff-capacity-template');
    const genuineTemplate = nativeCompletion.consumeAutonomousPersonalOriginalTurnV4(store, bridge);
    if (!genuineTemplate) throw new Error('Expected a genuine C2 template origin');

    let syntheticOrigin = genuineTemplate;
    jest
      .spyOn(nativeCompletion, 'consumeAutonomousPersonalOriginalTurnV4')
      .mockImplementation(() => syntheticOrigin);
    let now = performance.now();
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const syntheticToken = Object.freeze({}) as never;
    const syntheticOwner = {} as IGraphStorage;
    let published = 0;

    for (let index = 0; index < 128; index += 1) {
      syntheticOrigin = Object.freeze({
        ...genuineTemplate,
        identity: Object.freeze({
          ...genuineTemplate.identity,
          turn: `handoff-capacity-${index}`,
          sourceId: randomUUID(),
        }),
      }) as AutonomousPersonalNativeOriginV4;
      expect(
        publishAutonomousPersonalMemoryHandoffV4(ctx, syntheticOwner, syntheticToken).kind,
      ).toBe('published');
      published += 1;
      if (index === 0) {
        expect(
          publishAutonomousPersonalMemoryHandoffV4(ctx, syntheticOwner, syntheticToken),
        ).toEqual({ kind: 'not_published' });
      }
    }
    syntheticOrigin = Object.freeze({
      ...genuineTemplate,
      identity: Object.freeze({
        ...genuineTemplate.identity,
        turn: 'handoff-capacity-overflow',
        sourceId: randomUUID(),
      }),
    }) as AutonomousPersonalNativeOriginV4;
    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, syntheticOwner, syntheticToken)).toEqual({
      kind: 'not_published',
    });
    expect(published).toBe(128);

    now += HANDOFF_TTL_MS + 1;
    expect(
      consumeAutonomousPersonalMemoryHandoffV4(
        ctx,
        genuineTemplate.identity.storeHash,
        genuineTemplate.identity.namespace,
        genuineTemplate.identity.issuer,
        genuineTemplate.identity.actorReference,
        'no-such-turn',
        genuineTemplate.identity.sourceId,
      ),
    ).toBeNull();
  });
});
