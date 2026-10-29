import { makeCompositionalCommittedClaimFixture as committedFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { validateCompositionalQualifiedClaimReadV3 as validate } from '../../../src/extraction/CompositionalQualifiedClaimReadV3';
import {
  CompositionalQualifiedClaimReadContextV3Schema,
  CompositionalQualifiedClaimCommitProofV3Schema,
} from '../../../src/schemas/CompositionalQualifiedClaimReadV3.schema';
import { reviewExtractionMetadata } from '../../../src/schemas/ExtractionMetadata.schema';
import { applyAutomaticBindingCommand } from '../../../src/storage/AutomaticIdentity';
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
describe('same-family full-root creation evidence (data only)', () => {
  it('reconstructs a rich complete actual source and unique creator without a permit', () => {
    const f = committedFixture();
    const before = copy(f.graph);
    const result = validate(f.graph, f.request);
    expect(result.status).toBe('valid_data');
    if (result.status !== 'valid_data') throw new Error(JSON.stringify(result));
    expect(result.creationReview).toBe('accepted');
    expect(result.currentReview).toBe('accepted');
    expect(CompositionalQualifiedClaimReadContextV3Schema.parse(result.context)).toEqual(
      result.context,
    );
    expect(result).not.toHaveProperty('should_process');
    expect(result).not.toHaveProperty('eligibleFirstCommit');
    expect(f.graph).toEqual(before);
  });
  it('preserves proposed-at-commit separately from actual paired manual acceptance', () => {
    const f = committedFixture('proposed');
    for (const row of [f.graph.edges[0], f.graph.entities[1]])
      row.attributes.engram_extraction = reviewExtractionMetadata(
        row.attributes.engram_extraction,
        'accepted',
        'synthetic-operator',
        '2026-10-25T12:00:02.000Z',
      );
    expect(validate(f.graph, f.request)).toMatchObject({
      status: 'valid_data',
      creationReview: 'proposed',
      currentReview: 'accepted',
    });
    expect(f.operation.terminalReceipt.kind).toBe('human_compositional_capture_committed');
    if (f.operation.terminalReceipt.kind !== 'human_compositional_capture_committed')
      throw new Error('fixture');
    expect(f.operation.terminalReceipt.acceptedCoverage).toBe('none');
  });
  it.each(['reviewer', 'time', 'threshold'] as const)(
    'rejects paired current metadata mismatch: %s',
    (field) => {
      const f = committedFixture('proposed');
      for (const row of [f.graph.edges[0], f.graph.entities[1]])
        row.attributes.engram_extraction = reviewExtractionMetadata(
          row.attributes.engram_extraction,
          'accepted',
          'operator',
          '2026-10-25T12:00:02.000Z',
        );
      const meta = f.graph.entities[1].attributes.engram_extraction as Record<string, unknown>;
      if (field === 'reviewer') meta.reviewed_by = 'different-operator';
      else if (field === 'time') meta.reviewed_at = '2026-10-25T12:00:02.001Z';
      else meta.threshold_decision = 'auto_accepted';
      expect(validate(f.graph, f.request)).toEqual({
        status: 'invalid',
        reason: 'invalid_review_pair',
      });
    },
  );
  it('keeps unchanged proposed and paired manually rejected data distinct', () => {
    const f = committedFixture('proposed');
    expect(validate(f.graph, f.request)).toMatchObject({
      status: 'valid_data',
      creationReview: 'proposed',
      currentReview: 'proposed',
    });
    for (const row of [f.graph.edges[0], f.graph.entities[1]])
      row.attributes.engram_extraction = reviewExtractionMetadata(
        row.attributes.engram_extraction,
        'rejected',
        'synthetic-operator',
        '2026-10-25T12:00:02.000Z',
      );
    expect(validate(f.graph, f.request)).toMatchObject({
      status: 'valid_data',
      creationReview: 'proposed',
      currentReview: 'rejected',
    });
  });
  it.each(['missing', 'captured', 'repeat_only', 'ambiguous'] as const)(
    'requires a unique actual committed creation operation: %s',
    (kind) => {
      const f = committedFixture();
      if (kind === 'missing') delete f.graph.automatic_operations_v1;
      else if (kind === 'captured')
        f.graph.automatic_operations_v1!.operations = [f.capturedOperation];
      else if (kind === 'ambiguous')
        f.graph.automatic_operations_v1!.operations.push({
          ...f.operation,
          operationId: '99999999-9999-4999-8999-999999999999',
        });
      else {
        if (f.operation.terminalReceipt.kind !== 'human_compositional_capture_committed')
          throw new Error('fixture');
        const item = f.operation.terminalReceipt.selection.items[0];
        item.state = 'unchanged';
        item.mutation = 'none';
        f.graph.automatic_operations_v1!.operations = [f.operation];
      }
      expect(validate(f.graph, f.request).status).not.toBe('valid_data');
    },
  );
  it.each([
    'source',
    'namespace',
    'actor',
    'descriptor',
    'dependency',
    'evidence',
    'key',
    'endpoint',
    'review_pair',
    'manual_evidence',
    'future_review',
    'trust',
    'revocation',
    'global_binding_duplicate',
    'raw_proto',
  ] as const)('rejects altered actual evidence or current authority: %s', (kind) => {
    const f = committedFixture();
    const edge = f.graph.edges[0];
    const value = f.graph.entities[1];
    switch (kind) {
      case 'source':
        f.graph.episodes[0].content += ' extra';
        break;
      case 'namespace':
        f.request.namespace += ' ';
        break;
      case 'actor':
        (edge.attributes.engram_claim_v1 as Record<string, unknown>).actorReference = 'other';
        break;
      case 'descriptor':
        f.operation.descriptor.invocationDeadlineMs = 12345;
        break;
      case 'dependency':
        if (f.operation.terminalReceipt.kind === 'human_compositional_capture_committed')
          f.operation.terminalReceipt.selection.items[0].predicateDependencies[0].dependencyHash =
            'f'.repeat(64);
        break;
      case 'evidence':
        value.name += ' missing';
        break;
      case 'key':
        (edge.attributes.engram_claim_v1 as Record<string, unknown>).key = 'f'.repeat(64);
        break;
      case 'endpoint':
        edge.target_node_uuid = f.source.uuid;
        break;
      case 'review_pair':
        value.attributes.engram_extraction = reviewExtractionMetadata(
          value.attributes.engram_extraction,
          'rejected',
          'operator',
          '2026-10-25T12:00:02.000Z',
        );
        break;
      case 'manual_evidence':
        for (const row of [edge, value])
          row.attributes.engram_extraction = {
            ...(row.attributes.engram_extraction as object),
            review_status: 'proposed',
          };
        break;
      case 'future_review':
        for (const row of [edge, value])
          row.attributes.engram_extraction = reviewExtractionMetadata(
            row.attributes.engram_extraction,
            'accepted',
            'operator',
            '2026-10-25T12:00:05.000Z',
          );
        break;
      case 'trust':
        f.graph.episodes[0].trust_level = 'trusted';
        break;
      case 'revocation':
        applyAutomaticBindingCommand(
          f.graph,
          {
            namespace: f.request.namespace,
            action: 'revoke',
            bindingId: f.operation.identity.binding.bindingId,
            expectedRevision: 1,
            reason: 'synthetic',
            authorizedBy: 'operator',
          },
          f.operation.identity.binding.bindingId,
          '2026-10-25T12:00:02.000Z',
        );
        break;
      case 'global_binding_duplicate':
        f.graph.entities.push({
          ...copy(f.graph.entities[0]),
          uuid: '99999999-9999-4999-8999-999999999999',
        });
        break;
      case 'raw_proto':
        Object.defineProperty(f.graph.episodes[0].attributes, '__proto__', {
          enumerable: true,
          value: { synthetic: true },
        });
        break;
    }
    // Mutated op is the actual stored row, not an unrelated receipt argument.
    if (kind === 'descriptor' || kind === 'dependency')
      f.graph.automatic_operations_v1!.operations = [f.operation];
    expect(validate(f.graph, f.request).status).not.toBe('valid_data');
  });
  it('bounds oversized contexts and unknown raw input before deep validation', () => {
    const f = committedFixture();
    f.graph.entities[0].summary = 'x'.repeat(512 * 1024);
    expect(validate(f.graph, f.request)).toEqual({
      status: 'invalid',
      reason: 'context_too_large',
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validate(cyclic, f.request).status).toBe('invalid');
  });
  it('rejects normalization of protected review metadata', () => {
    const f = committedFixture();
    delete (f.graph.edges[0].attributes.engram_extraction as Record<string, unknown>).reviewed_at;
    expect(validate(f.graph, f.request)).toEqual({
      status: 'invalid',
      reason: 'invalid_review_pair',
    });
  });
  it('requires actual review evidence for both rows, not a changed accepted flag', () => {
    const f = committedFixture('proposed');
    for (const row of [f.graph.edges[0], f.graph.entities[1]])
      row.attributes.engram_extraction = {
        ...(row.attributes.engram_extraction as object),
        review_status: 'accepted',
      };
    expect(validate(f.graph, f.request)).toEqual({
      status: 'invalid',
      reason: 'invalid_review_pair',
    });
  });
  it.each(['summary', 'value_embedding', 'edge_embedding'] as const)(
    'rejects changed immutable created value geometry: %s',
    (field) => {
      const f = committedFixture();
      if (field === 'summary') f.graph.entities[1].summary = 'changed automatic value';
      else if (field === 'value_embedding') f.graph.entities[1].name_embedding = [0.1];
      else f.graph.edges[0].fact_embedding = [0.1];
      expect(validate(f.graph, f.request).status).toBe('invalid');
    },
  );
  it('latches a one-shot cancellation swallowed by parser recovery', () => {
    const f = committedFixture();
    const cancelled = new Error('one shot parser cancellation');
    let thrown = false;
    expect(() =>
      validate(f.graph, f.request, () => {
        if (!thrown && new Error().stack?.includes('CompositionalPreferenceV2Parser')) {
          thrown = true;
          throw cancelled;
        }
      }),
    ).toThrow(cancelled);
    expect(thrown).toBe(true);
  });
  it('propagates cancellation during later global/source checks without returning invalid data', () => {
    const f = committedFixture();
    let count = 0;
    const cancelled = new Error('later cancellation');
    expect(() =>
      validate(f.graph, f.request, () => {
        if (++count === 12) throw cancelled;
      }),
    ).toThrow(cancelled);
    expect(count).toBe(12);
  });
  it('caps the public minimal proof at 24KiB before nested schema work', () => {
    const f = committedFixture();
    const result = validate(f.graph, f.request);
    if (result.status !== 'valid_data') throw new Error('fixture');
    expect(Buffer.byteLength(JSON.stringify(result.context.proof))).toBeLessThan(24 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result.context))).toBeLessThan(512 * 1024);
    expect(
      CompositionalQualifiedClaimCommitProofV3Schema.safeParse({
        ...result.context.proof,
        unknown: 'x'.repeat(24 * 1024),
      }).success,
    ).toBe(false);
  });
  it('never treats a public minimal context as an actual root', () => {
    const f = committedFixture();
    const result = validate(f.graph, f.request);
    if (result.status !== 'valid_data') throw new Error('fixture');
    expect(validate(result.context, f.request).status).not.toBe('valid_data');
  });
  it('rejects getters/proxies without invoking them and propagates cancellation distinctly', () => {
    let calls = 0;
    const graph = {};
    Object.defineProperty(graph, 'entities', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('secret');
      },
    });
    const validRequest = committedFixture().request;
    expect(validate(graph, validRequest).status).toBe('invalid');
    expect(calls).toBe(0);
    const f = committedFixture();
    const proxy = new Proxy(f.graph, {
      ownKeys() {
        calls++;
        throw new Error('secret');
      },
    });
    expect(validate(proxy, f.request).status).toBe('invalid');
    expect(calls).toBe(0);
    const cancelled = new Error('cancelled');
    expect(() =>
      validate(f.graph, f.request, () => {
        throw cancelled;
      }),
    ).toThrow(cancelled);
  });
});
