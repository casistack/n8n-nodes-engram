import { RequestBudget, readBoundedResponse } from '../extraction/RequestBudget';
/**
 * Thin wrapper around OpenAI-compatible /v1/embeddings API.
 * Works with OpenAI, OpenRouter, Ollama, or any compatible endpoint.
 */

import { normalizeHttpBaseUrl } from '../utils/url';
import { ExtractionError, type ExtractionDiagnostics } from '../extraction/ExtractionDiagnostics';

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

  constructor(
    config: EmbeddingConfig,
    private diagnostics?: ExtractionDiagnostics,
    private budget?: RequestBudget,
  ) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeHttpBaseUrl(config.baseUrl, 'Embedding API baseUrl');
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

    const end = this.diagnostics?.begin('embeddings');
    let failed = true;
    try {
      const url = `${this.baseUrl}/embeddings`;

      const body: Record<string, unknown> = {
        model: this.model,
        input: texts,
      };

      if (this.dimensions) {
        body.dimensions = this.dimensions;
      }

      const serializedBody = JSON.stringify(body);
      const remaining = this.budget?.reserve(Buffer.byteLength(serializedBody));
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.budget?.controller.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, Math.min(remaining ?? this.timeoutMs, this.timeoutMs));

      const metric = this.diagnostics?.beginRequest('embeddings');
      try {
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: serializedBody,
            signal: controller.signal,
          });
        } catch (error: unknown) {
          if (this.budget)
            throw new ExtractionError(controller.signal.aborted ? 'timeout' : 'network');
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Embedding API request timed out after ${this.timeoutMs}ms`);
          }
          throw error;
        }

        metric?.headers();
        if (!response.ok) {
          const errorText = this.budget
            ? await readBoundedResponse(response, this.budget.maxResponseBytes)
            : await response.text();
          if (this.budget)
            throw new ExtractionError(
              response.status === 401 || response.status === 403
                ? 'authentication'
                : response.status === 429
                  ? 'rate_limit'
                  : response.status >= 500
                    ? 'provider_server'
                    : 'invalid_request',
              response.status,
            );
          throw new Error(`Embedding API error (${response.status}): ${errorText}`);
        }

        const data = (
          this.budget
            ? JSON.parse(await readBoundedResponse(response, this.budget.maxResponseBytes))
            : await response.json()
        ) as {
          data: Array<{ embedding: number[]; index: number }>;
          usage?: { prompt_tokens: number; total_tokens: number };
        };

        this.budget?.check();
        if (
          this.budget &&
          (!Array.isArray(data?.data) ||
            data.data.length !== texts.length ||
            data.data.some(
              (item) =>
                !item ||
                !Number.isInteger(item.index) ||
                item.index < 0 ||
                item.index >= texts.length ||
                !Array.isArray(item.embedding) ||
                !item.embedding.length ||
                !item.embedding.every(Number.isFinite),
            ) ||
            new Set(data.data.map((item) => item.index)).size !== texts.length)
        )
          throw new Error('Invalid embedding response');
        // Sort by index to preserve input order
        const sorted = [...data.data].sort((a, b) => a.index - b.index);

        metric?.end('completed', data.usage, true);
        const results = sorted.map((item) => ({
          embedding: item.embedding,
          usage: data.usage,
        }));
        failed = false;
        return results;
      } catch (error) {
        if (this.budget?.controller.signal.aborted) this.budget.check();
        if (this.budget && controller.signal.aborted) throw new ExtractionError('timeout');
        throw error;
      } finally {
        if (failed)
          metric?.end(controller.signal.aborted ? 'cancelled' : 'failed', undefined, true);
        clearTimeout(timeout);
        this.budget?.controller.signal.removeEventListener('abort', abort);
      }
    } finally {
      end?.(failed);
    }
  }
}
