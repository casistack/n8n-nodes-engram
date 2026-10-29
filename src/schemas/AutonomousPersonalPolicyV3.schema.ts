import { z } from 'zod';
import { hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  CompositionalPreferenceV2DescriptorSchema,
} from './CompositionalPreferenceV2.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

/** Policy data ceilings, never permission to read, write or accept a claim. */
export const AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS = Object.freeze({
  sourceBytes: 65536,
  envelopeBytes: 16384,
  geometryEntries: 32,
  sourceUnits: 128,
  lexicalTokens: 8192,
  occurrences: 32,
  dependencyRoots: 32,
  preferencePredicates: 32,
  preferenceNodes: 128,
  preferenceEdges: 128,
  preferenceDepth: 8,
  statementCodePoints: 2048,
  statementBytes: 4096,
  policyBytes: 4096,
  descriptorBytes: 4096,
  preflightBytes: 16384,
  claimMetadataBytes: 32768,
  planBytes: 524288,
  cachedStageBytes: 589824,
  receiptBytes: 16384,
  operationBytes: 32768,
  guards: 130,
  candidateProjections: 128,
  rootRecords: 100000,
  rootBytes: 104857600,
  readMilliseconds: 5000,
  readAttempts: 128,
  sourceHydrations: 512,
  conflicts: 128,
  conflictRefsPerClaim: 8,
  readContextBytes: 8388608,
  qualifiedContextBytes: 524288,
  minimalProofBytes: 24576,
  diagnosticReferences: 8,
  providerMaxAttempts: 2,
  providerRequestBytes: 262144,
  providerResponseBytes: 65536,
} as const);
const L = AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS;
const limitsSchema = z
  .object({
    sourceBytes: z.literal(L.sourceBytes),
    envelopeBytes: z.literal(L.envelopeBytes),
    geometryEntries: z.literal(L.geometryEntries),
    sourceUnits: z.literal(L.sourceUnits),
    lexicalTokens: z.literal(L.lexicalTokens),
    occurrences: z.literal(L.occurrences),
    dependencyRoots: z.literal(L.dependencyRoots),
    preferencePredicates: z.literal(L.preferencePredicates),
    preferenceNodes: z.literal(L.preferenceNodes),
    preferenceEdges: z.literal(L.preferenceEdges),
    preferenceDepth: z.literal(L.preferenceDepth),
    statementCodePoints: z.literal(L.statementCodePoints),
    statementBytes: z.literal(L.statementBytes),
    policyBytes: z.literal(L.policyBytes),
    descriptorBytes: z.literal(L.descriptorBytes),
    preflightBytes: z.literal(L.preflightBytes),
    claimMetadataBytes: z.literal(L.claimMetadataBytes),
    planBytes: z.literal(L.planBytes),
    cachedStageBytes: z.literal(L.cachedStageBytes),
    receiptBytes: z.literal(L.receiptBytes),
    operationBytes: z.literal(L.operationBytes),
    guards: z.literal(L.guards),
    candidateProjections: z.literal(L.candidateProjections),
    rootRecords: z.literal(L.rootRecords),
    rootBytes: z.literal(L.rootBytes),
    readMilliseconds: z.literal(L.readMilliseconds),
    readAttempts: z.literal(L.readAttempts),
    sourceHydrations: z.literal(L.sourceHydrations),
    conflicts: z.literal(L.conflicts),
    conflictRefsPerClaim: z.literal(L.conflictRefsPerClaim),
    readContextBytes: z.literal(L.readContextBytes),
    qualifiedContextBytes: z.literal(L.qualifiedContextBytes),
    minimalProofBytes: z.literal(L.minimalProofBytes),
    diagnosticReferences: z.literal(L.diagnosticReferences),
    providerMaxAttempts: z.literal(L.providerMaxAttempts),
    providerRequestBytes: z.literal(L.providerRequestBytes),
    providerResponseBytes: z.literal(L.providerResponseBytes),
  })
  .strict();
const inputSchema = z
  .object({ profileId: z.enum(['conservative', 'explicit', 'reviewFirst']) })
  .strict();
export type AutonomousPersonalPolicyInputV3 = z.input<typeof inputSchema>;
const reserveSchema = z
  .object({
    minMs: z.literal(20),
    maxMs: z.literal(1000),
    numerator: z.literal(1),
    denominator: z.literal(10),
    rounding: z.literal('ceil'),
  })
  .strict();
const bodySchema = z
  .object({
    version: z.literal(3),
    policyId: z.literal('autonomous-personal-memory'),
    policyVersion: z.literal(1),
    profileId: inputSchema.shape.profileId,
    profileVersion: z.literal(2),
    interpretationFamily: z.literal('autonomous-personal-v1'),
    preferenceInterpreter: CompositionalPreferenceV2DescriptorSchema,
    statementGrammarVersion: z.literal(1),
    compositionVersion: z.literal(1),
    usefulnessPolicyVersion: z.literal(1),
    riskPolicyVersion: z.literal(1),
    consistencyPolicyVersion: z.literal(1),
    materializerVersion: z.literal(1),
    autoAccept: z.boolean(),
    requiresProtectedIntent: z.boolean(),
    limits: limitsSchema,
    finalizationReserve: reserveSchema,
  })
  .strict();
const fingerprint = (body: z.infer<typeof bodySchema>) =>
  hashAutomaticCaptureV2({ domain: 'engram-autonomous-policy-v1', policy: body });
function body(profileId: AutonomousPersonalPolicyInputV3['profileId']) {
  return bodySchema.parse({
    version: 3,
    policyId: 'autonomous-personal-memory',
    policyVersion: 1,
    profileId,
    profileVersion: 2,
    interpretationFamily: 'autonomous-personal-v1',
    preferenceInterpreter: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    statementGrammarVersion: 1,
    compositionVersion: 1,
    usefulnessPolicyVersion: 1,
    riskPolicyVersion: 1,
    consistencyPolicyVersion: 1,
    materializerVersion: 1,
    autoAccept: profileId !== 'reviewFirst',
    requiresProtectedIntent: profileId === 'explicit',
    limits: L,
    finalizationReserve: {
      minMs: 20,
      maxMs: 1000,
      numerator: 1,
      denominator: 10,
      rounding: 'ceil',
    },
  });
}

/** Composition schema for already-owned JSON. Raw JavaScript uses the facade below. */
export const AutonomousPersonalPolicyV3OwnedDataSchema = bodySchema
  .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict()
  .superRefine((policy, context) => {
    const { fingerprint: actual, ...value } = policy;
    if (
      actual !== fingerprint(value) ||
      fingerprint(value) !== fingerprint(body(policy.profileId)) ||
      Buffer.byteLength(JSON.stringify(policy)) > L.policyBytes
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Policy must match the exact compiled profile',
      });
  });
export type AutonomousPersonalPolicyV3 = z.infer<typeof AutonomousPersonalPolicyV3OwnedDataSchema>;
function invalid() {
  return new z.ZodError([
    { code: z.ZodIssueCode.custom, path: [], message: 'Invalid autonomous personal policy data' },
  ]);
}
function own(value: unknown) {
  return cloneBoundedAutomaticCaptureJson(value, 'policyData');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function parse(value: unknown): AutonomousPersonalPolicyV3 {
  try {
    return freeze(AutonomousPersonalPolicyV3OwnedDataSchema.parse(own(value)));
  } catch {
    throw invalid();
  }
}
/** Own before entering Zod: even a raw then getter is never inspected. Data only. */
export const AutonomousPersonalPolicyV3Schema = Object.freeze({
  parse,
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalPolicyV3> {
    try {
      return { success: true, data: parse(value) };
    } catch {
      return { success: false, error: invalid() };
    }
  },
});
export function compileAutonomousPersonalPolicyV3(input: unknown): AutonomousPersonalPolicyV3 {
  let profile: AutonomousPersonalPolicyInputV3;
  try {
    profile = inputSchema.parse(own(input));
  } catch {
    throw invalid();
  }
  const value = body(profile.profileId);
  return parse({ ...value, fingerprint: fingerprint(value) });
}
