import { StorageAccumulator } from '../storage/StorageDiagnostics';
import { performance } from 'perf_hooks';
import { setTimeout as delay } from 'timers/promises';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  ExtractionPolicySchema,
  WorkerTimingSchema,
  type WorkerTimingInput,
  type ExtractionPolicyInput,
  type ExtractionThresholdPolicy,
  type QueueBinding,
  type ExtractionJob,
  type ExtractionOutcome,
  type StagedExtraction,
} from '../schemas';
import { fingerprint } from './QueueState';
import { StagedGraph } from './StagedGraph';
import { boundedExtract } from './BoundedExtraction';
import type { LlmClientConfig } from './LlmClient';
import type { EmbeddingConfig } from '../embeddings';
import { ExtractionDiagnostics, ExtractionError } from './ExtractionDiagnostics';
import type { ExtractionSource } from './ExtractionSource';

export type ExtractionSettings = {
  llm: LlmClientConfig;
  embeddings?: EmbeddingConfig;
  policy?: ExtractionPolicyInput;
  types: string[];
  threshold?: ExtractionThresholdPolicy;
  signal?: AbortSignal;
  execution?: 'synchronous' | 'durable';
};
export function queueBinding(routeId: string, config: ExtractionSettings): QueueBinding {
  const safeRoute = (value: string) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Engram queue: secret_bearing_route');
    return url.toString().replace(/\/$/, '');
  };
  return {
    route_id: routeId,
    config_hash: fingerprint({
      endpoint: safeRoute(config.llm.baseUrl),
      model: config.llm.model,
      temperature: config.llm.temperature ?? { mode: 'legacy' },
      timeout: config.llm.timeoutMs ?? 30000,
      embeddings: config.embeddings
        ? {
            endpoint: safeRoute(config.embeddings.baseUrl),
            model: config.embeddings.model,
            dimensions: config.embeddings.dimensions ?? null,
          }
        : null,
      policy: ExtractionPolicySchema.parse(config.policy),
      types: config.types,
      threshold: config.threshold ?? null,
    }),
  };
}
export async function prepareExtraction(
  storage: IGraphStorage,
  group: string,
  sources: ExtractionSource[],
  config: ExtractionSettings,
): Promise<StagedExtraction> {
  if (!storage.readExtractionSnapshot)
    throw new Error('Engram extraction: atomic_storage_required');
  if (sources.length > 32) throw new ExtractionError('budget_exhausted');
  const started = performance.now();
  const policy = ExtractionPolicySchema.parse(config.policy);
  const diagnostics = new ExtractionDiagnostics({
    backend: storage.extractionBackend?.() ?? 'unknown',
    resolution: policy.mode,
    quality: policy.quality,
    execution: config.execution ?? 'unknown',
  });
  const endRead = diagnostics.begin('persistence');
  let readFailed = true;
  const snapshot = await (async () => {
    try {
      const result = await storage.readExtractionSnapshot!(group);
      readFailed = false;
      return result;
    } finally {
      endRead(readFailed);
    }
  })();
  let remaining = Math.floor(policy.deadline_ms - (performance.now() - started));
  if (config.signal?.aborted) throw new ExtractionError('cancelled');
  if (remaining <= 0) throw new ExtractionError('budget_exhausted');
  for (const source of sources) {
    const episode = snapshot.episodes.find((ep) => ep.uuid === source.episode_uuid);
    if (
      !episode ||
      episode.content !== source.content ||
      episode.role !== source.role ||
      episode.episode_kind !== source.episode_kind
    )
      throw new Error('Engram queue: source_changed');
  }
  const staged = new StagedGraph(
    snapshot,
    group,
    true,
    sources.map((source) => source.episode_uuid!),
  );
  if (!sources.some((source) => source.content.trim()))
    return staged.plan(diagnostics.finish('no_sources'));
  const capturedSources = sources.map((source) => {
    const ep = snapshot.episodes.find((episode) => episode.uuid === source.episode_uuid)!;
    return {
      content: ep.content,
      role: ep.role,
      episode_kind: ep.episode_kind,
      episode_uuid: ep.uuid,
      source_message_id: ep.source_message_id,
      quoted_message_id: ep.quoted_message_id,
      sender_id: ep.sender_id,
      sender_name: ep.sender_name,
      reference_time: ep.reference_time,
      trust_level: ep.trust_level,
      review_status: ep.review_status,
    };
  });
  remaining = Math.floor(policy.deadline_ms - (performance.now() - started));
  if (remaining <= 0) throw new ExtractionError('budget_exhausted');
  await boundedExtract(
    staged.storage,
    group,
    capturedSources,
    { ...config, deadlineMs: remaining },
    diagnostics,
  );
  const outcome = diagnostics.finish();
  outcome.duration_scope = 'preparation';
  return staged.plan(outcome);
}
async function runBoundedExtractionCore(
  storage: IGraphStorage,
  group: string,
  sources: ExtractionSource[],
  config: ExtractionSettings,
): Promise<ExtractionOutcome> {
  const started = performance.now();
  const plan = await prepareExtraction(storage, group, sources, {
    ...config,
    execution: 'synchronous',
  });
  if (!sources.some((source) => source.content.trim())) return plan.outcome;
  if (!storage.applyStagedExtraction) throw new Error('Engram extraction: atomic_storage_required');
  if (plan.outcome.status === 'failed' || plan.outcome.error_count > 0) {
    for (const key of [
      'entities_created',
      'entities_updated',
      'edges_created',
      'edges_updated',
      'edges_expired',
    ] as const)
      plan.outcome.counts[key] = 0;
    plan.outcome.status = 'failed';
    return plan.outcome;
  }
  const applyStarted = performance.now();
  let applyDispatched = false;
  try {
    if (config.signal?.aborted) throw new ExtractionError('cancelled');
    if (performance.now() - started >= ExtractionPolicySchema.parse(config.policy).deadline_ms)
      throw new ExtractionError('budget_exhausted');
    const metric = plan.outcome.metrics?.stages.find((item) => item.stage === 'persistence');
    if (metric) metric.operations++;
    applyDispatched = true;
    await storage.applyStagedExtraction(plan);
  } catch (error) {
    const outcome = plan.outcome;
    for (const key of [
      'entities_created',
      'entities_updated',
      'edges_created',
      'edges_updated',
      'edges_expired',
    ] as const)
      outcome.counts[key] = 0;
    const kind = error instanceof ExtractionError ? error.kind : 'storage';
    outcome.error_count++;
    if (outcome.errors.length < 20) outcome.errors.push({ stage: 'persistence', kind });
    else outcome.errors_truncated = true;
    outcome.status = 'failed';
    outcome.duration_ms = performance.now() - started;
    const metric = outcome.metrics?.stages.find((item) => item.stage === 'persistence');
    if (metric && applyDispatched) {
      metric.operation_failures++;
      metric.elapsed_ms += performance.now() - applyStarted;
      metric.summed_operation_ms += performance.now() - applyStarted;
    }
    outcome.duration_scope = 'end_to_end';
    const stage = outcome.stages.find((item) => item.stage === 'persistence')!;
    stage.status = 'failed';
    delete stage.reason;
    return outcome;
  }
  const outcome = plan.outcome;
  outcome.duration_scope = 'end_to_end';
  outcome.duration_ms = performance.now() - started;
  const metric = outcome.metrics?.stages.find((item) => item.stage === 'persistence');
  if (metric) {
    const elapsed = performance.now() - applyStarted;
    metric.elapsed_ms += elapsed;
    metric.summed_operation_ms += elapsed;
  }
  const stage = outcome.stages.find((item) => item.stage === 'persistence')!;
  stage.status = 'succeeded';
  delete stage.reason;
  return outcome;
}

export async function runBoundedExtraction(
  storage: IGraphStorage,
  group: string,
  sources: ExtractionSource[],
  config: ExtractionSettings,
): Promise<ExtractionOutcome> {
  const timing = new StorageAccumulator();
  const operation = () => runBoundedExtractionCore(storage, group, sources, config);
  const outcome = storage.withExtractionDiagnostics
    ? await storage.withExtractionDiagnostics((value) => timing.observe(value), operation)
    : await operation();
  if (outcome.metrics) outcome.metrics.storage_breakdown = timing.snapshot();
  return outcome;
}

/** Awaited bounded Admin worker. It owns no conversation send/retry side effects. */
export async function processExtractionJobs(
  storage: IGraphStorage,
  group: string,
  routeId: string,
  config: ExtractionSettings,
  maxJobs = 1,
  timingInput: WorkerTimingInput = {},
): Promise<Array<{ job_uuid: string; state: string; outcome?: ExtractionOutcome }>> {
  if (
    !storage.extractionQueueCommand ||
    !storage.readExtractionSnapshot ||
    !storage.supportsDurableExtraction?.()
  )
    throw new Error('Engram queue: unsupported_storage');
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 10)
    throw new Error('Engram queue: invalid_batch');
  const binding = queueBinding(routeId, config);
  const timing = WorkerTimingSchema.parse(timingInput);
  const results: Array<{ job_uuid: string; state: string; outcome?: ExtractionOutcome }> = [];
  for (let i = 0; i < maxJobs; i++) {
    const operationStarted = performance.now();
    const job = (
      await storage.extractionQueueCommand({
        action: 'claim',
        group_id: group,
        binding,
        lease_ms: timing.lease_ms,
      })
    ).job;
    if (!job) break;
    const lease = {
      group_id: group,
      job_uuid: job.uuid,
      token: job.lease_token!,
      generation: job.generation,
    };
    const heartbeat = new AbortController();
    const workAbort = new AbortController();
    let heartbeatFailed = false;
    const maintain = (async () => {
      try {
        while (!heartbeat.signal.aborted) {
          await delay(timing.heartbeat_ms, undefined, { signal: heartbeat.signal });
          await storage.extractionQueueCommand!({
            action: 'renew',
            ...lease,
            lease_ms: timing.lease_ms,
          });
        }
      } catch {
        if (!heartbeat.signal.aborted) {
          heartbeatFailed = true;
          workAbort.abort();
        }
      }
    })();
    try {
      let plan = job.plan;
      if (!plan) {
        const snapshot = await storage.readExtractionSnapshot(group);
        const sources = job.sources.map((source) => {
          const ep = snapshot.episodes.find((episode) => episode.uuid === source.uuid);
          if (!ep) throw new Error('Engram queue: source_changed');
          const rest = { ...ep };
          rest.attributes = {};
          return { ...rest, episode_uuid: ep.uuid };
        });
        plan = await prepareExtraction(storage, group, sources, {
          ...config,
          signal: workAbort.signal,
          execution: 'durable',
        });
        if (heartbeatFailed) throw new Error('Engram queue: stale_lease');
        if (plan.outcome.status === 'failed' || plan.outcome.error_count > 0) {
          for (const key of [
            'entities_created',
            'entities_updated',
            'edges_created',
            'edges_updated',
            'edges_expired',
          ] as const)
            plan.outcome.counts[key] = 0;
          plan.outcome.status = 'failed';
          const retry = plan.outcome.errors.every((error) =>
            ['timeout', 'network', 'rate_limit', 'provider_server'].includes(error.kind),
          );
          const failed = await storage.extractionQueueCommand({
            action: 'fail',
            ...lease,
            error: 'provider',
            retry,
            outcome: plan.outcome,
          });
          results.push({ job_uuid: job.uuid, state: failed.job!.state, outcome: plan.outcome });
          continue;
        }
        if (heartbeatFailed) throw new Error('Engram queue: stale_lease');
        await storage.extractionQueueCommand({ action: 'stage', ...lease, plan });
      }
      if (heartbeatFailed) throw new Error('Engram queue: stale_lease');
      const commitStarted = performance.now();
      const timing = new StorageAccumulator();
      const commit = () => storage.extractionQueueCommand!({ action: 'commit', ...lease });
      const done = storage.withExtractionDiagnostics
        ? await storage.withExtractionDiagnostics((value) => timing.observe(value), commit)
        : await commit();
      if (done.job?.outcome) {
        if (done.job.outcome.metrics)
          done.job.outcome.metrics.storage_breakdown = timing.snapshot();
        done.job.outcome.duration_scope = 'end_to_end';
        done.job.outcome.duration_ms = performance.now() - operationStarted;
        const metric = done.job.outcome.metrics?.stages.find(
          (item) => item.stage === 'persistence',
        );
        if (metric) {
          metric.operations++;
          const elapsed = performance.now() - commitStarted;
          metric.elapsed_ms += elapsed;
          metric.summed_operation_ms += elapsed;
        }
      }
      results.push({
        job_uuid: job.uuid,
        state: done.job!.state,
        ...(done.job!.outcome ? { outcome: done.job!.outcome } : {}),
      });
    } catch (error) {
      const conflict = error instanceof Error && error.message === 'Engram queue: graph_changed';
      const message = error instanceof Error ? error.message : '';
      const code = (error as { code?: unknown } | null)?.code;
      const transient =
        (typeof code === 'string' &&
          (code.startsWith('Neo.TransientError.') ||
            ['EAGAIN', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET'].includes(code))) ||
        ['Engram queue: stale_lease', 'Engram queue: concurrent_snapshot'].includes(message);
      try {
        const failed = await storage.extractionQueueCommand({
          action: 'fail',
          ...lease,
          error: conflict
            ? 'graph_changed'
            : message.includes('source_changed')
              ? 'source_changed'
              : /capacity|plan_size/.test(message)
                ? 'capacity'
                : error instanceof ExtractionError &&
                    ['budget_exhausted', 'cancelled'].includes(error.kind)
                  ? 'budget'
                  : /invalid|mismatch|unsupported|pinned|evidence|configuration/.test(message)
                    ? 'configuration'
                    : 'storage',
          retry: conflict || transient,
        });
        results.push({ job_uuid: job.uuid, state: failed.job!.state });
      } catch {
        // May be a committed application with lost acknowledgement, or a stale lease. Reconcile by job ID.
        const snapshot = await storage.readExtractionSnapshot(group);
        const owner = snapshot.episodes.find((ep) => ep.uuid === job.sources[0].uuid);
        const stored = owner?.attributes.engram_extraction_queue_v1 as
          | { job?: ExtractionJob }
          | undefined;
        results.push({
          job_uuid: job.uuid,
          state: stored?.job?.state === 'completed' ? 'completed' : 'unconfirmed',
        });
      }
    } finally {
      heartbeat.abort();
      await maintain;
    }
  }
  return results;
}
