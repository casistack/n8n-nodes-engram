import {
  compileAutonomousPersonalPolicyV3 as compile,
  AutonomousPersonalPolicyV3Schema as Schema,
  AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS,
} from '../../../src/schemas/AutonomousPersonalPolicyV3.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { compileCompositionalAutomaticPolicyV2 } from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';

const goldens = {
  conservative: [
    '4cbbe760432c51a478786dd32d644ac628ccfc311314d44e099d26fa79b9976d',
    '27ae057230adc4d6258fdaf14816bddfa0dc3dec4281e06348475775631dd084',
    '472adece1d88bd423db9ac293dea6b13136b7acc62f3cce68cc224a0ac5c5d32',
  ],
  explicit: [
    'bbdb43bcba958223134fad530c56b203e84a3736af2e72417ed76b4eb81a0eb7',
    '4bbc8e3ab84262fa44f97f6d748fcc076e132b87e2798c640b42c484ef996dc6',
    '898280cf46c861f5d040ef8aa34b48e8ea52ad8ccae06b7f2c7081558cc76980',
  ],
  reviewFirst: [
    '92b42ba2140717667c575839828e962a3b8717e912713587314ef6763ffa0d90',
    '3047ddd7bf7a433612d85145111d200e74bd3ccc8aae03dd7b19901db43fe01a',
    '256702f665e34ae9bc7648b4f01916cebc9bb5c39db6e104112f900c53d329b1',
  ],
} as const;
const resign = (value: ReturnType<typeof compile>) => {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'fingerprint'));
  return {
    ...body,
    fingerprint: hashAutomaticCaptureV2({ domain: 'engram-autonomous-policy-v1', policy: body }),
  };
};
describe('standalone autonomous policy3 data contract', () => {
  test.each(['conservative', 'explicit', 'reviewFirst'] as const)(
    'freezes the %s profile and leaves old policy fingerprints unchanged',
    (profileId) => {
      const beforeLiteral = JSON.stringify(compileAutomaticPolicy({ profileId }));
      const beforeCompositional = JSON.stringify(
        compileCompositionalAutomaticPolicyV2({ profileId }),
      );
      const policy = compile({ profileId });
      expect(policy).toMatchObject({
        version: 3,
        profileVersion: 2,
        autoAccept: profileId !== 'reviewFirst',
        requiresProtectedIntent: profileId === 'explicit',
        preferenceInterpreter: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
      });
      expect(policy.fingerprint).toBe(goldens[profileId][0]);
      expect(compileAutomaticPolicy({ profileId }).fingerprint).toBe(goldens[profileId][1]);
      expect(compileCompositionalAutomaticPolicyV2({ profileId }).fingerprint).toBe(
        goldens[profileId][2],
      );
      expect(JSON.stringify(compileAutomaticPolicy({ profileId }))).toBe(beforeLiteral);
      expect(JSON.stringify(compileCompositionalAutomaticPolicyV2({ profileId }))).toBe(
        beforeCompositional,
      );
      expect(Buffer.byteLength(JSON.stringify(policy))).toBeLessThanOrEqual(4096);
      expect(Schema.parse(policy)).toEqual(policy);
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.limits)).toBe(true);
      expect(Object.isFrozen(policy.preferenceInterpreter)).toBe(true);
      expect(Object.isFrozen(policy.finalizationReserve)).toBe(true);
      expect(policy.limits).not.toBe(AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS);
    },
  );
  test.each([
    undefined,
    {},
    { profileId: 'existing' },
    { profileId: 'conservative', autoAccept: true },
    { profileId: 'conservative', actor: 'synthetic-authority' },
  ])('requires an explicit profile without caller authority fields: %j', (input) => {
    expect(() => compile(input)).toThrow('Invalid autonomous personal policy data');
  });
  test('does not permit re-signed acceptance flags, limits or interpreter changes', () => {
    const policy = compile({ profileId: 'reviewFirst' });
    const changed = structuredClone(policy);
    changed.autoAccept = true;
    expect(Schema.safeParse(resign(changed)).success).toBe(false);
    const intent = { ...compile({ profileId: 'explicit' }), requiresProtectedIntent: false };
    expect(Schema.safeParse(resign(intent)).success).toBe(false);
    const invalid = [
      { ...policy, version: 2 },
      { ...policy, profileVersion: 1 },
      { ...policy, limits: { ...policy.limits, providerMaxAttempts: 3 } },
      { ...policy, limits: { ...policy.limits, sourceUnits: 129 } },
      { ...policy, limits: { ...policy.limits, statementBytes: 4097 } },
      { ...policy, preferenceInterpreter: { ...policy.preferenceInterpreter, lexiconVersion: 3 } },
      { ...policy, finalizationReserve: { ...policy.finalizationReserve, maxMs: 1001 } },
      { ...policy, fingerprint: '0'.repeat(64) },
      { ...policy, should_process: true },
    ];
    for (const value of invalid) expect(Schema.safeParse(value).success).toBe(false);
  });
  test('fingerprints are independent of object key order', () => {
    const policy = compile({ profileId: 'conservative' });
    const reversed = Object.fromEntries(Object.entries(policy).reverse());
    expect(Schema.parse(reversed).fingerprint).toBe(policy.fingerprint);
    expect(
      Schema.parse({
        ...reversed,
        limits: Object.fromEntries(Object.entries(policy.limits).reverse()),
      }),
    ).toEqual(policy);
  });
  test('owns raw JavaScript before Zod without invoking getters, proxies or serialization methods', () => {
    let traps = 0;
    for (const value of [
      Object.defineProperty({}, 'then', { enumerable: true, get: () => ++traps }),
      Object.defineProperty({}, 'profileId', { enumerable: true, get: () => ++traps }),
      { profileId: 'conservative', toJSON: () => ++traps },
      new Proxy(
        {},
        {
          get: () => ++traps,
          ownKeys: () => {
            traps++;
            return [];
          },
        },
      ),
    ]) {
      expect(() => compile(value)).toThrow();
      expect(Schema.safeParse(value).success).toBe(false);
    }
    expect(traps).toBe(0);
  });
  test('bounds raw preflight and returns fixed redacted errors', () => {
    const privateValue = 'synthetic-private-'.repeat(1500);
    const result = Schema.safeParse({ padding: privateValue });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('Invalid autonomous personal policy data');
      expect(result.error.message).not.toContain(privateValue);
    }
  });
});
