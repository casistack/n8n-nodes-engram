import type { IGraphStorage } from '../storage/IGraphStorage';
import { HybridSearchEngine } from './HybridSearchEngine';
import { GraphTraverser } from '../traversal/GraphTraverser';
import { AutomaticClaimMetadataSchema } from '../schemas/AutomaticClaim.schema';
import type { RetrievalFilters } from './RetrievalGovernance';
import {
  extractionMetadataFromAttributes,
  MemoryQualitySchema,
  ExplicitTimestampSchema,
} from '../schemas';
import { estimateContextTokens } from './ContextBudget';
import type { CompositionalRuntimeReaderV3 } from '../schemas/CompositionalRuntimeReaderV3.schema';
import { getCompositionalRuntimeLexicalHintV3 } from './CompositionalRuntimeSearchV3';
import { getAutonomousPersonalRuntimeLexicalHintV4 } from './AutonomousPersonalRuntimeSearchV4';
import { getCompositionalRuntimeAutomaticReadContextV3 } from './CompositionalRuntimeReaderV3';
import {
  GraphEvidenceBudgetsSchema,
  type GraphEvidenceBudgetsInput,
} from '../schemas/ExtractionPolicy.schema';

/** Opt-in reconciliation. Does not change stored records or legacy retrieval behavior. */
export async function governedContext(
  storage: IGraphStorage,
  engine: HybridSearchEngine,
  query: string,
  group: string,
  options: {
    mode: 'current' | 'historical' | 'asOf';
    at?: string;
    evidenceBudgets?: GraphEvidenceBudgetsInput;
    limit: number;
    minScore: number;
    tokenBudget?: number;
    traversal: boolean;
    hops: number;
    acceptedOnly: boolean;
    filters: RetrievalFilters;
    compositionalReader?: CompositionalRuntimeReaderV3;
  },
) {
  if (options.mode === 'asOf' && !ExplicitTimestampSchema.safeParse(options.at).success)
    throw new Error('Engram retrieval: as_of_requires_timestamp');
  const evidenceBudgets = GraphEvidenceBudgetsSchema.parse(options.evidenceBudgets);
  const sharedAutomatic =
    options.compositionalReader === undefined
      ? null
      : getCompositionalRuntimeAutomaticReadContextV3(options.compositionalReader, {
          mode: options.mode,
          ...(options.at === undefined ? {} : { at: options.at }),
        });
  const hydration = sharedAutomatic?.sources ?? { remaining: 512, deferred: 0 };
  const automatic = sharedAutomatic ?? {
    mode: options.mode,
    at: options.at,
    conflicts: { remaining: 128 },
    sources: hydration,
  };
  const audit = {
    candidates: 0,
    returned: 0,
    duplicate_uuid: 0,
    irrelevant: 0,
    uncertain_time: 0,
    invalid_time: 0,
    budget: 0,
    source_reference_deferred: 0,
    truncated: false,
  };
  if (options.compositionalReader !== undefined && sharedAutomatic === null) {
    audit.truncated = true;
    return { context: '', audit };
  }
  if (!query.trim()) return { context: '', audit };
  const historical = options.mode !== 'current';
  const limit = Math.min(200, Math.max(1, options.limit));
  const found = await engine.search(query, group, {
    limit: Math.min(200, limit * 4),
    minScore: options.minScore,
    acceptedOnly: options.acceptedOnly,
    retrievalFilters: options.filters,
    includeExpired: historical,
    captureMatchEvidence: true,
    hydrationBudget: hydration,
    automaticBudget: automatic,
    ...(options.compositionalReader === undefined
      ? {}
      : { compositionalReader: options.compositionalReader }),
  });
  const combined = [...found.edges];
  if (options.traversal && found.entities.length) {
    let examined = 0;
    const traversal = await new GraphTraverser().traverse(
      storage,
      found.entities.slice(0, 20).map((hit) => hit.entity.uuid),
      {
        maxHops: Math.min(5, options.hops),
        maxEntities: 20,
        includeExpiredEdges: historical,
        entityFilter: (entity) =>
          !options.acceptedOnly ||
          (extractionMetadataFromAttributes(entity.attributes)?.review_status ?? 'accepted') ===
            'accepted',
        edgeFilter: (edge) =>
          ++examined <= 200 &&
          (!options.acceptedOnly ||
            (extractionMetadataFromAttributes(edge.attributes)?.review_status ?? 'accepted') ===
              'accepted'),
      },
    );
    if (examined > 200) audit.truncated = true;
    combined.push(
      ...(await engine.governTraversalEdges(
        traversal.edges.slice(0, 200),
        {
          ...options.filters,
          ...(options.acceptedOnly ? { review_statuses: ['accepted'] } : {}),
        },
        hydration,
        automatic,
        ...(options.compositionalReader === undefined
          ? ([] as const)
          : ([options.compositionalReader] as const)),
      )),
    );
  }
  const unique = new Map<string, (typeof combined)[number]>();
  audit.source_reference_deferred = hydration.deferred;
  if (hydration.deferred) audit.truncated = true;
  for (const hit of combined) {
    audit.candidates++;
    if (unique.has(hit.edge.uuid)) {
      audit.duplicate_uuid++;
      continue;
    }
    unique.set(hit.edge.uuid, hit);
  }
  const stop = new Set([
    'what',
    'when',
    'where',
    'which',
    'that',
    'this',
    'with',
    'about',
    'does',
    'have',
    'today',
    'tomorrow',
    'previously',
    'planned',
    'plan',
    'they',
    'their',
    'were',
    'was',
    'the',
    'for',
    'and',
    'are',
  ]);
  const tokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length > 2 && !stop.has(token));
  const normalizeTerm = (term: string) => {
    const value = term.toLowerCase();
    if (['live', 'lives', 'living', 'reside', 'resides', 'residence', 'residency'].includes(value))
      return 'live';
    if (value.length > 4 && value.endsWith('ies')) return value.slice(0, -3) + 'y';
    if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
    return value;
  };
  const queryTokens = new Set(tokens.map(normalizeTerm));
  const tiers = new Map<string, { relevance: number; temporal: number; provenance: number }>();
  const selected: typeof combined = [];
  const now = options.mode === 'asOf' ? Date.parse(options.at ?? '') : Date.now();
  if (options.mode === 'asOf' && !Number.isFinite(now))
    throw new Error('Engram retrieval: as_of_requires_timestamp');
  for (const hit of unique.values()) {
    const edge = hit.edge;
    // An entity/sender name alone is insufficient relationship relevance.
    const withoutNames = edge.fact
      .toLowerCase()
      .split(hit.sourceEntity.name.toLowerCase())
      .join(' ')
      .split(hit.targetEntity.name.toLowerCase())
      .join(' ');
    const automaticClaim = AutomaticClaimMetadataSchema.safeParse(edge.attributes.engram_claim_v1);
    const wholeLexical =
      getAutonomousPersonalRuntimeLexicalHintV4(hit) ?? getCompositionalRuntimeLexicalHintV3(hit);
    const claimVersion = (edge.attributes.engram_claim_v1 as { version?: unknown } | undefined)
      ?.version;
    const protectedRich = claimVersion === 2 || claimVersion === 3;
    if (protectedRich && (historical || wholeLexical === null)) {
      audit.irrelevant++;
      continue;
    }
    const relationText =
      (wholeLexical?.toLowerCase() ?? withoutNames) +
      ' ' +
      edge.name.toLowerCase().replace(/_/g, ' ') +
      (automaticClaim.success
        ? ' preference ' + automaticClaim.data.claim.literal.toLowerCase()
        : '');
    const lexical = relationText
      .split(/\W+/)
      .some((token) => queryTokens.has(normalizeTerm(token)));
    const nameTerms = new Set(
      (hit.sourceEntity.name + ' ' + hit.targetEntity.name)
        .toLowerCase()
        .split(/\W+/)
        .map(normalizeTerm),
    );
    const meaningfulQuery = [...queryTokens].some((token) => !nameTerms.has(token));
    const semantic = hit.match_evidence?.vector === true && meaningfulQuery;
    const relevant = lexical || semantic;
    if (!relevant) {
      audit.irrelevant++;
      continue;
    }
    const parsedQuality = MemoryQualitySchema.safeParse(edge.attributes.engram_memory_quality);
    const quality = parsedQuality.success ? parsedQuality.data : undefined;
    const temporal = quality?.temporal;
    if (options.mode === 'current' || options.mode === 'asOf') {
      const relative =
        /\b(today|tomorrow|yesterday|later|next\s+(week|month|tuesday|monday|wednesday|thursday|friday|saturday|sunday)|easter|holiday weekend)\b/i.test(
          edge.fact,
        );
      if (temporal?.status === 'resolved') {
        const start = Date.parse(temporal.start ?? ''),
          end = Date.parse(temporal.end ?? '');
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          audit.uncertain_time++;
          continue;
        }
        if (!(start <= now && now < end)) {
          audit.invalid_time++;
          continue;
        }
      } else if (
        temporal?.status === 'uncertain' ||
        relative ||
        ['event_plan', 'commitment'].includes(quality?.category ?? '')
      ) {
        audit.uncertain_time++;
        continue;
      }
      // Existing assertion validity is separate from event time, but a known ended assertion is not current.
      if (
        options.mode === 'current' &&
        (edge.expired_at || (edge.invalid_at && Date.parse(edge.invalid_at) <= now))
      ) {
        audit.invalid_time++;
        continue;
      }
    }
    const provenanceTier = (hit.provenance ?? []).some(
      (source) =>
        ['standard', 'trusted'].includes(source.trust_level ?? '') &&
        source.episode_review_status === 'accepted' &&
        extractionMetadataFromAttributes(edge.attributes)?.review_status === 'accepted' &&
        ['active_human', 'passive_human'].includes(source.episode_kind ?? ''),
    )
      ? 2
      : 0;
    const temporalTier =
      temporal?.status === 'none' ? 3 : temporal?.status === 'resolved' ? 2 : quality ? 1 : 0;
    tiers.set(edge.uuid, {
      relevance: lexical ? 2 : 1,
      temporal: temporalTier,
      provenance: provenanceTier,
    });
    const tag = historical ? 'Historical evidence; event time may be uncertain' : 'Memory evidence';
    if (wholeLexical !== null) selected.push(hit);
    else
      selected.push({
        ...hit,
        edge: {
          ...edge,
          fact: `${edge.fact} [${tag}; category=${quality?.category ?? 'legacy_unknown'}; temporal=${temporal?.status ?? 'unknown'}]`,
        },
      });
  }
  // Origin scores are not summed: retain governed search order, then deterministic traversal UUID order.
  const searchIds = new Set(found.edges.map((hit) => hit.edge.uuid));
  selected.sort(
    (a, b) =>
      tiers.get(b.edge.uuid)!.relevance - tiers.get(a.edge.uuid)!.relevance ||
      tiers.get(b.edge.uuid)!.temporal - tiers.get(a.edge.uuid)!.temporal ||
      tiers.get(b.edge.uuid)!.provenance - tiers.get(a.edge.uuid)!.provenance ||
      Number(searchIds.has(b.edge.uuid)) - Number(searchIds.has(a.edge.uuid)) ||
      (searchIds.has(a.edge.uuid)
        ? found.edges.findIndex((hit) => hit.edge.uuid === a.edge.uuid) -
          found.edges.findIndex((hit) => hit.edge.uuid === b.edge.uuid)
        : a.edge.uuid.localeCompare(b.edge.uuid)),
  );
  const bounded: typeof combined = [];
  for (const hit of selected) {
    const quality = MemoryQualitySchema.safeParse(hit.edge.attributes.engram_memory_quality);
    const bucket =
      quality.success &&
      ['durable_fact', 'preference'].includes(quality.data.category) &&
      quality.data.temporal.status === 'none'
        ? 'durable'
        : 'historical';
    const single = engine.formatAsContextWithAudit(
      { entities: [], edges: [hit] },
      evidenceBudgets[bucket],
      true,
    );
    if (bounded.length >= limit || !single.audit.fact_section.included_ids.length) {
      audit.budget++;
      continue;
    }
    evidenceBudgets[bucket] = Math.max(
      0,
      evidenceBudgets[bucket] - estimateContextTokens(single.context),
    );
    bounded.push(hit);
  }
  const prefix = 'Relevant knowledge from memory:\n';
  const budget =
    options.tokenBudget === undefined
      ? 4096
      : Math.max(0, options.tokenBudget - estimateContextTokens(prefix));
  // Free-text legacy summaries are not silently recast as current facts.
  const rendered = engine.formatAsContextWithAudit({ entities: [], edges: bounded }, budget, true);
  audit.returned = rendered.audit.fact_section.included_ids.length;
  audit.budget += rendered.audit.fact_section.excluded_ids.length;
  return { context: rendered.context ? prefix + rendered.context : '', audit };
}
