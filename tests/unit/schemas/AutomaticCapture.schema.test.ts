import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import {
  AutomaticCaptureBeginRequestV2Schema,
  AutomaticCaptureSourceOwnerV2Schema,
  AutomaticOperationIdentityV2Schema,
} from '../../../src/schemas/AutomaticCapture.schema';

const hash = 'a'.repeat(64);
const uuid = '7f8f3c7d-50a1-42dc-b1e8-0c913a12cb14';
const binding = {
  bindingId: 'c4dcb624-1eef-47c3-8888-79ced532bc50',
  revision: 2,
  subjectId: '124b6af9-2b89-4e80-b052-373197a3e1c5',
  fingerprint: 'b'.repeat(64),
};

function humanRequest() {
  return {
    version: 2,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    namespace: 'tenant',
    issuer: 'workflow',
    actorReference: 'user-1',
    turn: 'turn-1',
    settings: {
      profileId: 'explicit',
      requestedTrustLevel: 'standard',
      intentSetting: true,
      invocationDeadlineMs: 30_000,
    },
    source: {
      content: 'I like tea ☕',
      sourceMessageId: 'message-1',
      conversationId: 'conversation-1',
      senderId: 'sender-1',
      senderName: 'A user',
      sourceWorkflowId: 'workflow-1',
      originalSourceExecutionId: 'execution-1',
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'explicit', value: '2026-10-25T14:30:00+02:00' },
      applicationOwnedWrapper: null,
      humanRegion: null,
      quoteRegions: [],
    },
    attemptIdHash: hash,
  };
}

function humanOwner() {
  return {
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: hash,
    namespace: 'tenant',
    turn: 'turn-1',
    role: 'human',
    issuer: 'workflow',
    actorReference: 'user-1',
    binding,
    assistantWriteAuthority: null,
    purpose: 'human_turn_memory',
    requestedTrustLevel: 'standard',
    intentSetting: true,
    intentEvidence: true,
    eventTimeMode: 'explicit',
    eventTimeHash: hash,
    stableProducerHash: hash,
    sourceContentHash: hash,
    settingsHash: hash,
    policy: compileAutomaticPolicy({ profileId: 'explicit' }),
  };
}

describe('AutomaticCaptureBeginRequestV2Schema', () => {
  it('accepts bounded human inputs and normalizes offset time to UTC', () => {
    const parsed = AutomaticCaptureBeginRequestV2Schema.parse(humanRequest());
    expect(parsed.source.eventTime).toEqual({
      mode: 'explicit',
      value: '2026-10-25T12:30:00.000Z',
    });
    expect(parsed.source.content).toBe('I like tea ☕');
  });

  it('accepts exact assistant null settings and full-source mapping only', () => {
    const request = humanRequest();
    const parsed = AutomaticCaptureBeginRequestV2Schema.parse({
      ...request,
      purpose: 'assistant_final_save',
      settings: {
        profileId: null,
        requestedTrustLevel: null,
        intentSetting: null,
        invocationDeadlineMs: 100,
      },
      source: {
        ...request.source,
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
        eventTime: { mode: 'first_capture' },
      },
    });
    expect(parsed.purpose).toBe('assistant_final_save');
    expect(parsed.source.eventTime).toEqual({ mode: 'first_capture' });
  });

  it('rejects unknown caller fields and policy, hash, or ID injection', () => {
    const request = humanRequest();
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({ ...request, operationId: uuid }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        settings: {
          ...request.settings,
          policy: compileAutomaticPolicy({ profileId: 'explicit' }),
        },
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        settings: { ...request.settings, settingsHash: hash },
      }).success,
    ).toBe(false);
  });

  it('rejects mixed human and assistant settings and the existing profile', () => {
    const request = humanRequest();
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        purpose: 'assistant_final_save',
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        settings: { ...request.settings, profileId: 'existing' },
      }).success,
    ).toBe(false);
  });

  it.each([99, 120_001, 1.5])('rejects deadline %s outside the closed range', (deadline) => {
    const request = humanRequest();
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        settings: { ...request.settings, invocationDeadlineMs: deadline },
      }).success,
    ).toBe(false);
  });

  it('rejects content beyond the UTF-8 byte cap and malformed surrogate sequences', () => {
    const request = humanRequest();
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: { ...request.source, content: 'a'.repeat(65_537) },
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: { ...request.source, content: '\ud800' },
      }).success,
    ).toBe(false);
  });

  it('returns before scanning Unicode when the outer request content exceeds its length bound', () => {
    const request = humanRequest();
    const overlongMalformed = `${'x'.repeat(65_536)}\ud800`;
    const charCodeSpy = jest.spyOn(String.prototype, 'charCodeAt');
    let success = true;
    let scanCalls = -1;
    try {
      success = AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: { ...request.source, content: overlongMalformed },
      }).success;
      scanCalls = charCodeSpy.mock.contexts.filter(
        (context) => context === overlongMalformed,
      ).length;
    } finally {
      charCodeSpy.mockRestore();
    }
    expect(success).toBe(false);
    expect(scanCalls).toBe(0);
  });

  it('rejects producer IDs and display values that storage would trim or normalize', () => {
    const request = humanRequest();
    const producerFields = [
      'sourceMessageId',
      'conversationId',
      'senderId',
      'sourceWorkflowId',
      'originalSourceExecutionId',
      'quotedMessageId',
      'senderName',
    ] as const;
    for (const field of producerFields) {
      for (const value of ['', '  ', ' id ']) {
        expect(
          AutomaticCaptureBeginRequestV2Schema.safeParse({
            ...request,
            source: { ...request.source, [field]: value },
          }).success,
        ).toBe(false);
      }
    }
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: {
          ...request.source,
          sourceMessageId: null,
          conversationId: null,
          senderId: null,
          sourceWorkflowId: null,
          originalSourceExecutionId: null,
          quotedMessageId: null,
          senderName: null,
        },
      }).success,
    ).toBe(true);
  });

  it('validates UTF-16 mapping geometry and quote boundaries around astral characters', () => {
    const request = humanRequest();
    const wrapped = {
      ...request,
      source: {
        ...request.source,
        content: 'x😀y',
        applicationOwnedWrapper: true,
        humanRegion: { start: 1, end: 3 },
        quoteRegions: [],
      },
    };
    expect(AutomaticCaptureBeginRequestV2Schema.safeParse(wrapped).success).toBe(true);
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...wrapped,
        source: { ...wrapped.source, humanRegion: { start: 2, end: 3 } },
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...wrapped,
        source: { ...wrapped.source, quoteRegions: [{ start: 0, end: 1 }] },
      }).success,
    ).toBe(false);
  });

  it('rejects incomplete wrappers, overlapping quotes, and unzoned local timestamps', () => {
    const request = humanRequest();
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: { ...request.source, applicationOwnedWrapper: true },
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: {
          ...request.source,
          quoteRegions: [
            { start: 0, end: 3 },
            { start: 2, end: 4 },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: {
          ...request.source,
          eventTime: { mode: 'explicit', value: '2026-10-25T14:30:00' },
        },
      }).success,
    ).toBe(false);
  });

  it('caps human mapping plus quote spans at the existing envelope limit', () => {
    const request = humanRequest();
    const quotes31 = Array.from({ length: 31 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
    }));
    const quotes32 = [...quotes31, { start: 62, end: 63 }];
    const withQuotes = (quoteRegions: Array<{ start: number; end: number }>) => ({
      ...request,
      source: { ...request.source, content: 'x'.repeat(100), quoteRegions },
    });
    expect(AutomaticCaptureBeginRequestV2Schema.safeParse(withQuotes(quotes31)).success).toBe(true);
    expect(AutomaticCaptureBeginRequestV2Schema.safeParse(withQuotes(quotes32)).success).toBe(
      false,
    );
  });

  it.each([
    '2026-01-01T00:00:00+99:99',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00+01:99',
    '2025-02-30T00:00:00Z',
  ])('safely rejects invalid explicit timezone/date value %s', (value) => {
    const request = humanRequest();
    expect(() =>
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: { ...request.source, eventTime: { mode: 'explicit', value } },
      }),
    ).not.toThrow();
    expect(
      AutomaticCaptureBeginRequestV2Schema.safeParse({
        ...request,
        source: { ...request.source, eventTime: { mode: 'explicit', value } },
      }).success,
    ).toBe(false);
  });
});

describe('AutomaticCaptureSourceOwnerV2Schema', () => {
  it('accepts the strict human owner shape with compiled policy', () => {
    expect(AutomaticCaptureSourceOwnerV2Schema.parse(humanOwner()).purpose).toBe(
      'human_turn_memory',
    );
  });

  it('rejects purpose/role mixtures and tampered policy values', () => {
    const owner = humanOwner();
    expect(
      AutomaticCaptureSourceOwnerV2Schema.safeParse({ ...owner, role: 'assistant' }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureSourceOwnerV2Schema.safeParse({
        ...owner,
        policy: { ...owner.policy, autoAccept: false, fingerprint: 'c'.repeat(64) },
      }).success,
    ).toBe(false);
    expect(AutomaticCaptureSourceOwnerV2Schema.safeParse({ ...owner, binding: null }).success).toBe(
      false,
    );
  });

  it('requires assistant provenance authority and exact null human fields', () => {
    const owner = humanOwner();
    const assistant = {
      ...owner,
      role: 'assistant',
      purpose: 'assistant_final_save',
      binding: null,
      assistantWriteAuthority: {
        kind: 'owned_human_turn',
        sourceId: uuid,
        sourceHash: hash,
        descriptorHash: hash,
        requestedAuthorityHash: hash,
      },
      requestedTrustLevel: null,
      intentSetting: null,
      intentEvidence: null,
      policy: null,
    };
    expect(AutomaticCaptureSourceOwnerV2Schema.safeParse(assistant).success).toBe(true);
    expect(
      AutomaticCaptureSourceOwnerV2Schema.safeParse({ ...assistant, intentSetting: false }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureSourceOwnerV2Schema.safeParse({
        ...assistant,
        assistantWriteAuthority: null,
      }).success,
    ).toBe(false);
  });
});

describe('AutomaticOperationIdentityV2Schema', () => {
  const identity = {
    lifecycle: 'replaySafeV2',
    storeHash: hash,
    namespace: 'tenant',
    issuer: 'workflow',
    actorReference: 'user-1',
    turn: 'turn-1',
    role: 'human',
    sourceId: uuid,
    sourceHash: hash,
    originalProducerHash: hash,
    stableProducerHash: hash,
    requestedAuthorityHash: hash,
    purpose: 'human_turn_memory',
    binding,
  };

  it('accepts the human identity and rejects purpose/role mismatch', () => {
    expect(AutomaticOperationIdentityV2Schema.safeParse(identity).success).toBe(true);
    expect(
      AutomaticOperationIdentityV2Schema.safeParse({ ...identity, role: 'assistant' }).success,
    ).toBe(false);
    expect(
      AutomaticOperationIdentityV2Schema.safeParse({ ...identity, binding: null }).success,
    ).toBe(false);
  });

  it('requires assistant identity to have a null human binding', () => {
    expect(
      AutomaticOperationIdentityV2Schema.safeParse({
        ...identity,
        role: 'assistant',
        purpose: 'assistant_final_save',
        binding: null,
      }).success,
    ).toBe(true);
    expect(
      AutomaticOperationIdentityV2Schema.safeParse({
        ...identity,
        role: 'assistant',
        purpose: 'assistant_final_save',
      }).success,
    ).toBe(false);
  });
});
