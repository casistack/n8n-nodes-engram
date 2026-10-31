import { performance } from 'node:perf_hooks';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import { assertAutomaticLedgerSourceIntegrity } from '../../../src/storage/AutomaticIdentity';
import {
  assertAutonomousPersonalRecordIntegrityV4,
  parseIntegrityCheckedAutonomousPersonalGraphV4,
} from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import * as lossless from '../../../src/storage/LosslessAutomaticCaptureGraph';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

let baseline: Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;

beforeAll(async () => {
  baseline = await autonomousPersonalQualifiedClaimFixtureV4();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function work(): AutonomousPersonalTypedSyntaxWorkV1 {
  return {
    absoluteMonotonicDeadlineMs: performance.now() + 30_000,
    signal: new AbortController().signal,
  };
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

// The pre-Plan031 composition: storage parse, then ledger and record integrity.
function original(value: unknown): void {
  const graph = lossless.parseLosslessAutomaticCaptureGraph(value);
  assertAutomaticLedgerSourceIntegrity(graph);
  assertAutonomousPersonalRecordIntegrityV4(graph, work(), () => {});
}

describe('parseIntegrityCheckedAutonomousPersonalGraphV4', () => {
  it('parses exactly once and returns a fresh graph equal to the input', () => {
    const spy = jest.spyOn(lossless, 'parseLosslessAutomaticCaptureGraph');
    const input = graphCopy();
    const graph = parseIntegrityCheckedAutonomousPersonalGraphV4(input, work(), () => {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(graph).not.toBe(input);
    expect(graph).toEqual(input);
    expect(input).toEqual(baseline.graph);
    expect(Object.isFrozen(graph)).toBe(false);
  });

  it('matches the original composition on valid and semantically hostile input', () => {
    for (const graph of [graphCopy(), corruptClaim(graphCopy())]) {
      expect(
        outcome(() =>
          parseIntegrityCheckedAutonomousPersonalGraphV4(structuredClone(graph), work(), () => {}),
        ),
      ).toBe(outcome(() => original(structuredClone(graph))));
    }
    expect(
      outcome(() =>
        parseIntegrityCheckedAutonomousPersonalGraphV4(corruptClaim(graphCopy()), work(), () => {}),
      ),
    ).not.toBe('ok');
  });

  it('rethrows the original raw parse error classification', () => {
    let raw: unknown;
    try {
      lossless.parseLosslessAutomaticCaptureGraph('not a graph');
    } catch (error) {
      raw = error;
    }
    expect(raw).toBeDefined();
    expect(
      outcome(() =>
        parseIntegrityCheckedAutonomousPersonalGraphV4('not a graph', work(), () => {}),
      ),
    ).toBe(outcome(() => lossless.parseLosslessAutomaticCaptureGraph('not a graph')));
  });

  it('propagates a code-owned check failure from the validation phase', () => {
    const failure = new Error('sentinel');
    expect(() =>
      parseIntegrityCheckedAutonomousPersonalGraphV4(graphCopy(), work(), () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});
