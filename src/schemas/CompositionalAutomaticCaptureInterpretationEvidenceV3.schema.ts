import { types as utilTypes } from 'util';
import { z } from 'zod';
import { compositionalCaptureInterpreterResultHashV3 } from './CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalPreferenceV2Schema,
  snapshotBoundedCompositionalJson,
} from './CompositionalPreferenceV2.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const resultBody = z
  .object({
    version: z.literal(3),
    kind: z.literal('non_authoritative_interpretation_evidence'),
    sourceId: z.string().uuid(),
    sourceHash: hash64,
    descriptorHash: hash64,
    interpreterResultHash: hash64,
    result: CompositionalPreferenceV2Schema,
  })
  .strict();

const evidenceKeys = [
  'version',
  'kind',
  'sourceId',
  'sourceHash',
  'descriptorHash',
  'interpreterResultHash',
  'result',
] as const;

function preflightEvidence(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== evidenceKeys.length || keys.some((key) => typeof key !== 'string'))
      return undefined;
    const input: Record<string, unknown> = {};
    const metadata: Record<string, unknown> = {};
    let result: unknown;
    for (const key of evidenceKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      if (key === 'result') result = descriptor.value;
      else metadata[key] = descriptor.value;
    }
    const copiedMetadata = snapshotBoundedCompositionalJson(metadata, 16384);
    if (
      copiedMetadata === undefined ||
      copiedMetadata === null ||
      typeof copiedMetadata !== 'object'
    )
      return undefined;
    Object.assign(input, copiedMetadata, { result });
    return input;
  } catch {
    return undefined;
  }
}

/** A parser-result record only. This schema does not represent admission or permission. */
export const CompositionalAutomaticCaptureInterpretationEvidenceV3Schema = z
  .preprocess(preflightEvidence, resultBody)
  .superRefine((evidence, context) => {
    let expectedHash: string;
    try {
      expectedHash = compositionalCaptureInterpreterResultHashV3(
        evidence.sourceId,
        evidence.sourceHash,
        evidence.descriptorHash,
        evidence.result,
      );
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interpreterResultHash'],
        message: 'Interpreter result hash inputs are invalid',
      });
      return;
    }
    if (evidence.interpreterResultHash !== expectedHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['interpreterResultHash'],
        message: 'Interpreter result hash does not match its bounded result',
      });
    }
  });
export type CompositionalAutomaticCaptureInterpretationEvidenceV3 = z.infer<
  typeof CompositionalAutomaticCaptureInterpretationEvidenceV3Schema
>;
