import { AUTOMATIC_LEDGER_LIMITS } from '../schemas/AutomaticLedgerPrimitives.schema';
import {
  AutonomousPersonalTerminalOperationAuditV4OwnedDataSchema,
  AutonomousPersonalTerminalOperationV4InputOwnedDataSchema,
  type AutonomousPersonalTerminalOperationV4,
  type AutonomousPersonalTerminalOperationV4FailureReason,
} from '../schemas/AutonomousPersonalTerminalOperationV4.schema';
import { AutonomousPersonalOperationV4OwnedDataSchema } from '../schemas/AutonomousPersonalOperationV4.schema';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from './BoundedAutomaticCaptureJson';

export class AutonomousPersonalTerminalOperationFailureV4 extends Error {
  constructor(readonly reason: AutonomousPersonalTerminalOperationV4FailureReason) {
    super(`Engram autonomous personal capture: terminal_operation_${reason}`);
    this.name = 'AutonomousPersonalTerminalOperationFailureV4';
    Object.freeze(this);
  }
}

function fail(reason: AutonomousPersonalTerminalOperationV4FailureReason): never {
  throw new AutonomousPersonalTerminalOperationFailureV4(reason);
}

function createStickyCheck(callback: () => void): () => void {
  if (typeof callback !== 'function') fail('invalid_input');
  let failed = false;
  let failure: unknown;
  return () => {
    if (failed) throw failure;
    try {
      callback();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
}

function deepFreeze<T>(value: T, check: () => void): T {
  check();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child, check);
    }
    Object.freeze(value);
  }
  return value;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && 'value' in property ? property.value : undefined;
}

function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : null;
  } catch {
    return null;
  }
}

function hasDuplicateCompletionAudit(input: unknown, check: () => void): boolean {
  const audit = AutonomousPersonalTerminalOperationAuditV4OwnedDataSchema.safeParse(
    ownDataProperty(input, 'audit'),
  );
  if (!audit.success) return false;
  const leasedOperation = ownDataProperty(input, 'leasedOperation');
  const attempts = ownDataProperty(leasedOperation, 'attempts');
  if (!Array.isArray(attempts)) return false;
  let matches = 0;
  for (const attempt of attempts) {
    check();
    if (ownDataProperty(attempt, 'attemptHash') === audit.data.attemptIdHash) {
      matches += 1;
      if (matches > 1) return true;
    }
  }
  return false;
}

/**
 * Build bounded committed Operation4 DATA from an already-owned leased record.
 * The caller retains all backend, lease-owner, receipt-origin, and commit authority.
 */
export function buildCommittedAutonomousPersonalOperationV4(
  inputValue: unknown,
  codeOwnedCheck: () => void,
): AutonomousPersonalTerminalOperationV4 {
  const check = createStickyCheck(codeOwnedCheck);
  check();

  let snapshot: unknown;
  try {
    snapshot = cloneBoundedAutomaticCaptureJson<unknown>(inputValue, 'beginRequest');
  } catch (error) {
    check();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      fail('capacity');
    }
    fail('invalid_input');
  }
  check();

  const leasedOperationValue = ownDataProperty(snapshot, 'leasedOperation');
  const terminalReceiptValue = ownDataProperty(snapshot, 'terminalReceipt');
  const leasedOperationBytes = jsonByteLength(leasedOperationValue);
  const terminalReceiptBytes = jsonByteLength(terminalReceiptValue);
  if (leasedOperationBytes === null || terminalReceiptBytes === null) {
    fail('invalid_input');
  }
  if (
    leasedOperationBytes > AUTOMATIC_LEDGER_LIMITS.operationBytes ||
    terminalReceiptBytes > AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes
  ) {
    fail('capacity');
  }

  if (hasDuplicateCompletionAudit(snapshot, check)) fail('invalid_audit');
  check();
  const parsedInput = AutonomousPersonalTerminalOperationV4InputOwnedDataSchema.safeParse(snapshot);
  check();
  if (!parsedInput.success) fail('invalid_input');

  const { leasedOperation, terminalReceipt, completionCallHash, audit } = parsedInput.data;
  if (leasedOperation.state !== 'leased') fail('invalid_input');
  const operation = leasedOperation;

  if (
    operation.generation !== 1 ||
    operation.lease.claimKind !== 'initial' ||
    operation.lastResumeCause !== undefined
  ) {
    fail('unsupported_generation');
  }

  const supportedReceipt =
    terminalReceipt.kind === 'human_autonomous_capture_committed' ||
    terminalReceipt.kind === 'human_autonomous_source_deferred_committed' ||
    terminalReceipt.kind === 'human_autonomous_source_verdict_committed';
  if (
    operation.identity.purpose !== 'human_turn_memory' ||
    !supportedReceipt ||
    terminalReceipt.operationId !== operation.operationId ||
    terminalReceipt.sourceId !== operation.identity.sourceId ||
    terminalReceipt.sourceHash !== operation.identity.sourceHash ||
    terminalReceipt.descriptorHash !== operation.identity.descriptorHash ||
    terminalReceipt.policyFingerprint !== operation.descriptor.policy.fingerprint
  ) {
    fail('invalid_receipt');
  }

  if (
    audit.action !== 'completion' ||
    audit.operationId !== operation.operationId ||
    audit.sourceId !== operation.identity.sourceId
  ) {
    fail('invalid_audit');
  }

  const claimWon: typeof operation.attempts = [];
  for (const attempt of operation.attempts) {
    check();
    if (attempt.disposition === 'claim_won') claimWon.push(attempt);
  }
  if (
    claimWon.length !== 1 ||
    operation.attempts[0]?.disposition !== 'claim_won' ||
    operation.attempts[0]?.at !== operation.createdAt ||
    operation.lease.renewedAt !== operation.createdAt
  ) {
    fail('invalid_audit');
  }

  const terminalAt = Date.parse(terminalReceipt.terminalAt);
  if (terminalAt < Date.parse(operation.lastObservedAt)) fail('clock_regression');
  if (terminalAt >= Date.parse(operation.lease.expiresAt)) fail('lease_expired');

  const attempts = [...operation.attempts];
  let auditTruncated = operation.auditTruncated;
  const matching: typeof operation.attempts = [];
  for (const attempt of attempts) {
    check();
    if (attempt.attemptHash === audit.attemptIdHash) matching.push(attempt);
  }
  if (matching.length > 1) fail('invalid_audit');
  if (matching.length === 0) {
    if (attempts.length < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation) {
      attempts.push({
        attemptHash: audit.attemptIdHash,
        at: terminalReceipt.terminalAt,
        disposition: 'committed',
      });
    } else {
      auditTruncated = true;
    }
  }

  check();
  const { lease: _lease, ...common } = operation;
  void _lease;
  const committedCandidate = {
    ...common,
    state: 'committed' as const,
    lastObservedAt: terminalReceipt.terminalAt,
    attempts,
    overflowCount: operation.overflowCount,
    ...(auditTruncated === undefined ? {} : { auditTruncated }),
    completionCallHash,
    terminalReceipt,
  };

  const receiptBytes = jsonByteLength(committedCandidate.terminalReceipt);
  const operationBytes = jsonByteLength(committedCandidate);
  if (receiptBytes === null || operationBytes === null) fail('invalid_input');
  if (
    receiptBytes > AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes ||
    operationBytes > AUTOMATIC_LEDGER_LIMITS.operationBytes
  ) {
    fail('capacity');
  }

  check();
  const committed = AutonomousPersonalOperationV4OwnedDataSchema.safeParse(committedCandidate);
  check();
  if (!committed.success || committed.data.state !== 'committed') fail('invalid_input');
  const frozen = deepFreeze(committed.data, check);
  check();
  return frozen;
}
