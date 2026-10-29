import { randomUUID } from 'crypto';
import { buildAutomaticOperationDescriptorV2 } from '../../../src/extraction/AutomaticCaptureDescriptor';
import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import {
  AutomaticLedgerSchema,
  AutomaticOperationDescriptorSchema,
  type AutomaticOperation,
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

const timestamp = '2026-10-25T12:00:00.000Z';
const digest = (letter: string) => letter.repeat(64);
const policy = compileAutomaticPolicy({ profileId: 'explicit' });
const replaySafeDescriptor = buildAutomaticOperationDescriptorV2({
  purpose: 'human_turn_memory',
  profileId: 'explicit',
  requestedTrustLevel: 'standard',
  intentSetting: true,
  invocationDeadlineMs: 15_000,
}).descriptor;
const binding = {
  bindingId: 'c4dcb624-1eef-47c3-8888-79ced532bc50',
  revision: 2,
  subjectId: '124b6af9-2b89-4e80-b052-373197a3e1c5',
  fingerprint: digest('b'),
};
type MutableOperation = Record<string, unknown> & { identity: Record<string, unknown> };

function v2Captured(overrides: Record<string, unknown> = {}) {
  const operationId = randomUUID();
  const identity = {
    lifecycle: 'replaySafeV2',
    storeHash: digest('a'),
    namespace: 'mixed-ledger-tests',
    issuer: 'test-workflow',
    actorReference: 'actor-1',
    turn: 'v2-turn',
    role: 'human',
    purpose: 'human_turn_memory',
    sourceId: randomUUID(),
    sourceHash: digest('c'),
    originalProducerHash: digest('d'),
    stableProducerHash: digest('e'),
    requestedAuthorityHash: digest('f'),
    binding,
  };
  return {
    version: 2,
    operationId,
    identity,
    descriptor: replaySafeDescriptor,
    createdAt: timestamp,
    lastObservedAt: timestamp,
    attempts: [],
    overflowCount: 0,
    beginCallHash: digest('1'),
    retryCount: 0,
    state: 'captured',
    generation: 0,
    ...overrides,
  };
}

function v1Captured(overrides: Record<string, unknown> = {}) {
  const identity = {
    storeHash: digest('a'),
    namespace: 'mixed-ledger-tests',
    issuer: 'test-workflow',
    actorReference: 'legacy-actor',
    turn: 'v1-turn',
    role: 'human' as const,
    sourceId: randomUUID(),
    sourceHash: digest('2'),
    originalProducerHash: digest('3'),
    binding: null,
  };
  const descriptor = AutomaticOperationDescriptorSchema.parse({
    version: 1,
    interpreterId: 'literal-parser-v1',
    executionMode: 'synchronous',
    semanticVersion: 1,
    grammarVersion: 1,
    lexiconVersion: 1,
    invocationDeadlineMs: 15_000,
    routeConfigHash: digest('4'),
    policy,
  });
  return {
    version: 1,
    operationId: randomUUID(),
    identity,
    descriptor,
    createdAt: timestamp,
    lastObservedAt: timestamp,
    attempts: [],
    overflowCount: 0,
    state: 'captured',
    generation: 0,
    ...overrides,
  } satisfies AutomaticOperation;
}

describe('mixed automatic operation ledger', () => {
  it('parses and preserves the exact v1/v2 operation records in one bounded root', () => {
    const legacy = v1Captured();
    const replaySafe = v2Captured();
    const ledger = AutomaticLedgerSchema.parse({ version: 1, operations: [legacy, replaySafe] });

    expect(ledger.operations).toEqual([legacy, replaySafe]);
    expect(JSON.stringify(ledger.operations[1])).toBe(JSON.stringify(replaySafe));
  });

  it.each([
    [
      'operation ID',
      (legacy: MutableOperation, replaySafe: MutableOperation) => {
        legacy.operationId = replaySafe.operationId;
      },
    ],
    [
      'source ID',
      (legacy: MutableOperation, replaySafe: MutableOperation) => {
        legacy.identity.sourceId = replaySafe.identity.sourceId;
      },
    ],
    [
      'namespace/turn/role locator',
      (legacy: MutableOperation, replaySafe: MutableOperation) => {
        legacy.identity.namespace = replaySafe.identity.namespace;
        legacy.identity.turn = replaySafe.identity.turn;
        legacy.identity.role = replaySafe.identity.role;
      },
    ],
  ])('rejects a cross-version duplicate %s', (_label, duplicate) => {
    const legacy = v1Captured() as unknown as MutableOperation;
    const replaySafe = v2Captured() as unknown as MutableOperation;
    duplicate(legacy, replaySafe);
    expect(
      AutomaticLedgerSchema.safeParse({ version: 1, operations: [legacy, replaySafe] }).success,
    ).toBe(false);
  });

  it('lets a v1 transition update one v1 record without changing a v2 record', () => {
    const first = v1Captured();
    const second = v1Captured({
      operationId: randomUUID(),
      identity: { ...first.identity, turn: 'other-v1-turn', sourceId: randomUUID() },
    });
    const replaySafe = v2Captured();
    const mixed = AutomaticLedgerSchema.parse({
      version: 1,
      operations: [first, second, replaySafe],
    });
    const beforeV2 = JSON.stringify(mixed.operations.find((op) => op.version === 2));
    const changed = admitAutomaticOperation(
      mixed,
      {
        operationId: second.operationId,
        identity: second.identity,
        descriptor: second.descriptor!,
        attempt: { attemptHash: digest('5') },
      },
      '2026-10-25T12:00:01.000Z',
    );

    expect(changed.kind).toBe('in_progress');
    expect(changed.ledger?.operations.find((op) => op.version === 2)).toEqual(replaySafe);
    expect(JSON.stringify(changed.ledger?.operations.find((op) => op.version === 2))).toBe(
      beforeV2,
    );
  });

  it('reserves receipt capacity for active v2 records when admitting a v1 operation', () => {
    const activeV2 = Array.from({ length: 640 }, (_, index) => {
      const base = v2Captured();
      return {
        ...base,
        identity: {
          ...base.identity,
          turn: `v2-turn-${index}`,
          sourceId: randomUUID(),
        },
      };
    });
    const mixed = AutomaticLedgerSchema.parse({ version: 1, operations: activeV2 });
    const proposed = v1Captured();
    const result = admitAutomaticOperation(
      mixed,
      {
        operationId: randomUUID(),
        identity: { ...proposed.identity, namespace: activeV2[0].identity.namespace },
        descriptor: proposed.descriptor,
        attempt: { attemptHash: digest('a') },
      },
      '2026-10-25T12:00:01.000Z',
    );

    expect(result.kind).toBe('capacity');
    expect(result.ledger).toEqual(mixed);
    expect(result.attemptAudit).toBe('capacity_reached');
  });

  it('returns only a private conflict at a v2 locator without touching audit state', () => {
    const replaySafe = v2Captured();
    const input = {
      operationId: randomUUID(),
      identity: {
        storeHash: digest('a'),
        namespace: replaySafe.identity.namespace,
        issuer: replaySafe.identity.issuer,
        actorReference: replaySafe.identity.actorReference,
        turn: replaySafe.identity.turn,
        role: 'human',
        sourceId: randomUUID(),
        sourceHash: digest('6'),
        originalProducerHash: digest('7'),
        binding,
      },
      descriptor: buildAutomaticOperationDescriptorV2({
        purpose: 'human_turn_memory',
        profileId: 'explicit',
        requestedTrustLevel: 'standard',
        intentSetting: true,
        invocationDeadlineMs: 15_000,
      }).descriptor,
      attempt: { attemptHash: digest('8') },
    };
    const ledger = AutomaticLedgerSchema.parse({ version: 1, operations: [replaySafe] });
    const admitted = admitAutomaticOperation(ledger, input, '2026-10-25T12:00:01.000Z');
    const observed = observeLegacyUnconfirmed(
      ledger,
      { operationId: randomUUID(), identity: input.identity, attempt: input.attempt },
      '2026-10-25T12:00:01.000Z',
    );

    for (const result of [admitted, observed]) {
      expect(result.kind).toBe('conflict');
      expect(result.ledger).toBeNull();
      expect(result.operation).toBeNull();
      expect(result.terminalReceipt).toBeNull();
      expect(result.attemptAudit).toBe('not_recorded');
    }
    expect(ledger.operations[0]).toEqual(replaySafe);
  });

  it('keeps every v1 operation-ID API private when it targets a v2 operation', () => {
    const replaySafe = v2Captured();
    const ledger = AutomaticLedgerSchema.parse({ version: 1, operations: [replaySafe] });
    const attempt = { attemptHash: digest('9') };
    const fence = { generation: 1, token: randomUUID() };
    const receipt = {
      version: 1 as const,
      policy: replaySafe.descriptor.policy,
      sourceIds: [replaySafe.identity.sourceId],
      persisted: true,
      commitAt: '2026-10-25T12:00:01.000Z',
      items: [],
      coverageComplete: true,
    };
    const results = [
      claimAutomaticOperation(
        ledger,
        { operationId: replaySafe.operationId, token: randomUUID(), attempt },
        '2026-10-25T12:00:01.000Z',
      ),
      renewAutomaticOperation(
        ledger,
        { operationId: replaySafe.operationId, fence, attempt },
        '2026-10-25T12:00:01.000Z',
      ),
      completeAutomaticOperation(
        ledger,
        {
          operationId: replaySafe.operationId,
          fence,
          attempt,
          coverage: 'unknown',
          dependencies: [],
          receipt,
        },
        '2026-10-25T12:00:01.000Z',
      ),
      failAutomaticOperation(
        ledger,
        {
          operationId: replaySafe.operationId,
          fence,
          attempt,
          state: 'failed',
          failureCode: 'unknown',
        },
        '2026-10-25T12:00:01.000Z',
      ),
      resumeAutomaticOperation(
        ledger,
        {
          operationId: replaySafe.operationId,
          expectedGeneration: 0,
          token: randomUUID(),
          attempt,
        },
        '2026-10-25T12:00:01.000Z',
      ),
      cancelAutomaticOperation(
        ledger,
        {
          operationId: replaySafe.operationId,
          expectedGeneration: 0,
          attempt,
          coverage: 'unknown',
          dependencies: [],
          receipt,
        },
        '2026-10-25T12:00:01.000Z',
      ),
      readAutomaticOperation(
        ledger,
        { operationId: replaySafe.operationId, attempt },
        '2026-10-25T12:00:01.000Z',
      ),
    ];

    for (const result of results) {
      expect(result).toMatchObject({
        kind: 'conflict',
        ledger: null,
        operation: null,
        terminalReceipt: null,
        attemptAudit: 'not_recorded',
      });
      const output = JSON.stringify(result);
      for (const privateValue of [
        replaySafe.operationId,
        replaySafe.identity.sourceId,
        replaySafe.identity.sourceHash,
        replaySafe.identity.originalProducerHash,
        replaySafe.identity.stableProducerHash,
        replaySafe.identity.requestedAuthorityHash,
        replaySafe.descriptor.settingsHash,
        replaySafe.beginCallHash,
      ]) {
        expect(output).not.toContain(privateValue);
      }
    }
    expect(ledger.operations[0]).toEqual(replaySafe);
    expect(ledger.operations[0]).toMatchObject({
      lastObservedAt: timestamp,
      attempts: [],
    });
  });

  it('rejects unknown operation versions before accepting the root', () => {
    expect(
      AutomaticLedgerSchema.safeParse({
        version: 1,
        operations: [{ ...v2Captured(), version: 3 }],
      }).success,
    ).toBe(false);
    expect(
      AutomaticLedgerSchema.safeParse({
        version: 1,
        operations: [{ ...v2Captured(), state: 'future_state' }],
      }).success,
    ).toBe(false);
    expect(createAutomaticLedger()).toEqual({ version: 1, operations: [] });
  });
});
