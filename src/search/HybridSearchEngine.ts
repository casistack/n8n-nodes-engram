import type {
  IGraphStorage,
  EntitySearchResult,
  EdgeSearchResult,
  EntitySearchOptions,
  EdgeSearchOptions,
} from '../storage/IGraphStorage';
import type { EmbeddingService } from '../embeddings';
import { extractionMetadataFromAttributes, ExplicitTimestampSchema } from '../schemas';
import {
  RetrievalGovernance,
  type GovernedEdgeSearchResult,
  type RetrievalCandidateDecision,
  type RetrievalFilters,
} from './RetrievalGovernance';
import { formatBudgetedItems, type BudgetedSectionResult } from './ContextBudget';
import type { EntityEdge } from '../schemas';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import type { AutomaticReadContext } from '../schemas/AutomaticRuntime.schema';
import type { CompositionalRuntimeReaderV3 } from '../schemas/CompositionalRuntimeReaderV3.schema';
import {
  getCompositionalRuntimeCandidateDataV3,
  isLiveCompositionalRuntimeReaderV3,
  isCompositionalCompatibilityRuntimeReaderV4,
  getCompositionalRuntimeAutomaticReadContextV3,
} from './CompositionalRuntimeReaderV3';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { getCompositionalRuntimeLexicalHintV3 } from './CompositionalRuntimeSearchV3';
import { EntityEdgeSchema } from '../schemas/EntityEdge.schema';
import { getAutonomousPersonalRuntimeDisplayV4 } from './AutonomousPersonalRuntimeSearchV4';
import {
  getAutonomousPersonalMemoryParentReadStopV4,
  type PrivateAutonomousPersonalMemoryParentReaderV4,
} from '../memory/AutonomousPersonalMemoryParentReaderV4';

type NativeSearchRouteV4 = Readonly<{
  owner: IGraphStorage;
  parent: PrivateAutonomousPersonalMemoryParentReaderV4;
  compatibilityReader: CompositionalRuntimeReaderV3;
  namespace: string;
  sources: SourceHydrationBudget;
  conflicts: AutomaticReadContext['conflicts'];
}>;
const nativeSearchRoutesV4 = new WeakMap<object, NativeSearchRouteV4>();

function nativeRouteLiveV4(route: NativeSearchRouteV4): boolean {
  return (
    isCompositionalCompatibilityRuntimeReaderV4(
      route.owner,
      route.parent,
      route.compatibilityReader,
    ) && getAutonomousPersonalMemoryParentReadStopV4(route.owner, route.parent) === null
  );
}

function nativeReadContextV4(
  route: NativeSearchRouteV4,
  requested?: AutomaticReadContext,
): AutomaticReadContext | null {
  if (!nativeRouteLiveV4(route)) return null;
  const mode = requested?.mode ?? 'current';
  const at = requested?.at;
  if (mode === 'asOf' && !ExplicitTimestampSchema.safeParse(at).success) return null;
  const context = getCompositionalRuntimeAutomaticReadContextV3(route.compatibilityReader, {
    mode,
    ...(at === undefined ? {} : { at }),
  });
  if (
    !context ||
    context.sources !== route.sources ||
    context.conflicts !== route.conflicts ||
    !nativeRouteLiveV4(route)
  )
    return null;
  return context;
}

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
  captureMatchEvidence?: boolean;
  hydrationBudget?: SourceHydrationBudget;
  automaticBudget?: AutomaticReadContext;
  compositionalReader?: CompositionalRuntimeReaderV3;
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

  /** @internal Fixed native construction; no caller graph, callback or mode can bind a route. */
  static forAutonomousPersonalMemoryV4(
    owner: IGraphStorage,
    parent: PrivateAutonomousPersonalMemoryParentReaderV4,
    compatibilityReader: CompositionalRuntimeReaderV3,
    embeddingService?: EmbeddingService,
  ): Readonly<{ engine: HybridSearchEngine; storage: IGraphStorage }> | null {
    const bound = RetrievalGovernance.forAutonomousPersonalMemoryV4(
      owner,
      parent,
      compatibilityReader,
    );
    if (!bound) return null;
    const automatic = getCompositionalRuntimeAutomaticReadContextV3(compatibilityReader);
    if (!automatic) return null;
    const route: NativeSearchRouteV4 = Object.freeze({
      owner,
      parent,
      compatibilityReader,
      namespace: bound.namespace,
      sources: automatic.sources,
      conflicts: automatic.conflicts,
    });
    if (!nativeRouteLiveV4(route)) return null;
    const engine = new HybridSearchEngine(bound.storage, embeddingService);
    engine.governance = bound.governance;
    nativeSearchRoutesV4.set(engine, route);
    return Object.freeze({ engine, storage: bound.storage });
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
    const native = nativeSearchRoutesV4.get(this);
    if (native) {
      if (groupId !== native.namespace || !nativeRouteLiveV4(native))
        return { entities: [], edges: [] };
      const automatic = nativeReadContextV4(native, options?.automaticBudget);
      const requestedLimit = options?.limit ?? 10;
      if (
        !automatic ||
        !Number.isInteger(requestedLimit) ||
        requestedLimit < 1 ||
        requestedLimit > 200
      )
        return { entities: [], edges: [] };
      options = {
        ...options,
        hydrationBudget: automatic.sources,
        automaticBudget: automatic,
        compositionalReader: native.compatibilityReader,
      };
    }
    const limit = options?.limit ?? 10;
    const minScore = options?.minScore ?? 0;
    const retrievalFilters: RetrievalFilters = {
      ...options?.retrievalFilters,
      review_statuses: options?.acceptedOnly
        ? ['accepted']
        : options?.retrievalFilters?.review_statuses,
    };

    // The opt-in native route normalizes a preference word family for candidate
    // matching only. Embeddings and diagnostics keep the original query.
    const textQuery = native ? query.replace(/\b(?:preferences?|preferred)\b/gi, 'prefer') : query;
    // Always run text search
    const textPromise = Promise.all([
      this.storage.searchEntities(query, groupId, {
        limit: limit * 2,
        min_score: minScore,
        entity_type: options?.entityType,
        created_after: options?.createdAfter,
        created_before: options?.createdBefore,
      }),
      this.storage.searchEdges(textQuery, groupId, {
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
        if (native && !nativeRouteLiveV4(native)) return { entities: [], edges: [] };
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
        if (native && !nativeRouteLiveV4(native)) return { entities: [], edges: [] };

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
        const mergedEdges = this.mergeEdgeResults(
          textEdges,
          vectorEdges,
          limit * 2,
          options?.captureMatchEvidence,
        );
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
        if (native) {
          // This also rethrows any sticky trusted-reader failure with its exact identity.
          if (!nativeRouteLiveV4(native)) return { entities: [], edges: [] };
          console.warn('Engram: Embedding search failed, using text-only');
        } else {
          // Embedding failed — fall back to text-only
          console.warn(
            'Engram: Embedding search failed, using text-only:',
            (error as Error).message,
          );
        }
      }
    }

    // Text-only path
    const [rawEntities, rawEdges] = await textPromise;
    if (native && !nativeRouteLiveV4(native)) return { entities: [], edges: [] };
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
    const native = nativeSearchRoutesV4.get(this);
    if (native) {
      if (groupId !== native.namespace || !nativeRouteLiveV4(native))
        return { entities: [], edges: [] };
      entityCandidates = entityCandidates.slice(0, 200);
      edgeCandidates = edgeCandidates.slice(0, 200);
    }
    if (!options?.includeDiagnostics) {
      const [entities, edges] = await Promise.all([
        this.governance.governEntities(
          entityCandidates,
          retrievalFilters,
          options?.hydrationBudget,
        ),
        native
          ? this.governance
              .governAutonomousPersonalMemoryEdgesV4(
                native.owner,
                native.parent,
                native.compatibilityReader,
                edgeCandidates,
                retrievalFilters,
                native.sources,
                options?.automaticBudget,
              )
              .then((result) => result.results)
          : this.governance.governEdges(
              edgeCandidates,
              retrievalFilters,
              options?.hydrationBudget,
              options?.automaticBudget,
              ...(options?.compositionalReader === undefined
                ? ([] as const)
                : ([options.compositionalReader] as const)),
            ),
      ]);
      if (native && !nativeRouteLiveV4(native)) return { entities: [], edges: [] };
      return { entities: entities.slice(0, limit), edges: edges.slice(0, limit) };
    }

    const [entityGovernance, edgeGovernance] = await Promise.all([
      this.governance.governEntitiesWithDecisions(
        entityCandidates,
        retrievalFilters,
        options?.hydrationBudget,
      ),
      native
        ? this.governance.governAutonomousPersonalMemoryEdgesV4(
            native.owner,
            native.parent,
            native.compatibilityReader,
            edgeCandidates,
            retrievalFilters,
            native.sources,
            options?.automaticBudget,
          )
        : this.governance.governEdgesWithDecisions(
            edgeCandidates,
            retrievalFilters,
            options?.hydrationBudget,
            options?.automaticBudget,
            ...(options?.compositionalReader === undefined
              ? ([] as const)
              : ([options.compositionalReader] as const)),
          ),
    ]);
    if (native && !nativeRouteLiveV4(native)) return { entities: [], edges: [] };
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
    evidence = false,
  ): EdgeSearchResult[] {
    const scores = new Map<string, { score: number; result: EdgeSearchResult }>();

    for (let i = 0; i < textResults.length; i++) {
      const r = textResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      scores.set(r.edge.uuid, {
        score: rrfScore,
        result: evidence ? { ...r, match_evidence: { text: true, vector: false } } : r,
      });
    }

    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      const existing = scores.get(r.edge.uuid);
      if (existing) {
        existing.score += rrfScore;
        if (evidence)
          existing.result = { ...existing.result, match_evidence: { text: true, vector: true } };
      } else {
        scores.set(r.edge.uuid, {
          score: rrfScore,
          result: evidence ? { ...r, match_evidence: { text: false, vector: true } } : r,
        });
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
    const buildFactItems = (allowClaim3: boolean) => {
      const items: { id: string; line: string }[] = [];
      for (const result of results.edges) {
        const version = (
          result.edge.attributes.engram_claim_v1 as { version?: unknown } | undefined
        )?.version;
        if (version === 3) {
          // Version 3 text is never trusted from the edge; only a live private display renders.
          const line = allowClaim3
            ? this.formatAutonomousPersonalFact(result, includeProvenance)
            : null;
          if (line !== null) items.push({ id: result.edge.uuid, line });
          continue;
        }
        if (version === 2 && getCompositionalRuntimeLexicalHintV3(result) === null) continue;
        items.push({
          id: result.edge.uuid,
          line: includeProvenance
            ? this.formatFactWithProvenance(result)
            : '- ' +
              result.sourceEntity.name +
              ' -> ' +
              result.targetEntity.name +
              ': ' +
              result.edge.fact,
        });
      }
      return items;
    };
    const entityBudget = tokenBudget === undefined ? undefined : Math.floor(tokenBudget * 0.25);
    const factBudget = tokenBudget === undefined ? undefined : tokenBudget - (entityBudget ?? 0);
    const entitySection = formatBudgetedItems('Known entities:', entityItems, entityBudget);
    let factItems = buildFactItems(true);
    let factSection = formatBudgetedItems('Known facts:', factItems, factBudget);
    const claim3Ids = new Set(
      results.edges
        .filter(
          (result) =>
            (result.edge.attributes.engram_claim_v1 as { version?: unknown } | undefined)
              ?.version === 3,
        )
        .map((result) => result.edge.uuid),
    );
    if (
      claim3Ids.size > 0 &&
      results.edges.some(
        (result) =>
          claim3Ids.has(result.edge.uuid) &&
          factSection.included_ids.includes(result.edge.uuid) &&
          getAutonomousPersonalRuntimeDisplayV4(result) === null,
      )
    ) {
      // A display expired while formatting: fail closed by dropping every Claim3 item.
      factItems = buildFactItems(false);
      factSection = formatBudgetedItems('Known facts:', factItems, factBudget);
    }
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
    budget?: SourceHydrationBudget,
    automatic?: AutomaticReadContext,
    compositionalReader?: CompositionalRuntimeReaderV3,
  ): Promise<GovernedEdgeSearchResult[]> {
    const native = nativeSearchRoutesV4.get(this);
    if (native) {
      if (!nativeRouteLiveV4(native) || !Array.isArray(edges) || edges.length > 200) return [];
      const context = nativeReadContextV4(native, automatic);
      if (!context) return [];
      const results: EdgeSearchResult[] = [];
      for (const candidate of edges) {
        if (!nativeRouteLiveV4(native)) return [];
        let edge: EntityEdge;
        try {
          edge = EntityEdgeSchema.strict().parse(
            cloneBoundedAutomaticCaptureJson(candidate, 'beginRequest'),
          );
        } catch {
          // Recheck outside data validation to preserve trusted-reader failures.
          if (!nativeRouteLiveV4(native)) return [];
          return [];
        }
        if (edge.group_id !== native.namespace) return [];
        const [sourceEntity, targetEntity] = await Promise.all([
          this.storage.getEntity(edge.source_node_uuid),
          this.storage.getEntity(edge.target_node_uuid),
        ]);
        if (!nativeRouteLiveV4(native)) return [];
        if (sourceEntity && targetEntity)
          results.push({ edge, sourceEntity, targetEntity, score: 0 });
      }
      const governed = await this.governance.governAutonomousPersonalMemoryEdgesV4(
        native.owner,
        native.parent,
        native.compatibilityReader,
        results,
        filters,
        native.sources,
        context,
      );
      return nativeRouteLiveV4(native) ? governed.results : [];
    }
    if (compositionalReader !== undefined) {
      if (!isLiveCompositionalRuntimeReaderV3(compositionalReader)) return [];
      let owned: EntityEdge[];
      try {
        owned = cloneBoundedAutomaticCaptureJson<{ edges: EntityEdge[] }>(
          { edges },
          'beginRequest',
        ).edges;
      } catch {
        return [];
      }
      if (!Array.isArray(owned) || owned.length > 200) return [];
      const results: EdgeSearchResult[] = [];
      for (const edge of owned) {
        if (!EntityEdgeSchema.strict().safeParse(edge).success) return [];
        const data = getCompositionalRuntimeCandidateDataV3(compositionalReader, edge.uuid);
        if (data.status === 'candidate_data')
          results.push({ edge, sourceEntity: data.subject, targetEntity: data.value, score: 0 });
      }
      return this.governance.governEdges(results, filters, budget, automatic, compositionalReader);
    }
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
    return this.governance.governEdges(results, filters, budget, automatic);
  }

  /** Render one genuine Claim3 hit from its private live display only; null excludes it. */
  private formatAutonomousPersonalFact(
    result: GovernedEdgeSearchResult,
    includeProvenance: boolean,
  ): string | null {
    const display = getAutonomousPersonalRuntimeDisplayV4(result);
    if (display === null) return null;
    const name = result.sourceEntity.name;
    let line =
      display.kind === 'typed_preference'
        ? '- ' + name + ' preference (structured): ' + JSON.stringify(display.meaning)
        : display.qualification === undefined
          ? '- Source statement dated ' +
            display.sourceEventTime +
            ' by ' +
            name +
            ': ' +
            display.statementLiteral
          : '- Source statement dated ' +
            display.sourceEventTime +
            ' by ' +
            name +
            ' (context-qualified; the stated condition is not asserted as true or current): ' +
            display.statementLiteral;
    if (includeProvenance) {
      const source = display.source;
      line +=
        ` [confidence=${display.confidence ?? 'unknown'} review=${source.reviewStatus};` +
        ` speaker=${source.senderName ?? source.senderId ?? 'unknown'}` +
        ` time=${source.referenceTime} trust=${source.trustLevel}]`;
    }
    return getAutonomousPersonalRuntimeDisplayV4(result) === display ? line : null;
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
