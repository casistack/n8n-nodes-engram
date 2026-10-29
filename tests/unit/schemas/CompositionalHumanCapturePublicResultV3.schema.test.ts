import { randomUUID } from 'crypto';
import { CompositionalHumanCapturePublicResultV3Schema as PublicResultSchema } from '../../../src/schemas/CompositionalHumanCapturePublicResultV3.schema';

const zeroCounts = () => ({
  bundleCount: 0,
  persistedBundleCount: 0,
  distinctPersistedClaimCount: 0,
  byState: { accepted: 0, unchanged: 0, proposed: 0, rejected: 0, not_selected: 0 },
});

const sourceVerdictSummary = () => ({
  kind: 'committed',
  persisted: true,
  terminalAt: '2026-10-26T12:00:00.000Z',
  interpretationCoverage: 'none',
  acceptedCoverage: 'none',
  reasons: [],
  selection: { kind: 'source_verdict', verdict: 'no_supported_preference_detected' },
  counts: zeroCounts(),
});

const firstCapture = (overrides: Record<string, unknown> = {}) => ({
  version: 3,
  purpose: 'human_turn_memory',
  status: 'first_capture_committed',
  sourceId: randomUUID(),
  should_process: true,
  currentAuthority: 'active',
  receiptSummary: sourceVerdictSummary(),
  ...overrides,
});

describe('CompositionalHumanCapturePublicResultV3Schema', () => {
  it('allows a first durable no-selection source verdict with no facts', () => {
    const result = PublicResultSchema.parse(firstCapture());
    expect(result.should_process).toBe(true);
    expect(result.receiptSummary).toMatchObject({
      kind: 'committed',
      interpretationCoverage: 'none',
      acceptedCoverage: 'none',
      selection: { kind: 'source_verdict' },
      counts: zeroCounts(),
    });
  });

  it('allows a first ReviewFirst proposed bundle while accepted coverage is none', () => {
    const claimId = randomUUID();
    const summary = {
      kind: 'committed',
      persisted: true,
      terminalAt: '2026-10-26T12:00:00.000Z',
      interpretationCoverage: 'complete',
      acceptedCoverage: 'none',
      reasons: [],
      selection: {
        kind: 'bundles',
        items: [
          {
            bundleIndex: 0,
            state: 'proposed',
            persisted: true,
            reason: 'profile_review_required',
            claimId,
          },
        ],
      },
      counts: {
        bundleCount: 1,
        persistedBundleCount: 1,
        distinctPersistedClaimCount: 1,
        byState: { accepted: 0, unchanged: 0, proposed: 1, rejected: 0, not_selected: 0 },
      },
    };
    const result = PublicResultSchema.parse(firstCapture({ receiptSummary: summary }));
    expect(result.should_process).toBe(true);
    expect(result.receiptSummary).toMatchObject({
      acceptedCoverage: 'none',
      selection: { kind: 'bundles', items: [{ state: 'proposed', claimId }] },
    });
  });

  it('counts duplicate persisted claim IDs once while preserving both bundle rows', () => {
    const claimId = randomUUID();
    const summary = {
      kind: 'committed',
      persisted: true,
      terminalAt: '2026-10-26T12:00:00.000Z',
      interpretationCoverage: 'complete',
      acceptedCoverage: 'all',
      reasons: [],
      selection: {
        kind: 'bundles',
        items: [
          {
            bundleIndex: 0,
            state: 'accepted',
            persisted: true,
            reason: 'eligible_create',
            claimId,
          },
          {
            bundleIndex: 1,
            state: 'unchanged',
            persisted: true,
            reason: 'existing_accepted',
            claimId,
          },
        ],
      },
      counts: {
        bundleCount: 2,
        persistedBundleCount: 2,
        distinctPersistedClaimCount: 1,
        byState: { accepted: 1, unchanged: 1, proposed: 0, rejected: 0, not_selected: 0 },
      },
    };

    expect(PublicResultSchema.safeParse(firstCapture({ receiptSummary: summary })).success).toBe(
      true,
    );
  });

  it('keeps committed replay and cancellation false while exposing their actual receipts', () => {
    const sourceId = randomUUID();
    const replay = PublicResultSchema.parse(
      firstCapture({
        status: 'committed_replay',
        sourceId,
        should_process: false,
        currentAuthority: 'revoked',
      }),
    );
    expect(replay.should_process).toBe(false);
    expect(replay.currentAuthority).toBe('revoked');

    const cancelled = PublicResultSchema.parse({
      version: 3,
      purpose: 'human_turn_memory',
      status: 'cancelled',
      sourceId,
      should_process: false,
      currentAuthority: 'not_evaluated',
      receiptSummary: {
        kind: 'cancelled',
        persisted: true,
        terminalAt: '2026-10-26T12:00:00.000Z',
        acceptedCoverage: 'none',
        counts: zeroCounts(),
      },
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it.each([
    ['true permission without first commit status', { status: 'committed_replay' }],
    ['first commit without current authority', { currentAuthority: 'unknown' }],
    ['first commit without receipt', { receiptSummary: null }],
    ['unconfirmed source identifier', { status: 'in_progress' }],
    [
      'source verdict with an invented fact',
      {
        receiptSummary: {
          ...sourceVerdictSummary(),
          counts: { ...zeroCounts(), bundleCount: 1 },
        },
      },
    ],
    [
      'incorrect distinct persisted count',
      {
        receiptSummary: {
          kind: 'committed',
          persisted: true,
          terminalAt: '2026-10-26T12:00:00.000Z',
          interpretationCoverage: 'complete',
          acceptedCoverage: 'none',
          reasons: [],
          selection: {
            kind: 'bundles',
            items: [{ bundleIndex: 0, state: 'proposed', persisted: true, claimId: randomUUID() }],
          },
          counts: {
            bundleCount: 1,
            persistedBundleCount: 1,
            distinctPersistedClaimCount: 0,
            byState: { accepted: 0, unchanged: 0, proposed: 1, rejected: 0, not_selected: 0 },
          },
        },
      },
    ],
  ])('rejects %s', (_name, override) => {
    expect(PublicResultSchema.safeParse(firstCapture(override)).success).toBe(false);
  });

  it('rejects private hashes, operation IDs and extra public fields', () => {
    expect(
      PublicResultSchema.safeParse({ ...firstCapture(), operationId: randomUUID() }).success,
    ).toBe(false);
  });
});
