import { createHash, randomUUID } from 'crypto';
import {
  ExtractionJobSchema,
  QueueBackupSchema,
  type QueueBackup,
  type QueueStats,
  type QueueClearImpact,
  SourceOwnershipSchema,
  QueueCommandSchema,
  QueueLimitsSchema,
  StagedExtractionSchema,
  EntityNodeSchema,
  MemoryQualitySchema,
  type EntityNode,
  type EntityEdge,
  extractionMetadataFromAttributes,
  EntityEdgeSchema,
  type QueueBinding,
  type QueueCommand,
  type QueueResult,
  type QueueLimits,
  type ExtractionJob,
  type EpisodicNode,
  type GraphData,
  type StagedExtraction,
} from '../schemas';
import type { AppendEpisodeResult } from '../storage/IGraphStorage';
import { isDurableAssertion } from './AssertionEvidence';

export const QUEUE_ATTRIBUTE = 'engram_extraction_queue_v1';
const terminal = new Set(['completed', 'cancelled']);
const reserving = new Set(['pending', 'leased', 'staged', 'retry_wait', 'paused']);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function sourceFingerprint(source: EpisodicNode): string {
  const data = { ...source };
  delete (data as Partial<EpisodicNode>).updated_at;
  const attributes = data.attributes;
  const safeAttributes = { ...attributes };
  delete safeAttributes[QUEUE_ATTRIBUTE];
  return fingerprint({ ...data, attributes: safeAttributes });
}
export function graphFingerprint(graph: GraphData, group: string): string {
  return fingerprint({
    epoch: graph.metadata?.extraction_epoch ?? 'initial',
    entities: graph.entities
      .filter((e) => e.group_id === group)
      .sort((a, b) => a.uuid.localeCompare(b.uuid)),
    edges: graph.edges
      .filter((e) => e.group_id === group)
      .sort((a, b) => a.uuid.localeCompare(b.uuid)),
  });
}
export function ownership(episode: EpisodicNode) {
  const value = episode.attributes[QUEUE_ATTRIBUTE];
  return value === undefined ? null : SourceOwnershipSchema.parse(value);
}
export function jobs(graph: GraphData): ExtractionJob[] {
  const result = graph.episodes.flatMap((episode) => {
    const own = ownership(episode);
    if (
      own?.job &&
      (own.job.uuid !== own.owner_job_uuid ||
        own.job.group_id !== episode.group_id ||
        own.job.sources[0]?.uuid !== episode.uuid ||
        own.job.sources[0]?.hash !== own.source_hash)
    )
      throw new Error('Engram queue: invalid_owner');
    return own?.job ? [own.job] : [];
  });
  if (new Set(result.map((job) => job.uuid)).size !== result.length)
    throw new Error('Engram queue: duplicate_job');
  return result;
}
function ownerEpisode(graph: GraphData, job: ExtractionJob): EpisodicNode {
  const owner = graph.episodes.find(
    (episode) => episode.uuid === job.sources[0].uuid && episode.group_id === job.group_id,
  );
  if (!owner || ownership(owner)?.owner_job_uuid !== job.uuid)
    throw new Error('Engram queue: missing_owner');
  return owner;
}
function saveJob(graph: GraphData, job: ExtractionJob): void {
  const owner = ownerEpisode(graph, job);
  owner.attributes = {
    ...owner.attributes,
    [QUEUE_ATTRIBUTE]: { ...ownership(owner), job: ExtractionJobSchema.parse(job) },
  };
}
function validSources(graph: GraphData, job: ExtractionJob): boolean {
  return job.sources.every((source) => {
    const ep = graph.episodes.find((e) => e.uuid === source.uuid && e.group_id === job.group_id);
    return (
      ep &&
      sourceFingerprint(ep) === source.hash &&
      ownership(ep)?.owner_job_uuid === job.uuid &&
      ownership(ep)?.source_hash === source.hash
    );
  });
}
function usage(graph: GraphData, group: string): { bytes: number; total: number; active: number } {
  let bytes = 0,
    total = 0,
    active = 0;
  for (const ep of graph.episodes) {
    const own = ownership(ep);
    if (!own) continue;
    const actual = Buffer.byteLength(canonical(own));
    const reserved =
      own.job && reserving.has(own.job.state) ? Math.max(actual, own.job.reserved_bytes) : actual;
    const sourceBytes = Buffer.byteLength(
      canonical({ ...ep, attributes: { ...ep.attributes, [QUEUE_ATTRIBUTE]: undefined } }),
    );
    total += reserved + sourceBytes;
    if (ep.group_id === group) {
      bytes += reserved + sourceBytes;
      if (own.job && reserving.has(own.job.state)) active++;
    }
  }
  return { bytes, total, active };
}
export function enforceCapacity(graph: GraphData, group: string, limits: QueueLimits): void {
  const u = usage(graph, group);
  if (
    u.active > limits.max_jobs ||
    u.bytes > limits.max_namespace_bytes ||
    u.total > limits.max_store_bytes
  )
    throw new Error('Engram queue: capacity');
}
export function enqueue(
  graph: GraphData,
  results: AppendEpisodeResult[],
  eligible: number[],
  binding: QueueBinding,
  limits: QueueLimits,
  now: string,
  jobUuid: string = randomUUID(),
): ExtractionJob[] {
  const settings = QueueLimitsSchema.parse(limits);
  const group = results[0]?.episode.group_id;
  for (const job of jobs(graph)) {
    if (
      job.limits.max_store_bytes !== settings.max_store_bytes ||
      (job.group_id === group && canonical(job.limits) !== canonical(settings))
    )
      throw new Error('Engram queue: capacity_configuration');
  }
  const refs = new Map<string, ExtractionJob>();
  const selected: EpisodicNode[] = [];
  for (const index of [...new Set(eligible)]) {
    const result = results[index];
    if (!result) throw new Error('Engram queue: invalid_source_index');
    const ep = graph.episodes.find((e) => e.uuid === result.episode.uuid)!;
    const own = ownership(ep);
    if (own) {
      const job = jobs(graph).find((item) => item.uuid === own.owner_job_uuid);
      if (!job || sourceFingerprint(ep) !== own.source_hash)
        throw new Error('Engram queue: source_changed');
      refs.set(job.uuid, job);
    } else if (result.created) {
      if (
        !['active_human', 'passive_human', 'assistant_reply'].includes(ep.episode_kind) ||
        ep.attributes.engram_audit === true
      )
        throw new Error('Engram queue: invalid_source_kind');
      selected.push(ep);
    }
  }
  if (selected.length > 32) throw new Error('Engram queue: source_limit');
  if (selected.length) {
    const group = selected[0].group_id;
    if (selected.some((ep) => ep.group_id !== group)) throw new Error('Engram queue: mixed_groups');
    const job = ExtractionJobSchema.parse({
      version: 1,
      uuid: jobUuid,
      group_id: group,
      binding,
      limits: settings,
      sources: selected.map((ep) => ({ uuid: ep.uuid, hash: sourceFingerprint(ep) })),
      state: 'pending',
      created_at: now,
      updated_at: now,
      available_at: now,
    });
    for (const ep of selected)
      ep.attributes = {
        ...ep.attributes,
        [QUEUE_ATTRIBUTE]: {
          version: 1,
          owner_job_uuid: job.uuid,
          source_hash: sourceFingerprint(ep),
          ...(ep === selected[0] ? { job } : {}),
        },
      };
    enforceCapacity(graph, group, settings);
    refs.set(job.uuid, job);
  }
  return [...refs.values()];
}

function validatePlanSources(plan: StagedExtraction, job: ExtractionJob): void {
  const sorted = (items: Array<{ uuid: string; hash: string }>) =>
    canonical([...items].sort((a, b) => a.uuid.localeCompare(b.uuid)));
  if (sorted(plan.source_guards) !== sorted(job.sources))
    throw new Error('Engram queue: plan_source_mismatch');
}
export function applyPlan(graph: GraphData, input: StagedExtraction, queued = false): void {
  const plan = StagedExtractionSchema.parse(input);
  if (!queued && !plan.source_guards.length) throw new Error('Engram queue: unbound_plan');
  for (const guard of plan.source_guards) {
    const ep = graph.episodes.find(
      (item) => item.uuid === guard.uuid && item.group_id === plan.group_id,
    );
    if (!ep || sourceFingerprint(ep) !== guard.hash)
      throw new Error('Engram queue: source_changed');
    if (!queued && ownership(ep)) throw new Error('Engram queue: queued_source_requires_job');
  }
  if (graphFingerprint(graph, plan.group_id) !== plan.graph_hash)
    throw new Error('Engram queue: graph_changed');
  if (Buffer.byteLength(canonical(plan)) > 512 * 1024) throw new Error('Engram queue: plan_size');
  if (
    [...plan.entities, ...plan.edges].some(
      (item) => item.group_id !== plan.group_id || QUEUE_ATTRIBUTE in item.attributes,
    )
  )
    throw new Error('Engram queue: invalid_plan');
  const guards = new Set(plan.source_guards.map((guard) => guard.uuid));
  const validateReferences = (
    item: EntityNode | EntityEdge,
    isNew: boolean,
    extra: string[] = [],
  ) => {
    const meta = extractionMetadataFromAttributes(item.attributes);
    if (isNew && (!meta || meta.source !== 'llm'))
      throw new Error('Engram queue: missing_extraction_metadata');
    if (isNew && meta?.source === 'llm' && meta.review_status === 'accepted') {
      const quality = MemoryQualitySchema.safeParse(item.attributes.engram_memory_quality);
      if (
        !meta.episode_uuids.length ||
        !quality.success ||
        !quality.data.evidence.length ||
        !['durable_fact', 'preference'].includes(quality.data.category)
      )
        throw new Error('Engram queue: missing_accepted_evidence');
      const normalized = (value: string) =>
        value
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[.!]+$/, '');
      let supported = false;
      for (const span of quality.data.evidence) {
        const ep = graph.episodes.find(
          (source) => source.uuid === span.source_id && source.group_id === plan.group_id,
        );
        if (
          !ep ||
          !guards.has(ep.uuid) ||
          ep.role !== 'human' ||
          !['active_human', 'passive_human'].includes(ep.episode_kind) ||
          !['standard', 'trusted'].includes(ep.trust_level) ||
          ep.review_status !== 'accepted' ||
          ep.quoted_message_id ||
          span.end <= span.start ||
          span.end > ep.content.length ||
          !isDurableAssertion(ep.content, span.start, span.end)
        )
          throw new Error('Engram queue: invalid_accepted_evidence');
        const clause = normalized(ep.content.slice(span.start, span.end));
        if ('fact' in item) {
          if (clause === normalized(item.fact)) supported = true;
        } else {
          if (item.summary !== '') throw new Error('Engram queue: unsupported_summary');
          if (
            clause.includes(normalized(item.name)) ||
            normalized(ep.sender_name ?? '') === normalized(item.name)
          )
            supported = true;
        }
      }
      if (!supported) throw new Error('Engram queue: unsupported_claim');
    }
    const references = [...(meta?.episode_uuids ?? []), ...extra];
    for (const uuid of references) {
      const ep = graph.episodes.find(
        (source) => source.uuid === uuid && source.group_id === plan.group_id,
      );
      if (!ep || (isNew && !guards.has(uuid)))
        throw new Error('Engram queue: invalid_source_reference');
    }
    const quality = item.attributes.engram_memory_quality as
      | { evidence?: Array<{ source_id: string }> }
      | undefined;
    if (quality?.evidence?.some((span) => !guards.has(span.source_id)))
      throw new Error('Engram queue: invalid_source_reference');
  };
  const ids = new Set<string>();
  for (const entity of plan.entities) {
    EntityNodeSchema.parse(entity);
    if (
      graph.episodes.some((ep) => ep.uuid === entity.uuid) ||
      graph.edges.some((edge) => edge.uuid === entity.uuid)
    )
      throw new Error('Engram queue: cross_kind_id');
    if (ids.has(entity.uuid)) throw new Error('Engram queue: duplicate_plan_id');
    ids.add(entity.uuid);
    const other = [...graph.entities, ...graph.episodes].find((e) => e.uuid === entity.uuid);
    if (other && other.group_id !== plan.group_id) throw new Error('Engram queue: cross_group');
    const index = graph.entities.findIndex((e) => e.uuid === entity.uuid);
    if (index >= 0 && graph.entities[index].created_at !== entity.created_at)
      throw new Error('Engram queue: immutable_identity');
    if (index >= 0) {
      const review = extractionMetadataFromAttributes(graph.entities[index].attributes);
      if (
        review?.threshold_decision === 'manually_reviewed' &&
        canonical(graph.entities[index]) !== canonical(entity)
      )
        throw new Error('Engram queue: pinned_review');
    }
    validateReferences(entity, index < 0);
    if (index < 0) graph.entities.push(entity);
    else graph.entities[index] = entity;
  }
  for (const edge of plan.edges) {
    EntityEdgeSchema.parse(edge);
    if (
      graph.entities.some((entity) => entity.uuid === edge.uuid) ||
      graph.episodes.some((ep) => ep.uuid === edge.uuid)
    )
      throw new Error('Engram queue: cross_kind_id');
    if (ids.has(edge.uuid)) throw new Error('Engram queue: duplicate_plan_id');
    ids.add(edge.uuid);
    const source = graph.entities.find(
      (e) => e.uuid === edge.source_node_uuid && e.group_id === plan.group_id,
    );
    const target = graph.entities.find(
      (e) => e.uuid === edge.target_node_uuid && e.group_id === plan.group_id,
    );
    if (!source || !target) throw new Error('Engram queue: invalid_endpoint');
    const index = graph.edges.findIndex((e) => e.uuid === edge.uuid);
    if (index >= 0 && graph.edges[index].group_id !== plan.group_id)
      throw new Error('Engram queue: cross_group');
    if (
      index >= 0 &&
      (graph.edges[index].source_node_uuid !== edge.source_node_uuid ||
        graph.edges[index].target_node_uuid !== edge.target_node_uuid ||
        graph.edges[index].created_at !== edge.created_at)
    )
      throw new Error('Engram queue: immutable_identity');
    if (index >= 0) {
      const review = extractionMetadataFromAttributes(graph.edges[index].attributes);
      if (
        review?.threshold_decision === 'manually_reviewed' &&
        canonical(graph.edges[index]) !== canonical(edge)
      )
        throw new Error('Engram queue: pinned_review');
    }
    validateReferences(edge, index < 0, edge.episodes);
    if (index < 0) graph.edges.push(edge);
    else graph.edges[index] = edge;
  }
}
export function queueCommand(graph: GraphData, input: QueueCommand, now: string): QueueResult {
  const command = QueueCommandSchema.parse(input);
  const all = jobs(graph).filter((job) => job.group_id === command.group_id);
  let result: ExtractionJob | null = null;
  if (
    ['claim', 'renew', 'stage', 'commit'].includes(command.action) &&
    all.some((job) => !terminal.has(job.state) && job.updated_at > now)
  )
    throw new Error('Engram queue: clock_regression');
  if (command.action === 'claim') {
    result =
      all
        .filter(
          (job) =>
            canonical(job.binding) === canonical(command.binding) &&
            ((['pending', 'retry_wait'].includes(job.state) && job.available_at <= now) ||
              (['leased', 'staged'].includes(job.state) &&
                job.lease_expires_at !== null &&
                job.lease_expires_at <= now)),
        )
        .sort(
          (a, b) => a.available_at.localeCompare(b.available_at) || a.uuid.localeCompare(b.uuid),
        )[0] ?? null;
    if (result) {
      if (result.lease_expires_at) result.recoveries++;
      result.claims++;
      result.generation++;
      result.lease_token = randomUUID();
      result.lease_expires_at = new Date(Date.parse(now) + command.lease_ms).toISOString();
      if (!result.plan) {
        result.state = 'leased';
        result.processing_attempts++;
      } else result.state = 'staged';
      if (!validSources(graph, result)) {
        result.state = 'failed';
        result.last_error = 'source_changed';
        result.lease_token = null;
      } else if (
        result.processing_attempts > 5 * (1 + result.manual_retries) ||
        result.recoveries > 20
      ) {
        result.state = 'failed';
        result.last_error = 'budget';
        result.lease_token = null;
      }
      result.updated_at = now;
      saveJob(graph, result);
      if (result.state === 'failed') result = null;
    }
  } else if (command.action === 'control') {
    result = all.find((job) => job.uuid === command.job_uuid) ?? null;
    if (
      !result ||
      (terminal.has(result.state) && command.operation !== 'compact') ||
      result.reviews.length >= 20
    )
      throw new Error('Engram queue: invalid_control');
    const previousBinding = result.binding.config_hash;
    if (command.operation === 'rebind') {
      if (
        !command.binding ||
        !['pending', 'retry_wait', 'failed', 'paused'].includes(result.state) ||
        !validSources(graph, result) ||
        result.manual_retries >= 3
      )
        throw new Error('Engram queue: invalid_control');
      result.binding = command.binding;
      result.manual_retries++;
      result.plan = null;
      result.state = 'pending';
      result.available_at = now;
    } else if (command.operation === 'compact') {
      if (!terminal.has(result.state)) throw new Error('Engram queue: invalid_control');
      if (result.outcome) delete result.outcome.metrics;
    } else if (['resume', 'retry'].includes(command.operation)) {
      if (
        !command.binding ||
        canonical(command.binding) !== canonical(result.binding) ||
        !validSources(graph, result)
      )
        throw new Error('Engram queue: configuration');
      if (command.operation === 'resume' && result.state !== 'paused')
        throw new Error('Engram queue: invalid_control');
      if (
        command.operation === 'retry' &&
        (result.state !== 'failed' || result.manual_retries >= 3)
      )
        throw new Error('Engram queue: invalid_control');
      if (command.operation === 'retry') {
        result.manual_retries++;
        result.plan = null;
      }
      result.state = 'pending';
      result.available_at = now;
    } else {
      result.state = command.operation === 'pause' ? 'paused' : 'cancelled';
      if (result.state === 'cancelled') result.plan = null;
    }
    result.generation++;
    result.lease_token = null;
    result.lease_expires_at = null;
    result.updated_at = now;
    result.reviews.push({
      at: now,
      actor: command.actor,
      reason: command.reason,
      action: command.operation,
      ...(command.operation === 'rebind' ? { previous_config_hash: previousBinding } : {}),
    });
    saveJob(graph, result);
    enforceCapacity(graph, result.group_id, result.limits);
  } else if (command.action !== 'status') {
    result = all.find((job) => job.uuid === command.job_uuid) ?? null;
    if (!result) throw new Error('Engram queue: missing_job');
    if (command.action === 'commit' && result.state === 'completed') return summary(all, result);
    if (
      result.lease_token !== command.token ||
      result.generation !== command.generation ||
      !result.lease_expires_at ||
      now >= result.lease_expires_at ||
      !['leased', 'staged'].includes(result.state)
    )
      throw new Error('Engram queue: stale_lease');
    if (!validSources(graph, result)) throw new Error('Engram queue: source_changed');
    switch (command.action) {
      case 'renew':
        result.lease_expires_at = new Date(Date.parse(now) + command.lease_ms).toISOString();
        break;
      case 'stage':
        if (!command.plan || command.plan.group_id !== result.group_id)
          throw new Error('Engram queue: invalid_plan');
        if (Buffer.byteLength(canonical({ ...result, plan: command.plan })) > result.reserved_bytes)
          throw new Error('Engram queue: capacity');
        validatePlanSources(command.plan, result);
        result.plan = StagedExtractionSchema.parse(command.plan);
        result.state = 'staged';
        break;
      case 'commit': {
        if (!result.plan) throw new Error('Engram queue: not_staged');
        result.commit_attempts++;
        validatePlanSources(result.plan, result);
        applyPlan(graph, result.plan, true);
        result.outcome = result.plan.outcome;
        const persistence = result.outcome.stages.find((stage) => stage.stage === 'persistence')!;
        persistence.status = 'succeeded';
        delete persistence.reason;
        result.plan = null;
        result.state = 'completed';
        result.lease_token = null;
        result.lease_expires_at = null;
        break;
      }
      case 'fail':
        if (command.outcome) result.outcome = command.outcome;
        result.last_error = command.error ?? 'provider';
        result.state =
          command.retry &&
          result.processing_attempts < 5 * (1 + result.manual_retries) &&
          result.recoveries < 20
            ? 'retry_wait'
            : 'failed';
        result.available_at = new Date(
          Date.parse(now) +
            Math.min(
              900000,
              1000 * 2 ** result.processing_attempts +
                (parseInt(result.uuid.slice(0, 8), 16) % 500),
            ),
        ).toISOString();
        result.plan = null;
        result.lease_token = null;
        result.lease_expires_at = null;
        break;
      case 'cancel':
        result.state = 'cancelled';
        result.generation++;
        result.lease_token = null;
        result.plan = null;
        result.lease_expires_at = null;
        break;
    }
    result.updated_at = now;
    saveJob(graph, result);
    enforceCapacity(graph, result.group_id, result.limits);
  }
  return summary(all, result);
}
export function queueStats(graph: GraphData, group: string): QueueStats {
  const all = jobs(graph).filter((job) => job.group_id === group),
    pending = all.filter((job) => reserving.has(job.state));
  const failed = all.filter((job) => job.state === 'failed').length;
  return {
    pending: pending.length,
    failed,
    oldest_pending_at: pending.map((job) => job.created_at).sort()[0] ?? null,
    graph_fresh: pending.length === 0 && failed === 0,
  };
}
function summary(all: ExtractionJob[], job: ExtractionJob | null): QueueResult {
  const pending = all.filter((item) => !terminal.has(item.state) && item.state !== 'failed');
  return {
    job,
    pending: pending.length,
    failed: all.filter((item) => item.state === 'failed').length,
    oldest_pending_at: pending.map((item) => item.created_at).sort()[0] ?? null,
  };
}
export class QueueClearRequiresReview extends Error {
  constructor(readonly impact: QueueClearImpact) {
    super('Engram queue: clear_requires_review');
  }
}
export function queueClearImpact(
  episodes: Array<Pick<EpisodicNode, 'attributes'>>,
): QueueClearImpact {
  const sources = episodes.filter((ep) => ep.attributes[QUEUE_ATTRIBUTE] !== undefined);
  return {
    sources: sources.length,
    jobs: sources.filter((ep) => (ep.attributes[QUEUE_ATTRIBUTE] as { job?: unknown } | null)?.job)
      .length,
  };
}
export function assertQueueClear(
  episodes: Array<Pick<EpisodicNode, 'attributes'>>,
  reviewed = false,
): void {
  if (reviewed) return;
  const impact = queueClearImpact(episodes);
  if (impact.sources) throw new QueueClearRequiresReview(impact);
}
/** Generic maintenance cannot erase or reactivate extraction ownership. */
export function assertNoQueueMutation(episodes: EpisodicNode[]): void {
  if (episodes.some((ep) => ep.attributes[QUEUE_ATTRIBUTE] !== undefined))
    throw new Error('Engram queue: protected_source');
}

/** Explicit operational backup; source/job dependencies must be complete. */
export function exportQueueBackup(graph: GraphData): QueueBackup {
  validateQueueGraph(graph);
  const episodeIds = new Set(graph.episodes.map((ep) => ep.uuid));
  return {
    format: 'engram-extraction-backup',
    version: 1,
    graph,
    sha256: fingerprint(graph),
    warnings: {
      missing_fact_source_references: graph.edges.reduce(
        (count, edge) => count + edge.episodes.filter((uuid) => !episodeIds.has(uuid)).length,
        0,
      ),
      missing_chain_predecessors: graph.episodes.filter(
        (ep) => ep.previous_episode_uuid && !episodeIds.has(ep.previous_episode_uuid),
      ).length,
    },
  };
}
function validateQueueGraph(graph: GraphData): void {
  const ids = [...graph.entities, ...graph.edges, ...graph.episodes].map((item) => item.uuid);
  if (new Set(ids).size !== ids.length) throw new Error('Engram queue: duplicate_snapshot_id');
  if (
    graph.group_id &&
    [...graph.entities, ...graph.edges, ...graph.episodes].some(
      (item) => item.group_id !== graph.group_id,
    )
  )
    throw new Error('Engram queue: scoped_backup_mismatch');
  const entityMap = new Map(graph.entities.map((entity) => [entity.uuid, entity]));
  const episodeMap = new Map(graph.episodes.map((episode) => [episode.uuid, episode]));
  for (const edge of graph.edges) {
    if (
      entityMap.get(edge.source_node_uuid)?.group_id !== edge.group_id ||
      entityMap.get(edge.target_node_uuid)?.group_id !== edge.group_id ||
      edge.episodes.some(
        (uuid) => episodeMap.has(uuid) && episodeMap.get(uuid)!.group_id !== edge.group_id,
      )
    )
      throw new Error('Engram queue: incomplete_backup');
  }
  for (const ep of graph.episodes)
    if (
      ep.previous_episode_uuid &&
      episodeMap.has(ep.previous_episode_uuid) &&
      episodeMap.get(ep.previous_episode_uuid)!.group_id !== ep.group_id
    )
      throw new Error('Engram queue: incomplete_backup');
  for (const job of jobs(graph)) {
    if (!validSources(graph, job)) throw new Error('Engram queue: incomplete_backup');
    if (job.plan && job.plan.group_id !== job.group_id)
      throw new Error('Engram queue: invalid_plan');
  }
  for (const ep of graph.episodes) {
    const own = ownership(ep);
    if (
      own &&
      !jobs(graph).some(
        (job) =>
          job.uuid === own.owner_job_uuid && job.sources.some((source) => source.uuid === ep.uuid),
      )
    )
      throw new Error('Engram queue: incomplete_backup');
  }
}
export function prepareQueueImport(input: unknown, existing: GraphData, now: string): GraphData {
  const backup = QueueBackupSchema.parse(input);
  if (fingerprint(backup.graph) !== backup.sha256) throw new Error('Engram queue: backup_checksum');
  const graph = JSON.parse(JSON.stringify(backup.graph)) as GraphData;
  validateQueueGraph(graph);
  const existingIds = new Set(
    [...existing.entities, ...existing.edges, ...existing.episodes].map((item) => item.uuid),
  );
  if (
    [...graph.entities, ...graph.edges, ...graph.episodes].some((item) =>
      existingIds.has(item.uuid),
    )
  )
    throw new Error('Engram queue: import_collision');
  const combined = {
    ...existing,
    entities: [...existing.entities, ...graph.entities],
    edges: [...existing.edges, ...graph.edges],
    episodes: [...existing.episodes, ...graph.episodes],
  };
  jobs(combined);
  const logical = new Set<string>();
  for (const ep of combined.episodes) {
    const keys = [
      ...(ep.source_message_id
        ? [canonical([ep.group_id, ep.episode_kind, ep.source_message_id])]
        : []),
      ...(ep.idempotency_key ? [canonical([ep.group_id, ep.idempotency_key])] : []),
    ];
    for (const key of keys) {
      if (logical.has(key)) throw new Error('Engram queue: import_logical_collision');
      logical.add(key);
    }
  }
  for (const job of jobs(graph))
    if (!terminal.has(job.state) && job.state !== 'failed') {
      if (job.reviews.length >= 20) throw new Error('Engram queue: review_limit');
      job.state = 'paused';
      job.generation++;
      job.lease_token = null;
      job.lease_expires_at = null;
      job.updated_at = now;
      job.reviews.push({
        at: now,
        actor: 'backup-import',
        reason: 'Imported work requires explicit configuration review and resume',
        action: 'pause',
      });
      saveJob(graph, job);
    }
  for (const job of jobs(graph))
    enforceCapacity(
      {
        ...existing,
        entities: [...existing.entities, ...graph.entities],
        edges: [...existing.edges, ...graph.edges],
        episodes: [...existing.episodes, ...graph.episodes],
      },
      job.group_id,
      job.limits,
    );
  return graph;
}
