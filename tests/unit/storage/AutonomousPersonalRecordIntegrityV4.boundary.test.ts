import { performance } from 'node:perf_hooks';
import { makeCompositionalAssistantHumanParentFixture } from '../../helpers/compositionalAssistantParentFixture';
import { assertAutonomousPersonalRecordIntegrityV4 } from '../../../src/storage/AutonomousPersonalRecordIntegrityV4';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  autonomousPersonalQualifiedClaimFixtureV4,
  type AutonomousPersonalQualifiedClaimFixtureV4,
} from '../../helpers/autonomousPersonalQualifiedClaimV4';

let fixture: AutonomousPersonalQualifiedClaimFixtureV4;
beforeAll(async () => {
  fixture = await autonomousPersonalQualifiedClaimFixtureV4();
});
function work(): AutonomousPersonalTypedSyntaxWorkV1 {
  return {
    absoluteMonotonicDeadlineMs: performance.now() + 5_000,
    signal: new AbortController().signal,
  };
}
it('retains historical structure after current source rejection, distrust and expiry', () => {
  const value = structuredClone(fixture);
  value.source.review_status = 'rejected';
  value.source.trust_level = 'untrusted';
  value.edge.expired_at = value.backendNow;
  const before = JSON.stringify(value.graph);
  expect(() =>
    assertAutonomousPersonalRecordIntegrityV4(value.graph, work(), () => undefined),
  ).not.toThrow();
  expect(JSON.stringify(value.graph)).toBe(before);
});
it('detects a receipt-owned pair even after both metadata tags and the reserved entity type disappear', () => {
  const value = structuredClone(fixture);
  delete value.edge.attributes.engram_claim_v1;
  delete value.value.attributes.engram_literal_v1;
  value.value.entity_type = 'concept';
  const before = JSON.stringify(value.graph);
  expect(() =>
    assertAutonomousPersonalRecordIntegrityV4(value.graph, work(), () => undefined),
  ).toThrow();
  expect(JSON.stringify(value.graph)).toBe(before);
});
it('preserves a legitimate paired manual rejection without rewriting the accepted creator receipt', () => {
  const value = structuredClone(fixture);
  const receiptBefore = JSON.stringify(value.operation.terminalReceipt);
  for (const row of [value.edge, value.value]) {
    Object.assign(row.attributes.engram_extraction as Record<string, unknown>, {
      review_status: 'rejected',
      threshold_decision: 'manually_reviewed',
      reviewed_at: value.terminalAt,
      reviewed_by: 'synthetic-reviewer',
    });
  }
  expect(() =>
    assertAutonomousPersonalRecordIntegrityV4(value.graph, work(), () => undefined),
  ).not.toThrow();
  expect(JSON.stringify(value.operation.terminalReceipt)).toBe(receiptBefore);
});
it('does not classify shared version2 attributes as new family4 or inspect work on that fast path', () => {
  const value = makeCompositionalAssistantHumanParentFixture('accepted_bundle');
  const trap = jest.fn(() => {
    throw new Error('must not inspect work');
  });
  const unsafeWork = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  expect(() =>
    assertAutonomousPersonalRecordIntegrityV4(
      value.graph,
      unsafeWork as AutonomousPersonalTypedSyntaxWorkV1,
      () => undefined,
    ),
  ).not.toThrow();
  expect(trap).not.toHaveBeenCalled();
});
it('does not observe hostile graph getters or leak their private error', () => {
  const trap = jest.fn(() => {
    throw new Error('synthetic private graph text');
  });
  const graph = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  let error: unknown;
  try {
    assertAutonomousPersonalRecordIntegrityV4(graph, work(), () => undefined);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain('synthetic private graph text');
  expect(trap).not.toHaveBeenCalled();
});
