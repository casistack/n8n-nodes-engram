import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { readNativeAutonomousPersonalCaptureConfigV4 } from '../../../src/utils/AutonomousPersonalCaptureNativeConfigV4';
import {
  AutonomousPersonalNativeMemoryConfigV4Error,
  readAutonomousPersonalNativeMemoryConfigV4,
  type AutonomousPersonalNativeMemoryConfigContextV4,
} from '../../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import { AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../../helpers/autonomousPersonalCaptureBackend';

describe('Admin provider-reference baseline capture for the Memory config refactor', () => {
  it.each([
    [
      'legacy',
      { mode: 'legacy' },
      '12a4428dd8a30be721083c9dfc62165363e0d0b89ef4d7f49dfc20dc8a958d58',
    ],
    [
      'providerDefault',
      { mode: 'providerDefault' },
      '4ff6c5a4ba8e366f569270c06e12ef92074ce70acf1d161d5297ea199e49877d',
    ],
    [
      'custom',
      { mode: 'custom', value: 0.25 },
      'b109ab999da231b6ef2e019f39cea5f2ef635b884ad35387c25037bd8311b0b4',
    ],
  ] as const)(
    'preserves the pre-refactor Admin provider fingerprint for %s',
    async (mode, temperature, configurationFingerprint) => {
      const store = new GraphologyStorage();
      await store.initialize();
      try {
        const seed = await seedAutonomousPersonalCaptureSubject(store);
        const ctx = nativeAutonomousPersonalCaptureContext(seed, {
          model: 'model:golden-memory',
          routeId: 'route:golden-memory',
          extraParameters: {
            automaticPreferenceInterpreter: 'autonomousPersonalV1',
            queueTemperatureMode: mode,
            ...(temperature.mode === 'custom' ? { queueTemperature: temperature.value } : {}),
          },
        });
        const result = await readNativeAutonomousPersonalCaptureConfigV4(ctx);
        if (result.kind !== 'ready')
          throw new Error(`Expected Admin config DATA, got ${result.kind}`);
        expect(result.request.settings.providerReference).toEqual({
          routeId: 'route:golden-memory',
          configurationFingerprint,
          protocol: 'openai-compatible-json-v1',
          configuredRequestLimit: 2,
          configuredTimeoutMs: 30_000,
          configuredRequestBytes: 262_144,
          configuredResponseBytes: 65_536,
          temperature,
          responseFormat: 'json_object',
          outputTokenLimit: { mode: 'omit' },
        });
      } finally {
        await store.close();
      }
    },
  );
});

type MemoryContextOptions = {
  readonly parameters?: Record<string, unknown>;
  readonly node?: Record<string, unknown>;
  readonly itemCount?: number;
  readonly execution?: string;
  readonly workflow?: string;
  readonly instance?: string;
  readonly credentials?: Record<string, unknown>;
};

function memoryContext(
  options: MemoryContextOptions = {},
): AutonomousPersonalNativeMemoryConfigContextV4 {
  const parameters: Record<string, unknown> = {
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
    extractionRouteId: 'route:golden-memory',
    extractionModel: 'model:golden-memory',
    extractionTemperatureMode: 'legacy',
    queueModel: 'model:admin-must-not-be-used',
    queueTemperatureMode: 'custom',
    queueTemperature: 0.9,
    ...options.parameters,
  };
  const node = {
    id: 'synthetic-memory-node',
    type: 'n8n-nodes-engram.engramMemory',
    typeVersion: 3,
    parameters: { automaticCaptureLifecycle: 'replaySafeV2' },
    continueOnFail: false,
    onError: 'stopWorkflow',
    ...options.node,
  };
  return {
    getNode: () => node,
    getNodeParameter: (name: string, _itemIndex: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
    getInputData: () =>
      Array.from({ length: options.itemCount ?? 1 }, () => ({
        json: { sessionId: 'memory-native-namespace' },
      })),
    getExecutionId: () => options.execution ?? 'memory-execution-1',
    getWorkflow: () => ({ id: options.workflow ?? 'memory-workflow-1' }),
    getInstanceId: () => options.instance ?? 'memory-instance-1',
    getCredentials: async () =>
      options.credentials ?? {
        apiKey: 'synthetic-memory-secret',
        baseUrl: 'https://memory.invalid/v1',
      },
    evaluateExpression: () => 'memory-native-namespace',
  } as unknown as AutonomousPersonalNativeMemoryConfigContextV4;
}

const MEMORY_STORE_HASH = 'c'.repeat(64);

describe('readAutonomousPersonalNativeMemoryConfigV4', () => {
  it('captures strict frozen Memory DATA and matches the pre-refactor Admin provider fingerprint', async () => {
    const config = await readAutonomousPersonalNativeMemoryConfigV4(
      memoryContext(),
      0,
      MEMORY_STORE_HASH,
    );

    expect(config).toEqual({
      version: 4,
      native: {
        instance: 'memory-instance-1',
        workflow: 'memory-workflow-1',
        execution: 'memory-execution-1',
      },
      storeHash: MEMORY_STORE_HASH,
      namespace: 'memory-native-namespace',
      issuer: 'issuer:synthetic',
      actorReference: 'actor:synthetic-1',
      turn: 'turn:synthetic-1',
      sourceId: '54df7873-e0f0-4bfb-95c8-9057e99e0254',
      profileId: 'conservative',
      explicitIntent: false,
      currentHumanQuery: 'I prefer concise explanations.',
      sourceMapping: { mode: 'full_body' },
      quoteRegions: [],
      invocationDeadlineMs: 30_000,
      providerReference: {
        routeId: 'route:golden-memory',
        configurationFingerprint:
          '12a4428dd8a30be721083c9dfc62165363e0d0b89ef4d7f49dfc20dc8a958d58',
        protocol: 'openai-compatible-json-v1',
        configuredRequestLimit: 2,
        configuredTimeoutMs: 30_000,
        configuredRequestBytes: 262_144,
        configuredResponseBytes: 65_536,
        temperature: { mode: 'legacy' },
        responseFormat: 'json_object',
        outputTokenLimit: { mode: 'omit' },
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.native)).toBe(true);
    expect(Object.isFrozen(config.providerReference)).toBe(true);
    expect(JSON.stringify(config)).not.toContain('synthetic-memory-secret');
    expect(config).not.toHaveProperty('ctx');
    expect(config).not.toHaveProperty('credentials');
    expect(
      AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.safeParse({
        ...config,
        apiKey: 'forbidden-secret-field',
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'legacy',
      { mode: 'legacy' },
      '12a4428dd8a30be721083c9dfc62165363e0d0b89ef4d7f49dfc20dc8a958d58',
    ],
    [
      'providerDefault',
      { mode: 'providerDefault' },
      '4ff6c5a4ba8e366f569270c06e12ef92074ce70acf1d161d5297ea199e49877d',
    ],
    [
      'custom',
      { mode: 'custom', value: 0.25 },
      'b109ab999da231b6ef2e019f39cea5f2ef635b884ad35387c25037bd8311b0b4',
    ],
  ] as const)(
    'uses the shared Admin fingerprint recipe for Memory temperature mode %s',
    async (mode, temperature, configurationFingerprint) => {
      const context = memoryContext({
        parameters: {
          extractionTemperatureMode: mode,
          ...(temperature.mode === 'custom' ? { extractionTemperature: temperature.value } : {}),
        },
      });
      const config = await readAutonomousPersonalNativeMemoryConfigV4(
        context,
        0,
        MEMORY_STORE_HASH,
      );
      expect(config.providerReference.configurationFingerprint).toBe(configurationFingerprint);
      expect(config.providerReference.temperature).toEqual(temperature);
    },
  );

  it('keeps the known provider route stable across API key rotation or removal without retaining keys', async () => {
    const baseline = await readAutonomousPersonalNativeMemoryConfigV4(
      memoryContext(),
      0,
      MEMORY_STORE_HASH,
    );
    for (const apiKey of ['rotated-memory-secret', '']) {
      const config = await readAutonomousPersonalNativeMemoryConfigV4(
        memoryContext({
          credentials: { apiKey, baseUrl: 'https://memory.invalid/v1' },
        }),
        0,
        MEMORY_STORE_HASH,
      );
      expect(config.providerReference).toEqual(baseline.providerReference);
      if (apiKey) expect(JSON.stringify(config)).not.toContain(apiKey);
      expect(JSON.stringify(config)).not.toContain('synthetic-memory-secret');
    }
    const normalizedRoute = await readAutonomousPersonalNativeMemoryConfigV4(
      memoryContext({
        credentials: {
          apiKey: 'another-synthetic-key',
          baseUrl: 'https://MEMORY.invalid/v1/',
        },
      }),
      0,
      MEMORY_STORE_HASH,
    );
    expect(normalizedRoute.providerReference).toEqual(baseline.providerReference);
  });

  it('preserves the configured UTF-16 application region and requires raw query equality', async () => {
    const query = 'I prefer concise explanations.';
    const start = '👋 app wrapper: '.length;
    const config = await readAutonomousPersonalNativeMemoryConfigV4(
      memoryContext({
        parameters: {
          currentHumanQuery: query,
          automaticRawHuman: query,
          automaticWrapper: 'enabled',
          automaticRegionStart: start,
          automaticRegionEnd: start + query.length,
        },
      }),
      0,
      MEMORY_STORE_HASH,
    );
    expect(config.sourceMapping).toEqual({
      mode: 'application_region',
      humanRegion: { start, end: start + query.length },
    });
    expect(config.rawHumanContent).toBe(query);

    await expect(
      readAutonomousPersonalNativeMemoryConfigV4(
        memoryContext({
          parameters: {
            currentHumanQuery: query,
            automaticRawHuman: 'different human content',
            automaticWrapper: 'enabled',
            automaticRegionStart: start,
            automaticRegionEnd: start + query.length,
          },
        }),
        0,
        MEMORY_STORE_HASH,
      ),
    ).rejects.toBeInstanceOf(AutonomousPersonalNativeMemoryConfigV4Error);

    await expect(
      readAutonomousPersonalNativeMemoryConfigV4(
        memoryContext({
          parameters: {
            currentHumanQuery: query,
            automaticRawHuman: 'different full-body text',
          },
        }),
        0,
        MEMORY_STORE_HASH,
      ),
    ).rejects.toBeInstanceOf(AutonomousPersonalNativeMemoryConfigV4Error);
  });

  it('rejects invalid native admission and unsupported Memory configuration', async () => {
    const cases: Array<[string, MemoryContextOptions, number, unknown]> = [
      ['Admin node', { node: { type: 'n8n-nodes-engram.engramAdmin' } }, 0, MEMORY_STORE_HASH],
      ['wrong node version', { node: { typeVersion: 2 } }, 0, MEMORY_STORE_HASH],
      [
        'legacy lifecycle',
        { node: { parameters: { automaticCaptureLifecycle: 'legacy' } } },
        0,
        MEMORY_STORE_HASH,
      ],
      ['continue on fail', { node: { continueOnFail: true } }, 0, MEMORY_STORE_HASH],
      ['continue error mode', { node: { onError: 'continueRegularOutput' } }, 0, MEMORY_STORE_HASH],
      ['multiple inputs', { itemCount: 2 }, 0, MEMORY_STORE_HASH],
      ['nonzero item index', {}, 1, MEMORY_STORE_HASH],
      [
        'durable extraction',
        { parameters: { extractionExecution: 'durable' } },
        0,
        MEMORY_STORE_HASH,
      ],
      [
        'legacy extraction policy',
        { parameters: { advancedExtractionPolicy: 'legacy' } },
        0,
        MEMORY_STORE_HASH,
      ],
      [
        'existing profile',
        { parameters: { automaticMemoryProfile: 'existing' } },
        0,
        MEMORY_STORE_HASH,
      ],
      [
        'missing source locator',
        { parameters: { automaticCapturedSource: '' } },
        0,
        MEMORY_STORE_HASH,
      ],
      ['empty query', { parameters: { currentHumanQuery: '' } }, 0, MEMORY_STORE_HASH],
      ['invalid store hash', {}, 0, 'path-not-hash'],
      [
        'unsupported intent mode',
        { parameters: { automaticIntent: 'fromModel' } },
        0,
        MEMORY_STORE_HASH,
      ],
      [
        'unsupported wrapper mode',
        { parameters: { automaticWrapper: 'unknown' } },
        0,
        MEMORY_STORE_HASH,
      ],
    ];
    for (const [name, options, itemIndex, storeHash] of cases) {
      await expect(
        readAutonomousPersonalNativeMemoryConfigV4(memoryContext(options), itemIndex, storeHash),
      ).rejects.toBeInstanceOf(AutonomousPersonalNativeMemoryConfigV4Error);
      expect(name).toBeTruthy();
    }
  });

  it('captures changed actor, profile, intent, route, model, limit, and deadline as strict current DATA', async () => {
    const config = await readAutonomousPersonalNativeMemoryConfigV4(
      memoryContext({
        parameters: {
          automaticActor: 'actor:synthetic-2',
          automaticMemoryProfile: 'explicit',
          automaticIntent: 'enabled',
          extractionRouteId: 'route:other',
          extractionModel: 'model:other',
          extractionRequestLimit: 3,
          extractionDeadlineMs: 20_000,
        },
      }),
      0,
      MEMORY_STORE_HASH,
    );
    expect(config.actorReference).toBe('actor:synthetic-2');
    expect(config.profileId).toBe('explicit');
    expect(config.explicitIntent).toBe(true);
    expect(config.providerReference.routeId).toBe('route:other');
    expect(config.providerReference.configurationFingerprint).not.toBe(
      '12a4428dd8a30be721083c9dfc62165363e0d0b89ef4d7f49dfc20dc8a958d58',
    );
    expect(config.providerReference.configuredRequestLimit).toBe(3);
    expect(config.invocationDeadlineMs).toBe(20_000);
  });

  it('rejects provider route fingerprint inputs beyond the existing owned-data bound', async () => {
    await expect(
      readAutonomousPersonalNativeMemoryConfigV4(
        memoryContext({ parameters: { extractionModel: 'm'.repeat(600_000) } }),
        0,
        MEMORY_STORE_HASH,
      ),
    ).rejects.toMatchObject({ reason: 'capacity' });
  });
});
