import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { compileAutonomousPersonalDescriptorV4 } from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import {
  hashAutonomousPersonalExecutionBudgetV1,
  resolveAutonomousPersonalExecutionBudgetV1,
} from '../../../src/storage/AutonomousPersonalExecutionBudgetV1';
import { readNativeAutonomousPersonalCaptureConfigV4 } from '../../../src/utils/AutonomousPersonalCaptureNativeConfigV4';
import {
  AutonomousPersonalNativeMemoryConfigV4Error,
  readAutonomousPersonalNativeMemoryConfigV4,
  type AutonomousPersonalNativeMemoryConfigContextV4,
} from '../../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import {
  AUTOMATIC_EXECUTION_BUDGET_NATIVE_DEFAULTS,
  AutonomousPersonalExecutionBudgetConfigError,
  readNativeAutonomousPersonalExecutionBudgetV1,
} from '../../../src/utils/autonomousPersonalExecutionBudget';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../../helpers/autonomousPersonalCaptureBackend';

const MODE = 'automaticExecutionBudgetMode';
const CONFIGURED = { [MODE]: 'configuredV1' };
const STORE_HASH = 'c'.repeat(64);

function getFrom(values: Record<string, unknown>) {
  return (name: string, fallback: unknown) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
}

function read(raw: unknown, values: Record<string, unknown> = {}) {
  return readNativeAutonomousPersonalExecutionBudgetV1(raw, getFrom(values));
}

describe('shared native execution budget mapping', () => {
  it('keeps a missing raw mode legacy even when the resolved getter supplies defaults', () => {
    const get = (_name: string, _fallback: unknown) => 'limited';
    expect(readNativeAutonomousPersonalExecutionBudgetV1({}, get)).toBeUndefined();
    expect(
      readNativeAutonomousPersonalExecutionBudgetV1({ [MODE]: 'legacy' }, get),
    ).toBeUndefined();
  });

  it('never reads values for legacy', () => {
    const get = jest.fn();
    readNativeAutonomousPersonalExecutionBudgetV1({ [MODE]: 'legacy' }, get);
    expect(get).not.toHaveBeenCalled();
  });

  it('maps configured defaults', () => {
    expect(read(CONFIGURED)).toEqual({
      semantics: 'configured',
      version: 1,
      completion: { mode: 'inheritOverall' },
      syntax: { mode: 'inheritOverall' },
      finalizationReserve: { mode: 'automatic' },
    });
    expect(AUTOMATIC_EXECUTION_BUDGET_NATIVE_DEFAULTS.completionLimitedMs).toBe(30_000);
    expect(AUTOMATIC_EXECUTION_BUDGET_NATIVE_DEFAULTS.reserveFixedMs).toBe(1_000);
  });

  it('uses visible limited and fixed defaults when numbers resolve to their fallbacks', () => {
    expect(
      read(CONFIGURED, {
        automaticCompletionBudgetMode: 'limited',
        automaticSyntaxBudgetMode: 'limited',
        automaticFinalizationReserveMode: 'fixed',
      }),
    ).toMatchObject({
      completion: { mode: 'limited', durationMs: 30_000 },
      syntax: { mode: 'limited', durationMs: 30_000 },
      finalizationReserve: { mode: 'fixed', durationMs: 1_000 },
    });
  });

  it.each([
    [100, 20],
    [120_000, 5_000],
  ])('accepts the limits %d and reserve %d', (stageMs, reserveMs) => {
    expect(
      read(CONFIGURED, {
        automaticCompletionBudgetMode: 'limited',
        automaticCompletionBudgetMs: stageMs,
        automaticSyntaxBudgetMode: 'limited',
        automaticSyntaxBudgetMs: stageMs,
        automaticFinalizationReserveMode: 'fixed',
        automaticFinalizationReserveMs: reserveMs,
      }),
    ).toMatchObject({
      completion: { durationMs: stageMs },
      syntax: { durationMs: stageMs },
      finalizationReserve: { durationMs: reserveMs },
    });
  });

  it.each([99, 120_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5000', null, undefined])(
    'rejects malformed limited value %p',
    (value) => {
      for (const key of ['automaticCompletionBudgetMs', 'automaticSyntaxBudgetMs']) {
        const mode = key.replace('Ms', 'Mode');
        expect(() => read(CONFIGURED, { [mode]: 'limited', [key]: value })).toThrow(
          AutonomousPersonalExecutionBudgetConfigError,
        );
      }
    },
  );

  it.each([19, 5_001, 20.5, Number.NaN, '1000', null])(
    'rejects malformed fixed reserve %p',
    (value) => {
      expect(() =>
        read(CONFIGURED, {
          automaticFinalizationReserveMode: 'fixed',
          automaticFinalizationReserveMs: value,
        }),
      ).toThrow(AutonomousPersonalExecutionBudgetConfigError);
    },
  );

  it.each([
    ['automaticCompletionBudgetMode', 'unknown'],
    ['automaticSyntaxBudgetMode', null],
    ['automaticFinalizationReserveMode', 'Fixed'],
    ['automaticCompletionBudgetMode', undefined],
  ])('rejects unknown resolved mode %s=%p without fallback', (name, value) => {
    expect(() => read(CONFIGURED, { [name]: value })).toThrow(
      AutonomousPersonalExecutionBudgetConfigError,
    );
  });

  it('does not inspect ignored numeric fields for inherit or automatic', () => {
    const names: string[] = [];
    const get = (name: string, fallback: unknown) => {
      names.push(name);
      return name.endsWith('Ms') ? 'garbage' : fallback;
    };
    expect(readNativeAutonomousPersonalExecutionBudgetV1(CONFIGURED, get)).toBeDefined();
    expect(names.some((name) => name.endsWith('Ms'))).toBe(false);
  });

  it.each([
    ['unknown literal', { [MODE]: 'other' }],
    ['null', { [MODE]: null }],
    ['undefined', { [MODE]: undefined }],
    ['expression', { [MODE]: '={{ "configuredV1" }}' }],
    ['number', { [MODE]: 1 }],
    ['wrong case', { [MODE]: 'ConfiguredV1' }],
  ])('rejects the raw mode: %s', (_name, raw) => {
    expect(() => read(raw)).toThrow(AutonomousPersonalExecutionBudgetConfigError);
  });

  it('rejects an accessor mode without invoking it', () => {
    const getter = jest.fn(() => 'configuredV1');
    const raw = {};
    Object.defineProperty(raw, MODE, { get: getter, enumerable: true });
    expect(() => read(raw)).toThrow(AutonomousPersonalExecutionBudgetConfigError);
    expect(getter).not.toHaveBeenCalled();
  });

  it('ignores inherited mode values and rejects non-plain containers', () => {
    expect(() => read(Object.create({ [MODE]: 'configuredV1' }))).toThrow(
      AutonomousPersonalExecutionBudgetConfigError,
    );
    for (const container of [null, undefined, 'configuredV1', 7, [], new Map()]) {
      expect(() => read(container)).toThrow(AutonomousPersonalExecutionBudgetConfigError);
    }
    expect(read(Object.assign(Object.create(null), { [MODE]: 'legacy' }))).toBeUndefined();
  });

  it('rejects a proxy container without running any trap', () => {
    const trap = jest.fn();
    const handler: ProxyHandler<object> = {
      get: trap,
      has: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      isExtensible: trap,
      set: trap,
      defineProperty: trap,
      deleteProperty: trap,
    };
    expect(() => read(new Proxy({ [MODE]: 'configuredV1' }, handler))).toThrow(
      AutonomousPersonalExecutionBudgetConfigError,
    );
    expect(trap).not.toHaveBeenCalled();
  });

  it('returns deep-frozen owned DATA isolated from caller mutation', () => {
    const values: Record<string, unknown> = {
      automaticCompletionBudgetMode: 'limited',
      automaticCompletionBudgetMs: 2_000,
    };
    const budget = read(CONFIGURED, values);
    expect(Object.isFrozen(budget)).toBe(true);
    expect(Object.isFrozen(budget?.completion)).toBe(true);
    expect(Object.isFrozen(budget?.finalizationReserve)).toBe(true);
    values.automaticCompletionBudgetMs = 9_000;
    expect(budget?.completion).toEqual({ mode: 'limited', durationMs: 2_000 });
    expect(read(CONFIGURED, values)).not.toBe(budget);
  });

  it('uses a fixed diagnostic that does not echo input', () => {
    try {
      read({ [MODE]: 'secret-expression-value' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AutonomousPersonalExecutionBudgetConfigError);
      expect(String((error as Error).message)).not.toContain('secret-expression-value');
    }
  });
});

type Raw = Record<string, unknown>;

async function adminRead(
  rawNodeParameters: Raw,
  resolved: Raw = {},
  options: { deadlineMs?: number } = {},
) {
  const store = new GraphologyStorage();
  await store.initialize();
  try {
    const seed = await seedAutonomousPersonalCaptureSubject(
      store,
      'synthetic-native-budget-config',
    );
    const base = nativeAutonomousPersonalCaptureContext(seed, {
      model: 'model:budget',
      routeId: 'route:budget',
      deadlineMs: options.deadlineMs,
      extraParameters: resolved,
    });
    const node = base.getNode();
    const ctx = {
      ...(base as unknown as object),
      getNode: () => ({ ...node, parameters: { ...node.parameters, ...rawNodeParameters } }),
    } as unknown as typeof base;
    return await readNativeAutonomousPersonalCaptureConfigV4(ctx);
  } finally {
    await store.close();
  }
}

function memoryContext(
  rawNodeParameters: Raw,
  resolved: Raw = {},
): AutonomousPersonalNativeMemoryConfigContextV4 {
  const parameters: Raw = {
    sessionIdType: 'customKey',
    sessionKey: 'memory-native-namespace',
    backend: 'embedded',
    extractionExecution: 'synchronous',
    currentHumanQuery: 'I prefer concise explanations.',
    automaticMemoryProfile: 'conservative',
    automaticIssuer: 'issuer:synthetic',
    automaticActor: 'actor:synthetic-1',
    automaticTurn: 'turn:synthetic-1',
    automaticIntent: 'disabled',
    automaticRawHuman: '',
    automaticWrapper: 'disabled',
    automaticCapturedSource: '54df7873-e0f0-4bfb-95c8-9057e99e0254',
    advancedExtractionPolicy: 'bounded',
    knowledgeSelection: 'durableTemporal',
    extractionRequestLimit: 2,
    extractionDeadlineMs: 30_000,
    extractionRouteId: 'route:budget',
    extractionModel: 'model:budget',
    extractionTemperatureMode: 'legacy',
    ...resolved,
  };
  const node = {
    id: 'synthetic-memory-node',
    type: 'n8n-nodes-engram.engramMemory',
    typeVersion: 3,
    parameters: { automaticCaptureLifecycle: 'replaySafeV2', ...rawNodeParameters },
    continueOnFail: false,
    onError: 'stopWorkflow',
  };
  return {
    getNode: () => node,
    getNodeParameter: (name: string, _itemIndex: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
    getInputData: () => [{ json: { sessionId: 'memory-native-namespace' } }],
    getExecutionId: () => 'memory-execution-1',
    getWorkflow: () => ({ id: 'memory-workflow-1' }),
    getInstanceId: () => 'memory-instance-1',
    getCredentials: async () => ({
      apiKey: 'synthetic-memory-secret',
      baseUrl: 'https://memory.invalid/v1',
    }),
    evaluateExpression: () => 'memory-native-namespace',
  } as unknown as AutonomousPersonalNativeMemoryConfigContextV4;
}

async function memoryRead(rawNodeParameters: Raw, resolved: Raw = {}) {
  return readAutonomousPersonalNativeMemoryConfigV4(
    memoryContext(rawNodeParameters, resolved),
    0,
    STORE_HASH,
  );
}

async function adminReady(raw: Raw, resolved: Raw = {}, options: { deadlineMs?: number } = {}) {
  const result = await adminRead(raw, resolved, options);
  if (result.kind !== 'ready') throw new Error(`Expected ready Admin config, got ${result.kind}`);
  return result.request;
}

const LIMITED_RESOLVED: Raw = {
  automaticCompletionBudgetMode: 'limited',
  automaticCompletionBudgetMs: 4_000,
  automaticSyntaxBudgetMode: 'limited',
  automaticSyntaxBudgetMs: 6_000,
  automaticFinalizationReserveMode: 'fixed',
  automaticFinalizationReserveMs: 500,
};

const EXPECTED_LIMITED = {
  semantics: 'configured',
  version: 1,
  completion: { mode: 'limited', durationMs: 4_000 },
  syntax: { mode: 'limited', durationMs: 6_000 },
  finalizationReserve: { mode: 'fixed', durationMs: 500 },
};

describe('native Admin and Memory readers with configured execution budgets', () => {
  it('omits the key entirely for missing and explicit legacy modes, even with configured-looking resolved values', async () => {
    const baselineAdmin = await adminReady({});
    expect(baselineAdmin.settings).not.toHaveProperty('executionBudget');
    const baselineMemory = await memoryRead({});
    expect(baselineMemory).not.toHaveProperty('executionBudget');

    for (const raw of [{}, { [MODE]: 'legacy' }]) {
      const admin = await adminReady(raw, LIMITED_RESOLVED);
      expect(admin.settings).not.toHaveProperty('executionBudget');
      expect(admin).toEqual(baselineAdmin);
      expect(JSON.stringify(admin)).toBe(JSON.stringify(baselineAdmin));
      const memory = await memoryRead(raw, LIMITED_RESOLVED);
      expect(memory).not.toHaveProperty('executionBudget');
      expect(JSON.stringify(memory)).toBe(JSON.stringify(baselineMemory));
    }
  });

  it('produces an identical executionBudget on Admin and Memory for the same raw configuration', async () => {
    const admin = await adminReady(CONFIGURED, LIMITED_RESOLVED);
    const memory = await memoryRead(CONFIGURED, LIMITED_RESOLVED);
    expect(admin.settings.executionBudget).toEqual(EXPECTED_LIMITED);
    expect(memory.executionBudget).toEqual(EXPECTED_LIMITED);
    expect(admin.settings.executionBudget).toEqual(memory.executionBudget);
    expect(Object.isFrozen(memory.executionBudget)).toBe(true);
    expect(Object.isFrozen(memory.executionBudget?.completion)).toBe(true);

    const adminDescriptor = compileAutonomousPersonalDescriptorV4(admin.settings);
    const memoryDescriptor = compileAutonomousPersonalDescriptorV4({
      profileId: memory.profileId,
      requestedTrustLevel: 'standard',
      intentSetting: memory.explicitIntent,
      invocationDeadlineMs: memory.invocationDeadlineMs,
      providerReference: memory.providerReference,
      executionBudget: memory.executionBudget,
    });
    expect(hashAutonomousPersonalExecutionBudgetV1(adminDescriptor.executionBudget)).toBe(
      hashAutonomousPersonalExecutionBudgetV1(memoryDescriptor.executionBudget),
    );
    expect(adminDescriptor.finalizationReserveMs).toBe(500);
    expect(memoryDescriptor.finalizationReserveMs).toBe(500);
  });

  it('maps configured defaults identically on both nodes', async () => {
    const admin = await adminReady(CONFIGURED);
    const memory = await memoryRead(CONFIGURED);
    const defaults = {
      semantics: 'configured',
      version: 1,
      completion: { mode: 'inheritOverall' },
      syntax: { mode: 'inheritOverall' },
      finalizationReserve: { mode: 'automatic' },
    };
    expect(admin.settings.executionBudget).toEqual(defaults);
    expect(memory.executionBudget).toEqual(defaults);
    const reserve = resolveAutonomousPersonalExecutionBudgetV1(defaults, {
      originalStartedAt: 0,
      configuredOverallMs: 30_000,
      originalOverallDeadlineAt: 30_000,
      existingLeaseDeadlineAt: 30_000,
    }).finalizationReserveMs;
    expect(compileAutonomousPersonalDescriptorV4(admin.settings).finalizationReserveMs).toBe(
      reserve,
    );
  });

  it('keeps provider reference, source and identity unchanged by configured values', async () => {
    const legacyAdmin = await adminReady({});
    const configuredAdmin = await adminReady(CONFIGURED, LIMITED_RESOLVED);
    expect(configuredAdmin.settings.providerReference).toEqual(
      legacyAdmin.settings.providerReference,
    );
    expect(configuredAdmin.source).toEqual(legacyAdmin.source);
    expect(configuredAdmin.namespace).toBe(legacyAdmin.namespace);

    const legacyMemory = await memoryRead({});
    const configuredMemory = await memoryRead(CONFIGURED, LIMITED_RESOLVED);
    const rest = { ...configuredMemory };
    delete rest.executionBudget;
    expect(rest).toEqual(legacyMemory);
  });

  it('round-trips the optional Memory config body exactly', async () => {
    const memory = await memoryRead(CONFIGURED, LIMITED_RESOLVED);
    const parsed = AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.parse(
      JSON.parse(JSON.stringify(memory)),
    );
    expect(parsed).toEqual(memory);
    expect(parsed.executionBudget).toEqual(EXPECTED_LIMITED);
    expect(
      AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.safeParse({
        ...memory,
        executionBudget: { ...EXPECTED_LIMITED, semantics: 'legacy' },
      }).success,
    ).toBe(false);
  });

  it('rejects malformed configuration on both nodes', async () => {
    const cases: Raw[] = [
      { automaticCompletionBudgetMode: 'unknown' },
      { automaticCompletionBudgetMode: 'limited', automaticCompletionBudgetMs: '4000' },
      { automaticSyntaxBudgetMode: 'limited', automaticSyntaxBudgetMs: 99 },
      { automaticFinalizationReserveMode: 'fixed', automaticFinalizationReserveMs: 5_001 },
    ];
    for (const resolved of cases) {
      expect((await adminRead(CONFIGURED, resolved)).kind).toBe('invalid_input');
      await expect(memoryRead(CONFIGURED, resolved)).rejects.toBeInstanceOf(
        AutonomousPersonalNativeMemoryConfigV4Error,
      );
    }
    for (const raw of [{ [MODE]: 'bogus' }, { [MODE]: null }, { [MODE]: '={{ 1 }}' }]) {
      expect((await adminRead(raw)).kind).toBe('invalid_input');
      await expect(memoryRead(raw)).rejects.toBeInstanceOf(
        AutonomousPersonalNativeMemoryConfigV4Error,
      );
    }
  });

  it('ignores inactive numeric fields on both nodes', async () => {
    const stale = {
      automaticCompletionBudgetMs: 'stale',
      automaticSyntaxBudgetMs: -1,
      automaticFinalizationReserveMs: 1,
    };
    expect((await adminReady(CONFIGURED, stale)).settings.executionBudget).toMatchObject({
      completion: { mode: 'inheritOverall' },
      finalizationReserve: { mode: 'automatic' },
    });
    expect((await memoryRead(CONFIGURED, stale)).executionBudget).toMatchObject({
      syntax: { mode: 'inheritOverall' },
      finalizationReserve: { mode: 'automatic' },
    });
  });

  it('rejects a fixed reserve that is not below the invocation allowance', async () => {
    const resolved = {
      automaticFinalizationReserveMode: 'fixed',
      automaticFinalizationReserveMs: 1_000,
      extractionDeadlineMs: 1_000,
    };
    expect((await adminRead(CONFIGURED, resolved, { deadlineMs: 1_000 })).kind).toBe(
      'invalid_input',
    );
    await expect(memoryRead(CONFIGURED, resolved)).rejects.toBeInstanceOf(
      AutonomousPersonalNativeMemoryConfigV4Error,
    );
    // The same reserve is valid against the default allowance.
    expect(
      (await adminReady(CONFIGURED, { ...resolved, extractionDeadlineMs: 30_000 })).settings
        .executionBudget,
    ).toMatchObject({ finalizationReserve: { mode: 'fixed', durationMs: 1_000 } });
  });

  it('does not echo rejected raw input in Memory errors', async () => {
    const error = await memoryRead({ [MODE]: 'secret-expression-value' }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AutonomousPersonalNativeMemoryConfigV4Error);
    expect(String((error as Error).message)).not.toContain('secret-expression-value');
  });
});
