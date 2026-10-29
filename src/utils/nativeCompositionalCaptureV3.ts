import type { IExecuteFunctions } from 'n8n-workflow';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import { nativeCompositionalProcessingAttemptHashV3 } from './nativeCompositionalProcessingV3';
import { readReplaySafeHumanCaptureRequest } from './replaySafeAutomaticAdmin';

/** Native configuration mapping only; no storage/write/processing authority. */
export function readNativeCompositionalHumanCaptureRequestV3(
  ctx: IExecuteFunctions,
  index: number,
) {
  if (ctx.getNode().parameters.automaticPreferenceInterpreter !== 'compositionalV2')
    throw new Error('Engram compositional capture: unsupported_configuration');
  const literalMapping = readReplaySafeHumanCaptureRequest(ctx, index);
  return CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
    ...literalMapping,
    version: 3,
    preferenceInterpreter: 'compositionalV2',
    attemptIdHash: nativeCompositionalProcessingAttemptHashV3(ctx, {
      namespace: literalMapping.namespace,
      issuer: literalMapping.issuer,
      actorReference: literalMapping.actorReference,
      turn: literalMapping.turn,
    }),
  });
}
