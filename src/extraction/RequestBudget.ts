import { performance } from 'perf_hooks';
import { ExtractionError } from './ExtractionDiagnostics';

/** One invocation, finite requests and deadline. No background lifetime. */
export class RequestBudget {
  readonly controller = new AbortController();
  private readonly expires: number;
  private timer: ReturnType<typeof setTimeout>;
  private calls = 0;
  private externalAbort = () => this.controller.abort();
  constructor(
    readonly maxCalls = 32,
    readonly deadlineMs = 30000,
    readonly maxRequestBytes = 256 * 1024,
    readonly maxResponseBytes = 256 * 1024,
    private externalSignal?: AbortSignal,
  ) {
    for (const value of [maxCalls, deadlineMs, maxRequestBytes, maxResponseBytes])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid extraction budget');
    if (externalSignal?.aborted) this.controller.abort();
    else externalSignal?.addEventListener('abort', this.externalAbort, { once: true });
    this.expires = performance.now() + deadlineMs;
    this.timer = setTimeout(() => this.controller.abort(), deadlineMs);
  }
  check(): void {
    if (this.externalSignal?.aborted) throw new ExtractionError('cancelled');
    if (this.controller.signal.aborted || performance.now() >= this.expires)
      throw new ExtractionError('budget_exhausted');
  }
  reserve(bytes: number): number {
    this.check();
    if (bytes > this.maxRequestBytes || this.calls >= this.maxCalls)
      throw new ExtractionError('budget_exhausted');
    this.calls++;
    return Math.max(1, this.expires - performance.now());
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.externalSignal?.removeEventListener('abort', this.externalAbort);
    this.controller.abort();
  }
}

/** Enforce the ceiling while consuming real HTTP bodies, before allocating an unbounded string. */
export async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers?.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ExtractionError('budget_exhausted');
  }
  if (!response.body) throw new ExtractionError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) throw new ExtractionError('budget_exhausted');
      chunks.push(item.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
