import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { ExtractionDiagnostics } from '../extraction/ExtractionDiagnostics';
import type { LlmRequestObserver } from '../extraction/LlmClient';
import type { IGraphStorage } from '../storage/IGraphStorage';
import { StorageAccumulator } from '../storage/StorageDiagnostics';
import {
  NativeDiagnosticsOptionSchema,
  NativeMemoryObservabilityV1Schema,
  type NativeMemoryObservabilityV1,
} from '../schemas/NativeMemoryObservabilityV1.schema';

type Purpose = NativeMemoryObservabilityV1['purpose'];
export const nativeDiagnosticsProperty: INodeProperties = {
  displayName: 'Native Memory Diagnostics',
  name: 'nativeDiagnostics',
  noDataExpression: true,
  type: 'options',
  default: 'disabled',
  options: [
    { name: 'Disabled', value: 'disabled' },
    { name: 'Enabled', value: 'enabled' },
  ],
  displayOptions: {
    show: {
      '@version': [3],
      automaticMemoryProfile: ['conservative', 'explicit', 'reviewFirst'],
      automaticPreferenceInterpreter: ['autonomousPersonalV1'],
    },
  },
  description:
    'Include bounded request timing, token usage and available storage totals in diagnostic output. Does not change memory acceptance or model settings.',
};

export function readNativeDiagnosticsEnabled(
  ctx: Pick<IExecuteFunctions, 'getNodeParameter'>,
): boolean {
  try {
    return (
      NativeDiagnosticsOptionSchema.safeParse(
        ctx.getNodeParameter('nativeDiagnostics', 0, 'disabled'),
      ).data === 'enabled'
    );
  } catch {
    return false;
  }
}

class OperationObserver {
  readonly storage = new StorageAccumulator();
  readonly operationId = randomUUID();
  readonly started = performance.now();
  errors = 0;
  private requests?: ExtractionDiagnostics;
  readonly requestObserver: LlmRequestObserver = {
    beginRequest: (stage) => {
      const metric = this.safe(() => {
        this.requests ??= new ExtractionDiagnostics();
        return this.requests.beginRequest(stage);
      });
      return {
        headers: () => this.safe(() => metric?.headers()),
        end: (...args) => this.safe(() => metric?.end(...args)),
      };
    },
  };
  safe<T>(body: () => T): T | undefined {
    try {
      return body();
    } catch {
      this.errors = Math.min(100, this.errors + 1);
      return undefined;
    }
  }
  snapshot(purpose: Purpose): NativeMemoryObservabilityV1 | undefined {
    return this.safe(() => {
      const requestData = this.requests
        ?.finish()
        .metrics?.stages.find((stage) => stage.stage === 'entities')?.requests;
      // The internal accumulator's extraction status and stage label are deliberately not exposed.
      const nativeRequests = requestData
        ? NativeMemoryObservabilityV1Schema.shape.native_requests
            .unwrap()
            .parse(
              Object.fromEntries(Object.entries(requestData).filter(([key]) => key !== 'retries')),
            )
        : null;
      return NativeMemoryObservabilityV1Schema.parse({
        version: 1,
        operation_id: this.operationId,
        purpose,
        elapsed_ms: Math.max(0, performance.now() - this.started),
        observer_errors: this.errors,
        native_requests: nativeRequests,
        storage: this.storage.snapshot(),
      });
    });
  }
}
const operations = new AsyncLocalStorage<OperationObserver>();

/** Structural request observer; its values never participate in native control flow. */
export function currentNativeRequestObserver(): LlmRequestObserver | undefined {
  return operations.getStore()?.requestObserver;
}

async function observeStorage<T>(
  storage: IGraphStorage,
  observer: OperationObserver,
  body: () => Promise<T>,
): Promise<T> {
  let pending: Promise<T> | undefined;
  // Even a broken optional diagnostic adapter must never cause a second invocation.
  const invoke = () => (pending ??= (async () => body())());
  try {
    const capability = storage.withExtractionDiagnostics;
    if (typeof capability === 'function') {
      await capability.call(
        storage,
        (sample) => observer.safe(() => observer.storage.observe(sample)),
        invoke,
      );
    }
  } catch (error) {
    if (!pending)
      observer.safe(() => {
        throw error;
      });
    else {
      try {
        await pending;
        observer.safe(() => {
          throw error;
        });
      } catch (nativeError) {
        if (nativeError !== error)
          observer.safe(() => {
            throw error;
          });
      }
    }
  }
  return invoke();
}

/** Own returned sidecar only; never writes into the native value or a shared last-result slot. */
export async function observeNativeOperation<T>(
  enabled: boolean,
  purpose: Purpose,
  storage: IGraphStorage,
  body: () => Promise<T>,
): Promise<{ value: T; diagnostics?: NativeMemoryObservabilityV1 }> {
  if (!enabled) return { value: await body() };
  let observer: OperationObserver;
  try {
    observer = new OperationObserver();
  } catch {
    return { value: await body() };
  }
  const value = await operations.run(observer, () => observeStorage(storage, observer, body));
  const diagnostics = observer.snapshot(purpose);
  return diagnostics ? { value, diagnostics } : { value };
}
