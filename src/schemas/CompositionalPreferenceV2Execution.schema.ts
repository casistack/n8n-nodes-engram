import { z } from 'zod';
import { CompositionalPreferenceV2Schema } from './CompositionalPreferenceV2.schema';

/**
 * Closed internal parser-path report. These labels describe which bounded
 * parser branch produced the unchanged public AST result; they carry no
 * semantic, ownership, acceptance, or persistence authority.
 */
export const CompositionalPreferenceV2ExecutionBranchSchema = z.enum([
  'complete_ast',
  'completed_none',
  'unsupported_meaning',
  'unsupported_descriptor',
  'invalid_input',
  'invalid_envelope',
  'source_integrity_failure',
  'malformed_quote',
  'quote_token_limit',
  'malformed_terminal',
  'malformed_framing',
  'resource_limit',
  'ast_integrity_failure',
]);
export type CompositionalPreferenceV2ExecutionBranch = z.infer<
  typeof CompositionalPreferenceV2ExecutionBranchSchema
>;

export const CompositionalPreferenceV2ExecutionReportSchema = z
  .object({
    result: CompositionalPreferenceV2Schema,
    branch: CompositionalPreferenceV2ExecutionBranchSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const completeAst =
      report.branch === 'complete_ast' &&
      report.result.coverage === 'complete' &&
      report.result.bundles.length > 0;
    const completedNone =
      report.branch === 'completed_none' &&
      report.result.coverage === 'none' &&
      report.result.bundles.length === 0;
    const closedFailure =
      report.branch !== 'complete_ast' &&
      report.branch !== 'completed_none' &&
      report.result.coverage === 'unknown' &&
      report.result.bundles.length === 0;
    if (!completeAst && !completedNone && !closedFailure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['branch'],
        message: 'Parser branch must agree with the bounded public result shape',
      });
    }
  });
export type CompositionalPreferenceV2ExecutionReport = z.infer<
  typeof CompositionalPreferenceV2ExecutionReportSchema
>;
