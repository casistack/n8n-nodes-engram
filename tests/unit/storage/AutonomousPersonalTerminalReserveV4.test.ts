import { ZodError } from 'zod';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from '../../../src/schemas/AutomaticLedgerPrimitives.schema';
import {
  hashAutonomousPersonalDescriptorV4,
  compileAutonomousPersonalDescriptorV4,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { AutonomousPersonalOperationV4Schema } from '../../../src/schemas/AutonomousPersonalOperationV4.schema';
import { compileAutonomousPersonalSourceTupleV4 } from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import { projectAutonomousPersonalTerminalReserveV4 } from '../../../src/storage/AutonomousPersonalTerminalReserveV4';

const T0 = '2026-10-26T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const hashAt = (value: number) => value.toString(16).padStart(64, '0');
const uuidAt = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const controlMax = (length: number) => '\u0001'.repeat(length - 1) + 'x';

function makeMaximumDescriptor() {
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

function makeMaximumIdentity(descriptor = makeMaximumDescriptor()) {
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
  return { descriptor, identity: tuple.identity };
}

function makeOperation(attemptCount = 0, state: 'captured' | 'failed' = 'failed') {
  const base = makeMaximumIdentity();
  const attempts = Array.from({ length: attemptCount }, (_, index) =>
    AutomaticOperationAttemptSchema.parse({
      attemptHash: hashAt(index + 1000),
      at: T0,
      disposition: index === 0 ? 'claim_won' : 'legacy_unconfirmed',
    }),
  );
  const common = {
    version: 4,
    operationId: uuidAt(10),
    identity: base.identity,
    descriptor: base.descriptor,
    createdAt: T0,
    lastObservedAt: T0,
    attempts,
    overflowCount: AUTOMATIC_LEDGER_LIMITS.overflowCounterMax,
    auditTruncated: false,
    beginCallHash: hashAt(400),
  };
  if (state === 'captured') {
    const captured = {
      ...common,
      overflowCount: 0,
      state: 'captured' as const,
      generation: 0,
      retryCount: 0,
    };
    delete (captured as Record<string, unknown>)['auditTruncated'];
    return captured;
  }
  return {
    ...common,
    lastResumeCause: 'lease_expired',
    retryCount: 3,
    lastRetryCallHash: hashAt(778),
    state: 'failed' as const,
    generation: AUTOMATIC_LEDGER_LIMITS.maxGeneration,
    failedAt: T0,
    failureCode: 'storage_error' as const,
  };
}

function makeMeasuringEnvelope(operation: ReturnType<typeof makeOperation>) {
  const parsed = AutonomousPersonalOperationV4Schema.parse(operation);
  return {
    version: parsed.version,
    operationId: parsed.operationId,
    identity: parsed.identity,
    descriptor: parsed.descriptor,
    createdAt: parsed.createdAt,
    lastObservedAt: parsed.lastObservedAt,
    attempts: parsed.attempts,
    overflowCount: AUTOMATIC_LEDGER_LIMITS.overflowCounterMax,
    auditTruncated: false,
    lastResumeCause: 'lease_expired',
    beginCallHash: parsed.beginCallHash,
    retryCount: 3,
    lastRetryCallHash: hashAt(999),
    state: 'committed',
    generation: AUTOMATIC_LEDGER_LIMITS.maxGeneration,
    terminalReceipt: null,
    completionCallHash: hashAt(998),
  };
}

function expectFixedError(invoke: () => unknown, sentinel?: string): void {
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
    message: 'invalid_autonomous_terminal_reserve_data',
  });
  expect(error.message).not.toContain(sentinel ?? 'private-operation-sentinel');
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(error.issues)).toBe(true);
  expect(Object.isFrozen(error.issues[0])).toBe(true);
  expect(Object.isFrozen(error.issues[0]?.path)).toBe(true);
}

describe('Autonomous Operation4 terminal reserve projection is size DATA only', () => {
  test('projects the exact max committed shape from one current audit prefix', () => {
    const operation = makeOperation(8);
    const before = JSON.stringify(operation);
    const measuringEnvelope = makeMeasuringEnvelope(operation);
    const expectedBytes =
      Buffer.byteLength(JSON.stringify(measuringEnvelope), 'utf8') -
      Buffer.byteLength('null', 'utf8') +
      AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes;

    const result = projectAutonomousPersonalTerminalReserveV4(operation);
    expect(result).toEqual({
      version: 1,
      projectedTerminalBytes: expectedBytes,
      withinLimit: expectedBytes <= AUTOMATIC_LEDGER_LIMITS.operationBytes,
    });
    expect(result).not.toHaveProperty('operation');
    expect(result).not.toHaveProperty('receipt');
    expect(result).not.toHaveProperty('permit');
    expect(result).not.toHaveProperty('accepted');
    expect(Object.keys(result).sort()).toEqual([
      'projectedTerminalBytes',
      'version',
      'withinLimit',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(operation)).toBe(before);
  });

  test('uses current maximum descriptor strings, safe-integer settings, and custom temperature bytes', () => {
    const operation = makeOperation(1);
    const result = projectAutonomousPersonalTerminalReserveV4(operation);
    const descriptor = operation.descriptor;
    expect(descriptor.provider.configuredTimeoutMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(descriptor.provider.configuredRequestBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(descriptor.provider.configuredResponseBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(descriptor.provider.temperature).toEqual({
      mode: 'custom',
      value: 0.12345678901234568,
    });
    expect(descriptor.provider.routeId).toBe(controlMax(128));
    expect(hashAutonomousPersonalDescriptorV4(descriptor)).toBe(operation.identity.descriptorHash);

    const independentlyMeasured =
      Buffer.byteLength(JSON.stringify(makeMeasuringEnvelope(operation)), 'utf8') - 4 + 16_384;
    expect(result.projectedTerminalBytes).toBe(independentlyMeasured);
  });

  test('dynamically crosses the cap between a real 16-row and 17-row maximum-context prefix', () => {
    const sixteen = makeOperation(16);
    const seventeen = makeOperation(17);
    expect(AutonomousPersonalOperationV4Schema.safeParse(sixteen).success).toBe(true);
    expect(AutonomousPersonalOperationV4Schema.safeParse(seventeen).success).toBe(true);

    const projected16 = projectAutonomousPersonalTerminalReserveV4(sixteen);
    const projected17 = projectAutonomousPersonalTerminalReserveV4(seventeen);
    expect(projected16.withinLimit).toBe(true);
    expect(projected17.withinLimit).toBe(false);
    expect(projected17.projectedTerminalBytes).toBeGreaterThan(projected16.projectedTerminalBytes);
    const rows = (seventeen as { attempts: Array<{ disposition: string }> }).attempts;
    expect(rows[0]?.disposition).toBe('claim_won');
    expect(rows.slice(1).every((attempt) => attempt.disposition === 'legacy_unconfirmed')).toBe(
      true,
    );
  });

  test('drops state-only failure and lease fields while retaining the same common-prefix projection', () => {
    const failed = makeOperation(2, 'failed');
    const captured = makeOperation(2, 'captured');
    const interrupted = {
      ...failed,
      state: 'interrupted' as const,
      failureCode: 'invocation_interrupted' as const,
      interruptedAt: T0,
    };
    delete (interrupted as Record<string, unknown>)['failedAt'];

    const leased = {
      ...failed,
      state: 'leased' as const,
      lease: {
        token: uuidAt(20),
        acquiredAt: T0,
        renewedAt: T0,
        expiresAt: '2026-10-26T12:02:30.000Z',
        claimKind: 'resume' as const,
      },
    };
    delete (leased as Record<string, unknown>)['failedAt'];
    delete (leased as Record<string, unknown>)['failureCode'];

    for (const active of [captured, failed, interrupted, leased]) {
      expect(AutonomousPersonalOperationV4Schema.safeParse(active).success).toBe(true);
    }
    const expected = projectAutonomousPersonalTerminalReserveV4(failed);
    expect(projectAutonomousPersonalTerminalReserveV4(captured)).toEqual(expected);
    expect(projectAutonomousPersonalTerminalReserveV4(interrupted)).toEqual(expected);
    expect(projectAutonomousPersonalTerminalReserveV4(leased)).toEqual(expected);
  });

  test('rejects terminal operation states instead of projecting a second terminal', () => {
    const base = makeOperation(0, 'captured');
    const operationId = base.operationId;
    const descriptorHash = hashAutonomousPersonalDescriptorV4(base.descriptor);
    const receipt = {
      version: 4,
      kind: 'human_autonomous_source_verdict_committed',
      operationId,
      sourceId: base.identity.sourceId,
      sourceHash: base.identity.sourceHash,
      descriptorHash,
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
    const committed = {
      ...base,
      state: 'committed' as const,
      generation: 1,
      terminalReceipt: receipt,
      completionCallHash: hashAt(999),
    };
    expect(AutonomousPersonalOperationV4Schema.safeParse(committed).success).toBe(true);
    expectFixedError(() => projectAutonomousPersonalTerminalReserveV4(committed));

    const cancelledReceipt = {
      version: 4,
      kind: 'cancelled',
      operationId,
      sourceId: base.identity.sourceId,
      sourceHash: base.identity.sourceHash,
      descriptorHash,
      policyFingerprint: base.descriptor.policy.fingerprint,
      terminalAt: T0,
      acceptedCoverage: 'none',
    };
    const cancelled = {
      ...base,
      state: 'cancelled' as const,
      generation: 0,
      terminalReceipt: cancelledReceipt,
    };
    expect(AutonomousPersonalOperationV4Schema.safeParse(cancelled).success).toBe(true);
    expectFixedError(() => projectAutonomousPersonalTerminalReserveV4(cancelled));
  });

  test('owns hostile input first, returns one frozen fixed error, and never invokes callbacks or I/O', () => {
    const input = makeOperation(1);
    const sentinel = 'private-operation-sentinel';
    let traps = 0;
    const getter = Object.defineProperty({}, 'state', {
      enumerable: true,
      get: () => {
        traps += 1;
        throw new Error(sentinel);
      },
    });
    const proxy = new Proxy(input, {
      get: () => {
        traps += 1;
        throw new Error(sentinel);
      },
    });
    const nestedProxy = { ...input, identity: new Proxy(input.identity, { get: () => ++traps }) };
    const cycle: Record<string, unknown> = { ...input };
    cycle['cycle'] = cycle;
    for (const hostile of [getter, proxy, nestedProxy, cycle]) {
      expectFixedError(() => projectAutonomousPersonalTerminalReserveV4(hostile), sentinel);
    }

    for (const key of ['then', 'toJSON', 'callback', 'requestedLimit', 'receipt']) {
      const hostile = { ...input, [key]: () => ++traps };
      expectFixedError(() => projectAutonomousPersonalTerminalReserveV4(hostile), sentinel);
    }
    const oversized = { ...input, padding: 'x'.repeat(512 * 1024) };
    expectFixedError(() => projectAutonomousPersonalTerminalReserveV4(oversized), sentinel);
    expect(traps).toBe(0);

    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected network access');
    });
    try {
      projectAutonomousPersonalTerminalReserveV4(input);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
