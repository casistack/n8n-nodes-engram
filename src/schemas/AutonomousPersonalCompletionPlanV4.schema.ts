import { z } from 'zod';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EntityNodeSchema } from './EntityNode.schema';
import {
  AutonomousPersonalCaptureBoundScopeV4OwnedDataSchema,
  AutonomousPersonalCaptureStagedFreshV4OwnedDataSchema,
} from './AutonomousPersonalCaptureBeginV4.schema';
import {
  AutonomousPersonalTerminalOperationAuditV4OwnedDataSchema,
  type AutonomousPersonalTerminalOperationV4,
} from './AutonomousPersonalTerminalOperationV4.schema';
import { AutonomousPersonalOperationV4OwnedDataSchema } from './AutonomousPersonalOperationV4.schema';
import {
  AutonomousPersonalClaimV3OwnedDataSchema,
  AutonomousPersonalValueMarkerV3OwnedDataSchema,
  hashAutonomousPersonalClaimKeyV3,
  hashAutonomousPersonalClaimMeaningV3,
  hashAutonomousPersonalPredicateDependencyV1,
} from './AutonomousPersonalClaimV3.schema';
import { ExtractionMetadataV2Schema } from './ExtractionMetadata.schema';
import { canonicalAutomaticCaptureV2 } from './AutomaticCapture.schema';
import { deriveAutonomousPersonalRecordIdsV1 } from '../storage/AutonomousPersonalRecordIdsV1';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from './AutonomousPersonalPolicyV3.schema';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const canonicalUtcMilliseconds = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  });
const same = (left: unknown, right: unknown) =>
  canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);

export const AutonomousPersonalCompletionPlanV4OutcomeOwnedDataSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('response') }).strict(),
    z
      .object({
        kind: z.literal('deferred'),
        reason: z.enum([
          'provider_invalid_request',
          'provider_auth',
          'provider_rate_limit',
          'provider_unavailable',
          'provider_network',
          'provider_invalid_response',
          'provider_subdeadline',
          'provider_request_bytes',
          'provider_response_bytes',
          'interpretation_capacity',
        ]),
      })
      .strict(),
    z
      .object({
        kind: z.literal('no_dispatch'),
        reason: z.enum([
          'empty_source',
          'policy_not_selected',
          'source_indeterminate',
          'source_resource',
          'unit_count',
          'typed_metadata',
          'aggregate',
        ]),
      })
      .strict(),
  ],
);

/** Strict caller DATA only. It does not contain provider or graph evidence. */
export const AutonomousPersonalCompletionPlanV4InputOwnedDataSchema = z
  .object({
    scope: AutonomousPersonalCaptureBoundScopeV4OwnedDataSchema,
    stagedFresh: AutonomousPersonalCaptureStagedFreshV4OwnedDataSchema,
    outcome: AutonomousPersonalCompletionPlanV4OutcomeOwnedDataSchema,
    backendNow: canonicalUtcMilliseconds,
    completionCallHash: hash,
    audit: AutonomousPersonalTerminalOperationAuditV4OwnedDataSchema,
  })
  .strict();

export type AutonomousPersonalCompletionPlanV4Input = z.infer<
  typeof AutonomousPersonalCompletionPlanV4InputOwnedDataSchema
>;

const referenceGuardSchema = z
  .object({
    claimId: uuid,
    valueId: uuid,
    sourceId: uuid,
    operationId: uuid,
    key: hash,
    meaningHash: hash,
    reviewState: z.enum(['accepted', 'proposed', 'rejected']),
    occurrenceIndexes: z.array(z.number().int().safe().min(0).max(31)).min(1).max(32),
    claimRowHash: hash,
    valueRowHash: hash,
    sourceRowHash: hash,
    operationRowHash: hash,
  })
  .strict()
  .superRefine((guard, context) => {
    if (
      new Set([guard.claimId, guard.valueId, guard.sourceId, guard.operationId]).size !== 4 ||
      guard.occurrenceIndexes.some(
        (value, index) => index > 0 && value <= guard.occurrenceIndexes[index - 1]!,
      )
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid reference guard DATA' });
    }
  });

export type AutonomousPersonalCompletionPlanV4ReferenceGuard = z.infer<typeof referenceGuardSchema>;

const committedOperation = AutonomousPersonalOperationV4OwnedDataSchema.refine(
  (operation): operation is AutonomousPersonalTerminalOperationV4 =>
    operation.state === 'committed',
);

const createdEntity = EntityNodeSchema.strict();
const createdEdge = EntityEdgeSchema.strict();
const planned = z
  .object({
    kind: z.literal('planned'),
    createEntities: z.array(createdEntity).max(32),
    createEdges: z.array(createdEdge).max(32),
    operation: committedOperation,
    referenceGuards: z.array(referenceGuardSchema).max(32),
  })
  .strict();

function validatePlanned(plan: z.infer<typeof planned>, context: z.RefinementCtx): void {
  const invalid = (path: Array<string | number>, message: string) =>
    context.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (plan.createEntities.length !== plan.createEdges.length) {
    invalid(['createEdges'], 'Created Claim3 edges and value entities must be paired');
  }

  const receipt = plan.operation.terminalReceipt;
  if (
    receipt.kind === 'cancelled' ||
    receipt.kind === 'human_autonomous_source_verdict_committed' ||
    receipt.kind === 'human_autonomous_source_deferred_committed'
  ) {
    if (
      plan.createEntities.length > 0 ||
      plan.createEdges.length > 0 ||
      plan.referenceGuards.length > 0
    ) {
      invalid([], 'Source-only terminal operations cannot carry Claim3 rows or references');
    }
    return;
  }

  if (
    plan.createEntities.length > receipt.selection.items.length ||
    plan.referenceGuards.length > receipt.selection.items.length
  ) {
    invalid([], 'The candidate plan exceeds its complete occurrence receipt');
  }

  const entityById = new Map<string, z.infer<typeof createdEntity>>();
  for (const [index, entity] of plan.createEntities.entries()) {
    if (entityById.has(entity.uuid)) invalid(['createEntities', index, 'uuid'], 'Duplicate ID');
    entityById.set(entity.uuid, entity);
  }
  const edgeIds = new Set<string>();
  const createdItemsByClaim = new Map<
    string,
    Array<{ item: (typeof receipt.selection.items)[number]; index: number }>
  >();
  const referenceIndexesByClaim = new Map<string, number[]>();
  for (const [index, item] of receipt.selection.items.entries()) {
    if (item.effect === 'created') {
      if (item.claimId === null) {
        invalid(
          ['operation', 'terminalReceipt', 'selection', 'items', index, 'claimId'],
          'Created receipt item requires a claim ID',
        );
        continue;
      }
      const creators = createdItemsByClaim.get(item.claimId) ?? [];
      creators.push({ item, index });
      createdItemsByClaim.set(item.claimId, creators);
    } else if (item.effect === 'reference') {
      if (item.claimId === null) {
        invalid(
          ['operation', 'terminalReceipt', 'selection', 'items', index, 'claimId'],
          'Reference receipt item requires a claim ID',
        );
        continue;
      }
      const indexes = referenceIndexesByClaim.get(item.claimId) ?? [];
      indexes.push(index);
      referenceIndexesByClaim.set(item.claimId, indexes);
    }
  }

  const namespace = plan.operation.identity.namespace;
  const subjectId = plan.operation.identity.binding.subjectId;
  for (const [index, edge] of plan.createEdges.entries()) {
    const entity = entityById.get(edge.target_node_uuid);
    const claimResult = AutonomousPersonalClaimV3OwnedDataSchema.safeParse(
      edge.attributes.engram_claim_v1,
    );
    const claim = claimResult.success ? claimResult.data : null;
    const markerResult = AutonomousPersonalValueMarkerV3OwnedDataSchema.safeParse(
      entity?.attributes.engram_literal_v1,
    );
    const marker = markerResult.success ? markerResult.data : null;
    const edgeMetadata = ExtractionMetadataV2Schema.safeParse(edge.attributes.engram_extraction);
    const valueMetadata = entity
      ? ExtractionMetadataV2Schema.safeParse(entity.attributes.engram_extraction)
      : null;
    const creatorItems = createdItemsByClaim.get(edge.uuid);
    const item = creatorItems?.length === 1 ? creatorItems[0]?.item : undefined;
    const logicalIdentity =
      claim === null
        ? null
        : claim.kind === 'typed_preference'
          ? {
              kind: 'typed_preference' as const,
              namespace: claim.namespace,
              subjectId: claim.subjectId,
              meaning: claim.meaning,
            }
          : {
              kind: 'source_statement_record' as const,
              namespace: claim.namespace,
              subjectId: claim.subjectId,
              sourceEventTime: claim.sourceEventTime,
              completeLiteral: claim.evidence.literal,
              semantics: 'source_attributed_statement' as const,
            };
    const expectedKey = logicalIdentity ? hashAutonomousPersonalClaimKeyV3(logicalIdentity) : null;
    const expectedMeaningHash = logicalIdentity
      ? hashAutonomousPersonalClaimMeaningV3(logicalIdentity)
      : null;
    const rootPaths =
      claim?.kind === 'typed_preference'
        ? (claim.meaning.bundles[0]?.rootPaths ?? [])
        : claim?.kind === 'source_statement_record'
          ? ['record']
          : [];
    const expectedDependencies =
      logicalIdentity && expectedMeaningHash
        ? rootPaths.map((rootPath, rootIndex) => ({
            index: rootIndex,
            dependencyHash: hashAutonomousPersonalPredicateDependencyV1({
              logicalInput: logicalIdentity,
              meaningHash: expectedMeaningHash,
              rootIndex,
              rootPath,
            }),
          }))
        : null;
    const expectedIds = claim
      ? deriveAutonomousPersonalRecordIdsV1({
          namespace: claim.namespace,
          subjectId: claim.subjectId,
          key: claim.key,
        })
      : null;
    const expectedThreshold = item?.state === 'accepted' ? 'auto_accepted' : 'pending_review';
    if (
      edgeIds.has(edge.uuid) ||
      creatorItems?.length !== 1 ||
      !entity ||
      !claim ||
      !marker ||
      !edgeMetadata?.success ||
      !valueMetadata?.success ||
      edge.group_id !== namespace ||
      entity.group_id !== namespace ||
      edge.uuid !== expectedIds?.claimId ||
      entity.uuid !== expectedIds?.valueId ||
      edge.source_node_uuid !== subjectId ||
      entity.entity_type !== 'autonomous_personal_value' ||
      entity.summary !== '' ||
      entity.name_embedding !== null ||
      edge.name !== (claim.kind === 'typed_preference' ? 'PREFERS' : 'STATED') ||
      edge.fact !== entity.name ||
      edge.fact !== claim.evidence.literal ||
      edge.fact_embedding !== null ||
      !Array.isArray(edge.episodes) ||
      edge.episodes.length !== 1 ||
      edge.episodes[0] !== receipt.sourceId ||
      edge.valid_at !== null ||
      edge.invalid_at !== null ||
      edge.expired_at !== null ||
      edge.created_at !== plan.operation.createdAt ||
      entity.created_at !== plan.operation.createdAt ||
      edge.updated_at !== plan.operation.createdAt ||
      entity.updated_at !== plan.operation.createdAt ||
      claim.key !== marker.key ||
      claim.kind !== marker.kind ||
      claim.namespace !== namespace ||
      claim.subjectId !== subjectId ||
      marker?.namespace !== namespace ||
      marker?.subjectId !== subjectId ||
      marker?.family !== 'autonomous-personal-v1' ||
      marker?.version !== 3 ||
      claim.key !== expectedKey ||
      item?.evidenceHash !== claim.evidence.evidenceHash ||
      item?.meaningHash !== expectedMeaningHash ||
      !item ||
      item.effect !== 'created' ||
      (item.state !== 'accepted' && item.state !== 'proposed') ||
      (item.state === 'accepted' && !claim.policy.autoAccept) ||
      edgeMetadata.data.review_status !== item.state ||
      valueMetadata.data.review_status !== item.state ||
      edgeMetadata.data.source !== 'policy' ||
      valueMetadata.data.source !== 'policy' ||
      edgeMetadata.data.confidence !== null ||
      valueMetadata.data.confidence !== null ||
      edgeMetadata.data.threshold_decision !== expectedThreshold ||
      valueMetadata.data.threshold_decision !== expectedThreshold ||
      edgeMetadata.data.extracted_at !== plan.operation.createdAt ||
      valueMetadata.data.extracted_at !== plan.operation.createdAt ||
      edgeMetadata.data.reviewed_at !== null ||
      valueMetadata.data.reviewed_at !== null ||
      edgeMetadata.data.reviewed_by !== null ||
      valueMetadata.data.reviewed_by !== null ||
      !same(edgeMetadata.data, valueMetadata.data) ||
      !same(edgeMetadata.data.episode_uuids, [receipt.sourceId]) ||
      !same(expectedDependencies, item.dependencies) ||
      Object.keys(edge.attributes).sort().join(',') !== 'engram_claim_v1,engram_extraction' ||
      Object.keys(entity.attributes).sort().join(',') !== 'engram_extraction,engram_literal_v1' ||
      !item ||
      item.kind !== claim.kind ||
      item.meaningHash.length !== 64
    ) {
      invalid(['createEdges', index], 'Created Claim3 pair does not match its receipt');
    }
    edgeIds.add(edge.uuid);
  }

  if (edgeIds.size !== entityById.size) {
    invalid(['createEntities'], 'Every created value must have exactly one Claim3 edge');
  }
  for (const [claimId, creators] of createdItemsByClaim) {
    if (creators.length !== 1 || !edgeIds.has(claimId)) {
      invalid(
        ['operation', 'terminalReceipt', 'selection', 'items', creators[0]?.index ?? 0],
        'Every created receipt item must have exactly one Claim3 pair',
      );
    }
  }

  const guardClaimIds = new Set<string>();
  for (const [guardIndex, guard] of plan.referenceGuards.entries()) {
    if (guardClaimIds.has(guard.claimId)) {
      invalid(['referenceGuards', guardIndex, 'claimId'], 'Duplicate reference guard');
    }
    guardClaimIds.add(guard.claimId);
    if (edgeIds.has(guard.claimId)) {
      invalid(
        ['referenceGuards', guardIndex, 'claimId'],
        'A created claim cannot have a pre-existing reference guard',
      );
    }
    const expectedIndexes = referenceIndexesByClaim.get(guard.claimId);
    if (
      !expectedIndexes ||
      expectedIndexes.length !== guard.occurrenceIndexes.length ||
      expectedIndexes.some(
        (occurrenceIndex, index) => occurrenceIndex !== guard.occurrenceIndexes[index],
      )
    ) {
      invalid(
        ['referenceGuards', guardIndex, 'occurrenceIndexes'],
        'Guard must cover every reference occurrence for its claim exactly once',
      );
    }
    for (const occurrenceIndex of expectedIndexes ?? []) {
      const item = receipt.selection.items[occurrenceIndex];
      const expectedReference = {
        accepted: { state: 'accepted', reason: 'existing_accepted' },
        proposed: { state: 'proposed', reason: 'existing_proposed' },
        rejected: { state: 'rejected', reason: 'existing_rejected' },
      }[guard.reviewState];
      if (
        !item ||
        item.effect !== 'reference' ||
        item.claimId !== guard.claimId ||
        item.meaningHash !== guard.meaningHash ||
        item.state !== expectedReference.state ||
        item.reason !== expectedReference.reason
      ) {
        invalid(
          ['referenceGuards', guardIndex, 'occurrenceIndexes'],
          'Guard does not match receipt',
        );
      }
    }
  }

  for (const [claimId, occurrenceIndexes] of referenceIndexesByClaim) {
    if (!edgeIds.has(claimId) && !guardClaimIds.has(claimId)) {
      invalid(
        ['operation', 'terminalReceipt', 'selection', 'items', occurrenceIndexes[0] ?? 0],
        'A pre-existing reference requires an exact row guard',
      );
    }
  }
}

export const AutonomousPersonalCompletionPlanV4NoWriteReasonSchema = z.enum([
  'invalid_input',
  'conflict',
  'authority_changed',
  'clock_regression',
  'lease_expired',
  'inspection_incomplete',
  'budget_exhausted',
  'capacity',
]);
export type AutonomousPersonalCompletionPlanV4NoWriteReason = z.infer<
  typeof AutonomousPersonalCompletionPlanV4NoWriteReasonSchema
>;

const noWrite = z
  .object({
    kind: z.literal('no_write'),
    reason: AutonomousPersonalCompletionPlanV4NoWriteReasonSchema,
  })
  .strict();

/** Complete candidate diff DATA only; no branch grants or performs a write. */
export const AutonomousPersonalCompletionPlanV4OwnedDataSchema = z
  .discriminatedUnion('kind', [planned, noWrite])
  .superRefine((value, context) => {
    if (value.kind === 'planned') validatePlanned(value, context);
    try {
      const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (serializedBytes > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.planBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Plan exceeds the frozen policy planBytes limit',
        });
      }
      if (serializedBytes > 100 * 1024 * 1024) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Plan exceeds graph ownership bound',
        });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Plan is not serializable DATA' });
    }
  });

export type AutonomousPersonalCompletionPlanV4 = z.infer<
  typeof AutonomousPersonalCompletionPlanV4OwnedDataSchema
>;
