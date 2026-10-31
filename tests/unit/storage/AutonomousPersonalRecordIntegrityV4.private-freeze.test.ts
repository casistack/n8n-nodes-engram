import { performance } from 'node:perf_hooks';
import {
  createAutonomousPersonalClaimIndexV4,
  getAutonomousPersonalClaimIndexGraphV4,
} from '../../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import {
  assertAutonomousPersonalRecordIntegrityV4,
  createIntegrityCheckedAutonomousPersonalClaimIndexV4,
} from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

let baseline: Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;

beforeAll(async () => {
  baseline = await autonomousPersonalQualifiedClaimFixtureV4();
});

function work(
  signal: AbortSignal = new AbortController().signal,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return { absoluteMonotonicDeadlineMs: performance.now() + 30_000, signal };
}

function graphCopy(): GraphData {
  return structuredClone(baseline.graph);
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
}

function isDeepUnfrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isDeepUnfrozen);
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

function corruptClaim(graph: GraphData): GraphData {
  const edge = graph.edges.find((row) =>
    Object.prototype.hasOwnProperty.call(row.attributes, 'engram_claim_v1'),
  );
  if (!edge) throw new Error('Expected a Claim3 edge fixture');
  (edge.attributes as Record<string, unknown>).engram_claim_v1 = { hostile: true };
  return graph;
}

describe('record integrity V4 private freeze scope', () => {
  it('still deep-freezes graphs owned by public returned indexes', () => {
    const input = graphCopy();
    const checked = createIntegrityCheckedAutonomousPersonalClaimIndexV4(input, work(), () => {});
    expect(isDeepFrozen(getAutonomousPersonalClaimIndexGraphV4(checked))).toBe(true);
    const plain = createAutonomousPersonalClaimIndexV4(input, work(), () => {});
    const plainGraph = getAutonomousPersonalClaimIndexGraphV4(plain);
    expect(isDeepFrozen(plainGraph)).toBe(true);
    expect(plainGraph).not.toBe(input);
    expect(isDeepUnfrozen(input)).toBe(true);
  });

  it('assert returns undefined and leaves the original input mutable', () => {
    const input = graphCopy();
    expect(assertAutonomousPersonalRecordIntegrityV4(input, work(), () => {})).toBeUndefined();
    expect(isDeepUnfrozen(input)).toBe(true);
    expect(input).toEqual(baseline.graph);
  });

  it('keeps semantic parity with the frozen public path on valid and hostile input', () => {
    for (const graph of [graphCopy(), corruptClaim(graphCopy())]) {
      const asserted = outcome(() =>
        assertAutonomousPersonalRecordIntegrityV4(structuredClone(graph), work(), () => {}),
      );
      const checked = outcome(() =>
        createIntegrityCheckedAutonomousPersonalClaimIndexV4(
          structuredClone(graph),
          work(),
          () => {},
        ),
      );
      expect(asserted).toBe(checked);
    }
    expect(
      outcome(() =>
        assertAutonomousPersonalRecordIntegrityV4(corruptClaim(graphCopy()), work(), () => {}),
      ),
    ).not.toBe('ok');
  });

  it('never hands arguments to the code-owned check callback', () => {
    const seen: unknown[][] = [];
    const sentinel = function (this: unknown, ...args: unknown[]) {
      seen.push([this, ...args]);
    };
    assertAutonomousPersonalRecordIntegrityV4(graphCopy(), work(), sentinel);
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) expect(call).toEqual([undefined]);
  });

  it('propagates a sticky callback failure and cancellation unchanged', () => {
    const failure = new Error('sentinel');
    let calls = 0;
    let caught: unknown;
    try {
      assertAutonomousPersonalRecordIntegrityV4(graphCopy(), work(), () => {
        calls += 1;
        if (calls === 5) throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      assertAutonomousPersonalRecordIntegrityV4(graphCopy(), work(controller.signal), () => {}),
    ).toThrow(AutonomousPersonalTypedSyntaxFailureV1);
  });

  it('accepts a no-footprint snapshot without freezing input', () => {
    const input = graphCopy();
    input.edges = [];
    input.episodes = [];
    input.entities = [];
    delete input.automatic_operations_v1;
    const asserted = outcome(() =>
      assertAutonomousPersonalRecordIntegrityV4(input, work(), () => {}),
    );
    expect(asserted).toBe(
      outcome(() =>
        createIntegrityCheckedAutonomousPersonalClaimIndexV4(
          structuredClone(input),
          work(),
          () => {},
        ),
      ),
    );
    expect(isDeepUnfrozen(input)).toBe(true);
  });
});
