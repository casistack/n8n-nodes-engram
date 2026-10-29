import {
  AutonomousPersonalClaimV3OwnedDataSchema,
  hashAutonomousPersonalClaimEvidenceV3,
  hashAutonomousPersonalClaimKeyV3,
  hashAutonomousPersonalClaimMeaningV3,
  hashAutonomousPersonalPredicateDependencyV1,
} from '../schemas/AutonomousPersonalClaimV3.schema';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from '../schemas/AutonomousPersonalPolicyV3.schema';
import {
  AutonomousPersonalClaimCandidateV1InputOwnedDataSchema,
  AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema,
  type AutonomousPersonalClaimCandidateV1Input,
  type AutonomousPersonalClaimCandidateV1Result,
} from '../schemas/AutonomousPersonalClaimCandidateV1.schema';
import type { CompositionalPreferenceV2Bundle } from '../schemas/CompositionalPreferenceV2.schema';
import type { CompositionalAutomaticClaimMeaningV2 } from '../schemas/CompositionalAutomaticMemory.schema';
import { projectCompositionalPreferenceV2Meaning } from './CompositionalPreferenceV2Meaning';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const MAX_CLAIM_BYTES = AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.claimMetadataBytes;
const MAX_DEPENDENCIES = AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.dependencyRoots;
const MAX_STATEMENT_CODE_POINTS = AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.statementCodePoints;
const MAX_STATEMENT_BYTES = AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.statementBytes;

class CandidateCapacity extends Error {}
class AggregateCapacity extends Error {}

function invalidCandidateData(): Error {
  const error = new Error('invalid_autonomous_personal_claim_candidate_data');
  error.name = 'AutonomousPersonalClaimCandidateV1Error';
  return Object.freeze(error);
}

function generatedJsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') throw invalidCandidateData();
    return Buffer.byteLength(serialized, 'utf8');
  } catch {
    throw invalidCandidateData();
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function capacity(
  kind: 'candidate_capacity' | 'aggregate_capacity',
): AutonomousPersonalClaimCandidateV1Result {
  return deepFreeze(AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema.parse({ kind }));
}

function buildOwnedCandidate(
  input: AutonomousPersonalClaimCandidateV1Input,
): AutonomousPersonalClaimCandidateV1Result {
  const {
    sourceId,
    contentHash,
    descriptorHash,
    namespace,
    subjectId,
    sourceHash,
    policy,
    sourceEventTime,
    unitId,
    unitIndex,
    kind,
    category,
    literal,
    rawSpan,
    mappedSpan,
  } = input;

  if (
    Array.from(literal).length > MAX_STATEMENT_CODE_POINTS ||
    Buffer.byteLength(literal, 'utf8') > MAX_STATEMENT_BYTES ||
    literal.length !== rawSpan.end - rawSpan.start ||
    literal.length !== mappedSpan.end - mappedSpan.start
  ) {
    throw new CandidateCapacity();
  }

  const evidenceInput = {
    sourceId,
    rawContentHash: contentHash,
    unitId,
    kind,
    rawSpan,
    mappedSpan,
    literal,
  };
  if (generatedJsonBytes(evidenceInput) > MAX_CLAIM_BYTES) throw new CandidateCapacity();
  const evidenceHashes = hashAutonomousPersonalClaimEvidenceV3(evidenceInput);

  let logicalInput:
    | {
        kind: 'typed_preference';
        namespace: string;
        subjectId: string;
        meaning: CompositionalAutomaticClaimMeaningV2;
      }
    | {
        kind: 'source_statement_record';
        namespace: string;
        subjectId: string;
        sourceEventTime: string;
        completeLiteral: string;
        semantics: 'source_attributed_statement';
      };
  let claimKindInput:
    | { bundle: CompositionalPreferenceV2Bundle; meaning: CompositionalAutomaticClaimMeaningV2 }
    | {
        sourceEventTime: string;
        framingVersion: 1;
        headForm: 'first_person_i_main_clause';
        semantics: 'source_attributed_statement';
        typedProjection: null;
      };
  let rootPaths: string[];

  if (input.kind === 'typed_preference') {
    const meaningResult = projectCompositionalPreferenceV2Meaning({
      preference: {
        version: 2,
        descriptor: input.bundle.evidence.descriptor,
        coverage: 'complete',
        bundles: [input.bundle],
        withheld: [],
        reasons: [],
      },
      namespace,
      subjectId,
    });
    if (!meaningResult.ok) throw invalidCandidateData();
    const meaning = meaningResult.meaning;
    logicalInput = { kind: 'typed_preference', namespace, subjectId, meaning };
    rootPaths = [...meaning.bundles[0]!.rootPaths];
    claimKindInput = { bundle: input.bundle, meaning };
  } else {
    logicalInput = {
      kind: 'source_statement_record',
      namespace,
      subjectId,
      sourceEventTime,
      completeLiteral: literal,
      semantics: 'source_attributed_statement',
    };
    rootPaths = ['record'];
    claimKindInput = {
      sourceEventTime,
      framingVersion: 1,
      headForm: 'first_person_i_main_clause',
      semantics: 'source_attributed_statement',
      typedProjection: null,
    };
  }

  if (generatedJsonBytes(logicalInput) > MAX_CLAIM_BYTES) throw new CandidateCapacity();
  const meaningHash = hashAutonomousPersonalClaimMeaningV3(logicalInput);
  const key = hashAutonomousPersonalClaimKeyV3(logicalInput);
  if (rootPaths.length > MAX_DEPENDENCIES) throw new AggregateCapacity();
  const dependencies = rootPaths.map((rootPath, index) => {
    const dependencyInput = { logicalInput, meaningHash, rootIndex: index, rootPath };
    if (generatedJsonBytes(dependencyInput) > MAX_CLAIM_BYTES) throw new CandidateCapacity();
    return {
      index,
      dependencyHash: hashAutonomousPersonalPredicateDependencyV1(dependencyInput),
    };
  });

  const claim = {
    version: 3,
    family: 'autonomous-personal-v1',
    kind,
    key,
    namespace,
    subjectId,
    sourceId,
    sourceHash,
    descriptorHash,
    policy,
    evidence: {
      unitId,
      rawSpan,
      mappedSpan,
      literal,
      rawContentHash: contentHash,
      ...evidenceHashes,
    },
    interpretation: {
      category,
      usefulness: 'personal_memory',
      risk: 'ordinary',
      downgrade: [],
    },
    ...claimKindInput,
  };
  if (generatedJsonBytes(claim) > MAX_CLAIM_BYTES) throw new CandidateCapacity();

  let ownedClaim;
  try {
    ownedClaim = AutonomousPersonalClaimV3OwnedDataSchema.parse(claim);
  } catch {
    throw invalidCandidateData();
  }

  return deepFreeze(
    AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema.parse({
      kind: 'candidate',
      claim: ownedClaim,
      reference: {
        unitIndex,
        kind,
        category,
        key,
        evidenceHash: evidenceHashes.evidenceHash,
        meaningHash,
        dependencies,
        rawSpan,
        mappedSpan,
      },
      dependencyCount: dependencies.length,
    }),
  );
}

/** Build one bounded Claim3 candidate from already-owned provenance DATA only. */
export function buildAutonomousPersonalClaimCandidateV1(
  inputValue: unknown,
): AutonomousPersonalClaimCandidateV1Result {
  try {
    const inputSnapshot = cloneBoundedAutomaticCaptureJson<unknown>(inputValue, 'beginRequest');
    const input = AutonomousPersonalClaimCandidateV1InputOwnedDataSchema.parse(inputSnapshot);
    return buildOwnedCandidate(input);
  } catch (error) {
    if (error instanceof CandidateCapacity) return capacity('candidate_capacity');
    if (error instanceof AggregateCapacity) return capacity('aggregate_capacity');
    throw invalidCandidateData();
  }
}
