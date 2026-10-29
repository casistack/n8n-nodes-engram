import { randomUUID } from 'crypto';
import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticLedgerSchema,
  AutomaticOperationSchema,
  automaticOperationDescriptorHash,
} from '../../../src/schemas/AutomaticLedger.schema';
import {
  admitAutomaticOperation,
  cancelAutomaticOperation,
  claimAutomaticOperation,
  completeAutomaticOperation,
  createAutomaticLedger,
  failAutomaticOperation,
  observeLegacyUnconfirmed,
  readAutomaticOperation,
  renewAutomaticOperation,
  resumeAutomaticOperation,
} from '../../../src/storage/AutomaticLedger';

const baseTime = Date.parse('2026-10-24T10:00:00.000Z');
const at = (offsetMs = 0) => new Date(baseTime + offsetMs).toISOString();
const hash = (char: string) => char.repeat(64);
const policy = compileAutomaticPolicy({ profileId: 'conservative' });

function identity(overrides: Record<string, unknown> = {}) {
  return {
    storeHash: hash('a'),
    namespace: 'ledger-tests',
    issuer: 'test-app',
    actorReference: 'stable-actor',
    turn: 'stable-turn-1',
    role: 'human' as const,
    sourceId: randomUUID(),
    sourceHash: hash('b'),
    originalProducerHash: hash('c'),
    binding: null,
    ...overrides,
  };
}

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    interpreterId: 'literal-parser-v1' as const,
    executionMode: 'synchronous' as const,
    semanticVersion: 1 as const,
    grammarVersion: 1 as const,
    lexiconVersion: 1 as const,
    invocationDeadlineMs: 30_000,
    routeConfigHash: hash('d'),
    policy,
    ...overrides,
  };
}

function attempt(seed = 'e') {
  return { attemptHash: hash(seed) };
}

function receipt(sourceId: string, time: string, state: 'accepted' | 'proposed' = 'accepted') {
  const claimId = randomUUID();
  const item = {
    claimId,
    state,
    persisted: true,
    mutation: state === 'accepted' ? ('created' as const) : ('created' as const),
    reasons: [state === 'accepted' ? ('selected' as const) : ('review_required' as const)],
  };
  return {
    receipt: {
      version: 1 as const,
      policy,
      sourceIds: [sourceId],
      persisted: true,
      commitAt: time,
      items: [item],
      coverageComplete: state === 'accepted',
    },
    coverage: state === 'accepted' ? ('all' as const) : ('none' as const),
    dependencies: [
      {
        dependencyHash: hash('f'),
        claimId,
        itemIndex: 0,
        state,
        persisted: item.persisted,
        reasons: [state === 'accepted' ? ('selected' as const) : ('review_required' as const)],
      },
    ],
  };
}

function committedUnknownOperation(index: number) {
  const currentIdentity = identity({
    namespace: 'near-cap',
    issuer: 'i',
    actorReference: 'a',
    turn: `pad-${index}`,
    sourceId: randomUUID(),
  });
  const currentDescriptor = descriptor();
  const operationId = randomUUID();
  const timestamp = at();
  return {
    version: 1,
    operationId,
    identity: currentIdentity,
    descriptor: currentDescriptor,
    createdAt: timestamp,
    lastObservedAt: at(2),
    attempts: Array.from({ length: 3 }, (_, attemptIndex) => ({
      attemptHash: hash(((attemptIndex % 9) + 1).toString()),
      at: at(attemptIndex),
      disposition: 'committed_replay' as const,
    })),
    overflowCount: 0,
    state: 'committed' as const,
    generation: 1,
    terminalReceipt: {
      version: 1,
      operationId,
      sourceId: currentIdentity.sourceId,
      sourceHash: currentIdentity.sourceHash,
      descriptorHash: automaticOperationDescriptorHash(currentDescriptor),
      terminalAt: timestamp,
      coverage: 'unknown' as const,
      dependencies: [],
      receipt: {
        version: 1 as const,
        policy,
        sourceIds: [currentIdentity.sourceId],
        persisted: true,
        commitAt: timestamp,
        items: [],
        coverageComplete: false,
      },
    },
  };
}

function admitted(
  options: {
    identity?: ReturnType<typeof identity>;
    descriptor?: ReturnType<typeof descriptor>;
  } = {},
) {
  const currentIdentity = options.identity ?? identity();
  const currentDescriptor = options.descriptor ?? descriptor();
  const created = admitAutomaticOperation(
    createAutomaticLedger(),
    {
      operationId: randomUUID(),
      identity: currentIdentity,
      descriptor: currentDescriptor,
      attempt: attempt(),
    },
    at(),
  );
  expect(created.kind).toBe('created');
  return {
    ledger: created.ledger!,
    operation: created.operation!,
    identity: currentIdentity,
    descriptor: currentDescriptor,
  };
}

function claimed(ledger: unknown, operationId: string, token = randomUUID(), now = at()) {
  const result = claimAutomaticOperation(
    ledger,
    { operationId, token, attempt: attempt('1') },
    now,
  );
  expect(result.kind).toBe('claimed');
  return result;
}

describe('AutomaticLedger schema and pure state machine', () => {
  it('preflights invalid roots and over-limit operation arrays before visiting entries', () => {
    const invalidEntries = Array.from(
      { length: AUTOMATIC_LEDGER_LIMITS.operationsPerStore + 1 },
      () => null,
    );
    const tooMany = AutomaticLedgerSchema.safeParse({ version: 1, operations: invalidEntries });
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) {
      expect(tooMany.error.issues).toHaveLength(1);
      expect(tooMany.error.issues[0].path).toEqual(['operations']);
    }

    const unknownVersion = AutomaticLedgerSchema.safeParse({
      version: 2,
      operations: invalidEntries,
    });
    expect(unknownVersion.success).toBe(false);
    if (!unknownVersion.success) {
      expect(unknownVersion.error.issues).toHaveLength(1);
      expect(unknownVersion.error.issues[0].path).toEqual(['version']);
    }
  });

  it('creates an immutable detached captured operation and rejects changed source, owner, policy, or route under the same locator', () => {
    const originalIdentity = identity();
    const originalDescriptor = descriptor();
    const first = admitAutomaticOperation(
      createAutomaticLedger(),
      {
        operationId: randomUUID(),
        identity: originalIdentity,
        descriptor: originalDescriptor,
        attempt: attempt(),
      },
      at(),
    );
    expect(first.kind).toBe('created');
    expect(Object.isFrozen(first.operation)).toBe(true);
    expect(Object.isFrozen(first.operation?.identity)).toBe(true);
    expect(Object.isFrozen(first.ledger?.operations[0])).toBe(true);

    const changedStore = admitAutomaticOperation(
      first.ledger,
      {
        operationId: randomUUID(),
        identity: identity({
          storeHash: hash('9'),
          sourceId: originalIdentity.sourceId,
        }),
        descriptor: originalDescriptor,
        attempt: attempt('2'),
      },
      at(1),
    );
    expect(changedStore.kind).toBe('conflict');
    expect(changedStore.shouldProcess).toBe(false);
    expect(changedStore.ledger).toBeNull();
    expect(changedStore.operation).toBeNull();
    expect(changedStore.terminalReceipt).toBeNull();
    expect(changedStore.attemptAudit).toBe('not_recorded');

    const changedActor = admitAutomaticOperation(
      first.ledger,
      {
        operationId: randomUUID(),
        identity: identity({ actorReference: 'different-actor' }),
        descriptor: originalDescriptor,
        attempt: attempt('8'),
      },
      at(1),
    );
    expect(changedActor.kind).toBe('conflict');
    expect(changedActor.ledger).toBeNull();
    expect(changedActor.operation).toBeNull();
    expect(changedActor.terminalReceipt).toBeNull();

    const changedSource = admitAutomaticOperation(
      first.ledger,
      {
        operationId: randomUUID(),
        identity: identity({
          sourceId: originalIdentity.sourceId,
          sourceHash: hash('8'),
        }),
        descriptor: originalDescriptor,
        attempt: attempt('3'),
      },
      at(1),
    );
    expect(changedSource.kind).toBe('conflict');

    const changedRoute = admitAutomaticOperation(
      first.ledger,
      {
        operationId: randomUUID(),
        identity: originalIdentity,
        descriptor: descriptor({ routeConfigHash: hash('7') }),
        attempt: attempt('4'),
      },
      at(1),
    );
    expect(changedRoute.kind).toBe('conflict');
    expect(changedRoute.ledger).toBeNull();
    expect(changedRoute.operation).toBeNull();
    expect(changedRoute.terminalReceipt).toBeNull();

    const changedProducer = admitAutomaticOperation(
      first.ledger,
      {
        operationId: randomUUID(),
        identity: identity({
          sourceId: originalIdentity.sourceId,
          originalProducerHash: hash('6'),
        }),
        descriptor: originalDescriptor,
        attempt: attempt('5'),
      },
      at(1),
    );
    expect(changedProducer.kind).toBe('conflict');

    const changedPolicy = admitAutomaticOperation(
      first.ledger,
      {
        operationId: randomUUID(),
        identity: originalIdentity,
        descriptor: descriptor({ policy: compileAutomaticPolicy({ profileId: 'explicit' }) }),
        attempt: attempt('6'),
      },
      at(1),
    );
    expect(changedPolicy.kind).toBe('conflict');
    expect(changedPolicy.ledger).toBeNull();
    expect(changedPolicy.operation).toBeNull();
    expect(changedPolicy.terminalReceipt).toBeNull();
    expect(first.operation?.identity.sourceHash).toBe(hash('b'));
  });

  it('rejects duplicate source UUIDs and validates descriptors against code-owned policies', () => {
    const first = admitted();
    const second = admitAutomaticOperation(
      createAutomaticLedger(),
      {
        operationId: randomUUID(),
        identity: identity({
          namespace: 'other-namespace',
          turn: 'other-turn',
          sourceId: first.identity.sourceId,
        }),
        descriptor: descriptor(),
        attempt: attempt('2'),
      },
      at(1),
    );
    expect(second.kind).toBe('created');
    expect(
      AutomaticLedgerSchema.safeParse({
        version: 1,
        operations: [first.operation, second.operation],
      }).success,
    ).toBe(false);

    const alteredPolicies = [
      { ...policy, autoAccept: false },
      { ...policy, requiresExplicitIntent: true },
      { ...policy, fingerprint: hash('8') },
    ];
    for (const alteredPolicy of alteredPolicies) {
      const invalidDescriptor = descriptor({ policy: alteredPolicy });
      expect(
        AutomaticOperationSchema.safeParse({
          ...first.operation,
          descriptor: invalidDescriptor,
        }).success,
      ).toBe(false);
      const admission = admitAutomaticOperation(
        createAutomaticLedger(),
        {
          operationId: randomUUID(),
          identity: identity(),
          descriptor: invalidDescriptor,
          attempt: attempt('3'),
        },
        at(2),
      );
      expect(admission.kind).toBe('invalid_input');
      expect(admission.shouldProcess).toBe(false);
    }

    const malformedExistingDescriptor = admitAutomaticOperation(
      first.ledger,
      {
        operationId: randomUUID(),
        identity: first.identity,
        descriptor: descriptor({ policy: { ...policy, autoAccept: false } }),
        attempt: attempt('4'),
      },
      at(3),
    );
    expect(malformedExistingDescriptor.kind).toBe('conflict');
    expect(malformedExistingDescriptor.ledger).toBeNull();
    expect(malformedExistingDescriptor.operation).toBeNull();
    expect(malformedExistingDescriptor.terminalReceipt).toBeNull();
    expect(malformedExistingDescriptor.attemptAudit).toBe('not_recorded');
  });

  it('hashes equivalent descriptors independently of object key order', () => {
    const original = descriptor();
    const reordered = {
      policy: {
        fingerprint: policy.fingerprint,
        requiresExplicitIntent: policy.requiresExplicitIntent,
        autoAccept: policy.autoAccept,
        policyVersion: policy.policyVersion,
        policyId: policy.policyId,
        profileVersion: policy.profileVersion,
        profileId: policy.profileId,
        version: policy.version,
      },
      routeConfigHash: original.routeConfigHash,
      invocationDeadlineMs: original.invocationDeadlineMs,
      lexiconVersion: original.lexiconVersion,
      grammarVersion: original.grammarVersion,
      semanticVersion: original.semanticVersion,
      executionMode: original.executionMode,
      interpreterId: original.interpreterId,
      version: original.version,
    };
    expect(automaticOperationDescriptorHash(reordered as ReturnType<typeof descriptor>)).toBe(
      automaticOperationDescriptorHash(original),
    );
  });

  it('keeps committed identity and receipt private on unauthorized admission and legacy conflicts', () => {
    const current = admitted();
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(1));
    const completed = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        ...receipt(current.identity.sourceId, at(2)),
        attempt: attempt('2'),
      },
      at(2),
    );
    expect(completed.kind).toBe('committed');
    const originalLedger = completed.ledger;

    const admissionConflict = admitAutomaticOperation(
      originalLedger,
      {
        operationId: randomUUID(),
        identity: current.identity,
        descriptor: descriptor({ routeConfigHash: hash('9') }),
        attempt: attempt('3'),
      },
      at(1),
    );
    expect(admissionConflict.kind).toBe('conflict');
    expect(admissionConflict.ledger).toBeNull();
    expect(admissionConflict.operation).toBeNull();
    expect(admissionConflict.terminalReceipt).toBeNull();
    expect(admissionConflict.attemptAudit).toBe('not_recorded');

    const legacyConflict = observeLegacyUnconfirmed(
      originalLedger,
      {
        operationId: randomUUID(),
        identity: identity({ actorReference: 'different-actor' }),
        attempt: attempt('4'),
      },
      at(1),
    );
    expect(legacyConflict.kind).toBe('conflict');
    expect(legacyConflict.ledger).toBeNull();
    expect(legacyConflict.operation).toBeNull();
    expect(legacyConflict.terminalReceipt).toBeNull();
    expect(legacyConflict.attemptAudit).toBe('not_recorded');
    expect(completed.ledger).toEqual(originalLedger);

    const invalidInput = readAutomaticOperation(
      originalLedger,
      { operationId: current.operation.operationId },
      at(5),
    );
    expect(invalidInput.kind).toBe('invalid_input');
    expect(invalidInput.ledger).toBeNull();
    expect(invalidInput.operation).toBeNull();
    expect(invalidInput.terminalReceipt).toBeNull();

    const notFound = readAutomaticOperation(
      originalLedger,
      { operationId: randomUUID(), attempt: attempt('5') },
      at(5),
    );
    expect(notFound.kind).toBe('not_found');
    expect(notFound.ledger).toBeNull();
    expect(notFound.operation).toBeNull();
    expect(notFound.terminalReceipt).toBeNull();
  });

  it('fails closed on unknown schema/descriptor versions and does not accept existing-policy receipts', () => {
    expect(AutomaticLedgerSchema.safeParse({ version: 2, operations: [] }).success).toBe(false);

    const current = admitted();
    const unknownVersion = admitAutomaticOperation(
      createAutomaticLedger(),
      {
        operationId: randomUUID(),
        identity: current.identity,
        descriptor: descriptor({ semanticVersion: 2 }),
        attempt: attempt(),
      },
      at(3),
    );
    expect(unknownVersion.kind).toBe('invalid_input');

    const existingPolicy = compileAutomaticPolicy({ profileId: 'existing' });
    const invalidTerminal = {
      ...current.operation,
      state: 'committed',
      generation: 1,
      terminalReceipt: {
        version: 1,
        operationId: current.operation.operationId,
        sourceId: current.identity.sourceId,
        sourceHash: current.identity.sourceHash,
        descriptorHash: hash('8'),
        terminalAt: at(2),
        coverage: 'all',
        dependencies: [],
        receipt: {
          version: 1,
          policy: existingPolicy,
          sourceIds: [current.identity.sourceId],
          persisted: true,
          commitAt: at(2),
          items: [],
          coverageComplete: true,
        },
      },
    };
    expect(AutomaticOperationSchema.safeParse(invalidTerminal).success).toBe(false);

    const existingDescriptor = descriptor({ policy: existingPolicy });
    const existing = admitted({ descriptor: existingDescriptor });
    const existingClaim = claimed(
      existing.ledger,
      existing.operation.operationId,
      randomUUID(),
      at(1),
    );
    const existingReceipt = {
      version: 1 as const,
      policy: existingPolicy,
      sourceIds: [existing.identity.sourceId],
      persisted: true,
      commitAt: at(2),
      items: [],
      coverageComplete: true,
    };
    const refusedExisting = completeAutomaticOperation(
      existingClaim.ledger,
      {
        operationId: existing.operation.operationId,
        fence: existingClaim.leaseFence!,
        coverage: 'unknown',
        dependencies: [],
        receipt: existingReceipt,
        attempt: attempt('7'),
      },
      at(2),
    );
    expect(refusedExisting.kind).toBe('invalid_or_unsupported_receipt');
    expect(refusedExisting.shouldProcess).toBe(false);
    expect(refusedExisting.operation?.state).toBe('leased');
  });

  it('rejects corrupt persisted clock order and caps lease duration to the captured deadline rule', () => {
    const current = admitted();
    expect(
      AutomaticOperationSchema.safeParse({
        ...current.operation,
        lastObservedAt: at(-1),
      }).success,
    ).toBe(false);
    expect(
      AutomaticOperationSchema.safeParse({
        ...current.operation,
        attempts: [{ ...current.operation.attempts[0], at: at(1) }],
      }).success,
    ).toBe(false);

    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(10));
    if (firstClaim.operation?.state !== 'leased') throw new Error('Expected leased operation');
    expect(
      AutomaticOperationSchema.safeParse({
        ...firstClaim.operation,
        lease: { ...firstClaim.operation.lease, expiresAt: at(180_010) },
      }).success,
    ).toBe(false);
  });

  it('requires backend time to be monotonic and renews only a live matching generation and token', () => {
    const current = admitted();
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(10));
    const fence = firstClaim.leaseFence!;
    const regressed = renewAutomaticOperation(
      firstClaim.ledger,
      { operationId: current.operation.operationId, fence, attempt: attempt('2') },
      at(9),
    );
    expect(regressed.kind).toBe('clock_regression');
    expect(regressed.ledger).toEqual(firstClaim.ledger);

    const wrongToken = renewAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: { generation: fence.generation, token: randomUUID() },
        attempt: attempt('3'),
      },
      at(11),
    );
    expect(wrongToken.kind).toBe('fenced');
    expect(wrongToken.operation?.state).toBe('leased');

    const renewed = renewAutomaticOperation(
      firstClaim.ledger,
      { operationId: current.operation.operationId, fence, attempt: attempt('4') },
      at(12),
    );
    expect(renewed.kind).toBe('renewed');
    expect(renewed.operation?.state).toBe('leased');
    if (renewed.operation?.state === 'leased') {
      expect(renewed.operation.lease.expiresAt).toBe(at(60_012));
    }
  });

  it('rejects expired completion and permits only explicit, incremented, memory-only resume', () => {
    const current = admitted();
    const initialToken = randomUUID();
    const firstClaim = claimed(current.ledger, current.operation.operationId, initialToken, at(10));
    const initialFence = firstClaim.leaseFence;
    const expiredAt = at(60_010);
    const expiredReceipt = receipt(current.identity.sourceId, expiredAt);
    const expiredCompletion = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: initialFence,
        ...expiredReceipt,
        attempt: attempt('5'),
      },
      expiredAt,
    );
    expect(expiredCompletion.kind).toBe('expired');
    expect(expiredCompletion.shouldProcess).toBe(false);

    const resumed = resumeAutomaticOperation(
      expiredCompletion.ledger,
      {
        operationId: current.operation.operationId,
        expectedGeneration: 1,
        token: randomUUID(),
        attempt: attempt('6'),
      },
      at(60_011),
    );
    expect(resumed.kind).toBe('resumed');
    expect(resumed.shouldProcess).toBe(false);
    expect(resumed.operation?.state).toBe('leased');
    expect(resumed.operation?.generation).toBe(2);
    if (resumed.operation?.state === 'leased') {
      expect(resumed.operation.lease.claimKind).toBe('resume');
    }

    const staleCompletion = completeAutomaticOperation(
      resumed.ledger,
      {
        operationId: current.operation.operationId,
        fence: initialFence,
        ...receipt(current.identity.sourceId, at(60_012)),
        attempt: attempt('7'),
      },
      at(60_012),
    );
    expect(staleCompletion.kind).toBe('fenced');
    expect(staleCompletion.operation?.generation).toBe(2);
    expect(staleCompletion.shouldProcess).toBe(false);

    const resumedFence = resumed.leaseFence;
    const completed = completeAutomaticOperation(
      staleCompletion.ledger,
      {
        operationId: current.operation.operationId,
        fence: resumedFence,
        ...receipt(current.identity.sourceId, at(60_013)),
        attempt: attempt('8'),
      },
      at(60_013),
    );
    expect(completed.kind).toBe('committed');
    expect(completed.shouldProcess).toBe(false);
    expect(completed.eligibleFirstCommit).toBe(false);
  });

  it('resumes failed and interrupted work without retaining state-specific fields', () => {
    for (const [state, failureCode] of [
      ['failed', 'provider_error'],
      ['interrupted', 'invocation_interrupted'],
    ] as const) {
      const current = admitted();
      const firstClaim = claimed(
        current.ledger,
        current.operation.operationId,
        randomUUID(),
        at(1),
      );
      const stopped = failAutomaticOperation(
        firstClaim.ledger,
        {
          operationId: current.operation.operationId,
          fence: firstClaim.leaseFence!,
          state,
          failureCode,
          attempt: attempt('2'),
        },
        at(2),
      );
      expect(stopped.kind).toBe(state);
      expect(stopped.operation?.state).toBe(state);

      const resumed = resumeAutomaticOperation(
        stopped.ledger,
        {
          operationId: current.operation.operationId,
          expectedGeneration: 1,
          token: randomUUID(),
          attempt: attempt('3'),
        },
        at(3),
      );
      expect(resumed.kind).toBe('resumed');
      expect(resumed.operation?.state).toBe('leased');
      expect(resumed.operation?.generation).toBe(2);
      expect(resumed.operation).not.toHaveProperty('failureCode');
      expect(resumed.operation).not.toHaveProperty('failedAt');
      expect(resumed.operation).not.toHaveProperty('interruptedAt');
      expect(resumed.shouldProcess).toBe(false);
    }
  });

  it('can cancel failed work and represents legacy sources as receipt-unavailable without processing', () => {
    const current = admitted();
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(1));
    const stopped = failAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        state: 'failed',
        failureCode: 'provider_error',
        attempt: attempt('2'),
      },
      at(2),
    );
    const cancelledReceipt = receipt(current.identity.sourceId, at(3), 'proposed');
    const cancelled = cancelAutomaticOperation(
      stopped.ledger,
      {
        operationId: current.operation.operationId,
        expectedGeneration: 1,
        ...cancelledReceipt,
        attempt: attempt('3'),
      },
      at(3),
    );
    expect(cancelled.kind).toBe('cancelled');
    expect(cancelled.operation?.state).toBe('cancelled');
    expect(cancelled.operation).not.toHaveProperty('failureCode');

    const legacyIdentity = identity({ turn: 'legacy-turn' });
    const legacy = observeLegacyUnconfirmed(
      createAutomaticLedger(),
      { operationId: randomUUID(), identity: legacyIdentity, attempt: attempt('4') },
      at(),
    );
    expect(legacy.kind).toBe('original_receipt_unavailable');
    expect(legacy.operation?.state).toBe('legacy_unconfirmed');
    expect(legacy.terminalReceipt).toBeNull();
    expect(legacy.shouldProcess).toBe(false);
    const replay = readAutomaticOperation(
      legacy.ledger,
      { operationId: legacy.operation!.operationId, attempt: attempt('5') },
      at(3),
    );
    expect(replay.kind).toBe('original_receipt_unavailable');
    expect(replay.terminalReceipt).toBeNull();
    expect(replay.shouldProcess).toBe(false);
  });

  it('returns the original committed receipt on replay without granting another processing permit', () => {
    const current = admitted();
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(10));
    const finalReceipt = receipt(current.identity.sourceId, at(20));
    const completed = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence,
        ...finalReceipt,
        attempt: attempt('1'),
      },
      at(20),
    );
    expect(completed.kind).toBe('committed');
    expect(completed.shouldProcess).toBe(false);
    expect(completed.eligibleFirstCommit).toBe(true);
    const immutableReceipt = completed.terminalReceipt;

    const replay = readAutomaticOperation(
      completed.ledger,
      { operationId: current.operation.operationId, attempt: attempt('2') },
      at(21),
    );
    expect(replay.kind).toBe('committed_replay');
    expect(replay.shouldProcess).toBe(false);
    expect(replay.terminalReceipt).toEqual(immutableReceipt);
    expect(replay.currentAuthority).toBe('not_evaluated');
    expect(replay.terminalReceipt?.receipt.items[0].state).toBe('accepted');
  });

  it('keeps the existing v1 not-selected coverageComplete value unchanged', () => {
    const current = admitted();
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(10));
    const notSelectedReceipt = {
      version: 1 as const,
      policy,
      sourceIds: [current.identity.sourceId],
      persisted: true,
      commitAt: at(20),
      items: [
        {
          state: 'not_selected' as const,
          persisted: false,
          mutation: 'none' as const,
          reasons: ['not_selected' as const],
        },
      ],
      coverageComplete: true,
    };
    const completed = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        coverage: 'none',
        dependencies: [
          {
            dependencyHash: hash('f'),
            itemIndex: 0,
            state: 'not_selected',
            persisted: false,
            reasons: ['not_selected'],
          },
        ],
        receipt: notSelectedReceipt,
        attempt: attempt('1'),
      },
      at(20),
    );
    expect(completed.kind).toBe('committed');
    expect(completed.eligibleFirstCommit).toBe(true);
    expect(completed.terminalReceipt?.receipt.coverageComplete).toBe(true);
    expect(completed.terminalReceipt?.coverage).toBe('none');
  });

  it('pairs idless proposed and deferred receipt items by bounded item index and rejects extra sources', () => {
    const current = admitted();
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(10));
    const idlessReceipt = {
      version: 1 as const,
      policy,
      sourceIds: [current.identity.sourceId],
      persisted: true,
      commitAt: at(20),
      items: [
        {
          state: 'proposed' as const,
          persisted: false,
          mutation: 'pending' as const,
          reasons: ['review_required' as const],
        },
        {
          state: 'deferred' as const,
          persisted: false,
          mutation: 'none' as const,
          reasons: ['capacity' as const],
        },
      ],
      coverageComplete: true,
    };
    const completion = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        coverage: 'none',
        dependencies: [
          {
            dependencyHash: hash('1'),
            itemIndex: 0,
            state: 'proposed',
            persisted: false,
            reasons: ['review_required'],
          },
          {
            dependencyHash: hash('2'),
            itemIndex: 1,
            state: 'deferred',
            persisted: false,
            reasons: ['capacity'],
          },
        ],
        receipt: idlessReceipt,
        attempt: attempt('4'),
      },
      at(20),
    );
    expect(completion.kind).toBe('committed');
    expect(completion.terminalReceipt?.receipt.items.map((item) => item.state)).toEqual([
      'proposed',
      'deferred',
    ]);

    const acceptedReceipt = receipt(current.identity.sourceId, at(20));
    const extraSource = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        ...acceptedReceipt,
        receipt: {
          ...acceptedReceipt.receipt,
          sourceIds: [current.identity.sourceId, randomUUID()],
        },
        attempt: attempt('5'),
      },
      at(20),
    );
    expect(extraSource.kind).toBe('invalid_or_unsupported_receipt');
    expect(extraSource.shouldProcess).toBe(false);
  });

  it('rejects mismatched item persistence, duplicate item indexes, and duplicate claim IDs', () => {
    const current = admitted();
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(10));
    const proposed = receipt(current.identity.sourceId, at(20), 'proposed');
    const mismatchedPersistence = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        ...proposed,
        dependencies: [{ ...proposed.dependencies[0], persisted: false }],
        attempt: attempt('6'),
      },
      at(20),
    );
    expect(mismatchedPersistence.kind).toBe('invalid_or_unsupported_receipt');

    const idlessItems = {
      version: 1 as const,
      policy,
      sourceIds: [current.identity.sourceId],
      persisted: true,
      commitAt: at(20),
      items: [
        {
          state: 'proposed' as const,
          persisted: false,
          mutation: 'pending' as const,
          reasons: ['review_required' as const],
        },
        {
          state: 'deferred' as const,
          persisted: false,
          mutation: 'none' as const,
          reasons: ['capacity' as const],
        },
      ],
      coverageComplete: true,
    };
    const duplicateIndex = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        coverage: 'none',
        receipt: idlessItems,
        dependencies: [
          {
            dependencyHash: hash('1'),
            itemIndex: 0,
            state: 'proposed',
            persisted: false,
            reasons: ['review_required'],
          },
          {
            dependencyHash: hash('2'),
            itemIndex: 0,
            state: 'deferred',
            persisted: false,
            reasons: ['capacity'],
          },
        ],
        attempt: attempt('7'),
      },
      at(20),
    );
    expect(duplicateIndex.kind).toBe('invalid_or_unsupported_receipt');

    const duplicateClaimId = randomUUID();
    const duplicateClaimReceipt = {
      version: 1 as const,
      policy,
      sourceIds: [current.identity.sourceId],
      persisted: true,
      commitAt: at(20),
      items: [
        {
          claimId: duplicateClaimId,
          state: 'accepted' as const,
          persisted: true,
          mutation: 'created' as const,
          reasons: ['selected' as const],
        },
        {
          claimId: duplicateClaimId,
          state: 'proposed' as const,
          persisted: true,
          mutation: 'pending' as const,
          reasons: ['review_required' as const],
        },
      ],
      coverageComplete: true,
    };
    const duplicateClaim = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        coverage: 'partial',
        receipt: duplicateClaimReceipt,
        dependencies: [
          {
            dependencyHash: hash('3'),
            claimId: duplicateClaimId,
            itemIndex: 0,
            state: 'accepted',
            persisted: true,
            reasons: ['selected'],
          },
          {
            dependencyHash: hash('4'),
            claimId: duplicateClaimId,
            itemIndex: 1,
            state: 'proposed',
            persisted: true,
            reasons: ['review_required'],
          },
        ],
        attempt: attempt('8'),
      },
      at(20),
    );
    expect(duplicateClaim.kind).toBe('invalid_or_unsupported_receipt');
  });

  it('keeps cancellation terminal, non-accepted, and unable to grant processing permission', () => {
    const current = admitted();
    const deferred = receipt(current.identity.sourceId, at(20), 'proposed');
    deferred.receipt.coverageComplete = false;
    const cancelled = cancelAutomaticOperation(
      current.ledger,
      {
        operationId: current.operation.operationId,
        expectedGeneration: 0,
        ...deferred,
        attempt: attempt('1'),
      },
      at(20),
    );
    expect(cancelled.kind).toBe('cancelled');
    expect(cancelled.operation?.state).toBe('cancelled');
    expect(cancelled.shouldProcess).toBe(false);

    const replay = readAutomaticOperation(
      cancelled.ledger,
      { operationId: current.operation.operationId, attempt: attempt('2') },
      at(21),
    );
    expect(replay.kind).toBe('cancelled');
    expect(replay.shouldProcess).toBe(false);
    expect(replay.terminalReceipt).toEqual(cancelled.terminalReceipt);
  });

  it('returns committed receipts when attempt audit is full and saturates the overflow counter', () => {
    const current = admitted();
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(10));
    const completed = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence,
        ...receipt(current.identity.sourceId, at(20)),
        attempt: attempt('1'),
      },
      at(20),
    );
    let ledger = completed.ledger;
    let readResult = completed;
    for (let index = 0; index < AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation; index += 1) {
      readResult = readAutomaticOperation(
        ledger,
        {
          operationId: current.operation.operationId,
          attempt: { attemptHash: hash(((index % 9) + 1).toString()) },
        },
        at(21 + index),
      );
      ledger = readResult.ledger;
    }
    const receiptBeforeOverflow = readResult.terminalReceipt;
    const full = readAutomaticOperation(
      ledger,
      { operationId: current.operation.operationId, attempt: attempt('9') },
      at(60),
    );
    expect(full.kind).toBe('committed_replay');
    expect(full.attemptAudit).toBe('capacity_reached');
    expect(full.shouldProcess).toBe(false);
    expect(full.terminalReceipt).toEqual(receiptBeforeOverflow);
    expect(full.operation?.attempts).toHaveLength(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation);
    expect(full.operation?.overflowCount).toBeGreaterThan(0);

    const saturated = {
      ...full.operation,
      overflowCount: AUTOMATIC_LEDGER_LIMITS.overflowCounterMax,
    };
    const parsedSaturated = AutomaticOperationSchema.safeParse(saturated);
    expect(parsedSaturated.success).toBe(true);
    const saturatedLedger = AutomaticLedgerSchema.parse({
      version: 1,
      operations: [parsedSaturated.data],
    });
    const noWrap = readAutomaticOperation(
      saturatedLedger,
      { operationId: current.operation.operationId, attempt: attempt('8') },
      at(61),
    );
    expect(noWrap.operation?.overflowCount).toBe(AUTOMATIC_LEDGER_LIMITS.overflowCounterMax);
    expect(noWrap.terminalReceipt).toEqual(receiptBeforeOverflow);
  });

  it('keeps terminal receipts readable near the namespace byte cap and refuses new admission', () => {
    const candidates = Array.from(
      { length: AUTOMATIC_LEDGER_LIMITS.operationsPerNamespace },
      (_, index) => committedUnknownOperation(index),
    );
    let low = 1;
    let high = candidates.length;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const bytes = Buffer.byteLength(
        JSON.stringify({ version: 1, operations: candidates.slice(0, middle) }),
        'utf8',
      );
      if (bytes <= AUTOMATIC_LEDGER_LIMITS.namespaceBytes) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const raw = { version: 1 as const, operations: candidates.slice(0, best) };
    const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    expect(bytes).toBeGreaterThan(AUTOMATIC_LEDGER_LIMITS.namespaceBytes - 2_000);
    const valid = AutomaticLedgerSchema.safeParse(raw);
    expect(valid.success).toBe(true);
    if (!valid.success) return;

    const denied = admitAutomaticOperation(
      valid.data,
      {
        operationId: randomUUID(),
        identity: identity({
          namespace: 'near-cap',
          issuer: 'i',
          actorReference: 'a',
          turn: 'capacity-last',
        }),
        descriptor: descriptor(),
        attempt: attempt('1'),
      },
      at(3),
    );
    expect(denied.kind).toBe('capacity');
    expect(denied.shouldProcess).toBe(false);
    expect(denied.saved).toBe(false);
    expect(denied.ledger?.operations).toHaveLength(best);

    const storedReceipt =
      valid.data.operations[0].state === 'committed'
        ? valid.data.operations[0].terminalReceipt
        : null;
    const read = readAutomaticOperation(
      valid.data,
      { operationId: valid.data.operations[0].operationId, attempt: attempt('9') },
      at(3),
    );
    expect(read.kind).toBe('committed_replay');
    expect(read.shouldProcess).toBe(false);
    expect(read.attemptAudit).toBe('capacity_reached');
    expect(read.terminalReceipt).toEqual(storedReceipt);
  });

  it('does not create a second lease owner for durable memory-only descriptors', () => {
    const current = admitted({ descriptor: descriptor({ executionMode: 'durable_memory_only' }) });
    const result = claimAutomaticOperation(
      current.ledger,
      { operationId: current.operation.operationId, token: randomUUID(), attempt: attempt() },
      at(1),
    );
    expect(result.kind).toBe('unsupported_durable_linkage');
    expect(result.operation?.state).toBe('captured');
    expect(result.shouldProcess).toBe(false);
  });

  it('withholds terminal preference receipts for assistant-role source ownership', () => {
    const current = admitted({ identity: identity({ role: 'assistant' }) });
    const firstClaim = claimed(current.ledger, current.operation.operationId, randomUUID(), at(1));
    const refused = completeAutomaticOperation(
      firstClaim.ledger,
      {
        operationId: current.operation.operationId,
        fence: firstClaim.leaseFence!,
        ...receipt(current.identity.sourceId, at(2)),
        attempt: attempt('3'),
      },
      at(2),
    );
    expect(refused.kind).toBe('invalid_or_unsupported_receipt');
    expect(refused.shouldProcess).toBe(false);
    expect(refused.operation?.state).toBe('leased');
  });
});
