import { randomUUID } from 'node:crypto';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';
import type { StorageObservation } from '../../../src/schemas/StorageObservation.schema';
import { NativeMemoryObservabilityV1Schema } from '../../../src/schemas/NativeMemoryObservabilityV1.schema';
import {
  currentNativeRequestObserver,
  observeNativeOperation,
  readNativeDiagnosticsEnabled,
} from '../../../src/utils/NativeMemoryObservability';

type DiagnosticsHook = NonNullable<IGraphStorage['withExtractionDiagnostics']>;

const asStorage = (withExtractionDiagnostics?: DiagnosticsHook): IGraphStorage =>
  (withExtractionDiagnostics ? { withExtractionDiagnostics } : {}) as IGraphStorage;

const sample: StorageObservation = {
  backend: 'embedded',
  acknowledged: true,
  total_ms: 8,
  queue_wait_ms: 2,
  lock_wait_ms: 1,
  disk_refresh_ms: null,
  snapshot_write_ms: 3,
  snapshot_bytes: 128,
  transaction_ms: null,
  serialization_ms: 2,
};

const validSidecar = () => ({
  version: 1 as const,
  operation_id: randomUUID(),
  purpose: 'save' as const,
  elapsed_ms: 0,
  observer_errors: 0,
  native_requests: null,
  storage: null,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Native memory observability opt-in', () => {
  describe('readNativeDiagnosticsEnabled', () => {
    it('enables collection only for the explicit valid option', () => {
      expect(
        readNativeDiagnosticsEnabled({
          getNodeParameter: () => 'enabled',
        } as never),
      ).toBe(true);
      expect(
        readNativeDiagnosticsEnabled({
          getNodeParameter: (_name: string, _index: number, fallback: unknown) => fallback,
        } as never),
      ).toBe(false);
    });

    it.each([undefined, null, true, 'Enabled', 'on', 'unexpected'])(
      'keeps missing or invalid option %p disabled',
      (value) => {
        expect(
          readNativeDiagnosticsEnabled({
            getNodeParameter: () => value,
          } as never),
        ).toBe(false);
      },
    );

    it('fails closed when reading the node option throws', () => {
      expect(
        readNativeDiagnosticsEnabled({
          getNodeParameter: () => {
            throw new Error('private node context');
          },
        } as never),
      ).toBe(false);
    });
  });

  describe('operation collection', () => {
    it('leaves the disabled operation value untouched and creates no observer sidecar', async () => {
      const value = { payload: 'the exact native result' };
      let observerDuringBody: unknown;
      const body = jest.fn(async () => {
        observerDuringBody = currentNativeRequestObserver();
        return value;
      });

      const result = await observeNativeOperation(false, 'capture', asStorage(), body);

      expect(body).toHaveBeenCalledTimes(1);
      expect(observerDuringBody).toBeUndefined();
      expect(result.value).toBe(value);
      expect(result).not.toHaveProperty('diagnostics');
      expect(currentNativeRequestObserver()).toBeUndefined();
    });

    it('collects bounded request and storage totals without retaining supplied text', async () => {
      const apiSecret = 'SECRET_API_KEY_8a2f';
      const promptSecret = 'PRIVATE_PROMPT_41c9';
      const responseSecret = 'RAW_PROVIDER_RESPONSE_7bd1';
      const withDiagnostics: DiagnosticsHook = async (record, operation) => {
        record({ ...sample, private_prompt: promptSecret } as StorageObservation);
        return operation();
      };
      const nativeValue = { retainedByCaller: responseSecret };
      const body = jest.fn(async () => {
        const observer = currentNativeRequestObserver();
        expect(observer).toBeDefined();

        const valid = observer!.beginRequest('entities');
        valid.headers();
        valid.end('completed', {
          prompt_tokens: 11,
          completion_tokens: 4,
          total_tokens: 15,
          api_key: apiSecret,
          prompt: promptSecret,
          response: responseSecret,
        });

        const missing = observer!.beginRequest('entities');
        missing.headers();
        missing.end('completed');

        const invalid = observer!.beginRequest('entities');
        invalid.headers();
        invalid.end('failed', {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 99,
          response: responseSecret,
        });
        return nativeValue;
      });

      const result = await observeNativeOperation(
        true,
        'capture',
        asStorage(withDiagnostics),
        body,
      );

      expect(body).toHaveBeenCalledTimes(1);
      expect(result.value).toBe(nativeValue);
      expect(result.diagnostics).toMatchObject({
        version: 1,
        purpose: 'capture',
        observer_errors: 0,
        native_requests: {
          attempted: 3,
          completed: 2,
          failed: 1,
          cancelled: 0,
          in_flight: 0,
          timing_samples: 3,
          usage_valid: 1,
          usage_missing: 1,
          usage_invalid: 1,
          input_tokens: 11,
          output_tokens: 4,
          total_tokens: 15,
        },
        storage: {
          operations: 1,
          unconfirmed: 0,
          invalid_samples: 0,
          summed_total_ms: 8,
          queue_wait_ms: 2,
          lock_wait_ms: 1,
          snapshot_write_ms: 3,
          snapshot_bytes: 128,
          serialization_ms: 2,
        },
      });
      expect(result.diagnostics?.native_requests?.headers_ms).not.toBeNull();
      expect(result.diagnostics?.native_requests?.body_ms).not.toBeNull();
      expect(NativeMemoryObservabilityV1Schema.safeParse(result.diagnostics).success).toBe(true);
      const serializedSidecar = JSON.stringify(result.diagnostics);
      for (const secret of [apiSecret, promptSecret, responseSecret])
        expect(serializedSidecar).not.toContain(secret);
      expect(result.diagnostics?.storage).not.toHaveProperty('backend');
      expect(currentNativeRequestObserver()).toBeUndefined();
    });

    it('uses null for storage totals when the adapter does not expose the optional hook', async () => {
      const body = jest.fn(async () => 'completed');
      const result = await observeNativeOperation(true, 'load', asStorage(), body);

      expect(body).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        value: 'completed',
        diagnostics: { purpose: 'load', native_requests: null, storage: null },
      });
    });

    it('contains storage collector and adapter failures while preserving the body result', async () => {
      const adapterError = new Error('PRIVATE_ADAPTER_FAILURE');
      const collectorError = new Error('PRIVATE_COLLECTOR_FAILURE');
      const brokenSample = new Proxy({} as StorageObservation, {
        get() {
          throw collectorError;
        },
      });
      const hook: DiagnosticsHook = async (record, operation) => {
        record(brokenSample);
        await operation();
        throw adapterError;
      };
      const nativeValue = { stable: true };
      const body = jest.fn(async () => nativeValue);

      const result = await observeNativeOperation(true, 'save', asStorage(hook), body);

      expect(body).toHaveBeenCalledTimes(1);
      expect(result.value).toBe(nativeValue);
      expect(result.diagnostics?.observer_errors).toBe(2);
      expect(JSON.stringify(result.diagnostics)).not.toContain('PRIVATE_');
    });

    it('omits a sidecar if schema snapshotting throws and still returns the native value', async () => {
      const snapshotError = new Error('PRIVATE_SCHEMA_FAILURE');
      const parseSpy = jest
        .spyOn(NativeMemoryObservabilityV1Schema, 'parse')
        .mockImplementationOnce(() => {
          throw snapshotError;
        });
      const nativeValue = { unchanged: true };
      const body = jest.fn(async () => nativeValue);

      try {
        const result = await observeNativeOperation(true, 'save', asStorage(), body);
        expect(body).toHaveBeenCalledTimes(1);
        expect(result.value).toBe(nativeValue);
        expect(result).not.toHaveProperty('diagnostics');
      } finally {
        parseSpy.mockRestore();
      }
    });

    it('bounds observer error counts at the schema maximum without exposing thrown text', async () => {
      const plantedSecret = 'PRIVATE_DIAGNOSTIC_THROW_6e82';
      const brokenSample = new Proxy({} as StorageObservation, {
        get() {
          throw new Error(plantedSecret);
        },
      });
      const hook: DiagnosticsHook = async (record, operation) => {
        for (let index = 0; index < 125; index++) record(brokenSample);
        return operation();
      };

      const result = await observeNativeOperation(true, 'capture', asStorage(hook), async () => 7);

      expect(result.value).toBe(7);
      expect(result.diagnostics?.observer_errors).toBe(100);
      expect(NativeMemoryObservabilityV1Schema.safeParse(result.diagnostics).success).toBe(true);
      expect(JSON.stringify(result.diagnostics)).not.toContain(plantedSecret);
    });

    it('invokes the body once when the optional adapter throws before invoking it', async () => {
      const adapterError = new Error('PRIVATE_BEFORE_BODY');
      const hook: DiagnosticsHook = async () => {
        throw adapterError;
      };
      const nativeValue = { runs: 1 };
      const body = jest.fn(async () => nativeValue);

      const result = await observeNativeOperation(true, 'capture', asStorage(hook), body);

      expect(body).toHaveBeenCalledTimes(1);
      expect(result.value).toBe(nativeValue);
      expect(result.diagnostics?.observer_errors).toBe(1);
      expect(JSON.stringify(result.diagnostics)).not.toContain('PRIVATE_BEFORE_BODY');
    });

    it('memoizes repeated adapter invocations and contains a failure after body completion', async () => {
      const adapterError = new Error('PRIVATE_AFTER_BODY');
      const hook: DiagnosticsHook = async (_record, operation) => {
        const first = await operation();
        const second = await operation();
        expect(second).toBe(first);
        throw adapterError;
      };
      const nativeValue = { onlyOnce: true };
      const body = jest.fn(async () => nativeValue);

      const result = await observeNativeOperation(true, 'save', asStorage(hook), body);

      expect(body).toHaveBeenCalledTimes(1);
      expect(result.value).toBe(nativeValue);
      expect(result.diagnostics?.observer_errors).toBe(1);
      expect(JSON.stringify(result.diagnostics)).not.toContain('PRIVATE_AFTER_BODY');
    });

    it('preserves the exact body rejection even when an adapter replaces the rejection', async () => {
      const bodyError = new Error('PRIVATE_NATIVE_FAILURE');
      const adapterError = new Error('PRIVATE_ADAPTER_REPLACEMENT');
      const hook: DiagnosticsHook = async (_record, operation) => {
        try {
          return await operation();
        } catch {
          throw adapterError;
        }
      };
      const body = jest.fn(async () => {
        throw bodyError;
      });

      await expect(observeNativeOperation(true, 'save', asStorage(hook), body)).rejects.toBe(
        bodyError,
      );
      expect(body).toHaveBeenCalledTimes(1);
      expect(currentNativeRequestObserver()).toBeUndefined();
    });

    it('keeps overlapping operation request counts and token totals in separate scopes', async () => {
      const gateA = deferred();
      const gateB = deferred();
      const enteredA = deferred();
      const enteredB = deferred();
      const begin = (
        gate: ReturnType<typeof deferred>,
        entered: ReturnType<typeof deferred>,
        label: string,
        requestCount: number,
        promptTokens: number,
      ) =>
        observeNativeOperation(true, 'capture', asStorage(), async () => {
          const observer = currentNativeRequestObserver();
          expect(observer).toBeDefined();
          const requests = Array.from({ length: requestCount }, () =>
            observer!.beginRequest('entities'),
          );
          for (const request of requests) request.headers();
          entered.resolve();
          await gate.promise;
          requests.forEach((request, index) => {
            request.end(
              'completed',
              index === 0
                ? {
                    prompt_tokens: promptTokens,
                    completion_tokens: 1,
                    total_tokens: promptTokens + 1,
                  }
                : undefined,
            );
          });
          return label;
        });

      const slow = begin(gateA, enteredA, 'slow', 2, 5);
      const fast = begin(gateB, enteredB, 'fast', 1, 12);
      await Promise.all([enteredA.promise, enteredB.promise]);
      gateB.resolve();
      gateA.resolve();
      const [resultA, resultB] = await Promise.all([slow, fast]);

      expect(resultA.value).toBe('slow');
      expect(resultA.diagnostics?.native_requests).toMatchObject({
        attempted: 2,
        completed: 2,
        usage_valid: 1,
        usage_missing: 1,
        input_tokens: 5,
        output_tokens: 1,
        total_tokens: 6,
      });
      expect(resultB.value).toBe('fast');
      expect(resultB.diagnostics?.native_requests).toMatchObject({
        attempted: 1,
        completed: 1,
        usage_valid: 1,
        usage_missing: 0,
        input_tokens: 12,
        output_tokens: 1,
        total_tokens: 13,
      });
      expect(currentNativeRequestObserver()).toBeUndefined();
    });
  });
});

describe('NativeMemoryObservabilityV1Schema', () => {
  it('accepts a minimal fixed-shape sidecar', () => {
    expect(NativeMemoryObservabilityV1Schema.safeParse(validSidecar()).success).toBe(true);
  });

  it.each(['prompt', 'response_text', 'raw_payload', 'provider_error'])(
    'rejects text-bearing sidecar field %s',
    (field) => {
      expect(
        NativeMemoryObservabilityV1Schema.safeParse({
          ...validSidecar(),
          [field]: 'PRIVATE_TEXT',
        }).success,
      ).toBe(false);
    },
  );

  it('rejects unknown request fields, including the internal retry count', () => {
    const nativeRequests = {
      attempted: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      in_flight: 0,
      summed_ms: 0,
      headers_ms: null,
      body_ms: null,
      timing_samples: 0,
      usage_valid: 0,
      usage_missing: 0,
      usage_invalid: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      retries: 0,
    };

    expect(
      NativeMemoryObservabilityV1Schema.safeParse({
        ...validSidecar(),
        native_requests: nativeRequests,
      }).success,
    ).toBe(false);
  });

  it.each([
    { elapsed_ms: -1 },
    { elapsed_ms: Number.POSITIVE_INFINITY },
    { observer_errors: 101 },
    { observer_errors: 1.5 },
    {
      native_requests: {
        attempted: -1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        in_flight: 0,
        summed_ms: 0,
        headers_ms: null,
        body_ms: null,
        timing_samples: 0,
        usage_valid: 0,
        usage_missing: 0,
        usage_invalid: 0,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      },
    },
  ])('rejects invalid numeric values %#', (override) => {
    expect(
      NativeMemoryObservabilityV1Schema.safeParse({ ...validSidecar(), ...override }).success,
    ).toBe(false);
  });
});
