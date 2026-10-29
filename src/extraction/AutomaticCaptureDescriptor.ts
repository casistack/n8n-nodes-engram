import { z } from 'zod';
import { compileAutomaticPolicy } from './AutomaticEvidence';
import {
  AutomaticCaptureDescriptorBuildResultV2Schema,
  AutomaticOperationDescriptorV2Schema,
  AutomaticCaptureTrustLevelV2Schema,
  automaticOperationDescriptorSettingsHashV2,
  hashAutomaticCaptureV2,
  type AutomaticCaptureDescriptorBuildResultV2,
  type AutomaticOperationDescriptorSettingsV2,
} from '../schemas/AutomaticCapture.schema';

/** The only descriptor factory implemented in this checkpoint is human-purpose. */
export const BuildAutomaticOperationDescriptorV2InputSchema = z
  .object({
    purpose: z.literal('human_turn_memory'),
    profileId: z.enum(['conservative', 'explicit', 'reviewFirst']),
    requestedTrustLevel: AutomaticCaptureTrustLevelV2Schema,
    intentSetting: z.boolean(),
    invocationDeadlineMs: z.number().int().min(100).max(120_000),
  })
  .strict();
export type BuildAutomaticOperationDescriptorV2Input = z.input<
  typeof BuildAutomaticOperationDescriptorV2InputSchema
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((nested) => deepFreeze(nested));
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the closed literal-v1 descriptor for an explicitly requested human capture.
 * This does not mint a lease, operation, or processing authority.
 */
export function buildAutomaticOperationDescriptorV2(
  value: BuildAutomaticOperationDescriptorV2Input,
): AutomaticCaptureDescriptorBuildResultV2 {
  const input = BuildAutomaticOperationDescriptorV2InputSchema.parse(value);
  const policy = compileAutomaticPolicy({ profileId: input.profileId });
  const settings: AutomaticOperationDescriptorSettingsV2 = {
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    interpreterId: 'literal-parser-v1',
    semanticVersion: 1,
    grammarVersion: 1,
    lexiconVersion: 1,
    requestedTrustLevel: input.requestedTrustLevel,
    intentSetting: input.intentSetting,
    invocationDeadlineMs: input.invocationDeadlineMs,
    policy,
    assistantWriteAuthority: null,
  };
  const descriptor = AutomaticOperationDescriptorV2Schema.parse({
    version: 2,
    lifecycle: settings.lifecycle,
    purpose: settings.purpose,
    executionMode: 'synchronous',
    interpreterId: settings.interpreterId,
    semanticVersion: settings.semanticVersion,
    grammarVersion: settings.grammarVersion,
    lexiconVersion: settings.lexiconVersion,
    requestedTrustLevel: settings.requestedTrustLevel,
    intentSetting: settings.intentSetting,
    policy: settings.policy,
    assistantWriteAuthority: settings.assistantWriteAuthority,
    invocationDeadlineMs: settings.invocationDeadlineMs,
    settingsHash: automaticOperationDescriptorSettingsHashV2(settings),
  });
  const result = AutomaticCaptureDescriptorBuildResultV2Schema.parse({
    descriptor,
    descriptorHash: hashAutomaticCaptureV2(descriptor),
  });
  return deepFreeze(result);
}
