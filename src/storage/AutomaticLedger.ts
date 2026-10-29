/**
 * Pure backend transition preparation, without persistence or authority checks.
 * A backend must validate source ownership/current authority and atomically commit
 * the returned ledger with its graph mutation under the common writer transaction.
 * Results contain backend state and require a separate public response projection.
 * eligibleFirstCommit is never an agent execution or external delivery permit.
 */
import { z } from 'zod';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticLedgerSchema,
  AutomaticLedgerResultSchema,
  AutomaticLedgerTerminalReceiptSchema,
  AutomaticLegacyUnconfirmedInputSchema,
  AutomaticOperationAdmissionInputSchema,
  AutomaticOperationCancellationInputSchema,
  AutomaticOperationCompletionInputSchema,
  AutomaticOperationFailureInputSchema,
  AutomaticOperationLeaseInputSchema,
  AutomaticOperationResumeInputSchema,
  AutomaticOperationSchema,
  AutomaticOperationDescriptorSchema,
  AutomaticOperationFencedInputSchema,
  AutomaticOperationControlInputSchema,
  automaticOperationDescriptorHash,
  type AutomaticLedger,
  type AutomaticLedgerResult,
  type AutomaticOperation,
  type AutomaticOperationAttempt,
  type AutomaticOperationAttemptInput,
  type StoredAutomaticOperation,
} from '../schemas/AutomaticLedger.schema';
import { AutomaticReceiptSchema, type AutomaticReceipt } from '../schemas/AutomaticClaim.schema';

const BackendTimeSchema = z.string().datetime();
const MAX_RECEIPT_RESERVE_BYTES = AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes;
const MAX_OVERFLOW_COUNTER_GROWTH_BYTES = 9;

type AuditResult = 'recorded' | 'capacity_reached';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((nested) => deepFreeze(nested));
    Object.freeze(value);
  }
  return value;
}

function immutable<T>(value: T): T {
  return deepFreeze(cloneJson(value));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function terminalState(operation: AutomaticOperation): boolean {
  return operation.state === 'committed' || operation.state === 'cancelled';
}

function commonOperationFields(operation: AutomaticOperation) {
  return {
    version: operation.version,
    operationId: operation.operationId,
    identity: operation.identity,
    descriptor: operation.descriptor,
    createdAt: operation.createdAt,
    lastObservedAt: operation.lastObservedAt,
    attempts: operation.attempts,
    overflowCount: operation.overflowCount,
  };
}

function storedReservableState(operation: StoredAutomaticOperation): boolean {
  return (
    operation.state === 'captured' ||
    operation.state === 'leased' ||
    operation.state === 'failed' ||
    operation.state === 'interrupted'
  );
}

function validateLedger(value: unknown): AutomaticLedger | null {
  const parsed = AutomaticLedgerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readLedger(value: unknown): AutomaticLedger | null {
  try {
    return validateLedger(value);
  } catch {
    return null;
  }
}

function parseBackendTime(value: unknown): string | null {
  const parsed = BackendTimeSchema.safeParse(value);
  return parsed.success && Number.isFinite(Date.parse(parsed.data)) ? parsed.data : null;
}

function clockRegressed(operation: AutomaticOperation, now: string): boolean {
  return Date.parse(now) < Date.parse(operation.lastObservedAt);
}

function leaseDurationMs(operation: AutomaticOperation): number {
  if (!operation.descriptor) return 0;
  return Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      operation.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
    ),
  );
}

function addDuration(now: string, durationMs: number): string {
  return new Date(Date.parse(now) + durationMs).toISOString();
}

function attemptFits(
  operation: AutomaticOperation,
  attempt: AutomaticOperationAttemptInput,
  at: string,
  disposition: AutomaticOperationAttempt['disposition'],
): boolean {
  return AutomaticOperationSchema.safeParse({
    ...operation,
    attempts: [...operation.attempts, { ...attempt, at, disposition }],
    lastObservedAt: at,
  }).success;
}

function addAttempt(
  operation: AutomaticOperation,
  attempt: AutomaticOperationAttemptInput,
  at: string,
  disposition: AutomaticOperationAttempt['disposition'],
): { operation: AutomaticOperation; audit: AuditResult } {
  const candidateAttempt: AutomaticOperationAttempt = { ...attempt, at, disposition };
  const canAppend =
    operation.attempts.length < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation &&
    attemptFits(operation, attempt, at, disposition);
  if (canAppend) {
    const candidate = {
      ...operation,
      lastObservedAt: at,
      attempts: [...operation.attempts, candidateAttempt],
    };
    const receiptReserve = terminalState(operation) ? 0 : MAX_RECEIPT_RESERVE_BYTES;
    if (
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') +
        receiptReserve +
        MAX_OVERFLOW_COUNTER_GROWTH_BYTES <=
      AUTOMATIC_LEDGER_LIMITS.operationBytes
    ) {
      return { operation: candidate as AutomaticOperation, audit: 'recorded' };
    }
  }
  return {
    operation: {
      ...operation,
      lastObservedAt: at,
      overflowCount: Math.min(
        AUTOMATIC_LEDGER_LIMITS.overflowCounterMax,
        operation.overflowCount + 1,
      ),
    } as AutomaticOperation,
    audit: 'capacity_reached',
  };
}

function operationIndex(ledger: AutomaticLedger, operationId: string): number {
  return ledger.operations.findIndex((operation) => operation.operationId === operationId);
}

function replaceOperation(
  ledger: AutomaticLedger,
  operation: AutomaticOperation,
): AutomaticLedger | null {
  const index = operationIndex(ledger, operation.operationId);
  if (index < 0) return null;
  if (ledger.operations[index].version !== 1) return null;
  const operations = ledger.operations.slice();
  operations[index] = operation;
  const parsed = AutomaticLedgerSchema.safeParse({ version: 1, operations });
  if (!parsed.success) return null;
  if (!hasReceiptCapacity(parsed.data)) return null;
  return parsed.data;
}

function hasReceiptCapacity(ledger: AutomaticLedger): boolean {
  const reserveByNamespace = new Map<string, number>();
  const counterReserveByNamespace = new Map<string, number>();
  let activeCount = 0;
  const totalCounterReserve = ledger.operations.length * MAX_OVERFLOW_COUNTER_GROWTH_BYTES;
  for (const operation of ledger.operations) {
    const namespace = operation.identity.namespace;
    counterReserveByNamespace.set(namespace, (counterReserveByNamespace.get(namespace) ?? 0) + 1);
    if (!storedReservableState(operation)) continue;
    activeCount += 1;
    reserveByNamespace.set(namespace, (reserveByNamespace.get(namespace) ?? 0) + 1);
  }
  if (
    Buffer.byteLength(JSON.stringify(ledger), 'utf8') +
      activeCount * MAX_RECEIPT_RESERVE_BYTES +
      totalCounterReserve >
    AUTOMATIC_LEDGER_LIMITS.storeBytes
  ) {
    return false;
  }
  for (const [namespace, counterCount] of counterReserveByNamespace) {
    const receiptCount = reserveByNamespace.get(namespace) ?? 0;
    const namespaceOperations = ledger.operations.filter(
      (operation) => operation.identity.namespace === namespace,
    );
    const bytes = Buffer.byteLength(
      JSON.stringify({ version: 1, operations: namespaceOperations }),
      'utf8',
    );
    if (
      bytes +
        receiptCount * MAX_RECEIPT_RESERVE_BYTES +
        counterCount * MAX_OVERFLOW_COUNTER_GROWTH_BYTES >
      AUTOMATIC_LEDGER_LIMITS.namespaceBytes
    ) {
      return false;
    }
  }
  return true;
}

function applyTransition(
  ledger: AutomaticLedger,
  proposed: AutomaticOperation,
  attempt: AutomaticOperationAttemptInput,
  at: string,
  disposition: AutomaticOperationAttempt['disposition'],
): { ledger: AutomaticLedger; operation: AutomaticOperation; audit: AuditResult } | null {
  const audited = addAttempt(proposed, attempt, at, disposition);
  let nextLedger = replaceOperation(ledger, audited.operation);
  if (nextLedger) return { ledger: nextLedger, operation: audited.operation, audit: audited.audit };

  const withoutDetail: AutomaticOperation = {
    ...proposed,
    lastObservedAt: at,
    overflowCount: Math.min(AUTOMATIC_LEDGER_LIMITS.overflowCounterMax, proposed.overflowCount + 1),
  } as AutomaticOperation;
  nextLedger = replaceOperation(ledger, withoutDetail);
  if (!nextLedger) return null;
  return { ledger: nextLedger, operation: withoutDetail, audit: 'capacity_reached' };
}

function outcome(
  kind: AutomaticLedgerResult['kind'],
  ledger: AutomaticLedger | null,
  operation: AutomaticOperation | null,
  details: Partial<
    Pick<
      AutomaticLedgerResult,
      | 'eligibleFirstCommit'
      | 'attemptAudit'
      | 'terminalReceipt'
      | 'currentAuthority'
      | 'leaseFence'
      | 'saved'
      | 'sourcePersistence'
    >
  > & { shouldProcess?: false } = {},
): AutomaticLedgerResult {
  return deepFreeze(
    AutomaticLedgerResultSchema.parse({
      kind,
      ledger: ledger ? immutable(ledger) : null,
      operation: operation ? immutable(operation) : null,
      shouldProcess: false,
      eligibleFirstCommit: false,
      ...details,
    }),
  );
}

function missingOutcome(
  kind: AutomaticLedgerResult['kind'],
  ledger: AutomaticLedger,
  details: Parameters<typeof outcome>[3] = {},
) {
  if (kind === 'invalid_input' || kind === 'not_found') {
    return outcome(kind, null, null, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
      terminalReceipt: null,
      currentAuthority: 'not_evaluated',
      ...details,
    });
  }
  return outcome(kind, ledger, null, { shouldProcess: false, ...details });
}

function privateConflictOutcome(): AutomaticLedgerResult {
  return outcome('conflict', null, null, {
    attemptAudit: 'not_recorded',
    terminalReceipt: null,
    currentAuthority: 'not_evaluated',
  });
}

function findLocator(ledger: AutomaticLedger, identity: AutomaticOperation['identity']) {
  return ledger.operations.find(
    (operation) =>
      operation.identity.namespace === identity.namespace &&
      operation.identity.turn === identity.turn &&
      operation.identity.role === identity.role,
  );
}

function locatorFromUnknown(
  value: unknown,
): { namespace: string; turn: string; role: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = (value as Record<string, unknown>).identity;
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const raw = identity as Record<string, unknown>;
  if (
    typeof raw.namespace !== 'string' ||
    typeof raw.turn !== 'string' ||
    (raw.role !== 'human' && raw.role !== 'assistant')
  ) {
    return null;
  }
  return { namespace: raw.namespace, turn: raw.turn, role: raw.role };
}

function hasExistingLocator(ledger: AutomaticLedger, inputValue: unknown): boolean {
  const locator = locatorFromUnknown(inputValue);
  return (
    locator !== null &&
    ledger.operations.some(
      (operation) =>
        operation.identity.namespace === locator.namespace &&
        operation.identity.turn === locator.turn &&
        operation.identity.role === locator.role,
    )
  );
}

function sameImmutableInputs(
  operation: AutomaticOperation,
  identity: AutomaticOperation['identity'],
  descriptor: NonNullable<AutomaticOperation['descriptor']>,
): boolean {
  return (
    canonical(operation.identity) === canonical(identity) &&
    canonical(operation.descriptor) === canonical(descriptor)
  );
}

function isActiveLease(
  operation: Extract<AutomaticOperation, { state: 'leased' }>,
  now: string,
): boolean {
  return Date.parse(now) < Date.parse(operation.lease.expiresAt);
}

function stateDisposition(
  operation: AutomaticOperation,
  now: string,
): AutomaticOperationAttempt['disposition'] {
  if (operation.state === 'committed') return 'committed_replay';
  if (operation.state === 'cancelled') return 'cancelled_replay';
  if (operation.state === 'legacy_unconfirmed') return 'legacy_unconfirmed';
  if (operation.state === 'leased')
    return isActiveLease(operation, now) ? 'in_progress' : 'resume_available';
  if (operation.state === 'failed' || operation.state === 'interrupted') return 'resume_available';
  return 'in_progress';
}

function admissionStatus(
  operation: AutomaticOperation,
  now: string,
): AutomaticLedgerResult['kind'] {
  if (operation.state === 'committed') return 'committed_replay';
  if (operation.state === 'cancelled') return 'cancelled';
  if (operation.state === 'legacy_unconfirmed') return 'original_receipt_unavailable';
  if (operation.state === 'leased')
    return isActiveLease(operation, now) ? 'in_progress' : 'resume_available';
  if (operation.state === 'failed' || operation.state === 'interrupted') return 'resume_available';
  return 'in_progress';
}

function validateTerminalReceipt(
  operation: AutomaticOperation,
  coverage: unknown,
  dependencies: unknown,
  receipt: unknown,
  terminalAt: string,
) {
  if (
    !operation.descriptor ||
    operation.identity.role !== 'human' ||
    operation.descriptor.interpreterId !== 'literal-parser-v1' ||
    operation.descriptor.policy.profileId === 'existing'
  )
    return null;
  const parsedReceipt = AutomaticReceiptSchema.safeParse(receipt);
  if (!parsedReceipt.success) return null;
  const wrapper = AutomaticLedgerTerminalReceiptSchema.safeParse({
    version: 1,
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: automaticOperationDescriptorHash(operation.descriptor),
    terminalAt,
    coverage,
    dependencies,
    receipt: parsedReceipt.data,
  });
  return wrapper.success ? wrapper.data : null;
}

export function createAutomaticLedger(): AutomaticLedger {
  return immutable(AutomaticLedgerSchema.parse({ version: 1, operations: [] }));
}

export function automaticLedgerLeaseDurationMs(descriptor: unknown): number | null {
  const parsed = AutomaticOperationDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) return null;
  return Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      parsed.data.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
    ),
  );
}

export function admitAutomaticOperation(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticOperationAdmissionInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success) {
    return hasExistingLocator(ledger, inputValue)
      ? privateConflictOutcome()
      : missingOutcome('invalid_input', ledger);
  }
  if (!now) {
    return hasExistingLocator(ledger, inputValue)
      ? privateConflictOutcome()
      : missingOutcome('invalid_input', ledger);
  }

  const existing = findLocator(ledger, input.data.identity);
  if (existing) {
    if (existing.version !== 1) return privateConflictOutcome();
    if (!sameImmutableInputs(existing, input.data.identity, input.data.descriptor)) {
      return privateConflictOutcome();
    }
    if (clockRegressed(existing, now)) {
      return outcome('clock_regression', ledger, existing, {
        shouldProcess: false,
        attemptAudit: 'not_recorded',
      });
    }
    const disposition = stateDisposition(existing, now);
    const transition = applyTransition(ledger, existing, input.data.attempt, now, disposition);
    if (!transition) {
      return outcome(admissionStatus(existing, now), ledger, existing, {
        shouldProcess: false,
        attemptAudit: 'capacity_reached',
        terminalReceipt:
          existing.state === 'committed' || existing.state === 'cancelled'
            ? existing.terminalReceipt
            : null,
        currentAuthority: 'not_evaluated',
      });
    }
    return outcome(admissionStatus(existing, now), transition.ledger, transition.operation, {
      shouldProcess: false,
      attemptAudit: transition.audit,
      terminalReceipt:
        existing.state === 'committed' || existing.state === 'cancelled'
          ? existing.terminalReceipt
          : null,
      currentAuthority: 'not_evaluated',
    });
  }

  const sameSource = ledger.operations.find(
    (operation) => operation.identity.sourceId === input.data.identity.sourceId,
  );
  if (
    sameSource ||
    ledger.operations.some((operation) => operation.operationId === input.data.operationId)
  ) {
    return privateConflictOutcome();
  }

  const operation = AutomaticOperationSchema.safeParse({
    version: 1,
    operationId: input.data.operationId,
    identity: input.data.identity,
    descriptor: input.data.descriptor,
    createdAt: now,
    lastObservedAt: now,
    attempts: [],
    overflowCount: 0,
    state: 'captured',
    generation: 0,
  });
  if (!operation.success) return missingOutcome('invalid_input', ledger);
  const audited = addAttempt(operation.data, input.data.attempt, now, 'captured');
  const operations = [...ledger.operations, audited.operation];
  const next = AutomaticLedgerSchema.safeParse({ version: 1, operations });
  if (!next.success || !hasReceiptCapacity(next.data)) {
    return missingOutcome('capacity', ledger, {
      shouldProcess: false,
      attemptAudit: 'capacity_reached',
      saved: false,
      sourcePersistence: 'caller_must_handle',
    });
  }
  return outcome('created', next.data, audited.operation, {
    shouldProcess: false,
    attemptAudit: audited.audit,
  });
}

export function observeLegacyUnconfirmed(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticLegacyUnconfirmedInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success || !now) {
    return hasExistingLocator(ledger, inputValue)
      ? privateConflictOutcome()
      : missingOutcome('invalid_input', ledger);
  }
  const existing = findLocator(ledger, input.data.identity);
  if (existing) {
    if (existing.version !== 1) return privateConflictOutcome();
    if (canonical(existing.identity) !== canonical(input.data.identity)) {
      return privateConflictOutcome();
    }
    if (clockRegressed(existing, now)) {
      return outcome('clock_regression', ledger, existing, { shouldProcess: false });
    }
    const disposition = stateDisposition(existing, now);
    const transition = applyTransition(ledger, existing, input.data.attempt, now, disposition);
    return outcome(
      admissionStatus(existing, now),
      transition?.ledger ?? ledger,
      transition?.operation ?? existing,
      {
        shouldProcess: false,
        attemptAudit: transition?.audit ?? 'capacity_reached',
        terminalReceipt:
          existing.state === 'committed' || existing.state === 'cancelled'
            ? existing.terminalReceipt
            : null,
        currentAuthority: 'not_evaluated',
      },
    );
  }
  if (
    ledger.operations.some((operation) => operation.operationId === input.data.operationId) ||
    ledger.operations.some(
      (operation) => operation.identity.sourceId === input.data.identity.sourceId,
    )
  ) {
    return privateConflictOutcome();
  }
  const created = AutomaticOperationSchema.safeParse({
    version: 1,
    operationId: input.data.operationId,
    identity: input.data.identity,
    descriptor: null,
    createdAt: now,
    lastObservedAt: now,
    attempts: [],
    overflowCount: 0,
    state: 'legacy_unconfirmed',
    generation: 0,
  });
  if (!created.success) return missingOutcome('invalid_input', ledger);
  const audited = addAttempt(created.data, input.data.attempt, now, 'legacy_unconfirmed');
  const next = AutomaticLedgerSchema.safeParse({
    version: 1,
    operations: [...ledger.operations, audited.operation],
  });
  if (!next.success) {
    return missingOutcome('capacity', ledger, {
      shouldProcess: false,
      attemptAudit: 'capacity_reached',
    });
  }
  return outcome('original_receipt_unavailable', next.data, audited.operation, {
    shouldProcess: false,
    attemptAudit: audited.audit,
    terminalReceipt: null,
    currentAuthority: 'not_evaluated',
  });
}

export function claimAutomaticOperation(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticOperationLeaseInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success || !now) return missingOutcome('invalid_input', ledger);
  const current = ledger.operations.find(
    (operation) => operation.operationId === input.data.operationId,
  );
  if (!current) return missingOutcome('not_found', ledger);
  if (current.version !== 1) return privateConflictOutcome();
  if (clockRegressed(current, now)) {
    return outcome('clock_regression', ledger, current, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
    });
  }
  if (current.state !== 'captured') {
    const disposition = stateDisposition(current, now);
    const transition = applyTransition(ledger, current, input.data.attempt, now, disposition);
    return outcome(
      admissionStatus(current, now),
      transition?.ledger ?? ledger,
      transition?.operation ?? current,
      {
        shouldProcess: false,
        attemptAudit: transition?.audit ?? 'capacity_reached',
        terminalReceipt:
          current.state === 'committed' || current.state === 'cancelled'
            ? current.terminalReceipt
            : null,
        currentAuthority: 'not_evaluated',
      },
    );
  }
  if (current.descriptor?.executionMode !== 'synchronous') {
    const transition = applyTransition(
      ledger,
      current,
      input.data.attempt,
      now,
      'unsupported_mode',
    );
    return outcome(
      'unsupported_durable_linkage',
      transition?.ledger ?? ledger,
      transition?.operation ?? current,
      {
        shouldProcess: false,
        attemptAudit: transition?.audit ?? 'capacity_reached',
      },
    );
  }
  const duration = leaseDurationMs(current);
  const leased = AutomaticOperationSchema.safeParse({
    ...commonOperationFields(current),
    lastObservedAt: now,
    state: 'leased',
    generation: current.generation + 1,
    lease: {
      token: input.data.token,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: addDuration(now, duration),
      claimKind: 'initial',
    },
  });
  if (!leased.success) return missingOutcome('generation_exhausted', ledger);
  const transition = applyTransition(ledger, leased.data, input.data.attempt, now, 'claim_won');
  if (!transition) return missingOutcome('capacity', ledger, { attemptAudit: 'capacity_reached' });
  return outcome('claimed', transition.ledger, transition.operation, {
    shouldProcess: false,
    attemptAudit: transition.audit,
    leaseFence: { generation: current.generation + 1, token: input.data.token },
  });
}

export function renewAutomaticOperation(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticOperationFencedInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success || !now) return missingOutcome('invalid_input', ledger);
  const current = ledger.operations.find(
    (operation) => operation.operationId === input.data.operationId,
  );
  if (!current) return missingOutcome('not_found', ledger);
  if (current.version !== 1) return privateConflictOutcome();
  if (clockRegressed(current, now)) {
    return outcome('clock_regression', ledger, current, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
    });
  }
  if (current.state !== 'leased')
    return missingOutcome('fenced', ledger, { attemptAudit: 'not_recorded' });
  if (
    current.generation !== input.data.fence.generation ||
    current.lease.token !== input.data.fence.token
  ) {
    const transition = applyTransition(ledger, current, input.data.attempt, now, 'fenced');
    return outcome('fenced', transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
    });
  }
  if (!isActiveLease(current, now)) {
    const transition = applyTransition(
      ledger,
      current,
      input.data.attempt,
      now,
      'resume_available',
    );
    return outcome('expired', transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
    });
  }
  if (current.descriptor?.executionMode !== 'synchronous') {
    return missingOutcome('unsupported_durable_linkage', ledger);
  }
  const renewed = AutomaticOperationSchema.safeParse({
    ...current,
    lastObservedAt: now,
    lease: {
      ...current.lease,
      renewedAt: now,
      expiresAt: addDuration(now, leaseDurationMs(current)),
    },
  });
  if (!renewed.success) return missingOutcome('invalid_ledger', ledger);
  const transition = applyTransition(
    ledger,
    renewed.data,
    input.data.attempt,
    now,
    'lease_renewed',
  );
  if (!transition) return missingOutcome('capacity', ledger, { attemptAudit: 'capacity_reached' });
  return outcome('renewed', transition.ledger, transition.operation, {
    shouldProcess: false,
    attemptAudit: transition.audit,
    leaseFence: { generation: current.generation, token: current.lease.token },
  });
}

export function completeAutomaticOperation(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticOperationCompletionInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success || !now) return missingOutcome('invalid_input', ledger);
  const current = ledger.operations.find(
    (operation) => operation.operationId === input.data.operationId,
  );
  if (!current) return missingOutcome('not_found', ledger);
  if (current.version !== 1) return privateConflictOutcome();
  if (clockRegressed(current, now)) {
    return outcome('clock_regression', ledger, current, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
    });
  }
  if (current.state !== 'leased') {
    const disposition = stateDisposition(current, now);
    const transition = applyTransition(ledger, current, input.data.attempt, now, disposition);
    return outcome(
      admissionStatus(current, now),
      transition?.ledger ?? ledger,
      transition?.operation ?? current,
      {
        shouldProcess: false,
        attemptAudit: transition?.audit ?? 'capacity_reached',
        terminalReceipt:
          current.state === 'committed' || current.state === 'cancelled'
            ? current.terminalReceipt
            : null,
        currentAuthority: 'not_evaluated',
      },
    );
  }
  if (
    current.generation !== input.data.fence.generation ||
    current.lease.token !== input.data.fence.token
  ) {
    const transition = applyTransition(ledger, current, input.data.attempt, now, 'fenced');
    return outcome('fenced', transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
    });
  }
  if (!isActiveLease(current, now)) {
    const transition = applyTransition(
      ledger,
      current,
      input.data.attempt,
      now,
      'resume_available',
    );
    return outcome('expired', transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
    });
  }
  if (current.descriptor?.executionMode !== 'synchronous') {
    return missingOutcome('unsupported_durable_linkage', ledger);
  }
  const terminalReceipt = validateTerminalReceipt(
    current,
    input.data.coverage,
    input.data.dependencies,
    input.data.receipt,
    now,
  );
  if (!terminalReceipt) {
    return outcome('invalid_or_unsupported_receipt', ledger, current, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
    });
  }
  const committedOperation = AutomaticOperationSchema.safeParse({
    ...commonOperationFields(current),
    state: 'committed',
    generation: current.generation,
    lastObservedAt: now,
    terminalReceipt,
  });
  if (!committedOperation.success) return missingOutcome('invalid_or_unsupported_receipt', ledger);
  const transition = applyTransition(
    ledger,
    committedOperation.data,
    input.data.attempt,
    now,
    'committed',
  );
  if (!transition) return missingOutcome('capacity', ledger, { attemptAudit: 'capacity_reached' });
  const eligibleFirstCommit =
    current.lease.claimKind === 'initial' &&
    current.descriptor?.executionMode === 'synchronous' &&
    terminalReceipt.coverage !== 'unknown';
  return outcome('committed', transition.ledger, transition.operation, {
    eligibleFirstCommit,
    attemptAudit: transition.audit,
    terminalReceipt,
    currentAuthority: 'not_evaluated',
  });
}

export function failAutomaticOperation(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticOperationFailureInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success || !now) return missingOutcome('invalid_input', ledger);
  const current = ledger.operations.find(
    (operation) => operation.operationId === input.data.operationId,
  );
  if (!current) return missingOutcome('not_found', ledger);
  if (current.version !== 1) return privateConflictOutcome();
  if (clockRegressed(current, now)) {
    return outcome('clock_regression', ledger, current, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
    });
  }
  if (current.state !== 'leased')
    return missingOutcome('fenced', ledger, { attemptAudit: 'not_recorded' });
  if (
    current.generation !== input.data.fence.generation ||
    current.lease.token !== input.data.fence.token
  ) {
    const transition = applyTransition(ledger, current, input.data.attempt, now, 'fenced');
    return outcome('fenced', transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
    });
  }
  if (!isActiveLease(current, now)) {
    const transition = applyTransition(
      ledger,
      current,
      input.data.attempt,
      now,
      'resume_available',
    );
    return outcome('expired', transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
    });
  }
  const nextState =
    input.data.state === 'failed'
      ? {
          ...commonOperationFields(current),
          state: 'failed' as const,
          generation: current.generation,
          failedAt: now,
          failureCode: input.data.failureCode as Extract<
            AutomaticOperation,
            { state: 'failed' }
          >['failureCode'],
        }
      : {
          ...commonOperationFields(current),
          state: 'interrupted' as const,
          generation: current.generation,
          interruptedAt: now,
          failureCode: input.data.failureCode as Extract<
            AutomaticOperation,
            { state: 'interrupted' }
          >['failureCode'],
        };
  const failedOperation = AutomaticOperationSchema.safeParse({ ...nextState, lastObservedAt: now });
  if (!failedOperation.success) return missingOutcome('invalid_input', ledger);
  const transition = applyTransition(
    ledger,
    failedOperation.data,
    input.data.attempt,
    now,
    input.data.state,
  );
  if (!transition) return missingOutcome('capacity', ledger, { attemptAudit: 'capacity_reached' });
  return outcome(input.data.state, transition.ledger, transition.operation, {
    shouldProcess: false,
    attemptAudit: transition.audit,
  });
}

export function resumeAutomaticOperation(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticOperationResumeInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success || !now) return missingOutcome('invalid_input', ledger);
  const current = ledger.operations.find(
    (operation) => operation.operationId === input.data.operationId,
  );
  if (!current) return missingOutcome('not_found', ledger);
  if (current.version !== 1) return privateConflictOutcome();
  if (clockRegressed(current, now)) {
    return outcome('clock_regression', ledger, current, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
    });
  }
  if (
    current.state === 'committed' ||
    current.state === 'cancelled' ||
    current.state === 'legacy_unconfirmed'
  ) {
    const disposition = stateDisposition(current, now);
    const transition = applyTransition(ledger, current, input.data.attempt, now, disposition);
    const kind =
      current.state === 'committed'
        ? 'committed_replay'
        : current.state === 'cancelled'
          ? 'cancelled'
          : 'original_receipt_unavailable';
    return outcome(kind, transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
      terminalReceipt:
        current.state === 'committed' || current.state === 'cancelled'
          ? current.terminalReceipt
          : null,
      currentAuthority: 'not_evaluated',
    });
  }
  if (current.generation !== input.data.expectedGeneration) {
    const transition = applyTransition(ledger, current, input.data.attempt, now, 'fenced');
    return outcome('fenced', transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
    });
  }
  if (current.state === 'leased' && isActiveLease(current, now)) {
    const transition = applyTransition(ledger, current, input.data.attempt, now, 'in_progress');
    return outcome('in_progress', transition?.ledger ?? ledger, transition?.operation ?? current, {
      shouldProcess: false,
      attemptAudit: transition?.audit ?? 'capacity_reached',
    });
  }
  if (current.state === 'captured') {
    const transition = applyTransition(
      ledger,
      current,
      input.data.attempt,
      now,
      'resume_available',
    );
    return outcome(
      'resume_unavailable',
      transition?.ledger ?? ledger,
      transition?.operation ?? current,
      {
        shouldProcess: false,
        attemptAudit: transition?.audit ?? 'capacity_reached',
      },
    );
  }
  if (current.descriptor?.executionMode !== 'synchronous') {
    const transition = applyTransition(
      ledger,
      current,
      input.data.attempt,
      now,
      'unsupported_mode',
    );
    return outcome(
      'unsupported_durable_linkage',
      transition?.ledger ?? ledger,
      transition?.operation ?? current,
      {
        shouldProcess: false,
        attemptAudit: transition?.audit ?? 'capacity_reached',
      },
    );
  }
  if (current.generation >= AUTOMATIC_LEDGER_LIMITS.maxGeneration) {
    return missingOutcome('generation_exhausted', ledger);
  }
  if (current.state === 'leased' && current.lease.token === input.data.token) {
    return missingOutcome('invalid_input', ledger);
  }
  const resumed = AutomaticOperationSchema.safeParse({
    ...commonOperationFields(current),
    lastObservedAt: now,
    state: 'leased',
    generation: current.generation + 1,
    lease: {
      token: input.data.token,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: addDuration(now, leaseDurationMs(current)),
      claimKind: 'resume',
    },
  });
  if (!resumed.success) return missingOutcome('invalid_ledger', ledger);
  const transition = applyTransition(ledger, resumed.data, input.data.attempt, now, 'resumed');
  if (!transition) return missingOutcome('capacity', ledger, { attemptAudit: 'capacity_reached' });
  return outcome('resumed', transition.ledger, transition.operation, {
    shouldProcess: false,
    attemptAudit: transition.audit,
    leaseFence: { generation: current.generation + 1, token: input.data.token },
  });
}

export function cancelAutomaticOperation(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticOperationCancellationInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success || !now) return missingOutcome('invalid_input', ledger);
  const current = ledger.operations.find(
    (operation) => operation.operationId === input.data.operationId,
  );
  if (!current) return missingOutcome('not_found', ledger);
  if (current.version !== 1) return privateConflictOutcome();
  if (clockRegressed(current, now)) {
    return outcome('clock_regression', ledger, current, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
    });
  }
  if (
    current.state === 'committed' ||
    current.state === 'cancelled' ||
    current.state === 'legacy_unconfirmed'
  ) {
    const disposition = stateDisposition(current, now);
    const transition = applyTransition(ledger, current, input.data.attempt, now, disposition);
    return outcome(
      admissionStatus(current, now),
      transition?.ledger ?? ledger,
      transition?.operation ?? current,
      {
        shouldProcess: false,
        attemptAudit: transition?.audit ?? 'capacity_reached',
        terminalReceipt:
          current.state === 'committed' || current.state === 'cancelled'
            ? current.terminalReceipt
            : null,
        currentAuthority: 'not_evaluated',
      },
    );
  }
  if (current.generation !== input.data.expectedGeneration) {
    return missingOutcome('fenced', ledger, { attemptAudit: 'not_recorded' });
  }
  if (current.state === 'leased') {
    if (
      !input.data.fence ||
      input.data.fence.generation !== current.generation ||
      input.data.fence.token !== current.lease.token
    ) {
      return missingOutcome('fenced', ledger, { attemptAudit: 'not_recorded' });
    }
    if (!isActiveLease(current, now)) {
      const transition = applyTransition(
        ledger,
        current,
        input.data.attempt,
        now,
        'resume_available',
      );
      return outcome('expired', transition?.ledger ?? ledger, transition?.operation ?? current, {
        shouldProcess: false,
        attemptAudit: transition?.audit ?? 'capacity_reached',
      });
    }
  }
  const terminalReceipt = validateTerminalReceipt(
    current,
    input.data.coverage,
    input.data.dependencies,
    input.data.receipt,
    now,
  );
  if (
    !terminalReceipt ||
    terminalReceipt.coverage === 'all' ||
    terminalReceipt.coverage === 'partial'
  ) {
    return missingOutcome('invalid_or_unsupported_receipt', ledger);
  }
  const cancelled = AutomaticOperationSchema.safeParse({
    ...commonOperationFields(current),
    state: 'cancelled',
    generation: current.generation,
    lastObservedAt: now,
    terminalReceipt,
  });
  if (!cancelled.success) return missingOutcome('invalid_or_unsupported_receipt', ledger);
  const transition = applyTransition(ledger, cancelled.data, input.data.attempt, now, 'cancelled');
  if (!transition) return missingOutcome('capacity', ledger, { attemptAudit: 'capacity_reached' });
  return outcome('cancelled', transition.ledger, transition.operation, {
    shouldProcess: false,
    attemptAudit: transition.audit,
    terminalReceipt,
    currentAuthority: 'not_evaluated',
  });
}

export function readAutomaticOperation(
  ledgerValue: unknown,
  inputValue: unknown,
  backendNowValue: unknown,
) {
  const ledger = readLedger(ledgerValue);
  if (!ledger) return outcome('invalid_ledger', null, null, { shouldProcess: false });
  const input = AutomaticOperationControlInputSchema.safeParse(inputValue);
  const now = parseBackendTime(backendNowValue);
  if (!input.success || !now) return missingOutcome('invalid_input', ledger);
  const current = ledger.operations.find(
    (operation) => operation.operationId === input.data.operationId,
  );
  if (!current) return missingOutcome('not_found', ledger);
  if (current.version !== 1) return privateConflictOutcome();
  if (clockRegressed(current, now)) {
    return outcome('clock_regression', ledger, current, {
      shouldProcess: false,
      attemptAudit: 'not_recorded',
    });
  }
  const transition = applyTransition(
    ledger,
    current,
    input.data.attempt,
    now,
    stateDisposition(current, now),
  );
  const resultOperation = transition?.operation ?? current;
  return outcome(admissionStatus(current, now), transition?.ledger ?? ledger, resultOperation, {
    shouldProcess: false,
    attemptAudit: transition?.audit ?? 'capacity_reached',
    terminalReceipt:
      current.state === 'committed' || current.state === 'cancelled'
        ? current.terminalReceipt
        : null,
    currentAuthority: 'not_evaluated',
  });
}

export function automaticOperationReceipt(value: unknown): AutomaticReceipt | null {
  const parsed = AutomaticReceiptSchema.safeParse(value);
  return parsed.success ? immutable(parsed.data) : null;
}
