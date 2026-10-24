import { LlmClient, type LlmMessage } from '../../../src/extraction/LlmClient';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import { RequestBudget } from '../../../src/extraction/RequestBudget';

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockLlmResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  };
}

describe('LlmClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should call the OpenAI-compatible chat completions endpoint', async () => {
    const client = new LlmClient({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example.com/v1/',
      model: 'gpt-test',
    });
    mockFetch.mockResolvedValueOnce(mockLlmResponse('{"ok":true}'));

    const response = await client.chat([{ role: 'user', content: 'hello' }]);

    expect(response.content).toBe('{"ok":true}');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://llm.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        },
      }),
    );
  });

  it('should reject non-http baseUrl protocols before fetch', () => {
    expect(
      () =>
        new LlmClient({
          apiKey: 'key',
          baseUrl: 'file:///tmp/chat',
          model: 'model',
        }),
    ).toThrow('LLM API baseUrl must use http or https');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should reject malformed baseUrl values before fetch', () => {
    expect(
      () =>
        new LlmClient({
          apiKey: 'key',
          baseUrl: 'not a url',
          model: 'model',
        }),
    ).toThrow('LLM API baseUrl must be a valid HTTP(S) URL');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('extraction generation compatibility', () => {
  const config = { apiKey: 'private-key', baseUrl: 'https://llm.example/v1', model: 'fixed' };
  const messages = [{ role: 'user' as const, content: 'private-input' }];
  beforeEach(() => mockFetch.mockReset());

  it('reproduces fixed-temperature rejection and fixes it by omission, without replay', async () => {
    mockFetch.mockImplementation(async (_url, request) => {
      const body = JSON.parse(request.body);
      return 'temperature' in body
        ? {
            ok: false,
            status: 400,
            text: async () =>
              'temperature 0 unsupported; model only supports default 1 private-input',
          }
        : mockLlmResponse('{"entities":[]}');
    });
    await expect(new LlmClient(config).chatJson(messages)).rejects.toMatchObject({
      kind: 'unsupported_parameter',
      httpStatus: 400,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await expect(
      new LlmClient({ ...config, temperature: { mode: 'providerDefault' } }).chatJson(messages),
    ).resolves.toEqual({ entities: [] });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).not.toHaveProperty('temperature');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).temperature).toBe(0);
  });

  it.each([0, 1])('preserves custom %s and per-call precedence', async (value) => {
    mockFetch.mockResolvedValue(mockLlmResponse('ok'));
    const client = new LlmClient({ ...config, temperature: { mode: 'providerDefault' } });
    await client.chat(messages, { temperature: value });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).temperature).toBe(value);
    await client.chat(messages, { temperature: { mode: 'legacy' } });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).temperature).toBe(0);
    await new LlmClient(config).chat(messages, { temperature: { mode: 'providerDefault' } });
    expect(JSON.parse(mockFetch.mock.calls[2][1].body)).not.toHaveProperty('temperature');
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite configuration %s before fetch',
    (value) => {
      expect(() => new LlmClient({ ...config, temperature: { mode: 'custom', value } })).toThrow();
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, 'invalid_request'],
    [401, 'authentication'],
    [403, 'authentication'],
    [429, 'rate_limit'],
    [503, 'provider_server'],
  ])('classifies HTTP %s without leaking provider text', async (status, kind) => {
    mockFetch.mockResolvedValue({
      ok: false,
      status,
      text: async () => 'private-input private-key',
    });
    await expect(new LlmClient(config).chat(messages)).rejects.toMatchObject({
      kind,
      httpStatus: status,
      message: `Engram extraction: ${kind}`,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    {},
    { choices: [] },
    { choices: [{ message: { content: '' } }] },
    { choices: [{ message: { content: [] } }] },
  ])('rejects malformed envelopes safely: %j', async (data) => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => data });
    await expect(new LlmClient(config).chat(messages)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('does not include malformed completion or network errors in errors', async () => {
    mockFetch.mockResolvedValueOnce(mockLlmResponse('private-input'));
    await expect(new LlmClient(config).chatJson(messages)).rejects.toMatchObject({
      message: 'Engram extraction: invalid_response',
    });
    mockFetch.mockRejectedValueOnce(new Error('private-key'));
    await expect(new LlmClient(config).chat(messages)).rejects.toMatchObject({
      message: 'Engram extraction: network',
    });
  });

  it.each([true, false])('keeps timeout active while reading %s response body', async (ok) => {
    mockFetch.mockImplementation(async (_url, request) => {
      const read = () =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('private-input'))),
        );
      return { ok, status: 400, json: read, text: read };
    });
    await expect(new LlmClient({ ...config, timeoutMs: 15 }).chat(messages)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

describe('opt-in JSON instruction contract', () => {
  const config = {
    apiKey: 'private-key',
    baseUrl: 'https://provider.test/v1',
    model: 'fixed',
    temperature: { mode: 'providerDefault' as const },
  };
  beforeEach(() => mockFetch.mockReset());
  it.each(['JSON', 'json', 'Json'])(
    'accepts trusted %s instructions without changing caller messages or roles',
    async (word) => {
      const messages: LlmMessage[] = [
        { role: 'system', content: `Return only valid ${word}.` },
        { role: 'user', content: 'Synthetic data' },
      ];
      for (const message of messages) Object.freeze(message);
      Object.freeze(messages);
      mockFetch.mockResolvedValue(mockLlmResponse('{"decision":"unknown"}'));
      await expect(
        new LlmClient(config).chatJson(messages, { requireJsonInstruction: true }),
      ).resolves.toEqual({ decision: 'unknown' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual(messages);
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('requireJsonInstruction');
    },
  );
  it.each(['user', 'assistant'] as const)(
    'does not accept %s data as the trusted JSON instruction and dispatches zero requests',
    async (role) => {
      const diagnostics = new ExtractionDiagnostics();
      await expect(
        new LlmClient(config, diagnostics).chatJson(
          [
            { role: 'system', content: 'Compare identities.' },
            { role, content: 'Return JSON.' },
          ],
          { requireJsonInstruction: true },
        ),
      ).rejects.toMatchObject({
        kind: 'invalid_request',
        details: { reason: 'json_mode_instruction_missing', parameter: 'messages' },
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(diagnostics.finish().metrics!.stages[0].requests.attempted).toBe(0);
    },
  );
  it('preserves legacy caller content when the new precondition is not enabled', async () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'private-input' }];
    mockFetch.mockResolvedValue(mockLlmResponse('{}'));
    await new LlmClient(config).chatJson(messages);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).messages).toEqual(messages);
  });
  it('does not consume the shared request budget when preflight fails', async () => {
    const budget = new RequestBudget(1);
    try {
      const client = new LlmClient(config, undefined, 'entity_dedup', budget);
      await expect(
        client.chatJson([{ role: 'system', content: 'Compare identities.' }], {
          requireJsonInstruction: true,
        }),
      ).rejects.toMatchObject({ kind: 'invalid_request' });
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] })),
      );
      await expect(
        client.chatJson([{ role: 'system', content: 'Return JSON.' }], {
          requireJsonInstruction: true,
        }),
      ).resolves.toEqual({});
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      budget.dispose();
    }
  });
  it.each([
    'messages must contain json for json_object PRIVATE_PROVIDER_TEXT',
    JSON.stringify({
      error: {
        type: 'server_error',
        param: 'messages',
        message: 'messages must contain json for json_object PRIVATE_PROVIDER_TEXT',
      },
    }),
    JSON.stringify({
      error: {
        type: 'invalid_request_error',
        param: 'messages',
        message: 'messages must contain json PRIVATE_PROVIDER_TEXT',
      },
    }),
    JSON.stringify({
      error: {
        type: 'invalid_request_error',
        param: 'messages',
        message: 'json_object is not supported PRIVATE_PROVIDER_TEXT',
      },
    }),
  ])('does not overclassify unrecognized error bodies', async (body) => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => body });
    await expect(
      new LlmClient(config).chatJson([{ role: 'system', content: 'Return JSON.' }]),
    ).rejects.toMatchObject({ kind: 'invalid_request', details: undefined, httpStatus: 400 });
  });
  it.each([
    ['messages', true],
    ['arbitrary-private-param', false],
  ])(
    'classifies only recognized structured JSON errors with parameter %s',
    async (param, recognized) => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              param,
              message:
                "messages must contain the word 'json' to use response_format json_object. PRIVATE_RESPONSE",
            },
          }),
      });
      const diagnostics = new ExtractionDiagnostics();
      let error: unknown;
      try {
        await new LlmClient(config).chatJson([{ role: 'system', content: 'Compare identities.' }]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ kind: 'invalid_request', httpStatus: 400 });
      diagnostics.error(
        'entity_dedup',
        error as import('../../../src/extraction/ExtractionDiagnostics').ExtractionError,
      );
      const outcome = diagnostics.finish();
      expect(outcome.errors[0].reason).toBe(
        recognized ? 'json_mode_instruction_missing' : undefined,
      );
      expect(outcome.errors[0].parameter).toBe(recognized ? 'messages' : undefined);
      expect(JSON.stringify(outcome)).not.toContain('PRIVATE_RESPONSE');
      expect(JSON.stringify(outcome)).not.toContain('arbitrary-private-param');
    },
  );
});
