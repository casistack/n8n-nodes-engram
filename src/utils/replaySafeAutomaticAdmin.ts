import { createHash } from 'crypto';
import type { IExecuteFunctions } from 'n8n-workflow';
import {
  AutomaticCaptureBeginRequestV2Schema,
  canonicalAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { readAutomaticRuntime } from './automaticMemory';
import { AutomaticCapturePublicResultV2Schema } from '../schemas/AutomaticCaptureApi.schema';

/** Fixed conditions shared by expression rendering and execution. */
const safeOutputConditions = [
  { field: 'automaticCaptureLifecycle', fallback: 'legacy', value: 'legacy', equal: false },
] as const;
export function usesReplaySafeCaptureOutputs(parameters: Record<string, unknown> = {}): boolean {
  return safeOutputConditions.every(
    (condition) =>
      ((parameters[condition.field] === undefined
        ? condition.fallback
        : parameters[condition.field]) ===
        condition.value) ===
      condition.equal,
  );
}

const safeOutputPredicateExpression = safeOutputConditions
  .map(
    (condition) =>
      `($parameter.toJSON()[${JSON.stringify(condition.field)}] === undefined ? ${JSON.stringify(condition.fallback)} : $parameter.toJSON()[${JSON.stringify(condition.field)}]) ${condition.equal ? '===' : '!=='} ${JSON.stringify(condition.value)}`,
  )
  .join(' && ');
export const replaySafeCaptureOutputsExpression =
  `={{ (${safeOutputPredicateExpression}) ? [{type: 'main', displayName: 'Proceed'}, {type: 'main', displayName: 'Stopped'}] : ['main'] }}` as const;

export function stoppedReplaySafeCapture() {
  return AutomaticCapturePublicResultV2Schema.parse({
    version: 2,
    purpose: null,
    status: 'failed',
    sourceId: null,
    sourcePersistence: 'unknown',
    should_process: false,
    currentAuthority: 'not_evaluated',
    receiptSummary: null,
  });
}

/** Trusted native configuration only. Current execution metadata is attempt provenance, never source identity. */
export function readReplaySafeHumanCaptureRequest(ctx: IExecuteFunctions, index: number) {
  const get = (name: string, fallback: unknown) =>
    ctx.getNodeParameter(name, index, fallback as string);
  const node = ctx.getNode();
  if (
    node.type !== 'n8n-nodes-engram.engramAdmin' ||
    node.typeVersion !== 3 ||
    node.parameters.resource !== 'automaticMemory' ||
    node.parameters.operation !== 'captureHuman' ||
    node.parameters.automaticCaptureLifecycle !== 'replaySafeV2' ||
    node.continueOnFail ||
    (node.onError && node.onError !== 'stopWorkflow')
  )
    throw new Error('Engram automatic capture: unsupported_mode');
  if (get('automaticExecution', 'synchronous') !== 'synchronous')
    throw new Error('Engram automatic capture: unsupported_mode');
  const namespace = get('automaticNamespace', '') as string;
  // This reader uses the runtime schema only for exact configured mapping; the backend derives store identity.
  const runtime = readAutomaticRuntime(get, namespace, '0'.repeat(64));
  if (!runtime || runtime.capturedSourceId)
    throw new Error('Engram automatic capture: invalid_input');
  const content = get('automaticInput', '') as string;
  const region = runtime.actor.humanRegion;
  if (runtime.actor.applicationOwnedWrapper === true && runtime.rawHumanContent === undefined)
    throw new Error('Engram automatic capture: invalid_input');
  const body = region ? content.slice(region.start, region.end) : content;
  if (runtime.rawHumanContent !== undefined && runtime.rawHumanContent !== body)
    throw new Error('Engram automatic capture: invalid_input');
  const execution = ctx.getExecutionId();
  if (!execution || !execution.trim()) throw new Error('Engram automatic capture: invalid_input');
  const attemptIdHash = createHash('sha256')
    .update(
      canonicalAutomaticCaptureV2({
        domain: 'engram-native-capture-attempt-v2',
        workflow: ctx.getWorkflow().id ?? null,
        execution,
        node: node.id,
        action: 'captureHuman',
      }),
      'utf8',
    )
    .digest('hex');
  return AutomaticCaptureBeginRequestV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    namespace,
    issuer: runtime.actor.issuer,
    actorReference: runtime.actor.actorReference,
    turn: runtime.turnId,
    attemptIdHash,
    settings: {
      profileId: runtime.profileId,
      requestedTrustLevel: 'standard',
      intentSetting: runtime.explicitIntent,
      invocationDeadlineMs: get('extractionDeadlineMs', 30000),
    },
    source: {
      content,
      sourceMessageId: null,
      conversationId: null,
      senderId: null,
      senderName: null,
      sourceWorkflowId: get('automaticOriginalWorkflow', '') || null,
      originalSourceExecutionId: get('automaticOriginalExecution', '') || null,
      sourceType: 'message',
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' },
      applicationOwnedWrapper: runtime.actor.applicationOwnedWrapper ?? null,
      humanRegion: region ?? null,
      quoteRegions: runtime.actor.quoteRegions ?? [],
    },
  });
}
