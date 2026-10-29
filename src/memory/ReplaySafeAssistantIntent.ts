import { z } from 'zod';
import { types as utilTypes } from 'util';
import type { BaseMessage } from '@langchain/core/messages';
import {
  AutomaticRuntimeSchema,
  type AutomaticRuntimeInput,
} from '../schemas/AutomaticRuntime.schema';
import { AutomaticAssistantCaptureIntentV2Schema } from '../schemas/AutomaticAssistantCapture.schema';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from '../storage/BoundedAutomaticCaptureJson';
import { readReplaySafeMessageData, readReplaySafeMessageRole } from './ReplaySafeAudits';

const translationResultSchema = z.union([
  z
    .object({ kind: z.literal('prepared'), intent: AutomaticAssistantCaptureIntentV2Schema })
    .strict(),
  z
    .object({
      kind: z.literal('rejected'),
      reason: z.enum(['invalid_input', 'unsupported_mode', 'capacity']),
    })
    .strict(),
]);
export type ReplaySafeAssistantIntentTranslation = z.infer<typeof translationResultSchema>;

/** Pure translation from configured human scope and one final AI message. No IDs/hashes are inferred as authority. */
export function prepareReplaySafeAssistantIntent(
  runtimeInput: AutomaticRuntimeInput,
  currentHumanContent: string,
  finalMessage: BaseMessage,
  attemptIdHash: string,
  invocationDeadlineMs: number,
): ReplaySafeAssistantIntentTranslation {
  const reject = (
    reason: 'invalid_input' | 'unsupported_mode' | 'capacity',
  ): ReplaySafeAssistantIntentTranslation => ({ kind: 'rejected', reason });
  try {
    const runtime = AutomaticRuntimeSchema.parse(
      cloneBoundedAutomaticCaptureJson(runtimeInput, 'beginRequest'),
    );
    if (runtime.profileId === 'existing' || !runtime.capturedSourceId)
      return reject('unsupported_mode');
    if (typeof currentHumanContent !== 'string' || currentHumanContent.length === 0)
      return reject('invalid_input');
    if (currentHumanContent.length > 65536) return reject('capacity');
    if (readReplaySafeMessageRole(finalMessage) !== 'ai') return reject('invalid_input');
    const content = readReplaySafeMessageData(finalMessage, 'content');
    if (typeof content !== 'string' || content.length === 0) return reject('invalid_input');
    if (content.length > 65536) return reject('capacity');
    if (content.trim().length === 0) return reject('invalid_input');
    const additional = cloneBoundedAutomaticCaptureJson(
      readReplaySafeMessageData(finalMessage, 'additional_kwargs') ?? {},
      'beginRequest',
    ) as Record<string, unknown>;
    const noCalls = (calls: unknown) =>
      calls === null ||
      calls === undefined ||
      (!utilTypes.isProxy(calls) && Array.isArray(calls) && calls.length === 0);
    if (
      !noCalls(readReplaySafeMessageData(finalMessage, 'tool_calls')) ||
      !noCalls(additional.tool_calls) ||
      (additional.function_call !== null && additional.function_call !== undefined)
    )
      return reject('invalid_input');
    const wrapper = runtime.actor.applicationOwnedWrapper ?? null;
    const region = runtime.actor.humanRegion ?? null;
    if (wrapper === true && runtime.rawHumanContent === undefined) return reject('invalid_input');
    const body = region ? currentHumanContent.slice(region.start, region.end) : currentHumanContent;
    if ((runtime.rawHumanContent ?? currentHumanContent) !== body) return reject('invalid_input');
    const originalMessageId = readReplaySafeMessageData(finalMessage, 'id');
    const intent = AutomaticAssistantCaptureIntentV2Schema.parse({
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'assistant_final_save',
      humanTurn: {
        namespace: runtime.actor.namespace,
        issuer: runtime.actor.issuer,
        actorReference: runtime.actor.actorReference,
        turn: runtime.turnId,
        input: {
          content: currentHumanContent,
          applicationOwnedWrapper: wrapper,
          humanRegion: region,
          quoteRegions: runtime.actor.quoteRegions ?? [],
        },
      },
      finalAssistant: {
        content,
        sourceMessageId: originalMessageId ?? null,
        conversationId: null,
        senderId: null,
        senderName: null,
        sourceWorkflowId: null,
        originalSourceExecutionId: null,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
      },
      attemptIdHash,
      invocationDeadlineMs,
    });
    return translationResultSchema.parse({ kind: 'prepared', intent });
  } catch (error) {
    return reject(
      error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json'
        ? 'capacity'
        : 'invalid_input',
    );
  }
}
