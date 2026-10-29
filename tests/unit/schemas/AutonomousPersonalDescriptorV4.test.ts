import {
  compileAutonomousPersonalDescriptorV4 as compile,
  hashAutonomousPersonalDescriptorV4 as hash,
  AutonomousPersonalDescriptorV4Schema as Schema,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { compileAutonomousPersonalPolicyV3 } from '../../../src/schemas/AutonomousPersonalPolicyV3.schema';
import {
  compileCompositionalAutomaticDescriptorV3,
  hashCompositionalAutomaticDescriptorV3,
} from '../../../src/schemas/CompositionalAutomaticMemory.schema';

const input = () => ({
  profileId: 'conservative',
  requestedTrustLevel: 'standard',
  intentSetting: false,
  invocationDeadlineMs: 30000,
  providerReference: {
    routeId: ' synthetic route ',
    configurationFingerprint: 'a'.repeat(64),
    protocol: 'openai-compatible-json-v1',
    configuredRequestLimit: 32,
    configuredTimeoutMs: 30000,
    configuredRequestBytes: 262144,
    configuredResponseBytes: 65536,
    temperature: { mode: 'providerDefault' },
    responseFormat: 'json_object',
    outputTokenLimit: { mode: 'omit' },
  },
});
const resign = (value: object) => {
  const settings = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'settingsHash'),
  );
  return {
    ...settings,
    settingsHash: hashAutomaticCaptureV2({ domain: 'engram-autonomous-settings-v1', settings }),
  };
};
const oldHashes = {
  conservative: [
    '5ae33bbdd8316cf43b1e4d2f60be665d86cea0d949dc87c6d5782a3891e8ad22',
    '5a4cd8c86ba6de128ee12d521e64e7adf77e8cde83f6299f57779f41ec95a667',
  ],
  explicit: [
    'ce1bb3390ea6934be8c7979044521e840e8421f112afbc22d9bff0947cb1e790',
    'b33c048458908c7994ad4a42667ffc3011c778129fa852f54383759a52ae494a',
  ],
  reviewFirst: [
    'd158c8679803a2e64e3802db1f6ccaa3cc73260ac2ee581cb8f4365073dc5282',
    '29f7ae4cdf7f2cfdb6b11f2e0f87054fa9729d8b6f2c842d68f04030b40da0b2',
  ],
};

describe('autonomous descriptor4 configuration data only', () => {
  test.each(['conservative', 'explicit', 'reviewFirst'] as const)(
    'compiles %s with exact policy and preserves old descriptor hashes',
    (profileId) => {
      for (const requestedTrustLevel of ['standard', 'trusted'])
        for (const intentSetting of [false, true]) {
          const descriptor = compile({ ...input(), profileId, requestedTrustLevel, intentSetting });
          expect(descriptor.policy).toEqual(compileAutonomousPersonalPolicyV3({ profileId }));
          expect(descriptor).toMatchObject({
            version: 4,
            lifecycle: 'replaySafeV2',
            executionMode: 'synchronous',
            requestedTrustLevel,
            intentSetting,
            assistantWriteAuthority: null,
          });
          expect(Schema.parse(descriptor)).toEqual(descriptor);
          expect(Object.isFrozen(descriptor.provider.temperature)).toBe(true);
          expect(Object.isFrozen(descriptor.policy.limits)).toBe(true);
          expect(Object.isFrozen(descriptor)).toBe(true);
          expect(Buffer.byteLength(JSON.stringify(descriptor))).toBeLessThanOrEqual(4096);
        }
      const previous = compileCompositionalAutomaticDescriptorV3({
        profileId,
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30000,
      });
      expect(previous.settingsHash).toBe(oldHashes[profileId][0]);
      expect(hashCompositionalAutomaticDescriptorV3(previous)).toBe(oldHashes[profileId][1]);
    },
  );
  test.each([
    [1, 1],
    [2, 2],
    [256, 2],
  ])('never increases configured request ceiling %i', (configuredRequestLimit, expected) => {
    const base = input();
    expect(
      compile({ ...base, providerReference: { ...base.providerReference, configuredRequestLimit } })
        .provider.effectiveRequestLimit,
    ).toBe(expected);
  });
  test.each([
    [100, 20],
    [1001, 101],
    [30000, 1000],
    [120000, 1000],
  ])(
    'derives original-deadline finalization reserve for %ims',
    (invocationDeadlineMs, expected) => {
      const descriptor = compile({ ...input(), invocationDeadlineMs });
      expect(descriptor.finalizationReserveMs).toBe(expected);
      expect(descriptor.provider.effectiveTimeoutMs).toBe(Math.min(30000, invocationDeadlineMs));
    },
  );
  test('respects stricter configured bytes/time and clips larger values', () => {
    const base = input();
    const small = compile({
      ...base,
      providerReference: {
        ...base.providerReference,
        configuredTimeoutMs: 1,
        configuredRequestBytes: 1,
        configuredResponseBytes: 1,
      },
    });
    expect(small.provider).toMatchObject({
      effectiveTimeoutMs: 1,
      effectiveRequestBytes: 1,
      effectiveResponseBytes: 1,
    });
    const large = compile({
      ...base,
      providerReference: {
        ...base.providerReference,
        configuredTimeoutMs: Number.MAX_SAFE_INTEGER,
        configuredRequestBytes: Number.MAX_SAFE_INTEGER,
        configuredResponseBytes: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(large.provider).toMatchObject({
      effectiveTimeoutMs: 30000,
      effectiveRequestBytes: 262144,
      effectiveResponseBytes: 65536,
    });
  });
  test.each([{ mode: 'legacy' }, { mode: 'providerDefault' }, { mode: 'custom', value: -1.25 }])(
    'preserves configured temperature %j without adding token parameters',
    (temperature) => {
      const base = input();
      const descriptor = compile({
        ...base,
        providerReference: { ...base.providerReference, temperature },
      });
      expect(descriptor.provider.temperature).toEqual(temperature);
      expect(descriptor.provider.outputTokenLimit).toEqual({ mode: 'omit' });
      expect(JSON.stringify(descriptor)).not.toContain('max_tokens');
      expect(JSON.stringify(descriptor)).not.toContain('max_completion_tokens');
    },
  );
  test('rejects nested extras, token settings and secret-bearing reference fields', () => {
    const base = input();
    for (const extra of [
      { apiKey: 'synthetic-only' },
      { endpoint: 'https://provider.invalid' },
      { model: 'synthetic' },
      { effectiveRequestLimit: 2 },
      { max_tokens: 2000 },
    ])
      expect(() =>
        compile({ ...base, providerReference: { ...base.providerReference, ...extra } }),
      ).toThrow('invalid_descriptor_data');
    expect(() =>
      compile({
        ...base,
        providerReference: {
          ...base.providerReference,
          temperature: { mode: 'providerDefault', value: 0 },
        },
      }),
    ).toThrow('invalid_descriptor_data');
    expect(() =>
      compile({
        ...base,
        providerReference: {
          ...base.providerReference,
          outputTokenLimit: { mode: 'custom', value: 1 },
        },
      }),
    ).toThrow('invalid_descriptor_data');
    for (const key of Object.keys(base)) {
      const missing = { ...base } as Record<string, unknown>;
      delete missing[key];
      expect(() => compile(missing)).toThrow('invalid_descriptor_data');
    }
  });
  test('does not accept re-signed effective limits, reserve or authority fields', () => {
    const descriptor = compile(input());
    const base = input();
    const oneRequest = compile({
      ...base,
      providerReference: { ...base.providerReference, configuredRequestLimit: 1 },
    });
    expect(
      Schema.safeParse(
        resign({ ...oneRequest, provider: { ...oneRequest.provider, effectiveRequestLimit: 2 } }),
      ).success,
    ).toBe(false);
    for (const changed of [
      { ...descriptor, provider: { ...descriptor.provider, effectiveRequestLimit: 1 } },
      { ...descriptor, provider: { ...descriptor.provider, effectiveTimeoutMs: 29999 } },
      { ...descriptor, provider: { ...descriptor.provider, effectiveResponseBytes: 65535 } },
      { ...descriptor, finalizationReserveMs: 999 },
      {
        ...descriptor,
        preferenceInterpreter: { ...descriptor.preferenceInterpreter, lexiconVersion: 3 },
      },
      { ...descriptor, assistantWriteAuthority: true },
      { ...descriptor, should_process: true },
    ])
      expect(Schema.safeParse(resign(changed)).success).toBe(false);
    expect(Schema.safeParse({ ...descriptor, settingsHash: '0'.repeat(64) }).success).toBe(false);
  });
  test('validates the opaque fingerprint shape without claiming route authority', () => {
    const base = input();
    const other = compile({
      ...base,
      providerReference: { ...base.providerReference, configurationFingerprint: 'b'.repeat(64) },
    });
    expect(Schema.safeParse(other).success).toBe(true);
    expect(other.provider.routeId).toBe(' synthetic route ');
    expect(other.settingsHash).not.toBe(compile(base).settingsHash);
    expect(other).not.toHaveProperty('should_process');
    expect(other).not.toHaveProperty('identityReady');
    expect(other).not.toHaveProperty('permit');
  });

  test('keeps the largest escaped route and numeric configuration within the descriptor bound without I/O', () => {
    const request = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected provider request');
    });
    try {
      const base = input();
      const routeId = 'r' + '\u0001'.repeat(127);
      const descriptor = compile({
        ...base,
        invocationDeadlineMs: 120000,
        providerReference: {
          ...base.providerReference,
          routeId,
          configuredRequestLimit: 256,
          configuredTimeoutMs: Number.MAX_SAFE_INTEGER,
          configuredRequestBytes: Number.MAX_SAFE_INTEGER,
          configuredResponseBytes: Number.MAX_SAFE_INTEGER,
        },
      });
      expect(descriptor.provider.routeId).toBe(routeId);
      expect(Buffer.byteLength(JSON.stringify(descriptor))).toBeLessThanOrEqual(4096);
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
  test('bounds invalid routes, hashes, numbers and explicit selections', () => {
    const base = input();
    for (const routeId of ['', '  ', '\ud800', '\udfff', 'x'.repeat(129)])
      expect(() =>
        compile({ ...base, providerReference: { ...base.providerReference, routeId } }),
      ).toThrow('invalid_descriptor_data');
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      for (const key of [
        'configuredTimeoutMs',
        'configuredRequestBytes',
        'configuredResponseBytes',
      ])
        expect(() =>
          compile({ ...base, providerReference: { ...base.providerReference, [key]: value } }),
        ).toThrow('invalid_descriptor_data');
    }
    for (const invalid of [
      { profileId: 'existing' },
      { requestedTrustLevel: 'unverified' },
      { invocationDeadlineMs: 99 },
      { invocationDeadlineMs: 120001 },
      { intentSetting: 1 },
    ])
      expect(() => compile({ ...base, ...invalid })).toThrow('invalid_descriptor_data');
    expect(() =>
      compile({
        ...base,
        providerReference: { ...base.providerReference, configurationFingerprint: 'A'.repeat(64) },
      }),
    ).toThrow('invalid_descriptor_data');
  });
  test('uses complete parsed values in both domain-separated hashes and ignores key order', () => {
    const descriptor = compile(input());
    const body = Object.fromEntries(
      Object.entries(descriptor).filter(([key]) => key !== 'settingsHash'),
    );
    expect(descriptor.settingsHash).toBe(
      hashAutomaticCaptureV2({ domain: 'engram-autonomous-settings-v1', settings: body }),
    );
    expect(hash(descriptor)).toBe(
      hashAutomaticCaptureV2({ domain: 'engram-autonomous-descriptor-v1', descriptor }),
    );
    expect(hash(Object.fromEntries(Object.entries(descriptor).reverse()))).toBe(hash(descriptor));
    const original = input();
    const detached = compile(original);
    original.providerReference.routeId = 'changed';
    expect(detached.provider.routeId).toBe(' synthetic route ');
  });
  test('owns arbitrary raw input before Zod, hashing or serialization', () => {
    let traps = 0;
    const values = [
      Object.defineProperty({}, 'then', { enumerable: true, get: () => ++traps }),
      Object.defineProperty({}, 'providerReference', { enumerable: true, get: () => ++traps }),
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
      { ...input(), toJSON: () => ++traps },
    ];
    for (const value of values) {
      expect(() => compile(value)).toThrow('invalid_descriptor_data');
      expect(Schema.safeParse(value).success).toBe(false);
      expect(() => hash(value)).toThrow('invalid_descriptor_data');
    }
    expect(traps).toBe(0);
    const cyclic = { child: null as unknown };
    cyclic.child = cyclic;
    const privateValue = 'synthetic-private-'.repeat(1500);
    for (const value of [cyclic, { ...input(), private: privateValue }]) {
      const result = Schema.safeParse(value);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual([
          { code: 'custom', path: [], message: 'invalid_descriptor_data' },
        ]);
        expect(result.error.message).not.toContain(privateValue);
      }
    }
  });
});
