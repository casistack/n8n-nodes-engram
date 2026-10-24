import {
  ExtractionError,
  reportExtractionError,
  type ExtractionDiagnostics,
} from './ExtractionDiagnostics';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  ExtractionMetadataV2Schema,
  decideExtractionReview,
  extractionMetadataFromAttributes,
  type EntityNode,
  type ExtractionMetadataV2,
  type ExtractionThresholdPolicy,
} from '../schemas';
import { LlmClient, type LlmClientConfig } from './LlmClient';
import { EntityExtractor } from './EntityExtractor';
import { RelationshipExtractor } from './RelationshipExtractor';
import { EntityDeduplicator } from './EntityDeduplicator';
import { ContradictionDetector } from './ContradictionDetector';
import { EdgeDeduplicator } from './EdgeDeduplicator';
import { EmbeddingService, type EmbeddingConfig } from '../embeddings';
import { nowIso } from '../utils/temporal';
import { extractionEpisodeUuids, type ExtractionSource } from './ExtractionSource';

export interface ExtractionPipelineConfig {
  llmConfig: LlmClientConfig;
  entityTypes: string[];
  groupId: string;
  /** Optional embedding config — when provided, generates name_embedding / fact_embedding */
  embeddingConfig?: EmbeddingConfig;
  requireConfidence?: boolean;
  thresholdPolicy?: ExtractionThresholdPolicy;
}

/**
 * Orchestrates the full extraction pipeline:
 * 1. Extract entities from conversation
 * 2. Deduplicate against existing entities
 * 3. Persist new/updated entities
 * 4. Extract relationships
 * 5. Detect contradictions with existing facts
 * 6. Persist new edges (expire contradicted ones)
 */
export class ExtractionPipeline {
  private storage: IGraphStorage;
  private entityExtractor: EntityExtractor;
  private relationshipExtractor: RelationshipExtractor;
  private deduplicator: EntityDeduplicator;
  private contradictionDetector: ContradictionDetector;
  private edgeDeduplicator: EdgeDeduplicator;
  private embeddingService: EmbeddingService | null = null;
  private entityTypes: string[];
  private groupId: string;
  private requireConfidence: boolean;
  private thresholdPolicy?: ExtractionThresholdPolicy;

  constructor(
    storage: IGraphStorage,
    private config: ExtractionPipelineConfig,
    private diagnostics?: ExtractionDiagnostics,
  ) {
    const llm = (stage: import('../schemas').ExtractionStage) =>
      new LlmClient(config.llmConfig, diagnostics, stage);
    this.storage = diagnostics
      ? new Proxy(storage, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property);
            if (typeof value !== 'function') return value;
            return async (...args: unknown[]) => {
              const end = diagnostics.begin('persistence');
              let failed = true;
              try {
                const result: unknown = await (value as (...a: unknown[]) => unknown).apply(
                  target,
                  args,
                );
                const counters = {
                  addEntity: 'entities_created',
                  updateEntity: 'entities_updated',
                  addEdge: 'edges_created',
                  updateEdge: 'edges_updated',
                } as const;
                const counter = counters[property as keyof typeof counters];
                if (counter) {
                  const update = args[1] as Record<string, unknown> | undefined;
                  diagnostics.increment(
                    property === 'updateEdge' && update?.expired_at ? 'edges_expired' : counter,
                  );
                  diagnostics.success('persistence');
                }
                failed = false;
                return result;
              } catch {
                const error = new ExtractionError('storage');
                if (
                  ['addEntity', 'updateEntity', 'addEdge', 'updateEdge'].includes(String(property))
                ) {
                  reportExtractionError('persistence', error, diagnostics);
                }
                throw error;
              } finally {
                end(failed);
              }
            };
          },
        })
      : storage;
    this.entityExtractor = new EntityExtractor(llm('entities'), diagnostics);
    this.relationshipExtractor = new RelationshipExtractor(llm('relationships'), diagnostics);
    this.deduplicator = new EntityDeduplicator(llm('entity_dedup'), diagnostics);
    this.contradictionDetector = new ContradictionDetector(llm('contradictions'), diagnostics);
    this.edgeDeduplicator = new EdgeDeduplicator(llm('edge_dedup'), diagnostics);
    this.entityTypes = config.entityTypes;
    this.groupId = config.groupId;
    this.requireConfidence = config.requireConfidence ?? false;
    this.thresholdPolicy = config.thresholdPolicy;
    if (this.thresholdPolicy) {
      decideExtractionReview(0.5, this.thresholdPolicy);
    }

    if (config.embeddingConfig) {
      this.embeddingService = new EmbeddingService(config.embeddingConfig, diagnostics);
    }
  }

  async process(
    humanMessage: string,
    aiMessage: string,
    episodeUuids: string[] = [],
  ): Promise<void> {
    const sources: ExtractionSource[] = [];
    if (humanMessage) {
      sources.push({
        content: humanMessage,
        role: 'human',
        episode_kind: 'active_human',
        episode_uuid: episodeUuids[0] ?? null,
      });
    }
    if (aiMessage) {
      sources.push({
        content: aiMessage,
        role: 'ai',
        episode_kind: 'assistant_reply',
        episode_uuid: episodeUuids[1] ?? null,
      });
    }
    await this.processSources(sources);
  }

  async processSources(
    sources: ExtractionSource[],
    diagnostics?: ExtractionDiagnostics,
  ): Promise<void> {
    if (diagnostics) {
      // Each invocation owns its stages, collector, and storage accounting proxy.
      return new ExtractionPipeline(this.storage, this.config, diagnostics).processSources(sources);
    }
    const selectedSources = sources.filter((source) => source.content.trim().length > 0);
    if (selectedSources.length === 0) return;
    const episodeUuids = extractionEpisodeUuids(selectedSources);

    // Step 1: Get existing entity names for dedup context
    const existingEntities = await this.storage.listEntities(this.groupId);
    if (this.diagnostics)
      this.diagnostics.stageMetric('entity_dedup').candidates += existingEntities.length;
    const existingNames = existingEntities.map((e) => e.name);

    // Step 2: Extract entities
    const extractedEntities = await this.entityExtractor.extractSources(
      selectedSources,
      this.entityTypes,
      existingNames,
      this.requireConfidence,
    );

    if (extractedEntities.length === 0) {
      if (!this.diagnostics?.hasFailed('entities')) this.diagnostics?.skip('relationships');
      return;
    }

    // Step 3: Deduplicate and persist entities
    const resolvedEntities = new Map<string, EntityNode>();

    for (const extracted of extractedEntities) {
      const resolved = await this.resolveEntity(extracted, existingEntities, episodeUuids);
      resolvedEntities.set(extracted.name.toLowerCase(), resolved);
    }

    // Step 4: Extract relationships
    const allEntityNames = [
      ...new Set([...existingNames, ...[...resolvedEntities.values()].map((e) => e.name)]),
    ];

    const extractedRelationships = await this.relationshipExtractor.extractSources(
      selectedSources,
      allEntityNames,
      this.requireConfidence,
    );

    // Step 5: Persist relationships with contradiction detection
    for (const rel of extractedRelationships) {
      await this.persistRelationship(rel, resolvedEntities, existingEntities, episodeUuids);
    }
  }

  private async resolveEntity(
    extracted: { name: string; entity_type: string; summary: string; confidence: number | null },
    existingEntities: EntityNode[],
    episodeUuids: string[],
  ): Promise<EntityNode> {
    const incomingMetadata = this.createExtractionMetadata(extracted.confidence, episodeUuids);
    const incomingStatus = incomingMetadata.review_status;
    // Check for duplicates among existing entities
    for (const existing of existingEntities) {
      const { isDuplicate, mergedSummary } = await this.deduplicator.isDuplicate(extracted, {
        name: existing.name,
        summary: existing.summary,
        entity_type: existing.entity_type,
      });

      if (isDuplicate) {
        const existingStatus = this.reviewStatus(existing.attributes);
        const updates: Partial<EntityNode> = {};
        if (
          mergedSummary &&
          mergedSummary !== existing.summary &&
          (!this.thresholdPolicy || incomingStatus === 'accepted' || existingStatus !== 'accepted')
        ) {
          updates.summary = mergedSummary;
        }
        const mergedMetadata = this.mergeExtractionMetadata(
          extractionMetadataFromAttributes(existing.attributes),
          incomingMetadata,
          episodeUuids,
        );
        if (mergedMetadata) {
          updates.attributes = { ...existing.attributes, engram_extraction: mergedMetadata };
        }
        if (Object.keys(updates).length > 0) {
          return await this.storage.updateEntity(existing.uuid, updates);
        }
        this.diagnostics?.increment('unchanged');
        return existing;
      }
    }

    // New entity - create it (with optional name embedding)
    let nameEmbedding: number[] | undefined;
    if (this.embeddingService) {
      try {
        const result = await this.embeddingService.embed(extracted.name);
        nameEmbedding = result.embedding;
        this.diagnostics?.success('embeddings');
      } catch (error) {
        reportExtractionError('embeddings', error, this.diagnostics);
      }
    }

    return await this.storage.addEntity({
      name: extracted.name,
      group_id: this.groupId,
      summary: extracted.summary,
      entity_type: extracted.entity_type,
      name_embedding: nameEmbedding ?? null,
      attributes: {
        engram_extraction: incomingMetadata,
      },
    });
  }

  private async expireContradictedEdges(
    edges: import('../schemas').EntityEdge[],
    newFact: string,
    sourceEntityName: string,
    targetEntityName: string,
    newEdgeName: string,
  ): Promise<void> {
    for (const existingEdge of edges) {
      if (existingEdge.expired_at) continue; // Already expired
      if (this.thresholdPolicy && this.reviewStatus(existingEdge.attributes) !== 'accepted') {
        continue;
      }

      const resolution = await this.contradictionDetector.detect(
        existingEdge.fact,
        newFact,
        sourceEntityName,
        targetEntityName,
        existingEdge.name,
        newEdgeName,
      );

      if (resolution.isContradiction && resolution.expiredAt) {
        await this.storage.updateEdge(existingEdge.uuid, {
          expired_at: resolution.expiredAt,
          invalid_at: resolution.expiredAt,
        });
      }
    }
  }

  private async persistRelationship(
    rel: {
      source_entity: string;
      target_entity: string;
      name: string;
      fact: string;
      confidence: number | null;
    },
    resolvedEntities: Map<string, EntityNode>,
    existingEntities: EntityNode[],
    episodeUuids: string[],
  ): Promise<void> {
    // Find source and target entity UUIDs
    const sourceEntity = this.findEntity(rel.source_entity, resolvedEntities, existingEntities);
    const targetEntity = this.findEntity(rel.target_entity, resolvedEntities, existingEntities);

    if (!sourceEntity || !targetEntity) return;

    const normalizedNewEdgeName = rel.name.toUpperCase().replace(/\s+/g, '_');
    const incomingMetadata = this.createExtractionMetadata(rel.confidence, episodeUuids);
    const incomingStatus = incomingMetadata.review_status;

    // --- Fetch edges between this pair ONCE (reused by dedup + contradiction) ---
    let samePairEdges: import('../schemas').EntityEdge[] = [];
    try {
      samePairEdges = await this.storage.getEdgesBetween(sourceEntity.uuid, targetEntity.uuid);
    } catch (error) {
      reportExtractionError('edge_dedup', error, this.diagnostics);
      // If we can't fetch existing edges, skip dedup/contradiction and just create
    }

    // --- Same-Name Edge Deduplication ---
    // Check if an equivalent edge already exists between the same pair with the same name.
    // If so, update in-place rather than creating a duplicate.
    if (incomingStatus !== 'rejected') {
      try {
        const existingMatchingEdge = samePairEdges.find(
          (e) =>
            e.name === normalizedNewEdgeName &&
            !e.expired_at &&
            this.reviewStatus(e.attributes) !== 'rejected',
        );

        if (existingMatchingEdge) {
          const { isDuplicate, mergedFact } = await this.edgeDeduplicator.isDuplicate(
            existingMatchingEdge.fact,
            rel.fact,
            normalizedNewEdgeName,
            sourceEntity.name,
            targetEntity.name,
          );

          if (isDuplicate) {
            const updates = await this.buildEdgeUpdates(
              existingMatchingEdge,
              mergedFact || rel.fact,
              episodeUuids,
              incomingMetadata,
            );
            if (Object.keys(updates).length > 0) {
              await this.storage.updateEdge(existingMatchingEdge.uuid, updates);
            } else {
              this.diagnostics?.increment('unchanged');
            }
            return; // Deduplicated — skip contradiction detection and creation
          }
        }
      } catch (error) {
        reportExtractionError('edge_dedup', error, this.diagnostics);
        // Fall through to cross-name dedup, then contradiction detection + creation
      }
    }

    // --- Cross-Name Edge Deduplication ---
    // Check if an edge with a DIFFERENT name but the same semantic meaning
    // already exists between this pair. Example: WORKS_AT already exists,
    // HOLDS_POSITION is extracted — they describe the same employment relationship.
    // If found, update the existing edge's fact and return early.
    if (incomingStatus !== 'rejected') {
      try {
        const crossNameCandidates = samePairEdges.filter(
          (e) =>
            e.name !== normalizedNewEdgeName &&
            !e.expired_at &&
            this.reviewStatus(e.attributes) !== 'rejected',
        );

        if (crossNameCandidates.length > 0) {
          // Check first active candidate (simplest, lowest risk)
          const candidate = crossNameCandidates[0];
          const { isDuplicate, mergedFact } = await this.edgeDeduplicator.isDuplicateCrossName(
            candidate.fact,
            rel.fact,
            candidate.name,
            normalizedNewEdgeName,
            sourceEntity.name,
            targetEntity.name,
          );

          if (isDuplicate) {
            const updates = await this.buildEdgeUpdates(
              candidate,
              mergedFact || rel.fact,
              episodeUuids,
              incomingMetadata,
            );
            if (Object.keys(updates).length > 0) {
              await this.storage.updateEdge(candidate.uuid, updates);
            } else {
              this.diagnostics?.increment('unchanged');
            }
            return; // Cross-name deduplicated — skip contradiction detection and creation
          }
        }
      } catch (error) {
        reportExtractionError('cross_edge_dedup', error, this.diagnostics);
        // Fall through to contradiction detection + creation
      }
    }

    // --- Contradiction Detection ---
    if (!this.thresholdPolicy || incomingStatus === 'accepted') {
      try {
        // Pass 1: Check edges between the same entity pair (any edge name).
        // Catches type changes like WORKS_AT → WORKED_AT on the same pair.
        // Reuses samePairEdges fetched above (no duplicate storage call).
        await this.expireContradictedEdges(
          samePairEdges,
          rel.fact,
          sourceEntity.name,
          targetEntity.name,
          normalizedNewEdgeName,
        );

        // Pass 2: Check outgoing edges from source with the same edge name
        // but pointing to a DIFFERENT target.
        // Catches e.g. LIVES_IN London → LIVES_IN Berlin.
        const checkedUuids = new Set(samePairEdges.map((e) => e.uuid));
        const allSourceEdges = await this.storage.getEdgesForEntity(sourceEntity.uuid);
        const crossTargetEdges = allSourceEdges.filter(
          (e) =>
            e.source_node_uuid === sourceEntity.uuid &&
            e.name === normalizedNewEdgeName &&
            e.target_node_uuid !== targetEntity.uuid &&
            !e.expired_at &&
            !checkedUuids.has(e.uuid),
        );
        await this.expireContradictedEdges(
          crossTargetEdges,
          rel.fact,
          sourceEntity.name,
          targetEntity.name,
          normalizedNewEdgeName,
        );
      } catch (error) {
        reportExtractionError('contradictions', error, this.diagnostics);
      }
    }

    // Create the new edge (with optional fact embedding)
    let factEmbedding: number[] | undefined;
    if (this.embeddingService) {
      try {
        const result = await this.embeddingService.embed(rel.fact);
        factEmbedding = result.embedding;
        this.diagnostics?.success('embeddings');
      } catch (error) {
        reportExtractionError('embeddings', error, this.diagnostics);
      }
    }

    await this.storage.addEdge({
      group_id: this.groupId,
      source_node_uuid: sourceEntity.uuid,
      target_node_uuid: targetEntity.uuid,
      name: normalizedNewEdgeName,
      fact: rel.fact,
      fact_embedding: factEmbedding ?? null,
      valid_at: nowIso(),
      episodes: episodeUuids,
      attributes: {
        engram_extraction: incomingMetadata,
      },
    });
  }

  /**
   * Build an updates object for an edge dedup merge (same-name or cross-name).
   * Updates fact + embedding + episodes as needed.
   */
  private async buildEdgeUpdates(
    existingEdge: import('../schemas').EntityEdge,
    effectiveFact: string,
    episodeUuids: string[],
    incomingMetadata: ExtractionMetadataV2,
  ): Promise<Record<string, unknown>> {
    const updates: Record<string, unknown> = {};
    const existingMetadata = extractionMetadataFromAttributes(existingEdge.attributes);
    const existingStatus = this.reviewStatus(existingEdge.attributes);

    if (
      effectiveFact !== existingEdge.fact &&
      (!this.thresholdPolicy ||
        incomingMetadata.review_status === 'accepted' ||
        existingStatus !== 'accepted')
    ) {
      updates.fact = effectiveFact;

      // Regenerate fact embedding if service available
      if (this.embeddingService) {
        try {
          const result = await this.embeddingService.embed(effectiveFact);
          updates.fact_embedding = result.embedding;
          this.diagnostics?.success('embeddings');
        } catch (error) {
          reportExtractionError('embeddings', error, this.diagnostics);
        }
      }
    }

    // Merge episode if provided
    if (episodeUuids.length > 0) {
      const existingEpisodes = existingEdge.episodes || [];
      const mergedEpisodes = [...existingEpisodes];
      for (const episodeUuid of episodeUuids) {
        if (!mergedEpisodes.includes(episodeUuid)) {
          mergedEpisodes.push(episodeUuid);
        }
      }
      if (mergedEpisodes.length !== existingEpisodes.length) {
        updates.episodes = mergedEpisodes;
      }
    }

    const mergedEpisodeUuids = [
      ...new Set([...(existingMetadata?.episode_uuids ?? []), ...episodeUuids]),
    ];
    const mergedMetadata = this.mergeExtractionMetadata(
      existingMetadata,
      incomingMetadata,
      mergedEpisodeUuids,
    );
    if (mergedMetadata) {
      updates.attributes = {
        ...existingEdge.attributes,
        engram_extraction: mergedMetadata,
      };
    }

    return updates;
  }

  private createExtractionMetadata(
    confidence: number | null,
    episodeUuids: string[],
  ): ExtractionMetadataV2 {
    const decision = decideExtractionReview(confidence, this.thresholdPolicy);
    return ExtractionMetadataV2Schema.parse({
      version: 2,
      source: 'llm',
      confidence,
      ...decision,
      extracted_at: nowIso(),
      episode_uuids: episodeUuids,
    });
  }

  private reviewStatus(attributes: Record<string, unknown>): 'proposed' | 'accepted' | 'rejected' {
    return extractionMetadataFromAttributes(attributes)?.review_status ?? 'accepted';
  }

  private mergeExtractionMetadata(
    existing: ExtractionMetadataV2 | null,
    incoming: ExtractionMetadataV2,
    episodeUuids: string[],
  ): ExtractionMetadataV2 | null {
    if (!existing) return null;
    const rank = { rejected: 0, proposed: 1, accepted: 2 } as const;
    const winner =
      rank[incoming.review_status] > rank[existing.review_status] ? incoming : existing;
    const confidence = Math.max(existing.confidence ?? 0, incoming.confidence ?? 0);
    return ExtractionMetadataV2Schema.parse({
      ...winner,
      confidence: existing.confidence === null && incoming.confidence === null ? null : confidence,
      episode_uuids: [...new Set(episodeUuids)],
    });
  }

  private findEntity(
    name: string,
    resolvedEntities: Map<string, EntityNode>,
    existingEntities: EntityNode[],
  ): EntityNode | undefined {
    const normalized = name.toLowerCase().trim();

    // Check resolved entities first
    const resolved = resolvedEntities.get(normalized);
    if (resolved) return resolved;

    // Fall back to existing entities
    return existingEntities.find((e) => e.name.toLowerCase().trim() === normalized);
  }
}
