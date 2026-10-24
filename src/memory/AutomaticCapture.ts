import { HumanMessage } from '@langchain/core/messages';
import { EngramChatMemory, type EngramChatMemoryInput } from './EngramChatMemory';
import { AUTOMATIC_OWNER } from '../extraction/AutomaticClaims';
import { AutomaticWriteOwnerSchema } from '../schemas/AutomaticClaim.schema';

/** Await before generating a saving acknowledgement. Never creates an assistant turn. */
export async function captureHumanMemory(fields: EngramChatMemoryInput, content: string) {
  if (
    !fields.automaticMemory ||
    fields.automaticMemory.profileId === 'existing' ||
    fields.automaticMemory.capturedSourceId
  )
    throw new Error('Engram automatic: capture_requires_new_profile');
  const memory = new EngramChatMemory(fields);
  const outcome = await memory.saveMessagesWithDelivery([new HumanMessage(content)]);
  const snapshot = await fields.storage.readExtractionSnapshot!(fields.groupId);
  const matches = snapshot.episodes.filter((ep) => {
    const owner = AutomaticWriteOwnerSchema.safeParse(ep.attributes[AUTOMATIC_OWNER]);
    return (
      owner.success &&
      owner.data.role === 'human' &&
      owner.data.turn === fields.automaticMemory!.turnId &&
      owner.data.store === fields.automaticMemory!.storeIdentity &&
      owner.data.actor === fields.automaticMemory!.actor.actorReference &&
      owner.data.issuer === fields.automaticMemory!.actor.issuer
    );
  });
  if (matches.length !== 1) throw new Error('Engram automatic: capture_owner_missing');
  const receipt = 'extraction' in outcome ? outcome.extraction.automatic : undefined;
  const acknowledgement =
    'delivery' in outcome
      ? 'queued'
      : !receipt?.persisted
        ? 'unconfirmed'
        : receipt.items.some((item) => item.state === 'accepted' || item.state === 'unchanged')
          ? 'facts_accepted'
          : receipt.items.some((item) => item.state === 'proposed')
            ? 'review_required'
            : 'not_saved';
  return { sourceId: matches[0].uuid, outcome, acknowledgement };
}
