import { z } from 'zod';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { AutonomousPersonalRecordIdsV1InputOwnedDataSchema } from './AutonomousPersonalRecordIdsV1.schema';

const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const UUID = z.string().uuid();
const namespace = AutonomousPersonalRecordIdsV1InputOwnedDataSchema.shape.namespace;
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  });
const span = z
  .object({
    start: z.number().int().safe().min(0).max(65_536),
    end: z.number().int().safe().min(1).max(65_536),
  })
  .strict()
  .refine((value) => value.start < value.end);
const dependency = z
  .object({ index: z.number().int().min(0).max(31), dependencyHash: HASH })
  .strict();

/** Historical join DATA, not a native read, write or processing permit. */
export const AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema = z
  .object({
    storeHash: HASH,
    namespace,
    subjectId: UUID,
    claimId: UUID,
    valueId: UUID,
    sourceId: UUID,
    operationId: UUID,
    key: HASH,
    kind: z.enum(['typed_preference', 'source_statement_record']),
    unitIndex: z.number().int().min(0).max(31),
    unitId: HASH,
    rawSpan: span,
    mappedSpan: span,
    sourceHash: HASH,
    descriptorHash: HASH,
    evidenceHash: HASH,
    meaningHash: HASH,
    dependencies: z.array(dependency).min(1).max(32),
    createdAt: timestamp,
    sourceEventTime: timestamp,
    reviewState: z.enum(['accepted', 'proposed', 'rejected']),
  })
  .strict()
  .superRefine((proof, context) => {
    if (
      new Set([proof.subjectId, proof.claimId, proof.valueId, proof.sourceId, proof.operationId])
        .size !== 5 ||
      proof.rawSpan.end - proof.rawSpan.start !== proof.mappedSpan.end - proof.mappedSpan.start ||
      proof.dependencies.some((row, index) => row.index !== index) ||
      (proof.kind === 'source_statement_record' && proof.dependencies.length !== 1)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid qualified claim proof DATA',
      });
    }
  });

export type AutonomousPersonalQualifiedClaimProofV4 = z.infer<
  typeof AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema
>;

export const AutonomousPersonalQualifiedClaimRequestV4OwnedDataSchema = z
  .object({ storeHash: HASH, namespace, edgeId: UUID, backendNow: timestamp })
  .strict();
export type AutonomousPersonalQualifiedClaimRequestV4 = z.infer<
  typeof AutonomousPersonalQualifiedClaimRequestV4OwnedDataSchema
>;

export const AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema = z
  .union([
    z
      .object({
        status: z.literal('structural'),
        proof: AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal('qualified'),
        proof: AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal('inactive'),
        reason: z.enum([
          'store_mismatch',
          'namespace_mismatch',
          'authority_inactive',
          'source_inactive',
          'time_inactive',
        ]),
      })
      .strict(),
    z
      .object({ status: z.literal('uncommitted'), reason: z.literal('capture_not_committed') })
      .strict(),
    z
      .object({
        status: z.literal('invalid'),
        reason: z.enum([
          'missing_record',
          'invalid_record',
          'ambiguous_record',
          'invalid_source',
          'invalid_operation',
          'invalid_creator',
          'invalid_claim',
          'invalid_review_pair',
          'unsupported_generation',
        ]),
      })
      .strict(),
    z
      .object({
        status: z.literal('capacity'),
        reason: z.enum(['snapshot_capacity', 'proof_capacity']),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Qualified claim DATA exceeds limit',
      });
    }
  });

export type AutonomousPersonalQualifiedClaimResultV4 = z.infer<
  typeof AutonomousPersonalQualifiedClaimResultV4OwnedDataSchema
>;

function invalidRequest(): Error {
  const error = new Error('invalid_autonomous_claim_request_data');
  error.name = 'AutonomousPersonalQualifiedClaimV4Error';
  return Object.freeze(error);
}

export const AutonomousPersonalQualifiedClaimRequestV4Schema = Object.freeze({
  parse(input: unknown): AutonomousPersonalQualifiedClaimRequestV4 {
    try {
      return Object.freeze(
        AutonomousPersonalQualifiedClaimRequestV4OwnedDataSchema.parse(
          cloneBoundedAutomaticCaptureJson<unknown>(input, 'policyData'),
        ),
      );
    } catch {
      throw invalidRequest();
    }
  },
});

export const AutonomousPersonalQualifiedClaimEdgeIdV4Schema = Object.freeze({
  parse(input: unknown): string {
    try {
      const owned = cloneBoundedAutomaticCaptureJson<{ edgeId: unknown }>(
        { edgeId: input },
        'policyData',
      );
      return UUID.parse(owned.edgeId);
    } catch {
      throw invalidRequest();
    }
  },
});
