import { createHash } from 'node:crypto';
import {
  compileAutonomousPersonalDescriptorV4 as compile,
  hashAutonomousPersonalDescriptorV4 as hash,
  AutonomousPersonalDescriptorV4InputOwnedDataSchema as InputSchema,
  AutonomousPersonalDescriptorV4Schema as Schema,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';

type Profile = 'conservative' | 'explicit' | 'reviewFirst';

const baseInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  profileId: 'conservative',
  requestedTrustLevel: 'standard',
  intentSetting: false,
  invocationDeadlineMs: 30000,
  providerReference: {
    routeId: 'synthetic-budget-contract',
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
  ...overrides,
});

const budget = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  semantics: 'configured',
  version: 1,
  completion: { mode: 'inheritOverall' },
  syntax: { mode: 'inheritOverall' },
  finalizationReserve: { mode: 'automatic' },
  ...overrides,
});

const resign = (value: object): Record<string, unknown> => {
  const settings = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'settingsHash'),
  );
  return {
    ...settings,
    settingsHash: hashAutomaticCaptureV2({ domain: 'engram-autonomous-settings-v1', settings }),
  };
};

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

// Baseline vectors for descriptors without configured execution budgets.
const LEGACY_GOLDENS: ReadonlyArray<{
  profileId: Profile;
  requestedTrustLevel: 'standard' | 'trusted';
  intentSetting: boolean;
  settingsHash: string;
  descriptorHash: string;
  serializedSha256: string;
}> = [
  {
    profileId: 'conservative',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    settingsHash: 'c47d0315ecb5863f7eaea15d060959b52170e4782165acade81dee5a67d2d8f3',
    descriptorHash: 'ecf1cf8f3ea60bdd636c192279ca7185cd3c578c789c9ed8ddf54182ce46ad09',
    serializedSha256: 'ee4f5b6155c6e6dbf32bd060de66bc11c8a0ca588f1ad2fe1d8e0a07eee7af88',
  },
  {
    profileId: 'conservative',
    requestedTrustLevel: 'standard',
    intentSetting: true,
    settingsHash: '1c53c9cdc010ebeaefac8a68af019a0fda23bccb0d05ea49b2b0922c510ddf5c',
    descriptorHash: '72ab4043e6e693b606d589af2f7824c04cf2a3ef5f2ed05c93641b44e527f8c8',
    serializedSha256: '4c42f10381e0c687913292c5ebfd6af1524a4ffa415fc2da83431a750902cfcf',
  },
  {
    profileId: 'conservative',
    requestedTrustLevel: 'trusted',
    intentSetting: false,
    settingsHash: '7e835385812f6ea4036dfdc725dc39c2c1ba6af3a1d53b1e8c22028d05be9706',
    descriptorHash: 'd2b4e95ed786ad99958e91acd566b73bba77833acf274102e87568e02d2f239f',
    serializedSha256: '162a73bd345599eaa08196bd932498d285d71931721069dc56b09ead0e360ead',
  },
  {
    profileId: 'conservative',
    requestedTrustLevel: 'trusted',
    intentSetting: true,
    settingsHash: 'faf4806c2ef47b9e77af0c9528c1f960dcbd69f045381c61d73feeb0066aaa30',
    descriptorHash: '4cf4872aeb03283b5d543e257a1102ae391f0cb782b19c0be37f3f5b1d3a6c82',
    serializedSha256: 'e686266c11080cdd4f46921532fbb2e1b09dbb3cf981dd04f3ac8b5bb9f5ccfb',
  },
  {
    profileId: 'explicit',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    settingsHash: 'cd82773e2cf298e9cc2a80f0798217b4d3ebfcf3bfd213cfceb85225dc10fb82',
    descriptorHash: '61ba166e6ed71fd5f35561599b41e2624b48f3518cefe1b430ea0f12c3f3e963',
    serializedSha256: 'cbf6210e6c86e3b9a2508a64f9fbedee29f38e98b63b2c72df7d129fa8c50a72',
  },
  {
    profileId: 'explicit',
    requestedTrustLevel: 'standard',
    intentSetting: true,
    settingsHash: '141d401aa2ac944a60b0fa64d72395c41ebe394b9b44a17e254c030aa93f2f7d',
    descriptorHash: '62e9d434d2c506850155c0b8bf9e1d337575e161838f0f5b6024f0715a12ee75',
    serializedSha256: 'a74042d9222d9a236c0ab38def9f28d81a3e25b89f0912edb4b64842e67ec1fb',
  },
  {
    profileId: 'explicit',
    requestedTrustLevel: 'trusted',
    intentSetting: false,
    settingsHash: '2b1135d944e2ba3ec1a59c64173393c38a427d0fa1c7a19e11cf5ead469c7bdf',
    descriptorHash: '476e0332f22cc9636de55c967f9e10cfe536fa9179c69aa12f8c2be9fdf62513',
    serializedSha256: '6fc88e3d9df27e71d5ad707417152d5e281f4d8c5d1844d41bc040bfa350c71b',
  },
  {
    profileId: 'explicit',
    requestedTrustLevel: 'trusted',
    intentSetting: true,
    settingsHash: '1a2e43a14c428e1855d35f1036a452d8783ea5fd9e61126c90695652c38108e0',
    descriptorHash: 'f1ead1d573a2341dae2c2b09dc1049f9b99ed8aaa1ed3905b967b067477b5c96',
    serializedSha256: '7a15d27fe46c723b84255610544f89a9536a0b7a26cb6e3925aeae7e77a9b703',
  },
  {
    profileId: 'reviewFirst',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    settingsHash: '53e9510e0f4bdfb72785dd6515c55cefccd277af754c56c66322793ff9ffbd6c',
    descriptorHash: '19d546e2821e8c03a260bf08528842153d661c487760d5897f54811497fb70b1',
    serializedSha256: '410cc7ad793f140e90508f66edfd60be7726545830b9df234fe49af17f018811',
  },
  {
    profileId: 'reviewFirst',
    requestedTrustLevel: 'standard',
    intentSetting: true,
    settingsHash: '65708a36f2f1e3a4b3fda2aa82b6ac05dade8d1f705299f1507b2d05e8783250',
    descriptorHash: '68d4eb1b9bbf1302b3322fc85460d4349b61241d2e7979c154624fc1dcfcbcfc',
    serializedSha256: '34dcc8bb947a62cc594d5efc77bdbdcc36870fbfc3801e1dfe6b9d91c2084ead',
  },
  {
    profileId: 'reviewFirst',
    requestedTrustLevel: 'trusted',
    intentSetting: false,
    settingsHash: '8c811542fb9c39300162b6fe9f1b95d865ec033459aaf4459b02fe0f86724ff0',
    descriptorHash: 'c066732480cdf83cbed0542f1d662547ca4b0df85073a666ed3d86a85037c250',
    serializedSha256: 'f6ee4a5e880fa08643344d84673ea73b0605dc70db667eb05ae1d7afaf77257e',
  },
  {
    profileId: 'reviewFirst',
    requestedTrustLevel: 'trusted',
    intentSetting: true,
    settingsHash: '2bc5c4237441203e746564ba87c12e3a01c0e0b0be065ea5ed1aa3e7705f5ea4',
    descriptorHash: 'df9d20ac51fffe00d989d8827dfc274dc88e6dee98cc56cb620dadf6ddb6fcc5',
    serializedSha256: 'd1e63bb277c2aa02aed06c4a5a5475a2fd9d1652a2fade221eaa58abb5a65978',
  },
];

const deepFrozen = (value: unknown): boolean =>
  value === null ||
  typeof value !== 'object' ||
  (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

describe('descriptor4 legacy compatibility with absent executionBudget', () => {
  test.each(LEGACY_GOLDENS)(
    'keeps golden hashes for $profileId/$requestedTrustLevel/intent=$intentSetting',
    ({ settingsHash, descriptorHash, serializedSha256, ...variant }) => {
      const descriptor = compile(baseInput(variant));
      expect(descriptor.settingsHash).toBe(settingsHash);
      expect(hash(descriptor)).toBe(descriptorHash);
      expect(sha256(JSON.stringify(descriptor))).toBe(serializedSha256);
      expect('executionBudget' in descriptor).toBe(false);
      expect(Object.keys(descriptor)).not.toContain('executionBudget');
      expect(JSON.stringify(descriptor)).not.toContain('executionBudget');
      expect(descriptor.provider.temperature).toEqual({ mode: 'providerDefault' });
      expect('outputTokenLimit' in descriptor.provider).toBe(true);
      expect(descriptor.provider.outputTokenLimit).toEqual({ mode: 'omit' });
      expect(Schema.parse(descriptor)).toEqual(descriptor);
    },
  );

  test('old serialized descriptors still parse without gaining a key', () => {
    const descriptor = compile(baseInput());
    const reparsed = Schema.parse(JSON.parse(JSON.stringify(descriptor)));
    expect('executionBudget' in reparsed).toBe(false);
    expect(JSON.stringify(reparsed)).toBe(JSON.stringify(descriptor));
  });

  test('legacy reserve still follows the policy recipe', () => {
    expect(compile(baseInput({ invocationDeadlineMs: 100 })).finalizationReserveMs).toBe(20);
    expect(compile(baseInput({ invocationDeadlineMs: 120_000 })).finalizationReserveMs).toBe(1000);
  });

  test('legacy descriptors reject a reserve above the old bound even though structure admits it', () => {
    const descriptor = compile(baseInput());
    expect(Schema.safeParse(resign({ ...descriptor, finalizationReserveMs: 2000 })).success).toBe(
      false,
    );
    expect(Schema.safeParse(resign({ ...descriptor, finalizationReserveMs: 5001 })).success).toBe(
      false,
    );
  });
});

describe('descriptor4 configured executionBudget', () => {
  const variants: ReadonlyArray<[string, Record<string, unknown>, number]> = [
    ['default', budget(), 1000],
    [
      'limited stages',
      budget({
        completion: { mode: 'limited', durationMs: 4000 },
        syntax: { mode: 'limited', durationMs: 2500 },
      }),
      1000,
    ],
    [
      'mixed stages',
      budget({
        completion: { mode: 'limited', durationMs: 100 },
        syntax: { mode: 'inheritOverall' },
      }),
      1000,
    ],
    [
      'fixed reserve above 1000',
      budget({ finalizationReserve: { mode: 'fixed', durationMs: 2000 } }),
      2000,
    ],
    [
      'fixed reserve at 5000',
      budget({ finalizationReserve: { mode: 'fixed', durationMs: 5000 } }),
      5000,
    ],
    ['fixed reserve at 20', budget({ finalizationReserve: { mode: 'fixed', durationMs: 20 } }), 20],
  ];

  test.each(variants)(
    '%s round-trips, is frozen and binds the reserve',
    (_name, config, reserve) => {
      const descriptor = compile(baseInput({ executionBudget: config }));
      expect(descriptor.executionBudget).toEqual(config);
      expect(descriptor.finalizationReserveMs).toBe(reserve);
      expect(deepFrozen(descriptor)).toBe(true);
      const reparsed = Schema.parse(JSON.parse(JSON.stringify(descriptor)));
      expect(reparsed).toEqual(descriptor);
      expect(JSON.stringify(reparsed)).toBe(JSON.stringify(descriptor));
      expect(hash(reparsed)).toBe(hash(descriptor));
      expect(Buffer.byteLength(JSON.stringify(descriptor))).toBeLessThanOrEqual(4096);
    },
  );

  test('automatic reserve matches the legacy recipe for the same invocation', () => {
    for (const invocationDeadlineMs of [100, 500, 30000, 120_000]) {
      const legacy = compile(baseInput({ invocationDeadlineMs }));
      const configured = compile(baseInput({ invocationDeadlineMs, executionBudget: budget() }));
      expect(configured.finalizationReserveMs).toBe(legacy.finalizationReserveMs);
    }
  });

  test('configured output is independent of later caller mutation', () => {
    const config = budget({ completion: { mode: 'limited', durationMs: 4000 } }) as {
      completion: { durationMs: number };
    };
    const input = baseInput({ executionBudget: config });
    const descriptor = compile(input);
    const before = JSON.stringify(descriptor);
    config.completion.durationMs = 9000;
    (input.executionBudget as Record<string, unknown>).version = 2;
    expect(JSON.stringify(descriptor)).toBe(before);
    expect(descriptor.executionBudget).not.toBe(config);
    expect(() => {
      (descriptor as { executionBudget: { version: number } }).executionBudget.version = 2;
    }).toThrow();
  });

  test('every configured field and mode changes settingsHash and descriptor hash', () => {
    const reference = compile(baseInput({ executionBudget: budget() }));
    const changes: Array<Record<string, unknown>> = [
      budget({ completion: { mode: 'limited', durationMs: 4000 } }),
      budget({ completion: { mode: 'limited', durationMs: 4001 } }),
      budget({ syntax: { mode: 'limited', durationMs: 4000 } }),
      budget({ syntax: { mode: 'limited', durationMs: 4001 } }),
      budget({ finalizationReserve: { mode: 'fixed', durationMs: 20 } }),
      budget({ finalizationReserve: { mode: 'fixed', durationMs: 21 } }),
    ];
    const seen = new Set([reference.settingsHash]);
    const seenDescriptor = new Set([hash(reference)]);
    for (const executionBudget of changes) {
      const descriptor = compile(baseInput({ executionBudget }));
      seen.add(descriptor.settingsHash);
      seenDescriptor.add(hash(descriptor));
    }
    expect(seen.size).toBe(changes.length + 1);
    expect(seenDescriptor.size).toBe(changes.length + 1);
    const legacy = compile(baseInput());
    expect(seen.has(legacy.settingsHash)).toBe(false);
    expect(seenDescriptor.has(hash(legacy))).toBe(false);
  });

  test('key insertion order does not change the descriptor', () => {
    const forward = compile(
      baseInput({
        executionBudget: {
          semantics: 'configured',
          version: 1,
          completion: { mode: 'limited', durationMs: 4000 },
          syntax: { mode: 'inheritOverall' },
          finalizationReserve: { mode: 'fixed', durationMs: 2000 },
        },
      }),
    );
    const reversed = compile(
      baseInput({
        executionBudget: {
          finalizationReserve: { durationMs: 2000, mode: 'fixed' },
          syntax: { mode: 'inheritOverall' },
          completion: { durationMs: 4000, mode: 'limited' },
          version: 1,
          semantics: 'configured',
        },
      }),
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(reversed.settingsHash).toBe(forward.settingsHash);
    expect(hash(reversed)).toBe(hash(forward));
  });

  test('worst-valid configured descriptor stays within the 4KB limit', () => {
    const descriptor = compile(
      baseInput({
        profileId: 'reviewFirst',
        requestedTrustLevel: 'trusted',
        intentSetting: true,
        invocationDeadlineMs: 120_000,
        providerReference: {
          ...(baseInput().providerReference as object),
          routeId: '\u0000'.repeat(128),
          configuredRequestLimit: 256,
          configuredTimeoutMs: Number.MAX_SAFE_INTEGER,
          configuredRequestBytes: Number.MAX_SAFE_INTEGER,
          configuredResponseBytes: Number.MAX_SAFE_INTEGER,
          temperature: { mode: 'custom', value: -Number.MAX_VALUE },
        },
        executionBudget: budget({
          completion: { mode: 'limited', durationMs: 120_000 },
          syntax: { mode: 'limited', durationMs: 120_000 },
          finalizationReserve: { mode: 'fixed', durationMs: 5000 },
        }),
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(descriptor), 'utf8')).toBeLessThanOrEqual(4096);
  });
});

describe('descriptor4 executionBudget rejection', () => {
  const rejectedBodies: ReadonlyArray<[string, unknown]> = [
    ['null', null],
    ['explicit undefined', undefined],
    ['legacy tag', { semantics: 'legacy' }],
    ['unknown version', budget({ version: 2 })],
    ['unknown field', budget({ extra: true })],
    ['unknown semantics', budget({ semantics: 'other' })],
    ['missing field', { semantics: 'configured', version: 1 }],
    ['unknown stage mode', budget({ completion: { mode: 'unbounded' } })],
    ['limited without duration', budget({ syntax: { mode: 'limited' } })],
    ['inherit with duration', budget({ completion: { mode: 'inheritOverall', durationMs: 5 } })],
    ['stage below minimum', budget({ completion: { mode: 'limited', durationMs: 99 } })],
    ['stage above maximum', budget({ syntax: { mode: 'limited', durationMs: 120_001 } })],
    ['fractional stage', budget({ completion: { mode: 'limited', durationMs: 100.5 } })],
    ['string stage', budget({ completion: { mode: 'limited', durationMs: '4000' } })],
    ['reserve below minimum', budget({ finalizationReserve: { mode: 'fixed', durationMs: 19 } })],
    ['reserve above maximum', budget({ finalizationReserve: { mode: 'fixed', durationMs: 5001 } })],
    [
      'automatic with duration',
      budget({ finalizationReserve: { mode: 'automatic', durationMs: 50 } }),
    ],
    ['array', []],
    ['string', 'configured'],
  ];

  test.each(rejectedBodies)('compiler rejects %s', (_name, executionBudget) => {
    expect(() => compile(baseInput({ executionBudget }))).toThrow();
  });

  test('owned JSON input schema rejects malformed configured bodies', () => {
    for (const [, executionBudget] of rejectedBodies.filter(([, value]) => value !== undefined)) {
      expect(InputSchema.safeParse(baseInput({ executionBudget })).success).toBe(false);
    }
    expect(InputSchema.safeParse(baseInput()).success).toBe(true);
    expect(InputSchema.safeParse(baseInput({ executionBudget: budget() })).success).toBe(true);
  });

  test('parse rejects the same bodies embedded in a valid descriptor', () => {
    const configured = compile(baseInput({ executionBudget: budget() }));
    for (const [, executionBudget] of rejectedBodies) {
      const result = Schema.safeParse(resign({ ...configured, executionBudget }));
      expect(result.success).toBe(false);
    }
  });

  test('fixed reserve equal to or above the invocation allowance rejects', () => {
    for (const [invocationDeadlineMs, durationMs] of [
      [100, 100],
      [3000, 3000],
      [3000, 3001],
      [1000, 5000],
    ]) {
      expect(() =>
        compile(
          baseInput({
            invocationDeadlineMs,
            executionBudget: budget({ finalizationReserve: { mode: 'fixed', durationMs } }),
          }),
        ),
      ).toThrow();
    }
  });

  test('fixed reserve below the invocation allowance is accepted', () => {
    const descriptor = compile(
      baseInput({
        invocationDeadlineMs: 3000,
        executionBudget: budget({ finalizationReserve: { mode: 'fixed', durationMs: 2999 } }),
      }),
    );
    expect(descriptor.finalizationReserveMs).toBe(2999);
    expect(Schema.safeParse(JSON.parse(JSON.stringify(descriptor))).success).toBe(true);
  });

  test('parse reports an impossible fixed reserve as a bounded failure', () => {
    const valid = compile(
      baseInput({
        invocationDeadlineMs: 3000,
        executionBudget: budget({ finalizationReserve: { mode: 'fixed', durationMs: 2999 } }),
      }),
    );
    const impossible = resign({
      ...valid,
      finalizationReserveMs: 3000,
      executionBudget: budget({ finalizationReserve: { mode: 'fixed', durationMs: 3000 } }),
    });
    let result: ReturnType<typeof Schema.safeParse> | undefined;
    expect(() => {
      result = Schema.safeParse(impossible);
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });
});

describe('descriptor4 configured tamper resistance', () => {
  const configured = () =>
    compile(
      baseInput({
        executionBudget: budget({
          completion: { mode: 'limited', durationMs: 4000 },
          finalizationReserve: { mode: 'fixed', durationMs: 2000 },
        }),
      }),
    );
  const plain = (descriptor: object): Record<string, unknown> =>
    JSON.parse(JSON.stringify(descriptor)) as Record<string, unknown>;

  test('untampered configured descriptor parses', () => {
    expect(Schema.safeParse(plain(configured())).success).toBe(true);
  });

  test('reserve tamper is rejected even with a recomputed settings hash', () => {
    for (const finalizationReserveMs of [20, 1000, 1999, 2001, 5000]) {
      const tampered = { ...plain(configured()), finalizationReserveMs };
      expect(Schema.safeParse(tampered).success).toBe(false);
      expect(Schema.safeParse(resign(tampered)).success).toBe(false);
    }
  });

  test('budget body tamper is rejected even with a recomputed settings hash', () => {
    const base = plain(configured());
    const tampers: Array<Record<string, unknown>> = [
      budget({ finalizationReserve: { mode: 'fixed', durationMs: 2500 } }),
      budget({ finalizationReserve: { mode: 'automatic' } }),
      budget({ completion: { mode: 'limited', durationMs: 4000 } }),
    ];
    for (const executionBudget of tampers) {
      const tampered = { ...base, executionBudget };
      expect(Schema.safeParse(tampered).success).toBe(false);
      expect(Schema.safeParse(resign(tampered)).success).toBe(false);
    }
  });

  test('stripping the budget does not silently fall back to a legacy descriptor', () => {
    const stripped = plain(configured());
    delete stripped.executionBudget;
    expect(Schema.safeParse(stripped).success).toBe(false);
    expect(Schema.safeParse(resign(stripped)).success).toBe(false);
  });

  test('a stripped automatic-budget descriptor is a different legacy descriptor, not an alias', () => {
    const withBudget = compile(baseInput({ executionBudget: budget() }));
    const stripped = plain(withBudget);
    delete stripped.executionBudget;
    expect(Schema.safeParse(stripped).success).toBe(false);
    const legacy = compile(baseInput());
    expect(legacy.settingsHash).not.toBe(withBudget.settingsHash);
    expect(hash(legacy)).not.toBe(hash(withBudget));
  });

  test('settings and body hash tamper are rejected', () => {
    const base = plain(configured());
    expect(Schema.safeParse({ ...base, settingsHash: 'b'.repeat(64) }).success).toBe(false);
    expect(
      Schema.safeParse({ ...base, settingsHash: LEGACY_GOLDENS[0].settingsHash }).success,
    ).toBe(false);
    expect(Schema.safeParse({ ...base, invocationDeadlineMs: 29999 }).success).toBe(false);
  });

  test('a recomputed outer hash cannot excuse a mismatched provider timeout', () => {
    const base = plain(configured());
    const provider = { ...(base.provider as object), effectiveTimeoutMs: 1 };
    expect(Schema.safeParse(resign({ ...base, provider })).success).toBe(false);
  });
});

describe('descriptor4 compiler purity and protections', () => {
  test('compiling uses no clock', () => {
    const now = jest.spyOn(Date, 'now');
    const perf = jest.spyOn(performance, 'now');
    try {
      compile(baseInput({ executionBudget: budget() }));
      compile(
        baseInput({
          executionBudget: budget({ finalizationReserve: { mode: 'fixed', durationMs: 2000 } }),
        }),
      );
      compile(baseInput());
      expect(now).not.toHaveBeenCalled();
      expect(perf).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      perf.mockRestore();
    }
  });

  test('strict ownership still rejects unknown, undefined and hostile input', () => {
    expect(() => compile(baseInput({ unexpected: true }))).toThrow();
    expect(() => compile(baseInput({ executionBudget: undefined }))).toThrow();
    expect(() => compile(null)).toThrow();
    const getter = baseInput();
    Object.defineProperty(getter, 'executionBudget', {
      enumerable: true,
      get: () => budget(),
    });
    expect(() => compile(getter)).toThrow();
    const configured = compile(baseInput({ executionBudget: budget() }));
    expect(Schema.safeParse({ ...configured, extra: 1 }).success).toBe(false);
    expect(
      Schema.safeParse({
        ...configured,
        executionBudget: { ...budget(), completion: { mode: 'inheritOverall', extra: 1 } },
      }).success,
    ).toBe(false);
  });

  test('oversized route ids and descriptors are still rejected', () => {
    expect(() =>
      compile(
        baseInput({
          providerReference: {
            ...(baseInput().providerReference as object),
            routeId: 'r'.repeat(129),
          },
          executionBudget: budget(),
        }),
      ),
    ).toThrow();
  });
});
