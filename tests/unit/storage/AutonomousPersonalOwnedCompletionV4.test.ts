import { autonomousPersonalCompletionPlanFixtureV4 } from '../../helpers/autonomousPersonalCompletionPlanV4';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../../src/storage/AutonomousPersonalCompletionPlanV4';
import { prepareAutonomousPersonalCompletionGraphCandidateV4 } from '../../../src/storage/AutonomousPersonalCompletionGraphV4';
import {
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';
import { performance } from 'node:perf_hooks';
import {
  createAutonomousPersonalClaimIndexV4,
  getAutonomousPersonalClaimIndexGraphV4,
  getRegisteredAutonomousPersonalClaimIndexGraphV4,
} from '../../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import {
  assertAutonomousPersonalRecordIntegrityV4,
  createIntegrityCheckedAutonomousPersonalClaimIndexV4,
} from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import * as lossless from '../../../src/storage/LosslessAutomaticCaptureGraph';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

jest.mock('../../../src/storage/LosslessAutomaticCaptureGraph', () => {
  const actual = jest.requireActual('../../../src/storage/LosslessAutomaticCaptureGraph');
  return {
    ...actual,
    parseLosslessAutomaticCaptureGraph: jest.fn(actual.parseLosslessAutomaticCaptureGraph),
  };
});

const parseSpy = lossless.parseLosslessAutomaticCaptureGraph as jest.Mock;

let baseline: Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;

beforeAll(async () => {
  baseline = await autonomousPersonalQualifiedClaimFixtureV4();
});

beforeEach(() => parseSpy.mockClear());

function work(
  signal: AbortSignal = new AbortController().signal,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return { absoluteMonotonicDeadlineMs: performance.now() + 30_000, signal };
}

function graphCopy(): GraphData {
  return structuredClone(baseline.graph);
}

function corruptClaim(graph: GraphData): GraphData {
  const edge = graph.edges.find((row) =>
    Object.prototype.hasOwnProperty.call(row.attributes, 'engram_claim_v1'),
  );
  if (!edge) throw new Error('Expected a Claim3 edge fixture');
  (edge.attributes as Record<string, unknown>).engram_claim_v1 = { hostile: true };
  return graph;
}

function outcome(run: () => unknown): string {
  try {
    run();
    return 'ok';
  } catch (error) {
    const reason = (error as { reason?: unknown }).reason;
    return `${(error as Error).constructor.name}:${String(reason)}`;
  }
}

describe('owned completion snapshot V4', () => {
  it('recognizes only module-registered indexes by identity', () => {
    const index = createAutonomousPersonalClaimIndexV4(graphCopy(), work(), () => {});
    expect(getRegisteredAutonomousPersonalClaimIndexGraphV4(index)).toBe(
      getAutonomousPersonalClaimIndexGraphV4(index),
    );
    for (const value of [
      graphCopy(),
      Object.freeze(Object.create(null)),
      Object.freeze({ ...index }),
      null,
      undefined,
      'index',
    ]) {
      expect(getRegisteredAutonomousPersonalClaimIndexGraphV4(value)).toBeUndefined();
    }
  });

  it('does not recognize a proxied index or observe proxy traps', () => {
    const index = createAutonomousPersonalClaimIndexV4(graphCopy(), work(), () => {});
    const trap = jest.fn(() => {
      throw new Error('proxy trap');
    });
    const proxy = new Proxy(index, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    expect(getRegisteredAutonomousPersonalClaimIndexGraphV4(proxy)).toBeUndefined();
    expect(trap).not.toHaveBeenCalled();
  });

  it('retains cancellation identity without parsing again', () => {
    const controller = new AbortController();
    const index = createAutonomousPersonalClaimIndexV4(
      graphCopy(),
      work(controller.signal),
      () => {},
    );
    controller.abort();
    let cancelled: unknown;
    try {
      getRegisteredAutonomousPersonalClaimIndexGraphV4(index);
    } catch (error) {
      cancelled = error;
    }
    expect(cancelled).toMatchObject({
      name: 'AutonomousPersonalTypedSyntaxFailureV1',
      reason: 'cancelled',
    });
    let caught: unknown;
    try {
      assertAutonomousPersonalRecordIntegrityV4(index, work(), () => {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cancelled);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('reindexes a known index without parsing or copying its frozen graph', () => {
    const first = createAutonomousPersonalClaimIndexV4(graphCopy(), work(), () => {});
    expect(parseSpy).toHaveBeenCalledTimes(1);
    const second = createAutonomousPersonalClaimIndexV4(first, work(), () => {});
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(getAutonomousPersonalClaimIndexGraphV4(second)).toBe(
      getAutonomousPersonalClaimIndexGraphV4(first),
    );
  });

  it('asserts a known index without parsing and with raw-path parity', () => {
    for (const graph of [graphCopy(), corruptClaim(graphCopy())]) {
      const raw = outcome(() =>
        assertAutonomousPersonalRecordIntegrityV4(structuredClone(graph), work(), () => {}),
      );
      const index = createAutonomousPersonalClaimIndexV4(structuredClone(graph), work(), () => {});
      parseSpy.mockClear();
      expect(
        outcome(() => assertAutonomousPersonalRecordIntegrityV4(index, work(), () => {})),
      ).toBe(raw);
      expect(parseSpy).not.toHaveBeenCalled();
    }
    const index = createAutonomousPersonalClaimIndexV4(graphCopy(), work(), () => {});
    const checked = createIntegrityCheckedAutonomousPersonalClaimIndexV4(index, work(), () => {});
    expect(getAutonomousPersonalClaimIndexGraphV4(checked)).toBe(
      getAutonomousPersonalClaimIndexGraphV4(index),
    );
  });

  it('keeps raw GraphData inputs on the parsing path with mutable inputs', () => {
    const input = graphCopy();
    assertAutonomousPersonalRecordIntegrityV4(input, work(), () => {});
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it('propagates the guard failure of a known index unchanged, never as raw fallback', () => {
    const failure = new Error('lease_sentinel');
    let expired = false;
    const index = createAutonomousPersonalClaimIndexV4(graphCopy(), work(), () => {
      if (expired) throw failure;
    });
    expired = true;
    const caught = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(caught(() => getRegisteredAutonomousPersonalClaimIndexGraphV4(index))).toBe(failure);
    expect(caught(() => assertAutonomousPersonalRecordIntegrityV4(index, work(), () => {}))).toBe(
      failure,
    );
    expect(caught(() => createAutonomousPersonalClaimIndexV4(index, work(), () => {}))).toBe(
      failure,
    );
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('honors the current caller check on a reindexed snapshot', () => {
    const index = createAutonomousPersonalClaimIndexV4(graphCopy(), work(), () => {});
    const failure = new Error('caller_sentinel');
    let caught: unknown;
    try {
      assertAutonomousPersonalRecordIntegrityV4(index, work(), () => {
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});

describe('owned completion helper parity', () => {
  function budgetFor(f: Awaited<ReturnType<typeof autonomousPersonalCompletionPlanFixtureV4>>) {
    const budget = { remaining: f.budget.remaining, deferred: f.budget.deferred };
    expect(
      reserveAutomaticClaimSnapshotBytes(
        getAutomaticClaimReadScope(budget),
        Buffer.byteLength(JSON.stringify(f.graph)),
      ),
    ).toBe(true);
    return budget;
  }

  it('produces identical plans and changed candidates without mutating source data', async () => {
    const f = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const before = structuredClone(f.graph);
      const index = createAutonomousPersonalClaimIndexV4(f.graph, f.work, f.check);
      const raw = planAutonomousPersonalCaptureCompletionV4(
        f.input,
        f.graph,
        f.response,
        f.selection,
        f.work,
        f.check,
        budgetFor(f),
      );
      const owned = planAutonomousPersonalCaptureCompletionV4(
        f.input,
        index,
        f.response,
        f.selection,
        f.work,
        f.check,
        budgetFor(f),
      );
      expect(raw.kind).toBe('planned');
      expect(owned).toEqual(raw);
      if (raw.kind !== 'planned') throw new Error('Expected a planned synthetic claim');
      const epoch = '123e4567-e89b-42d3-a456-426614174000';
      const rawCandidate = prepareAutonomousPersonalCompletionGraphCandidateV4(
        f.graph,
        f.input,
        raw,
        epoch,
        f.work,
        f.check,
      );
      const ownedCandidate = prepareAutonomousPersonalCompletionGraphCandidateV4(
        index,
        f.input,
        raw,
        epoch,
        f.work,
        f.check,
      );
      expect(rawCandidate.kind).toBe('candidate');
      expect(ownedCandidate).toEqual(rawCandidate);
      expect(f.graph).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it('keeps wrong-namespace completion rejected on both data paths', async () => {
    const f = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const input = structuredClone(f.input);
      input.scope.request.namespace = 'synthetic-wrong-namespace';
      input.scope.context.namespace = 'synthetic-wrong-namespace';
      const index = createAutonomousPersonalClaimIndexV4(f.graph, f.work, f.check);
      const raw = planAutonomousPersonalCaptureCompletionV4(
        input,
        f.graph,
        f.response,
        f.selection,
        f.work,
        f.check,
        budgetFor(f),
      );
      const owned = planAutonomousPersonalCaptureCompletionV4(
        input,
        index,
        f.response,
        f.selection,
        f.work,
        f.check,
        budgetFor(f),
      );
      expect(raw.kind).toBe('no_write');
      expect(owned).toEqual(raw);
    } finally {
      await f.close();
    }
  });

  it('does not convert known-index guard failures into planner or candidate data failures', async () => {
    const f = await autonomousPersonalCompletionPlanFixtureV4();
    try {
      const plan = planAutonomousPersonalCaptureCompletionV4(
        f.input,
        f.graph,
        f.response,
        f.selection,
        f.work,
        f.check,
        budgetFor(f),
      );
      if (plan.kind !== 'planned') throw new Error('Expected a planned synthetic claim');
      const failure = new Error('owned index guard sentinel');
      let fail = false;
      const index = createAutonomousPersonalClaimIndexV4(f.graph, f.work, () => {
        if (fail) throw failure;
      });
      fail = true;
      let caught: unknown;
      try {
        planAutonomousPersonalCaptureCompletionV4(
          f.input,
          index,
          f.response,
          f.selection,
          f.work,
          f.check,
          budgetFor(f),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      caught = undefined;
      try {
        prepareAutonomousPersonalCompletionGraphCandidateV4(
          index,
          f.input,
          plan,
          null,
          f.work,
          f.check,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    } finally {
      await f.close();
    }
  });
});
