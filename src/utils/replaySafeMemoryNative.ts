import { createHash } from 'crypto';
import { NodeConnectionType, type IExecuteFunctions } from 'n8n-workflow';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { MemoryProcessingAttemptHashSchema } from '../schemas/ReplaySafeMemory.schema';
import { AutomaticActorSchema } from '../schemas/AutomaticMemory.schema';

/** Exact configured namespace for the new lifecycle; legacy trimming stays separate. */
export function readReplaySafeMemoryNamespace(ctx: IExecuteFunctions, itemIndex: number): string {
  try {
    const selection = ctx.getNodeParameter('sessionIdType', itemIndex);
    const value =
      selection === 'fromInput'
        ? ctx.evaluateExpression('{{ $json.sessionId }}', itemIndex)
        : selection === 'customKey'
          ? ctx.getNodeParameter('sessionKey', itemIndex, '')
          : undefined;
    return AutomaticActorSchema.shape.namespace.parse(value);
  } catch {
    throw new Error('Engram replay-safe memory: unsupported_configuration');
  }
}

/** Native configuration admission only; this neither reads nor authorizes stored memory. */
export function readReplaySafeMemoryNativeContext(ctx: IExecuteFunctions, itemIndex = 0) {
  const node = ctx.getNode();
  const lifecycle = node.parameters?.automaticCaptureLifecycle;
  if (lifecycle === undefined || lifecycle === 'legacy') return undefined;
  if (
    lifecycle !== 'replaySafeV2' ||
    node.type !== 'n8n-nodes-engram.engramMemory' ||
    node.typeVersion !== 3 ||
    node.continueOnFail ||
    (node.onError && node.onError !== 'stopWorkflow')
  )
    throw new Error('Engram replay-safe memory: unsupported_configuration');
  // SupplyDataContext carries the parent agent's main input. Request it
  // explicitly: its default connection type is ai_memory, whose input is empty.
  const items = ctx.getInputData(0, NodeConnectionType.Main);
  if (itemIndex !== 0 || !Array.isArray(items) || items.length !== 1)
    throw new Error('Engram replay-safe memory: single_event_required');
  const execution = ctx.getExecutionId();
  if (typeof execution !== 'string' || !execution.trim())
    throw new Error('Engram replay-safe memory: processing_attempt_required');
  const processingAttemptHash = MemoryProcessingAttemptHashSchema.parse(
    createHash('sha256')
      .update(
        canonicalAutomaticCaptureV2({
          domain: 'engram-native-memory-attempt-v2',
          workflow: ctx.getWorkflow().id ?? null,
          execution,
          node: node.id,
          action: 'saveFinalAssistant',
        }),
        'utf8',
      )
      .digest('hex'),
  );
  return { captureLifecycle: 'replaySafeV2' as const, processingAttemptHash };
}
