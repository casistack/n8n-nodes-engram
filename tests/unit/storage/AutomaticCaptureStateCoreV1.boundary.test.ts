import { ZodError } from 'zod';
import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
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
import { AutomaticCaptureAttemptWrapperV1OwnedDataSchema } from '../../../src/schemas/AutomaticCaptureStateCoreV1.schema';
import { createCompositionalAutomaticCaptureHandleRegistryV3 } from '../../../src/storage/CompositionalAutomaticCaptureHandlesV3';
import { withCompositionalCaptureAttemptV3 } from '../../../src/storage/CompositionalAutomaticCaptureBeginV3';
import * as stateCore from '../../../src/storage/AutomaticCaptureStateCoreV1';
import { applyAutomaticCaptureAttemptV1 } from '../../../src/storage/AutomaticCaptureStateCoreV1';
import * as terminalReserve from '../../../src/storage/AutonomousPersonalTerminalReserveV4';

const T0 = '2026-10-26T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const hashAt = (value: number) => value.toString(16).padStart(64, '0');
const uuidAt = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const controlMax = (length: number) => '\u0001'.repeat(length - 1) + 'x';

function expectFixedAttemptError(invoke: () => unknown, sentinel?: string): ZodError {
  let caught: unknown;
  try {
    invoke();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ZodError);
  const error = caught as ZodError;
  expect(error.issues).toHaveLength(1);
  expect(error.issues[0]).toMatchObject({
    code: 'custom',
    path: [],
    message: 'invalid_autonomous_capture_attempt_data',
  });
  expect(error.message).not.toContain(sentinel ?? 'private-state-core-boundary-sentinel');
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(Object.isFrozen(error.issues[0])).toBe(true);
  expect(Object.isFrozen(error.issues[0]?.path)).toBe(true);
  return error;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function makeV3LeasedOperation() {
  const fixture = makeCompositionalCaptureFixture();
  const createdAt = fixture.graph.exported_at;
  const duration = Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      fixture.operation.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
    ),
  );
  return CompositionalAutomaticCaptureOperationV3Schema.parse({
    ...fixture.operation,
    createdAt,
    lastObservedAt: createdAt,
    attempts: [
      AutomaticOperationAttemptSchema.parse({
        attemptHash: hashAt(1),
        at: createdAt,
        disposition: 'claim_won',
      }),
    ],
    overflowCount: 0,
    auditTruncated: false,
    retryCount: 0,
    state: 'leased',
    generation: 1,
    lease: {
      token: uuidAt(2),
      acquiredAt: createdAt,
      renewedAt: createdAt,
      expiresAt: new Date(Date.parse(createdAt) + duration).toISOString(),
      claimKind: 'initial',
    },
  });
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
        bindingId: uuidAt(10),
        revision: AUTOMATIC_LEDGER_LIMITS.maxGeneration,
        subjectId: uuidAt(11),
        fingerprint: 'b'.repeat(64),
      },
    },
    descriptor,
    producer: {
      uuid: uuidAt(12),
      group_id: namespace,
      content: 'Synthetic bounded source.',
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
      attemptHash: hashAt(index + 100),
      at: T0,
      disposition: index === 0 ? 'claim_won' : 'legacy_unconfirmed',
    }),
  );
  return AutonomousPersonalOperationV4OwnedDataSchema.parse({
    version: 4,
    operationId: uuidAt(13),
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

function makeCommittedV4Operation(attemptCount: number) {
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
  const operation = AutonomousPersonalOperationV4OwnedDataSchema.parse({
    ...common,
    state: 'committed',
    terminalReceipt: receipt,
    completionCallHash: hashAt(402),
  });
  if (operation.state !== 'committed') throw new Error('Expected committed V4 fixture');
  return operation;
}

describe('automatic capture state core raw boundary and family invariants', () => {
  test('owns raw wrappers before schemas and rejects accessors, proxies, cycles, prototypes and raw over-cap input', () => {
    const parseWrapper = jest.spyOn(AutomaticCaptureAttemptWrapperV1OwnedDataSchema, '_parse');
    const parseV3 = jest.spyOn(
      compositionalV3Schemas.CompositionalAutomaticCaptureOperationV3Schema,
      '_parse',
    );
    const sentinel = 'private-state-core-boundary-sentinel';
    let callbacks = 0;
    const getter = Object.defineProperty({}, 'familyVersion', {
      enumerable: true,
      get: () => {
        callbacks += 1;
        throw new Error(sentinel);
      },
    });
    const proxy = new Proxy(
      { familyVersion: 3, operation: {}, observation: {} },
      { get: () => (callbacks += 1) },
    );
    const cycle: Record<string, unknown> = {
      familyVersion: 3,
      operation: {},
      observation: {},
    };
    cycle['cycle'] = cycle;
    const customPrototype = Object.create({ synthetic: true }) as Record<string, unknown>;
    Object.assign(customPrototype, { familyVersion: 3, operation: {}, observation: {} });
    const oversized = {
      familyVersion: 3,
      operation: { padding: 'x'.repeat(512 * 1024) },
      observation: {},
    };

    for (const input of [getter, proxy, cycle, customPrototype, oversized]) {
      expectFixedAttemptError(() => applyAutomaticCaptureAttemptV1(input), sentinel);
    }
    expect(callbacks).toBe(0);
    expect(parseWrapper).not.toHaveBeenCalled();
    expect(parseV3).not.toHaveBeenCalled();
    parseWrapper.mockRestore();
    parseV3.mockRestore();
  });

  test('checks the serialized operation cap before invoking either family operation schema', () => {
    const parseWrapper = jest.spyOn(AutomaticCaptureAttemptWrapperV1OwnedDataSchema, '_parse');
    const parseV3 = jest.spyOn(
      compositionalV3Schemas.CompositionalAutomaticCaptureOperationV3Schema,
      '_parse',
    );
    const parseV4 = jest.spyOn(AutonomousPersonalOperationV4OwnedDataSchema, '_parse');
    const input = {
      familyVersion: 3,
      operation: { padding: 'x'.repeat(AUTOMATIC_LEDGER_LIMITS.operationBytes) },
      observation: {
        attemptHash: hashAt(900),
        at: T0,
        disposition: 'in_progress',
      },
    };

    expectFixedAttemptError(() => applyAutomaticCaptureAttemptV1(input));
    expect(parseWrapper).toHaveBeenCalledTimes(1);
    expect(parseV3).not.toHaveBeenCalled();
    expect(parseV4).not.toHaveBeenCalled();
    parseWrapper.mockRestore();
    parseV3.mockRestore();
    parseV4.mockRestore();
  });

  test.each(['name', 'prototype'] as const)(
    'does not invoke fake-constructor %s accessors',
    (property) => {
      let callbacks = 0;
      const prototype = Object.create(null) as Record<string, unknown>;
      const constructor = () => undefined;
      Object.defineProperty(constructor, 'name', { value: 'Object', configurable: true });
      Object.defineProperty(constructor, property, {
        get: () => {
          callbacks += 1;
          return property === 'name' ? 'Object' : prototype;
        },
      });
      Object.defineProperty(prototype, 'constructor', { value: constructor });
      const fakeRealm = Object.create(prototype) as Record<string, unknown>;
      Object.assign(fakeRealm, {
        familyVersion: 3,
        operation: {},
        observation: {},
      });
      const parseWrapper = jest.spyOn(AutomaticCaptureAttemptWrapperV1OwnedDataSchema, '_parse');
      expectFixedAttemptError(() => applyAutomaticCaptureAttemptV1(fakeRealm));
      expect(callbacks).toBe(0);
      expect(parseWrapper).not.toHaveBeenCalled();
      parseWrapper.mockRestore();
    },
  );

  test('rejects own reserved prototype keys without mutating the raw wrapper', () => {
    const input = JSON.parse(
      '{"familyVersion":3,"operation":{},"observation":{},"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const beforePrototype = Object.getPrototypeOf(input);
    expect(Object.prototype.hasOwnProperty.call(input, '__proto__')).toBe(true);
    expectFixedAttemptError(() => applyAutomaticCaptureAttemptV1(input));
    expect(Object.getPrototypeOf(input)).toBe(beforePrototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test('dispatches an exact complete Operation3 or Operation4 only to its own schema', () => {
    const operation3 = makeV3LeasedOperation();
    const operation4 = makeMaximumV4Operation(0);
    const parseV3 = jest.spyOn(
      compositionalV3Schemas.CompositionalAutomaticCaptureOperationV3Schema,
      '_parse',
    );
    const parseV4 = jest.spyOn(AutonomousPersonalOperationV4OwnedDataSchema, '_parse');
    try {
      const updated4 = applyAutomaticCaptureAttemptV1({
        familyVersion: 4,
        operation: operation4,
        observation: {
          attemptHash: hashAt(901),
          at: T0,
          disposition: 'resume_available',
        },
      });
      expect(updated4.kind).toBe('updated');
      if (updated4.kind !== 'updated' || updated4.operation.version !== 4) {
        throw new Error('Expected Operation4 update');
      }
      expect(updated4.operation.attempts).toHaveLength(1);
      const { attempts: _attempts4, lastObservedAt: _observed4, ...beforeNonAudit4 } = operation4;
      const {
        attempts: _updatedAttempts4,
        lastObservedAt: _updatedObserved4,
        ...updatedNonAudit4
      } = updated4.operation;
      void _attempts4;
      void _observed4;
      void _updatedAttempts4;
      void _updatedObserved4;
      expect(updatedNonAudit4).toEqual(beforeNonAudit4);
      expectDeepFrozen(updated4);
      expect(parseV3).not.toHaveBeenCalled();
      expect(parseV4).toHaveBeenCalled();

      parseV3.mockClear();
      parseV4.mockClear();
      const updated3 = applyAutomaticCaptureAttemptV1({
        familyVersion: 3,
        operation: operation3,
        observation: {
          attemptHash: hashAt(902),
          at: '2026-10-25T12:00:01.000Z',
          disposition: 'in_progress',
        },
      });
      expect(updated3.kind).toBe('updated');
      if (updated3.kind !== 'updated' || updated3.operation.version !== 3) {
        throw new Error('Expected Operation3 update');
      }
      const { attempts: _attempts3, lastObservedAt: _observed3, ...beforeNonAudit3 } = operation3;
      const {
        attempts: _updatedAttempts3,
        lastObservedAt: _updatedObserved3,
        ...updatedNonAudit3
      } = updated3.operation;
      void _attempts3;
      void _observed3;
      void _updatedAttempts3;
      void _updatedObserved3;
      expect(updatedNonAudit3).toEqual(beforeNonAudit3);
      expectDeepFrozen(updated3);
      expect(parseV3).toHaveBeenCalled();
      expect(parseV4).not.toHaveBeenCalled();
    } finally {
      parseV3.mockRestore();
      parseV4.mockRestore();
    }
  });

  test('returns independent deeply frozen updates and preserves complete operations on duplicate no-op', () => {
    const operation3 = makeV3LeasedOperation();
    const before3 = JSON.stringify(operation3);
    const updated3 = applyAutomaticCaptureAttemptV1({
      familyVersion: 3,
      operation: operation3,
      observation: {
        attemptHash: hashAt(903),
        at: '2026-10-25T12:00:01.000Z',
        disposition: 'in_progress',
      },
    });
    expect(updated3.kind).toBe('updated');
    expectDeepFrozen(updated3);
    expect(JSON.stringify(operation3)).toBe(before3);
    if (updated3.kind !== 'updated') throw new Error('Expected Operation3 update');
    expect(updated3.operation).not.toBe(operation3);
    expect(updated3.operation.attempts).not.toBe(operation3.attempts);

    const duplicate3 = applyAutomaticCaptureAttemptV1({
      familyVersion: 3,
      operation: operation3,
      observation: {
        attemptHash: operation3.attempts[0]!.attemptHash,
        at: '2026-10-25T12:00:01.000Z',
        disposition: 'in_progress',
      },
    });
    expect(duplicate3).toEqual({ kind: 'same', familyVersion: 3 });
    expect(JSON.stringify(operation3)).toBe(before3);

    const operation4 = makeMaximumV4Operation(1);
    const before4 = JSON.stringify(operation4);
    const duplicate4 = applyAutomaticCaptureAttemptV1({
      familyVersion: 4,
      operation: operation4,
      observation: {
        attemptHash: operation4.attempts[0]!.attemptHash,
        at: T0,
        disposition: 'resume_available',
      },
    });
    expect(duplicate4).toEqual({ kind: 'same', familyVersion: 4 });
    expect(JSON.stringify(operation4)).toBe(before4);
  });

  test('uses the active reserve at 16 rows and refuses the same append at 17', () => {
    const projector = jest.spyOn(terminalReserve, 'projectAutonomousPersonalTerminalReserveV4');
    try {
      const sixteen = makeMaximumV4Operation(16);
      const before = JSON.stringify(sixteen);
      const result16 = applyAutomaticCaptureAttemptV1({
        familyVersion: 4,
        operation: sixteen,
        observation: {
          attemptHash: hashAt(920),
          at: T0,
          disposition: 'resume_available',
        },
      });
      expect(result16.kind).toBe('updated');
      if (result16.kind !== 'updated' || result16.operation.version !== 4) {
        throw new Error('Expected Operation4 reserve fallback');
      }
      expect(result16.operation.attempts).toEqual(sixteen.attempts);
      expect(result16.operation.auditTruncated).toBe(true);
      const {
        attempts: _attempts16,
        lastObservedAt: _observed16,
        auditTruncated: _truncated16,
        ...beforeNonAudit16
      } = sixteen;
      const {
        attempts: _updatedAttempts16,
        lastObservedAt: _updatedObserved16,
        auditTruncated: _updatedTruncated16,
        ...updatedNonAudit16
      } = result16.operation;
      void _attempts16;
      void _observed16;
      void _truncated16;
      void _updatedAttempts16;
      void _updatedObserved16;
      void _updatedTruncated16;
      expect(updatedNonAudit16).toEqual(beforeNonAudit16);
      expect(JSON.stringify(sixteen)).toBe(before);
      expect(projector.mock.calls.length).toBeGreaterThanOrEqual(2);

      projector.mockClear();
      const seventeen = makeMaximumV4Operation(17);
      const before17 = JSON.stringify(seventeen);
      const result17 = applyAutomaticCaptureAttemptV1({
        familyVersion: 4,
        operation: seventeen,
        observation: {
          attemptHash: hashAt(921),
          at: T0,
          disposition: 'resume_available',
        },
      });
      expect(result17).toEqual({ kind: 'not_updated', familyVersion: 4 });
      expect(JSON.stringify(seventeen)).toBe(before17);
      expect(projector).toHaveBeenCalledTimes(1);
    } finally {
      projector.mockRestore();
    }
  });

  test('appends a terminal V4 replay without calling the active reserve projector', () => {
    const operation = makeCommittedV4Operation(31);
    const before = JSON.stringify(operation);
    const projector = jest.spyOn(terminalReserve, 'projectAutonomousPersonalTerminalReserveV4');
    try {
      const result = applyAutomaticCaptureAttemptV1({
        familyVersion: 4,
        operation,
        observation: {
          attemptHash: hashAt(930),
          at: T0,
          disposition: 'committed_replay',
        },
      });
      expect(result.kind).toBe('updated');
      if (
        result.kind !== 'updated' ||
        result.operation.version !== 4 ||
        result.operation.state !== 'committed'
      ) {
        throw new Error('Expected terminal Operation4 update');
      }
      expect(result.operation.attempts).toHaveLength(32);
      expect(result.operation.terminalReceipt).toEqual(operation.terminalReceipt);
      expect(projector).not.toHaveBeenCalled();
      expect(JSON.stringify(operation)).toBe(before);
      expectDeepFrozen(result);
    } finally {
      projector.mockRestore();
    }
  });

  test('preserves V3 helper checks around candidate update, no-op and fixed DATA failure', () => {
    const operation = makeV3LeasedOperation();
    const duplicateRegistry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const duplicateBegin = duplicateRegistry.startInitialBegin(
      operation.attempts[0]!.attemptHash,
      operation.descriptor,
    );
    const check = jest.fn();

    const duplicate = withCompositionalCaptureAttemptV3(
      operation,
      duplicateBegin.audit,
      '2026-10-25T12:00:01.000Z',
      'in_progress',
      duplicateRegistry,
      check,
    );
    expect(duplicate).toBe(operation);
    expect(check).toHaveBeenCalledTimes(2);

    const registry = createCompositionalAutomaticCaptureHandleRegistryV3();
    const begin = registry.startInitialBegin(hashAt(940), operation.descriptor);
    check.mockClear();
    const updated = withCompositionalCaptureAttemptV3(
      operation,
      begin.audit,
      '2026-10-25T12:00:01.000Z',
      'in_progress',
      registry,
      check,
    );
    expect(updated).not.toBeNull();
    expect(check).toHaveBeenCalledTimes(3);

    const realApply = applyAutomaticCaptureAttemptV1;
    const helper = jest.spyOn(stateCore, 'applyAutomaticCaptureAttemptV1');
    const sentinel = new Error('Engram compositional capture: budget_exhausted');
    let invalidated = false;
    const invalidatingCheck = jest.fn(() => {
      if (invalidated) throw sentinel;
    });
    try {
      helper.mockImplementation((input) => {
        invalidated = true;
        return realApply(input);
      });
      expect(() =>
        withCompositionalCaptureAttemptV3(
          operation,
          begin.audit,
          '2026-10-25T12:00:02.000Z',
          'in_progress',
          registry,
          invalidatingCheck,
        ),
      ).toThrow(sentinel);
      expect(invalidatingCheck).toHaveBeenCalledTimes(3);

      helper.mockImplementation(() => realApply({}));
      invalidatingCheck.mockClear();
      invalidated = false;
      expect(
        withCompositionalCaptureAttemptV3(
          operation,
          begin.audit,
          '2026-10-25T12:00:02.000Z',
          'in_progress',
          registry,
          invalidatingCheck,
        ),
      ).toBeNull();
      expect(invalidatingCheck).toHaveBeenCalledTimes(3);
    } finally {
      helper.mockRestore();
    }
  });
});
