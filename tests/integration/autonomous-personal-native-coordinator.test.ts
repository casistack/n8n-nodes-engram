import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { GraphData } from '../../src/schemas/GraphData.schema';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import * as completionHandles from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import * as nativeOriginProjector from '../../src/storage/AutonomousPersonalNativeOriginV4';
import {
  completeNativeAutonomousPersonalCaptureV4,
  consumeAutonomousPersonalOriginalTurnV4,
} from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

type ProviderBody = {
  messages: Array<{ role: string; content: string }>;
};

type ReceiptBranch =
  | 'human_autonomous_capture_committed'
  | 'human_autonomous_source_deferred_committed'
  | 'human_autonomous_source_verdict_committed';

describe('fixed native autonomous personal coordinator V4', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;
  let preparedHandles: unknown[];

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-coordinator-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    preparedHandles = [];
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const handle of preparedHandles) {
      completionHandles.closeAutonomousPersonalCompletionV4(store, handle);
    }
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function contextFor(
    turn: string,
    intent: 'enabled' | 'disabled' = 'enabled',
    content = 'I prefer concise explanations.',
    executionId = `execution:${turn}`,
  ) {
    return nativeAutonomousPersonalCaptureContext(seed, {
      executionId,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content,
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: intent,
        automaticTurn: turn,
      },
    });
  }

  function installProvider(mode: 'success' | 'unavailable' | 'unexpected' = 'success') {
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

  function spyPreparation(afterPrepared?: (handle: unknown) => void) {
    const original = completionHandles.prepareNativeAutonomousPersonalCompletionV4;
    return jest
      .spyOn(completionHandles, 'prepareNativeAutonomousPersonalCompletionV4')
      .mockImplementation(async (ctx, owner) => {
        const result = await original(ctx, owner);
        if (result.kind === 'completion_prepared') {
          preparedHandles.push(result.handle);
          afterPrepared?.(result.handle);
        }
        return result;
      });
  }

  function spyClose() {
    const original = completionHandles.closeAutonomousPersonalCompletionV4;
    return jest
      .spyOn(completionHandles, 'closeAutonomousPersonalCompletionV4')
      .mockImplementation((owner, handle) => original(owner, handle));
  }

  function overrideParameter(context: object, name: string, value: unknown): void {
    const mutable = context as {
      getNodeParameter: (key: string, index: number, fallback: unknown) => unknown;
    };
    const original = mutable.getNodeParameter.bind(context);
    mutable.getNodeParameter = (key, index, fallback) =>
      key === name ? value : original(key, index, fallback);
  }

  async function finishAndReadOrigin(
    result: Awaited<ReturnType<typeof completeNativeAutonomousPersonalCaptureV4>>,
  ) {
    expect(result.kind).toBe('original_turn');
    if (result.kind !== 'original_turn')
      throw new Error(`Expected original turn, got ${result.kind}`);
    const token = result.origin;
    expect(Object.isFrozen(token)).toBe(true);
    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(JSON.stringify(token)).toBe('{}');
    return { token, origin: consumeAutonomousPersonalOriginalTurnV4(store, token) };
  }

  it.each([
    ['occurrence', 'enabled', 'success', 'human_autonomous_capture_committed'],
    ['provider-deferred', 'enabled', 'unavailable', 'human_autonomous_source_deferred_committed'],
    ['source-verdict', 'disabled', 'unexpected', 'human_autonomous_source_verdict_committed'],
  ] as const)(
    'issues a one-use origin bridge for the real %s committed receipt',
    async (name, intent, providerMode, receiptKind) => {
      const turn = `coordinator-${name}`;
      const fetchSpy = installProvider(providerMode);
      const preparationSpy = spyPreparation();
      const closeSpy = spyClose();
      const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
      const providerSpy = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
      const backendSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');
      const projectSpy = jest.spyOn(
        nativeOriginProjector,
        'projectAutonomousPersonalNativeOriginV4',
      );

      const result = await completeNativeAutonomousPersonalCaptureV4(
        contextFor(turn, intent, 'I prefer concise explanations.'),
        store,
      );

      expect(preparationSpy).toHaveBeenCalledTimes(1);
      expect(beginSpy).toHaveBeenCalledTimes(1);
      expect(providerSpy).toHaveBeenCalledTimes(1);
      expect(backendSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      if (providerMode === 'unexpected') expect(fetchSpy).not.toHaveBeenCalled();
      else if (providerMode === 'success') expect(fetchSpy).toHaveBeenCalledTimes(1);
      else expect(fetchSpy).toHaveBeenCalled();

      const { token, origin } = await finishAndReadOrigin(result);
      expect(origin).not.toBeNull();
      expect(origin).toBe(projectSpy.mock.results[0]?.value);
      expect(Object.isFrozen(origin)).toBe(true);
      expect(origin!.terminalReceipt.kind).toBe(receiptKind satisfies ReceiptBranch);
      expect(origin!.identity.turn).toBe(turn);
      expect(origin!.instance).toBe(`instance:${turn}`);
      expect(origin!.workflow).toBe(`workflow:${turn}`);
      expect(origin!.execution).toBe(`execution:${turn}`);
      expect(consumeAutonomousPersonalOriginalTurnV4(store, token)).toBeNull();
      expect(consumeAutonomousPersonalOriginalTurnV4({}, token)).toBeNull();
      expect(consumeAutonomousPersonalOriginalTurnV4(store, { ...(token as object) })).toBeNull();
      expect(
        consumeAutonomousPersonalOriginalTurnV4(store, new Proxy(token as object, {})),
      ).toBeNull();
      expect(
        consumeAutonomousPersonalOriginalTurnV4(store, JSON.parse(JSON.stringify(token))),
      ).toBeNull();
      expect(preparedHandles).toHaveLength(1);
      expect(() =>
        completionHandles.checkAutonomousPersonalCompletionV4(store, preparedHandles[0]),
      ).toThrow('Engram autonomous personal provider: invalid_handle');
    },
  );

  it('preserves a committed replay decision after reopen and does not redispatch', async () => {
    const turn = 'coordinator-replay-event';
    const fetchSpy = installProvider('unexpected');
    const firstPreparationSpy = spyPreparation();
    const first = await completeNativeAutonomousPersonalCaptureV4(
      contextFor(turn, 'disabled'),
      store,
    );
    expect(first.kind).toBe('original_turn');
    if (first.kind !== 'original_turn') throw new Error('Expected first native origin');
    const original = consumeAutonomousPersonalOriginalTurnV4(store, first.origin);
    if (!original) throw new Error('Expected the first owner-bound origin');
    expect(firstPreparationSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    firstPreparationSpy.mockRestore();

    await store.close();
    store = new GraphologyStorage(file);
    await store.initialize();
    const preparationSpy = spyPreparation();
    const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const providerSpy = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const backendSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');
    const beforeReplay = JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;

    const replay = await completeNativeAutonomousPersonalCaptureV4(
      contextFor(turn, 'disabled', 'I prefer concise explanations.', 'execution:redelivery'),
      store,
    );

    expect(replay).toEqual({
      kind: 'decision',
      result: {
        kind: 'committed_observed',
        terminalReceipt: original.terminalReceipt,
        eligibleFirstCommit: false,
      },
    });
    expect(preparationSpy).toHaveBeenCalledTimes(1);
    expect(beginSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy).not.toHaveBeenCalled();
    expect(backendSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const afterReplay = JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
    expect(afterReplay.entities).toEqual(beforeReplay.entities);
    expect(afterReplay.edges).toEqual(beforeReplay.edges);
    expect(afterReplay.episodes).toEqual(beforeReplay.episodes);
  });

  it.each(['missing-native-method', 'missing-owner-registry'] as const)(
    'returns unsupported_mode before provider dispatch when %s',
    async (missing) => {
      const fetchSpy = installProvider('unexpected');
      const context = contextFor(`coordinator-${missing}`);
      if (missing === 'missing-native-method') {
        const mutable = store as unknown as {
          completeAutonomousPersonalCaptureForNativeV4?: unknown;
        };
        const previous = mutable.completeAutonomousPersonalCaptureForNativeV4;
        mutable.completeAutonomousPersonalCaptureForNativeV4 = undefined;
        const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
        try {
          await expect(completeNativeAutonomousPersonalCaptureV4(context, store)).resolves.toEqual({
            kind: 'decision',
            result: { kind: 'unsupported_mode', eligibleFirstCommit: false },
          });
          expect(beginSpy).not.toHaveBeenCalled();
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          if (previous === undefined) delete mutable.completeAutonomousPersonalCaptureForNativeV4;
          else mutable.completeAutonomousPersonalCaptureForNativeV4 = previous;
        }
        return;
      }

      const begin = jest.fn();
      const provider = jest.fn();
      const backend = jest.fn();
      const owner = {
        beginAndClaimAutonomousPersonalCaptureV4: begin,
        prepareAutonomousPersonalCaptureProviderV4: provider,
        completeAutonomousPersonalCaptureForNativeV4: backend,
      } as unknown as IGraphStorage;
      await expect(completeNativeAutonomousPersonalCaptureV4(context, owner)).resolves.toEqual({
        kind: 'decision',
        result: { kind: 'unsupported_mode', eligibleFirstCommit: false },
      });
      expect(begin).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(backend).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('fails closed to unconfirmed for an invalid backend token', async () => {
    installProvider('unexpected');
    const preparationSpy = spyPreparation();
    const backend = jest
      .spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4')
      .mockResolvedValue(
        {} as Awaited<
          ReturnType<GraphologyStorage['completeAutonomousPersonalCaptureForNativeV4']>
        >,
      );
    const closeSpy = spyClose();

    const result = await completeNativeAutonomousPersonalCaptureV4(
      contextFor('coordinator-invalid-token', 'disabled'),
      store,
    );

    expect(result).toEqual({ kind: 'no_origin', observation: { kind: 'unconfirmed' } });
    expect(preparationSpy).toHaveBeenCalledTimes(1);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('maps a visible matched unknown-ack observation to unconfirmed without an origin', async () => {
    installProvider('success');
    let completionRenameCount = 0;
    let injectedUnknownAck = false;
    spyPreparation(() => {
      const originalRename = fs.promises.rename.bind(fs.promises);
      jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
        if (String(target) === file) completionRenameCount += 1;
        await originalRename(source, target);
        if (String(target) === file && !injectedUnknownAck) {
          injectedUnknownAck = true;
          throw new Error('synthetic_post_rename_rejection');
        }
      });
    });
    const closeSpy = spyClose();

    const result = await completeNativeAutonomousPersonalCaptureV4(
      contextFor('coordinator-unknown-ack'),
      store,
    );

    expect(result).toEqual({ kind: 'no_origin', observation: { kind: 'unconfirmed' } });
    expect(completionRenameCount).toBe(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves an exact backend no_write reason from an injected prewrite projector failure', async () => {
    installProvider('success');
    spyPreparation();
    const closeSpy = spyClose();
    jest
      .spyOn(nativeOriginProjector, 'projectAutonomousPersonalNativeOriginV4')
      .mockImplementation(() => {
        throw new nativeOriginProjector.AutonomousPersonalNativeOriginV4Error('capacity');
      });

    const result = await completeNativeAutonomousPersonalCaptureV4(
      contextFor('coordinator-no-write-reason'),
      store,
    );

    expect(result).toEqual({
      kind: 'no_origin',
      observation: { kind: 'no_write', reason: 'capacity' },
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'profile',
      (context: object) => overrideParameter(context, 'automaticMemoryProfile', 'reviewFirst'),
    ],
    [
      'input',
      (context: object) =>
        overrideParameter(context, 'automaticInput', 'I prefer detailed examples.'),
    ],
    ['model', (context: object) => overrideParameter(context, 'queueModel', 'model:changed')],
    [
      'execution',
      (context: object) => {
        (context as unknown as { getExecutionId: () => string }).getExecutionId = () =>
          'execution:changed';
      },
    ],
  ] as const)('suppresses the origin after a post-backend %s change', async (_name, mutate) => {
    installProvider('success');
    spyPreparation();
    const closeSpy = spyClose();
    const context = contextFor(`coordinator-post-backend-${_name}`);
    const originalBackend = store.completeAutonomousPersonalCaptureForNativeV4.bind(store);
    const backend = jest
      .spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4')
      .mockImplementation(async (handle) => {
        const token = await originalBackend(handle);
        mutate(context);
        return token;
      });

    const result = await completeNativeAutonomousPersonalCaptureV4(context, store);

    expect(result).toEqual({
      kind: 'decision',
      result: { kind: 'authority_changed', eligibleFirstCommit: false },
    });
    expect(backend).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rotated', 'coordinator-key-rotated'],
    ['removed', ''],
  ] as const)(
    'allows a post-backend %s key when the configured provider route is unchanged',
    async (_name, apiKey) => {
      installProvider('success');
      spyPreparation();
      const closeSpy = spyClose();
      const context = contextFor(`coordinator-key-${_name}`);
      const originalBackend = store.completeAutonomousPersonalCaptureForNativeV4.bind(store);
      jest
        .spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4')
        .mockImplementation(async (handle) => {
          const token = await originalBackend(handle);
          (
            context as unknown as {
              getCredentials: () => Promise<{ apiKey: string; baseUrl: string }>;
            }
          ).getCredentials = async () => ({ apiKey, baseUrl: 'https://memory.invalid/v1' });
          return token;
        });

      const result = await completeNativeAutonomousPersonalCaptureV4(context, store);

      expect(result.kind).toBe('original_turn');
      expect(closeSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['abort', 'expiry'] as const)(
    'closes the issued completion exactly once when %s arrives before backend use',
    async (cause) => {
      const controller = new AbortController();
      const context = Object.assign(contextFor(`coordinator-prebackend-${cause}`, 'disabled'), {
        getExecutionCancelSignal: () => controller.signal,
      });
      installProvider('unexpected');
      const closeSpy = spyClose();
      const actualNow = performance.now.bind(performance);
      const preparationSpy = spyPreparation(() => {
        if (cause === 'abort') controller.abort();
        else jest.spyOn(performance, 'now').mockImplementation(() => actualNow() + 6_000);
      });
      const backend = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');

      const result = await completeNativeAutonomousPersonalCaptureV4(context, store);

      expect(result.kind).toBe('decision');
      if (result.kind !== 'decision') throw new Error('Expected fixed lifetime decision');
      expect(result.result.kind).toBe(cause === 'abort' ? 'cancelled' : 'budget_exhausted');
      expect(preparationSpy).toHaveBeenCalledTimes(1);
      expect(backend).not.toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    },
  );
});
