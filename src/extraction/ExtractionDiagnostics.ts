import {
  ExtractionStageSchema,
  type ExtractionStage,
  type ExtractionErrorKind,
  type ExtractionOutcome,
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
  private readonly started = Date.now();
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
    this.outcome.duration_ms = Math.max(0, Date.now() - this.started);
    // Return a detached snapshot, rather than a live collector reference.
    return JSON.parse(JSON.stringify(this.outcome)) as ExtractionOutcome;
  }
}
