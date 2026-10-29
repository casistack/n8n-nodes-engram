import { types as utilTypes } from 'util';
import { z } from 'zod';
import { CompositionalPreferenceV2ExecutionReportSchema } from './CompositionalPreferenceV2Execution.schema';
import { CompositionalPreferenceV2ExecutionBranchSchema } from './CompositionalPreferenceV2Execution.schema';
import { CompositionalAutomaticCaptureInterpretationEvidenceV3Schema } from './CompositionalAutomaticCaptureInterpretationEvidenceV3.schema';

const reportBody = z
  .object({
    evidence: CompositionalAutomaticCaptureInterpretationEvidenceV3Schema,
    branch: CompositionalPreferenceV2ExecutionBranchSchema,
  })
  .strict();

const reportKeys = ['evidence', 'branch'] as const;

function preflightReport(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== reportKeys.length || keys.some((key) => typeof key !== 'string'))
      return undefined;
    const snapshot: Record<string, unknown> = {};
    for (const key of reportKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Non-authoritative source interpretation evidence paired with parser path. */
export const CompositionalAutomaticCaptureEvidenceReportV3Schema = z
  .preprocess(preflightReport, reportBody)
  .superRefine((report, context) => {
    const execution = CompositionalPreferenceV2ExecutionReportSchema.safeParse({
      result: report.evidence.result,
      branch: report.branch,
    });
    if (!execution.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['branch'],
        message: 'Parser branch must match the bounded interpretation result',
      });
    }
  });
export type CompositionalAutomaticCaptureEvidenceReportV3 = z.infer<
  typeof CompositionalAutomaticCaptureEvidenceReportV3Schema
>;
