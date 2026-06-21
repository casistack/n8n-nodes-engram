import { LlmClient } from '../../../src/extraction/LlmClient';

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
    expect(() => new LlmClient({
      apiKey: 'key',
      baseUrl: 'file:///tmp/chat',
      model: 'model',
    })).toThrow('LLM API baseUrl must use http or https');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should reject malformed baseUrl values before fetch', () => {
    expect(() => new LlmClient({
      apiKey: 'key',
      baseUrl: 'not a url',
      model: 'model',
    })).toThrow('LLM API baseUrl must be a valid HTTP(S) URL');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
