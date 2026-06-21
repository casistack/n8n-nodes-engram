import { EmbeddingService } from '../../../src/embeddings/EmbeddingService';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockEmbeddingResponse(embeddings: number[][], usage?: { prompt_tokens: number; total_tokens: number }) {
	return {
		ok: true,
		json: async () => ({
			data: embeddings.map((embedding, index) => ({ embedding, index })),
			usage: usage ?? { prompt_tokens: 10, total_tokens: 10 },
		}),
	};
}

describe('EmbeddingService', () => {
	let service: EmbeddingService;

	beforeEach(() => {
		mockFetch.mockReset();
		service = new EmbeddingService({
			apiKey: 'test-key',
			baseUrl: 'https://api.example.com/v1',
			model: 'text-embedding-3-small',
		});
	});

	describe('embed', () => {
		it('should embed a single text and return the vector', async () => {
			const vector = [0.1, 0.2, 0.3];
			mockFetch.mockResolvedValueOnce(mockEmbeddingResponse([vector]));

			const result = await service.embed('hello world');

			expect(result.embedding).toEqual(vector);
			expect(result.usage).toEqual({ prompt_tokens: 10, total_tokens: 10 });
		});

		it('should call the correct endpoint with correct headers', async () => {
			mockFetch.mockResolvedValueOnce(mockEmbeddingResponse([[0.1]]));

			await service.embed('test');

			expect(mockFetch).toHaveBeenCalledWith(
				'https://api.example.com/v1/embeddings',
				expect.objectContaining({
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: 'Bearer test-key',
					},
				}),
			);

			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.model).toBe('text-embedding-3-small');
			expect(body.input).toEqual(['test']);
		});

		it('should strip trailing slash from baseUrl', async () => {
			const svc = new EmbeddingService({
				apiKey: 'key',
				baseUrl: 'https://api.example.com/v1/',
				model: 'model',
			});
			mockFetch.mockResolvedValueOnce(mockEmbeddingResponse([[0.1]]));

			await svc.embed('test');

			expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/v1/embeddings');
		});

		it('should reject non-http baseUrl protocols before fetch', async () => {
			expect(() => new EmbeddingService({
				apiKey: 'key',
				baseUrl: 'file:///tmp/embeddings',
				model: 'model',
			})).toThrow('Embedding API baseUrl must use http or https');

			expect(mockFetch).not.toHaveBeenCalled();
		});

		it('should reject malformed baseUrl values before fetch', async () => {
			expect(() => new EmbeddingService({
				apiKey: 'key',
				baseUrl: 'not a url',
				model: 'model',
			})).toThrow('Embedding API baseUrl must be a valid HTTP(S) URL');

			expect(mockFetch).not.toHaveBeenCalled();
		});

		it('should include dimensions when configured', async () => {
			const svc = new EmbeddingService({
				apiKey: 'key',
				baseUrl: 'https://api.example.com/v1',
				model: 'model',
				dimensions: 256,
			});
			mockFetch.mockResolvedValueOnce(mockEmbeddingResponse([[0.1]]));

			await svc.embed('test');

			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.dimensions).toBe(256);
		});

		it('should not include dimensions when not configured', async () => {
			mockFetch.mockResolvedValueOnce(mockEmbeddingResponse([[0.1]]));

			await service.embed('test');

			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.dimensions).toBeUndefined();
		});
	});

	describe('embedBatch', () => {
		it('should embed multiple texts in one call', async () => {
			const vectors = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
			mockFetch.mockResolvedValueOnce(mockEmbeddingResponse(vectors));

			const results = await service.embedBatch(['a', 'b', 'c']);

			expect(results).toHaveLength(3);
			expect(results[0].embedding).toEqual([0.1, 0.2]);
			expect(results[1].embedding).toEqual([0.3, 0.4]);
			expect(results[2].embedding).toEqual([0.5, 0.6]);
		});

		it('should preserve input order even if API returns shuffled indices', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [
						{ embedding: [0.5, 0.6], index: 2 },
						{ embedding: [0.1, 0.2], index: 0 },
						{ embedding: [0.3, 0.4], index: 1 },
					],
					usage: { prompt_tokens: 10, total_tokens: 10 },
				}),
			});

			const results = await service.embedBatch(['a', 'b', 'c']);

			expect(results[0].embedding).toEqual([0.1, 0.2]);
			expect(results[1].embedding).toEqual([0.3, 0.4]);
			expect(results[2].embedding).toEqual([0.5, 0.6]);
		});

		it('should return empty array for empty input', async () => {
			const results = await service.embedBatch([]);

			expect(results).toEqual([]);
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe('error handling', () => {
		it('should throw on non-OK response', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				text: async () => 'Unauthorized',
			});

			await expect(service.embed('test')).rejects.toThrow(
				'Embedding API error (401): Unauthorized',
			);
		});

		it('should throw on timeout', async () => {
			const svc = new EmbeddingService({
				apiKey: 'key',
				baseUrl: 'https://api.example.com/v1',
				model: 'model',
				timeoutMs: 50,
			});

			// Mock fetch that respects AbortSignal (real fetch does this natively)
			mockFetch.mockImplementationOnce((_url: string, options: { signal?: AbortSignal }) => {
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve(undefined), 200);
					options?.signal?.addEventListener('abort', () => {
						clearTimeout(timer);
						const error = new Error('The operation was aborted');
						error.name = 'AbortError';
						reject(error);
					});
				});
			});

			await expect(svc.embed('test')).rejects.toThrow('timed out');
		});

		it('should throw on network error', async () => {
			mockFetch.mockRejectedValueOnce(new Error('Network error'));

			await expect(service.embed('test')).rejects.toThrow('Network error');
		});
	});
});
