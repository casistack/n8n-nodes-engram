import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'node:perf_hooks';
import type { IExecuteFunctions } from 'n8n-workflow';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  closeAutonomousPersonalCaptureProviderStageAccessV4,
  consumeAutonomousPersonalCaptureProviderStageV4,
  getAutonomousPersonalCaptureProviderStageAccessV4,
  getAutonomousPersonalCaptureProviderV4ResultSchema,
  prepareNativeAutonomousPersonalCaptureProviderV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { compileAutonomousPersonalEvidenceSelectionV1 } from '../../src/extraction/AutonomousPersonalEvidenceSelectionV1';
import * as selectionCompiler from '../../src/extraction/AutonomousPersonalEvidenceSelectionV1';
import { canonicalAutomaticCaptureV2 } from '../../src/schemas/AutomaticCapture.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import type { AutonomousPersonalCaptureSeed } from '../helpers/autonomousPersonalCaptureBackend';

type ProviderBody = {
  messages: Array<{ role: string; content: string }>;
};

function providerSuccess(unitIds: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              version: 1,
              units: unitIds.map((unitId) => ({
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
}

describe('native V4 provider stage retains bounded selection DATA', () => {
  let directory: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-provider-selection-stage-'));
    store = new GraphologyStorage(join(directory, 'store.json'));
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const contextFor = (
    captureSeed: AutonomousPersonalCaptureSeed,
    options: Parameters<typeof nativeAutonomousPersonalCaptureContext>[1] = {},
  ) => nativeAutonomousPersonalCaptureContext(captureSeed, options);
  const context = (options: Parameters<typeof nativeAutonomousPersonalCaptureContext>[1] = {}) =>
    contextFor(seed, options);

  const successfulProviderFetch = () =>
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units.map((unit) => unit.unitId));
    });

  const preparedStage = async (
    ctx = context(),
  ): Promise<{
    result: Awaited<ReturnType<typeof prepareNativeAutonomousPersonalCaptureProviderV4>>;
    stage: object;
  }> => {
    successfulProviderFetch();
    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);
    if (result.kind !== 'prepared') throw new Error('Expected private provider stage');
    return { result, stage: result.stage };
  };

  it('retains the exact independent complete selection without exposing source literals', async () => {
    const fetchSpy = successfulProviderFetch();
    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);

    expect(result.kind).toBe('prepared');
    expect(result.eligibleFirstCommit).toBe(false);
    expect(result).not.toHaveProperty('selection');
    expect(getAutonomousPersonalCaptureProviderV4ResultSchema().safeParse(result).success).toBe(
      true,
    );
    if (result.kind !== 'prepared') throw new Error('Expected private provider stage');

    const access = consumeAutonomousPersonalCaptureProviderStageV4(store, result.stage);
    const consumed = getAutonomousPersonalCaptureProviderStageAccessV4(store, access);
    const { view } = consumed;
    expect(view.outcome.kind).toBe('response');
    if (view.outcome.kind !== 'response') throw new Error('Expected validated provider response');
    expect(view.selection).not.toBeNull();
    const selection = view.selection;
    if (!selection) throw new Error('Expected retained selection');

    const expected = compileAutonomousPersonalEvidenceSelectionV1(
      {
        source: view.stagedFresh.episode,
        descriptor: view.stagedFresh.operation.descriptor,
      },
      view.outcome.response,
      {
        absoluteMonotonicDeadlineMs: performance.now() + 30_000,
        signal: new AbortController().signal,
      } satisfies AutonomousPersonalTypedSyntaxWorkV1,
    );
    expect(selection.status).toBe('complete');
    expect(canonicalAutomaticCaptureV2(selection)).toBe(canonicalAutomaticCaptureV2(expected));
    expect(selection.sourceId).toBe(view.refs.sourceId);
    expect(selection.sourceHash).toBe(view.refs.sourceHash);
    expect(selection.descriptorHash).toBe(view.refs.descriptorHash);
    expect(selection.policyFingerprint).toBe(
      view.stagedFresh.operation.descriptor.policy.fingerprint,
    );
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.units)).toBe(true);
    expect(Object.isFrozen(selection.occurrences)).toBe(true);
    expect(selection).not.toHaveProperty('literal');
    expect(JSON.stringify(selection)).not.toContain(seed.request.source.content);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getAutonomousPersonalCaptureProviderV4ResultSchema().safeParse(result).success).toBe(
      false,
    );
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, access);
  });

  it('stores null selection for no-dispatch and deferred stages', async () => {
    const noDispatchFetch = jest.spyOn(globalThis, 'fetch');
    const noDispatch = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({
        extraParameters: {
          automaticMemoryProfile: 'explicit',
          automaticIntent: 'disabled',
        },
      }),
      store,
    );
    expect(noDispatch.kind).toBe('prepared');
    if (noDispatch.kind !== 'prepared') throw new Error('Expected no-dispatch stage');
    const noDispatchAccess = consumeAutonomousPersonalCaptureProviderStageV4(
      store,
      noDispatch.stage,
    );
    const noDispatchView = getAutonomousPersonalCaptureProviderStageAccessV4(
      store,
      noDispatchAccess,
    );
    expect(noDispatchView.view.outcome).toEqual({
      kind: 'no_dispatch',
      reason: 'policy_not_selected',
    });
    expect(noDispatchView.view.selection).toBeNull();
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, noDispatchAccess);
    expect(noDispatchFetch).not.toHaveBeenCalled();

    const deferredSeed = await seedAutonomousPersonalCaptureSubject(store);
    const deferredContext = contextFor(deferredSeed);
    (deferredContext as unknown as { getCredentials: jest.Mock }).getCredentials = jest.fn(
      async () => ({ apiKey: '', baseUrl: 'https://memory.invalid/v1' }),
    );
    const deferred = await prepareNativeAutonomousPersonalCaptureProviderV4(deferredContext, store);
    expect(deferred.kind).toBe('prepared');
    if (deferred.kind !== 'prepared') throw new Error('Expected deferred stage');
    const deferredAccess = consumeAutonomousPersonalCaptureProviderStageV4(store, deferred.stage);
    const deferredView = getAutonomousPersonalCaptureProviderStageAccessV4(store, deferredAccess);
    expect(deferredView.view.outcome).toEqual({ kind: 'deferred', reason: 'provider_auth' });
    expect(deferredView.view.selection).toBeNull();
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, deferredAccess);
  });

  it.each(['sourceId', 'sourceHash', 'descriptorHash', 'policyFingerprint'] as const)(
    'rejects a provider selection report with a mismatched %s reference',
    async (field) => {
      const fetchSpy = successfulProviderFetch();
      const original = selectionCompiler.compileAutonomousPersonalEvidenceSelectionV1;
      let compileCalls = 0;
      const selectionSpy = jest
        .spyOn(selectionCompiler, 'compileAutonomousPersonalEvidenceSelectionV1')
        .mockImplementation((input, response, work) => {
          compileCalls += 1;
          const selection = original(input, response, work);
          if (compileCalls === 1 || selection.status !== 'complete') return selection;
          const mismatched = { ...selection };
          if (field === 'sourceId') mismatched.sourceId = '00000000-0000-4000-8000-000000000001';
          if (field === 'sourceHash') mismatched.sourceHash = '0'.repeat(64);
          if (field === 'descriptorHash') mismatched.descriptorHash = '0'.repeat(64);
          if (field === 'policyFingerprint') mismatched.policyFingerprint = '0'.repeat(64);
          return mismatched;
        });

      const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);
      expect(result).toEqual({ kind: 'conflict', eligibleFirstCommit: false });
      expect(getAutonomousPersonalCaptureProviderV4ResultSchema().safeParse(result).success).toBe(
        true,
      );
      expect(result).not.toHaveProperty('stage');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(selectionSpy).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps selection DATA from becoming a copied, foreign, or reusable access key', async () => {
    const { result, stage } = await preparedStage();
    if (result.kind !== 'prepared') throw new Error('Expected private provider stage');

    expect(() => consumeAutonomousPersonalCaptureProviderStageV4({}, stage)).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
    expect(() => consumeAutonomousPersonalCaptureProviderStageV4(store, { ...stage })).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );

    const access = consumeAutonomousPersonalCaptureProviderStageV4(store, stage);
    const consumed = getAutonomousPersonalCaptureProviderStageAccessV4(store, access);
    expect(consumed.view.selection).not.toBeNull();
    expect(() => consumeAutonomousPersonalCaptureProviderStageV4(store, stage)).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
    expect(() => getAutonomousPersonalCaptureProviderStageAccessV4(store, { ...access })).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
    expect(() =>
      getAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.view.selection),
    ).toThrow('Engram autonomous personal provider: invalid_handle');
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, access);
    expect(() => getAutonomousPersonalCaptureProviderStageAccessV4(store, access)).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
  });

  it('retains the original cancellation and absolute deadline through stage access', async () => {
    const controller = new AbortController();
    const ctx = context() as IExecuteFunctions & { getExecutionCancelSignal: jest.Mock };
    ctx.getExecutionCancelSignal = jest.fn(() => controller.signal);
    const { stage } = await preparedStage(ctx);
    const access = consumeAutonomousPersonalCaptureProviderStageV4(store, stage);
    const consumed = getAutonomousPersonalCaptureProviderStageAccessV4(store, access);
    expect(consumed.signal.aborted).toBe(false);
    expect(consumed.view.overallDeadlineAtMonotonicMs).toBeGreaterThan(performance.now());

    controller.abort();
    expect(consumed.signal.aborted).toBe(true);
    expect(() => consumed.check()).toThrow();
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, access);
  });

  it('enforces the same absolute deadline in the returned access check', async () => {
    const { stage } = await preparedStage();
    const access = consumeAutonomousPersonalCaptureProviderStageV4(store, stage);
    const consumed = getAutonomousPersonalCaptureProviderStageAccessV4(store, access);
    const error: unknown = (() => {
      const nowSpy = jest
        .spyOn(performance, 'now')
        .mockReturnValue(consumed.view.overallDeadlineAtMonotonicMs);
      try {
        consumed.check();
      } catch (caught) {
        return caught;
      } finally {
        nowSpy.mockRestore();
      }
      throw new Error('Expected the original overall deadline to fail');
    })();
    expect(error).toMatchObject({
      message: 'Engram autonomous personal provider: budget_exhausted',
    });
    expect(() => consumed.check()).toThrow(error as Error);
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, access);
  });
});
