import { z } from 'zod';
import { canonicalAutomaticCaptureV2, hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import {
  AutonomousPersonalBeginV4ContextOwnedDataSchema,
  AutonomousPersonalBeginV4RequestOwnedDataSchema,
} from './AutonomousPersonalBeginV4.schema';
import {
  AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema,
  AutonomousPersonalCaptureFenceV4OwnedDataSchema,
  type AutonomousPersonalCaptureBeginV4ResultProjection,
  type AutonomousPersonalCaptureFenceV4,
} from './AutonomousPersonalCaptureAdmissionV4.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
} from './AutonomousPersonalOperationV4.schema';
import { hashAutonomousPersonalDescriptorV4 } from './AutonomousPersonalDescriptorV4.schema';
import {
  AutonomousPersonalSourceOwnerV4OwnedDataSchema,
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
} from './AutonomousPersonalSourceV4.schema';
import { EpisodicNodeSchema, type EpisodicNode } from './EpisodicNode.schema';

const UUID = z.string().uuid();
const HASH_64 = /^[a-f0-9]{64}$/u;
const HASH = z.string().regex(HASH_64);
const canonicalUtcMilliseconds = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });

export const AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema = z
  .object({
    request: AutonomousPersonalBeginV4RequestOwnedDataSchema,
    context: AutonomousPersonalBeginV4ContextOwnedDataSchema,
    sourceId: UUID,
    operationId: UUID,
    leaseToken: UUID,
    stableBeginHash: HASH,
    attemptHash: HASH,
    backendNow: canonicalUtcMilliseconds,
    previousEpisodeId: UUID.nullable(),
  })
  .strict();

export type AutonomousPersonalCaptureSnapshotPreparationV4Input = z.infer<
  typeof AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema
>;

type FalseProjection = Exclude<
  AutonomousPersonalCaptureBeginV4ResultProjection,
  { kind: 'claimed' }
>;

const falseProjection: z.ZodType<FalseProjection, z.ZodTypeDef, unknown> =
  AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema.refine(
    (projection): projection is FalseProjection => projection.kind !== 'claimed',
  );

const episodeDataSchema: z.ZodType<EpisodicNode, z.ZodTypeDef, unknown> =
  EpisodicNodeSchema.strict();
const operationDataSchema: z.ZodType<AutonomousPersonalOperationV4, z.ZodTypeDef, unknown> =
  AutonomousPersonalOperationV4OwnedDataSchema;
const fenceDataSchema: z.ZodType<AutonomousPersonalCaptureFenceV4, z.ZodTypeDef, unknown> =
  AutonomousPersonalCaptureFenceV4OwnedDataSchema;

function invalidCandidate(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message });
}

function validateCandidateRows(
  value: {
    episode: EpisodicNode;
    operation: AutonomousPersonalOperationV4;
    fence: AutonomousPersonalCaptureFenceV4;
  },
  context: z.RefinementCtx,
  allowAuditSuffix: boolean,
): void {
  const { episode, operation, fence } = value;
  if (
    operation.state !== 'leased' ||
    operation.generation !== 1 ||
    operation.retryCount !== 0 ||
    operation.lastRetryCallHash !== undefined ||
    operation.lease.claimKind !== 'initial'
  ) {
    invalidCandidate(context, 'Initial candidates require a generation-one initial lease');
    return;
  }

  const identity = operation.identity;
  if (
    operation.operationId !== fence.operationId ||
    episode.uuid !== identity.sourceId ||
    episode.uuid !== fence.sourceId ||
    episode.group_id !== identity.namespace ||
    identity.role !== 'human' ||
    identity.purpose !== 'human_turn_memory' ||
    fence.descriptorHash !== identity.descriptorHash ||
    fence.descriptorHash !== hashAutonomousPersonalDescriptorV4(operation.descriptor) ||
    fence.identityHash !== hashAutomaticCaptureV2(identity) ||
    fence.sourceHash !== identity.sourceHash ||
    fence.beginCallHash !== operation.beginCallHash ||
    fence.state !== 'leased' ||
    fence.generation !== operation.generation ||
    fence.token !== operation.lease.token ||
    fence.claimKind !== operation.lease.claimKind ||
    fence.retryCount !== operation.retryCount ||
    fence.planTimestamp !== operation.lease.renewedAt
  ) {
    invalidCandidate(context, 'Initial candidate row and fence references disagree');
    return;
  }

  const rawOwner = episode.attributes[AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE];
  const rawEnvelope = episode.attributes[AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE];
  const ownerResult = AutonomousPersonalSourceOwnerV4OwnedDataSchema.safeParse(rawOwner);
  if (!ownerResult.success || rawEnvelope === undefined) {
    invalidCandidate(context, 'Initial candidate lacks a complete Source4 attribute pair');
    return;
  }
  const owner = ownerResult.data;
  if (
    owner.sourceId !== episode.uuid ||
    owner.storeHash !== identity.storeHash ||
    owner.namespace !== identity.namespace ||
    owner.issuer !== identity.issuer ||
    owner.actorReference !== identity.actorReference ||
    owner.turn !== identity.turn ||
    owner.binding.bindingId !== identity.binding.bindingId ||
    owner.binding.revision !== identity.binding.revision ||
    owner.binding.subjectId !== identity.binding.subjectId ||
    owner.binding.fingerprint !== identity.binding.fingerprint
  ) {
    invalidCandidate(context, 'Source4 owner does not match Operation4 identity');
    return;
  }

  try {
    const reconstructed = reconstructAutonomousPersonalStoredSourceIdentityV4({
      source: episode,
      descriptor: operation.descriptor,
    });
    if (
      canonicalAutomaticCaptureV2(reconstructed.tuple.identity) !==
        canonicalAutomaticCaptureV2(identity) ||
      fence.envelopeHash !== hashAutomaticCaptureV2(reconstructed.tuple.envelope) ||
      reconstructed.tuple.envelope.descriptorHash !== identity.descriptorHash ||
      rawEnvelope === undefined
    ) {
      invalidCandidate(context, 'Source4 tuple does not match candidate identity and fence');
      return;
    }
  } catch {
    invalidCandidate(context, 'Source4 row cannot be reconstructed');
    return;
  }

  const initialAttempt = operation.attempts[0];
  if (
    !initialAttempt ||
    initialAttempt.disposition !== 'claim_won' ||
    initialAttempt.at !== operation.createdAt ||
    operation.lease.acquiredAt !== operation.createdAt ||
    operation.lease.renewedAt !== operation.createdAt ||
    episode.created_at !== operation.createdAt
  ) {
    invalidCandidate(context, 'Initial candidate does not preserve its original claim attempt');
    return;
  }

  if (!allowAuditSuffix) {
    if (
      operation.attempts.length !== 1 ||
      operation.auditTruncated !== false ||
      operation.lastObservedAt !== operation.createdAt
    ) {
      invalidCandidate(context, 'Fresh initial candidates have exactly one claim attempt');
    }
    return;
  }

  if (operation.attempts.slice(1).some((attempt) => attempt.disposition === 'claim_won')) {
    invalidCandidate(context, 'Initial candidate cannot contain another claim attempt');
  }
}

const initialCandidateSchema = z
  .object({
    kind: z.literal('initial_candidate'),
    episode: episodeDataSchema,
    operation: operationDataSchema,
    fence: fenceDataSchema,
  })
  .strict();

const sameInitialScopeCandidateSchema = z
  .object({
    kind: z.literal('same_initial_scope_candidate'),
    episode: episodeDataSchema,
    operation: operationDataSchema,
    fence: fenceDataSchema,
  })
  .strict();

const auditCandidateSchema = z
  .object({
    kind: z.literal('audit_candidate'),
    operation: operationDataSchema,
    resultProjection: falseProjection,
  })
  .strict();

const noWriteSchema = z
  .object({
    kind: z.literal('no_write'),
    resultProjection: falseProjection,
  })
  .strict();

const snapshotPreparationSchema = z
  .discriminatedUnion('kind', [
    initialCandidateSchema,
    sameInitialScopeCandidateSchema,
    auditCandidateSchema,
    noWriteSchema,
  ])
  .superRefine((value, context) => {
    if (value.kind === 'initial_candidate') validateCandidateRows(value, context, false);
    if (value.kind === 'same_initial_scope_candidate') validateCandidateRows(value, context, true);
    if (value.kind === 'audit_candidate') {
      const invalid = () =>
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Audit operation and result projection do not agree',
        });
      const projection = value.resultProjection;
      switch (value.operation.state) {
        case 'leased':
          if (projection.kind !== 'in_progress' && projection.kind !== 'resume_available')
            invalid();
          break;
        case 'failed':
          if (
            projection.kind !== 'failed' ||
            projection.failureCode !== value.operation.failureCode
          )
            invalid();
          break;
        case 'interrupted':
          if (
            projection.kind !== 'interrupted' ||
            projection.failureCode !== value.operation.failureCode
          )
            invalid();
          break;
        case 'committed':
          if (
            projection.kind !== 'committed_observed' ||
            canonicalAutomaticCaptureV2(projection.terminalReceipt) !==
              canonicalAutomaticCaptureV2(value.operation.terminalReceipt)
          )
            invalid();
          break;
        case 'cancelled':
          if (
            projection.kind !== 'cancelled_observed' ||
            canonicalAutomaticCaptureV2(projection.terminalReceipt) !==
              canonicalAutomaticCaptureV2(value.operation.terminalReceipt)
          )
            invalid();
          break;
        case 'captured':
          invalid();
          break;
      }
    }
  });

export type AutonomousPersonalCaptureSnapshotPreparationV4 = z.infer<
  typeof snapshotPreparationSchema
>;

export const AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema: z.ZodType<
  AutonomousPersonalCaptureSnapshotPreparationV4,
  z.ZodTypeDef,
  unknown
> = snapshotPreparationSchema;
