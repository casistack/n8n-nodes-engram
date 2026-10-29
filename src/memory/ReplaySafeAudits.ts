import { createHash } from 'crypto';
import { types as utilTypes } from 'util';
import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
  AutomaticCaptureReadRequestV2Schema,
  type AutomaticCaptureReadRequestV2,
} from '../schemas/AutomaticCaptureApi.schema';
import { REPLAY_SAFE_AUDIT_LIMITS as limits } from '../schemas/ReplaySafeMemory.schema';
import {
  cloneBoundedAutomaticCaptureJson,
  BoundedAutomaticCaptureJsonError,
} from '../storage/BoundedAutomaticCaptureJson';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import type { EpisodeMessageWrite } from './EngramChatMessageHistory';

const candidateSchema = z
  .object({
    message: z.custom<BaseMessage>((value) => value !== null && typeof value === 'object'),
    position: z.number().int().min(0).max(999),
  })
  .strict();
export type ReplaySafeAuditCandidate = z.infer<typeof candidateSchema>;
const identifierSchema = z
  .string()
  .min(1)
  .max(limits.identifierUnits)
  .refine(
    (value) =>
      value.length <= limits.identifierUnits &&
      value.trim().length > 0 &&
      value.trim() === value &&
      Buffer.byteLength(value, 'utf8') <= limits.identifierUnits &&
      Buffer.from(value, 'utf8').toString('utf8') === value,
  );
const resultSchema = z.union([
  z
    .object({
      kind: z.literal('prepared'),
      requested: z.number().int().min(0).max(limits.perSave),
      payloadBytes: z.number().int().min(0).max(limits.aggregateBytes),
      writes: z.array(z.custom<EpisodeMessageWrite>()).max(limits.perSave),
    })
    .strict(),
  z
    .object({
      kind: z.literal('rejected'),
      requested: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      reason: z.enum(['capacity', 'invalid_input']),
    })
    .strict(),
]);
export type ReplaySafeAuditPreparation = z.infer<typeof resultSchema>;

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw new Error('Engram audit: invalid_input');
  return descriptor.value;
}

function inheritedData(value: object, key: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 16; depth++) {
    if (utilTypes.isProxy(current)) throw new Error('Engram audit: invalid_input');
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!('value' in descriptor)) throw new Error('Engram audit: invalid_input');
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/** LangChain versions differ in method placement; resolve their methods without accessor lookup. */
function auditRole(message: BaseMessage): string {
  const method = inheritedData(message, '_getType');
  const modernMethod = inheritedData(message, 'getType');
  inheritedData(message, 'type');
  if (
    typeof method !== 'function' ||
    (modernMethod !== undefined && typeof modernMethod !== 'function')
  )
    throw new Error('Engram audit: invalid_input');
  return z.string().min(1).max(32).parse(method.call(message));
}

export { ownData as readReplaySafeMessageData, auditRole as readReplaySafeMessageRole };

/** Pure preflight of the entire logical save. No provider, storage, final lease or source mutation. */
export function prepareReplaySafeAudits(
  input: readonly ReplaySafeAuditCandidate[],
  scopeInput: AutomaticCaptureReadRequestV2,
): ReplaySafeAuditPreparation {
  let requested = 0;
  const reject = (reason: 'capacity' | 'invalid_input'): ReplaySafeAuditPreparation => ({
    kind: 'rejected',
    requested,
    reason,
  });
  try {
    if (utilTypes.isProxy(input) || !Array.isArray(input)) return reject('invalid_input');
    requested = input.length;
    if (requested > limits.perSave) return reject('capacity');
    const scope = AutomaticCaptureReadRequestV2Schema.parse(
      cloneBoundedAutomaticCaptureJson(scopeInput, 'beginRequest'),
    );
    if (scope.role !== 'human') return reject('invalid_input');
    const writes: EpisodeMessageWrite[] = [];
    let aggregate = 0;
    for (let index = 0; index < requested; index++) {
      const entry = Object.getOwnPropertyDescriptor(input, String(index));
      if (!entry || !('value' in entry)) return reject('invalid_input');
      const candidate: unknown = entry.value;
      if (!candidate || typeof candidate !== 'object' || utilTypes.isProxy(candidate))
        return reject('invalid_input');
      const fields = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(fields);
      if (
        keys.length !== 2 ||
        !keys.includes('message') ||
        !keys.includes('position') ||
        keys.some(
          (key) => typeof key !== 'string' || !('value' in fields[key]) || !fields[key].enumerable,
        )
      )
        return reject('invalid_input');
      // Zod's generic object discrimination can inspect then/catch on a class.
      // Keep the opaque LangChain instance out of that path; only parse its data fields below.
      const messageValue: unknown = fields.message.value;
      if (
        messageValue === null ||
        typeof messageValue !== 'object' ||
        utilTypes.isProxy(messageValue)
      )
        return reject('invalid_input');
      const message = messageValue as BaseMessage;
      const position = candidateSchema.shape.position.parse(fields.position.value);
      const role = auditRole(message);
      if (role === 'human') return reject('invalid_input');
      const nullableId = (value: unknown) =>
        value === undefined || value === null || value === ''
          ? null
          : identifierSchema.parse(value);
      const messageId = nullableId(ownData(message, 'id'));
      const toolCallId = nullableId(ownData(message, 'tool_call_id'));
      const canonicalCalls = ownData(message, 'tool_calls');
      const additional = cloneBoundedAutomaticCaptureJson(
        ownData(message, 'additional_kwargs') ?? {},
        'beginRequest',
      ) as Record<string, unknown>;
      const payload = cloneBoundedAutomaticCaptureJson(
        {
          role,
          content: ownData(message, 'content'),
          tool_calls: canonicalCalls ?? null,
          provider_tool_calls: additional.tool_calls ?? null,
          function_call: additional.function_call ?? null,
        },
        'beginRequest',
      );
      const serialized = JSON.stringify(payload);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      aggregate += bytes;
      if (bytes > limits.payloadBytes || aggregate > limits.aggregateBytes)
        return reject('capacity');
      // Hash exactly the stored bounded envelope, including structured tool arguments.
      const contentHash = createHash('sha256').update(serialized, 'utf8').digest('hex');
      const key = hashAutomaticCaptureV2({
        domain: 'engram-audit-event-v2',
        namespace: scope.namespace,
        issuer: scope.issuer,
        actorReference: scope.actorReference,
        turn: scope.turn,
        role,
        toolCallId,
        messageId,
        position: toolCallId === null && messageId === null ? position : null,
        contentHash,
      });
      writes.push({
        message: new SystemMessage(serialized),
        metadata: {
          episode_kind: 'tool_output',
          source_type: 'message',
          idempotency_key: `automatic-audit-v2:${key}`,
          source_message_id: null,
          conversation_id: null,
          sender_id: null,
          sender_name: null,
          source_workflow_id: null,
          source_execution_id: null,
          quoted_message_id: null,
          trust_level: 'unverified',
          review_status: 'proposed',
          attributes: {
            engram_audit: true,
            engram_message: {
              original_role: role,
              original_message_id: messageId,
              tool_call_id: toolCallId,
            },
          },
        },
      });
    }
    return resultSchema.parse({ kind: 'prepared', requested, payloadBytes: aggregate, writes });
  } catch (error) {
    return reject(
      error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json'
        ? 'capacity'
        : 'invalid_input',
    );
  }
}
