import { randomUUID } from 'crypto';
import { makeHumanFixture } from './automaticCommittedFixture';
import { buildCompositionalHumanCaptureSourceV3 } from '../../src/storage/CompositionalAutomaticCaptureSourceV3';
import { AutomaticWriteOwnerSchema } from '../../src/schemas/AutomaticClaim.schema';
import { GraphDataSchema } from '../../src/schemas/GraphData.schema';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import type { CompositionalAutomaticHumanSourceBuildV3 } from '../../src/schemas/CompositionalAutomaticCaptureSourceBuildV3.schema';

/** Synthetic source/operation only; no backend writer or processing permit. */
export function makeCompositionalCaptureFixture(
  content = 'I prefer concise explanations.',
  storeHash = 'b'.repeat(64),
) {
  const literal = makeHumanFixture(`compositional-fixture-${randomUUID()}`);
  const owner = AutomaticWriteOwnerSchema.parse(literal.human.attributes.engram_write_owner_v1);
  const graph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: '2026-10-25T12:00:00.000Z',
    entities: literal.graph.entities.filter((row) => row.uuid === literal.binding.subjectId),
    episodes: [],
    edges: [],
  });
  const input: CompositionalAutomaticHumanSourceBuildV3 = {
    sourceId: randomUUID(),
    storeHash,
    capturedAt: graph.exported_at,
    previousEpisodeId: null,
    request: {
      version: 3,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      preferenceInterpreter: 'compositionalV2',
      namespace: literal.human.group_id,
      issuer: owner.issuer,
      actorReference: owner.actor,
      turn: `compositional-turn-${randomUUID()}`,
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30000,
      },
      source: {
        content,
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
      attemptIdHash: 'a'.repeat(64),
    },
  };
  const built = buildCompositionalHumanCaptureSourceV3(graph, input);
  const source = structuredClone(built.episode);
  graph.episodes.push(source);
  const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
    version: 3,
    operationId: randomUUID(),
    identity: built.identity,
    descriptor: built.descriptor,
    createdAt: graph.exported_at,
    lastObservedAt: graph.exported_at,
    attempts: [],
    overflowCount: 0,
    beginCallHash: 'c'.repeat(64),
    retryCount: 0,
    state: 'captured',
    generation: 0,
  });
  return { graph, source, operation, built, input };
}
