import type { IExecuteFunctions } from 'n8n-workflow';
import { AutomaticRuntimeSchema } from '../schemas/AutomaticRuntime.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { nativeCompositionalProcessingAttemptHashV3 } from './nativeCompositionalProcessingV3';
import { readReplaySafeMemoryNativeContext } from './replaySafeMemoryNative';

/** Native configuration data only. Actual stored parent/current authority is checked by Memory. */
export function readNativeCompositionalMemoryContextV3(
  ctx: IExecuteFunctions,
  runtimeValue: unknown,
  itemIndex = 0,
) {
  if (ctx.getNode().parameters.automaticPreferenceInterpreter !== 'compositionalV2')
    throw new Error('Engram compositional memory: unsupported_configuration');
  const native = readReplaySafeMemoryNativeContext(ctx, itemIndex);
  if (!native) throw new Error('Engram compositional memory: unsupported_configuration');
  let runtime;
  try {
    runtime = AutomaticRuntimeSchema.parse(
      cloneBoundedAutomaticCaptureJson(runtimeValue, 'beginRequest'),
    );
  } catch {
    throw new Error('Engram compositional memory: unsupported_configuration');
  }
  if (runtime.profileId === 'existing' || !runtime.capturedSourceId)
    throw new Error('Engram compositional memory: unsupported_configuration');
  return Object.freeze({
    ...native,
    automaticPreferenceInterpreter: 'compositionalV2' as const,
    expectedHumanProcessingAttemptHash: nativeCompositionalProcessingAttemptHashV3(ctx, {
      namespace: runtime.actor.namespace,
      issuer: runtime.actor.issuer,
      actorReference: runtime.actor.actorReference,
      turn: runtime.turnId,
    }),
  });
}
