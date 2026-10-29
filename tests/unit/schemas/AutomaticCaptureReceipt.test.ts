import { randomUUID } from 'crypto';
import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../../../src/schemas/AutomaticCaptureReceipt.schema';

function fixture() {
  const sourceId = randomUUID();
  const claimId = randomUUID();
  const terminalAt = '2026-10-25T10:00:00.000Z';
  const item = {
    claimId,
    state: 'accepted',
    persisted: true,
    mutation: 'created',
    reasons: ['selected'],
  };
  return {
    version: 2,
    kind: 'human_capture_committed',
    operationId: randomUUID(),
    sourceId,
    sourceHash: 'a'.repeat(64),
    descriptorHash: 'b'.repeat(64),
    terminalAt,
    receiptInspectionComplete: true,
    interpretationCoverage: 'complete',
    acceptedCoverage: 'all',
    dependencies: [
      {
        sourceId,
        dependencyHash: 'c'.repeat(64),
        itemIndex: 0,
        claimId,
        state: item.state,
        persisted: item.persisted,
        reasons: item.reasons,
      },
    ],
    receipt: {
      version: 1,
      policy: structuredClone(compileAutomaticPolicy({ profileId: 'conservative' })),
      sourceIds: [sourceId],
      persisted: true,
      commitAt: terminalAt,
      items: [item],
      coverageComplete: true,
    },
  };
}

describe('automatic capture v2 terminal receipt structural contract', () => {
  it('preserves the embedded v1 receipt exactly and grants no processing permission', () => {
    const input = fixture();
    const original = structuredClone(input.receipt);
    const parsed = AutomaticCaptureTerminalReceiptV2Schema.parse(input);
    expect(parsed.kind).toBe('human_capture_committed');
    if (parsed.kind === 'human_capture_committed') expect(parsed.receipt).toEqual(original);
    expect(parsed).not.toHaveProperty('should_process');
  });

  it.each([
    ['source', (v: ReturnType<typeof fixture>) => (v.dependencies[0].sourceId = randomUUID())],
    ['source list', (v: ReturnType<typeof fixture>) => v.receipt.sourceIds.push(randomUUID())],
    ['time', (v: ReturnType<typeof fixture>) => (v.receipt.commitAt = '2026-10-25T11:00:00.000Z')],
    ['persisted', (v: ReturnType<typeof fixture>) => (v.receipt.persisted = false)],
    ['inspection', (v: ReturnType<typeof fixture>) => (v.receiptInspectionComplete = false)],
    ['coverage', (v: ReturnType<typeof fixture>) => (v.acceptedCoverage = 'none')],
    ['claim', (v: ReturnType<typeof fixture>) => (v.dependencies[0].claimId = randomUUID())],
    ['index', (v: ReturnType<typeof fixture>) => (v.dependencies[0].itemIndex = 1)],
    ['state', (v: ReturnType<typeof fixture>) => (v.dependencies[0].state = 'proposed')],
    [
      'reasons',
      (v: ReturnType<typeof fixture>) => (v.dependencies[0].reasons = ['review_required']),
    ],
    ['policy', (v: ReturnType<typeof fixture>) => (v.receipt.policy.autoAccept = false)],
  ])('rejects mismatched %s', (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(input).success).toBe(false);
  });

  it('rejects empty or duplicated item dependencies and repeated accepted IDs', () => {
    const empty = fixture();
    empty.receipt.items = [];
    empty.dependencies = [];
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(empty).success).toBe(false);
    const duplicate = fixture();
    duplicate.dependencies.push(structuredClone(duplicate.dependencies[0]));
    duplicate.receipt.items.push(structuredClone(duplicate.receipt.items[0]));
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(duplicate).success).toBe(false);
    duplicate.dependencies[1].itemIndex = 1;
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(duplicate).success).toBe(false);
  });

  it('covers an idless no-fact result without claiming accepted knowledge', () => {
    const input = fixture();
    const item = {
      state: 'not_selected',
      persisted: false,
      mutation: 'none',
      reasons: ['unsupported_topic'],
    };
    const value = {
      ...input,
      interpretationCoverage: 'unknown',
      acceptedCoverage: 'none',
      dependencies: [
        {
          sourceId: input.sourceId,
          dependencyHash: 'c'.repeat(64),
          itemIndex: 0,
          state: item.state,
          persisted: item.persisted,
          reasons: item.reasons,
        },
      ],
      receipt: { ...input.receipt, items: [item] },
    };
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(value).success).toBe(true);
    expect(
      AutomaticCaptureTerminalReceiptV2Schema.safeParse({ ...value, acceptedCoverage: 'all' })
        .success,
    ).toBe(false);
  });

  it('keeps assistant and cancellation receipts strictly write-only', () => {
    const input = fixture();
    const { version, operationId, sourceId, sourceHash, descriptorHash, terminalAt } = input;
    const base = { version, operationId, sourceId, sourceHash, descriptorHash, terminalAt };
    const assistant = { ...base, kind: 'assistant_final_saved', persisted: true };
    const cancelled = { ...base, kind: 'cancelled', acceptedCoverage: 'none' };
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(assistant).success).toBe(true);
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(cancelled).success).toBe(true);
    for (const value of [assistant, cancelled]) {
      expect(
        AutomaticCaptureTerminalReceiptV2Schema.safeParse({ ...value, receipt: input.receipt })
          .success,
      ).toBe(false);
      expect(
        AutomaticCaptureTerminalReceiptV2Schema.safeParse({ ...value, should_process: true })
          .success,
      ).toBe(false);
    }
  });

  it('derives partial coverage without treating proposals as accepted facts', () => {
    const input = fixture();
    const proposed = {
      ...input.receipt.items[0],
      claimId: randomUUID(),
      state: 'proposed',
      reasons: ['review_required'],
    };
    input.receipt.items.push(proposed);
    input.dependencies.push({
      ...input.dependencies[0],
      itemIndex: 1,
      claimId: proposed.claimId,
      state: proposed.state,
      reasons: proposed.reasons,
    });
    input.acceptedCoverage = 'partial';
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(input).success).toBe(true);
    input.acceptedCoverage = 'all';
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(input).success).toBe(false);
  });

  it('bounds the complete wrapper, including every dependency and nested v1 item', () => {
    const input = fixture();
    input.receipt.items = [];
    input.dependencies = [];
    for (let index = 0; index < 32; index++) {
      const claimId = randomUUID();
      const reasons = Array(8).fill('review_required') as string[];
      input.receipt.items.push({
        claimId,
        state: 'accepted',
        persisted: true,
        mutation: 'created',
        reasons,
      });
      input.dependencies.push({
        sourceId: input.sourceId,
        dependencyHash: 'c'.repeat(64),
        itemIndex: index,
        claimId,
        state: 'accepted',
        persisted: true,
        reasons,
      });
    }
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(16 * 1024);
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(input).success).toBe(false);
  });

  it.each(['pending', 'none'])('rejects an accepted item with mutation %s', (mutation) => {
    const input = fixture();
    input.receipt.items[0].mutation = mutation;
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(input).success).toBe(false);
  });

  it.each(['unknown', 'none', 'partial'])(
    'rejects supported claim with %s interpretation',
    (interpretationCoverage) => {
      expect(
        AutomaticCaptureTerminalReceiptV2Schema.safeParse({ ...fixture(), interpretationCoverage })
          .success,
      ).toBe(false);
    },
  );

  it('rejects persisted no-selection and keeps known absence distinct from unknown meaning', () => {
    const input = fixture();
    const item = {
      state: 'not_selected',
      persisted: false,
      mutation: 'none',
      reasons: ['no_preference_clause'],
    };
    const value = {
      ...input,
      interpretationCoverage: 'none',
      acceptedCoverage: 'none',
      dependencies: [
        {
          sourceId: input.sourceId,
          dependencyHash: 'c'.repeat(64),
          itemIndex: 0,
          state: item.state,
          persisted: item.persisted,
          reasons: item.reasons,
        },
      ],
      receipt: { ...input.receipt, items: [item] },
    };
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(value).success).toBe(true);
    expect(
      AutomaticCaptureTerminalReceiptV2Schema.safeParse({
        ...value,
        interpretationCoverage: 'unknown',
      }).success,
    ).toBe(false);
    item.persisted = true;
    value.dependencies[0].persisted = true;
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(value).success).toBe(false);
  });

  it('rejects a falsely created unchanged claim and incomplete inspection', () => {
    const unchanged = fixture();
    unchanged.receipt.items[0].state = 'unchanged';
    unchanged.dependencies[0].state = 'unchanged';
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(unchanged).success).toBe(false);
    unchanged.receipt.items[0].mutation = 'none';
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(unchanged).success).toBe(true);
    unchanged.receipt.coverageComplete = false;
    unchanged.receiptInspectionComplete = false;
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(unchanged).success).toBe(false);
  });

  it.each([
    'clause_too_long',
    'object_too_long',
    'too_many_claims',
    'capacity',
    'invalid_envelope',
    'content_mismatch',
    'incomplete_mapping',
    'source_changed',
    'binding_changed',
    'missing_binding',
    'interrupted',
  ])('rejects successful terminal state containing failure %s', (reason) => {
    const input = fixture();
    input.receipt.items[0].reasons = [reason];
    input.dependencies[0].reasons = [reason];
    expect(AutomaticCaptureTerminalReceiptV2Schema.safeParse(input).success).toBe(false);
  });
});
