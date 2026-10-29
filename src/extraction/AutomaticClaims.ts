import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { z } from 'zod';
import { ExtractionBudgetError } from './ExtractionDiagnostics';
import { v5 as uuid } from 'uuid';
import {
  type GraphData,
  type StagedExtraction,
  type ExtractionOutcome,
  type EntityNode,
  type EntityEdge,
  extractionMetadataFromAttributes,
  EntityNodeSchema,
  EntityEdgeSchema,
} from '../schemas';
import {
  AutomaticSourceEnvelopeSchema,
  type AutomaticPolicy,
} from '../schemas/AutomaticMemory.schema';
import {
  AutomaticClaimMetadataSchema,
  AutomaticReceiptSchema,
  type AutomaticReceipt,
} from '../schemas/AutomaticClaim.schema';
import {
  AutomaticClaimCommitProofSchema,
  AutomaticClaimReadContextSchema,
  type AutomaticClaimReadContext,
} from '../schemas/AutomaticClaimRead.schema';
import { compileAutomaticPolicy, parseAutomaticPreferences } from './AutomaticEvidence';
import {
  assertAutomaticBinding,
  automaticCaptureOperationIdentityForOwnedSource,
  prepareAutomaticEpisodeInput,
  reconcileAutomaticCaptureOperationIdentity,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../storage/AutomaticIdentity';
import {
  boundedAutomaticClaimReadJsonBytes,
  projectAutomaticClaimReadContext,
} from './AutomaticClaimCommitProof';
import { canonical, fingerprint, graphFingerprint, sourceFingerprint } from './QueueState';

export const AUTOMATIC_ENVELOPE = 'engram_source_envelope_v1';
export const AUTOMATIC_CLAIM = 'engram_claim_v1';
export const AUTOMATIC_OWNER = 'engram_write_owner_v1';
const hashText = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const stableId = (key: unknown) => uuid(canonical(key), uuid.URL);

/** Validates literal source evidence and current binding, without requiring a commit. */
export function validateAutomaticClaimEvidence(
  graph: GraphData,
  edge: EntityEdge,
  check: () => void = () => {},
  historicalEvidence = false,
): boolean {
  try {
    check();
    const meta = AutomaticClaimMetadataSchema.parse(edge.attributes[AUTOMATIC_CLAIM]);
    const source = graph.episodes.find(
      (ep) => ep.uuid === meta.sourceId && ep.group_id === edge.group_id,
    );
    if (
      !source ||
      source.role !== 'human' ||
      !['active_human', 'passive_human'].includes(source.episode_kind) ||
      source.review_status !== 'accepted' ||
      !['standard', 'trusted'].includes(source.trust_level) ||
      source.quoted_message_id
    )
      return false;
    prepareAutomaticEpisodeInput(source);
    const envelope = AutomaticSourceEnvelopeSchema.parse(source.attributes[AUTOMATIC_ENVELOPE]);
    if (
      envelope.namespace !== edge.group_id ||
      hashText(source.content) !== envelope.rawContentHash ||
      canonical(meta.binding) !== canonical(envelope.bindingRef) ||
      meta.issuer !== envelope.issuer ||
      meta.actorReference !== envelope.actorReference ||
      canonical(meta.policy) !== canonical(envelope.policy)
    )
      return false;
    if (!historicalEvidence) assertAutomaticBinding(graph, envelope, check);
    const parsed = parseAutomaticPreferences(
      envelope,
      source.content.slice(envelope.humanRegion.start, envelope.humanRegion.end),
    );
    if (!parsed.claims.some((claim) => canonical(claim) === canonical(meta.claim))) return false;
    const valueKey = [
      'literal-preference-v1',
      edge.group_id,
      'preference_value',
      meta.claim.languageTag,
      meta.claim.literal,
    ];
    const key = fingerprint([...valueKey, envelope.bindingRef.subjectId, meta.claim.polarity]);
    const target = graph.entities.find(
      (entity) => entity.uuid === edge.target_node_uuid && entity.group_id === edge.group_id,
    );
    return (
      meta.key === key &&
      meta.subjectId === envelope.bindingRef.subjectId &&
      edge.uuid === stableId(['attributed-preference-v1', key]) &&
      edge.source_node_uuid === meta.subjectId &&
      edge.target_node_uuid === stableId(valueKey) &&
      target?.name === meta.claim.literal &&
      target.entity_type === 'preference_value' &&
      edge.name === 'PREFERS' &&
      edge.fact === meta.claim.clause &&
      edge.episodes.includes(source.uuid) &&
      extractionMetadataFromAttributes(edge.attributes)?.episode_uuids.includes(source.uuid) ===
        true
    );
  } catch (error) {
    if (error instanceof ExtractionBudgetError) throw error;
    return false;
  }
}

/** Verifies a capability-returned context, including the committed source dependency. */
export function validateAutomaticClaimReadContext(
  candidate: EntityEdge,
  suppliedContext: AutomaticClaimReadContext,
  check: () => void = () => {},
  historicalEvidence = false,
): boolean {
  try {
    check();
    if (boundedAutomaticClaimReadJsonBytes(suppliedContext, 512 * 1024) > 512 * 1024) return false;
    const parsed = AutomaticClaimReadContextSchema.safeParse(suppliedContext);
    if (!parsed.success) return false;
    const context = parsed.data;
    if (canonical(context.edge) !== canonical(candidate)) return false;
    const proofResult = AutomaticClaimCommitProofSchema.safeParse(context.proof);
    if (!proofResult.success) return false;
    const { proof } = context;
    if (proof.identity.purpose !== 'human_turn_memory') return false;
    if (
      proof.identity.sourceId !== context.source.uuid ||
      proof.identity.namespace !== candidate.group_id ||
      proof.identity.binding.subjectId !== context.subject.uuid
    )
      return false;
    const sourceIdentity = automaticCaptureOperationIdentityForOwnedSource(
      context.source,
      proof.descriptor,
    );
    if (!reconcileAutomaticCaptureOperationIdentity(sourceIdentity, proof.identity)) return false;
    const envelope = AutomaticSourceEnvelopeSchema.parse(
      context.source.attributes[AUTOMATIC_ENVELOPE],
    );
    if (
      canonical(proof.identity.binding) !== canonical(envelope.bindingRef) ||
      envelope.namespace !== candidate.group_id ||
      proof.identity.issuer !== envelope.issuer ||
      proof.identity.actorReference !== envelope.actorReference
    ) {
      return false;
    }
    const terminal = proof.terminalReceipt;
    if (terminal.kind !== 'human_capture_committed') return false;
    const matching = terminal.dependencies.filter(
      (dependency) =>
        dependency.sourceId === context.source.uuid && dependency.claimId === context.edge.uuid,
    );
    if (matching.length !== 1) return false;
    const dependency = matching[0];
    const item = terminal.receipt.items[dependency.itemIndex];
    if (
      !item ||
      item.claimId !== context.edge.uuid ||
      item.state !== dependency.state ||
      item.persisted !== dependency.persisted ||
      canonical(item.reasons) !== canonical(dependency.reasons) ||
      !item.persisted ||
      !['accepted', 'proposed', 'rejected', 'unchanged'].includes(item.state)
    ) {
      return false;
    }
    const graph: GraphData = {
      version: '2.0',
      exported_at: new Date().toISOString(),
      group_id: candidate.group_id,
      entities: [context.subject, context.value],
      episodes: [context.source],
      edges: [context.edge],
    };
    return validateAutomaticClaimEvidence(graph, candidate, check, historicalEvidence);
  } catch (error) {
    if (error instanceof ExtractionBudgetError) throw error;
    return false;
  }
}

/** Persisted V2 claims require an actual committed V2 human operation in the graph root. */
export function validateStoredAutomaticClaim(
  graph: GraphData,
  edge: EntityEdge,
  check: () => void = () => {},
  historicalEvidence = false,
): boolean {
  try {
    check();
    const parsed = AutomaticClaimMetadataSchema.safeParse(edge.attributes[AUTOMATIC_CLAIM]);
    if (!parsed.success) return false;
    const source = graph.episodes.find(
      (episode) => episode.uuid === parsed.data.sourceId && episode.group_id === edge.group_id,
    );
    if (!source) return false;
    if (source.attributes[WRITE_OWNER_V2_ATTRIBUTE] === undefined) {
      return validateAutomaticClaimEvidence(graph, edge, check, historicalEvidence);
    }
    const projected = projectAutomaticClaimReadContext(graph, edge.group_id, edge.uuid);
    return (
      projected.status === 'committed' &&
      validateAutomaticClaimReadContext(edge, projected.context, check, historicalEvidence)
    );
  } catch (error) {
    if (error instanceof ExtractionBudgetError) throw error;
    return false;
  }
}

/** Builds only literal, source-grounded claims. No provider call or live write occurs here. */
export function planAutomaticClaims(
  graph: GraphData,
  group: string,
  sourceIds: string[],
  policy: AutomaticPolicy,
  baseOutcome: ExtractionOutcome,
  timestamp = new Date().toISOString(),
  workCheck?: () => void,
): StagedExtraction {
  const expires = performance.now() + 30000;
  const check =
    workCheck ??
    (() => {
      if (performance.now() >= expires) throw new ExtractionBudgetError('deadline');
    });
  check();
  if (graph.entities.length + graph.edges.length + graph.episodes.length > 100000)
    throw new ExtractionBudgetError('snapshot_limit');
  let snapshotBytes = 0;
  for (const item of [...graph.entities, ...graph.edges, ...graph.episodes]) {
    check();
    snapshotBytes += Buffer.byteLength(JSON.stringify(item));
    if (snapshotBytes > 100 * 1024 * 1024) throw new ExtractionBudgetError('snapshot_limit');
  }
  const compiled = compileAutomaticPolicy({ profileId: policy.profileId });
  if (policy.profileId === 'existing' || canonical(compiled) !== canonical(policy))
    throw new Error('Engram automatic: unsupported_policy');
  if (!sourceIds.length || sourceIds.length > 32 || new Set(sourceIds).size !== sourceIds.length)
    throw new Error('Engram automatic: source_limit');
  const entities: EntityNode[] = [],
    edges: EntityEdge[] = [];
  const outcome: ExtractionOutcome = JSON.parse(JSON.stringify(baseOutcome));
  const receipt: AutomaticReceipt = {
    version: 1,
    policy,
    sourceIds,
    persisted: false,
    commitAt: null,
    items: [],
    coverageComplete: true,
  };
  let hydrated = 0;
  let conflictScans = 0;
  let sourceBytes = 0;
  let extensionBytes = 0;
  for (const sourceId of sourceIds) {
    check();
    const source = graph.episodes.find((ep) => ep.uuid === sourceId && ep.group_id === group);
    if (
      !source ||
      source.role !== 'human' ||
      !['active_human', 'passive_human'].includes(source.episode_kind) ||
      !['standard', 'trusted'].includes(source.trust_level) ||
      source.review_status !== 'accepted' ||
      source.quoted_message_id
    )
      throw new Error('Engram automatic: invalid_source');
    prepareAutomaticEpisodeInput(source);
    sourceBytes += Buffer.byteLength(source.content);
    if (sourceBytes > 65536) throw new ExtractionBudgetError('source_bytes');
    extensionBytes += Buffer.byteLength(
      JSON.stringify({
        envelope: source.attributes[AUTOMATIC_ENVELOPE],
        owner: source.attributes[AUTOMATIC_OWNER],
      }),
    );
    const envelope = AutomaticSourceEnvelopeSchema.parse(source.attributes[AUTOMATIC_ENVELOPE]);
    if (
      envelope.namespace !== group ||
      canonical(envelope.policy) !== canonical(policy) ||
      hashText(source.content) !== envelope.rawContentHash ||
      Buffer.byteLength(source.content) > 65536
    )
      throw new Error('Engram automatic: source_changed');
    assertAutomaticBinding(graph, envelope, check);
    const content = source.content.slice(envelope.humanRegion.start, envelope.humanRegion.end);
    const parsed = parseAutomaticPreferences(envelope, content);
    if (!parsed.claims.length) {
      receipt.items.push({
        state: 'not_selected',
        persisted: false,
        mutation: 'none',
        reasons: parsed.reasons.length ? parsed.reasons : ['not_selected'],
      });
      outcome.counts.filtered++;
      continue;
    }
    for (const claim of parsed.claims) {
      check();
      if (receipt.items.length >= 32) throw new Error('Engram automatic: claim_limit');
      const valueKey = [
        'literal-preference-v1',
        group,
        'preference_value',
        claim.languageTag,
        claim.literal,
      ];
      const targetId = stableId(valueKey);
      const key = fingerprint([...valueKey, envelope.bindingRef.subjectId, claim.polarity]);
      const edgeId = stableId(['attributed-preference-v1', key]);
      const prior = [...graph.edges, ...edges].find((edge) => edge.uuid === edgeId);
      if (prior) {
        const priorClaim = AutomaticClaimMetadataSchema.safeParse(
          prior.attributes[AUTOMATIC_CLAIM],
        );
        const validationGraph = {
          ...graph,
          entities: [...graph.entities, ...entities],
          edges: [...graph.edges, ...edges],
        };
        const priorValid = graph.edges.includes(prior)
          ? validateStoredAutomaticClaim(validationGraph, prior, check)
          : validateAutomaticClaimEvidence(validationGraph, prior, check);
        if (
          !priorClaim.success ||
          priorClaim.data.key !== key ||
          prior.group_id !== group ||
          !priorValid
        )
          throw new Error('Engram automatic: identity_collision');
        const review = extractionMetadataFromAttributes(prior.attributes)?.review_status;
        if (!review) throw new Error('Engram automatic: missing_claim_review');
        receipt.items.push({
          claimId: prior.uuid,
          state:
            review === 'rejected' ? 'rejected' : review === 'proposed' ? 'proposed' : 'unchanged',
          persisted: true,
          mutation: 'none',
          reasons: ['existing_claim'],
        });
        outcome.counts.unchanged++;
        continue;
      }
      const candidates = [...graph.edges, ...edges].filter((edge) => {
        check();
        if (
          edge.group_id !== group ||
          edge.source_node_uuid !== envelope.bindingRef.subjectId ||
          edge.target_node_uuid !== targetId ||
          edge.attributes[AUTOMATIC_CLAIM] === undefined
        )
          return false;
        if (++conflictScans > 128) throw new ExtractionBudgetError('conflict_limit');
        return true;
      });
      const references = candidates.reduce(
        (total, edge) =>
          total +
          new Set([
            ...edge.episodes,
            ...(extractionMetadataFromAttributes(edge.attributes)?.episode_uuids ?? []),
          ]).size,
        0,
      );
      hydrated += references;
      if (references > 8 || hydrated > 512) throw new ExtractionBudgetError('conflict_limit');
      const conflict = candidates.some((edge) => {
        const other = AutomaticClaimMetadataSchema.safeParse(edge.attributes[AUTOMATIC_CLAIM]);
        return (
          other.success &&
          (graph.edges.includes(edge)
            ? validateStoredAutomaticClaim(
                { ...graph, entities: [...graph.entities, ...entities] },
                edge,
                check,
              )
            : validateAutomaticClaimEvidence(
                {
                  ...graph,
                  entities: [...graph.entities, ...entities],
                  edges: [...graph.edges, ...edges],
                },
                edge,
                check,
              )) &&
          other.data.claim.polarity !== claim.polarity &&
          extractionMetadataFromAttributes(edge.attributes)?.review_status !== 'rejected'
        );
      });
      const existingTarget = graph.entities.find((entity) => entity.uuid === targetId);
      const targetReview = existingTarget
        ? extractionMetadataFromAttributes(existingTarget.attributes)?.review_status
        : undefined;
      const accepted =
        policy.autoAccept && !conflict && (!existingTarget || targetReview === 'accepted');
      const metadata = {
        version: 2,
        source: 'policy',
        confidence: null,
        review_status: accepted ? 'accepted' : 'proposed',
        threshold_decision: accepted ? 'auto_accepted' : 'pending_review',
        extracted_at: timestamp,
        episode_uuids: [sourceId],
        reviewed_at: null,
        reviewed_by: null,
      };
      const quality = {
        version: 1,
        category: 'preference',
        policy: 'durableTemporal',
        evidence: [
          { source_id: sourceId, start: claim.rawClauseSpan.start, end: claim.rawClauseSpan.end },
        ],
        temporal: { status: 'none', source_times: [source.reference_time], timezone: null },
      };
      const claimMetadata = AutomaticClaimMetadataSchema.parse({
        version: 1,
        generation: 'literal-parser-v1',
        subjectId: envelope.bindingRef.subjectId,
        binding: envelope.bindingRef,
        issuer: envelope.issuer,
        actorReference: envelope.actorReference,
        policy,
        claim,
        sourceId,
        key,
      });
      const target = [...graph.entities, ...entities].find((entity) => entity.uuid === targetId);
      if (
        target &&
        (target.group_id !== group ||
          target.entity_type !== 'preference_value' ||
          target.name !== claim.literal)
      )
        throw new Error('Engram automatic: identity_collision');
      if (!target) {
        entities.push(
          EntityNodeSchema.parse({
            uuid: targetId,
            group_id: group,
            name: claim.literal,
            entity_type: 'preference_value',
            summary: '',
            created_at: timestamp,
            updated_at: timestamp,
            attributes: {
              engram_extraction: metadata,
              engram_memory_quality: quality,
              engram_literal_v1: {
                version: 1,
                languageTag: claim.languageTag,
                literal: claim.literal,
                key: fingerprint(valueKey),
              },
            },
          }),
        );
        outcome.counts.entities_created++;
      }
      edges.push(
        EntityEdgeSchema.parse({
          uuid: edgeId,
          group_id: group,
          source_node_uuid: envelope.bindingRef.subjectId,
          target_node_uuid: targetId,
          name: 'PREFERS',
          fact: claim.clause,
          episodes: [sourceId],
          created_at: timestamp,
          updated_at: timestamp,
          attributes: {
            engram_extraction: metadata,
            engram_memory_quality: quality,
            [AUTOMATIC_CLAIM]: claimMetadata,
          },
        }),
      );
      outcome.counts.edges_created++;
      receipt.items.push({
        claimId: edgeId,
        state: accepted ? 'accepted' : 'proposed',
        persisted: false,
        mutation: 'pending',
        reasons: [conflict ? 'conflicting_claim' : accepted ? 'selected' : 'review_required'],
      });
    }
  }
  outcome.automatic = AutomaticReceiptSchema.parse(receipt);
  extensionBytes += Buffer.byteLength(JSON.stringify(receipt));
  for (const item of [...entities, ...edges])
    extensionBytes += Buffer.byteLength(
      JSON.stringify({
        claim: item.attributes[AUTOMATIC_CLAIM],
        literal: item.attributes.engram_literal_v1,
      }),
    );
  if (extensionBytes > 32 * 1024) throw new ExtractionBudgetError('metadata_bytes');
  check();
  return {
    version: 1,
    group_id: group,
    graph_hash: graphFingerprint(graph, group),
    source_guards: sourceIds.map((id) => ({
      uuid: id,
      hash: sourceFingerprint(graph.episodes.find((ep) => ep.uuid === id)!),
    })),
    entities,
    edges,
    outcome,
  };
}

/** Rebuild using a trusted plan timestamp; claim attributes cannot choose their own validator. */
export function validateAutomaticPlanAt(
  graph: GraphData,
  plan: StagedExtraction,
  timestamp: string,
): boolean {
  if (!z.string().datetime().safeParse(timestamp).success)
    throw new Error('Engram automatic: invalid_plan');
  const sources = plan.source_guards.map((guard) =>
    graph.episodes.find((ep) => ep.uuid === guard.uuid && ep.group_id === plan.group_id),
  );
  const hasEnvelope = sources.some(
    (source) => source?.attributes[AUTOMATIC_ENVELOPE] !== undefined,
  );
  if (!hasEnvelope) {
    if (
      plan.outcome.automatic ||
      [...plan.entities, ...plan.edges].some(
        (item) =>
          item.attributes[AUTOMATIC_CLAIM] ||
          extractionMetadataFromAttributes(item.attributes)?.source === 'policy',
      )
    )
      throw new Error('Engram automatic: missing_source_authority');
    return false;
  }
  if (plan.outcome.error_count || plan.outcome.errors.length || plan.outcome.status !== 'succeeded')
    throw new Error('Engram automatic: failed_plan');
  const first = AutomaticSourceEnvelopeSchema.parse(sources[0]?.attributes[AUTOMATIC_ENVELOPE]);
  if (!first.policy) throw new Error('Engram automatic: missing_policy');
  const empty: ExtractionOutcome = {
    ...plan.outcome,
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
  };
  const expected = planAutomaticClaims(
    graph,
    plan.group_id,
    plan.source_guards.map((guard) => guard.uuid),
    first.policy,
    empty,
    timestamp,
  );
  if (
    canonical(expected.entities) !== canonical(plan.entities) ||
    canonical(expected.edges) !== canonical(plan.edges) ||
    canonical(expected.outcome.automatic) !== canonical(plan.outcome.automatic) ||
    canonical(expected.outcome.counts) !== canonical(plan.outcome.counts)
  )
    throw new Error('Engram automatic: invalid_plan');
  return true;
}

/** Preserve the V1 API's timestamp inference for existing callers. */
export function validateAutomaticPlan(graph: GraphData, plan: StagedExtraction): boolean {
  const timestamp =
    plan.edges[0]?.created_at ?? plan.entities[0]?.created_at ?? new Date().toISOString();
  return validateAutomaticPlanAt(graph, plan, timestamp);
}

export function committedAutomaticReceipt(outcome: ExtractionOutcome, timestamp: string): void {
  if (!outcome.automatic) return;
  outcome.automatic.persisted = true;
  outcome.automatic.commitAt = timestamp;
  for (const item of outcome.automatic.items)
    if (item.mutation === 'pending') {
      item.persisted = true;
      item.mutation = 'created';
    }
}

export function failedAutomaticReceipt(outcome: ExtractionOutcome): void {
  if (!outcome.automatic) return;
  outcome.automatic.persisted = false;
  outcome.automatic.commitAt = null;
  for (const item of outcome.automatic.items)
    if (item.mutation === 'pending') {
      item.persisted = false;
      item.mutation = 'none';
      item.state = 'deferred';
      item.reasons = ['interrupted'];
    }
}
