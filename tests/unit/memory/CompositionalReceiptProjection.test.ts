import { projectCompositionalCaptureReceiptSummaryV3 as project } from '../../../src/memory/CompositionalHumanCaptureV3';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';

describe('receipt display projection, not processing authority', () => {
  test.each(['accepted', 'proposed'] as const)(
    'preserves actual %s creation state without raw source or proof hashes',
    (review) => {
      const fixture = makeCompositionalCommittedClaimFixture(review);
      const summary = project(fixture.operation.terminalReceipt);
      expect(summary).toMatchObject({
        kind: 'committed',
        persisted: true,
        acceptedCoverage: review === 'accepted' ? 'all' : 'none',
        selection: { kind: 'bundles', items: [{ state: review, persisted: true }] },
      });
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(fixture.source.content);
      expect(serialized).not.toContain('sourceHash');
      expect(serialized).not.toContain('operationHash');
      expect(serialized).not.toContain('should_process');
      expect(Object.isFrozen(summary)).toBe(true);
      if (summary.kind === 'committed' && summary.selection.kind === 'bundles') {
        expect(Object.isFrozen(summary.selection.items)).toBe(true);
        expect(Object.isFrozen(summary.selection.items[0])).toBe(true);
      }
    },
  );
  test('owns raw values before schema inspection', () => {
    let traps = 0;
    const getter = Object.defineProperty({}, 'then', { enumerable: true, get: () => ++traps });
    expect(() => project(getter)).toThrow();
    expect(() => project(new Proxy({}, { get: () => ++traps }))).toThrow();
    expect(traps).toBe(0);
  });
  test('propagates caller cancellation unchanged, including final projection work', () => {
    const receipt = makeCompositionalCommittedClaimFixture().operation.terminalReceipt;
    let calls = 0;
    project(receipt, () => calls++);
    const cancelled = new Error('synthetic cancellation');
    let remaining = calls;
    expect(() =>
      project(receipt, () => {
        if (--remaining === 0) throw cancelled;
      }),
    ).toThrow(cancelled);
  });
});
