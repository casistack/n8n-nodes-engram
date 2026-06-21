/**
 * Lightweight OpenAI-compatible API client for extraction tasks.
 * Works with OpenAI, OpenRouter, Ollama, or any compatible endpoint.
 */

import { normalizeHttpBaseUrl } from '../utils/url';

export interface LlmClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
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

  constructor(config: LlmClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeHttpBaseUrl(config.baseUrl, 'LLM API baseUrl');
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async chat(
    messages: LlmMessage[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      responseFormat?: { type: 'json_object' | 'text' };
    },
  ): Promise<LlmResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.0,
    };

    if (options?.maxTokens) {
      body.max_tokens = options.maxTokens;
    }

    if (options?.responseFormat) {
      body.response_format = options.responseFormat;
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
        throw new Error(`LLM API request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      content: data.choices[0]?.message?.content ?? '',
      usage: data.usage,
    };
  }

  async chatJson<T>(
    messages: LlmMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<T> {
    const response = await this.chat(messages, {
      ...options,
      responseFormat: { type: 'json_object' },
    });

    try {
      return JSON.parse(response.content) as T;
    } catch {
      throw new Error(`Failed to parse LLM JSON response: ${response.content.slice(0, 200)}`);
    }
  }
}
