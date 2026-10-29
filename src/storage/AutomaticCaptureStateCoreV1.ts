import { z, ZodError } from 'zod';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from '../schemas/AutomaticLedgerPrimitives.schema';
import {
  AutomaticCaptureAttemptUpdateV1OwnedDataSchema,
  AutomaticCaptureAttemptWrapperV1OwnedDataSchema,
  AutomaticCaptureInitialLeaseFieldsV1InputOwnedDataSchema,
  AutomaticCaptureInitialLeaseFieldsV1OwnedDataSchema,
  AutomaticOperationAttemptV3StateCoreV1OwnedDataSchema,
  AutomaticOperationAttemptV4StateCoreV1OwnedDataSchema,
  type AutomaticCaptureAttemptUpdateV1,
  type AutomaticCaptureInitialLeaseFieldsV1Input,
} from '../schemas/AutomaticCaptureStateCoreV1.schema';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
} from '../schemas/AutonomousPersonalOperationV4.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import { projectAutonomousPersonalTerminalReserveV4 } from './AutonomousPersonalTerminalReserveV4';

type OperationV3 = z.infer<typeof CompositionalAutomaticCaptureOperationV3Schema>;
type AttemptV3 = z.infer<typeof AutomaticOperationAttemptSchema>;
type AttemptV4 = z.infer<typeof AutomaticOperationAttemptV4StateCoreV1OwnedDataSchema>;

function fixedError(code: string): ZodError {
  const path = Object.freeze([]) as unknown as Array<string | number>;
  const issue = Object.freeze({
    code: z.ZodIssueCode.custom,
    path,
    message: code,
  }) as z.ZodIssue;
  const error = new ZodError([issue]);
  Object.freeze(error.issues);
  return Object.freeze(error);
}

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}

function invalidLeaseData(): ZodError {
  return fixedError('invalid_automatic_capture_initial_lease_data');
}

function invalidAttemptData(): ZodError {
  return fixedError('invalid_autonomous_capture_attempt_data');
}

/**
 * Compile the common generation-one lease fields from bounded DATA supplied by
 * the fixed family adapter. This does not establish the provenance of any
 * identifier, timestamp, or hash-shaped value.
 */
export function compileAutomaticCaptureInitialLeaseFieldsV1(
  input: unknown,
): z.infer<typeof AutomaticCaptureInitialLeaseFieldsV1OwnedDataSchema> {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'policyData');
    const data: AutomaticCaptureInitialLeaseFieldsV1Input =
      AutomaticCaptureInitialLeaseFieldsV1InputOwnedDataSchema.parse(owned);
    const leaseDurationMs = Math.min(
      AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
      Math.max(
        AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
        data.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      ),
    );
    const expiresAt = new Date(Date.parse(data.createdAt) + leaseDurationMs).toISOString();
    return freezeData(
      AutomaticCaptureInitialLeaseFieldsV1OwnedDataSchema.parse({
        createdAt: data.createdAt,
        lastObservedAt: data.createdAt,
        attempts: [
          {
            attemptHash: data.initialAttemptHash,
            at: data.createdAt,
            disposition: 'claim_won',
          },
        ],
        overflowCount: 0,
        auditTruncated: false,
        beginCallHash: data.beginCallHash,
        retryCount: 0,
        state: 'leased',
        generation: 1,
        lease: {
          token: data.leaseToken,
          acquiredAt: data.createdAt,
          renewedAt: data.createdAt,
          expiresAt,
          claimKind: 'initial',
        },
      }),
    );
  } catch {
    throw invalidLeaseData();
  }
}

function result(value: AutomaticCaptureAttemptUpdateV1): AutomaticCaptureAttemptUpdateV1 {
  return freezeData(AutomaticCaptureAttemptUpdateV1OwnedDataSchema.parse(value));
}

function notUpdated(familyVersion: 3 | 4): AutomaticCaptureAttemptUpdateV1 {
  return result({ kind: 'not_updated', familyVersion });
}

function same(familyVersion: 3 | 4): AutomaticCaptureAttemptUpdateV1 {
  return result({ kind: 'same', familyVersion });
}

function updatedV3(operation: OperationV3): AutomaticCaptureAttemptUpdateV1 {
  return result({ kind: 'updated', familyVersion: 3, operation });
}

function updatedV4(operation: AutonomousPersonalOperationV4): AutomaticCaptureAttemptUpdateV1 {
  return result({ kind: 'updated', familyVersion: 4, operation });
}

function isTerminalObservationAllowed(
  terminalAt: string,
  observation: { at: string; disposition: string },
  terminalDisposition: 'committed_replay' | 'cancelled_replay',
): boolean {
  return (
    Date.parse(observation.at) >= Date.parse(terminalAt) &&
    observation.disposition === terminalDisposition
  );
}

function updateV3(operation: OperationV3, observation: AttemptV3): AutomaticCaptureAttemptUpdateV1 {
  if (Date.parse(observation.at) < Date.parse(operation.lastObservedAt)) return notUpdated(3);

  if (operation.state === 'committed') {
    if (
      !isTerminalObservationAllowed(
        operation.terminalReceipt.terminalAt,
        observation,
        'committed_replay',
      )
    )
      return notUpdated(3);
  } else if (operation.state === 'cancelled') {
    if (
      !isTerminalObservationAllowed(
        operation.terminalReceipt.terminalAt,
        observation,
        'cancelled_replay',
      )
    )
      return notUpdated(3);
  } else if (
    observation.disposition !== 'in_progress' &&
    observation.disposition !== 'resume_available'
  ) {
    return notUpdated(3);
  }

  if (
    operation.attempts.some((attempt) => attempt.attemptHash === observation.attemptHash) ||
    operation.auditTruncated === true
  ) {
    return same(3);
  }

  const candidate =
    operation.attempts.length < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation
      ? {
          ...operation,
          lastObservedAt: observation.at,
          attempts: [...operation.attempts, observation],
        }
      : { ...operation, lastObservedAt: observation.at, auditTruncated: true };
  const parsed = CompositionalAutomaticCaptureOperationV3Schema.safeParse(candidate);
  return parsed.success ? updatedV3(parsed.data) : notUpdated(3);
}

function operationHasFutureReceiptReserve(operation: AutonomousPersonalOperationV4): boolean {
  try {
    return projectAutonomousPersonalTerminalReserveV4(operation).withinLimit;
  } catch {
    return false;
  }
}

function parseV4Candidate(value: unknown): AutonomousPersonalOperationV4 | null {
  const parsed = AutonomousPersonalOperationV4OwnedDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function updateV4(
  operation: AutonomousPersonalOperationV4,
  observation: AttemptV4,
): AutomaticCaptureAttemptUpdateV1 {
  if (Date.parse(observation.at) < Date.parse(operation.lastObservedAt)) return notUpdated(4);

  if (operation.state === 'committed') {
    if (
      !isTerminalObservationAllowed(
        operation.terminalReceipt.terminalAt,
        observation,
        'committed_replay',
      )
    )
      return notUpdated(4);
  } else if (operation.state === 'cancelled') {
    if (
      !isTerminalObservationAllowed(
        operation.terminalReceipt.terminalAt,
        observation,
        'cancelled_replay',
      )
    )
      return notUpdated(4);
  } else if (
    observation.disposition !== 'in_progress' &&
    observation.disposition !== 'resume_available'
  ) {
    return notUpdated(4);
  }

  if (
    operation.attempts.some((attempt) => attempt.attemptHash === observation.attemptHash) ||
    operation.auditTruncated === true
  ) {
    return same(4);
  }

  const terminal = operation.state === 'committed' || operation.state === 'cancelled';
  if (!terminal && !operationHasFutureReceiptReserve(operation)) return notUpdated(4);

  const candidate =
    operation.attempts.length < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation
      ? {
          ...operation,
          lastObservedAt: observation.at,
          attempts: [...operation.attempts, observation],
        }
      : null;
  const parsedCandidate = candidate === null ? null : parseV4Candidate(candidate);
  if (parsedCandidate !== null) {
    if (terminal) return updatedV4(parsedCandidate);
    if (operationHasFutureReceiptReserve(parsedCandidate)) return updatedV4(parsedCandidate);
  }

  const truncationCandidate = parseV4Candidate({
    ...operation,
    lastObservedAt: observation.at,
    auditTruncated: true,
  });
  if (truncationCandidate === null) return notUpdated(4);
  if (!terminal && !operationHasFutureReceiptReserve(truncationCandidate)) return notUpdated(4);
  return updatedV4(truncationCandidate);
}

function hasOwnDataKey(value: unknown, key: string): boolean {
  return (
    value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)
  );
}

/**
 * Apply one already-derived attempt observation to one complete Operation3 or
 * Operation4. This bounded DATA helper does not authenticate either input.
 */
export function applyAutomaticCaptureAttemptV1(input: unknown): AutomaticCaptureAttemptUpdateV1 {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    if (
      !hasOwnDataKey(owned, 'familyVersion') ||
      !hasOwnDataKey(owned, 'operation') ||
      !hasOwnDataKey(owned, 'observation')
    ) {
      throw invalidAttemptData();
    }
    const wrapper = AutomaticCaptureAttemptWrapperV1OwnedDataSchema.parse(owned);
    const serializedOperation = JSON.stringify(wrapper.operation);
    if (
      typeof serializedOperation !== 'string' ||
      Buffer.byteLength(serializedOperation, 'utf8') > AUTOMATIC_LEDGER_LIMITS.operationBytes
    ) {
      throw invalidAttemptData();
    }

    switch (wrapper.familyVersion) {
      case 3: {
        const operation = CompositionalAutomaticCaptureOperationV3Schema.parse(wrapper.operation);
        const observation = AutomaticOperationAttemptV3StateCoreV1OwnedDataSchema.parse(
          wrapper.observation,
        );
        return updateV3(operation, observation);
      }
      case 4: {
        const operation = AutonomousPersonalOperationV4OwnedDataSchema.parse(wrapper.operation);
        const observation = AutomaticOperationAttemptV4StateCoreV1OwnedDataSchema.parse(
          wrapper.observation,
        );
        return updateV4(operation, observation);
      }
      default: {
        const impossibleFamily: never = wrapper.familyVersion;
        void impossibleFamily;
        throw invalidAttemptData();
      }
    }
  } catch {
    throw invalidAttemptData();
  }
}
