import {
  AutomaticCaptureOperationV2Schema,
  type AutomaticCaptureOperationV2,
} from '../schemas/AutomaticCaptureOperation.schema';
import {
  AutomaticOperationAttemptSchema,
  AUTOMATIC_LEDGER_LIMITS,
  type AutomaticOperationAttempt,
} from '../schemas/AutomaticLedgerPrimitives.schema';

/** Keep the first bounded unique attempts. No post-cap cardinality is invented. */
export function withAutomaticCaptureAttemptV2(
  operation: AutomaticCaptureOperationV2,
  attempt: AutomaticOperationAttempt,
): AutomaticCaptureOperationV2 | null {
  if (
    operation.auditTruncated ||
    operation.attempts.some((item) => item.attemptHash === attempt.attemptHash)
  )
    return operation;
  const parsedAttempt = AutomaticOperationAttemptSchema.safeParse(attempt);
  if (!parsedAttempt.success) return null;
  const candidate =
    operation.attempts.length < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation
      ? {
          ...operation,
          lastObservedAt: attempt.at,
          attempts: [...operation.attempts, parsedAttempt.data],
        }
      : { ...operation, lastObservedAt: attempt.at, auditTruncated: true };
  const parsed = AutomaticCaptureOperationV2Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
