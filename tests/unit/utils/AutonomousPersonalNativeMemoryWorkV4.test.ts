import { performance } from 'node:perf_hooks';
import type { IExecuteFunctions } from 'n8n-workflow';
import { ExtractionBudgetError } from '../../../src/extraction/ExtractionDiagnostics';
import { createAutonomousPersonalNativeMemoryWorkV4 } from '../../../src/utils/AutonomousPersonalNativeMemoryWorkV4';

type Host = Pick<IExecuteFunctions, 'getExecutionCancelSignal'>;

describe('native Memory work V4', () => {
  afterEach(() => jest.restoreAllMocks());

  it('captures the original clock and native signal once without retaining the host reader', () => {
    let now = 1000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    const getSignal = jest.fn(() => controller.signal);
    const lifetime = createAutonomousPersonalNativeMemoryWorkV4(
      { getExecutionCancelSignal: getSignal },
      100,
    );
    expect(lifetime.work.absoluteMonotonicDeadlineMs).toBe(1100);
    expect(lifetime.work.signal).toBe(controller.signal);
    expect(lifetime.nativeCancellationAvailable).toBe(true);
    expect(Object.isFrozen(lifetime)).toBe(true);
    expect(Object.isFrozen(lifetime.work)).toBe(true);
    now = 1099;
    lifetime.check();
    now = 1100;
    let failure: unknown;
    try {
      lifetime.check();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ExtractionBudgetError);
    expect((failure as ExtractionBudgetError).budgetReason).toBe('deadline');
    now = 1000;
    let subsequent: unknown;
    try {
      lifetime.check();
    } catch (error) {
      subsequent = error;
    }
    expect(subsequent).toBe(failure);
    expect(getSignal).toHaveBeenCalledTimes(1);
  });

  it('keeps native cancellation distinct from deadline expiry', () => {
    const controller = new AbortController();
    const lifetime = createAutonomousPersonalNativeMemoryWorkV4(
      { getExecutionCancelSignal: () => controller.signal },
      30_000,
    );
    controller.abort();
    try {
      lifetime.check();
      throw new Error('Expected cancellation');
    } catch (error) {
      expect(error).toBeInstanceOf(ExtractionBudgetError);
      expect((error as ExtractionBudgetError).budgetReason).toBe('cancelled');
    }
  });

  it.each([{}, { getExecutionCancelSignal: () => undefined }])(
    'uses fallback only for an absent method or undefined signal',
    (host) => {
      const lifetime = createAutonomousPersonalNativeMemoryWorkV4(host as Host, 1000);
      expect(lifetime.work.signal.aborted).toBe(false);
      expect(lifetime.nativeCancellationAvailable).toBe(false);
      lifetime.check();
    },
  );

  it.each([null, {}, { aborted: false }, new Proxy(new AbortController().signal, {})])(
    'rejects an invalid supplied native signal without falling back',
    (signal) => {
      expect(() =>
        createAutonomousPersonalNativeMemoryWorkV4(
          { getExecutionCancelSignal: () => signal } as Host,
          1000,
        ),
      ).toThrow('unsupported_configuration');
    },
  );

  it('redacts host getter failures and malformed methods', () => {
    const hostileHost = Object.defineProperty({}, 'getExecutionCancelSignal', {
      get() {
        throw new Error('synthetic-private-property-value');
      },
    });
    expect(() => createAutonomousPersonalNativeMemoryWorkV4(hostileHost as Host, 1000)).toThrow(
      'Engram native Memory work: unsupported_configuration',
    );
    expect(() =>
      createAutonomousPersonalNativeMemoryWorkV4(
        {
          getExecutionCancelSignal() {
            throw new Error('synthetic-private-value');
          },
        },
        1000,
      ),
    ).toThrow('Engram native Memory work: unsupported_configuration');
    expect(() =>
      createAutonomousPersonalNativeMemoryWorkV4(
        { getExecutionCancelSignal: null } as unknown as Host,
        1000,
      ),
    ).toThrow('unsupported_configuration');
  });

  it.each([99, 120001, NaN, Infinity, '1000'])('rejects invalid deadline %s', (deadline) => {
    expect(() => createAutonomousPersonalNativeMemoryWorkV4({} as Host, deadline)).toThrow(
      'unsupported_configuration',
    );
  });
});
