import { StorageAccumulator } from '../storage/StorageDiagnostics';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import {
  ExtractionStageSchema,
  ExtractionMetricContextSchema,
  type ExtractionMetricContext,
  type ExtractionStage,
  type ExtractionErrorKind,
  type ExtractionOutcome,
  type ExtractionMetrics,
  type ExtractionStageMetrics,
} from '../schemas';

/** Safe by construction: never retains the original provider body or error message. */
export class ExtractionError extends Error {
  constructor(
    public readonly kind: ExtractionErrorKind,
    public readonly httpStatus?: number,
  ) {
    super(`Engram extraction: ${kind}`);
    this.name = 'ExtractionError';
  }
}
export function safeExtractionError(error: unknown): ExtractionError {
  return error instanceof ExtractionError ? error : new ExtractionError('unknown');
}
export function reportExtractionError(
  stage: ExtractionStage,
  error: unknown,
  diagnostics?: ExtractionDiagnostics,
): void {
  const safe = safeExtractionError(error);
  const recorded = diagnostics?.error(stage, safe);
  if (recorded === false) return;
  // Stage names and classifications are fixed identifiers; no input/provider text.
  const labels: Record<ExtractionStage, string> = {
    entities: 'Entity extraction failed',
    relationships: 'Relationship extraction failed',
    entity_dedup: 'Entity deduplication failed',
    edge_dedup: 'Edge deduplication failed',
    cross_edge_dedup: 'Cross-name edge deduplication failed',
    contradictions: 'Contradiction detection failed',
    embeddings: 'Embedding generation failed',
    persistence: 'Extraction persistence failed',
  };
  // Bounded warning volume as well as bounded retained diagnostics.
  if (!diagnostics || diagnostics.errorCount <= 20)
    console.warn(`Engram: ${labels[stage]}:`, safe.message);
}

/** Owned by a single save invocation; never stored on a shared memory instance. */
export class ExtractionDiagnostics {
  private readonly storageTimings = new StorageAccumulator();
  observeStorage(observation: unknown): void {
    this.storageTimings.observe(observation);
  }
  private readonly started = performance.now();
  private readonly metrics: ExtractionMetrics = {
    version: 1,
    operation_id: randomUUID(),
    // Same relative path from src/extraction and dist/extraction.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    package_version: (require('../../package.json') as { version: string }).version,
    storage_breakdown: null,
    context: ExtractionMetricContextSchema.parse({}),
    stages: ExtractionStageSchema.options.map((stage) => ({
      stage,
      operations: 0,
      operation_failures: 0,
      elapsed_ms: 0,
      summed_operation_ms: 0,
      candidates: 0,
      exact_hits: 0,
      shortlisted: 0,
      pruned: 0,
      unresolved: 0,
      deferrals: { budget: 0, ambiguity: 0, unknown: 0 },
      requests: {
        attempted: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        in_flight: 0,
        retries: 0,
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
    })),
  };
  constructor(context: ExtractionMetricContext = {}) {
    this.metrics.context = ExtractionMetricContextSchema.parse(context);
  }
  private active = new Map<ExtractionStage, { count: number; start: number }>();

  /** Union of overlapping stage operations, separate from summed operation time. */
  begin(stage: ExtractionStage): (failed?: boolean) => void {
    const start = performance.now();
    const metric = this.stageMetric(stage);
    metric.operations++;
    const active = this.active.get(stage) ?? { count: 0, start };
    if (active.count++ === 0) active.start = start;
    this.active.set(stage, active);
    let ended = false;
    return (failed = false) => {
      if (ended) return;
      ended = true;
      const now = performance.now();
      metric.summed_operation_ms += Math.max(0, now - start);
      if (failed) metric.operation_failures++;
      if (--active.count === 0) metric.elapsed_ms += Math.max(0, now - active.start);
    };
  }

  stageMetric(stage: ExtractionStage): ExtractionStageMetrics {
    return this.metrics.stages.find((item) => item.stage === stage)!;
  }

  /** Never stores a prompt, response, URL, model-controlled error or source identity. */
  beginRequest(stage: ExtractionStage): {
    headers: () => void;
    end: (
      state: 'completed' | 'failed' | 'cancelled',
      usage?: unknown,
      embedding?: boolean,
    ) => void;
  } {
    const started = performance.now();
    const requests = this.stageMetric(stage).requests;
    requests.attempted++;
    requests.in_flight++;
    let headerTime: number | undefined;
    let ended = false;
    return {
      headers: () => {
        if (headerTime === undefined) headerTime = performance.now();
      },
      end: (state, usage, embedding = false) => {
        if (ended) return;
        ended = true;
        const now = performance.now();
        requests.in_flight--;
        requests[state]++;
        requests.summed_ms += Math.max(0, now - started);
        if (headerTime !== undefined) {
          requests.headers_ms = (requests.headers_ms ?? 0) + Math.max(0, headerTime - started);
          requests.body_ms = (requests.body_ms ?? 0) + Math.max(0, now - headerTime);
          requests.timing_samples++;
        }
        if (usage === undefined || usage === null) {
          requests.usage_missing++;
          return;
        }
        const data = usage as Record<string, unknown>;
        const input = data?.prompt_tokens;
        const output = embedding ? 0 : data?.completion_tokens;
        const total = data?.total_tokens;
        if (
          ![input, output, total].every(
            (value) => Number.isSafeInteger(value) && (value as number) >= 0,
          ) ||
          (total as number) !== (input as number) + (output as number) ||
          ![
            (requests.input_tokens ?? 0) + (input as number),
            (requests.output_tokens ?? 0) + (output as number),
            (requests.total_tokens ?? 0) + (total as number),
          ].every(Number.isSafeInteger)
        ) {
          requests.usage_invalid++;
          return;
        }
        requests.usage_valid++;
        requests.input_tokens = (requests.input_tokens ?? 0) + (input as number);
        requests.output_tokens = (requests.output_tokens ?? 0) + (output as number);
        requests.total_tokens = (requests.total_tokens ?? 0) + (total as number);
      },
    };
  }
  private readonly outcome: ExtractionOutcome = {
    status: 'succeeded',
    duration_ms: 0,
    counts: {
      entities_created: 0,
      entities_updated: 0,
      edges_created: 0,
      edges_updated: 0,
      edges_expired: 0,
      unchanged: 0,
      malformed: 0,
      filtered: 0,
    },
    stages: ExtractionStageSchema.options.map((stage) => ({
      stage,
      status: 'skipped',
      reason: 'not_reached',
    })),
    errors: [],
    error_count: 0,
    errors_truncated: false,
  };
  private readonly recordedErrors = new WeakSet<ExtractionError>();
  private requiredFailure = false;
  private optionalFailure = false;
  get errorCount(): number {
    return this.outcome.error_count;
  }
  increment(key: keyof ExtractionOutcome['counts']): void {
    this.outcome.counts[key]++;
  }
  hasFailed(stage: ExtractionStage): boolean {
    return this.outcome.stages.some((item) => item.stage === stage && item.status === 'failed');
  }
  success(stage: ExtractionStage): void {
    const item = this.outcome.stages.find((s) => s.stage === stage)!;
    if (item.status === 'skipped') {
      item.status = 'succeeded';
      delete item.reason;
    }
  }
  skip(stage: ExtractionStage): void {
    const item = this.outcome.stages.find((s) => s.stage === stage)!;
    if (item.status === 'skipped') item.reason = 'not_eligible';
  }
  defer(stage: ExtractionStage, reason: 'budget' | 'ambiguity' | 'unknown' = 'unknown'): void {
    this.stageMetric(stage).deferrals[reason]++;
    this.optionalFailure = true;
    const item = this.outcome.stages.find((s) => s.stage === stage)!;
    item.status = 'partial';
    delete item.reason;
  }
  malformed(stage: ExtractionStage): void {
    this.increment('malformed');
    this.optionalFailure = true;
    const item = this.outcome.stages.find((s) => s.stage === stage)!;
    item.status = 'partial';
    delete item.reason;
  }
  error(stage: ExtractionStage, error: ExtractionError): boolean {
    if (stage === 'entities' || stage === 'relationships' || stage === 'persistence')
      this.requiredFailure = true;
    else this.optionalFailure = true;
    const item = this.outcome.stages.find((s) => s.stage === stage)!;
    item.status = 'failed';
    delete item.reason;
    if (this.recordedErrors.has(error)) return false;
    this.recordedErrors.add(error);
    this.outcome.error_count++;
    if (this.outcome.errors.length < 20)
      this.outcome.errors.push({
        stage,
        kind: error.kind,
        ...(error.httpStatus ? { http_status: error.httpStatus } : {}),
      });
    else this.outcome.errors_truncated = true;
    return true;
  }
  finish(reason?: ExtractionOutcome['reason']): ExtractionOutcome {
    const cutoff = performance.now();
    const c = this.outcome.counts;
    const mutated =
      c.entities_created +
        c.entities_updated +
        c.edges_created +
        c.edges_updated +
        c.edges_expired >
      0;
    this.outcome.status =
      reason === 'disabled'
        ? 'disabled'
        : reason === 'no_sources'
          ? 'skipped'
          : reason === 'missing_configuration'
            ? 'failed'
            : this.requiredFailure
              ? mutated
                ? 'partial'
                : 'failed'
              : this.optionalFailure
                ? 'partial'
                : 'succeeded';
    if (reason) this.outcome.reason = reason;
    this.outcome.duration_ms = Math.max(0, cutoff - this.started);
    this.metrics.storage_breakdown = this.storageTimings.snapshot();
    this.outcome.metrics = this.metrics;
    // Account for spans that are still active at a diagnostic snapshot without closing them.
    const snapshot = JSON.parse(JSON.stringify(this.outcome)) as ExtractionOutcome;
    for (const [stage, active] of this.active) {
      if (active.count > 0)
        snapshot.metrics!.stages.find((item) => item.stage === stage)!.elapsed_ms += Math.max(
          0,
          cutoff - active.start,
        );
    }
    // Return a detached snapshot, rather than a live collector reference.
    return snapshot;
  }
}
