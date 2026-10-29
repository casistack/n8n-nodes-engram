import { z } from 'zod';
import { CompositionalPreferenceV2ExecutionBranchSchema } from './CompositionalPreferenceV2Execution.schema';
import {
  CompositionalPreferenceV2ReasonSchema,
  CompositionalPreferenceV2Schema,
} from './CompositionalPreferenceV2.schema';

const HASH_64 = /^[a-f0-9]{64}$/u;
const hash = z.string().regex(HASH_64);
const unitIndex = z.number().int().min(0).max(31);

const typedSyntaxWorkShapeSchema = z
  .object({
    absoluteMonotonicDeadlineMs: z.number(),
    signal: z.custom<AbortSignal>(),
  })
  .strict();

const refsSchema = {
  version: z.literal(1),
  rawContentHash: hash,
  mappedContentHash: hash,
  geometryHash: hash,
  sourceScanHash: hash,
  framingHash: hash,
  syntaxScopeHash: hash,
};

const unitRowSchema = z.discriminatedUnion('kind', [
  z
    .object({
      unitIndex,
      kind: z.literal('typed'),
      preference: CompositionalPreferenceV2Schema,
    })
    .strict(),
  z
    .object({
      unitIndex,
      kind: z.literal('nonmatch'),
      parserBranch: CompositionalPreferenceV2ExecutionBranchSchema,
      reasons: z.array(CompositionalPreferenceV2ReasonSchema).max(16),
    })
    .strict(),
  z
    .object({
      unitIndex,
      kind: z.literal('source_blocked'),
      finding: z.enum([
        'quote',
        'framing',
        'question',
        'instruction',
        'sensitive',
        'remember_scope',
      ]),
    })
    .strict(),
]);

const outputBodySchema = z.discriminatedUnion('status', [
  z
    .object({
      ...refsSchema,
      status: z.literal('complete'),
      units: z.array(unitRowSchema).max(32),
    })
    .strict(),
  z
    .object({
      ...refsSchema,
      status: z.literal('not_interpreted'),
      reason: z.literal('source_indeterminate'),
      units: z.array(unitRowSchema).max(0),
    })
    .strict(),
  z
    .object({
      ...refsSchema,
      status: z.literal('capacity'),
      reason: z.enum(['source_resource', 'unit_count', 'typed_metadata', 'aggregate']),
      units: z.array(unitRowSchema).max(0),
    })
    .strict(),
]);

export const AutonomousPersonalTypedSyntaxV1OwnedDataSchema = outputBodySchema.superRefine(
  (report, context) => {
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > 512 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Typed syntax report exceeds the 512 KiB limit',
      });
    }
    if (report.status !== 'complete') return;
    report.units.forEach((row, index) => {
      if (row.unitIndex !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units', index, 'unitIndex'],
          message: 'Unit rows must be contiguous and ordered',
        });
      }
      if (
        row.kind === 'typed' &&
        (row.preference.coverage !== 'complete' ||
          row.preference.reasons.length !== 0 ||
          row.preference.bundles.length === 0 ||
          row.preference.withheld.length !== 0 ||
          row.preference.bundles.some((bundle) => bundle.coverage !== 'complete'))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units', index, 'preference'],
          message: 'Typed rows require complete unwithheld ALL2 coverage',
        });
      }
      if (
        row.kind === 'nonmatch' &&
        row.parserBranch === 'complete_ast' &&
        row.reasons.length === 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['units', index, 'parserBranch'],
          message: 'A complete positive ALL2 report cannot be labeled nonmatch',
        });
      }
    });
  },
);

export type AutonomousPersonalTypedSyntaxV1 = z.infer<
  typeof AutonomousPersonalTypedSyntaxV1OwnedDataSchema
>;

export type AutonomousPersonalTypedSyntaxWorkV1 = Readonly<
  z.infer<typeof typedSyntaxWorkShapeSchema>
>;
