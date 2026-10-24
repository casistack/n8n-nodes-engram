import { RequestBudget, readBoundedResponse } from './RequestBudget';
/**
 * Lightweight OpenAI-compatible API client for extraction tasks.
 * Works with OpenAI, OpenRouter, Ollama, or any compatible endpoint.
 */

import { ExtractionTemperatureSchema, type ExtractionTemperature } from '../schemas';
import { ExtractionError, type ExtractionDiagnostics } from './ExtractionDiagnostics';
import type { ExtractionStage } from '../schemas';
import { normalizeHttpBaseUrl } from '../utils/url';

export interface LlmClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  temperature?: ExtractionTemperature;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class LlmClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private temperature: ExtractionTemperature;

  constructor(
    config: LlmClientConfig,
    private diagnostics?: ExtractionDiagnostics,
    private stage: ExtractionStage = 'entities',
    private budget?: RequestBudget,
  ) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeHttpBaseUrl(config.baseUrl, 'LLM API baseUrl');
    this.model = config.model;
    this.temperature = ExtractionTemperatureSchema.parse(config.temperature ?? { mode: 'legacy' });
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async chat(
    messages: LlmMessage[],
    options?: {
      temperature?: number | ExtractionTemperature;
      maxTokens?: number;
      responseFormat?: { type: 'json_object' | 'text' };
      stage?: ExtractionStage;
    },
  ): Promise<LlmResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };

    const setting = options?.temperature;
    const temperature = ExtractionTemperatureSchema.parse(
      typeof setting === 'number'
        ? { mode: 'custom', value: setting }
        : (setting ?? this.temperature),
    );
    if (temperature.mode !== 'providerDefault')
      body.temperature = temperature.mode === 'custom' ? temperature.value : 0;

    if (options?.maxTokens) {
      body.max_tokens = options.maxTokens;
    }

    if (options?.responseFormat) {
      body.response_format = options.responseFormat;
    }

    const serializedBody = JSON.stringify(body);
    const remaining = this.budget?.reserve(Buffer.byteLength(serializedBody));
    const metric = this.diagnostics?.beginRequest(options?.stage ?? this.stage);
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.budget?.controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, Math.min(this.timeoutMs, remaining ?? this.timeoutMs));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: serializedBody,
        signal: controller.signal,
      });
      metric?.headers();
      if (!response.ok) {
        const text = this.budget
          ? await readBoundedResponse(response, this.budget.maxResponseBytes)
          : await response.text();
        let kind: import('../schemas').ExtractionErrorKind =
          response.status === 401 || response.status === 403
            ? 'authentication'
            : response.status === 429
              ? 'rate_limit'
              : response.status >= 500
                ? 'provider_server'
                : 'invalid_request';
        // Inspect only for classification; never retain or emit provider-controlled text.
        if (
          response.status === 400 &&
          /unsupported[_ ]parameter|(?:temperature|max_tokens|max_completion_tokens|response_format).{0,100}(?:unsupported|not supported|does not support|only supports)/i.test(
            text,
          )
        )
          kind = 'unsupported_parameter';
        throw new ExtractionError(kind, response.status);
      }
      let data: unknown;
      try {
        data = this.budget
          ? (JSON.parse(
              await readBoundedResponse(response, this.budget.maxResponseBytes),
            ) as unknown)
          : await response.json();
      } catch (error) {
        if (controller.signal.aborted || error instanceof ExtractionError) throw error;
        throw new ExtractionError('invalid_response');
      }
      const envelope = data as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: LlmResponse['usage'];
      } | null;
      const content = envelope?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim())
        throw new ExtractionError('invalid_response');
      this.budget?.check();
      metric?.end('completed', envelope?.usage);
      return { content, usage: envelope?.usage };
    } catch (error: unknown) {
      metric?.end(controller.signal.aborted ? 'cancelled' : 'failed');
      if (this.budget?.controller.signal.aborted) this.budget.check();
      if (controller.signal.aborted) throw new ExtractionError('timeout');
      if (error instanceof ExtractionError) throw error;
      throw new ExtractionError('network');
    } finally {
      clearTimeout(timeout);
      this.budget?.controller.signal.removeEventListener('abort', abort);
    }
  }

  async chatJson<T>(
    messages: LlmMessage[],
    options?: {
      temperature?: number | ExtractionTemperature;
      maxTokens?: number;
      stage?: ExtractionStage;
    },
  ): Promise<T> {
    const response = await this.chat(messages, {
      ...options,
      responseFormat: { type: 'json_object' },
    });

    try {
      return JSON.parse(response.content) as T;
    } catch {
      throw new ExtractionError('invalid_response');
    }
  }
}
