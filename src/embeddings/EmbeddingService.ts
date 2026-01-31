/**
 * Thin wrapper around OpenAI-compatible /v1/embeddings API.
 * Works with OpenAI, OpenRouter, Ollama, or any compatible endpoint.
 */

export interface EmbeddingConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	/** Optional fixed dimensions (e.g. 1536 for text-embedding-3-small) */
	dimensions?: number;
	/** Request timeout in milliseconds (default: 30000) */
	timeoutMs?: number;
}

export interface EmbeddingResult {
	embedding: number[];
	usage?: { prompt_tokens: number; total_tokens: number };
}

export class EmbeddingService {
	private apiKey: string;
	private baseUrl: string;
	private model: string;
	private dimensions: number | undefined;
	private timeoutMs: number;

	constructor(config: EmbeddingConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl.replace(/\/$/, '');
		this.model = config.model;
		this.dimensions = config.dimensions;
		this.timeoutMs = config.timeoutMs ?? 30_000;
	}

	/** Embed a single text string. */
	async embed(text: string): Promise<EmbeddingResult> {
		const results = await this.embedBatch([text]);
		return results[0];
	}

	/** Embed multiple texts in a single API call. */
	async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
		if (texts.length === 0) return [];

		const url = `${this.baseUrl}/embeddings`;

		const body: Record<string, unknown> = {
			model: this.model,
			input: texts,
		};

		if (this.dimensions) {
			body.dimensions = this.dimensions;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error: unknown) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error(
					`Embedding API request timed out after ${this.timeoutMs}ms`,
				);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Embedding API error (${response.status}): ${errorText}`,
			);
		}

		const data = (await response.json()) as {
			data: Array<{ embedding: number[]; index: number }>;
			usage?: { prompt_tokens: number; total_tokens: number };
		};

		// Sort by index to preserve input order
		const sorted = [...data.data].sort((a, b) => a.index - b.index);

		return sorted.map((item) => ({
			embedding: item.embedding,
			usage: data.usage,
		}));
	}
}
