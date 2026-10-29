import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import {
  compositionalClaimReviewPairHashV3 as pairHash,
  prepareCompositionalClaimReviewV3 as prepare,
} from '../../../src/storage/CompositionalClaimReviewV3';
import { validateCompositionalQualifiedClaimReadV3 as read } from '../../../src/extraction/CompositionalQualifiedClaimReadV3';
import { reviewExtractionMetadata } from '../../../src/schemas/ExtractionMetadata.schema';

function fixture(review: 'accepted' | 'proposed' = 'proposed') {
  const f = makeCompositionalCommittedClaimFixture(review);
  const pair = {
    namespace: f.request.namespace,
    edge: f.graph.edges[0],
    value: f.graph.entities.find((v) => v.uuid === f.graph.edges[0].target_node_uuid)!,
  };
  return {
    ...f,
    pair,
    command: {
      version: 3 as const,
      namespace: f.request.namespace,
      edgeId: f.request.edgeId,
      expectedPairHash: pairHash(pair),
      reviewStatus: 'accepted' as const,
      reviewedBy: 'synthetic-reviewer',
    },
    context: { storeHash: f.operation.identity.storeHash, backendNow: f.request.now },
  };
}

describe('pure compositional paired operator review', () => {
  it.each(['accepted', 'proposed', 'rejected'] as const)(
    'prepares a complete paired %s review without changing source/receipt/graph',
    (reviewStatus) => {
      const f = fixture();
      const before = structuredClone(f.graph);
      const result = prepare(f.graph, { ...f.command, reviewStatus }, f.context);
      expect(result.kind).toBe('prepared_review');
      if (result.kind !== 'prepared_review') throw new Error('fixture');
      for (const row of [result.pair.edge, result.pair.value]) {
        expect(row.updated_at).toBe(f.context.backendNow);
        expect(row.attributes.engram_extraction).toMatchObject({
          source: 'policy',
          confidence: null,
          review_status: reviewStatus,
          threshold_decision: 'manually_reviewed',
          reviewed_by: f.command.reviewedBy,
          reviewed_at: f.context.backendNow,
        });
      }
      const candidate = {
        ...f.graph,
        edges: [result.pair.edge],
        entities: f.graph.entities.map((v) =>
          v.uuid === result.pair.value.uuid ? result.pair.value : v,
        ),
      };
      expect(read(candidate, f.request)).toMatchObject({
        status: 'valid_data',
        creationReview: 'proposed',
        currentReview: reviewStatus,
      });
      expect(f.graph).toEqual(before);
      expect(candidate.automatic_operations_v1).toEqual(before.automatic_operations_v1);
      expect(candidate.episodes).toEqual(before.episodes);
      expect(result.pair.edge.attributes.engram_claim_v1).toEqual(
        f.pair.edge.attributes.engram_claim_v1,
      );
      expect(result.pair.value.attributes.engram_literal_v1).toEqual(
        f.pair.value.attributes.engram_literal_v1,
      );
      expect(result).not.toHaveProperty('should_process');
    },
  );

  it('permits manual rejection of accepted-at-creation data without rewriting its receipt', () => {
    const f = fixture('accepted');
    const result = prepare(f.graph, { ...f.command, reviewStatus: 'rejected' }, f.context);
    expect(result.kind).toBe('prepared_review');
    expect(f.operation.terminalReceipt.acceptedCoverage).toBe('all');
  });

  it('compares the exact pair hash before treating a repeated review as unchanged', () => {
    const f = fixture();
    for (const row of [f.pair.edge, f.pair.value])
      row.attributes.engram_extraction = reviewExtractionMetadata(
        row.attributes.engram_extraction,
        'accepted',
        f.command.reviewedBy,
        '2026-10-25T12:00:02.000Z',
      );
    expect(prepare(f.graph, f.command, f.context)).toEqual({
      kind: 'decision',
      reason: 'conflict',
    });
    const command = { ...f.command, expectedPairHash: pairHash(f.pair) };
    const result = prepare(f.graph, command, f.context);
    expect(result).toEqual({ kind: 'unchanged', pair: f.pair });
    expect(
      prepare(f.graph, { ...command, reviewedBy: 'second-synthetic-reviewer' }, f.context).kind,
    ).toBe('prepared_review');
  });

  it.each(['reviewer', 'review_time', 'threshold'] as const)(
    'rejects an existing mismatched %s instead of repairing it',
    (kind) => {
      const f = fixture();
      for (const row of [f.pair.edge, f.pair.value])
        row.attributes.engram_extraction = reviewExtractionMetadata(
          row.attributes.engram_extraction,
          'accepted',
          'same-reviewer',
          '2026-10-25T12:00:02.000Z',
        );
      const meta = f.pair.value.attributes.engram_extraction as Record<string, unknown>;
      if (kind === 'reviewer') meta.reviewed_by = 'another-reviewer';
      else if (kind === 'review_time') meta.reviewed_at = f.request.now;
      else meta.threshold_decision = 'auto_accepted';
      expect(prepare(f.graph, f.command, f.context)).toEqual({
        kind: 'decision',
        reason: 'invalid_claim',
      });
    },
  );

  it.each(['namespace', 'store', 'missing_value', 'missing_creator', 'missing_binding'] as const)(
    'fails closed for %s without changing original records',
    (kind) => {
      const f = fixture();
      const command = { ...f.command };
      const context = { ...f.context };
      if (kind === 'namespace') command.namespace += ' ';
      else if (kind === 'store') context.storeHash = '0'.repeat(64);
      else if (kind === 'missing_value')
        f.graph.entities = f.graph.entities.filter((v) => v.uuid !== f.pair.value.uuid);
      else if (kind === 'missing_creator') delete f.graph.automatic_operations_v1;
      else f.graph.entities[0].attributes = {};
      const before = structuredClone(f.graph);
      expect(prepare(f.graph, command, context).kind).toBe('decision');
      expect(f.graph).toEqual(before);
    },
  );

  it.each([
    'edge_time',
    'value_time',
    'manual_time',
    'operation_time',
    'terminal_time',
    'invalid_clock',
  ] as const)('reports a fixed backend clock failure for %s', (kind) => {
    const f = fixture();
    if (kind === 'edge_time') f.pair.edge.updated_at = '2026-10-25T12:00:04.000Z';
    else if (kind === 'value_time') f.pair.value.updated_at = '2026-10-25T12:00:04.000Z';
    else if (kind === 'manual_time')
      for (const row of [f.pair.edge, f.pair.value])
        row.attributes.engram_extraction = reviewExtractionMetadata(
          row.attributes.engram_extraction,
          'accepted',
          f.command.reviewedBy,
          '2026-10-25T12:00:04.000Z',
        );
    else if (kind === 'operation_time' || kind === 'terminal_time') {
      const op = f.graph.automatic_operations_v1!.operations[0];
      op.lastObservedAt = '2026-10-25T12:00:04.000Z';
      if (kind === 'terminal_time' && op.version === 3 && op.state === 'committed')
        op.terminalReceipt.terminalAt = op.lastObservedAt;
    } else f.context.backendNow = 'invalid';
    expect(prepare(f.graph, f.command, f.context)).toEqual({
      kind: 'decision',
      reason: 'backend_clock_invalid',
    });
  });

  it('rejects a confidence override explicitly through the closed request', () => {
    const f = fixture();
    expect(prepare(f.graph, { ...f.command, confidence: 0.99 }, f.context)).toEqual({
      kind: 'decision',
      reason: 'invalid_input',
    });
  });

  it('does not run getters or proxy traps on caller data or hash inputs', () => {
    const f = fixture();
    let traps = 0;
    const hostile = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => {
        traps++;
        return 3;
      },
    });
    const proxy = new Proxy({}, { get: () => (++traps, 3) });
    for (const input of [hostile, proxy, { ...f.command, extra: 'x'.repeat(600_000) }]) {
      expect(prepare(f.graph, input, f.context)).toEqual({
        kind: 'decision',
        reason: 'invalid_input',
      });
      expect(() => pairHash(input)).toThrow();
    }
    expect(traps).toBe(0);
  });

  it('propagates cancellation without returning a prepared result', () => {
    const f = fixture();
    const error = new Error('synthetic-cancel');
    let calls = 0;
    expect(() =>
      prepare(f.graph, f.command, f.context, () => {
        if (++calls === 7) throw error;
      }),
    ).toThrow(error);
    expect(calls).toBe(7);
  });
});
