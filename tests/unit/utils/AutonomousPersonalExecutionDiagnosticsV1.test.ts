import type { IExecuteFunctions } from 'n8n-workflow';
import { performance } from 'node:perf_hooks';
import { AutonomousPersonalExecutionDiagnosticsV1Schema } from '../../../src/schemas/AutonomousPersonalExecutionDiagnosticsV1.schema';
import {
  AutonomousPersonalExecutionScopeError,
  bindAutonomousPersonalExecutionScopeV1,
  getLatestAutonomousPersonalExecutionDiagnosticsV1,
  markCurrentAutonomousPersonalExecutionStageV1,
  openAutonomousPersonalExecutionScopeV1,
  recordCurrentAutonomousPersonalExecutionCompletionV1,
  runAutonomousPersonalExecutionScopeV1,
} from '../../../src/storage/AutonomousPersonalExecutionScopeV1';
import {
  readCurrentAutonomousPersonalEntryTimingV1,
  readLatestAutonomousPersonalExecutionDiagnosticsV1,
  runWithAutonomousPersonalExecutionEntryV1,
} from '../../../src/utils/AutonomousPersonalExecutionEntryV1';

const configuredBudget = {
  semantics: 'configured' as const,
  version: 1 as const,
  completion: { mode: 'limited' as const, durationMs: 1_000 },
  syntax: { mode: 'inheritOverall' as const },
  finalizationReserve: { mode: 'fixed' as const, durationMs: 100 },
};

function nativeContext(parameters: Record<string, unknown>): IExecuteFunctions {
  return {
    getNode: () => ({ parameters }),
    getNodeParameter: (name: string, _index: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
    getExecutionCancelSignal: () => undefined,
  } as unknown as IExecuteFunctions;
}

describe('configured native execution diagnostics V1', () => {
  it('emits strict bounded data with relative timing and frozen nested values', async () => {
    const context = {};
    const entry = openAutonomousPersonalExecutionScopeV1(context, 'adminCapture');
    bindAutonomousPersonalExecutionScopeV1(entry, context, configuredBudget, 5_000);

    await runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
      markCurrentAutonomousPersonalExecutionStageV1('initialize');
      markCurrentAutonomousPersonalExecutionStageV1('provider');
      const completionStartedAt = performance.now();
      recordCurrentAutonomousPersonalExecutionCompletionV1(
        completionStartedAt,
        completionStartedAt + 600,
        100,
      );
      markCurrentAutonomousPersonalExecutionStageV1('readback');
    });

    const result = getLatestAutonomousPersonalExecutionDiagnosticsV1(context);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      version: 1,
      lastReachedStage: 'final_check',
      configured: {
        overallMs: 5_000,
        completion: { mode: 'limited', durationMs: 1_000 },
        syntax: { mode: 'inheritOverall' },
        finalizationReserve: { mode: 'fixed', durationMs: 100 },
      },
      effective: {
        overallMs: 5_000,
        completionMs: 600,
        syntaxMs: null,
        finalizationReserveMs: 100,
      },
      firstStop: null,
    });
    expect(result!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result!.cumulativeSynchronousWorkMs).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.configured)).toBe(true);
    expect(Object.isFrozen(result!.configured.completion)).toBe(true);
    expect(Object.isFrozen(result!.effective)).toBe(true);
  });

  it('omits an invalid unbound outer entry instead of reusing prior invocation data', async () => {
    const parameters: Record<string, unknown> = {
      automaticExecutionBudgetMode: 'configuredV1',
      automaticPreferenceInterpreter: 'autonomousPersonalV1',
      resource: 'automaticMemory',
      extractionDeadlineMs: 5_000,
    };
    const context = nativeContext(parameters);
    await runWithAutonomousPersonalExecutionEntryV1(context, async () => undefined);
    expect(readLatestAutonomousPersonalExecutionDiagnosticsV1(context)).not.toBeNull();

    parameters.extractionDeadlineMs = 50;
    await expect(
      runWithAutonomousPersonalExecutionEntryV1(context, async () => undefined),
    ).rejects.toBeInstanceOf(AutonomousPersonalExecutionScopeError);
    expect(readLatestAutonomousPersonalExecutionDiagnosticsV1(context)).toBeNull();
  });

  it('keeps the last processing stage when the body fails before the final check', async () => {
    const context = {};
    const entry = openAutonomousPersonalExecutionScopeV1(context, 'adminCapture');
    bindAutonomousPersonalExecutionScopeV1(entry, context, configuredBudget, 5_000);
    const failure = new Error('synthetic body failure');

    await expect(
      runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
        markCurrentAutonomousPersonalExecutionStageV1('provider_preflight');
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(getLatestAutonomousPersonalExecutionDiagnosticsV1(context)).toMatchObject({
      lastReachedStage: 'provider_preflight',
      firstStop: null,
    });
  });

  it('does not reset a nested scope and rejects configured-to-legacy downgrade before the body', async () => {
    const parameters: Record<string, unknown> = {
      automaticExecutionBudgetMode: 'configuredV1',
      automaticPreferenceInterpreter: 'autonomousPersonalV1',
      resource: 'automaticMemory',
      extractionDeadlineMs: 5_000,
    };
    const context = nativeContext(parameters);
    let bodyCalled = false;

    await runWithAutonomousPersonalExecutionEntryV1(context, async () => {
      const before = readCurrentAutonomousPersonalEntryTimingV1(context);
      expect(before.kind).toBe('entry');
      parameters.automaticExecutionBudgetMode = 'legacy';
      await expect(
        runWithAutonomousPersonalExecutionEntryV1(context, async () => {
          bodyCalled = true;
        }),
      ).rejects.toMatchObject({ reason: 'configuration_conflict' });
      await expect(
        Promise.resolve().then(() => readCurrentAutonomousPersonalEntryTimingV1(context)),
      ).rejects.toMatchObject({ reason: 'configuration_conflict' });
      parameters.automaticExecutionBudgetMode = 'configuredV1';
      const after = readCurrentAutonomousPersonalEntryTimingV1(context);
      expect(after.kind).toBe('entry');
      if (before.kind === 'entry' && after.kind === 'entry') {
        expect(after.entry).toBe(before.entry);
      }
    });

    expect(bodyCalled).toBe(false);
  });

  it('rejects diagnostic-shaped authority fields and does not accept arbitrary keys', () => {
    const valid = {
      version: 1,
      lastReachedStage: 'begin',
      elapsedMs: 10,
      cumulativeSynchronousWorkMs: 2,
      configured: {
        overallMs: 5_000,
        completion: configuredBudget.completion,
        syntax: configuredBudget.syntax,
        finalizationReserve: configuredBudget.finalizationReserve,
      },
      effective: {
        overallMs: 5_000,
        completionMs: null,
        syntaxMs: null,
        finalizationReserveMs: 100,
      },
      firstStop: null,
    };
    expect(AutonomousPersonalExecutionDiagnosticsV1Schema.safeParse(valid).success).toBe(true);
    expect(
      AutonomousPersonalExecutionDiagnosticsV1Schema.safeParse({ ...valid, elapsedMs: null })
        .success,
    ).toBe(true);
    expect(
      AutonomousPersonalExecutionDiagnosticsV1Schema.safeParse({
        ...valid,
        sourceId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalExecutionDiagnosticsV1Schema.safeParse({
        ...valid,
        completionDeadlineAtMonotonicMs: 1_000,
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalExecutionDiagnosticsV1Schema.safeParse({
        ...valid,
        lastReachedStage: 'provider_error_message',
      }).success,
    ).toBe(false);
  });
});
