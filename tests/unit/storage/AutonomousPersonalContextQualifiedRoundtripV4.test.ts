import { performance } from 'node:perf_hooks';
import {
  createAutonomousPersonalClaimIndexV4,
  inspectAutonomousPersonalClaimCreatorV4,
} from '../../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import { assertAutonomousPersonalRecordIntegrityV4 } from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

const LITERAL = 'I review pull requests first thing when I start work.';
const MARKER = 'context_conditional_v1';

// Inspection accepts a code-owned index, never a caller-supplied raw graph.
function inspect(graph: GraphData, edgeId: string) {
  const index = createAutonomousPersonalClaimIndexV4(
    graph,
    {
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal: new AbortController().signal,
    },
    () => undefined,
  );
  return inspectAutonomousPersonalClaimCreatorV4(index, edgeId);
}

let qualified: Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;
let legacy: Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;

beforeAll(async () => {
  qualified = await autonomousPersonalQualifiedClaimFixtureV4({
    content: LITERAL,
    statementContextMode: 'contextQualifiedV1',
  });
  // Legacy V1 deliberately withholds conditional assertions; use its supported unqualified form.
  legacy = await autonomousPersonalQualifiedClaimFixtureV4({
    content: 'I review pull requests first thing.',
  });
});

function integrity(graph: GraphData): void {
  assertAutonomousPersonalRecordIntegrityV4(
    graph,
    {
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal: new AbortController().signal,
    },
    () => undefined,
  );
}

function claimOf(graph: GraphData, edgeId: string): Record<string, unknown> {
  return graph.edges.find((edge) => edge.uuid === edgeId)!.attributes.engram_claim_v1 as Record<
    string,
    unknown
  >;
}

describe('context-qualified statement creator reconstruction (end-to-end seam)', () => {
  it('rebuilds the persisted qualified claim exactly and keeps source facts unchanged', () => {
    const claim = claimOf(qualified.graph, qualified.edge.uuid);
    expect(claim.qualification).toBe(MARKER);
    expect((claim.evidence as { literal: string }).literal).toBe(LITERAL);
    const inspected = inspect(qualified.graph, qualified.edge.uuid);
    expect(inspected.status).toBe('structural');
    expect(() => integrity(qualified.graph)).not.toThrow();
    if (inspected.status !== 'structural') return;
    expect(inspected.proof.sourceHash).toBe((claim as { sourceHash: string }).sourceHash);
    expect(inspected.proof.rawSpan).toEqual((claim.evidence as { rawSpan: unknown }).rawSpan);
    expect(inspected.proof.mappedSpan).toEqual(
      (claim.evidence as { mappedSpan: unknown }).mappedSpan,
    );
  });

  it('keeps the legacy unmarked claim byte-for-byte reconstructable', () => {
    expect(claimOf(legacy.graph, legacy.edge.uuid)).not.toHaveProperty('qualification');
    expect(inspect(legacy.graph, legacy.edge.uuid).status).toBe('structural');
    expect(() => integrity(legacy.graph)).not.toThrow();
  });

  it('fails closed when the marker is stripped from a qualified source', () => {
    const graph = structuredClone(qualified.graph);
    delete claimOf(graph, qualified.edge.uuid).qualification;
    expect(inspect(graph, qualified.edge.uuid).status).toBe('invalid');
    expect(() => integrity(graph)).toThrow();
  });

  it('fails closed when a marker is forged onto a legacy/unqualified source', () => {
    const graph = structuredClone(legacy.graph);
    claimOf(graph, legacy.edge.uuid).qualification = MARKER;
    expect(inspect(graph, legacy.edge.uuid).status).toBe('invalid');
    expect(() => integrity(graph)).toThrow();
  });
});

describe('consistently re-keyed marker corruption is rejected by source-policy recomputation', () => {
  test.each(['forged', 'stripped'] as const)(
    '%s marker cannot authorize a self-consistent record',
    async (mode) => {
      const fixture = await autonomousPersonalQualifiedClaimFixtureV4(
        mode === 'forged'
          ? {
              content: 'I review pull requests first thing.',
              candidateQualificationOverride: 'context_conditional_v1',
            }
          : {
              content: LITERAL,
              statementContextMode: 'contextQualifiedV1',
              candidateQualificationOverride: 'omit',
            },
      );
      expect(fixture.candidate.kind).toBe('candidate');
      if (fixture.candidate.kind !== 'candidate') throw new Error('Expected re-keyed candidate');
      const item =
        fixture.receipt.selection.kind === 'occurrences'
          ? fixture.receipt.selection.items[0]
          : null;
      expect(item?.claimId).toBe(fixture.edge.uuid);
      expect(item?.meaningHash).toBe(fixture.candidate.reference.meaningHash);
      expect(item?.dependencies).toEqual(fixture.candidate.reference.dependencies);
      expect(inspect(fixture.graph, fixture.edge.uuid)).toMatchObject({
        status: 'invalid',
        reason: 'invalid_claim',
      });
      expect(() => integrity(fixture.graph)).toThrow();
    },
  );
});
