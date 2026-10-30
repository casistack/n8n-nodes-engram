import { performance } from 'node:perf_hooks';
import * as AutomaticCapture from '../../../src/schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalTypedSyntaxFailureV1,
  compileAutonomousPersonalTypedSyntaxV1,
} from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import {
  AutonomousPersonalExecutionScopeBudgetError,
  AutonomousPersonalExecutionScopeError,
  bindAutonomousPersonalExecutionScopeV1,
  createAutonomousPersonalExecutionScopeWorkV1,
  currentAutonomousPersonalExecutionScopeWorkV1,
  diagnoseAutonomousPersonalExecutionScopeV1,
  openAutonomousPersonalExecutionScopeV1,
  runAutonomousPersonalExecutionScopeV1,
} from '../../../src/storage/AutonomousPersonalExecutionScopeV1';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';

const SYNTAX_SCOPE = {
  namespace: 'typed-syntax-budget',
  issuer: 'synthetic-workflow',
  actorReference: 'synthetic-user',
  binding: {
    bindingId: '22222222-2222-4222-8222-222222222222',
    revision: 3,
    subjectId: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'a'.repeat(64),
  },
};

const source = () => ({
  rawContent: 'I prefer concise answers.',
  mapping: { mode: 'full_body' as const },
  quoteRegions: [],
  syntaxScope: SYNTAX_SCOPE,
});

const budget = (syntax: object = { mode: 'inheritOverall' }) => ({
  semantics: 'configured',
  version: 1,
  completion: { mode: 'inheritOverall' },
  syntax,
  finalizationReserve: { mode: 'automatic' },
});

function open(syntax?: object, overallMs = 30_000) {
  const context = {};
  const entry = openAutonomousPersonalExecutionScopeV1(context, 'memorySave');
  bindAutonomousPersonalExecutionScopeV1(entry, context, budget(syntax), overallMs);
  return { context, entry };
}

/**
 * Deterministic clock jump: every hash computed inside the compiler advances the monotonic
 * clock by `stepMs`, i.e. the compile "takes" that much time without real waiting.
 */
function jumpClockPerHash(stepMs: number) {
  const realNow = performance.now.bind(performance);
  const realHash = AutomaticCapture.hashAutomaticCaptureV2;
  let offset = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
  let jumped = false;
  jest.spyOn(AutomaticCapture, 'hashAutomaticCaptureV2').mockImplementation((value) => {
    if (!jumped) {
      jumped = true;
      offset += stepMs;
    }
    return realHash(value);
  });
  return () => {
    jumped = false;
  };
}

afterEach(() => jest.restoreAllMocks());

describe('typed syntax compiler under a configured execution budget', () => {
  it('lets registered configured work exceed the legacy five-second clamp inside overall', async () => {
    const rearm = jumpClockPerHash(5_001);
    const { context, entry } = open();
    const output = await runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
      const work = currentAutonomousPersonalExecutionScopeWorkV1()!;
      rearm();
      return compileAutonomousPersonalTypedSyntaxV1(source(), work);
    });
    expect(output.version).toBe(1);
  });

  it('keeps unregistered copies of the same work on the exact legacy five-second stop', async () => {
    const rearm = jumpClockPerHash(5_001);
    const { context, entry } = open();
    let failure: unknown;
    await runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
      const registered = currentAutonomousPersonalExecutionScopeWorkV1()!;
      const copy: AutonomousPersonalTypedSyntaxWorkV1 = {
        absoluteMonotonicDeadlineMs: registered.absoluteMonotonicDeadlineMs,
        signal: registered.signal,
      };
      rearm();
      try {
        compileAutonomousPersonalTypedSyntaxV1(source(), copy);
      } catch (error) {
        failure = error;
      }
    });
    expect(failure).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
    expect((failure as AutonomousPersonalTypedSyntaxFailureV1).reason).toBe('deadline');
  });

  it('keeps legacy work with no scope at all on the legacy branch', () => {
    jumpClockPerHash(5_001);
    const work = {
      absoluteMonotonicDeadlineMs: performance.now() + 60_000,
      signal: new AbortController().signal,
    };
    expect(() => compileAutonomousPersonalTypedSyntaxV1(source(), work)).toThrow(
      AutonomousPersonalTypedSyntaxFailureV1,
    );
  });

  it('consumes one cumulative syntax allowance across repeated compilations', async () => {
    const rearm = jumpClockPerHash(600);
    const { context, entry } = open({ mode: 'limited', durationMs: 1_000 });
    let second: unknown;
    await runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
      const work = currentAutonomousPersonalExecutionScopeWorkV1()!;
      compileAutonomousPersonalTypedSyntaxV1(source(), work);
      expect(
        diagnoseAutonomousPersonalExecutionScopeV1(entry, context).chargedSyntaxMs,
      ).toBeGreaterThanOrEqual(600);
      rearm();
      try {
        compileAutonomousPersonalTypedSyntaxV1(source(), work);
      } catch (error) {
        second = error;
      }
    }).catch(() => undefined);
    // The scope error is surfaced by identity, never remapped to a typed-syntax reason.
    expect(second).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect((second as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
      'syntax_allowance',
    );
  });

  it('stops safely on stage cancellation with the original scope error', async () => {
    const { context, entry } = open();
    const stage = new AbortController();
    let failure: unknown;
    await runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
      const overall = currentAutonomousPersonalExecutionScopeWorkV1()!.absoluteMonotonicDeadlineMs;
      const work = createAutonomousPersonalExecutionScopeWorkV1(
        entry,
        context,
        overall,
        stage.signal,
      );
      stage.abort();
      try {
        compileAutonomousPersonalTypedSyntaxV1(source(), work);
      } catch (error) {
        failure = error;
      }
    }).catch(() => undefined);
    expect(failure).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect((failure as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
      'stage_cancelled',
    );
  });

  it('fails closed for registered work after its scope has closed', async () => {
    const { context, entry } = open();
    const work = await runAutonomousPersonalExecutionScopeV1(
      entry,
      context,
      async () => currentAutonomousPersonalExecutionScopeWorkV1()!,
    );
    let failure: unknown;
    try {
      compileAutonomousPersonalTypedSyntaxV1(source(), work);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AutonomousPersonalExecutionScopeError);
    expect((failure as AutonomousPersonalExecutionScopeError).reason).toBe('scope_closed');
  });

  it('fails closed for work that belongs to a different active scope', async () => {
    const a = open();
    const b = open();
    let workA!: AutonomousPersonalTypedSyntaxWorkV1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let ready!: () => void;
    const created = new Promise<void>((resolve) => (ready = resolve));
    const first = runAutonomousPersonalExecutionScopeV1(a.entry, a.context, async () => {
      workA = currentAutonomousPersonalExecutionScopeWorkV1()!;
      ready();
      await gate;
    });
    await created;
    let failure: unknown;
    await runAutonomousPersonalExecutionScopeV1(b.entry, b.context, async () => {
      try {
        compileAutonomousPersonalTypedSyntaxV1(source(), workA);
      } catch (error) {
        failure = error;
      }
    });
    release();
    await first;
    expect((failure as AutonomousPersonalExecutionScopeError).reason).toBe('foreign_scope');
  });
});
