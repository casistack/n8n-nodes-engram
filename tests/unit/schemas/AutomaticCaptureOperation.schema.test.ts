import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { buildAutomaticOperationDescriptorV2 } from '../../../src/extraction/AutomaticCaptureDescriptor';
import {
  AutomaticOperationDescriptorV2Schema,
  automaticOperationDescriptorSettingsHashV2,
  hashAutomaticCaptureV2,
} from '../../../src/schemas/AutomaticCapture.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../../../src/schemas/AutomaticCaptureReceipt.schema';
import { AutomaticOperationAttemptSchema } from '../../../src/schemas/AutomaticLedger.schema';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const T2 = '2026-01-01T00:00:02.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const UUID_OPERATION = '7f8f3c7d-50a1-42dc-b1e8-0c913a12cb14';
const UUID_SOURCE = '124b6af9-2b89-4e80-b052-373197a3e1c5';
const UUID_ASSISTANT_SOURCE = 'be45148f-8443-40df-b68e-34c80332d4af';
const UUID_SUBJECT = 'e737f818-682b-42f8-a1b7-f39d7d1af599';
const UUID_BINDING = 'c4dcb624-1eef-47c3-8888-79ced532bc50';
const UUID_TOKEN = '4f870bb6-10e3-4803-a8c7-7a16d93e0fc1';
const UUID_HUMAN_REFERENCE = '897a3d36-a12d-4f63-90d3-dd9eb420e491';

const binding = {
  bindingId: UUID_BINDING,
  revision: 3,
  subjectId: UUID_SUBJECT,
  fingerprint: HASH_D,
};

function humanDescriptor() {
  return buildAutomaticOperationDescriptorV2({
    purpose: 'human_turn_memory',
    profileId: 'explicit',
    requestedTrustLevel: 'standard',
    intentSetting: true,
    invocationDeadlineMs: 15_000,
  }).descriptor;
}

function assistantDescriptor() {
  const authority = {
    kind: 'owned_human_turn' as const,
    sourceId: UUID_HUMAN_REFERENCE,
    sourceHash: HASH_B,
    descriptorHash: HASH_C,
    requestedAuthorityHash: HASH_D,
  };
  const settings = {
    lifecycle: 'replaySafeV2' as const,
    purpose: 'assistant_final_save' as const,
    interpreterId: 'assistant-final-write-v1' as const,
    semanticVersion: 1 as const,
    grammarVersion: null,
    lexiconVersion: null,
    requestedTrustLevel: null,
    intentSetting: null,
    invocationDeadlineMs: 15_000,
    policy: null,
    assistantWriteAuthority: authority,
  };
  return AutomaticOperationDescriptorV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    purpose: 'assistant_final_save',
    executionMode: 'synchronous',
    interpreterId: 'assistant-final-write-v1',
    semanticVersion: 1,
    grammarVersion: null,
    lexiconVersion: null,
    requestedTrustLevel: null,
    intentSetting: null,
    policy: null,
    assistantWriteAuthority: authority,
    invocationDeadlineMs: 15_000,
    settingsHash: automaticOperationDescriptorSettingsHashV2(settings),
  });
}

function humanIdentity(sourceId = UUID_SOURCE, sourceHash = HASH_B) {
  return {
    lifecycle: 'replaySafeV2',
    storeHash: HASH_A,
    namespace: 'tenant',
    issuer: 'workflow',
    actorReference: 'user-1',
    turn: 'turn-1',
    role: 'human',
    sourceId,
    sourceHash,
    originalProducerHash: HASH_C,
    stableProducerHash: HASH_D,
    requestedAuthorityHash: HASH_E,
    purpose: 'human_turn_memory',
    binding,
  };
}

function assistantIdentity() {
  return {
    lifecycle: 'replaySafeV2',
    storeHash: HASH_A,
    namespace: 'tenant',
    issuer: 'workflow',
    actorReference: 'user-1',
    turn: 'turn-1',
    role: 'assistant',
    sourceId: UUID_ASSISTANT_SOURCE,
    sourceHash: HASH_B,
    originalProducerHash: HASH_C,
    stableProducerHash: HASH_D,
    requestedAuthorityHash: HASH_E,
    purpose: 'assistant_final_save',
    binding: null,
  };
}

function common(
  identity: unknown = humanIdentity(),
  descriptor: unknown = humanDescriptor(),
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 2,
    operationId: UUID_OPERATION,
    identity,
    descriptor,
    createdAt: T0,
    lastObservedAt: T1,
    attempts: [],
    overflowCount: 0,
    beginCallHash: HASH_E,
    retryCount: 0,
    ...overrides,
  };
}

function humanTerminalReceipt(
  options: {
    operationId?: string;
    sourceId?: string;
    sourceHash?: string;
    descriptorHash?: string;
    policy?: ReturnType<typeof compileAutomaticPolicy>;
    terminalAt?: string;
  } = {},
) {
  const descriptor = humanDescriptor();
  const sourceId = options.sourceId ?? UUID_SOURCE;
  const terminalAt = options.terminalAt ?? T1;
  const policy = options.policy ?? descriptor.policy;
  const reasons = ['no_preference_clause' as const];
  return {
    version: 2,
    kind: 'human_capture_committed',
    operationId: options.operationId ?? UUID_OPERATION,
    sourceId,
    sourceHash: options.sourceHash ?? HASH_B,
    descriptorHash: options.descriptorHash ?? hashAutomaticCaptureV2(descriptor),
    terminalAt,
    receiptInspectionComplete: true,
    interpretationCoverage: 'none',
    acceptedCoverage: 'none',
    dependencies: [
      {
        sourceId,
        dependencyHash: HASH_E,
        itemIndex: 0,
        state: 'not_selected',
        persisted: false,
        reasons,
      },
    ],
    receipt: {
      version: 1,
      policy,
      sourceIds: [sourceId],
      persisted: true,
      commitAt: terminalAt,
      items: [{ state: 'not_selected', persisted: false, mutation: 'none', reasons }],
      coverageComplete: true,
    },
  };
}

function assistantTerminalReceipt(
  options: {
    operationId?: string;
    sourceId?: string;
    sourceHash?: string;
    descriptorHash?: string;
    terminalAt?: string;
  } = {},
) {
  const descriptor = assistantDescriptor();
  return {
    version: 2,
    kind: 'assistant_final_saved',
    operationId: options.operationId ?? UUID_OPERATION,
    sourceId: options.sourceId ?? UUID_ASSISTANT_SOURCE,
    sourceHash: options.sourceHash ?? HASH_B,
    descriptorHash: options.descriptorHash ?? hashAutomaticCaptureV2(descriptor),
    terminalAt: options.terminalAt ?? T1,
    persisted: true,
  };
}

function cancelledTerminalReceipt() {
  const descriptor = humanDescriptor();
  return {
    version: 2,
    kind: 'cancelled',
    operationId: UUID_OPERATION,
    sourceId: UUID_SOURCE,
    sourceHash: HASH_B,
    descriptorHash: hashAutomaticCaptureV2(descriptor),
    terminalAt: T1,
    acceptedCoverage: 'none',
  };
}

function validLease(overrides: Record<string, unknown> = {}) {
  return {
    ...common(humanIdentity(), humanDescriptor(), { lastObservedAt: T1 }),
    state: 'leased',
    generation: 1,
    lease: {
      token: UUID_TOKEN,
      acquiredAt: T0,
      renewedAt: T1,
      expiresAt: '2026-01-01T00:01:01.000Z',
      claimKind: 'initial',
      ...((overrides.lease as object | undefined) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'lease')),
  };
}

function validHumanCommitted(overrides: Record<string, unknown> = {}) {
  return {
    ...common(),
    state: 'committed',
    generation: 1,
    terminalReceipt: humanTerminalReceipt(),
    completionCallHash: HASH_D,
    ...overrides,
  };
}

function validAssistantCommitted(overrides: Record<string, unknown> = {}) {
  return {
    ...common(assistantIdentity(), assistantDescriptor()),
    state: 'committed',
    generation: 1,
    terminalReceipt: assistantTerminalReceipt(),
    completionCallHash: HASH_D,
    ...overrides,
  };
}

function validCancelled(overrides: Record<string, unknown> = {}) {
  return {
    ...common(),
    state: 'cancelled',
    generation: 1,
    terminalReceipt: cancelledTerminalReceipt(),
    ...overrides,
  };
}

describe('AutomaticCaptureOperationV2Schema', () => {
  it('accepts captured, initial lease, resumed lease, failed and interrupted states', () => {
    const captured = common(humanIdentity(), humanDescriptor(), {
      state: 'captured',
      generation: 0,
      lastObservedAt: T0,
    });
    const initialLease = validLease();
    const resumedLease = validLease({
      generation: 2,
      retryCount: 1,
      lastRetryCallHash: HASH_A,
      lease: { claimKind: 'resume' },
    });
    const failed = {
      ...common(),
      state: 'failed',
      generation: 1,
      failedAt: T1,
      failureCode: 'graph_conflict',
    };
    const interrupted = {
      ...common(),
      state: 'interrupted',
      generation: 1,
      interruptedAt: T1,
      failureCode: 'invocation_interrupted',
    };
    for (const operation of [captured, initialLease, resumedLease, failed, interrupted]) {
      expect(AutomaticCaptureOperationV2Schema.safeParse(operation).success).toBe(true);
    }
  });

  it('accepts purpose-matched committed and cancelled terminal variants', () => {
    expect(AutomaticCaptureOperationV2Schema.safeParse(validHumanCommitted()).success).toBe(true);
    expect(AutomaticCaptureOperationV2Schema.safeParse(validAssistantCommitted()).success).toBe(
      true,
    );
    expect(AutomaticCaptureOperationV2Schema.safeParse(validCancelled()).success).toBe(true);
  });

  it('rejects v1, future versions, and legacy-unconfirmed as v2 operation variants', () => {
    for (const invalid of [
      { ...common(), version: 1 },
      { ...common(), version: 3 },
      { ...common(), version: 2, state: 'legacy_unconfirmed', generation: 0 },
      { ...common(), version: 2, state: 'future_state', generation: 0 },
    ]) {
      expect(AutomaticCaptureOperationV2Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('binds operation identity and descriptor purpose, role, and binding', () => {
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        common(humanIdentity(), assistantDescriptor(), { state: 'captured', generation: 0 }),
      ).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        common({ ...humanIdentity(), role: 'assistant' }, humanDescriptor(), {
          state: 'captured',
          generation: 0,
        }),
      ).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        common({ ...humanIdentity(), binding: null }, humanDescriptor(), {
          state: 'captured',
          generation: 0,
        }),
      ).success,
    ).toBe(false);
  });

  it('requires retry hashes exactly when the persisted retry count is positive', () => {
    expect(AutomaticCaptureOperationV2Schema.safeParse(validLease({ retryCount: 1 })).success).toBe(
      false,
    );
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        validLease({ retryCount: 0, lastRetryCallHash: HASH_A }),
      ).success,
    ).toBe(false);
    expect(AutomaticCaptureOperationV2Schema.safeParse(validLease({ retryCount: 4 })).success).toBe(
      false,
    );
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        validLease({ retryCount: 1, lastRetryCallHash: HASH_A }),
      ).success,
    ).toBe(true);
  });

  it('forbids assistant-purpose retries in captured, leased, and committed states', () => {
    const retryFields = { retryCount: 1, lastRetryCallHash: HASH_A };
    const assistantCaptured = common(assistantIdentity(), assistantDescriptor(), {
      state: 'captured',
      generation: 0,
      lastObservedAt: T0,
      ...retryFields,
    });
    const assistantLeased = validLease({
      identity: assistantIdentity(),
      descriptor: assistantDescriptor(),
      ...retryFields,
    });
    const assistantCommitted = validAssistantCommitted(retryFields);
    for (const operation of [assistantCaptured, assistantLeased, assistantCommitted]) {
      expect(AutomaticCaptureOperationV2Schema.safeParse(operation).success).toBe(false);
    }
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        validLease({ retryCount: 1, lastRetryCallHash: HASH_A }),
      ).success,
    ).toBe(true);
  });

  it('requires begin/completion hashes and forbids completion hashes outside committed state', () => {
    const withoutBegin = { ...common(), state: 'captured', generation: 0 } as Record<
      string,
      unknown
    >;
    delete withoutBegin.beginCallHash;
    expect(AutomaticCaptureOperationV2Schema.safeParse(withoutBegin).success).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...validHumanCommitted(),
        completionCallHash: undefined,
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...validLease(),
        completionCallHash: HASH_C,
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...validCancelled(),
        completionCallHash: HASH_C,
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({ ...validLease(), rawCompletionNonce: 'secret' })
        .success,
    ).toBe(false);
  });

  it('requires exact terminal kind for purpose and state', () => {
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        validHumanCommitted({ terminalReceipt: assistantTerminalReceipt() }),
      ).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        validAssistantCommitted({ terminalReceipt: humanTerminalReceipt() }),
      ).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        validCancelled({ terminalReceipt: assistantTerminalReceipt() }),
      ).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...validLease(),
        terminalReceipt: cancelledTerminalReceipt(),
      }).success,
    ).toBe(false);
  });

  it('cross-binds terminal receipt operation/source/source hash and descriptor hash', () => {
    const base = humanTerminalReceipt();
    const invalidReceipts = [
      { ...base, operationId: UUID_ASSISTANT_SOURCE },
      { ...base, sourceId: UUID_ASSISTANT_SOURCE },
      { ...base, sourceHash: HASH_C },
      { ...base, descriptorHash: HASH_D },
    ];
    for (const terminalReceipt of invalidReceipts) {
      expect(
        AutomaticCaptureOperationV2Schema.safeParse(validHumanCommitted({ terminalReceipt }))
          .success,
      ).toBe(false);
    }
  });

  it('requires the human receipt policy to match the captured descriptor', () => {
    const terminalReceipt = humanTerminalReceipt({
      policy: compileAutomaticPolicy({ profileId: 'conservative' }),
    });
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(validHumanCommitted({ terminalReceipt })).success,
    ).toBe(false);
  });

  it('checks lease generation, monotonic times, expiry and captured deadline duration', () => {
    const invalidLeases = [
      { generation: 2, lease: { claimKind: 'initial' } },
      { generation: 1, lease: { claimKind: 'resume' } },
      { lease: { acquiredAt: '2025-12-31T23:59:59.000Z' } },
      { lease: { renewedAt: '2026-01-01T00:00:00.500Z' } },
      { lease: { renewedAt: '2026-01-01T00:00:02.000Z' } },
      { lease: { expiresAt: T1 } },
      { lease: { expiresAt: '2026-01-01T00:01:02.000Z' } },
    ];
    for (const override of invalidLeases) {
      expect(AutomaticCaptureOperationV2Schema.safeParse(validLease(override)).success).toBe(false);
    }
  });

  it('checks created, attempt, failure, interruption, and terminal times', () => {
    const attempt = { attemptHash: HASH_C, at: T2, disposition: 'captured' };
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        common(humanIdentity(), humanDescriptor(), {
          state: 'captured',
          generation: 0,
          lastObservedAt: T1,
          attempts: [attempt],
        }),
      ).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        common(humanIdentity(), humanDescriptor(), {
          state: 'captured',
          generation: 0,
          createdAt: T1,
          lastObservedAt: T0,
        }),
      ).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...common(),
        state: 'failed',
        generation: 1,
        failedAt: T2,
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...common(),
        state: 'interrupted',
        generation: 1,
        interruptedAt: '2025-12-31T23:59:59.000Z',
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        validHumanCommitted({
          terminalReceipt: humanTerminalReceipt({ terminalAt: T2 }),
        }),
      ).success,
    ).toBe(false);
  });

  it('uses the existing bounded attempt-entry schema and rejects too many attempts', () => {
    const attempt = { attemptHash: HASH_C, at: T0, disposition: 'captured' };
    expect(AutomaticOperationAttemptSchema.safeParse(attempt).success).toBe(true);
    expect(AutomaticOperationAttemptSchema.safeParse({ ...attempt, at: 'not-time' }).success).toBe(
      false,
    );
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(
        common(humanIdentity(), humanDescriptor(), {
          state: 'captured',
          generation: 0,
          attempts: Array.from({ length: 33 }, () => attempt),
        }),
      ).success,
    ).toBe(false);
  });

  it('preflights huge arrays and unknown versions before visiting their entries', () => {
    let indexedReads = 0;
    const oversizedAttempts = new Proxy(
      Array.from({ length: 100 }, () => null),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({ ...common(), attempts: oversizedAttempts })
        .success,
    ).toBe(false);
    expect(indexedReads).toBe(0);

    const oversizedDependencies = new Proxy(
      Array.from({ length: 33 }, () => null),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...validHumanCommitted(),
        terminalReceipt: { ...humanTerminalReceipt(), dependencies: oversizedDependencies },
      }).success,
    ).toBe(false);
    expect(indexedReads).toBe(0);

    const oversizedItems = new Proxy(
      Array.from({ length: 33 }, () => null),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    const receipt = humanTerminalReceipt();
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...validHumanCommitted(),
        terminalReceipt: {
          ...receipt,
          receipt: { ...receipt.receipt, items: oversizedItems },
        },
      }).success,
    ).toBe(false);
    expect(indexedReads).toBe(0);

    const oversizedSourceIds = new Proxy(
      Array.from({ length: 33 }, () => null),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...validHumanCommitted(),
        terminalReceipt: {
          ...receipt,
          receipt: { ...receipt.receipt, sourceIds: oversizedSourceIds },
        },
      }).success,
    ).toBe(false);
    expect(indexedReads).toBe(0);

    expect(
      AutomaticCaptureOperationV2Schema.safeParse({
        ...common(),
        version: 3,
        attempts: oversizedAttempts,
      }).success,
    ).toBe(false);
    expect(indexedReads).toBe(0);
  });

  it('rejects terminal wrapper receipts over their existing 16 KiB bound', () => {
    const descriptor = humanDescriptor();
    const policy = descriptor.policy;
    const sourceId = UUID_SOURCE;
    const reasons = Array.from({ length: 8 }, () => 'unsupported_grammar' as const);
    const items = Array.from({ length: 32 }, () => ({
      state: 'not_selected' as const,
      persisted: false,
      mutation: 'none' as const,
      reasons,
    }));
    const dependencies = items.map((item, itemIndex) => ({
      sourceId,
      dependencyHash: HASH_E,
      itemIndex,
      state: item.state,
      persisted: item.persisted,
      reasons: item.reasons,
    }));
    const terminalReceipt = {
      version: 2,
      kind: 'human_capture_committed',
      operationId: UUID_OPERATION,
      sourceId,
      sourceHash: HASH_B,
      descriptorHash: hashAutomaticCaptureV2(descriptor),
      terminalAt: T1,
      receiptInspectionComplete: true,
      interpretationCoverage: 'unknown',
      acceptedCoverage: 'none',
      dependencies,
      receipt: {
        version: 1,
        policy,
        sourceIds: [sourceId],
        persisted: true,
        commitAt: T1,
        items,
        coverageComplete: true,
      },
    };
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(terminalReceipt).success).toBe(false);
    expect(
      AutomaticCaptureOperationV2Schema.safeParse(validHumanCommitted({ terminalReceipt })).success,
    ).toBe(false);
  });
});
