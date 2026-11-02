import { z } from 'zod';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { statementQualificationSchema } from './AutonomousPersonalClaimV3.schema';
import { AutonomousPersonalSourceCoverageV4OwnedDataSchema } from './AutonomousPersonalOperationV4.schema';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const index = z.number().int().safe().min(0).max(31);
const kind = z.enum(['typed_preference', 'source_statement_record']);
const reason = z.enum([
  'neutral_greeting',
  'question_terminal',
  'source_frame',
  'instruction',
  'sensitive',
  'provider_conflict',
  'provider_sensitive',
  'provider_downgrade',
  'typed_category_conflict',
  'statement_structure',
  'claim_capacity',
  'ambiguous_scope',
  'provider_unknown',
  'unsupported_scope',
  'retroactive_correction',
]);
export type AutonomousPersonalEvidenceSelectionReasonV1 = z.infer<typeof reason>;

const withheldReasons = new Set([
  'question_terminal',
  'source_frame',
  'instruction',
  'sensitive',
  'statement_structure',
  'claim_capacity',
  'retroactive_correction',
]);
const unresolvedReasons = new Set([
  'provider_conflict',
  'provider_sensitive',
  'provider_downgrade',
  'typed_category_conflict',
  'statement_structure',
  'ambiguous_scope',
  'provider_unknown',
  'unsupported_scope',
  'retroactive_correction',
]);
const unitSchema = z
  .object({
    unitIndex: index,
    unitId: hash,
    outcome: z.enum(['candidate', 'neutral', 'withheld', 'unresolved']),
    kind: kind.nullable(),
    reason: reason.nullable(),
  })
  .strict()
  .superRefine((unit, context) => {
    const valid =
      unit.outcome === 'candidate'
        ? unit.kind !== null && unit.reason === null
        : unit.kind === null &&
          unit.reason !== null &&
          (unit.outcome === 'neutral'
            ? unit.reason === 'neutral_greeting'
            : unit.outcome === 'withheld'
              ? withheldReasons.has(unit.reason)
              : unresolvedReasons.has(unit.reason));
    if (!valid)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid unit outcome pairing' });
  });
export type AutonomousPersonalEvidenceSelectionUnitV1 = z.infer<typeof unitSchema>;

const span = z
  .object({
    start: z.number().int().safe().min(0).max(65_536),
    end: z.number().int().safe().min(0).max(65_536),
  })
  .strict()
  .refine((value) => value.start < value.end);
const occurrenceSchema = z
  .object({
    candidateIndex: index,
    unitIndex: index,
    kind,
    category: z.enum([
      'preference',
      'work_role',
      'work_affiliation',
      'project',
      'skill',
      'interest',
      'broad_location',
      'self_description',
      'personal_assertion',
    ]),
    key: hash,
    evidenceHash: hash,
    meaningHash: hash,
    dependencies: z
      .array(z.object({ index, dependencyHash: hash }).strict())
      .min(1)
      .max(32),
    rawSpan: span,
    mappedSpan: span,
    // Absent for legacy occurrences; only a source statement may carry it.
    qualification: statementQualificationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.qualification !== undefined && value.kind !== 'source_statement_record') ||
      value.rawSpan.end - value.rawSpan.start !== value.mappedSpan.end - value.mappedSpan.start ||
      (value.kind === 'typed_preference' && value.category !== 'preference') ||
      (value.kind === 'source_statement_record' && value.dependencies.length !== 1) ||
      value.dependencies.some((dependency, position) => dependency.index !== position)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid occurrence references' });
  });
export type AutonomousPersonalEvidenceSelectionOccurrenceV1 = z.infer<typeof occurrenceSchema>;

const refs = {
  version: z.literal(1),
  sourceId: z.string().uuid(),
  sourceHash: hash,
  descriptorHash: hash,
  policyFingerprint: hash,
  geometryHash: hash,
  sourceScanHash: hash,
  framingHash: hash,
  typedSyntaxHash: hash,
  sourceCoverage: AutonomousPersonalSourceCoverageV4OwnedDataSchema,
};
const bodySchema = z.discriminatedUnion('status', [
  z
    .object({
      ...refs,
      status: z.literal('complete'),
      units: z.array(unitSchema).max(32),
      occurrences: z.array(occurrenceSchema).max(32),
    })
    .strict(),
  z
    .object({
      ...refs,
      status: z.literal('not_interpreted'),
      reason: z.literal('source_indeterminate'),
      units: z.array(unitSchema).max(0),
      occurrences: z.array(occurrenceSchema).max(0),
    })
    .strict(),
  z
    .object({
      ...refs,
      status: z.literal('capacity'),
      reason: z.enum(['source_resource', 'unit_count', 'typed_metadata', 'aggregate']),
      units: z.array(unitSchema).max(0),
      occurrences: z.array(occurrenceSchema).max(0),
    })
    .strict(),
]);

function coverageReason(unit: AutonomousPersonalEvidenceSelectionUnitV1): string {
  if (unit.reason?.startsWith('provider_') || unit.reason === 'typed_category_conflict')
    return 'provider_unknown';
  return unit.reason === 'statement_structure' ? 'unsupported_scope' : unit.reason!;
}

/** Already-owned report DATA only. It cannot prove storage origin or authorize a write. */
export const AutonomousPersonalEvidenceSelectionV1OwnedDataSchema = bodySchema.superRefine(
  (report, context) => {
    const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > 512 * 1024)
      invalid('Selection report exceeds the 512 KiB limit');
    const coverage = report.sourceCoverage;
    if (report.status !== 'complete') {
      if (report.status === 'not_interpreted') {
        if (coverage.status !== 'unknown' || coverage.scanStatus !== 'indeterminate_suffix')
          invalid('Invalid indeterminate coverage');
      } else if (report.reason === 'source_resource') {
        if (coverage.status !== 'not_reported' || coverage.scanStatus !== 'resource_limit')
          invalid('Invalid resource coverage');
      } else if (
        coverage.status !== 'unknown' ||
        coverage.scanStatus !== 'complete' ||
        coverage.unresolvedReason !== 'interpretation_capacity' ||
        coverage.sourceUnitCount === null ||
        (report.reason === 'unit_count'
          ? coverage.sourceUnitCount <= 32
          : coverage.sourceUnitCount > 32)
      ) {
        invalid('Invalid complete-scan capacity coverage');
      }
      return;
    }
    const units = report.units;
    if (
      coverage.scanStatus !== 'complete' ||
      coverage.sourceUnitCount !== units.length ||
      new Set(units.map((unit) => unit.unitId)).size !== units.length ||
      units.some((unit, position) => unit.unitIndex !== position)
    )
      invalid('Invalid ordered unit table');
    const count = (outcome: AutonomousPersonalEvidenceSelectionUnitV1['outcome']) =>
      units.filter((unit) => unit.outcome === outcome).length;
    const unresolved = units.filter((unit) => unit.outcome === 'unresolved');
    const reasons = new Set(unresolved.map(coverageReason));
    const expectedReason =
      reasons.size === 0 ? null : reasons.size === 1 ? [...reasons][0] : 'multiple';
    const expectedStatus =
      unresolved.length === 0
        ? 'complete'
        : unresolved.length === units.length
          ? 'unknown'
          : 'partial';
    if (
      coverage.candidateUnitCount !== count('candidate') ||
      coverage.neutralUnitCount !== count('neutral') ||
      coverage.withheldUnitCount !== count('withheld') ||
      coverage.unresolvedUnitCount !== unresolved.length ||
      coverage.unresolvedReason !== expectedReason ||
      coverage.status !== expectedStatus
    )
      invalid('Coverage does not match unit outcomes');
    let previousUnit = -1;
    let dependencies = 0;
    const occurrenceCounts = new Map<number, number>();
    for (const [position, occurrence] of report.occurrences.entries()) {
      const unit = units[occurrence.unitIndex];
      if (
        occurrence.candidateIndex !== position ||
        occurrence.unitIndex < previousUnit ||
        !unit ||
        unit.outcome !== 'candidate' ||
        unit.kind !== occurrence.kind
      )
        invalid('Occurrence does not match candidate unit');
      previousUnit = occurrence.unitIndex;
      dependencies += occurrence.dependencies.length;
      occurrenceCounts.set(
        occurrence.unitIndex,
        (occurrenceCounts.get(occurrence.unitIndex) ?? 0) + 1,
      );
    }
    if (dependencies > 32) invalid('Dependency capacity exceeded');
    for (const unit of units) {
      const total = occurrenceCounts.get(unit.unitIndex) ?? 0;
      if (
        (unit.outcome === 'candidate' && total === 0) ||
        (unit.kind === 'source_statement_record' && total !== 1)
      )
        invalid('Incomplete candidate occurrences');
    }
  },
);
export type AutonomousPersonalEvidenceSelectionV1 = z.infer<
  typeof AutonomousPersonalEvidenceSelectionV1OwnedDataSchema
>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function invalidData(): z.ZodError {
  const error = new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'invalid_autonomous_evidence_selection_data',
    },
  ]);
  freeze(error.issues);
  return Object.freeze(error) as z.ZodError;
}
function parse(value: unknown): AutonomousPersonalEvidenceSelectionV1 {
  try {
    return freeze(
      AutonomousPersonalEvidenceSelectionV1OwnedDataSchema.parse(
        cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest'),
      ),
    );
  } catch {
    throw invalidData();
  }
}
export const AutonomousPersonalEvidenceSelectionV1Schema = Object.freeze({
  parse,
  safeParse(value: unknown) {
    try {
      return { success: true as const, data: parse(value) };
    } catch {
      return { success: false as const, error: invalidData() };
    }
  },
});
