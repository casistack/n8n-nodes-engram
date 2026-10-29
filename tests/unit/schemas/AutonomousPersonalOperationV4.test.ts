import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import { StoredAutomaticOperationSchema } from '../../../src/schemas/AutomaticLedger.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalOperationV4Schema as OperationSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
  AutonomousPersonalReceiptV4Schema as ReceiptSchema,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import {
  compileAutonomousPersonalDescriptorV4,
  hashAutonomousPersonalDescriptorV4,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { compileAutonomousPersonalSourceTupleV4 } from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import { cloneBoundedAutomaticCaptureJson } from '../../../src/storage/BoundedAutomaticCaptureJson';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';

const T0 = '2026-10-26T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const hashAt = (value: number) => value.toString(16).padStart(64, '0');
const uuidAt = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const controlMax = (length: number) => '\u0001'.repeat(length - 1) + 'x';

function descriptorInput(maximum = false) {
  return {
    profileId: 'reviewFirst' as const,
    requestedTrustLevel: 'standard' as const,
    intentSetting: false,
    invocationDeadlineMs: 120_000,
    providerReference: {
      routeId: maximum ? controlMax(128) : 'synthetic-route',
      configurationFingerprint: HASH,
      protocol: 'openai-compatible-json-v1' as const,
      configuredRequestLimit: 256,
      configuredTimeoutMs: Number.MAX_SAFE_INTEGER,
      configuredRequestBytes: Number.MAX_SAFE_INTEGER,
      configuredResponseBytes: Number.MAX_SAFE_INTEGER,
      temperature: { mode: 'providerDefault' as const },
      responseFormat: 'json_object' as const,
      outputTokenLimit: { mode: 'omit' as const },
    },
  };
}

function makeBase(maximum = false) {
  const descriptor = compileAutonomousPersonalDescriptorV4(descriptorInput(maximum));
  const namespace = maximum ? controlMax(128) : 'tenant:synthetic';
  const sourceTuple = compileAutonomousPersonalSourceTupleV4({
    scope: {
      storeHash: HASH,
      namespace,
      issuer: maximum ? controlMax(256) : 'synthetic-workflow',
      actorReference: maximum ? controlMax(512) : 'synthetic-user',
      turn: maximum ? controlMax(512) : 'synthetic-turn',
      binding: {
        bindingId: uuidAt(1),
        revision: maximum ? AUTOMATIC_LEDGER_LIMITS.maxGeneration : 3,
        subjectId: uuidAt(2),
        fingerprint: 'b'.repeat(64),
      },
    },
    descriptor,
    producer: {
      uuid: uuidAt(3),
      group_id: namespace,
      content: 'Synthetic source bytes.',
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      reference_time: T0,
      previous_episode_uuid: null,
      source_message_id: null,
      idempotency_key: null,
      conversation_id: null,
      sender_id: null,
      source_workflow_id: null,
      source_execution_id: null,
      quoted_message_id: null,
      created_at: T0,
    },
    eventTimeMode: 'first_capture',
    mapping: { mode: 'full_body' },
    quoteRegions: [],
  });
  return { descriptor, identity: sourceTuple.identity };
}

type Base = ReturnType<typeof makeBase>;

function makeKnownNoMemoryReceipt(base: Base, operationId = uuidAt(10)) {
  return {
    version: 4,
    kind: 'human_autonomous_source_verdict_committed',
    operationId,
    sourceId: base.identity.sourceId,
    sourceHash: base.identity.sourceHash,
    descriptorHash: hashAutonomousPersonalDescriptorV4(base.descriptor),
    policyFingerprint: base.descriptor.policy.fingerprint,
    terminalAt: T0,
    interpretationCoverage: 'complete',
    acceptedCoverage: 'none',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage: {
      status: 'complete',
      scanStatus: 'complete',
      sourceUnitCount: 0,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    },
    selection: { kind: 'source_verdict', outcome: 'known_no_memory' },
  };
}

function makeOccurrenceReceipt(base: Base, operationId = uuidAt(10)) {
  return {
    version: 4,
    kind: 'human_autonomous_capture_committed',
    operationId,
    sourceId: base.identity.sourceId,
    sourceHash: base.identity.sourceHash,
    descriptorHash: hashAutonomousPersonalDescriptorV4(base.descriptor),
    policyFingerprint: base.descriptor.policy.fingerprint,
    terminalAt: T0,
    interpretationCoverage: 'complete',
    acceptedCoverage: 'all',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage: {
      status: 'complete',
      scanStatus: 'complete',
      sourceUnitCount: 1,
      candidateUnitCount: 1,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    },
    selection: {
      kind: 'occurrences',
      items: [
        {
          occurrenceIndex: 0,
          kind: 'source_statement_record',
          evidenceHash: hashAt(100),
          meaningHash: hashAt(200),
          dependencies: [{ index: 0, dependencyHash: hashAt(300) }],
          state: 'accepted',
          effect: 'created',
          claimId: uuidAt(20),
          reason: 'eligible_create',
        },
      ],
    },
  };
}

function makeOperation(base = makeBase()) {
  return {
    version: 4,
    operationId: uuidAt(10),
    identity: base.identity,
    descriptor: base.descriptor,
    createdAt: T0,
    lastObservedAt: T0,
    attempts: [],
    overflowCount: 0,
    beginCallHash: hashAt(400),
    retryCount: 0,
    state: 'captured',
    generation: 0,
  };
}

function makeCommittedOperation(
  base: Base,
  receipt: ReturnType<typeof makeKnownNoMemoryReceipt> | ReturnType<typeof makeOccurrenceReceipt>,
) {
  return {
    ...makeOperation(base),
    state: 'committed' as const,
    generation: 1,
    terminalReceipt: receipt,
    completionCallHash: hashAt(401),
  };
}

function makeCancelledReceipt(base: Base, operationId = uuidAt(10)) {
  return {
    version: 4,
    kind: 'cancelled',
    operationId,
    sourceId: base.identity.sourceId,
    sourceHash: base.identity.sourceHash,
    descriptorHash: hashAutonomousPersonalDescriptorV4(base.descriptor),
    policyFingerprint: base.descriptor.policy.fingerprint,
    terminalAt: T0,
    acceptedCoverage: 'none',
  };
}

function expectFixedError(parse: (value: unknown) => unknown, value: unknown, code: string): void {
  let failure: unknown;
  try {
    parse(value);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    issues: [{ code: 'custom', path: [], message: code }],
  });
  const error = failure as { issues: Array<{ path: unknown[] }> };
  expect(Object.isFrozen(failure)).toBe(true);
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(Object.isFrozen(error.issues[0])).toBe(true);
  expect(Object.isFrozen(error.issues[0]?.path)).toBe(true);
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeCoverage(overrides: Record<string, unknown> = {}) {
  return {
    status: 'partial',
    scanStatus: 'complete',
    sourceUnitCount: 2,
    candidateUnitCount: 1,
    neutralUnitCount: 0,
    withheldUnitCount: 0,
    unresolvedUnitCount: 1,
    unresolvedReason: 'provider_unknown',
    ...overrides,
  };
}

function makeMaximumOccurrenceReceipt(base: Base, operationId = uuidAt(5000)) {
  const items = Array.from({ length: 32 }, (_, index) => ({
    occurrenceIndex: index,
    kind: index < 2 ? 'typed_preference' : 'source_statement_record',
    evidenceHash: hashAt(index + 1),
    meaningHash: hashAt(index + 100),
    dependencies: [{ index: 0, dependencyHash: hashAt(index + 200) }],
    state: 'proposed',
    effect: 'created',
    claimId: uuidAt(index + 6000),
    reason: 'profile_review_required',
  }));
  return {
    version: 4,
    kind: 'human_autonomous_capture_committed',
    operationId,
    sourceId: base.identity.sourceId,
    sourceHash: base.identity.sourceHash,
    descriptorHash: hashAutonomousPersonalDescriptorV4(base.descriptor),
    policyFingerprint: base.descriptor.policy.fingerprint,
    terminalAt: T0,
    interpretationCoverage: 'partial',
    acceptedCoverage: 'none',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage: {
      status: 'partial',
      scanStatus: 'complete',
      sourceUnitCount: 32,
      candidateUnitCount: 31,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 1,
      unresolvedReason: 'provider_unknown',
    },
    selection: { kind: 'occurrences', items },
  };
}

function makeMaximumOperation(attemptCount: number) {
  const base = makeBase(true);
  const operationId = uuidAt(5000);
  const receipt = makeMaximumOccurrenceReceipt(base, operationId);
  const attempts = Array.from({ length: attemptCount }, (_, index) =>
    AutomaticOperationAttemptSchema.parse({
      attemptHash: hashAt(index + 1000),
      at: T0,
      disposition: index === 0 ? 'claim_won' : 'legacy_unconfirmed',
    }),
  );
  return {
    operation: {
      ...makeOperation(base),
      operationId,
      attempts,
      overflowCount: AUTOMATIC_LEDGER_LIMITS.overflowCounterMax,
      auditTruncated: false,
      lastResumeCause: 'lease_expired',
      retryCount: 3,
      lastRetryCallHash: hashAt(778),
      state: 'committed',
      generation: AUTOMATIC_LEDGER_LIMITS.maxGeneration,
      terminalReceipt: receipt,
      completionCallHash: hashAt(779),
    },
    receipt,
  };
}

describe('AutonomousPersonalOperationV4 DATA schema', () => {
  test('owns, freezes, and returns captured operation metadata without caller aliases', () => {
    const input = makeOperation();
    const parsed = OperationSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.identity).not.toBe(input.identity);
    expect(Object.isFrozen(input)).toBe(false);
    expectDeepFrozen(parsed);
    expect(OperationSchema.safeParse(input)).toMatchObject({ success: true });

    const receipt = makeKnownNoMemoryReceipt(makeBase());
    const parsedReceipt = ReceiptSchema.parse(receipt);
    expect(parsedReceipt).toEqual(receipt);
    expect(parsedReceipt).not.toBe(receipt);
    expectDeepFrozen(parsedReceipt);
    expect(ReceiptSchema.safeParse(receipt)).toMatchObject({ success: true });
  });

  test('accepts all four receipt families, including the empty-source neutral verdict', () => {
    const base = makeBase();
    const empty = makeKnownNoMemoryReceipt(base);
    expect(ReceiptSchema.parse(empty)).toEqual(empty);

    const unsupported = makeKnownNoMemoryReceipt(base) as Record<string, unknown>;
    unsupported.sourceCoverage = {
      status: 'complete',
      scanStatus: 'complete',
      sourceUnitCount: 1,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 1,
      unresolvedUnitCount: 0,
      unresolvedReason: null,
    };
    unsupported.selection = { kind: 'source_verdict', outcome: 'unsupported_source' };
    expect(ReceiptSchema.safeParse(unsupported).success).toBe(true);

    const unknown = makeKnownNoMemoryReceipt(base) as Record<string, unknown>;
    unknown.interpretationCoverage = 'unknown';
    unknown.sourceCoverage = {
      status: 'unknown',
      scanStatus: 'indeterminate_suffix',
      sourceUnitCount: null,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: null,
      unresolvedReason: 'unmatched_quote',
    };
    unknown.selection = { kind: 'source_verdict', outcome: 'unknown_source' };
    expect(ReceiptSchema.safeParse(unknown).success).toBe(true);

    const providerUnknown = makeKnownNoMemoryReceipt(base) as Record<string, unknown>;
    providerUnknown.interpretationCoverage = 'unknown';
    providerUnknown.sourceCoverage = {
      status: 'unknown',
      scanStatus: 'complete',
      sourceUnitCount: 1,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 1,
      unresolvedReason: 'provider_unknown',
    };
    providerUnknown.selection = { kind: 'source_verdict', outcome: 'unknown_source' };
    expect(ReceiptSchema.safeParse(providerUnknown).success).toBe(true);

    const notSelected = clone(providerUnknown) as Record<string, unknown>;
    notSelected.sourceCoverage = {
      ...(notSelected.sourceCoverage as Record<string, unknown>),
      unresolvedReason: 'policy_not_selected',
    };
    notSelected.selection = { kind: 'source_verdict', outcome: 'policy_not_selected' };
    expect(ReceiptSchema.safeParse(notSelected).success).toBe(true);

    const deferred = makeKnownNoMemoryReceipt(base) as Record<string, unknown>;
    deferred.kind = 'human_autonomous_source_deferred_committed';
    deferred.interpretationCoverage = 'unknown';
    deferred.sourceCoverage = {
      status: 'unknown',
      scanStatus: 'complete',
      sourceUnitCount: 1,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 1,
      unresolvedReason: 'provider_failure',
    };
    deferred.selection = { kind: 'source_only_deferred', reason: 'provider_invalid_response' };
    expect(ReceiptSchema.safeParse(deferred).success).toBe(true);

    const resource = clone(deferred);
    resource.sourceCoverage = {
      status: 'not_reported',
      scanStatus: 'resource_limit',
      sourceUnitCount: null,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: null,
      unresolvedReason: 'unit_limit',
    };
    resource.selection = { kind: 'source_only_deferred', reason: 'interpretation_capacity' };
    expect(ReceiptSchema.safeParse(resource).success).toBe(true);

    const cancelled = makeCancelledReceipt(base);
    expect(ReceiptSchema.safeParse(cancelled).success).toBe(true);
    expect(cancelled).not.toHaveProperty('sourceCoverage');
  });

  test('checks occurrence mapping, duplicate meaning agreement, item ordering and bounds', () => {
    const base = makeBase();
    const twoOccurrences = makeOccurrenceReceipt(base) as Record<string, unknown>;
    const selection = twoOccurrences.selection as {
      kind: string;
      items: Array<Record<string, unknown>>;
    };
    selection.items.push({
      ...clone(selection.items[0]!),
      occurrenceIndex: 1,
      evidenceHash: hashAt(101),
      effect: 'reference',
      reason: 'existing_accepted',
    });
    twoOccurrences.acceptedCoverage = 'all';
    twoOccurrences.sourceCoverage = {
      ...(twoOccurrences.sourceCoverage as Record<string, unknown>),
      sourceUnitCount: 1,
      candidateUnitCount: 1,
    };
    expect(ReceiptSchema.safeParse(twoOccurrences).success).toBe(true);

    const invalidCases: unknown[] = [];
    const wrongIndexes = clone(twoOccurrences) as Record<string, unknown>;
    (
      wrongIndexes.selection as { items: Array<Record<string, unknown>> }
    ).items[1]!.occurrenceIndex = 3;
    invalidCases.push(wrongIndexes);

    const duplicateEvidence = clone(twoOccurrences) as Record<string, unknown>;
    (
      duplicateEvidence.selection as { items: Array<Record<string, unknown>> }
    ).items[1]!.evidenceHash = hashAt(100);
    invalidCases.push(duplicateEvidence);

    const duplicateCreator = clone(twoOccurrences) as Record<string, unknown>;
    const creatorItems = (duplicateCreator.selection as { items: Array<Record<string, unknown>> })
      .items;
    creatorItems[1]!.effect = 'created';
    creatorItems[1]!.reason = 'eligible_create';
    invalidCases.push(duplicateCreator);

    const meaningToDifferentClaim = clone(twoOccurrences) as Record<string, unknown>;
    const meaningItems = (
      meaningToDifferentClaim.selection as { items: Array<Record<string, unknown>> }
    ).items;
    meaningItems[1]!.claimId = uuidAt(21);
    invalidCases.push(meaningToDifferentClaim);

    const claimToDifferentMeaning = clone(twoOccurrences) as Record<string, unknown>;
    const claimItems = (
      claimToDifferentMeaning.selection as { items: Array<Record<string, unknown>> }
    ).items;
    claimItems[1]!.meaningHash = hashAt(201);
    invalidCases.push(claimToDifferentMeaning);

    const duplicateDependencyMismatch = clone(twoOccurrences) as Record<string, unknown>;
    const dependencyItems = (
      duplicateDependencyMismatch.selection as { items: Array<Record<string, unknown>> }
    ).items;
    (dependencyItems[1]!.dependencies as Array<Record<string, unknown>>)[0]!.dependencyHash =
      hashAt(301);
    invalidCases.push(duplicateDependencyMismatch);

    const acceptedCoverageMismatch = clone(twoOccurrences) as Record<string, unknown>;
    acceptedCoverageMismatch.acceptedCoverage = 'partial';
    invalidCases.push(acceptedCoverageMismatch);

    const statementMultipleDependencies = clone(makeOccurrenceReceipt(base)) as Record<
      string,
      unknown
    >;
    const statementItem = (
      statementMultipleDependencies.selection as { items: Array<Record<string, unknown>> }
    ).items[0]!;
    statementItem.dependencies = [
      { index: 0, dependencyHash: hashAt(300) },
      { index: 1, dependencyHash: hashAt(301) },
    ];
    invalidCases.push(statementMultipleDependencies);

    for (const invalid of invalidCases)
      expect(ReceiptSchema.safeParse(invalid).success).toBe(false);
  });

  test('rejects branch-incompatible resource and policy reasons on partial occurrence coverage', () => {
    const base = makeBase();
    const acceptedReasons: string[] = [];
    for (const reason of ['lexical_token_limit', 'unit_limit', 'policy_not_selected']) {
      const receipt = makeOccurrenceReceipt(base) as Record<string, unknown>;
      receipt.interpretationCoverage = 'partial';
      receipt.acceptedCoverage = 'all';
      receipt.sourceCoverage = makeCoverage({ unresolvedReason: reason });
      if (ReceiptSchema.safeParse(receipt).success) acceptedReasons.push(reason);
    }
    expect(acceptedReasons).toEqual([]);
  });

  test('maps provider capacity, source counts and verdicts to their exact branches', () => {
    const base = makeBase();
    const policySkip = makeKnownNoMemoryReceipt(base) as Record<string, unknown>;
    policySkip.interpretationCoverage = 'unknown';
    policySkip.sourceCoverage = {
      status: 'unknown',
      scanStatus: 'complete',
      sourceUnitCount: 1,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 1,
      unresolvedReason: 'policy_not_selected',
    };
    policySkip.selection = { kind: 'source_verdict', outcome: 'policy_not_selected' };
    expect(ReceiptSchema.safeParse(policySkip).success).toBe(true);

    const tooManyUnits = clone(policySkip) as Record<string, unknown>;
    tooManyUnits.sourceCoverage = {
      ...(tooManyUnits.sourceCoverage as Record<string, unknown>),
      sourceUnitCount: 33,
      unresolvedUnitCount: 33,
      unresolvedReason: 'interpretation_capacity',
    };
    expect(ReceiptSchema.safeParse(tooManyUnits).success).toBe(false);

    const capacity = makeKnownNoMemoryReceipt(base) as Record<string, unknown>;
    capacity.kind = 'human_autonomous_source_deferred_committed';
    capacity.interpretationCoverage = 'unknown';
    capacity.sourceCoverage = {
      status: 'unknown',
      scanStatus: 'complete',
      sourceUnitCount: 33,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: 33,
      unresolvedReason: 'interpretation_capacity',
    };
    capacity.selection = { kind: 'source_only_deferred', reason: 'interpretation_capacity' };
    expect(ReceiptSchema.safeParse(capacity).success).toBe(true);

    const invalidPartialProviderFailure = clone(capacity) as Record<string, unknown>;
    invalidPartialProviderFailure.sourceCoverage = {
      ...(invalidPartialProviderFailure.sourceCoverage as Record<string, unknown>),
      sourceUnitCount: 2,
      unresolvedUnitCount: 2,
      unresolvedReason: 'provider_failure',
    };
    expect(ReceiptSchema.safeParse(invalidPartialProviderFailure).success).toBe(false);
  });

  test('validates operation states, canonical times, leases, attempts and terminal references', () => {
    const base = makeBase();
    expect(OperationSchema.safeParse(makeOperation(base)).success).toBe(true);

    const leased = {
      ...makeOperation(base),
      state: 'leased',
      generation: 1,
      lease: {
        token: uuidAt(40),
        acquiredAt: T0,
        renewedAt: T0,
        expiresAt: '2026-10-26T12:02:30.000Z',
        claimKind: 'initial',
      },
    };
    expect(OperationSchema.safeParse(leased).success).toBe(true);

    const failed = {
      ...makeOperation(base),
      state: 'failed',
      generation: 1,
      failedAt: T0,
      failureCode: 'capacity',
    };
    expect(OperationSchema.safeParse(failed).success).toBe(true);

    const interrupted = {
      ...makeOperation(base),
      state: 'interrupted',
      generation: 1,
      interruptedAt: T0,
      failureCode: 'invocation_interrupted',
    };
    expect(OperationSchema.safeParse(interrupted).success).toBe(true);

    const committed = makeCommittedOperation(base, makeKnownNoMemoryReceipt(base));
    expect(OperationSchema.safeParse(committed).success).toBe(true);

    const cancelled = {
      ...makeOperation(base),
      state: 'cancelled',
      generation: 0,
      terminalReceipt: makeCancelledReceipt(base),
    };
    expect(OperationSchema.safeParse(cancelled).success).toBe(true);

    const invalid: unknown[] = [];
    const wrongDescriptorReference = clone(makeOperation(base)) as Record<string, unknown>;
    wrongDescriptorReference.identity = {
      ...(wrongDescriptorReference.identity as Record<string, unknown>),
      descriptorHash: hashAt(999),
    };
    invalid.push(wrongDescriptorReference);

    invalid.push({ ...makeOperation(base), createdAt: '2026-10-26T12:00:00Z' });
    invalid.push({ ...makeOperation(base), lastObservedAt: '2026-10-26T11:59:59.999Z' });
    invalid.push({ ...makeOperation(base), retryCount: 1 });
    invalid.push({
      ...makeOperation(base),
      state: 'captured',
      retryCount: 1,
      lastRetryCallHash: hashAt(1),
    });
    invalid.push({
      ...makeOperation(base),
      state: 'failed',
      generation: 1,
      failedAt: '2026-10-26T12:00:01.000Z',
      failureCode: 'unknown',
    });
    invalid.push({ ...makeOperation(base), extra: true });

    const badReceiptReference = clone(committed) as Record<string, unknown>;
    (badReceiptReference.terminalReceipt as Record<string, unknown>).sourceHash = hashAt(997);
    invalid.push(badReceiptReference);

    const duplicateAttempts = {
      ...makeOperation(base),
      attempts: [
        { attemptHash: hashAt(1), at: T0, disposition: 'claim_won' },
        { attemptHash: hashAt(1), at: T0, disposition: 'legacy_unconfirmed' },
      ],
    };
    invalid.push(duplicateAttempts);

    for (const value of invalid) expect(OperationSchema.safeParse(value).success).toBe(false);
  });

  test('preserves the old V3 operation reader and rejects V3 as V4', () => {
    const { operation } = makeCompositionalCaptureFixture();
    const parsedV3 = StoredAutomaticOperationSchema.parse(operation);
    expect(parsedV3).toBe(operation);
    expect(JSON.stringify(parsedV3)).toBe(JSON.stringify(operation));
    expect(parsedV3.version).toBe(3);
    expect(OperationSchema.safeParse(operation).success).toBe(false);
  });

  test('measures the legal maximum receipt and enforces the current 32 KiB operation cap', () => {
    const medium = makeMaximumOperation(17);
    const receiptJsonBytes = Buffer.byteLength(JSON.stringify(medium.receipt), 'utf8');
    const operationJsonBytes = Buffer.byteLength(JSON.stringify(medium.operation), 'utf8');
    expect(receiptJsonBytes).toBe(15_314);
    expect(ReceiptSchema.parse(medium.receipt)).toBeDefined();
    expect(operationJsonBytes).toBeLessThanOrEqual(AUTOMATIC_LEDGER_LIMITS.operationBytes);
    expect(OperationSchema.parse(medium.operation)).toBeDefined();

    const tooLarge = makeMaximumOperation(32);
    expect(Buffer.byteLength(JSON.stringify(tooLarge.operation), 'utf8')).toBeGreaterThan(
      AUTOMATIC_LEDGER_LIMITS.operationBytes,
    );
    expect(() =>
      cloneBoundedAutomaticCaptureJson(tooLarge.operation, 'beginRequest'),
    ).not.toThrow();
    const operationSpy = jest.spyOn(AutonomousPersonalOperationV4OwnedDataSchema, 'parse');
    expectFixedError(
      OperationSchema.parse,
      tooLarge.operation,
      'invalid_autonomous_operation_data',
    );
    expect(operationSpy).not.toHaveBeenCalled();
    operationSpy.mockRestore();
  });

  test('rejects hostile raw objects without running getters, proxies, thenables or toJSON', () => {
    const base = makeBase();
    const validReceipt = makeKnownNoMemoryReceipt(base);
    const validOperation = makeOperation(base);
    let traps = 0;
    const getter = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => {
        traps += 1;
        return 4;
      },
    });
    const nestedGetterReceipt = makeOccurrenceReceipt(base) as Record<string, unknown>;
    Object.defineProperty(nestedGetterReceipt, 'sourceHash', {
      enumerable: true,
      get: () => {
        traps += 1;
        return base.identity.sourceHash;
      },
    });
    const nestedGetterOperation = makeCommittedOperation(base, makeKnownNoMemoryReceipt(base));
    Object.defineProperty(nestedGetterOperation.terminalReceipt, 'sourceHash', {
      enumerable: true,
      get: () => {
        traps += 1;
        return base.identity.sourceHash;
      },
    });
    const proxy = new Proxy(validOperation, {
      get: () => {
        traps += 1;
        return undefined;
      },
      ownKeys: () => {
        traps += 1;
        return [];
      },
    });
    const thenable = Object.defineProperty({}, 'then', {
      enumerable: true,
      get: () => {
        traps += 1;
        return undefined;
      },
    });
    const toJson = { ...validReceipt, toJSON: () => ++traps };

    expect(ReceiptSchema.safeParse(getter).success).toBe(false);
    expect(ReceiptSchema.safeParse(nestedGetterReceipt).success).toBe(false);
    expect(ReceiptSchema.safeParse(thenable).success).toBe(false);
    expect(ReceiptSchema.safeParse(toJson).success).toBe(false);
    expect(OperationSchema.safeParse(getter).success).toBe(false);
    expect(OperationSchema.safeParse(nestedGetterOperation).success).toBe(false);
    expect(OperationSchema.safeParse(proxy).success).toBe(false);
    expect(OperationSchema.safeParse(thenable).success).toBe(false);
    expect(traps).toBe(0);

    expectFixedError(ReceiptSchema.parse, getter, 'invalid_autonomous_receipt_data');
    expectFixedError(OperationSchema.parse, proxy, 'invalid_autonomous_operation_data');
  });

  test('uses fixed facade errors and preflights the nested receipt before operation Zod', () => {
    const base = makeBase();
    expectFixedError(
      ReceiptSchema.parse,
      { ...makeKnownNoMemoryReceipt(base), extra: true },
      'invalid_autonomous_receipt_data',
    );
    expectFixedError(
      OperationSchema.parse,
      { ...makeOperation(base), extra: true },
      'invalid_autonomous_operation_data',
    );

    const largeReceipt = {
      ...makeKnownNoMemoryReceipt(base),
      padding: 'x'.repeat(16_500),
    };
    expect(Buffer.byteLength(JSON.stringify(largeReceipt), 'utf8')).toBeGreaterThan(
      AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes,
    );
    const oversizedTerminal = makeCommittedOperation(base, largeReceipt as never);
    expect(Buffer.byteLength(JSON.stringify(oversizedTerminal), 'utf8')).toBeLessThan(
      AUTOMATIC_LEDGER_LIMITS.operationBytes,
    );
    const parseSpy = jest.spyOn(AutonomousPersonalOperationV4OwnedDataSchema, 'parse');
    expectFixedError(OperationSchema.parse, oversizedTerminal, 'invalid_autonomous_operation_data');
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();

    const oversizedRawReceipt = { ...makeKnownNoMemoryReceipt(base), padding: 'x'.repeat(16_000) };
    const receiptSpy = jest.spyOn(AutonomousPersonalReceiptV4OwnedDataSchema, 'parse');
    expectFixedError(ReceiptSchema.parse, oversizedRawReceipt, 'invalid_autonomous_receipt_data');
    expect(receiptSpy).not.toHaveBeenCalled();
    receiptSpy.mockRestore();
  });

  test('does not perform I/O or interpret parsed authority references', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected network access');
    });
    try {
      const base = makeBase();
      const parsed = OperationSchema.parse(makeOperation(base));
      expect(parsed.identity.requestedAuthorityHash).toBe(base.identity.requestedAuthorityHash);
      expect(parsed.identity.sourceHash).toBe(base.identity.sourceHash);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
