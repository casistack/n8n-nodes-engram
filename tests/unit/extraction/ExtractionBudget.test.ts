import { RequestBudget, readBoundedResponse } from '../../../src/extraction/RequestBudget';
import {
  ExtractionBudgetError,
  ExtractionDiagnostics,
} from '../../../src/extraction/ExtractionDiagnostics';
import { LlmClient } from '../../../src/extraction/LlmClient';
import { EmbeddingService } from '../../../src/embeddings/EmbeddingService';

describe('versioned bounded extraction reasons', () => {
  it.each(['chat', 'embedding'] as const)(
    'preserves separate request timeout and shared deadline for %s',
    async (kind) => {
      const fetch = jest.spyOn(global, 'fetch').mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new Error('synthetic cancellation')),
              { once: true },
            );
          }),
      );
      const invoke = (budget: RequestBudget, timeoutMs: number) => {
        const config = {
          apiKey: 'synthetic',
          baseUrl: 'https://provider.invalid/v1',
          model: 'unused',
          timeoutMs,
        };
        return kind === 'chat'
          ? new LlmClient(config, undefined, 'entities', budget).chat([
              { role: 'user', content: 'synthetic' },
            ])
          : new EmbeddingService(config, undefined, budget).embed('synthetic');
      };
      const independent = new RequestBudget(2, 2000);
      let clipped: RequestBudget | undefined;
      try {
        await expect(invoke(independent, 5)).rejects.toMatchObject({ kind: 'timeout' });
        expect(independent.controller.signal.aborted).toBe(false);
        independent.reserve(1);
        clipped = new RequestBudget(2, 25);
        await expect(invoke(clipped, 1000)).rejects.toMatchObject({
          kind: 'budget_exhausted',
          budgetReason: 'deadline',
        });
        expect(clipped.controller.signal.aborted).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        independent.dispose();
        clipped?.dispose();
        fetch.mockRestore();
      }
    },
  );
  it('distinguishes request bytes and request count without changing the existing error kind', () => {
    const budget = new RequestBudget(1, 30000, 4, 4);
    try {
      budget.reserve(4);
      for (const [bytes, reason] of [
        [5, 'request_bytes'],
        [4, 'request_count'],
      ] as const) {
        try {
          budget.reserve(bytes);
          throw new Error('Expected bounded failure');
        } catch (error) {
          expect(error).toMatchObject({ kind: 'budget_exhausted', budgetReason: reason });
        }
      }
    } finally {
      budget.dispose();
    }
  });
  it('distinguishes deadline from external cancellation', () => {
    const external = new AbortController();
    const cancelled = new RequestBudget(1, 100, 4, 4, external.signal);
    external.abort();
    expect(() => cancelled.check()).toThrow(ExtractionBudgetError);
    try {
      cancelled.check();
    } catch (error) {
      expect(error).toMatchObject({ kind: 'cancelled', budgetReason: 'cancelled' });
    }
    cancelled.dispose();
    const deadline = new RequestBudget(1, 100, 4, 4);
    deadline.controller.abort();
    try {
      deadline.check();
    } catch (error) {
      expect(error).toMatchObject({ kind: 'budget_exhausted', budgetReason: 'deadline' });
    }
    deadline.dispose();
  });
  it('cancels an oversized response and emits a bounded redacted root diagnostic', async () => {
    const response = new Response('12345');
    await expect(readBoundedResponse(response, 4)).rejects.toMatchObject({
      kind: 'budget_exhausted',
      budgetReason: 'response_bytes',
    });
    const diagnostics = new ExtractionDiagnostics();
    diagnostics.error('entities', new ExtractionBudgetError('response_bytes'));
    const outcome = diagnostics.finish();
    expect(outcome.budget).toEqual({ version: 1, reason: 'response_bytes' });
    expect(outcome.errors).toEqual([{ stage: 'entities', kind: 'budget_exhausted' }]);
    expect(JSON.stringify(outcome)).not.toContain('12345');
  });
});
