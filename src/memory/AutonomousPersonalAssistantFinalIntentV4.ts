import { types as utilTypes } from 'util';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
  AutonomousPersonalAssistantFinalIntentV4Schema,
  type AutonomousPersonalAssistantFinalIntentV4,
} from '../schemas/AutonomousPersonalAssistantFinalV4.schema';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from '../storage/BoundedAutomaticCaptureJson';
import { readReplaySafeMessageData, readReplaySafeMessageRole } from './ReplaySafeAudits';

const rejectionReason = z.enum(['invalid_input', 'unsupported_mode', 'capacity']);

export type AutonomousPersonalAssistantFinalIntentV4Translation =
  | { readonly kind: 'prepared'; readonly intent: AutonomousPersonalAssistantFinalIntentV4 }
  | { readonly kind: 'rejected'; readonly reason: z.infer<typeof rejectionReason> };

function noCalls(calls: unknown): boolean {
  return (
    calls === null ||
    calls === undefined ||
    (!utilTypes.isProxy(calls) && Array.isArray(calls) && calls.length === 0)
  );
}

/**
 * Translate one final AI message and an optional actual human message into
 * strict final-turn DATA. This carries no native origin or write authority.
 */
export function prepareAutonomousPersonalAssistantFinalIntentV4(
  humanMessage: BaseMessage | undefined,
  finalAI: BaseMessage,
  memoryAttemptHash: string,
  invocationDeadlineMs: number,
): AutonomousPersonalAssistantFinalIntentV4Translation {
  const reject = (
    reason: z.infer<typeof rejectionReason>,
  ): AutonomousPersonalAssistantFinalIntentV4Translation => ({ kind: 'rejected', reason });

  try {
    let humanObservation: { kind: 'configured_query' } | { kind: 'message'; content: string };
    if (humanMessage === undefined) {
      humanObservation = { kind: 'configured_query' };
    } else {
      if (readReplaySafeMessageRole(humanMessage) !== 'human') return reject('invalid_input');
      const humanContent = readReplaySafeMessageData(humanMessage, 'content');
      if (typeof humanContent !== 'string' || humanContent.length === 0)
        return reject('invalid_input');
      if (humanContent.length > 65_536 || Buffer.byteLength(humanContent, 'utf8') > 65_536)
        return reject('capacity');
      humanObservation = { kind: 'message', content: humanContent };
    }

    if (readReplaySafeMessageRole(finalAI) !== 'ai') return reject('invalid_input');
    const content = readReplaySafeMessageData(finalAI, 'content');
    if (typeof content !== 'string' || content.length === 0) return reject('invalid_input');
    if (content.length > 65_536 || Buffer.byteLength(content, 'utf8') > 65_536)
      return reject('capacity');
    if (content.trim().length === 0) return reject('invalid_input');

    const additional = cloneBoundedAutomaticCaptureJson(
      readReplaySafeMessageData(finalAI, 'additional_kwargs') ?? {},
      'beginRequest',
    ) as Record<string, unknown>;
    if (
      !noCalls(readReplaySafeMessageData(finalAI, 'tool_calls')) ||
      !noCalls(additional.tool_calls) ||
      (additional.function_call !== null && additional.function_call !== undefined)
    ) {
      return reject('invalid_input');
    }

    const intent = AutonomousPersonalAssistantFinalIntentV4Schema.parse(
      cloneBoundedAutomaticCaptureJson(
        {
          version: 4,
          purpose: 'assistant_final_save',
          humanObservation,
          finalAssistant: {
            content,
            sourceMessageId: readReplaySafeMessageData(finalAI, 'id') ?? null,
            conversationId: null,
            senderId: null,
            senderName: null,
            sourceWorkflowId: null,
            originalSourceExecutionId: null,
            sourceType: 'message',
            quotedMessageId: null,
            eventTime: { mode: 'first_capture' },
          },
          memoryAttemptHash,
          invocationDeadlineMs,
        },
        'assistantIntent',
      ),
    );
    return { kind: 'prepared', intent };
  } catch (error) {
    return reject(
      error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json'
        ? 'capacity'
        : 'invalid_input',
    );
  }
}
