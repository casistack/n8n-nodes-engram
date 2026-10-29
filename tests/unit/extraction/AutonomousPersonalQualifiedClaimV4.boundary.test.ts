import { performance } from 'node:perf_hooks';
import {
  createAutonomousPersonalClaimIndexV4,
  inspectAutonomousPersonalClaimCreatorV4,
  qualifyAutonomousPersonalClaimCreatorV4,
} from '../../../src/extraction/AutonomousPersonalQualifiedClaimV4';
import {
  autonomousPersonalQualifiedClaimFixtureV4,
  type AutonomousPersonalQualifiedClaimFixtureV4,
} from '../../helpers/autonomousPersonalQualifiedClaimV4';

let baseline: AutonomousPersonalQualifiedClaimFixtureV4;
beforeAll(async () => {
  baseline = await autonomousPersonalQualifiedClaimFixtureV4();
});
function copy() {
  return structuredClone(baseline);
}
function index(fixture: AutonomousPersonalQualifiedClaimFixtureV4) {
  return createAutonomousPersonalClaimIndexV4(
    fixture.graph,
    {
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal: new AbortController().signal,
    },
    () => undefined,
  );
}
function inspect(fixture: AutonomousPersonalQualifiedClaimFixtureV4) {
  return inspectAutonomousPersonalClaimCreatorV4(index(fixture), fixture.edge.uuid);
}

it.each(['subject', 'value', 'edge'] as const)(
  'rejects a cross-namespace %s without modifying the snapshot',
  (row) => {
    const fixture = copy();
    fixture[row].group_id = 'synthetic:wrong-namespace';
    const before = JSON.stringify(fixture.graph);
    expect(inspect(fixture).status).toBe('invalid');
    expect(JSON.stringify(fixture.graph)).toBe(before);
  },
);
it.each(['source_node_uuid', 'target_node_uuid'] as const)('rejects a mismatched %s', (field) => {
  const fixture = copy();
  fixture.edge[field] = field === 'source_node_uuid' ? fixture.value.uuid : fixture.subject.uuid;
  expect(inspect(fixture).status).toBe('invalid');
});
it.each(['event', 'terminal'] as const)(
  'does not substitute %s time for creator row timestamps',
  (kind) => {
    const fixture = copy();
    const time = kind === 'event' ? fixture.source.reference_time : fixture.terminalAt;
    fixture.edge.created_at = time;
    fixture.value.created_at = time;
    for (const row of [fixture.edge, fixture.value]) {
      (row.attributes.engram_extraction as Record<string, unknown>).extracted_at = time;
    }
    expect(inspect(fixture)).toEqual({ status: 'invalid', reason: 'invalid_creator' });
  },
);
it.each([
  ['valid_at', -1, 'qualified'],
  ['valid_at', 0, 'qualified'],
  ['valid_at', 1, 'inactive'],
  ['invalid_at', -1, 'inactive'],
  ['invalid_at', 0, 'inactive'],
  ['invalid_at', 1, 'qualified'],
  ['expired_at', -1, 'inactive'],
  ['expired_at', 0, 'inactive'],
  ['expired_at', 1, 'inactive'],
] as const)(
  'checks %s at now%ims without poisoning structural history',
  (field, offset, status) => {
    const fixture = copy();
    fixture.edge[field] = new Date(Date.parse(fixture.backendNow) + offset).toISOString();
    const owned = index(fixture);
    expect(inspectAutonomousPersonalClaimCreatorV4(owned, fixture.edge.uuid).status).toBe(
      'structural',
    );
    expect(qualifyAutonomousPersonalClaimCreatorV4(owned, fixture.request).status).toBe(status);
  },
);
it('does not cache request-time qualification across backend clock boundaries', () => {
  const fixture = copy();
  fixture.edge.valid_at = new Date(Date.parse(fixture.backendNow) + 1).toISOString();
  const owned = index(fixture);
  expect(qualifyAutonomousPersonalClaimCreatorV4(owned, fixture.request).status).toBe('inactive');
  expect(
    qualifyAutonomousPersonalClaimCreatorV4(owned, {
      ...fixture.request,
      backendNow: fixture.edge.valid_at,
    }).status,
  ).toBe('qualified');
  expect(qualifyAutonomousPersonalClaimCreatorV4(owned, fixture.request).status).toBe('inactive');
});
it('rejects duplicate global identifiers before returning an index', () => {
  const fixture = copy();
  fixture.graph.episodes.push(structuredClone(fixture.source));
  expect(() => index(fixture)).toThrow('invalid_snapshot');
});
it('rejects distinct same-source operations through the existing ledger uniqueness invariant', () => {
  const fixture = copy();
  const duplicate = structuredClone(fixture.operation);
  duplicate.operationId = '90000000-0000-4000-8000-000000000001';
  duplicate.terminalReceipt.operationId = duplicate.operationId;
  fixture.graph.automatic_operations_v1!.operations.push(duplicate);
  expect(() => index(fixture)).toThrow('invalid_snapshot');
});
it('does not promote a later rejected review by reusing the accepted creator receipt', () => {
  const fixture = copy();
  for (const row of [fixture.edge, fixture.value]) {
    Object.assign(row.attributes.engram_extraction as Record<string, unknown>, {
      review_status: 'rejected',
      threshold_decision: 'manually_reviewed',
      reviewed_at: fixture.terminalAt,
      reviewed_by: 'synthetic-reviewer',
    });
  }
  const before = JSON.stringify(fixture.operation);
  expect(qualifyAutonomousPersonalClaimCreatorV4(index(fixture), fixture.request)).toMatchObject({
    status: 'qualified',
    proof: { reviewState: 'rejected' },
  });
  expect(JSON.stringify(fixture.operation)).toBe(before);
});
