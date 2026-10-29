import { randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import {
  AutomaticCaptureAdminFenceRequestV2Schema,
  AutomaticCaptureBeginDecisionV2Schema,
  AutomaticCaptureBeginRequestV2Schema,
  AutomaticCaptureCancelInternalResultV2Schema,
  AutomaticCapturePublicResultV2Schema,
  AutomaticCaptureReadRequestV2Schema,
  AutomaticCaptureReadResultV2Schema,
  AutomaticCaptureReceiptSummaryV2Schema,
  AutomaticCaptureResumeDecisionV2Schema,
  AutomaticAssistantCompletionInternalResultV2Schema,
  AutomaticHumanCompletionDataResultV2Schema,
} from '../../../src/schemas/AutomaticCaptureApi.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../../../src/schemas/AutomaticCaptureReceipt.schema';

const locator = {
  version: 2 as const,
  namespace: 'synthetic-api',
  issuer: 'synthetic-app',
  actorReference: 'synthetic-actor',
  turn: 'synthetic-event',
  role: 'human' as const,
};
const summary = {
  persisted: true,
  commitAt: '2026-10-25T12:00:00.000Z',
  receiptInspectionComplete: true,
  interpretationCoverage: 'complete' as const,
  acceptedCoverage: 'all' as const,
  itemCounts: { accepted: 1, proposed: 0, rejected: 0, deferred: 0, not_selected: 0, unchanged: 0 },
};
function firstResult() {
  return {
    version: 2 as const,
    purpose: 'human_turn_memory' as const,
    status: 'first_capture_committed' as const,
    sourceId: randomUUID(),
    sourcePersistence: 'persisted' as const,
    should_process: true,
    currentAuthority: 'active' as const,
    receiptSummary: structuredClone(summary),
  };
}
function committedResult() {
  const fixture = makeHumanFixture();
  const operation = fixture.humanOperation;
  if (operation.state !== 'committed') throw new Error('Expected genuine committed fixture');
  return {
    kind: 'committed' as const,
    invocation: 'initial_owner' as const,
    terminalReceipt: operation.terminalReceipt,
    currentAuthority: 'active' as const,
    eligibleFirstCommit: true as const,
  };
}

describe('standalone synchronous capture API data contracts', () => {
  it('reuses the existing closed human begin request and normalizes explicit event time', () => {
    const request = {
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      namespace: locator.namespace,
      issuer: locator.issuer,
      actorReference: locator.actorReference,
      turn: locator.turn,
      attemptIdHash: 'a'.repeat(64),
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30_000,
      },
      source: {
        content: 'I like JSON.',
        sourceMessageId: null,
        conversationId: null,
        senderId: null,
        senderName: null,
        sourceWorkflowId: null,
        originalSourceExecutionId: null,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'explicit', value: '2026-10-25T13:00:00+01:00' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    };
    expect(AutomaticCaptureBeginRequestV2Schema.parse(request).source.eventTime).toEqual({
      mode: 'explicit',
      value: '2026-10-25T12:00:00.000Z',
    });
    for (const forbidden of ['descriptor', 'policy', 'storeHash', 'leaseToken', 'operationId']) {
      expect(
        AutomaticCaptureBeginRequestV2Schema.safeParse({ ...request, [forbidden]: 'injected' })
          .success,
      ).toBe(false);
    }
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        settings: { ...request.settings, profileId: 'existing' },
      }).success,
    ).toBe(false);
  });

  it('bounds exact actor-scoped admin/read locators and rejects extra authority fields', () => {
    expect(AutomaticCaptureReadRequestV2Schema.parse(locator)).toEqual(locator);
    const admin = { ...locator, expectedGeneration: 2_147_483_647, attemptIdHash: 'b'.repeat(64) };
    expect(AutomaticCaptureAdminFenceRequestV2Schema.safeParse(admin).success).toBe(true);
    for (const expectedGeneration of [0, 2_147_483_648, 1.5]) {
      expect(
        AutomaticCaptureAdminFenceRequestV2Schema.safeParse({ ...admin, expectedGeneration })
          .success,
      ).toBe(false);
    }
    expect(
      AutomaticCaptureReadRequestV2Schema.safeParse({ ...locator, namespace: ' ' }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureReadRequestV2Schema.safeParse({ ...locator, actorReference: 'x'.repeat(513) })
        .success,
    ).toBe(false);
    expect(
      AutomaticCaptureReadRequestV2Schema.safeParse({ ...locator, sourceId: randomUUID() }).success,
    ).toBe(false);
  });

  it('keeps handle-free decisions private-data-free and does not accept guessed handles', () => {
    expect(
      AutomaticCaptureBeginDecisionV2Schema.parse({
        kind: 'capacity',
        sourcePersistence: 'persisted',
      }),
    ).toEqual({ kind: 'capacity', sourcePersistence: 'persisted' });
    expect(
      AutomaticCaptureResumeDecisionV2Schema.safeParse({ kind: 'committed_replay' }).success,
    ).toBe(true);
    for (const kind of ['conflict', 'authority_changed', 'invalid_input']) {
      expect(
        AutomaticCaptureBeginDecisionV2Schema.safeParse({ kind, sourceId: randomUUID() }).success,
      ).toBe(false);
    }
    expect(
      AutomaticCaptureBeginDecisionV2Schema.safeParse({
        kind: 'claimed',
        leaseHandle: Object.freeze({}),
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureResumeDecisionV2Schema.safeParse({
        kind: 'resumed',
        leaseHandle: Object.freeze({}),
      }).success,
    ).toBe(false);
    expect(
      AutomaticHumanCompletionDataResultV2Schema.safeParse({
        kind: 'graph_conflict_retry',
        retryHandle: {},
        eligibleFirstCommit: false,
      }).success,
    ).toBe(false);
  });

  it('validates genuine human completion data and separates explicit resume from eligibility', () => {
    const committed = committedResult();
    expect(AutomaticHumanCompletionDataResultV2Schema.safeParse(committed).success).toBe(true);
    expect(
      AutomaticHumanCompletionDataResultV2Schema.safeParse({
        ...committed,
        invocation: 'same_call_ack_recovered',
      }).success,
    ).toBe(true);
    expect(
      AutomaticHumanCompletionDataResultV2Schema.safeParse({
        ...committed,
        invocation: 'explicit_resume',
      }).success,
    ).toBe(false);
    expect(
      AutomaticHumanCompletionDataResultV2Schema.safeParse({
        ...committed,
        invocation: 'explicit_resume',
        eligibleFirstCommit: false,
      }).success,
    ).toBe(true);
    expect(
      AutomaticHumanCompletionDataResultV2Schema.safeParse({
        ...committed,
        currentAuthority: 'revoked',
      }).success,
    ).toBe(false);
    expect(
      AutomaticHumanCompletionDataResultV2Schema.safeParse({
        ...committed,
        currentAuthority: 'revoked',
        eligibleFirstCommit: false,
      }).success,
    ).toBe(true);
    expect(
      AutomaticHumanCompletionDataResultV2Schema.safeParse({ ...committed, should_process: true })
        .success,
    ).toBe(false);
  });

  it('separates assistant/cancel receipt kinds without accepting human extraction authority', () => {
    const human = committedResult();
    const terminal = human.terminalReceipt;
    const common = {
      version: 2 as const,
      operationId: terminal.operationId,
      sourceId: terminal.sourceId,
      sourceHash: terminal.sourceHash,
      descriptorHash: terminal.descriptorHash,
      terminalAt: terminal.terminalAt,
    };
    const assistant = AutomaticCaptureTerminalReceiptV2Schema.parse({
      ...common,
      kind: 'assistant_final_saved',
      persisted: true,
    });
    const result = { ...human, terminalReceipt: assistant, eligibleFirstCommit: false };
    expect(AutomaticAssistantCompletionInternalResultV2Schema.safeParse(result).success).toBe(true);
    expect(
      AutomaticAssistantCompletionInternalResultV2Schema.safeParse({
        ...result,
        eligibleFirstCommit: true,
      }).success,
    ).toBe(false);
    expect(
      AutomaticAssistantCompletionInternalResultV2Schema.safeParse({
        ...result,
        terminalReceipt: terminal,
      }).success,
    ).toBe(false);
    expect(AutomaticHumanCompletionDataResultV2Schema.safeParse(result).success).toBe(false);
    const cancelled = AutomaticCaptureTerminalReceiptV2Schema.parse({
      ...common,
      kind: 'cancelled',
      acceptedCoverage: 'none',
    });
    expect(
      AutomaticCaptureCancelInternalResultV2Schema.safeParse({
        kind: 'cancelled',
        terminalReceipt: cancelled,
        eligibleFirstCommit: false,
      }).success,
    ).toBe(true);
    expect(
      AutomaticCaptureCancelInternalResultV2Schema.safeParse({
        kind: 'cancelled',
        terminalReceipt: terminal,
        eligibleFirstCommit: false,
      }).success,
    ).toBe(false);
  });

  it('accepts only the structurally eligible first human projection and never permits reads', () => {
    const result = firstResult();
    expect(AutomaticCapturePublicResultV2Schema.safeParse(result).success).toBe(true);
    expect(AutomaticCaptureReadResultV2Schema.safeParse(result).success).toBe(false);
    expect(
      AutomaticCaptureReadResultV2Schema.safeParse({
        ...result,
        status: 'committed_replay',
        should_process: false,
      }).success,
    ).toBe(true);
    for (const change of [
      { purpose: 'assistant_final_save' },
      { currentAuthority: 'revoked' },
      { sourcePersistence: 'unknown' },
      { sourceId: null },
      { receiptSummary: null },
      { status: 'committed_replay' },
      { should_process: false },
    ])
      expect(AutomaticCapturePublicResultV2Schema.safeParse({ ...result, ...change }).success).toBe(
        false,
      );
  });

  it('allows completely inspected unknown meaning with no accepted facts, preserving the receipt axes', () => {
    const result = firstResult();
    const noFacts = {
      ...summary,
      interpretationCoverage: 'unknown',
      acceptedCoverage: 'none',
      itemCounts: { ...summary.itemCounts, accepted: 0, not_selected: 1 },
    };
    expect(
      AutomaticCapturePublicResultV2Schema.safeParse({ ...result, receiptSummary: noFacts })
        .success,
    ).toBe(true);
    expect(
      AutomaticCaptureReceiptSummaryV2Schema.safeParse({
        ...summary,
        interpretationCoverage: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureReceiptSummaryV2Schema.safeParse({
        ...summary,
        itemCounts: { ...summary.itemCounts, accepted: 32, proposed: 1 },
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureReceiptSummaryV2Schema.safeParse({
        ...summary,
        itemCounts: { ...summary.itemCounts, accepted: 0 },
      }).success,
    ).toBe(false);
  });

  it.each(['conflict', 'capacity', 'not_found', 'invalid_input'] as const)(
    'does not disclose another source or receipt through %s',
    (status) => {
      const result = {
        ...firstResult(),
        status,
        sourceId: null,
        should_process: false,
        sourcePersistence: status === 'conflict' ? 'unknown' : 'not_persisted',
        receiptSummary: null,
      };
      expect(AutomaticCapturePublicResultV2Schema.safeParse(result).success).toBe(true);
      expect(
        AutomaticCapturePublicResultV2Schema.safeParse({ ...result, sourceId: randomUUID() })
          .success,
      ).toBe(false);
      expect(
        AutomaticCapturePublicResultV2Schema.safeParse({ ...result, receiptSummary: summary })
          .success,
      ).toBe(false);
      expect(
        AutomaticCapturePublicResultV2Schema.safeParse({ ...result, leaseToken: 'private' })
          .success,
      ).toBe(false);
    },
  );
});
