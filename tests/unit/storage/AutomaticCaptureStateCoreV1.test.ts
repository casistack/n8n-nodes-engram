import { ZodError } from 'zod';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import { GraphDataSchema } from '../../../src/schemas/GraphData.schema';
import {
  CompositionalAutomaticCaptureBeginRequestV3Schema,
  buildCompositionalAutomaticDescriptorForRequestV3,
  CompositionalAutomaticCaptureOperationV3Schema,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import * as compositionalV3Schemas from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import {
  compileAutonomousPersonalDescriptorV4,
  hashAutonomousPersonalDescriptorV4,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
} from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import { compileAutonomousPersonalSourceTupleV4 } from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import {
  AutomaticCaptureInitialLeaseFieldsV1OwnedDataSchema,
  type AutomaticCaptureAttemptUpdateV1,
} from '../../../src/schemas/AutomaticCaptureStateCoreV1.schema';
import { createCompositionalAutomaticCaptureHandleRegistryV3 } from '../../../src/storage/CompositionalAutomaticCaptureHandlesV3';
import {
  prepareCompositionalHumanCaptureBeginV3,
  withCompositionalCaptureAttemptV3,
} from '../../../src/storage/CompositionalAutomaticCaptureBeginV3';
import * as stateCoreModule from '../../../src/storage/AutomaticCaptureStateCoreV1';
import {
  applyAutomaticCaptureAttemptV1,
  compileAutomaticCaptureInitialLeaseFieldsV1,
} from '../../../src/storage/AutomaticCaptureStateCoreV1';
import { projectAutonomousPersonalTerminalReserveV4 } from '../../../src/storage/AutonomousPersonalTerminalReserveV4';

jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  let randomUuidIndex = 1;
  return {
    ...actual,
    randomUUID: () => {
      const suffix = randomUuidIndex.toString(16).padStart(12, '0');
      randomUuidIndex += 1;
      return `00000000-0000-4000-8000-${suffix}` as ReturnType<typeof actual.randomUUID>;
    },
    randomBytes: (size: number) => Buffer.alloc(size, 0x6b),
  };
});

const NOW = '2026-10-25T12:05:00.000Z';
const ATTEMPT = 'a'.repeat(64);
const T0 = '2026-10-26T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const hashAt = (value: number) => value.toString(16).padStart(64, '0');
const uuidAt = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const controlMax = (length: number) => '\u0001'.repeat(length - 1) + 'x';

function expectFixedError(invoke: () => unknown, code: string, sentinel?: string): void {
  let caught: unknown;
  try {
    invoke();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ZodError);
  const error = caught as ZodError;
  expect(error.issues).toHaveLength(1);
  expect(error.issues[0]).toMatchObject({ code: 'custom', path: [], message: code });
  expect(error.message).not.toContain(sentinel ?? 'private-state-core-sentinel');
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(Object.isFrozen(error.issues[0])).toBe(true);
  expect(Object.isFrozen(error.issues[0]?.path)).toBe(true);
}

function makeMaximumV4Descriptor() {
  return compileAutonomousPersonalDescriptorV4({
    profileId: 'reviewFirst',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    invocationDeadlineMs: 120_000,
    providerReference: {
      routeId: controlMax(128),
      configurationFingerprint: HASH,
      protocol: 'openai-compatible-json-v1',
      configuredRequestLimit: 256,
      configuredTimeoutMs: Number.MAX_SAFE_INTEGER,
      configuredRequestBytes: Number.MAX_SAFE_INTEGER,
      configuredResponseBytes: Number.MAX_SAFE_INTEGER,
      temperature: { mode: 'custom', value: 0.12345678901234568 },
      responseFormat: 'json_object',
      outputTokenLimit: { mode: 'omit' },
    },
  });
}

function makeMaximumV4Operation(attemptCount = 0) {
  const descriptor = makeMaximumV4Descriptor();
  const namespace = controlMax(128);
  const tuple = compileAutonomousPersonalSourceTupleV4({
    scope: {
      storeHash: HASH,
      namespace,
      issuer: controlMax(256),
      actorReference: controlMax(512),
      turn: controlMax(512),
      binding: {
        bindingId: uuidAt(1),
        revision: AUTOMATIC_LEDGER_LIMITS.maxGeneration,
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
  const attempts = Array.from({ length: attemptCount }, (_, index) =>
    AutomaticOperationAttemptSchema.parse({
      attemptHash: hashAt(index + 1000),
      at: T0,
      disposition: index === 0 ? 'claim_won' : 'legacy_unconfirmed',
    }),
  );
  return AutonomousPersonalOperationV4OwnedDataSchema.parse({
    version: 4,
    operationId: uuidAt(10),
    identity: tuple.identity,
    descriptor,
    createdAt: T0,
    lastObservedAt: T0,
    attempts,
    overflowCount: AUTOMATIC_LEDGER_LIMITS.overflowCounterMax,
    auditTruncated: false,
    beginCallHash: hashAt(400),
    lastResumeCause: 'lease_expired',
    retryCount: 3,
    lastRetryCallHash: hashAt(401),
    state: 'failed',
    generation: AUTOMATIC_LEDGER_LIMITS.maxGeneration,
    failedAt: T0,
    failureCode: 'storage_error',
  });
}

function makeV4CommittedOperation(attemptCount: number) {
  const base = makeMaximumV4Operation(attemptCount);
  if (base.state !== 'failed') throw new Error('Expected failed V4 fixture');
  const receipt = AutonomousPersonalReceiptV4OwnedDataSchema.parse({
    version: 4,
    kind: 'human_autonomous_source_verdict_committed',
    operationId: base.operationId,
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
  });
  const { failedAt: _failedAt, failureCode: _failureCode, state: _state, ...common } = base;
  void _failedAt;
  void _failureCode;
  void _state;
  return AutonomousPersonalOperationV4OwnedDataSchema.parse({
    ...common,
    state: 'committed',
    terminalReceipt: receipt,
    completionCallHash: hashAt(402),
  });
}

function resultOperation(result: AutomaticCaptureAttemptUpdateV1) {
  if (result.kind !== 'updated') throw new Error(`Expected update, got ${result.kind}`);
  return result.operation;
}

function makeGoldenBegin() {
  const fixture = makeCompositionalCaptureFixture();
  const graph = GraphDataSchema.parse({
    ...fixture.graph,
    automatic_operations_v1: { version: 1, operations: [fixture.operation] },
  });
  const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
    ...fixture.input.request,
    turn: 'stage2-v3-golden-turn',
    attemptIdHash: ATTEMPT,
    source: {
      ...fixture.input.request.source,
      content: 'I prefer concise explanations.',
      sourceMessageId: 'stage2-v3-golden-message',
      conversationId: 'stage2-v3-golden-conversation',
      senderId: 'stage2-v3-golden-sender',
      senderName: 'Synthetic sender',
      sourceWorkflowId: 'stage2-v3-golden-workflow',
      originalSourceExecutionId: 'stage2-v3-golden-execution',
    },
  });
  const descriptor = buildCompositionalAutomaticDescriptorForRequestV3(request);
  const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
  const begin = registry.startInitialBegin(request.attemptIdHash, descriptor.descriptor);
  const context = {
    storeHash: fixture.input.storeHash,
    backendNow: NOW,
    previousEpisodeId: fixture.source.uuid,
  };
  const initial = prepareCompositionalHumanCaptureBeginV3(
    graph,
    request,
    context,
    begin.scope,
    registry,
    () => {},
  );
  if (initial.kind !== 'prepared_claim') throw new Error('Expected a V3 claim');
  const operation = initial.graph.automatic_operations_v1?.operations.find(
    (row) => row.version === 3 && row.identity.turn === request.turn,
  );
  if (!operation || operation.version !== 3) throw new Error('Expected a V3 operation');
  return { fixture, graph, request, context, registry, begin, initial, operation };
}

describe('shared automatic-capture state DATA core', () => {
  it('freezes the pre-refactor V3 initial-operation and same-scope replay golden', () => {
    const value = makeGoldenBegin();
    const leaseDurationMs = Math.min(
      AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
      Math.max(
        AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
        value.operation.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      ),
    );
    const legacyInitialAttempt = AutomaticOperationAttemptSchema.parse({
      attemptHash: value.request.attemptIdHash,
      at: value.context.backendNow,
      disposition: 'claim_won',
    });
    const legacyOperation = CompositionalAutomaticCaptureOperationV3Schema.parse({
      version: 3,
      operationId: value.begin.operationId,
      identity: value.operation.identity,
      descriptor: value.operation.descriptor,
      createdAt: value.context.backendNow,
      lastObservedAt: value.context.backendNow,
      attempts: [legacyInitialAttempt],
      overflowCount: 0,
      auditTruncated: false,
      beginCallHash: value.begin.beginCallHash,
      retryCount: 0,
      state: 'leased',
      generation: 1,
      lease: {
        token: value.begin.leaseToken,
        acquiredAt: value.context.backendNow,
        renewedAt: value.context.backendNow,
        expiresAt: new Date(Date.parse(value.context.backendNow) + leaseDurationMs).toISOString(),
        claimKind: 'initial',
      },
    });
    expect(JSON.stringify(value.operation)).toBe(JSON.stringify(legacyOperation));
    expect(value.operation.identity.sourceHash).toBe(
      '704b58a18463f267487654dd77386b7a2a890a844a9b1d5961f1c18b9a231845',
    );
    expect(value.operation.identity.descriptorHash).toBe(
      '5a4cd8c86ba6de128ee12d521e64e7adf77e8cde83f6299f57779f41ec95a667',
    );
    expect(value.initial.leaseFence.identityHash).toBe(
      '64bc47ca66fd89f133aabce41fba9758010dec703a146851d6d59ba9a06ee887',
    );
    expect({
      operation: value.operation,
      leaseFence: value.initial.leaseFence,
      writeRequired: value.initial.writeRequired,
    }).toMatchSnapshot();

    const replay = prepareCompositionalHumanCaptureBeginV3(
      value.initial.graph,
      value.request,
      { ...value.context, backendNow: '2026-10-25T12:05:01.000Z' },
      value.begin.scope,
      value.registry,
      () => {},
    );
    expect(replay.kind).toBe('prepared_claim');
    if (replay.kind !== 'prepared_claim') return;
    expect(replay.writeRequired).toBe(false);
    expect(replay.graph).toEqual(value.initial.graph);
    expect(replay.leaseFence).toEqual(value.initial.leaseFence);
  });

  it('keeps a deterministic complete V3 operation schema fixture available to state tests', () => {
    const value = makeGoldenBegin();
    expect(CompositionalAutomaticCaptureOperationV3Schema.parse(value.operation)).toEqual(
      value.operation,
    );
  });

  it('compiles only the closed initial lease fragment with the existing duration formula', () => {
    const minimum = compileAutomaticCaptureInitialLeaseFieldsV1({
      createdAt: T0,
      invocationDeadlineMs: AUTOMATIC_LEDGER_LIMITS.minInvocationDeadlineMs,
      beginCallHash: HASH,
      leaseToken: uuidAt(50),
      initialAttemptHash: hashAt(51),
    });
    expect(minimum).toEqual({
      createdAt: T0,
      lastObservedAt: T0,
      attempts: [{ attemptHash: hashAt(51), at: T0, disposition: 'claim_won' }],
      overflowCount: 0,
      auditTruncated: false,
      beginCallHash: HASH,
      retryCount: 0,
      state: 'leased',
      generation: 1,
      lease: {
        token: uuidAt(50),
        acquiredAt: T0,
        renewedAt: T0,
        expiresAt: '2026-10-26T12:01:00.000Z',
        claimKind: 'initial',
      },
    });
    expect(
      compileAutomaticCaptureInitialLeaseFieldsV1({
        createdAt: T0,
        invocationDeadlineMs: AUTOMATIC_LEDGER_LIMITS.maxInvocationDeadlineMs,
        beginCallHash: HASH,
        leaseToken: uuidAt(50),
        initialAttemptHash: hashAt(51),
      }).lease.expiresAt,
    ).toBe('2026-10-26T12:02:30.000Z');
    expect(Object.isFrozen(minimum)).toBe(true);
    expect(Object.isFrozen(minimum.lease)).toBe(true);
    expect(Object.isFrozen(minimum.attempts)).toBe(true);
    expect(AutomaticCaptureInitialLeaseFieldsV1OwnedDataSchema.parse(minimum)).toEqual(minimum);
    expect(Object.keys(minimum).sort()).toEqual([
      'attempts',
      'auditTruncated',
      'beginCallHash',
      'createdAt',
      'generation',
      'lastObservedAt',
      'lease',
      'overflowCount',
      'retryCount',
      'state',
    ]);
  });

  it('owns initial-field input before Zod and emits one fixed frozen failure', () => {
    const sentinel = 'private-state-core-sentinel';
    let invoked = 0;
    const getter = Object.defineProperty({}, 'createdAt', {
      enumerable: true,
      get: () => {
        invoked += 1;
        throw new Error(sentinel);
      },
    });
    const proxy = new Proxy(
      {
        createdAt: T0,
        invocationDeadlineMs: 30_000,
        beginCallHash: HASH,
        leaseToken: uuidAt(50),
        initialAttemptHash: hashAt(51),
      },
      { get: () => ++invoked },
    );
    const invalid = {
      createdAt: T0,
      invocationDeadlineMs: 30_000,
      beginCallHash: HASH,
      leaseToken: uuidAt(50),
      initialAttemptHash: hashAt(51),
      extra: 'reject',
    };
    const cycle: Record<string, unknown> = { ...invalid };
    cycle['cycle'] = cycle;
    for (const input of [getter, proxy, cycle, { ...invalid, createdAt: '2026-10-26T12:00:00Z' }]) {
      expectFixedError(
        () => compileAutomaticCaptureInitialLeaseFieldsV1(input),
        'invalid_automatic_capture_initial_lease_data',
        sentinel,
      );
    }
    expect(invoked).toBe(0);
  });

  it('applies a complete V3 candidate without changing non-audit fields', () => {
    const { operation } = makeGoldenBegin();
    const observation = {
      attemptHash: hashAt(90),
      at: '2026-10-25T12:05:01.000Z',
      disposition: 'in_progress' as const,
    };
    const before = JSON.parse(JSON.stringify(operation)) as Record<string, unknown>;
    const result = applyAutomaticCaptureAttemptV1({
      familyVersion: 3,
      operation,
      observation,
    });
    expect(result.kind).toBe('updated');
    const updated = resultOperation(result);
    expect(updated.version).toBe(3);
    expect(updated.identity).toEqual(operation.identity);
    expect(updated.descriptor).toEqual(operation.descriptor);
    expect(updated.attempts).toHaveLength(2);
    expect(updated.attempts[1]).toEqual(observation);
    expect(updated.lastObservedAt).toBe(observation.at);
    const { attempts: _attempts, lastObservedAt: _lastObservedAt, ...beforeNonAudit } = before;
    const {
      attempts: _updatedAttempts,
      lastObservedAt: _updatedLastObservedAt,
      ...updatedNonAudit
    } = updated;
    void _attempts;
    void _lastObservedAt;
    void _updatedAttempts;
    void _updatedLastObservedAt;
    expect(updatedNonAudit).toEqual(beforeNonAudit);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(updated.identity)).toBe(true);
  });

  it('keeps V3 duplicate/truncated no-op and exact 32-row truncation semantics', () => {
    const { operation } = makeGoldenBegin();
    const duplicate = applyAutomaticCaptureAttemptV1({
      familyVersion: 3,
      operation,
      observation: {
        attemptHash: operation.attempts[0]!.attemptHash,
        at: '2026-10-25T12:05:01.000Z',
        disposition: 'in_progress',
      },
    });
    expect(duplicate).toEqual({ kind: 'same', familyVersion: 3 });

    const attempts = [
      operation.attempts[0]!,
      ...Array.from({ length: 31 }, (_, index) =>
        AutomaticOperationAttemptSchema.parse({
          attemptHash: hashAt(index + 200),
          at: NOW,
          disposition: 'legacy_unconfirmed',
        }),
      ),
    ];
    const full = CompositionalAutomaticCaptureOperationV3Schema.parse({
      ...operation,
      attempts,
    });
    const truncated = applyAutomaticCaptureAttemptV1({
      familyVersion: 3,
      operation: full,
      observation: {
        attemptHash: hashAt(500),
        at: '2026-10-25T12:05:01.000Z',
        disposition: 'in_progress',
      },
    });
    const truncatedOperation = resultOperation(truncated);
    expect(truncatedOperation.attempts).toEqual(full.attempts);
    expect(truncatedOperation.auditTruncated).toBe(true);
    expect(truncatedOperation.overflowCount).toBe(full.overflowCount);
    expect(truncatedOperation.lastObservedAt).toBe('2026-10-25T12:05:01.000Z');

    const replayAfterTruncation = applyAutomaticCaptureAttemptV1({
      familyVersion: 3,
      operation: truncatedOperation,
      observation: {
        attemptHash: hashAt(501),
        at: '2026-10-25T12:05:02.000Z',
        disposition: 'in_progress',
      },
    });
    expect(replayAfterTruncation).toEqual({ kind: 'same', familyVersion: 3 });
    const regression = applyAutomaticCaptureAttemptV1({
      familyVersion: 3,
      operation,
      observation: {
        attemptHash: hashAt(502),
        at: '2026-10-25T12:04:59.000Z',
        disposition: 'in_progress',
      },
    });
    expect(regression).toEqual({ kind: 'not_updated', familyVersion: 3 });
  });

  it('preserves V3 helper check positions and original operation reference on duplicate audit', () => {
    const value = makeGoldenBegin();
    const helper = jest.spyOn(stateCoreModule, 'applyAutomaticCaptureAttemptV1');
    const check = jest.fn();
    try {
      const duplicate = withCompositionalCaptureAttemptV3(
        value.operation,
        value.begin.audit,
        '2026-10-25T12:05:01.000Z',
        'in_progress',
        value.registry,
        check,
      );
      expect(duplicate).toBe(value.operation);
      expect(check).toHaveBeenCalledTimes(2);
      expect(helper).not.toHaveBeenCalled();

      check.mockClear();
      const candidateRegistry = createCompositionalAutomaticCaptureHandleRegistryV3();
      const candidateBegin = candidateRegistry.startInitialBegin(
        hashAt(800),
        value.operation.descriptor,
      );
      const updated = withCompositionalCaptureAttemptV3(
        value.operation,
        candidateBegin.audit,
        '2026-10-25T12:05:01.000Z',
        'in_progress',
        candidateRegistry,
        check,
      );
      expect(updated).not.toBeNull();
      expect(check).toHaveBeenCalledTimes(3);
      expect(helper).toHaveBeenCalledTimes(1);
    } finally {
      helper.mockRestore();
    }
  });

  it('runs V3 check three after helper success or fixed DATA failure and propagates invalidation', () => {
    const value = makeGoldenBegin();
    const sentinel = new Error('Engram compositional capture: budget_exhausted');
    const realApply = applyAutomaticCaptureAttemptV1;
    const candidateRegistry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const candidateBegin = candidateRegistry.startInitialBegin(
      hashAt(801),
      value.operation.descriptor,
    );
    const helper = jest.spyOn(stateCoreModule, 'applyAutomaticCaptureAttemptV1');
    let invalidated = false;
    const check = jest.fn(() => {
      if (invalidated) throw sentinel;
    });
    try {
      helper.mockImplementation((input) => {
        const output = realApply(input);
        invalidated = true;
        return output;
      });
      expect(() =>
        withCompositionalCaptureAttemptV3(
          value.operation,
          candidateBegin.audit,
          '2026-10-25T12:05:01.000Z',
          'in_progress',
          candidateRegistry,
          check,
        ),
      ).toThrow(sentinel);
      expect(check).toHaveBeenCalledTimes(3);

      helper.mockImplementation(() => {
        invalidated = true;
        return realApply({});
      });
      check.mockClear();
      invalidated = false;
      expect(() =>
        withCompositionalCaptureAttemptV3(
          value.operation,
          candidateBegin.audit,
          '2026-10-25T12:05:01.000Z',
          'in_progress',
          candidateRegistry,
          check,
        ),
      ).toThrow(sentinel);
      expect(check).toHaveBeenCalledTimes(3);

      helper.mockImplementation(() => realApply({}));
      invalidated = false;
      check.mockClear();
      expect(
        withCompositionalCaptureAttemptV3(
          value.operation,
          candidateBegin.audit,
          '2026-10-25T12:05:01.000Z',
          'in_progress',
          candidateRegistry,
          check,
        ),
      ).toBeNull();
      expect(check).toHaveBeenCalledTimes(3);

      helper.mockImplementation(() => {
        throw sentinel;
      });
      check.mockClear();
      expect(() =>
        withCompositionalCaptureAttemptV3(
          value.operation,
          candidateBegin.audit,
          '2026-10-25T12:05:01.000Z',
          'in_progress',
          candidateRegistry,
          check,
        ),
      ).toThrow(sentinel);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      helper.mockRestore();
    }
  });

  it('rejects hostile, cross-family, unknown, and oversized attempt wrappers uniformly', () => {
    const { operation } = makeGoldenBegin();
    const valid = {
      familyVersion: 3,
      operation,
      observation: {
        attemptHash: hashAt(600),
        at: '2026-10-25T12:05:01.000Z',
        disposition: 'in_progress',
      },
    };
    const sentinel = 'private-state-core-sentinel';
    let invoked = 0;
    const getter = Object.defineProperty({}, 'familyVersion', {
      enumerable: true,
      get: () => {
        invoked += 1;
        throw new Error(sentinel);
      },
    });
    const proxy = new Proxy(valid, { get: () => ++invoked });
    const cycle: Record<string, unknown> = { ...valid };
    cycle['cycle'] = cycle;
    for (const input of [
      getter,
      proxy,
      cycle,
      { familyVersion: 3, observation: valid.observation },
      { ...valid, unexpected: true },
      { ...valid, familyVersion: 5 },
      { ...valid, operation: makeMaximumV4Operation(0) },
      { ...valid, operation: { padding: 'x'.repeat(AUTOMATIC_LEDGER_LIMITS.operationBytes) } },
    ]) {
      expectFixedError(
        () => applyAutomaticCaptureAttemptV1(input),
        'invalid_autonomous_capture_attempt_data',
        sentinel,
      );
    }
    expect(invoked).toBe(0);
  });

  it('uses the V4 reserve dynamically and falls back without losing a legal prefix', () => {
    const empty = makeMaximumV4Operation(0);
    const appended = applyAutomaticCaptureAttemptV1({
      familyVersion: 4,
      operation: empty,
      observation: {
        attemptHash: hashAt(699),
        at: T0,
        disposition: 'resume_available',
      },
    });
    const appendedOperation = resultOperation(appended);
    expect(appendedOperation.attempts).toHaveLength(1);
    expect(appendedOperation.attempts[0]?.attemptHash).toBe(hashAt(699));
    expect(projectAutonomousPersonalTerminalReserveV4(appendedOperation).withinLimit).toBe(true);

    const sixteen = makeMaximumV4Operation(16);
    const seventeen = makeMaximumV4Operation(17);
    expect(projectAutonomousPersonalTerminalReserveV4(sixteen).withinLimit).toBe(true);
    expect(projectAutonomousPersonalTerminalReserveV4(seventeen).withinLimit).toBe(false);

    const result = applyAutomaticCaptureAttemptV1({
      familyVersion: 4,
      operation: sixteen,
      observation: {
        attemptHash: hashAt(700),
        at: T0,
        disposition: 'resume_available',
      },
    });
    const updated = resultOperation(result);
    expect(updated.version).toBe(4);
    expect(updated.attempts).toEqual(sixteen.attempts);
    expect(updated.auditTruncated).toBe(true);
    expect(updated.overflowCount).toBe(sixteen.overflowCount);
    expect(updated.identity).toEqual(sixteen.identity);
    expect(updated.descriptor).toEqual(sixteen.descriptor);
    expect(projectAutonomousPersonalTerminalReserveV4(updated).withinLimit).toBe(true);

    const noReserve = applyAutomaticCaptureAttemptV1({
      familyVersion: 4,
      operation: seventeen,
      observation: {
        attemptHash: hashAt(701),
        at: T0,
        disposition: 'resume_available',
      },
    });
    expect(noReserve).toEqual({ kind: 'not_updated', familyVersion: 4 });
  });

  it('validates updated operation output only with the selected family schema', () => {
    const operation = makeMaximumV4Operation(0);
    const parseV3 = jest.spyOn(
      compositionalV3Schemas.CompositionalAutomaticCaptureOperationV3Schema,
      '_parse',
    );
    try {
      const result = applyAutomaticCaptureAttemptV1({
        familyVersion: 4,
        operation,
        observation: {
          attemptHash: hashAt(702),
          at: T0,
          disposition: 'resume_available',
        },
      });
      expect(result.kind).toBe('updated');
      expect(parseV3).not.toHaveBeenCalled();
    } finally {
      parseV3.mockRestore();
    }
  });

  it('updates a full terminal V4 audit prefix without applying active-state reserve projection', () => {
    const operation = makeV4CommittedOperation(32);
    if (operation.state !== 'committed') throw new Error('Expected committed V4 fixture');
    expect(Buffer.byteLength(JSON.stringify(operation), 'utf8')).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(operation), 'utf8')).toBeLessThanOrEqual(
      AUTOMATIC_LEDGER_LIMITS.operationBytes,
    );
    const result = applyAutomaticCaptureAttemptV1({
      familyVersion: 4,
      operation,
      observation: {
        attemptHash: hashAt(900),
        at: T0,
        disposition: 'committed_replay',
      },
    });
    const updated = resultOperation(result);
    if (updated.version !== 4 || updated.state !== 'committed') {
      throw new Error('Expected committed V4 update');
    }
    expect(updated.attempts).toEqual(operation.attempts);
    expect(updated.auditTruncated).toBe(true);
    expect(updated.terminalReceipt).toEqual(operation.terminalReceipt);
  });

  it('appends terminal V4 replay rows without changing the immutable receipt', () => {
    const operation = makeV4CommittedOperation(31);
    if (operation.state !== 'committed') throw new Error('Expected committed V4 fixture');
    const result = applyAutomaticCaptureAttemptV1({
      familyVersion: 4,
      operation,
      observation: {
        attemptHash: hashAt(901),
        at: T0,
        disposition: 'committed_replay',
      },
    });
    const updated = resultOperation(result);
    if (updated.version !== 4 || updated.state !== 'committed') {
      throw new Error('Expected committed V4 update');
    }
    expect(updated.attempts).toHaveLength(32);
    expect(updated.attempts[31]?.attemptHash).toBe(hashAt(901));
    expect(updated.terminalReceipt).toEqual(operation.terminalReceipt);
    expect(updated.auditTruncated).toBe(false);
  });
});
