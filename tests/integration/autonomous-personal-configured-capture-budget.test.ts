import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { IExecuteFunctions } from 'n8n-workflow';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import * as completionHandles from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  AutonomousPersonalExecutionScopeError,
  currentAutonomousPersonalExecutionScopeWorkV1,
  currentAutonomousPersonalExecutionScopeV1,
  diagnoseAutonomousPersonalExecutionScopeV1,
} from '../../src/storage/AutonomousPersonalExecutionScopeV1';
import {
  readCurrentAutonomousPersonalEntryTimingV1,
  runWithAutonomousPersonalExecutionEntryV1,
} from '../../src/utils/AutonomousPersonalExecutionEntryV1';
import { executeAutonomousPersonalAdminV4 } from '../../src/utils/autonomousPersonalAdmin';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

type Mode = 'configuredV1' | 'legacy' | undefined;

describe('configured autonomous capture timing (connected)', () => {
  let directory: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-configured-capture-'));
    store = new GraphologyStorage(join(directory, 'store.json'));
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
    mode: Mode,
    options: { deadlineMs?: number; signal?: AbortSignal; extra?: Record<string, unknown> } = {},
  ): IExecuteFunctions {
    const base = nativeAutonomousPersonalCaptureContext(seed, {
      executionId: `execution:${turn}`,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: options.deadlineMs ?? 30_000,
      content: 'I prefer concise explanations.',
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: 'enabled',
        automaticTurn: turn,
        ...options.extra,
      },
    });
    const node = base.getNode();
    const mutable = base as unknown as Record<string, unknown>;
    mutable.getNode = () => ({
      ...node,
      parameters: {
        ...node.parameters,
        ...(mode === undefined ? {} : { automaticExecutionBudgetMode: mode }),
      },
    });
    if (options.signal) mutable.getExecutionCancelSignal = () => options.signal;
    return base;
  }

  function installProvider(delayMs = 0) {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const user = JSON.parse(body.messages[1]!.content) as { units: Array<{ unitId: string }> };
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

  describe('fixed native entry', () => {
    it.each<Mode>([undefined, 'legacy'])('calls the original path for mode %s', async (mode) => {
      const ctx = contextFor('entry-legacy', mode);
      const seen: unknown[] = [];
      await runWithAutonomousPersonalExecutionEntryV1(ctx, async () => {
        seen.push(currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture'));
      });
      expect(seen).toEqual([undefined]);
      expect(readCurrentAutonomousPersonalEntryTimingV1(ctx)).toEqual({ kind: 'legacy' });
    });

    it('opens T0 before the first await and binds the configured overall synchronously', async () => {
      const ctx = contextFor('entry-t0', 'configuredV1', { deadlineMs: 20_000 });
      const before = performance.now();
      let observed: { startedAt: number; original: number; sameTick: boolean } | undefined;
      let awaited = false;
      const pending = runWithAutonomousPersonalExecutionEntryV1(ctx, async () => {
        const timing = readCurrentAutonomousPersonalEntryTimingV1(ctx);
        if (timing.kind !== 'entry') throw new Error('expected entry');
        observed = {
          startedAt: timing.startedAtMonotonicMs,
          original: timing.originalDeadlineAtMonotonicMs,
          sameTick: !awaited,
        };
      });
      awaited = true;
      await pending;
      const after = performance.now();
      expect(observed!.sameTick).toBe(true);
      expect(observed!.startedAt).toBeGreaterThanOrEqual(before);
      expect(observed!.startedAt).toBeLessThanOrEqual(after);
      expect(observed!.original - observed!.startedAt).toBeCloseTo(20_000, 5);
    });

    it('reuses the current entry without restarting T0 and rejects a conflicting configuration', async () => {
      const ctx = contextFor('entry-reuse', 'configuredV1');
      await runWithAutonomousPersonalExecutionEntryV1(ctx, async () => {
        const outer = currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture')!;
        const first = diagnoseAutonomousPersonalExecutionScopeV1(outer, ctx).originalDeadlineMs;
        await runWithAutonomousPersonalExecutionEntryV1(ctx, async () => {
          expect(currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture')).toBe(outer);
        });
        expect(diagnoseAutonomousPersonalExecutionScopeV1(outer, ctx).originalDeadlineMs).toBe(
          first,
        );

        const mutable = ctx as unknown as {
          getNodeParameter: (name: string, index: number, fallback: unknown) => unknown;
        };
        const original = mutable.getNodeParameter.bind(ctx);
        mutable.getNodeParameter = (name, index, fallback) =>
          name === 'extractionDeadlineMs' ? 45_000 : original(name, index, fallback);
        await expect(
          runWithAutonomousPersonalExecutionEntryV1(ctx, async () => 1),
        ).rejects.toMatchObject({
          reason: 'configuration_conflict',
        });
        expect(diagnoseAutonomousPersonalExecutionScopeV1(outer, ctx).originalDeadlineMs).toBe(
          first,
        );
      });
    });

    it('does not retry a failed configured binding under fresh timing', async () => {
      const ctx = contextFor('entry-clock-regression', 'configuredV1');
      const body = jest.fn(async () => undefined);
      const clock = jest.spyOn(performance, 'now');
      clock.mockReturnValueOnce(1000).mockReturnValueOnce(999).mockReturnValue(1001);
      await expect(runWithAutonomousPersonalExecutionEntryV1(ctx, body)).rejects.toMatchObject({
        reason: 'clock_regression',
      });
      expect(body).not.toHaveBeenCalled();
      expect(currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture')).toBeUndefined();
    });

    it('reports a missing entry for configured raw mode outside the fixed scope', () => {
      const ctx = contextFor('entry-missing', 'configuredV1');
      expect(readCurrentAutonomousPersonalEntryTimingV1(ctx)).toEqual({ kind: 'missing' });
    });

    it('closes the entry after the body and never leaks it to the next call', async () => {
      const ctx = contextFor('entry-close', 'configuredV1');
      await runWithAutonomousPersonalExecutionEntryV1(ctx, async () => undefined);
      expect(currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture')).toBeUndefined();
    });

    it('does not turn an already cancelled host signal into a legacy run', async () => {
      const controller = new AbortController();
      controller.abort();
      const ctx = contextFor('entry-cancelled', 'configuredV1', { signal: controller.signal });
      let ran = false;
      await expect(
        runWithAutonomousPersonalExecutionEntryV1(ctx, async () => {
          ran = true;
        }),
      ).rejects.toMatchObject({ stopReason: 'parent_cancelled' });
      expect(ran).toBe(false);
    });
  });

  describe('begin-only helpers', () => {
    it('does not invoke backend begin after a latched clock failure and clock reset', async () => {
      const ctx = contextFor('latched-clock-begin', 'configuredV1');
      const begin = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
      const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
      await expect(
        runWithAutonomousPersonalExecutionEntryV1(ctx, async () => {
          currentAutonomousPersonalExecutionScopeWorkV1();
          clock.mockReturnValue(999);
          expect(() => currentAutonomousPersonalExecutionScopeWorkV1()).toThrow();
          clock.mockReturnValue(1001);
          const result = await completionHandles.dispatchNativeAutonomousPersonalCaptureV4(
            ctx,
            store,
          );
          expect(result.kind).toBe('invalid_input');
          expect(begin).not.toHaveBeenCalled();
        }),
      ).rejects.toMatchObject({ reason: 'clock_regression' });
      expect(begin).not.toHaveBeenCalled();
    });

    it('refuses a standalone configured begin before any backend mutation', async () => {
      const ctx = contextFor('standalone-begin', 'configuredV1');
      const begin = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
      const result = await completionHandles.dispatchNativeAutonomousPersonalCaptureV4(ctx, store);
      expect(result.kind).toBe('unsupported_mode');
      expect(begin).not.toHaveBeenCalled();
      expect(currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture')).toBeUndefined();
    });

    it('refuses configured provider preparation outside the fixed entry instead of using legacy timing', async () => {
      const ctx = contextFor('begin-only', 'configuredV1');
      const result = await completionHandles.prepareNativeAutonomousPersonalCaptureProviderV4(
        ctx,
        store,
      );
      expect(result.kind).toBe('unsupported_mode');
      expect(result.eligibleFirstCommit).toBe(false);
    });
  });

  describe('connected completion and dispatcher', () => {
    it('rejects a budget changed during asynchronous credential resolution before backend begin', async () => {
      const ctx = contextFor('credential-budget-change', 'configuredV1');
      const mutable = ctx as unknown as {
        getNodeParameter: IExecuteFunctions['getNodeParameter'];
        getCredentials: IExecuteFunctions['getCredentials'];
      };
      const originalParameter = mutable.getNodeParameter.bind(ctx);
      const originalCredentials = mutable.getCredentials.bind(ctx);
      let changed = false;
      mutable.getNodeParameter = ((name: string, index: number, fallback: unknown) => {
        if (changed && name === 'automaticCompletionBudgetMode') return 'limited';
        if (changed && name === 'automaticCompletionBudgetMs') return 1000;
        return originalParameter(name, index, fallback as string);
      }) as IExecuteFunctions['getNodeParameter'];
      mutable.getCredentials = (async (
        ...args: Parameters<IExecuteFunctions['getCredentials']>
      ) => {
        await Promise.resolve();
        changed = true;
        return originalCredentials(...args);
      }) as IExecuteFunctions['getCredentials'];
      const begin = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
      const provider = jest.spyOn(globalThis, 'fetch');
      const completed = await completeNativeAutonomousPersonalCaptureV4(ctx, store);
      expect(completed.kind).not.toBe('original_turn');
      expect(begin).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    });

    it('completes a configured capture inside one entry and releases it afterwards', async () => {
      installProvider();
      const ctx = contextFor('complete-ok', 'configuredV1');
      const completed = await completeNativeAutonomousPersonalCaptureV4(ctx, store);
      expect(completed).toMatchObject({ kind: 'original_turn' });
      expect(currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture')).toBeUndefined();
    });

    it.each<Mode>(['configuredV1', undefined])(
      'exposes the exact completion read scope on Access for mode %s',
      async (mode) => {
        installProvider();
        const accessScopes: unknown[] = [];
        const original = completionHandles.getAutonomousPersonalCompletionAccessV4;
        jest
          .spyOn(completionHandles, 'getAutonomousPersonalCompletionAccessV4')
          .mockImplementation((owner, access) => {
            const view = original(owner, access);
            accessScopes.push(view.readScope);
            return view;
          });
        const result = await completeNativeAutonomousPersonalCaptureV4(
          contextFor(`access-${mode ?? 'legacy'}`, mode),
          store,
        );
        expect(result).toMatchObject({ kind: 'original_turn' });
        expect(accessScopes.length).toBeGreaterThan(0);
        for (const scope of accessScopes) expect(scope).toBeDefined();
        expect(new Set(accessScopes).size).toBe(1);
      },
    );

    it('stops without a first-processing permit when the configured overall expires during the provider call', async () => {
      installProvider(400);
      const ctx = contextFor('complete-slow', 'configuredV1', { deadlineMs: 150 });
      const completed = await completeNativeAutonomousPersonalCaptureV4(ctx, store);
      expect(completed.kind).not.toBe('original_turn');
      expect(currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture')).toBeUndefined();
    });

    it('stops on host cancellation and publishes no original turn', async () => {
      const controller = new AbortController();
      installProvider(200);
      const ctx = contextFor('complete-cancel', 'configuredV1', { signal: controller.signal });
      const pending = completeNativeAutonomousPersonalCaptureV4(ctx, store);
      setTimeout(() => controller.abort(), 30);
      expect((await pending).kind).not.toBe('original_turn');
    });

    it('keeps the dispatcher inside the entry through handoff and output projection', async () => {
      installProvider();
      const ctx = contextFor('dispatch-ok', 'configuredV1');
      const output = await executeAutonomousPersonalAdminV4(ctx, store);
      expect(output).toMatchObject({ version: 4, should_process: true, status: 'captured' });
      expect(currentAutonomousPersonalExecutionScopeV1(ctx, 'adminCapture')).toBeUndefined();
    });

    it('rejects a conflicting configuration from inside an existing entry as a fixed error', async () => {
      installProvider();
      const ctx = contextFor('dispatch-conflict', 'configuredV1');
      let failure: unknown;
      await runWithAutonomousPersonalExecutionEntryV1(ctx, async () => {
        const mutable = ctx as unknown as {
          getNodeParameter: (name: string, index: number, fallback: unknown) => unknown;
        };
        const original = mutable.getNodeParameter.bind(ctx);
        mutable.getNodeParameter = (name, index, fallback) =>
          name === 'extractionDeadlineMs' ? 60_000 : original(name, index, fallback);
        try {
          await executeAutonomousPersonalAdminV4(ctx, store);
        } catch (error) {
          failure = error;
        }
      });
      expect(failure).toBeInstanceOf(AutonomousPersonalExecutionScopeError);
    });
  });
});
