import { randomUUID, createHash } from 'crypto';
import {
  CompositionalAutomaticCaptureBeginRequestV3Schema,
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  compositionalCaptureInterpreterResultHashV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { hashCompositionalAutomaticDescriptorV3 } from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalCaptureAdminFenceRequestV3Schema,
  CompositionalCaptureReadRequestV3Schema,
} from '../../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import { CompositionalCaptureNamespaceV3Schema } from '../../../src/schemas/CompositionalCaptureNamespaceV3.schema';
import { interpretCompositionalHumanSourceV3Evidence } from '../../../src/extraction/CompositionalAutomaticCaptureV3Evidence';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import { reconstructCompositionalAutomaticSourceIdentityV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceTupleV3';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const terminalAt = '2026-10-25T12:02:00.000Z';

describe('compositional V3 exact namespace identity', () => {
  it('preserves a spaced namespace through source build, identity, receipt, operation, read, and admin schemas', () => {
    const namespace = '  tenant namespace  ';
    const prior = makeHumanFixture(namespace);
    const content = 'I prefer French.';
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      version: 3,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      preferenceInterpreter: 'compositionalV2',
      namespace,
      issuer: 'synthetic-workflow',
      actorReference: 'synthetic-human-actor',
      turn: `turn-v3-${randomUUID()}`,
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 10_000,
      },
      source: {
        content,
        sourceMessageId: 'v3-spaced-namespace-message',
        conversationId: 'v3-spaced-namespace-conversation',
        senderId: 'synthetic-human-actor',
        senderName: 'Synthetic Human',
        sourceWorkflowId: 'v3-spaced-namespace-workflow',
        originalSourceExecutionId: 'v3-spaced-namespace-original-execution',
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [{ start: 0, end: content.length }],
      },
      attemptIdHash: hash('spaced namespace attempt'),
    });

    expect(request.namespace).toBe(namespace);
    expect(CompositionalCaptureNamespaceV3Schema.parse(namespace)).toBe(namespace);

    const built = buildCompositionalHumanCaptureSourceV3(prior.graph, {
      request,
      sourceId: randomUUID(),
      storeHash: hash('spaced namespace logical store'),
      previousEpisodeId: prior.human.uuid,
      capturedAt: '2026-10-25T12:01:00.000Z',
    });
    expect(built.episode.group_id).toBe(namespace);
    expect(built.identity.namespace).toBe(namespace);
    expect(built.descriptorHash).toBe(hashCompositionalAutomaticDescriptorV3(built.descriptor));

    const reconstructed = reconstructCompositionalAutomaticSourceIdentityV3(
      built.episode,
      built.descriptor,
    );
    expect(reconstructed.owner.namespace).toBe(namespace);
    expect(reconstructed.envelope.sourceEnvelope.namespace).toBe(namespace);
    expect(reconstructed.identity.namespace).toBe(namespace);
    expect(reconstructed.identity).toEqual(built.identity);

    const evidence = interpretCompositionalHumanSourceV3Evidence(
      built.episode,
      built.descriptor,
      built.identity,
    );
    expect(evidence.result.coverage).toBe('none');
    const operationId = randomUUID();
    const receipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse({
      version: 3,
      kind: 'human_compositional_source_verdict_committed',
      operationId,
      sourceId: built.episode.uuid,
      sourceHash: built.identity.sourceHash,
      descriptorHash: built.descriptorHash,
      policyFingerprint: built.descriptor.policy.fingerprint,
      terminalAt,
      reasons: evidence.result.reasons,
      interpretationCoverage: evidence.result.coverage,
      selection: {
        kind: 'source_verdict',
        verdict: 'no_supported_preference_detected',
        interpreterResultHash: compositionalCaptureInterpreterResultHashV3(
          built.episode.uuid,
          built.identity.sourceHash,
          built.descriptorHash,
          evidence.result,
        ),
      },
      acceptedCoverage: 'none',
    });
    expect(receipt.sourceId).toBe(built.episode.uuid);

    const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
      version: 3,
      operationId,
      identity: built.identity,
      descriptor: built.descriptor,
      createdAt: built.episode.created_at,
      lastObservedAt: terminalAt,
      attempts: [
        {
          attemptHash: request.attemptIdHash,
          at: built.episode.created_at,
          disposition: 'claim_won',
        },
      ],
      overflowCount: 0,
      beginCallHash: hash('spaced namespace private begin call'),
      retryCount: 0,
      state: 'committed',
      generation: 1,
      completionCallHash: hash('spaced namespace private completion call'),
      terminalReceipt: receipt,
    });
    expect(operation.identity.namespace).toBe(namespace);
    expect(operation.state).toBe('committed');
    if (operation.state !== 'committed') throw new Error('Expected committed V3 operation');
    expect(operation.terminalReceipt.sourceId).toBe(built.episode.uuid);

    const locator = {
      version: 3,
      namespace,
      issuer: request.issuer,
      actorReference: request.actorReference,
      turn: request.turn,
      role: 'human',
    };
    expect(CompositionalCaptureReadRequestV3Schema.parse(locator).namespace).toBe(namespace);
    expect(
      CompositionalCaptureAdminFenceRequestV3Schema.parse({
        ...locator,
        expectedGeneration: 1,
        attemptIdHash: hash('spaced namespace admin attempt'),
      }).namespace,
    ).toBe(namespace);
  });

  it('rejects whitespace-only and malformed Unicode namespaces across the V3 family', () => {
    for (const invalid of ['   ', '\ud800']) {
      expect(CompositionalCaptureNamespaceV3Schema.safeParse(invalid).success).toBe(false);
      expect(
        CompositionalAutomaticCaptureBeginRequestV3Schema.safeParse({
          version: 3,
          lifecycle: 'replaySafeV2',
          purpose: 'human_turn_memory',
          preferenceInterpreter: 'compositionalV2',
          namespace: invalid,
          issuer: 'synthetic-workflow',
          actorReference: 'synthetic-human-actor',
          turn: 'turn-v3-invalid-namespace',
          settings: {
            profileId: 'conservative',
            requestedTrustLevel: 'standard',
            intentSetting: false,
            invocationDeadlineMs: 10_000,
          },
          source: {
            content: 'Hello.',
            sourceMessageId: null,
            conversationId: null,
            senderId: null,
            senderName: null,
            sourceWorkflowId: null,
            originalSourceExecutionId: null,
            sourceType: 'message',
            quotedMessageId: null,
            eventTime: { mode: 'first_capture' },
            applicationOwnedWrapper: null,
            humanRegion: null,
            quoteRegions: [],
          },
          attemptIdHash: hash('invalid namespace attempt'),
        }).success,
      ).toBe(false);
    }
  });
});
