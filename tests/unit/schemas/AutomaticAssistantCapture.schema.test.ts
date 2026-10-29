import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import {
  AutomaticAssistantCaptureIntentV2Schema,
  AutomaticAssistantFinalWriterResultV2Schema,
} from '../../../src/schemas/AutomaticAssistantCapture.schema';

function validIntent() {
  const parent = makeHumanFixture('assistant-intent-schema');
  return {
    version: 2,
    lifecycle: 'replaySafeV2',
    purpose: 'assistant_final_save',
    humanTurn: {
      namespace: parent.human.group_id,
      issuer: parent.humanIdentity.issuer,
      actorReference: parent.humanIdentity.actorReference,
      turn: parent.humanIdentity.turn,
      input: {
        content: parent.human.content,
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    },
    finalAssistant: {
      content: 'A bounded final answer.',
      sourceMessageId: 'assistant-message-1',
      conversationId: 'conversation-1',
      senderId: 'assistant-1',
      senderName: 'Assistant',
      sourceWorkflowId: 'workflow-1',
      originalSourceExecutionId: null,
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' },
    },
    attemptIdHash: 'a'.repeat(64),
    invocationDeadlineMs: 30_000,
  };
}

describe('AutomaticAssistantCaptureIntentV2Schema', () => {
  it('accepts the closed human-turn and final-assistant intent and normalizes explicit time', () => {
    const valid = validIntent();
    expect(AutomaticAssistantCaptureIntentV2Schema.parse(valid)).toEqual(valid);
    const explicit = AutomaticAssistantCaptureIntentV2Schema.parse({
      ...valid,
      finalAssistant: {
        ...valid.finalAssistant,
        eventTime: { mode: 'explicit', value: '2026-10-25T14:00:00+01:00' },
      },
    });
    expect(explicit.finalAssistant.eventTime).toEqual({
      mode: 'explicit',
      value: '2026-10-25T13:00:00.000Z',
    });
  });

  it('rejects caller-supplied IDs, hashes, policies, authority fields, and extra source fields', () => {
    const valid = validIntent();
    for (const forged of [
      { ...valid, sourceId: '00000000-0000-4000-8000-000000000001' },
      { ...valid, storeHash: 'b'.repeat(64) },
      { ...valid, descriptorHash: 'b'.repeat(64) },
      { ...valid, assistantWriteAuthority: { kind: 'owned_human_turn' } },
      {
        ...valid,
        finalAssistant: { ...valid.finalAssistant, policy: { profileId: 'conservative' } },
      },
    ]) {
      expect(AutomaticAssistantCaptureIntentV2Schema.safeParse(forged).success).toBe(false);
    }
  });

  it('rejects invalid purpose, deadlines, noncanonical producer identifiers, and malformed Unicode', () => {
    const valid = validIntent();
    expect(
      AutomaticAssistantCaptureIntentV2Schema.safeParse({ ...valid, purpose: 'human_turn_memory' })
        .success,
    ).toBe(false);
    expect(
      AutomaticAssistantCaptureIntentV2Schema.safeParse({ ...valid, invocationDeadlineMs: 120_001 })
        .success,
    ).toBe(false);
    expect(
      AutomaticAssistantCaptureIntentV2Schema.safeParse({
        ...valid,
        finalAssistant: { ...valid.finalAssistant, senderId: ' assistant-1' },
      }).success,
    ).toBe(false);
    expect(
      AutomaticAssistantCaptureIntentV2Schema.safeParse({
        ...valid,
        finalAssistant: { ...valid.finalAssistant, content: '\ud800' },
      }).success,
    ).toBe(false);
  });

  it('rejects invalid or out-of-range event-time offsets without throwing from safeParse', () => {
    const valid = validIntent();
    for (const value of [
      '2026-10-25T14:00:00+24:00',
      '2026-10-25T14:00:00+01:99',
      '2026-02-30T14:00:00Z',
      'not-a-date',
    ]) {
      expect(() =>
        AutomaticAssistantCaptureIntentV2Schema.safeParse({
          ...valid,
          finalAssistant: {
            ...valid.finalAssistant,
            eventTime: { mode: 'explicit', value },
          },
        }),
      ).not.toThrow();
      expect(
        AutomaticAssistantCaptureIntentV2Schema.safeParse({
          ...valid,
          finalAssistant: {
            ...valid.finalAssistant,
            eventTime: { mode: 'explicit', value },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('requires bounded human mapping geometry with at most 31 quote regions', () => {
    const valid = validIntent();
    const content = 'x'.repeat(128);
    const quoteRegions = Array.from({ length: 32 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
    }));
    expect(
      AutomaticAssistantCaptureIntentV2Schema.safeParse({
        ...valid,
        humanTurn: {
          ...valid.humanTurn,
          input: { ...valid.humanTurn.input, content, quoteRegions },
        },
      }).success,
    ).toBe(false);
    expect(
      AutomaticAssistantCaptureIntentV2Schema.safeParse({
        ...valid,
        humanTurn: {
          ...valid.humanTurn,
          input: {
            ...valid.humanTurn.input,
            content: 'prefix body',
            applicationOwnedWrapper: true,
            humanRegion: { start: 7, end: 99 },
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe('AutomaticAssistantFinalWriterResultV2Schema', () => {
  const receipt = {
    version: 2,
    kind: 'assistant_final_saved',
    operationId: '00000000-0000-4000-8000-000000000001',
    sourceId: '00000000-0000-4000-8000-000000000002',
    sourceHash: 'b'.repeat(64),
    descriptorHash: 'c'.repeat(64),
    terminalAt: '2026-10-25T14:00:00.000Z',
    persisted: true,
  };

  it('distinguishes fresh and same-call ack from independent committed replay with false eligibility', () => {
    for (const invocation of ['initial_owner', 'same_call_ack_recovered'] as const) {
      expect(
        AutomaticAssistantFinalWriterResultV2Schema.safeParse({
          kind: 'committed',
          invocation,
          terminalReceipt: receipt,
          currentAuthority: 'active',
          eligibleFirstCommit: false,
        }).success,
      ).toBe(true);
    }
    expect(
      AutomaticAssistantFinalWriterResultV2Schema.safeParse({
        kind: 'committed_replay',
        terminalReceipt: receipt,
        currentAuthority: 'revoked',
        eligibleFirstCommit: false,
      }).success,
    ).toBe(true);
    expect(
      AutomaticAssistantFinalWriterResultV2Schema.safeParse({
        kind: 'committed',
        invocation: 'initial_owner',
        terminalReceipt: receipt,
        currentAuthority: 'revoked',
        eligibleFirstCommit: false,
      }).success,
    ).toBe(false);
  });

  it('never grants first-commit eligibility or attaches invented receipts to decisions', () => {
    expect(
      AutomaticAssistantFinalWriterResultV2Schema.safeParse({
        kind: 'committed',
        invocation: 'initial_owner',
        terminalReceipt: receipt,
        currentAuthority: 'active',
        eligibleFirstCommit: true,
      }).success,
    ).toBe(false);
    expect(
      AutomaticAssistantFinalWriterResultV2Schema.safeParse({
        kind: 'decision',
        reason: 'source_only_unconfirmed',
        eligibleFirstCommit: false,
        terminalReceipt: receipt,
      }).success,
    ).toBe(false);
  });

  it('keeps budget and interruption failures as non-permit assistant results', () => {
    for (const reason of ['budget_exhausted', 'interrupted'] as const) {
      expect(
        AutomaticAssistantFinalWriterResultV2Schema.safeParse({
          kind: 'decision',
          reason,
          eligibleFirstCommit: false,
        }).success,
      ).toBe(true);
    }
  });
});
