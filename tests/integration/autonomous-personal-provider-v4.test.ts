import * as fs from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { GraphData } from '../../src/schemas';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { compileAutonomousPersonalSourceScanV1 } from '../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import {
  closeAutonomousPersonalCaptureProviderStageAccessV4,
  consumeAutonomousPersonalCaptureProviderStageV4,
  getAutonomousPersonalCaptureProviderStageAccessV4,
  getAutonomousPersonalCaptureProviderV4ResultSchema,
  prepareNativeAutonomousPersonalCaptureProviderV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import type { AutonomousPersonalCaptureSeed } from '../helpers/autonomousPersonalCaptureBackend';
import { readNativeAutonomousPersonalCaptureConfigV4 } from '../../src/utils/AutonomousPersonalCaptureNativeConfigV4';

type ProviderBody = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  response_format?: { type: string };
  max_tokens?: number;
};

function providerSuccess(units: Array<{ unitId: string }>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              version: 1,
              units: units.map(({ unitId }) => ({
                unitId,
                category: 'preference',
                risk: 'ordinary',
                usefulness: 'personal_memory',
                downgrade: [],
              })),
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('fixed native Autonomous Personal V4 provider preparation', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-autonomous-v4-provider-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const snapshot = async () => JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;
  const context = (options: Parameters<typeof nativeAutonomousPersonalCaptureContext>[1] = {}) =>
    nativeAutonomousPersonalCaptureContext(seed, options);

  const consumeStage = (
    result: Awaited<ReturnType<typeof prepareNativeAutonomousPersonalCaptureProviderV4>>,
  ) => {
    if (result.kind !== 'prepared') throw new Error('Expected private provider stage');
    const access = consumeAutonomousPersonalCaptureProviderStageV4(store, result.stage);
    return { access, ...getAutonomousPersonalCaptureProviderStageAccessV4(store, access) };
  };

  it('closes the backend preflight before one bounded request and returns only a live opaque stage', async () => {
    const events: string[] = [];
    let bodyAtFetch: ProviderBody | undefined;
    let serializedBodyAtFetch: string | undefined;
    let graphAtFetch: string | undefined;
    const originalPreflight = store.prepareAutonomousPersonalCaptureProviderV4!.bind(store);
    jest
      .spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4')
      .mockImplementation(async (handle) => {
        const result = await originalPreflight(handle);
        events.push('preflight_returned');
        return result;
      });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      events.push('fetch_started');
      serializedBodyAtFetch = String(init?.body);
      bodyAtFetch = JSON.parse(serializedBodyAtFetch) as ProviderBody;
      graphAtFetch = JSON.stringify(await snapshot());
      const user = JSON.parse(bodyAtFetch.messages[1]!.content) as {
        version: number;
        humanContent: string;
        units: Array<{ unitId: string; completeLiteral: string }>;
      };
      expect(user.version).toBe(1);
      expect(user.humanContent).toBe(seed.request.source.content);
      expect(user.units).toEqual([
        {
          unitId: expect.stringMatching(/^[a-f0-9]{64}$/u),
          completeLiteral: seed.request.source.content,
        },
      ]);
      return providerSuccess(user.units);
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);

    expect(result.kind).toBe('prepared');
    expect(result.eligibleFirstCommit).toBe(false);
    if (result.kind !== 'prepared') throw new Error('Expected private provider stage');
    expect(Object.keys(result.stage)).toEqual([]);
    expect(getAutonomousPersonalCaptureProviderV4ResultSchema().safeParse(result).success).toBe(
      true,
    );
    const consumed = consumeStage(result);
    expect(consumed.view.outcome.kind).toBe('response');
    expect(getAutonomousPersonalCaptureProviderV4ResultSchema().safeParse(result).success).toBe(
      false,
    );
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    expect(events).toEqual(['preflight_returned', 'fetch_started']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodyAtFetch).toBeDefined();
    expect(Buffer.byteLength(serializedBodyAtFetch!, 'utf8')).toBeLessThanOrEqual(262_144);
    expect(createHash('sha256').update(serializedBodyAtFetch!, 'utf8').digest('hex')).toBe(
      'ead9db182627a897c62c6dc605bd7d5016475dd13626e1d1290d8be9344c896e',
    );
    expect(bodyAtFetch?.response_format).toEqual({ type: 'json_object' });
    expect(bodyAtFetch).not.toHaveProperty('temperature');
    expect(bodyAtFetch).not.toHaveProperty('max_tokens');
    expect(bodyAtFetch?.messages[0]?.content).toMatch(/untrusted source data/u);
    expect(bodyAtFetch?.messages[1]?.content).not.toContain(seed.request.namespace);
    expect(bodyAtFetch?.messages[1]?.content).not.toContain(seed.request.issuer);
    expect(bodyAtFetch?.messages[1]?.content).not.toContain(seed.request.actorReference);

    const finalGraph = await snapshot();
    expect(JSON.stringify(finalGraph)).toBe(graphAtFetch);
    expect(finalGraph.episodes).toHaveLength(1);
    expect(finalGraph.automatic_operations_v1?.operations).toHaveLength(1);
    expect(finalGraph).not.toHaveProperty('automatic_claims_v3');
    expect(finalGraph).not.toHaveProperty('automatic_receipts_v4');
  });

  it('sends every complete unit from the mapped human body, including neutral and question units', async () => {
    const wrapper = 'Agent 🧭: ';
    const human = 'Hi! Do I like tea? I adore jazz.';
    const full = `${wrapper}${human} [display footer]`;
    const ctx = context({
      content: full,
      extraParameters: {
        automaticWrapper: 'enabled',
        automaticRegionStart: wrapper.length,
        automaticRegionEnd: wrapper.length + human.length,
        automaticRawHuman: human,
      },
    });
    let user:
      | { humanContent: string; units: Array<{ unitId: string; completeLiteral: string }> }
      | undefined;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      user = JSON.parse(body.messages[1]!.content) as NonNullable<typeof user>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: user.units.map((unit, index) => ({
                    unitId: unit.unitId,
                    category: 'preference',
                    risk: 'ordinary',
                    usefulness: index === 0 ? 'not_memory' : 'personal_memory',
                    downgrade: [],
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);

    expect(result.kind).toBe('prepared');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(user!.humanContent).toBe(human);
    expect(user!.units.map((unit) => unit.completeLiteral)).toEqual([
      'Hi!',
      'Do I like tea?',
      'I adore jazz.',
    ]);
    expect(JSON.stringify(user)).not.toContain(wrapper);
    expect(JSON.stringify(user)).not.toContain('display footer');
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome.kind).toBe('response');
      if (consumed.view.outcome.kind === 'response') {
        expect(consumed.view.outcome.response.units.map((unit) => unit.unitId)).toEqual(
          user!.units.map((unit) => unit.unitId),
        );
      }
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('preserves a configured custom temperature in the OpenAI-compatible request', async () => {
    const ctx = context({
      extraParameters: { queueTemperatureMode: 'custom', queueTemperature: 0.25 },
    });
    let requestBody: ProviderBody | undefined;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(requestBody.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units);
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);

    expect(result.kind).toBe('prepared');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestBody?.temperature).toBe(0.25);
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('includes complete quoted and report/example units instead of omitting framed source', async () => {
    const content =
      'I prefer concise explanations. She said "I adore jazz." Here is an example: I work remotely.';
    let requestUnits: Array<{ unitId: string; completeLiteral: string }> | undefined;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        humanContent: string;
        units: Array<{ unitId: string; completeLiteral: string }>;
      };
      requestUnits = user.units;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: user.units.map(({ unitId }) => ({
                    unitId,
                    category: 'personal_assertion',
                    risk: 'ordinary',
                    usefulness: 'personal_memory',
                    downgrade: [],
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ content }),
      store,
    );

    expect(result.kind).toBe('prepared');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const scan = compileAutonomousPersonalSourceScanV1({
      rawContent: content,
      mapping: { mode: 'full_body' },
      quoteRegions: [],
    });
    expect(scan.status).toBe('complete');
    if (scan.status !== 'complete') throw new Error('Expected complete source scan DATA');
    expect(requestUnits?.map((unit) => unit.completeLiteral)).toEqual(
      scan.units.map((unit) => content.slice(unit.mappedSpan.start, unit.mappedSpan.end)),
    );
    expect(requestUnits?.some((unit) => unit.completeLiteral.includes('She said'))).toBe(true);
    expect(requestUnits?.some((unit) => unit.completeLiteral.includes('Here is an example'))).toBe(
      true,
    );
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome.kind).toBe('response');
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('does not fetch for a replay after the first execution owns the initial lease', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units);
    });

    const first = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ executionId: 'execution:A' }),
      store,
    );
    const replay = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ executionId: 'execution:B' }),
      store,
    );

    expect(first.kind).toBe('prepared');
    if (first.kind === 'prepared') {
      const consumed = consumeStage(first);
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
    expect(replay).toEqual({ kind: 'in_progress', eligibleFirstCommit: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('verifies the source before no-dispatch for missing explicit save intent', async () => {
    const preflight = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({
        extraParameters: {
          automaticMemoryProfile: 'explicit',
          automaticIntent: 'disabled',
        },
      }),
      store,
    );

    expect(result.kind).toBe('prepared');
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome).toEqual({ kind: 'no_dispatch', reason: 'policy_not_selected' });
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('allows credential rotation with an unchanged route fingerprint and uses only the reread key', async () => {
    const ctx = context();
    let credentialReads = 0;
    const credentials = jest.fn(async () => {
      credentialReads += 1;
      return {
        apiKey: credentialReads === 1 ? 'synthetic-key-initial' : 'synthetic-key-rotated',
        baseUrl: 'https://memory.invalid/v1',
      };
    });
    (ctx as unknown as { getCredentials: jest.Mock }).getCredentials = credentials;
    let authorization: string | null = null;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units);
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);

    expect(result.kind).toBe('prepared');
    expect(credentialReads).toBe(2);
    expect(authorization).toBe('Bearer synthetic-key-rotated');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome.kind).toBe('response');
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('records a known route without an initial API key and defers auth only after actual preflight', async () => {
    const ctx = context();
    const credentials = jest.fn(async () => ({ apiKey: '', baseUrl: 'https://memory.invalid/v1' }));
    (ctx as unknown as { getCredentials: jest.Mock }).getCredentials = credentials;
    const preflight = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);

    expect(result.kind).toBe('prepared');
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome).toEqual({ kind: 'deferred', reason: 'provider_auth' });
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('keeps the existing Begin4 native config reader strict when the API key is missing', async () => {
    const ctx = context();
    (ctx as unknown as { getCredentials: jest.Mock }).getCredentials = jest.fn(async () => ({
      apiKey: '',
      baseUrl: 'https://memory.invalid/v1',
    }));

    await expect(readNativeAutonomousPersonalCaptureConfigV4(ctx)).resolves.toEqual({
      kind: 'invalid_input',
    });
  });

  it('runs actual preflight before returning provider_auth when the reread key is missing', async () => {
    const ctx = context();
    let credentialReads = 0;
    const credentials = jest.fn(async () => {
      credentialReads += 1;
      return {
        apiKey: credentialReads === 1 ? 'synthetic-key-initial' : '',
        baseUrl: 'https://memory.invalid/v1',
      };
    });
    (ctx as unknown as { getCredentials: jest.Mock }).getCredentials = credentials;
    const preflight = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);

    expect(result.kind).toBe('prepared');
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(credentialReads).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome).toEqual({ kind: 'deferred', reason: 'provider_auth' });
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('stops when the credential lookup loses the route needed for a fingerprint', async () => {
    const ctx = context();
    const credentials = jest.fn(async () => {
      throw new Error('synthetic credential lookup failure');
    });
    (ctx as unknown as { getCredentials: jest.Mock }).getCredentials = credentials;
    const begin = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);

    expect(result).toEqual({ kind: 'invalid_input', eligibleFirstCommit: false });
    expect(credentials).toHaveBeenCalledTimes(1);
    expect(begin).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops on a changed route before backend preflight or provider dispatch', async () => {
    const ctx = context();
    const original = ctx.getNodeParameter.bind(ctx);
    let routeReads = 0;
    (ctx as unknown as { getNodeParameter: jest.Mock }).getNodeParameter = jest.fn(
      (name: string, index: number, fallback: unknown) => {
        if (name === 'extractionRouteId') {
          routeReads += 1;
          return routeReads === 1 ? 'route:synthetic' : 'route:changed';
        }
        return original(name, index, fallback as string);
      },
    );
    const preflight = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);

    expect(result).toEqual({ kind: 'authority_changed', eligibleFirstCommit: false });
    expect(preflight).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await snapshot()).episodes).toHaveLength(1);
  });

  it('retries one transient provider failure with the same request and no extra source write', async () => {
    const bodies: string[] = [];
    let graphAtFirstRequest: string | undefined;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const serialized = String(init?.body);
      bodies.push(serialized);
      if (bodies.length === 1) {
        graphAtFirstRequest = JSON.stringify(await snapshot());
        return new Response('synthetic provider unavailable', { status: 503 });
      }
      return providerSuccess(
        (
          JSON.parse(JSON.parse(serialized).messages[1].content) as {
            units: Array<{ unitId: string }>;
          }
        ).units,
      );
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);

    expect(result.kind).toBe('prepared');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.stringify(await snapshot())).toBe(graphAtFirstRequest);
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome.kind).toBe('response');
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('does not exceed a one-call provider request ceiling after a transient failure', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('synthetic provider unavailable', { status: 503 }));

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ requestLimit: 1 }),
      store,
    );

    expect(result.kind).toBe('prepared');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome).toEqual({ kind: 'deferred', reason: 'provider_unavailable' });
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('maps an oversized bounded HTTP response to one fixed deferred stage', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('x'.repeat(65_537), {
          status: 200,
          headers: { 'content-length': '65537' },
        }),
    );

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);

    expect(result.kind).toBe('prepared');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome).toEqual({
        kind: 'deferred',
        reason: 'provider_response_bytes',
      });
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('does not retry a response that is invalid ProviderV1 data and keeps its reason fixed', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ version: 1, units: [] }) } }],
        }),
        { status: 200 },
      ),
    );

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);

    expect(result.kind).toBe('prepared');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    if (result.kind === 'prepared') {
      const consumed = consumeStage(result);
      expect(consumed.view.outcome).toEqual({
        kind: 'deferred',
        reason: 'provider_invalid_response',
      });
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    }
  });

  it('binds a stage to its storage owner and enforces one-use access with cleanup', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units);
    });
    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);
    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') throw new Error('Expected private provider stage');
    const foreignOwner = {};
    expect(() =>
      consumeAutonomousPersonalCaptureProviderStageV4(foreignOwner, result.stage),
    ).toThrow('Engram autonomous personal provider: invalid_handle');
    expect(getAutonomousPersonalCaptureProviderV4ResultSchema().safeParse(result).success).toBe(
      true,
    );

    const consumed = consumeStage(result);
    expect(consumed.view.outcome.kind).toBe('response');
    expect(() => consumeAutonomousPersonalCaptureProviderStageV4(store, result.stage)).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access);
    expect(() => getAutonomousPersonalCaptureProviderStageAccessV4(store, consumed.access)).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts before creating a source when the native execution signal is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = context() as IExecuteFunctions & { getExecutionCancelSignal: jest.Mock };
    ctx.getExecutionCancelSignal = jest.fn(() => controller.signal);
    const begin = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store)).resolves.toEqual({
      kind: 'cancelled',
      eligibleFirstCommit: false,
    });

    expect(ctx.getExecutionCancelSignal).toHaveBeenCalledTimes(1);
    expect(begin).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await snapshot()).episodes).toHaveLength(0);
  });

  it('settles an in-flight provider request on host cancellation and does not return a stage', async () => {
    const controller = new AbortController();
    const ctx = context() as IExecuteFunctions & { getExecutionCancelSignal: jest.Mock };
    ctx.getExecutionCancelSignal = jest.fn(() => controller.signal);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('missing request signal'));
        if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      });
    });

    const pending = prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);
    await started;
    controller.abort();
    const result = await pending;

    expect(result).toEqual({ kind: 'cancelled', eligibleFirstCommit: false });
    expect(getAutonomousPersonalCaptureProviderV4ResultSchema().safeParse(result).success).toBe(
      true,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
