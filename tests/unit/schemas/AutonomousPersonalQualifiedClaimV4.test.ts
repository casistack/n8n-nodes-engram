import {
  AutonomousPersonalQualifiedClaimRequestV4Schema,
  AutonomousPersonalQualifiedClaimEdgeIdV4Schema,
  AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema,
  AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema,
} from '../../../src/schemas/AutonomousPersonalQualifiedClaimV4.schema';
import {
  autonomousPersonalQualifiedClaimFixtureV4,
  type AutonomousPersonalQualifiedClaimFixtureV4,
} from '../../helpers/autonomousPersonalQualifiedClaimV4';

let fixture: AutonomousPersonalQualifiedClaimFixtureV4;
beforeAll(async () => {
  fixture = await autonomousPersonalQualifiedClaimFixtureV4();
});

function proof() {
  const claim = fixture.candidate.claim;
  return {
    storeHash: fixture.request.storeHash,
    namespace: fixture.request.namespace,
    subjectId: fixture.subject.uuid,
    claimId: fixture.edge.uuid,
    valueId: fixture.value.uuid,
    sourceId: fixture.source.uuid,
    operationId: fixture.operation.operationId,
    key: claim.key,
    kind: claim.kind,
    unitIndex: 0,
    unitId: claim.evidence.unitId,
    rawSpan: claim.evidence.rawSpan,
    mappedSpan: claim.evidence.mappedSpan,
    sourceHash: claim.sourceHash,
    descriptorHash: claim.descriptorHash,
    evidenceHash: claim.evidence.evidenceHash,
    meaningHash: fixture.candidate.reference.meaningHash,
    dependencies: fixture.candidate.reference.dependencies,
    createdAt: fixture.createdAt,
    sourceEventTime: new Date(Date.parse(fixture.source.reference_time)).toISOString(),
    reviewState: 'accepted' as const,
  };
}

it('constructs complete source/creator DATA while preserving distinct event and creation times', () => {
  expect(fixture.operation.state).toBe('committed');
  expect(fixture.operation.createdAt).toBe(fixture.source.created_at);
  expect(fixture.source.reference_time).not.toBe(fixture.createdAt);
  expect(AutonomousPersonalQualifiedClaimRequestV4Schema.parse(fixture.request)).toEqual(
    fixture.request,
  );
  expect(AutonomousPersonalQualifiedClaimEdgeIdV4Schema.parse(fixture.edge.uuid)).toBe(
    fixture.edge.uuid,
  );
  expect(AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema.parse(proof())).toEqual(proof());
  expect(
    AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema.safeParse({
      status: 'structural',
      proof: proof(),
    }).success,
  ).toBe(true);
});

it('rejects inconsistent proof references without adding a permission surface', () => {
  const value = proof();
  expect(
    AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema.safeParse({
      ...value,
      claimId: value.sourceId,
    }).success,
  ).toBe(false);
  expect(
    AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema.safeParse({
      ...value,
      dependencies: [{ index: 1, dependencyHash: 'a'.repeat(64) }],
    }).success,
  ).toBe(false);
  expect(
    AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema.safeParse({
      ...value,
      mappedSpan: { ...value.mappedSpan, end: value.mappedSpan.end + 1 },
    }).success,
  ).toBe(false);
  expect(
    AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema.safeParse({
      status: 'qualified',
      proof: value,
      should_process: true,
    }).success,
  ).toBe(false);
});

it('keeps only finite fixed diagnostic reasons', () => {
  expect(
    AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema.safeParse({
      status: 'invalid',
      reason: 'invalid_creator',
    }).success,
  ).toBe(true);
  expect(
    AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema.safeParse({
      status: 'inactive',
      reason: 'private provider text',
    }).success,
  ).toBe(false);
  expect(
    AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema.safeParse({
      status: 'capacity',
      reason: 'snapshot_capacity',
      records: [fixture.source],
    }).success,
  ).toBe(false);
});

it('owns request and edge identifiers without observing arbitrary getters or Proxy traps', () => {
  const getter = jest.fn(() => fixture.request.namespace);
  const value = Object.defineProperty({ ...fixture.request }, 'namespace', { get: getter });
  expect(() => AutonomousPersonalQualifiedClaimRequestV4Schema.parse(value)).toThrow(
    'invalid_autonomous_claim_request_data',
  );
  expect(getter).not.toHaveBeenCalled();
  const trap = jest.fn(() => {
    throw new Error('Do not call');
  });
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  expect(() => AutonomousPersonalQualifiedClaimEdgeIdV4Schema.parse(proxy)).toThrow(
    'invalid_autonomous_claim_request_data',
  );
  expect(trap).not.toHaveBeenCalled();
  expect(() =>
    AutonomousPersonalQualifiedClaimRequestV4Schema.parse({
      ...fixture.request,
      backendNow: '2026-10-27',
    }),
  ).toThrow('invalid_autonomous_claim_request_data');
});
