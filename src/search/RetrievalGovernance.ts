import type {
  EntityEdge,
  EpisodeKind,
  EpisodeReviewStatus,
  EpisodeTrustLevel,
  EpisodicNode,
} from '../schemas';
import { types as utilTypes } from 'util';
import { extractionMetadataFromAttributes } from '../schemas';
import { AutomaticClaimMetadataSchema } from '../schemas/AutomaticClaim.schema';
import { CompositionalAutomaticClaimMetadataV2Schema } from '../schemas/CompositionalAutomaticMemory.schema';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import type { PrivateAutonomousPersonalMemoryParentReaderV4 } from '../memory/AutonomousPersonalMemoryParentReaderV4';
import { getAutonomousPersonalMemoryParentReadStopV4 } from '../memory/AutonomousPersonalMemoryParentReaderV4';
import type { EdgeSearchResult, EntitySearchResult, IGraphStorage } from '../storage/IGraphStorage';
import {
  automaticClaimVisible,
  automaticClaimVisibleForCompositionalRuntimeV3,
} from './AutomaticRetrieval';
import type { CompositionalRuntimeReaderV3 } from '../schemas/CompositionalRuntimeReaderV3.schema';
import {
  getCompositionalRuntimeAutomaticReadContextV3,
  isCompositionalCompatibilityRuntimeReaderV4,
  isLiveCompositionalRuntimeReaderV3,
  getCompositionalRuntimeLiteralDataV3,
} from './CompositionalRuntimeReaderV3';
import {
  governCompositionalRuntimeEdgesV3,
  snapshotCompositionalRuntimeFiltersV3,
} from './CompositionalRuntimeSearchV3';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { CompositionalRuntimeSearchHitV3Schema } from '../schemas/CompositionalRuntimeSearchV3.schema';
import type { AutomaticReadContext } from '../schemas/AutomaticRuntime.schema';
import { getAutonomousPersonalMemoryParentNamespaceGraphV4 } from '../memory/AutonomousPersonalMemoryParentReaderV4';
import { StagedGraph } from '../extraction/StagedGraph';
import {
  governAutonomousPersonalRuntimeEdgesV4,
  ownAutonomousPersonalRuntimeRankedHitsV4,
} from './AutonomousPersonalRuntimeSearchV4';

type CompatibilityViewInput = {
  readonly view: { readonly mode: 'current' | 'historical' | 'asOf'; readonly at?: string };
  readonly sourceBudget?: unknown;
  readonly conflictBudget?: unknown;
  readonly hasAutomaticContext: boolean;
};

function compatibilityViewInput(value: unknown): CompatibilityViewInput | null {
  if (value === undefined) return { view: { mode: 'current' }, hasAutomaticContext: false };
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < 2 ||
      keys.length > 4 ||
      keys.some((key) => !['mode', 'at', 'sources', 'conflicts'].includes(String(key)))
    )
      return null;
    const data = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      data.set(key, descriptor.value);
    }
    if (!data.has('sources') || !data.has('conflicts')) return null;
    const suppliedMode = data.get('mode');
    const suppliedAt = data.get('at');
    const view: { mode: 'current' | 'historical' | 'asOf'; at?: string } = {
      mode:
        suppliedMode === undefined
          ? 'current'
          : (suppliedMode as 'current' | 'historical' | 'asOf'),
    };
    if (suppliedAt !== undefined) view.at = suppliedAt as string;
    return {
      view,
      sourceBudget: data.get('sources'),
      conflictBudget: data.get('conflicts'),
      hasAutomaticContext: true,
    };
  } catch {
    return null;
  }
}

export interface RetrievalFilters {
  sender_id?: string;
  episode_kind?: EpisodeKind;
  trust_level?: EpisodeTrustLevel;
  source_workflow_id?: string;
  source_execution_id?: string;
  reference_after?: string;
  reference_before?: string;
  review_statuses?: EpisodeReviewStatus[];
}

export interface FactProvenance {
  source_episode_uuid: string | null;
  source_message_id: string | null;
  conversation_id: string | null;
  speaker_role: 'human' | 'ai' | 'system' | null;
  sender_id: string | null;
  sender_name: string | null;
  episode_kind: EpisodeKind | null;
  reference_time: string | null;
  trust_level: EpisodeTrustLevel | null;
  episode_review_status: EpisodeReviewStatus | null;
  source_workflow_id: string | null;
  source_execution_id: string | null;
  fact_confidence: number | null;
  fact_review_status: EpisodeReviewStatus;
  creation_review_status?: 'accepted' | 'proposed';
  creation_operation_uuid?: string;
  creation_committed_at?: string;
}

export interface GovernedEdgeSearchResult extends EdgeSearchResult {
  provenance?: FactProvenance[];
}

export interface RetrievalCandidateDecision {
  candidate_id: string;
  candidate_type: 'entity' | 'fact';
  score: number;
  included: boolean;
  reasons: string[];
}

export interface GovernedResult<T> {
  results: T[];
  decisions: RetrievalCandidateDecision[];
}

type AutonomousPersonalGovernanceBindingV4 = Readonly<{
  owner: IGraphStorage;
  parentReader: PrivateAutonomousPersonalMemoryParentReaderV4;
  compatibilityReader: CompositionalRuntimeReaderV3;
  namespace: string;
  storage: IGraphStorage;
}>;

export type AutonomousPersonalGovernanceRouteV4 = Readonly<{
  namespace: string;
  governance: RetrievalGovernance;
  storage: IGraphStorage;
}>;

const autonomousPersonalGovernanceBindingsV4 = new WeakMap<
  object,
  AutonomousPersonalGovernanceBindingV4
>();
const autonomousPersonalGovernanceRoutesV4 = new WeakMap<
  object,
  WeakMap<object, AutonomousPersonalGovernanceRouteV4>
>();

export class RetrievalGovernance {
  constructor(private storage: IGraphStorage) {}

  /**
   * Creates the only V4-native governance instance. Its storage facade is a read-only
   * namespace projection of the exact live ParentReader, never the backend itself.
   */
  static forAutonomousPersonalMemoryV4(
    owner: IGraphStorage,
    parentReader: PrivateAutonomousPersonalMemoryParentReaderV4,
    compatibilityReader: CompositionalRuntimeReaderV3,
  ): AutonomousPersonalGovernanceRouteV4 | null {
    if (
      !isCompositionalCompatibilityRuntimeReaderV4(owner, parentReader, compatibilityReader) ||
      getAutonomousPersonalMemoryParentReadStopV4(owner, parentReader) !== null
    )
      return null;

    let byCompatibility = autonomousPersonalGovernanceRoutesV4.get(parentReader);
    const existing = byCompatibility?.get(compatibilityReader);
    if (existing) return existing;

    const graph = getAutonomousPersonalMemoryParentNamespaceGraphV4(owner, parentReader);
    if (
      !graph ||
      typeof graph.group_id !== 'string' ||
      graph.group_id.length === 0 ||
      !isCompositionalCompatibilityRuntimeReaderV4(owner, parentReader, compatibilityReader) ||
      getAutonomousPersonalMemoryParentReadStopV4(owner, parentReader) !== null
    )
      return null;

    let storage: IGraphStorage;
    try {
      storage = new StagedGraph(graph, graph.group_id, false).storage;
    } catch {
      // A trusted callback failure remains sticky and escapes with its original identity.
      if (!isCompositionalCompatibilityRuntimeReaderV4(owner, parentReader, compatibilityReader))
        return null;
      if (getAutonomousPersonalMemoryParentReadStopV4(owner, parentReader) !== null) return null;
      return null;
    }
    if (
      !isCompositionalCompatibilityRuntimeReaderV4(owner, parentReader, compatibilityReader) ||
      getAutonomousPersonalMemoryParentReadStopV4(owner, parentReader) !== null
    )
      return null;

    const governance = new RetrievalGovernance(storage);
    autonomousPersonalGovernanceBindingsV4.set(
      governance,
      Object.freeze({
        owner,
        parentReader,
        compatibilityReader,
        namespace: graph.group_id,
        storage,
      }),
    );
    if (!byCompatibility) {
      byCompatibility = new WeakMap();
      autonomousPersonalGovernanceRoutesV4.set(parentReader, byCompatibility);
    }
    const route = Object.freeze({ namespace: graph.group_id, governance, storage });
    byCompatibility.set(compatibilityReader, route);
    return route;
  }

  async governEntities(
    results: EntitySearchResult[],
    filters: RetrievalFilters = {},
    budget?: SourceHydrationBudget,
  ): Promise<EntitySearchResult[]> {
    return (await this.governEntitiesWithDecisions(results, filters, budget)).results;
  }

  async governEntitiesWithDecisions(
    results: EntitySearchResult[],
    filters: RetrievalFilters = {},
    budget?: SourceHydrationBudget,
  ): Promise<GovernedResult<EntitySearchResult>> {
    results = this.boundReferences(
      results,
      (result) => this.referenceCount(result.entity.attributes),
      budget,
    );
    const metadataByEntity = new Map(
      results.map((result) => [
        result.entity.uuid,
        extractionMetadataFromAttributes(result.entity.attributes),
      ]),
    );
    const episodeUuids = [
      ...new Set(
        [...metadataByEntity.values()].flatMap((metadata) => metadata?.episode_uuids ?? []),
      ),
    ];
    const episodes = await this.storage.getEpisodes(episodeUuids);
    const episodesByUuid = new Map(episodes.map((episode) => [episode.uuid, episode]));

    const governed: EntitySearchResult[] = [];
    const decisions: RetrievalCandidateDecision[] = [];
    for (const result of results) {
      if (Object.prototype.hasOwnProperty.call(result.entity.attributes, 'engram_literal_v1')) {
        decisions.push(
          this.decision(result.entity.uuid, 'entity', result.score, false, 'attributed_value_only'),
        );
        continue;
      }
      const metadata = metadataByEntity.get(result.entity.uuid) ?? null;
      const reviewStatus = metadata?.review_status ?? 'accepted';
      if (filters.review_statuses?.length && !filters.review_statuses.includes(reviewStatus)) {
        decisions.push(
          this.decision(
            result.entity.uuid,
            'entity',
            result.score,
            false,
            'review_status_filtered',
          ),
        );
        continue;
      }
      if (!this.hasEpisodeFilters(filters)) {
        governed.push(result);
        decisions.push(this.decision(result.entity.uuid, 'entity', result.score, true, 'included'));
        continue;
      }
      const sourceEpisodeUuids = metadata?.episode_uuids ?? [];
      const sourceEpisodes = sourceEpisodeUuids
        .map((uuid) => episodesByUuid.get(uuid))
        .filter((episode): episode is EpisodicNode => episode !== undefined);
      if (sourceEpisodes.some((episode) => this.matchesEpisode(episode, filters))) {
        governed.push(result);
        decisions.push(this.decision(result.entity.uuid, 'entity', result.score, true, 'included'));
      } else {
        const reason =
          sourceEpisodes.length === 0
            ? 'source_episode_missing'
            : 'no_source_episode_matched_filters';
        decisions.push(this.decision(result.entity.uuid, 'entity', result.score, false, reason));
      }
    }
    return { results: governed, decisions };
  }

  async governEdges(
    results: EdgeSearchResult[],
    filters: RetrievalFilters = {},
    budget?: SourceHydrationBudget,
    automatic?: AutomaticReadContext,
    compositionalReader?: CompositionalRuntimeReaderV3,
  ): Promise<GovernedEdgeSearchResult[]> {
    return (
      await this.governEdgesWithDecisions(
        results,
        filters,
        budget,
        automatic,
        ...(compositionalReader === undefined ? ([] as const) : ([compositionalReader] as const)),
      )
    ).results;
  }

  async governEdgesWithDecisions(
    results: EdgeSearchResult[],
    filters: RetrievalFilters = {},
    budget?: SourceHydrationBudget,
    automatic?: AutomaticReadContext,
    compositionalReader?: CompositionalRuntimeReaderV3,
  ): Promise<GovernedResult<GovernedEdgeSearchResult>> {
    if (compositionalReader !== undefined)
      return this.governRuntimeEdges(compositionalReader, results, filters, budget, automatic);
    const automaticBudget = automatic?.sources ?? budget ?? { remaining: 512, deferred: 0 };
    const automaticScans = automatic?.conflicts ?? { remaining: 128 };
    results = this.boundReferences(
      results,
      (result) => result.edge.episodes.length + this.referenceCount(result.edge.attributes),
      budget,
    );
    const episodeUuids = [
      ...new Set(results.flatMap((result) => this.edgeEpisodeUuids(result.edge))),
    ];
    const episodes = await this.storage.getEpisodes(episodeUuids);
    const episodesByUuid = new Map(episodes.map((episode) => [episode.uuid, episode]));
    const governed: GovernedEdgeSearchResult[] = [];
    const decisions: RetrievalCandidateDecision[] = [];

    for (const result of results) {
      const automaticView = await automaticClaimVisible(
        this.storage,
        result.edge,
        automaticBudget,
        automaticScans,
        automatic,
      );
      if (automaticView === 'hidden') {
        decisions.push(
          this.decision(result.edge.uuid, 'fact', result.score, false, 'automatic_claim_authority'),
        );
        continue;
      }
      const factMetadata = extractionMetadataFromAttributes(result.edge.attributes);
      const factReviewStatus = factMetadata?.review_status ?? 'accepted';
      if (filters.review_statuses?.length && !filters.review_statuses.includes(factReviewStatus)) {
        decisions.push(
          this.decision(result.edge.uuid, 'fact', result.score, false, 'review_status_filtered'),
        );
        continue;
      }

      const sourceEpisodes = this.edgeEpisodeUuids(result.edge)
        .map((uuid) => episodesByUuid.get(uuid))
        .filter((episode): episode is EpisodicNode => episode !== undefined);
      const matchingEpisodes = sourceEpisodes.filter((episode) =>
        this.matchesEpisode(episode, filters),
      );
      if (this.hasEpisodeFilters(filters) && matchingEpisodes.length === 0) {
        const reason =
          sourceEpisodes.length === 0
            ? 'source_episode_missing'
            : 'no_source_episode_matched_filters';
        decisions.push(this.decision(result.edge.uuid, 'fact', result.score, false, reason));
        continue;
      }

      const provenance =
        matchingEpisodes.length > 0
          ? matchingEpisodes.map((episode) =>
              this.episodeProvenance(episode, factMetadata?.confidence ?? null, factReviewStatus),
            )
          : [this.unknownProvenance(factMetadata?.confidence ?? null, factReviewStatus)];
      governed.push({
        ...result,
        provenance,
        ...(automaticView === 'historical_record'
          ? {
              edge: {
                ...result.edge,
                fact:
                  result.edge.fact +
                  ` [Historical recorded preference; recorded review=${factReviewStatus}; current identity and validity not established; not current personalization]`,
              },
            }
          : {}),
      });
      decisions.push(this.decision(result.edge.uuid, 'fact', result.score, true, 'included'));
    }
    return { results: governed, decisions };
  }

  /**
   * Fixed retrieval over a live V4 ParentReader and its exact legacy-compatibility reader.
   * Claim3 is governed by its private display path; older families retain the existing V3
   * compatibility behavior and the same source/conflict counters.
   */
  async governAutonomousPersonalMemoryEdgesV4(
    storageOwner: IGraphStorage,
    parentReader: PrivateAutonomousPersonalMemoryParentReaderV4,
    compatibilityReader: CompositionalRuntimeReaderV3,
    rankedHits: unknown,
    filters: RetrievalFilters = {},
    budget?: SourceHydrationBudget,
    automatic?: AutomaticReadContext,
  ): Promise<GovernedResult<GovernedEdgeSearchResult>> {
    const empty: GovernedResult<GovernedEdgeSearchResult> = { results: [], decisions: [] };
    const binding = autonomousPersonalGovernanceBindingsV4.get(this);
    if (
      !binding ||
      binding.owner !== storageOwner ||
      binding.parentReader !== parentReader ||
      binding.compatibilityReader !== compatibilityReader ||
      binding.storage !== this.storage
    )
      return empty;
    const live = () =>
      isCompositionalCompatibilityRuntimeReaderV4(
        storageOwner,
        parentReader,
        compatibilityReader,
      ) && getAutonomousPersonalMemoryParentReadStopV4(storageOwner, parentReader) === null;
    if (!live()) return empty;

    const automaticInput = compatibilityViewInput(automatic);
    if (!automaticInput) {
      live();
      return empty;
    }
    const sharedAutomatic = getCompositionalRuntimeAutomaticReadContextV3(
      compatibilityReader,
      automaticInput.view,
    );
    if (!live()) return empty;
    if (
      sharedAutomatic === null ||
      (automaticInput.hasAutomaticContext &&
        (automaticInput.sourceBudget !== sharedAutomatic.sources ||
          automaticInput.conflictBudget !== sharedAutomatic.conflicts)) ||
      (budget !== undefined && budget !== sharedAutomatic.sources)
    ) {
      return empty;
    }

    const ownedFilters = snapshotCompositionalRuntimeFiltersV3(compatibilityReader, filters);
    if (!ownedFilters || !live()) return empty;
    const intake = ownAutonomousPersonalRuntimeRankedHitsV4(
      storageOwner,
      parentReader,
      compatibilityReader,
      rankedHits,
    );
    if (!intake || !live()) return empty;

    type HitFamily = 'claim3' | 'legacy' | 'unknown';
    const uniqueHits: Array<{ hit: EdgeSearchResult; family: HitFamily }> = [];
    const seenIds = new Set<string>();
    const claimHits: EdgeSearchResult[] = [];
    const legacyHits: EdgeSearchResult[] = [];
    const unknownDecisions: RetrievalCandidateDecision[] = [];
    for (const { hit } of intake) {
      if (!live()) return empty;
      const id = hit.edge.uuid;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const metadata = hit.edge.attributes.engram_claim_v1;
      let family: HitFamily;
      if (metadata === undefined) {
        family = 'legacy';
      } else if (
        metadata !== null &&
        typeof metadata === 'object' &&
        !Array.isArray(metadata) &&
        (metadata as { version?: unknown }).version === 3
      ) {
        // Even malformed V3 tags remain in Claim3 governance and cannot become ordinary facts.
        family = 'claim3';
      } else if (AutomaticClaimMetadataSchema.safeParse(metadata).success) {
        family = 'legacy';
      } else if (CompositionalAutomaticClaimMetadataV2Schema.safeParse(metadata).success) {
        family = 'legacy';
      } else {
        family = 'unknown';
        unknownDecisions.push(
          this.decision(id, 'fact', hit.score, false, 'automatic_claim_authority'),
        );
      }
      uniqueHits.push({ hit, family });
      if (family === 'claim3') claimHits.push(hit);
      else if (family === 'legacy') legacyHits.push(hit);
    }

    const claimResult = claimHits.length
      ? governAutonomousPersonalRuntimeEdgesV4(
          storageOwner,
          parentReader,
          compatibilityReader,
          claimHits,
          ownedFilters,
          automaticInput.view,
        )
      : { results: [], decisions: [] };
    if (!live()) return empty;

    const legacyResult = legacyHits.length
      ? await this.governRuntimeEdges(
          compatibilityReader,
          legacyHits,
          ownedFilters,
          sharedAutomatic.sources,
          sharedAutomatic,
        )
      : { results: [], decisions: [] };
    // Awaited legacy governance must still belong to the original Parent and runtime lifetime.
    if (!live()) return empty;

    const decisionsById = new Map<string, RetrievalCandidateDecision>();
    const resultsById = new Map<string, GovernedEdgeSearchResult>();
    for (const item of [...claimResult.decisions, ...legacyResult.decisions, ...unknownDecisions]) {
      if (decisionsById.has(item.candidate_id)) return empty;
      decisionsById.set(item.candidate_id, item);
    }
    for (const item of [...claimResult.results, ...legacyResult.results]) {
      if (resultsById.has(item.edge.uuid)) return empty;
      resultsById.set(item.edge.uuid, item);
    }

    const results: GovernedEdgeSearchResult[] = [];
    const decisions: RetrievalCandidateDecision[] = [];
    for (const { hit } of uniqueHits) {
      if (!live()) return empty;
      const item = decisionsById.get(hit.edge.uuid);
      if (!item) return empty;
      const result = resultsById.get(hit.edge.uuid);
      if (item.included) {
        if (!result) return empty;
        // Keep the exact registered Claim3 object; the private display registry is identity-bound.
        results.push(result);
      } else if (result) {
        return empty;
      }
      decisions.push(item);
    }
    if (!live()) return empty;
    return { results, decisions };
  }

  private async governRuntimeEdges(
    reader: CompositionalRuntimeReaderV3,
    raw: EdgeSearchResult[],
    rawFilters: RetrievalFilters,
    budget?: SourceHydrationBudget,
    automatic?: AutomaticReadContext,
  ): Promise<GovernedResult<GovernedEdgeSearchResult>> {
    const empty = { results: [], decisions: [] };
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
    const ownedFilters = snapshotCompositionalRuntimeFiltersV3(reader, rawFilters);
    if (ownedFilters === null) return empty;
    const view: Record<string, unknown> = { mode: 'current' };
    if (automatic !== undefined) {
      if (!automatic || typeof automatic !== 'object' || utilTypes.isProxy(automatic)) return empty;
      try {
        for (const key of ['mode', 'at']) {
          const descriptor = Object.getOwnPropertyDescriptor(automatic, key);
          if (!descriptor) continue;
          if (!('value' in descriptor)) return empty;
          if (descriptor.value !== undefined) view[key] = descriptor.value;
        }
      } catch {
        return empty;
      }
    }
    const sharedAutomatic = getCompositionalRuntimeAutomaticReadContextV3(reader, view);
    if (sharedAutomatic === null) return empty;
    automatic = sharedAutomatic;
    budget = sharedAutomatic.sources;
    let results: EdgeSearchResult[], filters: RetrievalFilters;
    try {
      const owned = cloneBoundedAutomaticCaptureJson<{
        results: EdgeSearchResult[];
        filters: RetrievalFilters;
      }>({ results: raw, filters: ownedFilters }, 'beginRequest');
      results = owned.results;
      filters = owned.filters;
    } catch {
      return empty;
    }
    if (
      !Array.isArray(results) ||
      results.length > 200 ||
      !isLiveCompositionalRuntimeReaderV3(reader)
    )
      return empty;
    for (const hit of results)
      if (!CompositionalRuntimeSearchHitV3Schema.safeParse(hit).success) return empty;
    const version = (hit: EdgeSearchResult) => {
      const claim = hit.edge.attributes.engram_claim_v1;
      return claim && typeof claim === 'object'
        ? (claim as { version?: unknown }).version
        : undefined;
    };
    const rich = results.filter((hit) => version(hit) === 2);
    const ordinary = results.filter((hit) => hit.edge.attributes.engram_claim_v1 === undefined);
    const governed = governCompositionalRuntimeEdgesV3(reader, rich, filters, {
      mode: automatic?.mode ?? 'current',
      ...(automatic?.at === undefined ? {} : { at: automatic.at }),
    });
    const legacy = ordinary.length
      ? await this.governEdgesWithDecisions(ordinary, filters, budget, automatic)
      : { results: [], decisions: [] };
    governed.results.push(...legacy.results);
    governed.decisions.push(...legacy.decisions);
    const scans = automatic?.conflicts ?? { remaining: 128 };
    for (const hit of results.filter(
      (hit) => hit.edge.attributes.engram_claim_v1 !== undefined && version(hit) !== 2,
    )) {
      if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
      const data = getCompositionalRuntimeLiteralDataV3(reader, hit.edge.uuid);
      const exact =
        data.status === 'literal_data' &&
        hashAutomaticCaptureV2({
          edge: hit.edge,
          subject: hit.sourceEntity,
          value: hit.targetEntity,
        }) ===
          hashAutomaticCaptureV2({ edge: data.edge, subject: data.subject, value: data.value });
      const visible = exact
        ? await automaticClaimVisibleForCompositionalRuntimeV3(reader, hit.edge, scans, automatic)
        : 'hidden';
      if (data.status !== 'literal_data' || visible === 'hidden') {
        governed.decisions.push(
          this.decision(hit.edge.uuid, 'fact', hit.score, false, 'automatic_claim_authority'),
        );
        continue;
      }
      const metadata = extractionMetadataFromAttributes(data.edge.attributes),
        review = metadata?.review_status ?? 'accepted';
      if (filters.review_statuses?.length && !filters.review_statuses.includes(review)) {
        governed.decisions.push(
          this.decision(hit.edge.uuid, 'fact', hit.score, false, 'review_status_filtered'),
        );
        continue;
      }
      if (this.hasEpisodeFilters(filters) && !this.matchesEpisode(data.source, filters)) {
        governed.decisions.push(
          this.decision(
            hit.edge.uuid,
            'fact',
            hit.score,
            false,
            'no_source_episode_matched_filters',
          ),
        );
        continue;
      }
      governed.results.push({
        ...hit,
        edge:
          visible === 'historical_record'
            ? {
                ...data.edge,
                fact:
                  data.edge.fact +
                  ` [Historical recorded preference; recorded review=${review}; current identity and validity not established; not current personalization]`,
              }
            : data.edge,
        sourceEntity: data.subject,
        targetEntity: data.value,
        provenance: [this.episodeProvenance(data.source, metadata?.confidence ?? null, review)],
      });
      governed.decisions.push(this.decision(hit.edge.uuid, 'fact', hit.score, true, 'included'));
    }
    if (!isLiveCompositionalRuntimeReaderV3(reader)) return empty;
    const order = new Map(results.map((hit, index) => [hit.edge.uuid, index]));
    governed.results.sort((a, b) => (order.get(a.edge.uuid) ?? 0) - (order.get(b.edge.uuid) ?? 0));
    return governed;
  }

  private referenceCount(attributes: Record<string, unknown>): number {
    const metadata = attributes.engram_extraction as { episode_uuids?: unknown } | undefined;
    return Array.isArray(metadata?.episode_uuids) ? metadata.episode_uuids.length : 0;
  }

  private boundReferences<T>(
    results: T[],
    count: (result: T) => number,
    budget?: SourceHydrationBudget,
  ): T[] {
    if (!budget) return results;
    return results.filter((result) => {
      const references = count(result);
      if (references > budget.remaining) {
        budget.deferred++;
        return false;
      }
      budget.remaining -= references;
      return true;
    });
  }

  private decision(
    candidateId: string,
    candidateType: 'entity' | 'fact',
    score: number,
    included: boolean,
    reason: string,
  ): RetrievalCandidateDecision {
    return {
      candidate_id: candidateId,
      candidate_type: candidateType,
      score,
      included,
      reasons: [reason],
    };
  }

  private edgeEpisodeUuids(edge: EntityEdge): string[] {
    const metadataUuids = extractionMetadataFromAttributes(edge.attributes)?.episode_uuids ?? [];
    return [...new Set([...edge.episodes, ...metadataUuids])];
  }

  private hasEpisodeFilters(filters: RetrievalFilters): boolean {
    return Boolean(
      filters.sender_id ||
      filters.episode_kind ||
      filters.trust_level ||
      filters.source_workflow_id ||
      filters.source_execution_id ||
      filters.reference_after ||
      filters.reference_before,
    );
  }

  private matchesEpisode(episode: EpisodicNode, filters: RetrievalFilters): boolean {
    if (filters.sender_id && episode.sender_id !== filters.sender_id) return false;
    if (filters.episode_kind && episode.episode_kind !== filters.episode_kind) return false;
    if (filters.trust_level && episode.trust_level !== filters.trust_level) return false;
    if (filters.source_workflow_id && episode.source_workflow_id !== filters.source_workflow_id) {
      return false;
    }
    if (
      filters.source_execution_id &&
      episode.source_execution_id !== filters.source_execution_id
    ) {
      return false;
    }
    if (filters.reference_after && episode.reference_time < filters.reference_after) return false;
    if (filters.reference_before && episode.reference_time > filters.reference_before) return false;
    return true;
  }

  private episodeProvenance(
    episode: EpisodicNode,
    factConfidence: number | null,
    factReviewStatus: EpisodeReviewStatus,
  ): FactProvenance {
    return {
      source_episode_uuid: episode.uuid,
      source_message_id: episode.source_message_id,
      conversation_id: episode.conversation_id,
      speaker_role: episode.role,
      sender_id: episode.sender_id,
      sender_name: episode.sender_name,
      episode_kind: episode.episode_kind,
      reference_time: episode.reference_time,
      trust_level: episode.trust_level,
      episode_review_status: episode.review_status,
      source_workflow_id: episode.source_workflow_id,
      source_execution_id: episode.source_execution_id,
      fact_confidence: factConfidence,
      fact_review_status: factReviewStatus,
    };
  }

  private unknownProvenance(
    factConfidence: number | null,
    factReviewStatus: EpisodeReviewStatus,
  ): FactProvenance {
    return {
      source_episode_uuid: null,
      source_message_id: null,
      conversation_id: null,
      speaker_role: null,
      sender_id: null,
      sender_name: null,
      episode_kind: null,
      reference_time: null,
      trust_level: null,
      episode_review_status: null,
      source_workflow_id: null,
      source_execution_id: null,
      fact_confidence: factConfidence,
      fact_review_status: factReviewStatus,
    };
  }
}
