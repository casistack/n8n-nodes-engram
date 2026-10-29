import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { buildAutomaticOperationDescriptorV2 } from '../../../src/extraction/AutomaticCaptureDescriptor';
import {
  AutomaticCaptureDescriptorBuildResultV2Schema,
  AutomaticOperationDescriptorSettingsV2Schema,
  AutomaticOperationDescriptorV2Schema,
  hashAutomaticCaptureV2,
} from '../../../src/schemas/AutomaticCapture.schema';

function build(profileId: 'conservative' | 'explicit' | 'reviewFirst' = 'conservative') {
  return buildAutomaticOperationDescriptorV2({
    purpose: 'human_turn_memory',
    profileId,
    requestedTrustLevel: 'trusted',
    intentSetting: true,
    invocationDeadlineMs: 15_000,
  });
}

describe('buildAutomaticOperationDescriptorV2', () => {
  it.each(['conservative', 'explicit', 'reviewFirst'] as const)(
    'builds a compiled, immutable %s human descriptor',
    (profileId) => {
      const result = build(profileId);
      expect(result.descriptor.policy).toEqual(compileAutomaticPolicy({ profileId }));
      expect(result.descriptor.settingsHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.descriptorHash).toBe(hashAutomaticCaptureV2(result.descriptor));
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.descriptor)).toBe(true);
      expect(Object.isFrozen(result.descriptor.policy)).toBe(true);
    },
  );

  it('rejects the existing profile, assistant purpose, unknown settings and invalid deadlines', () => {
    const valid = {
      purpose: 'human_turn_memory',
      profileId: 'conservative',
      requestedTrustLevel: 'trusted',
      intentSetting: true,
      invocationDeadlineMs: 100,
    };
    expect(() =>
      buildAutomaticOperationDescriptorV2({ ...valid, profileId: 'existing' } as never),
    ).toThrow();
    expect(() =>
      buildAutomaticOperationDescriptorV2({ ...valid, purpose: 'assistant_final_save' } as never),
    ).toThrow();
    expect(() => buildAutomaticOperationDescriptorV2({ ...valid, policy: {} } as never)).toThrow();
    expect(() =>
      buildAutomaticOperationDescriptorV2({ ...valid, invocationDeadlineMs: 120_001 } as never),
    ).toThrow();
  });

  it('rejects tampered policy fields even when the schema shape is otherwise valid', () => {
    const descriptor = build().descriptor;
    expect(
      AutomaticOperationDescriptorV2Schema.safeParse({
        ...descriptor,
        policy: { ...descriptor.policy, autoAccept: false, fingerprint: 'b'.repeat(64) },
      }).success,
    ).toBe(false);
  });

  it('rejects tampered settings and descriptor hashes', () => {
    const result = build();
    expect(
      AutomaticOperationDescriptorV2Schema.safeParse({
        ...result.descriptor,
        settingsHash: 'c'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      AutomaticCaptureDescriptorBuildResultV2Schema.safeParse({
        ...result,
        descriptorHash: 'd'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('uses the strict settings schema for the hash recipe', () => {
    const descriptor = build().descriptor;
    const settings = {
      lifecycle: descriptor.lifecycle,
      purpose: descriptor.purpose,
      interpreterId: descriptor.interpreterId,
      semanticVersion: descriptor.semanticVersion,
      grammarVersion: descriptor.grammarVersion,
      lexiconVersion: descriptor.lexiconVersion,
      requestedTrustLevel: descriptor.requestedTrustLevel,
      intentSetting: descriptor.intentSetting,
      invocationDeadlineMs: descriptor.invocationDeadlineMs,
      policy: descriptor.policy,
      assistantWriteAuthority: descriptor.assistantWriteAuthority,
    };
    expect(AutomaticOperationDescriptorSettingsV2Schema.parse(settings)).toEqual(settings);
    expect(
      AutomaticOperationDescriptorSettingsV2Schema.safeParse({
        ...settings,
        policy: { ...settings.policy, autoAccept: false, fingerprint: 'e'.repeat(64) },
      }).success,
    ).toBe(false);
  });

  it('hashes canonical descriptors independently of object key order', () => {
    const result = build('explicit');
    const reordered = Object.fromEntries(Object.entries(result.descriptor).reverse());
    expect(AutomaticOperationDescriptorV2Schema.safeParse(reordered).success).toBe(true);
    expect(hashAutomaticCaptureV2(reordered)).toBe(result.descriptorHash);
  });
});
