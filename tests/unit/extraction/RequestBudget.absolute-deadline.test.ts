import { performance } from 'perf_hooks';
import { LlmClient } from '../../../src/extraction/LlmClient';
import { RequestBudget } from '../../../src/extraction/RequestBudget';

describe('RequestBudget absolute monotonic deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('clips a new 100 ms budget to the existing absolute deadline at 100 ms', () => {
    jest.spyOn(performance, 'now').mockReturnValue(75);
    const budget = new RequestBudget(2, 100, 1024, 1024, undefined, 100);

    try {
      expect(budget.reserve(1)).toBe(25);
      jest.advanceTimersByTime(24);
      expect(budget.controller.signal.aborted).toBe(false);
      jest.advanceTimersByTime(1);
      expect(budget.controller.signal.aborted).toBe(true);
    } finally {
      budget.dispose();
    }
  });

  it('reports at most 100 ms when 4900 ms of a 5000 ms window has elapsed', () => {
    jest.spyOn(performance, 'now').mockReturnValue(4900);
    const budget = new RequestBudget(2, 5000, 1024, 1024, undefined, 5000);

    try {
      expect(budget.reserve(1)).toBe(100);
      jest.advanceTimersByTime(100);
      expect(budget.controller.signal.aborted).toBe(true);
    } finally {
      budget.dispose();
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a nonfinite absolute deadline (%s)',
    (deadlineAt) => {
      expect(() => new RequestBudget(1, 100, 4, 4, undefined, deadlineAt)).toThrow(
        'Invalid extraction budget',
      );
    },
  );

  it('aborts synchronously for an expired anchor and never dispatches a request', async () => {
    jest.spyOn(performance, 'now').mockReturnValue(101);
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
    const budget = new RequestBudget(2, 5000, 1024, 1024, undefined, 100);
    const client = new LlmClient(
      {
        apiKey: 'synthetic',
        baseUrl: 'https://provider.invalid/v1',
        model: 'unused',
      },
      undefined,
      'entities',
      budget,
    );

    try {
      expect(budget.controller.signal.aborted).toBe(true);
      await expect(client.chat([{ role: 'user', content: 'synthetic' }])).rejects.toMatchObject({
        kind: 'budget_exhausted',
        budgetReason: 'deadline',
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      budget.dispose();
    }
  });

  it('keeps the shorter local deadline and preserves the existing five-argument call form', () => {
    jest.spyOn(performance, 'now').mockReturnValue(75);
    const short = new RequestBudget(2, 10, 1024, 1024, undefined, 100);
    const legacy = new RequestBudget(2, 20, 1024, 1024, undefined);

    try {
      expect(short.reserve(1)).toBe(10);
      expect(legacy.reserve(1)).toBe(20);
      jest.advanceTimersByTime(10);
      expect(short.controller.signal.aborted).toBe(true);
      expect(legacy.controller.signal.aborted).toBe(false);
      jest.advanceTimersByTime(10);
      expect(legacy.controller.signal.aborted).toBe(true);
    } finally {
      short.dispose();
      legacy.dispose();
    }
  });

  it('dispose clears the abort timer and does not fire it later', () => {
    jest.spyOn(performance, 'now').mockReturnValue(0);
    const budget = new RequestBudget(1, 100, 4, 4, undefined, 100);
    const abort = jest.spyOn(budget.controller, 'abort');

    budget.dispose();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(1000);
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
