import { primaryCompositionalBundleReceiptReasonV3 as primary } from '../../../src/storage/CompositionalBundleReceiptReasonV3';
import { CompositionalAutomaticCaptureTerminalReceiptV3Schema as receiptSchema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';

const hash = 'a'.repeat(64);
const id = '11111111-1111-4111-8111-111111111111';
const common = {
  bundleIndex: 0,
  bundleHash: hash,
  meaningHash: hash,
  semanticKey: hash,
  predicateDependencies: [{ predicateIndex: 0, dependencyHash: hash }],
  codes: ['eligible_create'],
};
const ids = { claimId: id, valueId: id };
const sourceReceipt = (state: string, mutation: string, reason?: string) => ({
  version: 3,
  kind: 'human_compositional_capture_committed',
  operationId: id,
  sourceId: id,
  sourceHash: hash,
  descriptorHash: hash,
  policyFingerprint: hash,
  terminalAt: '2026-10-26T10:00:00.000Z',
  reasons: [],
  interpretationCoverage: 'complete',
  acceptedCoverage: state === 'accepted' || state === 'unchanged' ? 'all' : 'none',
  selection: {
    kind: 'bundles',
    items: [
      {
        bundleIndex: 0,
        bundleHash: hash,
        meaningHash: hash,
        predicateDependencies: common.predicateDependencies,
        state,
        mutation,
        persisted: state !== 'not_selected',
        ...(state !== 'not_selected' ? { claimId: id } : {}),
        ...(reason === undefined ? {} : { reason }),
      },
    ],
  },
});

describe('persisted primary whole-bundle receipt diagnostics', () => {
  it.each([
    ['create_accepted', 'eligible_create'],
    ['create_proposed', 'profile_review_required'],
    ['reference_accepted', 'existing_accepted'],
    ['reference_proposed', 'existing_proposed'],
    ['reference_rejected', 'existing_rejected'],
  ])('maps %s to its fixed primary reason', (decision, reason) => {
    expect(
      primary({
        ...common,
        ...ids,
        decision,
        ...(decision.startsWith('reference') ? { referenceGuardHash: hash } : {}),
      }),
    ).toBe(reason);
  });
  it.each(['accepted', 'proposed'])(
    'reports a prepared repeated %s state truthfully',
    (intendedReview) => {
      expect(
        primary({
          ...common,
          ...ids,
          decision: 'reference_prepared',
          primaryBundleIndex: 0,
          intendedReview,
        }),
      ).toBe(`existing_${intendedReview}`);
    },
  );
  it('uses fixed policy-first blocker priority independent of incoming code order', () => {
    const codes = [
      'unknown_overlap_domain',
      'possible_overlap',
      'legacy_reuse_not_authorized',
      'existing_ineligible',
      'explicit_intent_required',
    ];
    expect(primary({ ...common, decision: 'not_selected', codes })).toBe(
      'explicit_intent_required',
    );
    expect(primary({ ...common, decision: 'not_selected', codes: [...codes].reverse() })).toBe(
      'explicit_intent_required',
    );
    expect(
      primary({
        ...common,
        decision: 'not_selected',
        codes: ['possible_overlap', 'unknown_overlap_domain'],
      }),
    ).toBe('possible_overlap');
    expect(() => primary({ ...common, decision: 'not_selected' })).toThrow(
      'invalid_selection_reason',
    );
  });
  it.each([
    ['accepted', 'created', 'eligible_create'],
    ['unchanged', 'none', 'existing_accepted'],
    ['proposed', 'created', 'profile_review_required'],
    ['proposed', 'none', 'existing_proposed'],
    ['rejected', 'none', 'existing_rejected'],
    ['not_selected', 'none', 'explicit_intent_required'],
  ])(
    'validates the persisted %s/%s reason without inventing defaults',
    (state, mutation, reason) => {
      const old = sourceReceipt(state, mutation);
      const parsed = receiptSchema.parse(old);
      expect(parsed).toEqual(old);
      expect(hashAutomaticCaptureV2(parsed)).toBe(hashAutomaticCaptureV2(old));
      if (
        parsed.kind !== 'human_compositional_capture_committed' ||
        parsed.selection.kind !== 'bundles'
      )
        throw new Error('fixture');
      expect(parsed.selection.items[0]).not.toHaveProperty('reason');
      expect(receiptSchema.safeParse(sourceReceipt(state, mutation, reason)).success).toBe(true);
      expect(
        receiptSchema.safeParse(sourceReceipt(state, mutation, 'arbitrary-provider-error')).success,
      ).toBe(false);
      expect(
        receiptSchema.safeParse(
          sourceReceipt(
            state,
            mutation,
            reason === 'eligible_create' ? 'existing_rejected' : 'eligible_create',
          ),
        ).success,
      ).toBe(false);
    },
  );
  it('does not inspect untrusted reason getters or proxies', () => {
    let traps = 0;
    const value = Object.defineProperty({}, 'decision', { enumerable: true, get: () => ++traps });
    expect(() => primary(value)).toThrow();
    expect(() => primary(new Proxy({}, { get: () => ++traps }))).toThrow();
    expect(traps).toBe(0);
  });

  it('does not call a newly created rejected row an existing rejected claim', () => {
    expect(
      receiptSchema.safeParse(sourceReceipt('rejected', 'created', 'existing_rejected')).success,
    ).toBe(false);
    expect(receiptSchema.safeParse(sourceReceipt('rejected', 'created')).success).toBe(true);
  });
  it.each(['proposed', 'rejected'] as const)(
    'does not call unpersisted %s evidence an existing claim',
    (state) => {
      const input = sourceReceipt(state, 'none', `existing_${state}`);
      input.selection.items[0].persisted = false;
      delete input.selection.items[0].claimId;
      expect(receiptSchema.safeParse(input).success).toBe(false);
      delete input.selection.items[0].reason;
      expect(receiptSchema.safeParse(input).success).toBe(true);
    },
  );
});
