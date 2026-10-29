import { readFileSync } from 'fs';
import { join } from 'path';
import { buildAutonomousPersonalClaimCandidateV1 } from '../../../src/extraction/AutonomousPersonalClaimCandidateV1';
import { AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema } from '../../../src/schemas/AutonomousPersonalClaimCandidateV1.schema';
import { AutonomousPersonalEvidenceSelectionV1OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalEvidenceSelectionV1.schema';
import { reconstructAutonomousPersonalStoredSourceIdentityV4 } from '../../../src/schemas/AutonomousPersonalSourceV4.schema';

function candidate() {
  const fixtures = JSON.parse(
    readFileSync(
      join(__dirname, '../../fixtures/compatibility/autonomous-evidence-selection-v1.json'),
      'utf8',
    ),
  ) as Array<{ label: string; input: unknown; expected: unknown }>;
  const fixture = fixtures.find((item) => item.label === 'open-work')!;
  const stored = reconstructAutonomousPersonalStoredSourceIdentityV4(fixture.input);
  const selection = AutonomousPersonalEvidenceSelectionV1OwnedDataSchema.parse(fixture.expected);
  const occurrence = selection.occurrences[0]!;
  const owner = stored.tuple.owner;
  const result = buildAutonomousPersonalClaimCandidateV1({
    sourceId: owner.sourceId,
    contentHash: owner.contentHash,
    descriptorHash: owner.descriptorHash,
    namespace: owner.namespace,
    subjectId: owner.binding.subjectId,
    sourceHash: stored.tuple.identity.sourceHash,
    policy: stored.descriptor.policy,
    sourceEventTime: new Date(Date.parse(stored.source.reference_time)).toISOString(),
    unitId: selection.units[occurrence.unitIndex]!.unitId,
    unitIndex: occurrence.unitIndex,
    kind: 'source_statement_record',
    category: 'work_role',
    literal: stored.source.content.slice(occurrence.rawSpan.start, occurrence.rawSpan.end),
    rawSpan: occurrence.rawSpan,
    mappedSpan: occurrence.mappedSpan,
    bundle: null,
  });
  if (result.kind !== 'candidate') throw new Error('Expected complete synthetic candidate');
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

const reference = (value: Record<string, unknown>) => value.reference as Record<string, unknown>;

const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
  [
    'meaning hash',
    (value: Record<string, unknown>) => (reference(value).meaningHash = 'f'.repeat(64)),
  ],
  ['logical key', (value: Record<string, unknown>) => (reference(value).key = 'f'.repeat(64))],
  [
    'evidence hash',
    (value: Record<string, unknown>) => (reference(value).evidenceHash = 'f'.repeat(64)),
  ],
  ['dependency count', (value: Record<string, unknown>) => (value.dependencyCount = 2)],
  [
    'dependency identity',
    (value: Record<string, unknown>) => {
      const dependencies = reference(value).dependencies as Array<Record<string, unknown>>;
      dependencies[0]!.dependencyHash = 'f'.repeat(64);
    },
  ],
  ['selector index', (value: Record<string, unknown>) => (reference(value).candidateIndex = 0)],
  ['permission flag', (value: Record<string, unknown>) => (value.eligibleFirstCommit = true)],
];

it.each(cases)('rejects inconsistent or extraneous result DATA: %s', (_label, mutate) => {
  const value = candidate();
  expect(AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema.safeParse(value).success).toBe(
    true,
  );
  mutate(value);
  expect(AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema.safeParse(value).success).toBe(
    false,
  );
});
