import { z } from 'zod';
import { v5 as uuidV5 } from 'uuid';
import { AutomaticBindingReferenceSchema } from './AutomaticMemory.schema';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import {
  CompositionalAutomaticClaimMetadataV2Schema,
  CompositionalAutomaticValueMarkerV2Schema,
} from './CompositionalAutomaticMemory.schema';
import {
  compositionalCaptureBundleHashV3,
  compositionalCaptureMeaningHashV3,
  compositionalCapturePredicateDependenciesV3,
} from './CompositionalAutomaticCaptureV3.schema';
import { canonicalAutomaticCaptureV2 } from './AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { CompositionalBundleDecisionCodeV3Schema as code } from './CompositionalBundleDecisionCodeV3.schema';

// Structural proposals only. These schemas establish neither source entailment,
// current authority, qualified references nor successful durable mutation.
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0);
export const PreparedCompositionalSourceGuardV3Schema = z
  .object({
    version: z.literal(3),
    operationId: uuid,
    sourceId: uuid,
    storeHash: hash,
    namespace: CompositionalCaptureNamespaceV3Schema,
    issuer: text(256),
    actorReference: text(512),
    bindingRef: AutomaticBindingReferenceSchema,
    capturedIdentityHash: hash,
    capturedSourceHash: hash,
    observedSourceHash: hash,
    rawContentHash: hash,
    mappedContentHash: hash,
    originalProducerHash: hash,
    stableProducerHash: hash,
    requestedAuthorityHash: hash,
    envelopeHash: hash,
    descriptorHash: hash,
    settingsHash: hash,
    policyFingerprint: hash,
  })
  .strict();
export type PreparedCompositionalSourceGuardV3 = z.infer<
  typeof PreparedCompositionalSourceGuardV3Schema
>;
const dependency = z
  .object({ predicateIndex: z.number().int().min(0).max(31), dependencyHash: hash })
  .strict();
const common = {
  bundleIndex: z.number().int().min(0).max(31),
  bundleHash: hash,
  meaningHash: hash,
  semanticKey: hash,
  predicateDependencies: z.array(dependency).min(1).max(32),
  codes: z.array(code).min(1).max(8),
};
const ids = { claimId: uuid, valueId: uuid };
export const PreparedCompositionalBundleDecisionV3Schema = z.discriminatedUnion('decision', [
  z.object({ ...common, decision: z.literal('create_accepted'), ...ids }).strict(),
  z.object({ ...common, decision: z.literal('create_proposed'), ...ids }).strict(),
  z
    .object({
      ...common,
      decision: z.literal('reference_accepted'),
      ...ids,
      referenceGuardHash: hash,
    })
    .strict(),
  z
    .object({
      ...common,
      decision: z.literal('reference_proposed'),
      ...ids,
      referenceGuardHash: hash,
    })
    .strict(),
  z
    .object({
      ...common,
      decision: z.literal('reference_rejected'),
      ...ids,
      referenceGuardHash: hash,
    })
    .strict(),
  z.object({ ...common, decision: z.literal('not_selected') }).strict(),
  z
    .object({
      ...common,
      decision: z.literal('reference_prepared'),
      ...ids,
      primaryBundleIndex: z.number().int().min(0).max(31),
      intendedReview: z.enum(['accepted', 'proposed']),
    })
    .strict(),
]);
export type PreparedCompositionalBundleDecisionV3 = z.infer<
  typeof PreparedCompositionalBundleDecisionV3Schema
>;
const metadata = z
  .object({
    version: z.literal(2),
    source: z.literal('policy'),
    confidence: z.null(),
    review_status: z.enum(['accepted', 'proposed']),
    threshold_decision: z.enum(['auto_accepted', 'pending_review']),
    extracted_at: z.string().datetime(),
    episode_uuids: z.tuple([uuid]),
    reviewed_at: z.null(),
    reviewed_by: z.null(),
  })
  .strict();
const valueRow = z
  .object({
    uuid,
    group_id: CompositionalCaptureNamespaceV3Schema,
    name: z.string().min(1).max(65536),
    summary: z.literal(''),
    entity_type: z.literal('compositional_preference_value'),
    name_embedding: z.null(),
    attributes: z
      .object({
        engram_literal_v1: CompositionalAutomaticValueMarkerV2Schema,
        engram_extraction: metadata,
      })
      .strict(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();
const edgeRow = z
  .object({
    uuid,
    group_id: CompositionalCaptureNamespaceV3Schema,
    source_node_uuid: uuid,
    target_node_uuid: uuid,
    name: z.literal('PREFERS'),
    fact: z.string().min(1).max(65536),
    fact_embedding: z.null(),
    episodes: z.tuple([uuid]),
    valid_at: z.null(),
    invalid_at: z.null(),
    expired_at: z.null(),
    attributes: z
      .object({
        engram_claim_v1: CompositionalAutomaticClaimMetadataV2Schema,
        engram_extraction: metadata,
      })
      .strict(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();
const body = z
  .object({
    version: z.literal(3),
    kind: z.literal('prepared_compositional_materialization'),
    sourceGuard: PreparedCompositionalSourceGuardV3Schema,
    snapshotHash: hash,
    planTimestamp: z.string().datetime(),
    items: z.array(PreparedCompositionalBundleDecisionV3Schema).min(1).max(32),
    createEntities: z.array(valueRow).max(32),
    createEdges: z.array(edgeRow).max(32),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const guard = plan.sourceGuard;
    const edges = new Map(plan.createEdges.map((e) => [e.uuid, e]));
    const values = new Map(plan.createEntities.map((e) => [e.uuid, e]));
    if (edges.size !== plan.createEdges.length || values.size !== plan.createEntities.length)
      fail('Duplicate proposed row identity');
    const allIds = [...edges.keys(), ...values.keys()];
    if (
      new Set(allIds).size !== allIds.length ||
      allIds.includes(guard.sourceId) ||
      allIds.includes(guard.bindingRef.subjectId)
    )
      fail('Cross-category identity collision');
    const groups = new Map<string, PreparedCompositionalBundleDecisionV3[]>();
    const keys = new Map<string, string>();
    let predicates = 0;
    let semanticNodes = 0;
    let semanticEdges = 0;
    const usedEdges = new Set<string>();
    const usedValues = new Set<string>();
    for (const [index, item] of plan.items.entries()) {
      if (item.bundleIndex !== index) fail('Bundle indexes must be contiguous source order');
      if (item.predicateDependencies.some((dep, i) => dep.predicateIndex !== i))
        fail('Predicate dependencies must be complete contiguous order');
      predicates += item.predicateDependencies.length;
      if (new Set(item.codes).size !== item.codes.length) fail('Duplicate decision code');
      const oldMeaning = keys.get(item.semanticKey);
      if (oldMeaning && oldMeaning !== item.meaningHash) fail('Semantic key meaning collision');
      keys.set(item.semanticKey, item.meaningHash);
      groups.set(item.meaningHash, [...(groups.get(item.meaningHash) ?? []), item]);
      if ('claimId' in item) {
        const expectedClaim = uuidV5(
          canonicalAutomaticCaptureV2({
            domain: 'engram-compositional-claim-row-v2',
            key: item.semanticKey,
          }),
          uuidV5.URL,
        );
        const expectedValue = uuidV5(
          canonicalAutomaticCaptureV2({
            domain: 'engram-compositional-value-row-v2',
            key: item.semanticKey,
          }),
          uuidV5.URL,
        );
        if (item.claimId !== expectedClaim || item.valueId !== expectedValue)
          fail('Proposed/reference IDs must match deterministic semantic IDs');
      }
      if (item.decision === 'reference_prepared') {
        const primary = plan.items[item.primaryBundleIndex];
        if (
          item.primaryBundleIndex >= index ||
          !primary ||
          (primary.decision !== 'create_accepted' && primary.decision !== 'create_proposed') ||
          primary.meaningHash !== item.meaningHash ||
          primary.semanticKey !== item.semanticKey ||
          canonicalAutomaticCaptureV2(primary.predicateDependencies) !==
            canonicalAutomaticCaptureV2(item.predicateDependencies) ||
          primary.claimId !== item.claimId ||
          primary.valueId !== item.valueId ||
          item.intendedReview !== (primary.decision === 'create_accepted' ? 'accepted' : 'proposed')
        )
          fail('Invalid backward prepared reference');
        if (
          primary &&
          (primary.decision === 'create_accepted' || primary.decision === 'create_proposed')
        ) {
          const primaryClaim = edges.get(primary.claimId)?.attributes.engram_claim_v1;
          if (primaryClaim) {
            semanticNodes += primaryClaim.bundle.members.length;
            semanticEdges += primaryClaim.bundle.attachments.length;
          }
        }
      }
      if (item.decision !== 'create_accepted' && item.decision !== 'create_proposed') continue;
      const edge = edges.get(item.claimId);
      const value = values.get(item.valueId);
      if (!edge || !value) {
        fail('Missing exact creation rows');
        continue;
      }
      usedEdges.add(edge.uuid);
      usedValues.add(value.uuid);
      const claim = edge.attributes.engram_claim_v1;
      semanticNodes += claim.bundle.members.length;
      semanticEdges += claim.bundle.attachments.length;
      const review = item.decision === 'create_accepted' ? 'accepted' : 'proposed';
      if (review === 'accepted' && !claim.policy.autoAccept)
        fail('Captured policy prohibits accepted creation');
      if (
        claim.key !== item.semanticKey ||
        compositionalCaptureBundleHashV3(claim.bundle) !== item.bundleHash ||
        compositionalCaptureMeaningHashV3(claim.meaning) !== item.meaningHash ||
        canonicalAutomaticCaptureV2(compositionalCapturePredicateDependenciesV3(claim.meaning)) !==
          canonicalAutomaticCaptureV2(item.predicateDependencies)
      )
        fail('Creation requires exact complete bundle meaning and dependencies');
      if (
        claim.namespace !== guard.namespace ||
        claim.sourceId !== guard.sourceId ||
        claim.subjectId !== guard.bindingRef.subjectId ||
        claim.issuer !== guard.issuer ||
        claim.actorReference !== guard.actorReference ||
        canonicalAutomaticCaptureV2(claim.binding) !==
          canonicalAutomaticCaptureV2(guard.bindingRef) ||
        claim.policy.fingerprint !== guard.policyFingerprint
      )
        fail('Creation claim source guard mismatch');
      if (
        edge.source_node_uuid !== guard.bindingRef.subjectId ||
        edge.target_node_uuid !== value.uuid ||
        edge.group_id !== guard.namespace ||
        value.group_id !== guard.namespace ||
        edge.episodes[0] !== guard.sourceId ||
        value.attributes.engram_literal_v1.key !== item.semanticKey ||
        value.name !== edge.fact ||
        edge.fact !== claim.bundle.evidence.lexicalForm
      )
        fail('Creation evidence/endpoints mismatch');
      for (const row of [edge, value]) {
        const meta = row.attributes.engram_extraction;
        if (
          row.created_at !== plan.planTimestamp ||
          row.updated_at !== plan.planTimestamp ||
          meta.extracted_at !== plan.planTimestamp ||
          meta.episode_uuids[0] !== guard.sourceId ||
          meta.review_status !== review ||
          meta.threshold_decision !== (review === 'accepted' ? 'auto_accepted' : 'pending_review')
        )
          fail('Creation metadata/time mismatch');
      }
    }
    if (predicates > 32) fail('Global predicate capacity exceeded');
    if (semanticNodes > 128 || semanticEdges > 128)
      fail('Global semantic structure capacity exceeded');
    if (usedEdges.size !== edges.size || usedValues.size !== values.size)
      fail('Orphan proposed row');
    for (const group of groups.values()) {
      const first = group[0];
      if (
        group.some(
          (item) =>
            canonicalAutomaticCaptureV2(item.predicateDependencies) !==
            canonicalAutomaticCaptureV2(first.predicateDependencies),
        )
      )
        fail('Duplicate whole meanings require identical predicate dependencies');
      if (group.some((item) => item.semanticKey !== first.semanticKey))
        fail('Duplicate meaning key mismatch');
      if (first.decision === 'not_selected') {
        if (group.some((item) => item.decision !== 'not_selected'))
          fail('Duplicate group cannot mix selected/unselected');
      } else if (first.decision === 'create_accepted' || first.decision === 'create_proposed') {
        if (
          group
            .slice(1)
            .some(
              (item) =>
                item.decision !== 'reference_prepared' ||
                item.primaryBundleIndex !== first.bundleIndex,
            )
        )
          fail('Duplicate creation requires one primary');
      } else if (
        first.decision === 'reference_prepared' ||
        group.some(
          (item) =>
            item.decision !== first.decision ||
            !('claimId' in item) ||
            !('claimId' in first) ||
            item.claimId !== first.claimId ||
            item.valueId !== first.valueId ||
            !('referenceGuardHash' in item) ||
            !('referenceGuardHash' in first) ||
            item.referenceGuardHash !== first.referenceGuardHash,
        )
      )
        fail('Duplicate references require uniform actual state and proof');
    }
  });

export const CompositionalMaterializationPreparedV3Schema = z
  .unknown()
  .transform((value, ctx) => {
    try {
      return cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid bounded compositional preparation',
      });
      return z.NEVER;
    }
  })
  .pipe(body);
export type CompositionalMaterializationPreparedV3 = z.infer<
  typeof CompositionalMaterializationPreparedV3Schema
>;
