import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from '../schemas/AutomaticLedgerPrimitives.schema';
import {
  CompositionalCaptureTerminalOperationInputV3Schema,
  type CompositionalCaptureTerminalOperationFailureReasonV3,
  type CompositionalCaptureTerminalOperationV3,
} from '../schemas/CompositionalCaptureTerminalOperationV3.schema';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';

export class CompositionalCaptureTerminalOperationFailureV3 extends Error {
  constructor(readonly reason: CompositionalCaptureTerminalOperationFailureReasonV3) {
    super(`Engram compositional capture: terminal_operation_${reason}`);
    this.name = 'CompositionalCaptureTerminalOperationFailureV3';
  }
}

function fail(reason: CompositionalCaptureTerminalOperationFailureReasonV3): never {
  throw new CompositionalCaptureTerminalOperationFailureV3(reason);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the bounded V3 committed operation candidate from an actual leased record.
 * This pure transform does not authenticate the lease, receipt, or audit; its caller
 * must supply those from the active private completion path and atomically persist
 * the returned record with the corresponding graph candidate.
 */
export function buildCommittedCompositionalCaptureOperationV3(
  inputValue: unknown,
  check: () => void = () => {},
): CompositionalCaptureTerminalOperationV3 {
  check();
  let snapshot: unknown;
  try {
    snapshot = cloneBoundedAutomaticCaptureJson(inputValue, 'beginRequest');
  } catch {
    check();
    return fail('invalid_input');
  }
  check();
  const parsed = CompositionalCaptureTerminalOperationInputV3Schema.safeParse(snapshot);
  check();
  if (!parsed.success || parsed.data.leasedOperation.state !== 'leased')
    return fail('invalid_input');

  const { leasedOperation, terminalReceipt, completionCallHash, audit } = parsed.data;
  const operation = leasedOperation;
  const receiptIsSupported =
    terminalReceipt.kind === 'human_compositional_capture_committed' ||
    terminalReceipt.kind === 'human_compositional_source_verdict_committed';
  if (
    operation.identity.purpose !== 'human_turn_memory' ||
    !receiptIsSupported ||
    terminalReceipt.operationId !== operation.operationId ||
    terminalReceipt.sourceId !== operation.identity.sourceId ||
    terminalReceipt.sourceHash !== operation.identity.sourceHash ||
    terminalReceipt.descriptorHash !== operation.identity.descriptorHash ||
    terminalReceipt.policyFingerprint !== operation.descriptor.policy.fingerprint
  )
    return fail('invalid_receipt');

  if (
    audit.action !== 'completion' ||
    audit.operationId !== operation.operationId ||
    audit.sourceId !== operation.identity.sourceId
  )
    return fail('invalid_audit');

  const claimWon = operation.attempts.filter((attempt) => {
    check();
    return attempt.disposition === 'claim_won';
  });
  if (
    claimWon.length !== 1 ||
    operation.attempts[0]?.disposition !== 'claim_won' ||
    Date.parse(operation.attempts[0].at) !== Date.parse(operation.createdAt)
  )
    return fail('invalid_audit');

  const terminalAt = Date.parse(terminalReceipt.terminalAt);
  if (terminalAt < Date.parse(operation.lastObservedAt)) return fail('clock_regression');
  if (terminalAt >= Date.parse(operation.lease.expiresAt)) return fail('lease_expired');

  const attempts = [...operation.attempts];
  let auditTruncated = operation.auditTruncated;
  const matching = attempts.filter((attempt) => {
    check();
    return attempt.attemptHash === audit.attemptIdHash;
  });
  if (matching.length > 1) return fail('invalid_audit');
  if (matching.length === 0) {
    if (attempts.length < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation) {
      attempts.push(
        AutomaticOperationAttemptSchema.parse({
          attemptHash: audit.attemptIdHash,
          at: terminalReceipt.terminalAt,
          disposition: 'committed',
        }),
      );
    } else {
      auditTruncated = true;
    }
  }

  check();
  const common: Record<string, unknown> = { ...operation };
  delete common.lease;
  const committed = CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...common,
    state: 'committed',
    lastObservedAt: terminalReceipt.terminalAt,
    attempts,
    overflowCount: operation.overflowCount,
    ...(auditTruncated === undefined ? {} : { auditTruncated }),
    completionCallHash,
    terminalReceipt,
  });
  check();
  if (committed.state !== 'committed') return fail('invalid_input');
  const frozen = deepFreeze(committed);
  check();
  return frozen;
}
