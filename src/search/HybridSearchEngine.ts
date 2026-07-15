import type {
  IGraphStorage,
  EntitySearchResult,
  EdgeSearchResult,
  EntitySearchOptions,
  EdgeSearchOptions,
} from '../storage/IGraphStorage';
import type { EmbeddingService } from '../embeddings';
import { extractionMetadataFromAttributes } from '../schemas';
import {
  RetrievalGovernance,
  type GovernedEdgeSearchResult,
  type RetrievalCandidateDecision,
  type RetrievalFilters,
} from './RetrievalGovernance';
import { formatBudgetedItems, type BudgetedSectionResult } from './ContextBudget';
import type { EntityEdge } from '../schemas';

export interface HybridSearchOptions {
  limit?: number;
  minScore?: number;
  entityType?: string;
  includeExpired?: boolean;
  validAfter?: string;
  validBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  acceptedOnly?: boolean;
  retrievalFilters?: RetrievalFilters;
  includeDiagnostics?: boolean;
  diagnosticsCandidateLimit?: number;
}

export interface HybridSearchResults {
  entities: EntitySearchResult[];
  edges: GovernedEdgeSearchResult[];
  audit?: RetrievalAuditTrace;
}

export interface RetrievalAuditTrace {
  normalized_query: string;
  search_mode: 'text' | 'hybrid';
  active_filters: {
    group_id: string;
    limit: number;
    min_score: number;
    entity_type: string | null;
    include_expired: boolean;
    valid_after: string | null;
    valid_before: string | null;
    created_after: string | null;
    created_before: string | null;
    provenance: RetrievalFilters;
  };
  candidate_decisions: RetrievalCandidateDecision[];
  candidate_limit: number;
  candidates_truncated: boolean;
  final_result_ids: {
    entities: string[];
    facts: string[];
  };
}

export interface RetrievalContextAudit {
  total_token_budget: number | null;
  entity_section: BudgetedSectionResult;
  fact_section: BudgetedSectionResult;
  final_context_item_ids: string[];
}

export interface FormattedRetrievalContext {
  context: string;
  audit: RetrievalContextAudit;
}

/**
 * Reciprocal Rank Fusion (RRF) constant.
 * Higher k gives more weight to lower-ranked results.
 * k=60 is the standard value from the original RRF paper.
 */
const RRF_K = 60;

/**
 * Orchestrates hybrid search across the knowledge graph.
 * Supports text search (MiniSearch/Lucene) and optional semantic search (embeddings).
 * When embeddings are enabled, merges results using Reciprocal Rank Fusion (RRF).
 */
export class HybridSearchEngine {
  private storage: IGraphStorage;
  private embeddingService: EmbeddingService | null;
  private governance: RetrievalGovernance;

  constructor(storage: IGraphStorage, embeddingService?: EmbeddingService) {
    this.storage = storage;
    this.embeddingService = embeddingService ?? null;
    this.governance = new RetrievalGovernance(storage);
  }

  /**
   * Search for relevant entities and edges matching the query.
   * When embeddings are enabled, runs text + vector search in parallel and merges with RRF.
   */
  async search(
    query: string,
    groupId: string,
    options?: HybridSearchOptions,
  ): Promise<HybridSearchResults> {
    const limit = options?.limit ?? 10;
    const minScore = options?.minScore ?? 0;
    const retrievalFilters: RetrievalFilters = {
      ...options?.retrievalFilters,
      review_statuses: options?.acceptedOnly
        ? ['accepted']
        : options?.retrievalFilters?.review_statuses,
    };

    // Always run text search
    const textPromise = Promise.all([
      this.storage.searchEntities(query, groupId, {
        limit: limit * 2,
        min_score: minScore,
        entity_type: options?.entityType,
        created_after: options?.createdAfter,
        created_before: options?.createdBefore,
      }),
      this.storage.searchEdges(query, groupId, {
        limit: limit * 2,
        min_score: minScore,
        include_expired: options?.includeExpired ?? false,
        valid_after: options?.validAfter,
        valid_before: options?.validBefore,
        created_after: options?.createdAfter,
        created_before: options?.createdBefore,
      }),
    ]);

    // If embeddings are available, run vector search in parallel
    if (
      this.embeddingService &&
      this.storage.searchEntitiesByVector &&
      this.storage.searchEdgesByVector
    ) {
      try {
        const embeddingResult = await this.embeddingService.embed(query);
        const vector = embeddingResult.embedding;

        const [textResults, vectorResults] = await Promise.all([
          textPromise,
          Promise.all([
            this.storage.searchEntitiesByVector(vector, groupId, {
              limit: limit * 2,
              min_score: 0.3, // Lower threshold for vector — RRF handles ranking
            }),
            this.storage.searchEdgesByVector(vector, groupId, {
              limit: limit * 2,
              min_score: 0.3,
            }),
          ]),
        ]);

        const [rawTextEntities, rawTextEdges] = textResults;
        const [rawVectorEntities, rawVectorEdges] = vectorResults;
        const textEntities = this.filterAcceptedEntities(rawTextEntities, options?.acceptedOnly);
        const textEdges = this.filterAcceptedEdges(rawTextEdges, options?.acceptedOnly);
        const vectorEntities = this.filterAcceptedEntities(
          rawVectorEntities,
          options?.acceptedOnly,
        );
        const vectorEdges = this.filterAcceptedEdges(rawVectorEdges, options?.acceptedOnly);

        // Merge with RRF
        const mergedEntities = this.mergeEntityResults(textEntities, vectorEntities, limit * 2);
        const mergedEdges = this.mergeEdgeResults(textEdges, vectorEdges, limit * 2);
        const preliminaryDecisions = options?.includeDiagnostics
          ? [
              ...this.reviewFilterDecisions(rawTextEntities, 'entity', options?.acceptedOnly),
              ...this.reviewFilterDecisions(rawVectorEntities, 'entity', options?.acceptedOnly),
              ...this.reviewFilterDecisions(rawTextEdges, 'fact', options?.acceptedOnly),
              ...this.reviewFilterDecisions(rawVectorEdges, 'fact', options?.acceptedOnly),
            ]
          : [];
        return this.governSearchResults(
          query,
          groupId,
          'hybrid',
          mergedEntities,
          mergedEdges,
          retrievalFilters,
          limit,
          minScore,
          options,
          preliminaryDecisions,
        );
      } catch (error) {
        // Embedding failed — fall back to text-only
        console.warn('Engram: Embedding search failed, using text-only:', (error as Error).message);
      }
    }

    // Text-only path
    const [rawEntities, rawEdges] = await textPromise;
    const entities = this.filterAcceptedEntities(rawEntities, options?.acceptedOnly);
    const edges = this.filterAcceptedEdges(rawEdges, options?.acceptedOnly);
    const preliminaryDecisions = options?.includeDiagnostics
      ? [
          ...this.reviewFilterDecisions(rawEntities, 'entity', options?.acceptedOnly),
          ...this.reviewFilterDecisions(rawEdges, 'fact', options?.acceptedOnly),
        ]
      : [];
    return this.governSearchResults(
      query,
      groupId,
      'text',
      entities,
      edges,
      retrievalFilters,
      limit,
      minScore,
      options,
      preliminaryDecisions,
    );
  }

  private async governSearchResults(
    query: string,
    groupId: string,
    searchMode: 'text' | 'hybrid',
    entityCandidates: EntitySearchResult[],
    edgeCandidates: EdgeSearchResult[],
    retrievalFilters: RetrievalFilters,
    limit: number,
    minScore: number,
    options: HybridSearchOptions | undefined,
    preliminaryDecisions: RetrievalCandidateDecision[],
  ): Promise<HybridSearchResults> {
    if (!options?.includeDiagnostics) {
      const [entities, edges] = await Promise.all([
        this.governance.governEntities(entityCandidates, retrievalFilters),
        this.governance.governEdges(edgeCandidates, retrievalFilters),
      ]);
      return { entities: entities.slice(0, limit), edges: edges.slice(0, limit) };
    }

    const [entityGovernance, edgeGovernance] = await Promise.all([
      this.governance.governEntitiesWithDecisions(entityCandidates, retrievalFilters),
      this.governance.governEdgesWithDecisions(edgeCandidates, retrievalFilters),
    ]);
    const entities = entityGovernance.results.slice(0, limit);
    const edges = edgeGovernance.results.slice(0, limit);
    const candidateLimit = Math.min(
      250,
      Math.max(1, Math.floor(options.diagnosticsCandidateLimit ?? 100)),
    );
    const allDecisions = this.finalizeCandidateDecisions(
      [...preliminaryDecisions, ...entityGovernance.decisions, ...edgeGovernance.decisions],
      new Set(entities.map((result) => result.entity.uuid)),
      new Set(edges.map((result) => result.edge.uuid)),
    );

    return {
      entities,
      edges,
      audit: {
        normalized_query: this.normalizeAuditQuery(query),
        search_mode: searchMode,
        active_filters: {
          group_id: groupId,
          limit,
          min_score: minScore,
          entity_type: options.entityType ?? null,
          include_expired: options.includeExpired ?? false,
          valid_after: options.validAfter ?? null,
          valid_before: options.validBefore ?? null,
          created_after: options.createdAfter ?? null,
          created_before: options.createdBefore ?? null,
          provenance: this.compactRetrievalFilters(retrievalFilters),
        },
        candidate_decisions: allDecisions.slice(0, candidateLimit),
        candidate_limit: candidateLimit,
        candidates_truncated: allDecisions.length > candidateLimit,
        final_result_ids: {
          entities: entities.map((result) => result.entity.uuid),
          facts: edges.map((result) => result.edge.uuid),
        },
      },
    };
  }

  private reviewFilterDecisions(
    results: EntitySearchResult[] | EdgeSearchResult[],
    candidateType: 'entity' | 'fact',
    acceptedOnly = false,
  ): RetrievalCandidateDecision[] {
    if (!acceptedOnly) return [];
    return results.flatMap((result) => {
      const record =
        candidateType === 'entity'
          ? (result as EntitySearchResult).entity
          : (result as EdgeSearchResult).edge;
      const status = extractionMetadataFromAttributes(record.attributes)?.review_status;
      if (status !== 'proposed' && status !== 'rejected') return [];
      return [
        {
          candidate_id: record.uuid,
          candidate_type: candidateType,
          score: result.score,
          included: false,
          reasons: ['review_status_filtered'],
        },
      ];
    });
  }

  private finalizeCandidateDecisions(
    decisions: RetrievalCandidateDecision[],
    finalEntityIds: Set<string>,
    finalFactIds: Set<string>,
  ): RetrievalCandidateDecision[] {
    const unique = new Map<string, RetrievalCandidateDecision>();
    for (const decision of decisions) {
      const key = `${decision.candidate_type}:${decision.candidate_id}`;
      if (!unique.has(key)) unique.set(key, decision);
    }
    return [...unique.values()].map((decision) => {
      const finalIds = decision.candidate_type === 'entity' ? finalEntityIds : finalFactIds;
      if (decision.included && !finalIds.has(decision.candidate_id)) {
        return { ...decision, included: false, reasons: ['result_limit'] };
      }
      return decision;
    });
  }

  private normalizeAuditQuery(query: string): string {
    const normalized = query
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
    return normalized.length > 512 ? `${normalized.slice(0, 509)}...` : normalized;
  }

  private compactRetrievalFilters(filters: RetrievalFilters): RetrievalFilters {
    return Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== undefined),
    ) as RetrievalFilters;
  }

  private filterAcceptedEntities(
    results: EntitySearchResult[],
    acceptedOnly = false,
  ): EntitySearchResult[] {
    if (!acceptedOnly) return results;
    return results.filter(
      (result) =>
        extractionMetadataFromAttributes(result.entity.attributes)?.review_status !== 'proposed' &&
        extractionMetadataFromAttributes(result.entity.attributes)?.review_status !== 'rejected',
    );
  }

  private filterAcceptedEdges(
    results: EdgeSearchResult[],
    acceptedOnly = false,
  ): EdgeSearchResult[] {
    if (!acceptedOnly) return results;
    return results.filter(
      (result) =>
        extractionMetadataFromAttributes(result.edge.attributes)?.review_status !== 'proposed' &&
        extractionMetadataFromAttributes(result.edge.attributes)?.review_status !== 'rejected',
    );
  }

  /**
   * Search entities only.
   */
  async searchEntities(
    query: string,
    groupId: string,
    options?: EntitySearchOptions,
  ): Promise<EntitySearchResult[]> {
    return this.storage.searchEntities(query, groupId, options);
  }

  /**
   * Search edges/relationships only.
   */
  async searchEdges(
    query: string,
    groupId: string,
    options?: EdgeSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    return this.storage.searchEdges(query, groupId, options);
  }

  /**
   * Merge entity results from text and vector search using Reciprocal Rank Fusion.
   */
  private mergeEntityResults(
    textResults: EntitySearchResult[],
    vectorResults: EntitySearchResult[],
    limit: number,
  ): EntitySearchResult[] {
    const scores = new Map<string, { score: number; entity: EntitySearchResult }>();

    // Add text search RRF scores
    for (let i = 0; i < textResults.length; i++) {
      const r = textResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      scores.set(r.entity.uuid, { score: rrfScore, entity: r });
    }

    // Add vector search RRF scores
    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      const existing = scores.get(r.entity.uuid);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(r.entity.uuid, { score: rrfScore, entity: r });
      }
    }

    // Sort by combined RRF score
    const merged = [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        entity: s.entity.entity,
        score: s.score,
      }));

    return merged;
  }

  /**
   * Merge edge results from text and vector search using Reciprocal Rank Fusion.
   */
  private mergeEdgeResults(
    textResults: EdgeSearchResult[],
    vectorResults: EdgeSearchResult[],
    limit: number,
  ): EdgeSearchResult[] {
    const scores = new Map<string, { score: number; result: EdgeSearchResult }>();

    for (let i = 0; i < textResults.length; i++) {
      const r = textResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      scores.set(r.edge.uuid, { score: rrfScore, result: r });
    }

    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      const existing = scores.get(r.edge.uuid);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(r.edge.uuid, { score: rrfScore, result: r });
      }
    }

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        ...s.result,
        score: s.score,
      }));
  }

  /**
   * Get a formatted context string from search results.
   * Useful for injecting into LLM prompts.
   */
  formatAsContext(
    results: HybridSearchResults,
    tokenBudget?: number,
    includeProvenance = false,
  ): string {
    return this.formatAsContextWithAudit(results, tokenBudget, includeProvenance).context;
  }

  formatAsContextWithAudit(
    results: HybridSearchResults,
    tokenBudget?: number,
    includeProvenance = false,
  ): FormattedRetrievalContext {
    const entityItems = results.entities.map((result) => ({
      id: result.entity.uuid,
      line:
        '- ' +
        result.entity.name +
        ' (' +
        result.entity.entity_type +
        '): ' +
        result.entity.summary,
    }));
    const factItems = results.edges.map((result) => ({
      id: result.edge.uuid,
      line: includeProvenance
        ? this.formatFactWithProvenance(result)
        : '- ' +
          result.sourceEntity.name +
          ' -> ' +
          result.targetEntity.name +
          ': ' +
          result.edge.fact,
    }));
    const entityBudget = tokenBudget === undefined ? undefined : Math.floor(tokenBudget * 0.25);
    const factBudget = tokenBudget === undefined ? undefined : tokenBudget - (entityBudget ?? 0);
    const entitySection = formatBudgetedItems('Known entities:', entityItems, entityBudget);
    const factSection = formatBudgetedItems('Known facts:', factItems, factBudget);
    const context = [entitySection.text, factSection.text].filter(Boolean).join('\n\n');
    return {
      context,
      audit: {
        total_token_budget: tokenBudget ?? null,
        entity_section: entitySection,
        fact_section: factSection,
        final_context_item_ids: [...entitySection.included_ids, ...factSection.included_ids],
      },
    };
  }

  async governTraversalEdges(
    edges: EntityEdge[],
    filters: RetrievalFilters = {},
  ): Promise<GovernedEdgeSearchResult[]> {
    const results = (
      await Promise.all(
        edges.map(async (edge) => {
          const [sourceEntity, targetEntity] = await Promise.all([
            this.storage.getEntity(edge.source_node_uuid),
            this.storage.getEntity(edge.target_node_uuid),
          ]);
          if (!sourceEntity || !targetEntity) return null;
          return { edge, sourceEntity, targetEntity, score: 0 };
        }),
      )
    ).filter((result): result is EdgeSearchResult => result !== null);
    return this.governance.governEdges(results, filters);
  }

  private formatFactWithProvenance(result: GovernedEdgeSearchResult): string {
    const sources = result.provenance ?? [];
    const provenance = sources
      .map((source) => {
        const speaker = source.sender_name ?? source.sender_id ?? source.speaker_role ?? 'unknown';
        return [
          `speaker=${speaker}`,
          `episode=${source.source_episode_uuid ?? 'none'}`,
          `message=${source.source_message_id ?? 'none'}`,
          `time=${source.reference_time ?? 'unknown'}`,
          `kind=${source.episode_kind ?? 'unknown'}`,
          `trust=${source.trust_level ?? 'unknown'}`,
        ].join(' ');
      })
      .join('; ');
    const factState = sources[0];
    return (
      '- ' +
      result.sourceEntity.name +
      ' -> ' +
      result.targetEntity.name +
      ': ' +
      result.edge.fact +
      ` [confidence=${factState?.fact_confidence ?? 'unknown'} review=${factState?.fact_review_status ?? 'accepted'}; ${provenance}]`
    );
  }
}
