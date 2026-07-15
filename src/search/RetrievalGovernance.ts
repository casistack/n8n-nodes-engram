import type {
  EntityEdge,
  EpisodeKind,
  EpisodeReviewStatus,
  EpisodeTrustLevel,
  EpisodicNode,
} from '../schemas';
import { extractionMetadataFromAttributes } from '../schemas';
import type { EdgeSearchResult, EntitySearchResult, IGraphStorage } from '../storage/IGraphStorage';

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

export class RetrievalGovernance {
  constructor(private storage: IGraphStorage) {}

  async governEntities(
    results: EntitySearchResult[],
    filters: RetrievalFilters = {},
  ): Promise<EntitySearchResult[]> {
    return (await this.governEntitiesWithDecisions(results, filters)).results;
  }

  async governEntitiesWithDecisions(
    results: EntitySearchResult[],
    filters: RetrievalFilters = {},
  ): Promise<GovernedResult<EntitySearchResult>> {
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
  ): Promise<GovernedEdgeSearchResult[]> {
    return (await this.governEdgesWithDecisions(results, filters)).results;
  }

  async governEdgesWithDecisions(
    results: EdgeSearchResult[],
    filters: RetrievalFilters = {},
  ): Promise<GovernedResult<GovernedEdgeSearchResult>> {
    const episodeUuids = [
      ...new Set(results.flatMap((result) => this.edgeEpisodeUuids(result.edge))),
    ];
    const episodes = await this.storage.getEpisodes(episodeUuids);
    const episodesByUuid = new Map(episodes.map((episode) => [episode.uuid, episode]));
    const governed: GovernedEdgeSearchResult[] = [];
    const decisions: RetrievalCandidateDecision[] = [];

    for (const result of results) {
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
      governed.push({ ...result, provenance });
      decisions.push(this.decision(result.edge.uuid, 'fact', result.score, true, 'included'));
    }
    return { results: governed, decisions };
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
