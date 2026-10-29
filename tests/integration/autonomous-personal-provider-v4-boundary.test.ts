import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { GraphData } from '../../src/schemas';
import { AUTONOMOUS_PERSONAL_PROVIDER_SYSTEM_PROMPT_V1 } from '../../src/extraction/AutonomousPersonalProviderRequestV1';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  closeAutonomousPersonalCaptureProviderStageAccessV4,
  consumeAutonomousPersonalCaptureProviderStageV4,
  getAutonomousPersonalCaptureProviderStageAccessV4,
  prepareNativeAutonomousPersonalCaptureProviderV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import type { AutonomousPersonalCaptureSeed } from '../helpers/autonomousPersonalCaptureBackend';

type ProviderUnit = {
  unitId: string;
  category: string;
  risk: string;
  usefulness: string;
  downgrade: string[];
};

type ProviderBody = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  response_format?: { type: string };
  max_tokens?: number;
};

const SYNTHETIC_API_KEY = 'synthetic-only-provider-key-do-not-leak';
const SYNTHETIC_PROVIDER_ERROR = 'provider-owned diagnostic-do-not-leak';

function providerClassification(
  units: Array<{ unitId: string }>,
  overrides: Partial<Omit<ProviderUnit, 'unitId'>> = {},
): { version: 1; units: ProviderUnit[] } {
  return {
    version: 1,
    units: units.map(({ unitId }) => ({
      unitId,
      category: overrides.category ?? 'preference',
      risk: overrides.risk ?? 'ordinary',
      usefulness: overrides.usefulness ?? 'personal_memory',
      downgrade: overrides.downgrade ?? [],
    })),
  };
}

function providerEnvelope(response: unknown): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(response) } }],
  });
}

function providerSuccess(units: Array<{ unitId: string }>): Response {
  return new Response(providerEnvelope(providerClassification(units)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function padJsonBodyToBytes(serializedJson: string, byteLength: number): string {
  const currentBytes = Buffer.byteLength(serializedJson, 'utf8');
  if (currentBytes > byteLength) throw new Error('Fixture JSON exceeds requested byte size');
  return `${serializedJson}${' '.repeat(byteLength - currentBytes)}`;
}

function serializedNativeRequestBytes(
  humanContent: string,
  model = 'model:synthetic-memory',
): number {
  const userContent = JSON.stringify({
    version: 1,
    humanContent,
    units: [{ unitId: '0'.repeat(64), completeLiteral: humanContent }],
  });
  return Buffer.byteLength(
    JSON.stringify({
      model,
      messages: [
        { role: 'system', content: AUTONOMOUS_PERSONAL_PROVIDER_SYSTEM_PROMPT_V1 },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
    }),
    'utf8',
  );
}

function sourceAtNativeRequestByteLimit(limit: number, model: string): string {
  for (let spacesBeforePeriod = 0; spacesBeforePeriod < 3; spacesBeforePeriod += 1) {
    const base = `I prefer tea${' '.repeat(spacesBeforePeriod)}.`;
    // Replace the one ordinary separator with escaped tabs. Each tab contributes
    // six outer-request bytes because it appears in humanContent and completeLiteral.
    const difference = limit - (serializedNativeRequestBytes(base, model) - 2);
    if (difference < 0 || difference % 6 !== 0) continue;
    const content = `I${'\t'.repeat(difference / 6)}prefer tea${' '.repeat(spacesBeforePeriod)}.`;
    if (
      Buffer.byteLength(content, 'utf8') <= 65_536 &&
      serializedNativeRequestBytes(content, model) === limit
    ) {
      return content;
    }
  }
  throw new Error('Could not build a source at the requested native request-byte boundary');
}

function consumeOutcomeIfPrepared(
  store: GraphologyStorage,
  result: Awaited<ReturnType<typeof prepareNativeAutonomousPersonalCaptureProviderV4>>,
) {
  if (result.kind !== 'prepared') return undefined;
  const access = consumeAutonomousPersonalCaptureProviderStageV4(store, result.stage);
  try {
    return getAutonomousPersonalCaptureProviderStageAccessV4(store, access).view.outcome;
  } finally {
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, access);
  }
}

function attachSignal(
  context: IExecuteFunctions,
  signal: AbortSignal | undefined,
): IExecuteFunctions & { getExecutionCancelSignal: jest.Mock } {
  const withSignal = context as IExecuteFunctions & { getExecutionCancelSignal: jest.Mock };
  withSignal.getExecutionCancelSignal = jest.fn(() => signal);
  return withSignal;
}

describe('fixed native Autonomous Personal V4 provider runner acceptance boundaries', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-autonomous-v4-provider-boundary-'));
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

  it('preserves the legacy temperature field in the native request', async () => {
    let requestBody: ProviderBody | undefined;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(requestBody.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units);
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ extraParameters: { queueTemperatureMode: 'legacy' } }),
      store,
    );
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome?.kind).toBe('response');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestBody?.temperature).toBe(0);
    expect(requestBody?.response_format).toEqual({ type: 'json_object' });
    expect(requestBody).not.toHaveProperty('max_tokens');
  });

  it('defers an exact source-size request whose escaped tabs exceed 256 KiB before fetch', async () => {
    const prefix = 'I';
    const suffix = ' prefer tea.';
    const content = `${prefix}${'\t'.repeat(65_536 - Buffer.byteLength(prefix + suffix))}${suffix}`;
    expect(Buffer.byteLength(content, 'utf8')).toBe(65_536);

    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected_external_fetch'));
    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ content }),
      store,
    );
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome).toEqual({ kind: 'deferred', reason: 'provider_request_bytes' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await snapshot()).episodes).toHaveLength(1);
  });

  it('accepts a complete native request body of exactly 256 KiB', async () => {
    const model = 'model:synthetic-memoryx';
    const content = sourceAtNativeRequestByteLimit(262_144, model);
    let requestBytes = 0;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const serialized = String(init?.body);
      requestBytes = Buffer.byteLength(serialized, 'utf8');
      const body = JSON.parse(serialized) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units);
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ content, model }),
      store,
    );
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome?.kind).toBe('response');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestBytes).toBe(262_144);
  });

  it('accepts an HTTP response body of exactly 65,536 bytes', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      const raw = padJsonBodyToBytes(providerEnvelope(providerClassification(user.units)), 65_536);
      const response = new Response(raw, { status: 200 });
      expect(response.headers.get('content-length')).toBeNull();
      return response;
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome?.kind).toBe('response');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('maps a 65,537-byte response body to the fixed response-byte reason', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      const raw = padJsonBodyToBytes(providerEnvelope(providerClassification(user.units)), 65_537);
      const response = new Response(raw, { status: 200 });
      expect(response.headers.get('content-length')).toBeNull();
      return response;
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome).toEqual({ kind: 'deferred', reason: 'provider_response_bytes' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('enforces the response ceiling while streaming without Content-Length and cancels the reader', async () => {
    let chunk = 0;
    let cancelled = false;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunk++ === 0) controller.enqueue(new Uint8Array(65_536));
          else controller.enqueue(new Uint8Array(1));
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = new Response(body, { status: 200 });
      expect(response.headers.get('content-length')).toBeNull();
      return response;
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome).toEqual({ kind: 'deferred', reason: 'provider_response_bytes' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it('accepts the largest closed ProviderV1 row shape and records why 16 KiB is unreachable', async () => {
    const downgrade = [
      'sensitive',
      'uncertain',
      'conditional',
      'reported',
      'quoted',
      'third_party',
      'transient',
      'ambiguous_scope',
    ];
    let providerDataBytes = 0;
    let validationInputBytes = 0;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      const response = providerClassification(user.units, {
        category: 'personal_assertion',
        risk: 'sensitive',
        usefulness: 'personal_memory',
        downgrade,
      });
      providerDataBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
      validationInputBytes = Buffer.byteLength(
        JSON.stringify({ response, unitIds: user.units.map(({ unitId }) => unitId) }),
        'utf8',
      );
      return new Response(providerEnvelope(response), { status: 200 });
    });

    const content = Array.from({ length: 32 }, (_unused, index) => `I prefer tea ${index}.`).join(
      ' ',
    );
    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ content }),
      store,
    );
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome?.kind).toBe('response');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(providerDataBytes).toBe(8_855);
    expect(validationInputBytes).toBe(11_024);
    expect(providerDataBytes).toBeLessThan(16_384);
    expect(validationInputBytes).toBeLessThan(16_384);
    if (outcome?.kind === 'response') expect(outcome.response.units).toHaveLength(32);
  });

  it('maps oversized provider DATA with an unknown padding field to a fixed invalid-response stage', async () => {
    let wireBytes = 0;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      const oversized = {
        ...providerClassification(user.units),
        padding: SYNTHETIC_PROVIDER_ERROR.repeat(900),
      };
      const serialized = providerEnvelope(oversized);
      wireBytes = Buffer.byteLength(serialized, 'utf8');
      return new Response(serialized, { status: 200 });
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome).toEqual({ kind: 'deferred', reason: 'provider_invalid_response' });
    expect(wireBytes).toBeGreaterThan(16_384);
    expect(wireBytes).toBeLessThan(65_536);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ result, outcome })).not.toContain(SYNTHETIC_PROVIDER_ERROR);
  });

  it.each([
    { label: 'HTTP 400', status: 400, reason: 'provider_invalid_request', calls: 1 },
    { label: 'HTTP 401', status: 401, reason: 'provider_auth', calls: 1 },
    { label: 'HTTP 403', status: 403, reason: 'provider_auth', calls: 1 },
    { label: 'HTTP 429', status: 429, reason: 'provider_rate_limit', calls: 2 },
    { label: 'HTTP 500', status: 500, reason: 'provider_unavailable', calls: 2 },
  ] as const)(
    '$label maps to a fixed redacted stage and uses only its permitted retry policy',
    async ({ status, reason, calls }) => {
      const requestBodies: string[] = [];
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        requestBodies.push(String(init?.body));
        return new Response(JSON.stringify({ error: { message: SYNTHETIC_PROVIDER_ERROR } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      });
      const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
        context({
          credentials: { apiKey: SYNTHETIC_API_KEY, baseUrl: 'https://memory.invalid/v1' },
        }),
        store,
      );
      const outcome = consumeOutcomeIfPrepared(store, result);

      expect(result.kind).toBe('prepared');
      expect(outcome).toEqual({ kind: 'deferred', reason });
      expect(fetchSpy).toHaveBeenCalledTimes(calls);
      expect(requestBodies.every((body) => body === requestBodies[0])).toBe(true);
      expect(JSON.stringify({ result, outcome })).not.toContain(SYNTHETIC_API_KEY);
      expect(JSON.stringify({ result, outcome })).not.toContain(SYNTHETIC_PROVIDER_ERROR);
    },
  );

  it('maps repeated network failures without retaining provider-controlled messages', async () => {
    const requestBodies: string[] = [];
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestBodies.push(String(init?.body));
      throw new Error(SYNTHETIC_PROVIDER_ERROR);
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({ credentials: { apiKey: SYNTHETIC_API_KEY, baseUrl: 'https://memory.invalid/v1' } }),
      store,
    );
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome).toEqual({ kind: 'deferred', reason: 'provider_network' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.stringify({ result, outcome })).not.toContain(SYNTHETIC_API_KEY);
    expect(JSON.stringify({ result, outcome })).not.toContain(SYNTHETIC_PROVIDER_ERROR);
  });

  it('settles a timed-out request at the provider subdeadline without retrying or leaking errors', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('missing request signal'));
        if (signal.aborted) return reject(new DOMException(SYNTHETIC_PROVIDER_ERROR, 'AbortError'));
        signal.addEventListener(
          'abort',
          () => reject(new DOMException(SYNTHETIC_PROVIDER_ERROR, 'AbortError')),
          { once: true },
        );
      });
    });
    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(
      context({
        deadlineMs: 5_000,
        credentials: { apiKey: SYNTHETIC_API_KEY, baseUrl: 'https://memory.invalid/v1' },
      }),
      store,
    );
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome).toEqual({ kind: 'deferred', reason: 'provider_subdeadline' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ result, outcome })).not.toContain(SYNTHETIC_API_KEY);
    expect(JSON.stringify({ result, outcome })).not.toContain(SYNTHETIC_PROVIDER_ERROR);
  }, 10_000);

  it('waits exactly the configured 100 ms transient retry delay and reuses the request', async () => {
    const requestBodies: string[] = [];
    const fetchTimes: number[] = [];
    let markDelayStarted!: () => void;
    const delayStarted = new Promise<void>((resolve) => {
      markDelayStarted = resolve;
    });
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const timerSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 100) markDelayStarted();
      return nativeSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      fetchTimes.push(performance.now());
      requestBodies.push(String(init?.body));
      if (fetchTimes.length === 1) return new Response('transient', { status: 503 });
      const body = JSON.parse(requestBodies[1]!) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units);
    });

    const pending = prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);
    await delayStarted;
    const result = await pending;
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome?.kind).toBe('response');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(timerSpy.mock.calls.filter(([, delay]) => delay === 100)).toHaveLength(1);
    expect(fetchTimes[1]! - fetchTimes[0]!).toBeGreaterThanOrEqual(95);
    expect(requestBodies[1]).toBe(requestBodies[0]);
  });

  it('skips the retry when fewer than 100 ms remain before the provider subdeadline', async () => {
    const invocationStarted = performance.now();
    const originalNow = performance.now.bind(performance);
    let sampleNearSubdeadline = false;
    let syntheticSampleUsed = false;
    jest.spyOn(performance, 'now').mockImplementation(() => {
      if (sampleNearSubdeadline && !syntheticSampleUsed) {
        syntheticSampleUsed = true;
        // The default 30-second invocation reserves 1 second for finalization.
        // Only the retry-gate sample is moved; storage and lifetime clocks stay real.
        return invocationStarted + 28_950;
      }
      return originalNow();
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      sampleNearSubdeadline = true;
      return new Response('transient', { status: 503 });
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(context(), store);
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome).toEqual({ kind: 'deferred', reason: 'provider_unavailable' });
    expect(syntheticSampleUsed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('settles response-body consumption and returns cancellation when the host aborts', async () => {
    const controller = new AbortController();
    const ctx = attachSignal(context(), controller.signal);
    let markBodyBlocked!: () => void;
    const bodyBlocked = new Promise<void>((resolve) => {
      markBodyBlocked = resolve;
    });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('missing request signal');
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(Buffer.from('{"choices":['));
        },
        pull(streamController) {
          markBodyBlocked();
          return new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                streamController.error(new Error(SYNTHETIC_PROVIDER_ERROR));
                resolve();
              },
              { once: true },
            );
          });
        },
      });
      return new Response(stream, { status: 200 });
    });

    const pending = prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);
    await bodyBlocked;
    controller.abort();
    const result = await pending;
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result).toEqual({ kind: 'cancelled', eligibleFirstCommit: false });
    expect(outcome).toBeUndefined();
    expect(ctx.getExecutionCancelSignal).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('settles the abortable retry delay when the host cancels between transient attempts', async () => {
    const controller = new AbortController();
    const ctx = attachSignal(context(), controller.signal);
    let markDelayStarted!: () => void;
    const delayStarted = new Promise<void>((resolve) => {
      markDelayStarted = resolve;
    });
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 100) markDelayStarted();
      return nativeSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('transient', { status: 503 }));

    const pending = prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);
    await delayStarted;
    controller.abort();
    const result = await pending;
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result).toEqual({ kind: 'cancelled', eligibleFirstCommit: false });
    expect(outcome).toBeUndefined();
    expect(ctx.getExecutionCancelSignal).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts an undefined n8n cancellation signal and remains deadline-bound', async () => {
    const ctx = attachSignal(context(), undefined);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return providerSuccess(user.units);
    });

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);
    const outcome = consumeOutcomeIfPrepared(store, result);

    expect(result.kind).toBe('prepared');
    expect(outcome?.kind).toBe('response');
    expect(ctx.getExecutionCancelSignal).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the original invocation start when credential lookup consumes its deadline', async () => {
    const ctx = context({ deadlineMs: 100 });
    const delayedCredentials = jest.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 125));
      return { apiKey: SYNTHETIC_API_KEY, baseUrl: 'https://memory.invalid/v1' };
    });
    ctx.getCredentials = delayedCredentials as unknown as typeof ctx.getCredentials;
    const begin = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected_external_fetch'));
    const started = performance.now();

    const result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, store);

    expect(performance.now() - started).toBeGreaterThanOrEqual(115);
    expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
    expect(begin).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await snapshot()).episodes).toHaveLength(0);
  });
});
