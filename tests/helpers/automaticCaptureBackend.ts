import { randomUUID } from 'crypto';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import { AutomaticCaptureBeginRequestV2Schema } from '../../src/schemas/AutomaticCapture.schema';

/** Synthetic identity created through the same supported storage APIs as native nodes. */
export async function seedAutomaticCaptureSubject(
  storage: IGraphStorage,
  namespace = `capture-${randomUUID()}`,
) {
  const time = new Date().toISOString();
  const subject = await storage.addEntity({
    group_id: namespace,
    name: 'Synthetic reviewed human',
    entity_type: 'person',
    attributes: {
      engram_extraction: {
        version: 2,
        source: 'manual',
        confidence: null,
        review_status: 'accepted',
        threshold_decision: 'manually_reviewed',
        extracted_at: time,
        episode_uuids: [],
        reviewed_at: time,
        reviewed_by: 'synthetic-reviewer',
      },
    },
  });
  const binding = await storage.automaticBindingCommand!({
    action: 'create',
    namespace,
    issuer: 'synthetic-app',
    actorReference: 'synthetic-actor',
    subjectId: subject.uuid,
    authorizedBy: 'synthetic-reviewer',
    reason: 'Synthetic verification',
  });
  const request = AutomaticCaptureBeginRequestV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    namespace,
    issuer: 'synthetic-app',
    actorReference: 'synthetic-actor',
    turn: 'synthetic-event',
    attemptIdHash: 'a'.repeat(64),
    settings: {
      profileId: 'conservative',
      requestedTrustLevel: 'standard',
      intentSetting: false,
      invocationDeadlineMs: 30000,
    },
    source: {
      content: 'I prefer concise explanations.',
      sourceMessageId: 'synthetic-original-message',
      conversationId: 'synthetic-conversation',
      senderId: 'synthetic-sender',
      senderName: 'Synthetic Display',
      sourceWorkflowId: null,
      originalSourceExecutionId: null,
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' },
      applicationOwnedWrapper: null,
      humanRegion: null,
      quoteRegions: [],
    },
  });
  return { request, binding, subject };
}
