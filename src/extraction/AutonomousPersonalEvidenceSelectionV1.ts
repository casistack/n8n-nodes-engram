import { types as utilTypes } from 'node:util';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { hashAutonomousPersonalSourceUnitIdV1 } from '../schemas/AutonomousPersonalClaimV3.schema';
import {
  compileAutonomousPersonalFramingV1,
  type AutonomousPersonalFramingV1,
} from '../schemas/AutonomousPersonalFramingV1.schema';
import {
  compileAutonomousPersonalSourceScanV1,
  type AutonomousPersonalSourceScanV1,
} from '../schemas/AutonomousPersonalSourceScanV1.schema';
import {
  AutonomousPersonalEvidenceSelectionV1OwnedDataSchema,
  type AutonomousPersonalEvidenceSelectionV1,
  type AutonomousPersonalEvidenceSelectionOccurrenceV1,
  type AutonomousPersonalEvidenceSelectionReasonV1,
  type AutonomousPersonalEvidenceSelectionUnitV1,
} from '../schemas/AutonomousPersonalEvidenceSelectionV1.schema';
import {
  hashAutomaticCaptureV2,
  canonicalAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
  type AutonomousPersonalStoredSourceIdentityV4,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from '../schemas/AutonomousPersonalPolicyV3.schema';
import {
  compileAutonomousSourceGeometryV3,
  type AutonomousSourceGeometryCompilationV3,
  type AutonomousSourceGeometryInputV3,
} from '../schemas/AutonomousSourceGeometryV3.schema';
import {
  validateAutonomousPersonalProviderResponseV1,
  type AutonomousPersonalProviderUnitV1,
} from '../schemas/AutonomousPersonalProviderV1.schema';
import {
  type AutonomousPersonalTypedSyntaxV1,
  type AutonomousPersonalTypedSyntaxWorkV1,
} from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  AutonomousPersonalTypedSyntaxFailureV1,
  compileAutonomousPersonalTypedSyntaxV1,
} from './AutonomousPersonalTypedSyntaxV1';
import { buildAutonomousPersonalClaimCandidateV1 } from './AutonomousPersonalClaimCandidateV1';
import { tokenizeMappedBody } from './AutonomousSourceLexerV1';
import type { AutonomousSourceLexicalTokenV1 } from '../schemas/AutonomousSourceLexicalTokenV1.schema';
import {
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject,
} from '../storage/BoundedAutomaticCaptureJson';

const MAX_SELECTION_BYTES = 512 * 1024;
const MAX_CLAIM_OCCURRENCES = 32;
const MAX_DEPENDENCIES = 32;
const MAX_STATEMENT_CODE_POINTS = AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.statementCodePoints;
const MAX_STATEMENT_BYTES = AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.statementBytes;
const WORK_CEILING_MS = 5000;

const inputSchema = z
  .object({ source: z.unknown(), descriptor: z.unknown() })
  .strict()
  .superRefine((input, context) => {
    if (
      !Object.prototype.hasOwnProperty.call(input, 'source') ||
      !Object.prototype.hasOwnProperty.call(input, 'descriptor')
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing Source4 input' });
    }
  });

const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

type FailureCode =
  | 'invalid_autonomous_evidence_input_data'
  | 'invalid_autonomous_evidence_source_data'
  | 'invalid_autonomous_evidence_provider_data'
  | 'cancelled_autonomous_evidence_selection'
  | 'deadline_autonomous_evidence_selection'
  | 'invalid_autonomous_evidence_selection_data';

export class AutonomousPersonalEvidenceSelectionFailureV1 extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(code);
    this.name = 'AutonomousPersonalEvidenceSelectionFailureV1';
    this.code = code;
    Object.freeze(this);
  }
}

function fail(code: FailureCode): never {
  throw new AutonomousPersonalEvidenceSelectionFailureV1(code);
}

function requireNoProviderResponse(value: unknown): void {
  // The no-dispatch form is the primitive `null`; testing its identity cannot
  // invoke a getter or inspect a provider object.
  if (value !== null) fail('invalid_autonomous_evidence_provider_data');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

interface WorkData {
  readonly deadline: number;
  readonly signal: AbortSignal;
}

function readWorkData(value: unknown): WorkData {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  )
    fail('invalid_autonomous_evidence_input_data');
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal')
    )
      fail('invalid_autonomous_evidence_input_data');
    const deadlineProperty = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
    const signalProperty = Object.getOwnPropertyDescriptor(value, 'signal');
    if (
      !deadlineProperty ||
      !deadlineProperty.enumerable ||
      !('value' in deadlineProperty) ||
      typeof deadlineProperty.value !== 'number' ||
      !Number.isFinite(deadlineProperty.value) ||
      !signalProperty ||
      !signalProperty.enumerable ||
      !('value' in signalProperty) ||
      signalProperty.value === null ||
      typeof signalProperty.value !== 'object' ||
      utilTypes.isProxy(signalProperty.value) ||
      nativeAbortSignalAbortedGetter === undefined
    )
      fail('invalid_autonomous_evidence_input_data');
    nativeAbortSignalAbortedGetter.call(signalProperty.value);
    return { deadline: deadlineProperty.value, signal: signalProperty.value as AbortSignal };
  } catch (error) {
    if (error instanceof AutonomousPersonalEvidenceSelectionFailureV1) throw error;
    fail('invalid_autonomous_evidence_input_data');
  }
}

function makeWorkCheck(
  work: unknown,
  enteredAt: number,
): {
  check: () => void;
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1;
} {
  const supplied = readWorkData(work);
  if (!Number.isFinite(enteredAt) || nativeAbortSignalAbortedGetter === undefined) {
    fail('invalid_autonomous_evidence_input_data');
  }
  const deadline = Math.min(supplied.deadline, enteredAt + WORK_CEILING_MS);
  let firstFailure: AutonomousPersonalEvidenceSelectionFailureV1 | undefined;
  const latch = (code: FailureCode): never => {
    firstFailure ??= new AutonomousPersonalEvidenceSelectionFailureV1(code);
    throw firstFailure;
  };
  const check = () => {
    if (firstFailure) throw firstFailure;
    try {
      if (nativeAbortSignalAbortedGetter.call(supplied.signal)) {
        latch('cancelled_autonomous_evidence_selection');
      }
      const now = performance.now();
      if (!Number.isFinite(now)) latch('invalid_autonomous_evidence_selection_data');
      if (now >= deadline) latch('deadline_autonomous_evidence_selection');
    } catch (error) {
      if (error instanceof AutonomousPersonalEvidenceSelectionFailureV1) {
        if (!firstFailure) firstFailure = error;
        throw firstFailure;
      }
      latch('invalid_autonomous_evidence_selection_data');
    }
  };
  return {
    check,
    typedSyntaxWork: {
      absoluteMonotonicDeadlineMs: deadline,
      signal: supplied.signal,
    },
  };
}

function geometryInputFromStored(
  stored: AutonomousPersonalStoredSourceIdentityV4,
): AutonomousSourceGeometryInputV3 {
  const geometry = stored.tuple.envelope.geometry;
  if (geometry.mode === 'full_body') {
    return {
      rawContent: stored.source.content,
      mapping: { mode: 'full_body' },
      quoteRegions: geometry.quoteRegions,
    };
  }
  if (!geometry.humanRegion || !geometry.applicationWrapper) {
    fail('invalid_autonomous_evidence_source_data');
  }
  return {
    rawContent: stored.source.content,
    mapping: {
      mode: 'application_region',
      humanRegion: geometry.humanRegion,
      applicationWrapper: geometry.applicationWrapper,
    },
    quoteRegions: geometry.quoteRegions,
  };
}

function checkReconstructedGeometry(
  stored: AutonomousPersonalStoredSourceIdentityV4,
  geometry: AutonomousSourceGeometryCompilationV3,
): void {
  const expected = stored.tuple.envelope.geometry;
  if (
    geometry.geometryHash !== stored.tuple.owner.geometryHash ||
    geometry.geometryHash !== stored.tuple.identity.geometryHash ||
    canonicalAutomaticCaptureV2(geometry.geometry) !== canonicalAutomaticCaptureV2(expected) ||
    geometry.geometry.rawContentHash !== stored.tuple.owner.contentHash ||
    geometry.geometry.rawContentHash !== stored.tuple.identity.contentHash ||
    geometry.geometry.rawUtf16Length !== stored.source.content.length
  ) {
    fail('invalid_autonomous_evidence_source_data');
  }
}

function hashScan(scan: AutonomousPersonalSourceScanV1): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-source-scan-v1',
    sourceScan: scan,
  });
}

function hashFraming(framing: AutonomousPersonalFramingV1): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-framing-v1',
    framing,
  });
}

function hashTypedSyntax(typedSyntax: AutonomousPersonalTypedSyntaxV1): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-typed-syntax-v1',
    typedSyntax,
  });
}

function sourceScopeHashMismatch(
  geometry: AutonomousSourceGeometryCompilationV3,
  scan: AutonomousPersonalSourceScanV1,
  framing: AutonomousPersonalFramingV1,
  typedSyntax: AutonomousPersonalTypedSyntaxV1,
): boolean {
  const scanHash = hashScan(scan);
  return (
    scan.rawContentHash !== geometry.geometry.rawContentHash ||
    scan.mappedContentHash !== geometry.geometry.mappedContentHash ||
    scan.geometryHash !== geometry.geometryHash ||
    framing.rawContentHash !== scan.rawContentHash ||
    framing.mappedContentHash !== scan.mappedContentHash ||
    framing.geometryHash !== geometry.geometryHash ||
    framing.sourceScanHash !== scanHash ||
    framing.scanStatus !== scan.status ||
    (scan.status === 'complete' && framing.units.length !== scan.units.length) ||
    typedSyntax.rawContentHash !== geometry.geometry.rawContentHash ||
    typedSyntax.mappedContentHash !== geometry.geometry.mappedContentHash ||
    typedSyntax.geometryHash !== geometry.geometryHash ||
    typedSyntax.sourceScanHash !== scanHash ||
    typedSyntax.framingHash !== hashFraming(framing) ||
    typedSyntax.units.length !== (typedSyntax.status === 'complete' ? scan.units.length : 0)
  );
}

function providerRowById(
  response: ReturnType<typeof validateAutonomousPersonalProviderResponseV1>,
): ReadonlyMap<string, AutonomousPersonalProviderUnitV1> {
  return new Map(response.units.map((unit) => [unit.unitId, unit] as const));
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

function wordTokensForUnit(
  body: string,
  tokens: readonly AutonomousSourceLexicalTokenV1[],
  unit: AutonomousPersonalSourceScanV1['units'][number],
): AutonomousSourceLexicalTokenV1[] {
  return tokens
    .slice(unit.tokenSpan.start, unit.tokenSpan.end)
    .filter((token) => token.kind === 'word');
}

function statementHeadIsSupported(
  body: string,
  tokens: readonly AutonomousSourceLexicalTokenV1[],
  unit: AutonomousPersonalSourceScanV1['units'][number],
  framingUnit: AutonomousPersonalFramingV1['units'][number],
  unitCount: number,
): boolean {
  const localTokens = tokens.slice(unit.tokenSpan.start, unit.tokenSpan.end);
  const words = wordTokensForUnit(body, tokens, unit);
  const head = framingUnit.headCode;
  const prefix =
    head === 'remember_prefix_i' ||
    head === 'remember_prefix_i_am' ||
    head === 'remember_prefix_i_have';
  if (prefix) {
    if (
      unitCount !== 1 ||
      unit.mappedSpan.start !== 0 ||
      unit.mappedSpan.end !== body.length ||
      localTokens[0]?.kind !== 'word' ||
      asciiLower(body.slice(localTokens[0].start, localTokens[0].end)) !== 'remember' ||
      localTokens[1]?.kind !== 'word' ||
      asciiLower(body.slice(localTokens[1].start, localTokens[1].end)) !== 'this' ||
      localTokens[2]?.kind !== 'punctuation' ||
      localTokens[2].codePoint !== 0x3a
    ) {
      return false;
    }
  } else if (head !== 'direct_i' && head !== 'contracted_i_am' && head !== 'contracted_i_have') {
    return false;
  }

  const headWordIndex = prefix ? 2 : 0;
  const firstWord = words[headWordIndex];
  if (!firstWord) return false;
  const normalizedHead = asciiLower(body.slice(firstWord.start, firstWord.end));
  const expectedHead = head.endsWith('_i_am')
    ? ["i'm", 'i’m']
    : head.endsWith('_i_have')
      ? ["i've", 'i’ve']
      : ['i'];
  if (!expectedHead.includes(normalizedHead)) return false;
  const subjectTokenIndex = prefix ? 3 : 0;
  return localTokens[subjectTokenIndex + 1]?.kind === 'word';
}

interface CandidateBuild {
  readonly reference: Omit<AutonomousPersonalEvidenceSelectionOccurrenceV1, 'candidateIndex'>;
  readonly dependencyCount: number;
}

class CandidateCapacity extends Error {}
class AggregateCapacity extends Error {}

function providerReason(
  row: AutonomousPersonalProviderUnitV1,
  typedPositive: boolean,
): AutonomousPersonalEvidenceSelectionReasonV1 | null {
  if (row.category === 'unknown' || row.usefulness === 'unknown' || row.risk === 'unknown')
    return 'provider_unknown';
  if (row.risk === 'sensitive') return 'provider_sensitive';
  if (row.downgrade.length > 0) return 'provider_downgrade';
  if (typedPositive && row.category !== 'preference') return 'typed_category_conflict';
  if (row.usefulness !== 'personal_memory') return 'provider_conflict';
  return null;
}

function coverageReason(
  units: readonly AutonomousPersonalEvidenceSelectionUnitV1[],
):
  | 'ambiguous_scope'
  | 'retroactive_correction'
  | 'unsupported_scope'
  | 'provider_unknown'
  | 'multiple'
  | null {
  const mapped = new Set<string>();
  for (const unit of units) {
    if (unit.outcome !== 'unresolved' || unit.reason === null) continue;
    switch (unit.reason) {
      case 'ambiguous_scope':
        mapped.add('ambiguous_scope');
        break;
      case 'retroactive_correction':
        mapped.add('retroactive_correction');
        break;
      case 'provider_conflict':
      case 'provider_sensitive':
      case 'provider_downgrade':
      case 'provider_unknown':
      case 'typed_category_conflict':
        mapped.add('provider_unknown');
        break;
      case 'statement_structure':
      case 'unsupported_scope':
        mapped.add('unsupported_scope');
        break;
      default:
        fail('invalid_autonomous_evidence_selection_data');
    }
  }
  if (mapped.size === 0) return null;
  if (mapped.size > 1) return 'multiple';
  return [...mapped][0] as
    | 'ambiguous_scope'
    | 'retroactive_correction'
    | 'unsupported_scope'
    | 'provider_unknown';
}

function makeCoverage(units: readonly AutonomousPersonalEvidenceSelectionUnitV1[]) {
  const candidateUnitCount = units.filter((unit) => unit.outcome === 'candidate').length;
  const neutralUnitCount = units.filter((unit) => unit.outcome === 'neutral').length;
  const withheldUnitCount = units.filter((unit) => unit.outcome === 'withheld').length;
  const unresolvedUnitCount = units.filter((unit) => unit.outcome === 'unresolved').length;
  const known = candidateUnitCount + neutralUnitCount + withheldUnitCount;
  const status = unresolvedUnitCount === 0 ? 'complete' : known === 0 ? 'unknown' : 'partial';
  return {
    status,
    scanStatus: 'complete' as const,
    sourceUnitCount: units.length,
    candidateUnitCount,
    neutralUnitCount,
    withheldUnitCount,
    unresolvedUnitCount,
    unresolvedReason: coverageReason(units),
  };
}

function makeCapacityResult(input: {
  stored: AutonomousPersonalStoredSourceIdentityV4;
  geometry: AutonomousSourceGeometryCompilationV3;
  scan: AutonomousPersonalSourceScanV1;
  framing: AutonomousPersonalFramingV1;
  typedSyntax: AutonomousPersonalTypedSyntaxV1;
  status: 'not_interpreted' | 'capacity';
  reason:
    | 'source_indeterminate'
    | 'source_resource'
    | 'unit_count'
    | 'typed_metadata'
    | 'aggregate';
  check: () => void;
}): AutonomousPersonalEvidenceSelectionV1 {
  const { stored, geometry, scan, framing, typedSyntax, status, reason, check } = input;
  const base = {
    version: 1 as const,
    sourceId: stored.tuple.owner.sourceId,
    sourceHash: stored.tuple.identity.sourceHash,
    descriptorHash: stored.tuple.owner.descriptorHash,
    policyFingerprint: stored.tuple.owner.policyFingerprint,
    geometryHash: geometry.geometryHash,
    sourceScanHash: hashScan(scan),
    framingHash: hashFraming(framing),
    typedSyntaxHash: hashTypedSyntax(typedSyntax),
  };
  let sourceCoverage: Record<string, unknown>;
  if (reason === 'source_indeterminate') {
    const scanReason = scan.coverage.indeterminateSpan?.reasonCode ?? 'ambiguous_period_boundary';
    sourceCoverage = {
      status: 'unknown',
      scanStatus: 'indeterminate_suffix',
      sourceUnitCount: null,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: null,
      unresolvedReason: scanReason,
    };
  } else if (reason === 'source_resource') {
    const resourceReason = scan.resourceReason?.kind ?? 'unit_limit';
    sourceCoverage = {
      status: 'not_reported',
      scanStatus: 'resource_limit',
      sourceUnitCount: null,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: null,
      unresolvedReason: resourceReason,
    };
  } else {
    sourceCoverage = {
      status: 'unknown',
      scanStatus: 'complete',
      sourceUnitCount: scan.units.length,
      candidateUnitCount: 0,
      neutralUnitCount: 0,
      withheldUnitCount: 0,
      unresolvedUnitCount: scan.units.length,
      unresolvedReason: 'interpretation_capacity',
    };
  }
  check();
  try {
    return deepFreeze(
      AutonomousPersonalEvidenceSelectionV1OwnedDataSchema.parse({
        ...base,
        status,
        reason,
        sourceCoverage,
        units: [],
        occurrences: [],
      }),
    );
  } catch {
    check();
    fail('invalid_autonomous_evidence_selection_data');
  }
}

function makeCompleteResult(input: {
  stored: AutonomousPersonalStoredSourceIdentityV4;
  geometry: AutonomousSourceGeometryCompilationV3;
  scan: AutonomousPersonalSourceScanV1;
  framing: AutonomousPersonalFramingV1;
  typedSyntax: AutonomousPersonalTypedSyntaxV1;
  units: AutonomousPersonalEvidenceSelectionUnitV1[];
  occurrences: AutonomousPersonalEvidenceSelectionOccurrenceV1[];
  check: () => void;
}): AutonomousPersonalEvidenceSelectionV1 {
  const { stored, geometry, scan, framing, typedSyntax, units, occurrences, check } = input;
  const result = {
    version: 1 as const,
    status: 'complete' as const,
    sourceId: stored.tuple.owner.sourceId,
    sourceHash: stored.tuple.identity.sourceHash,
    descriptorHash: stored.tuple.owner.descriptorHash,
    policyFingerprint: stored.tuple.owner.policyFingerprint,
    geometryHash: geometry.geometryHash,
    sourceScanHash: hashScan(scan),
    framingHash: hashFraming(framing),
    typedSyntaxHash: hashTypedSyntax(typedSyntax),
    sourceCoverage: makeCoverage(units),
    units,
    occurrences,
  };
  check();
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    fail('invalid_autonomous_evidence_selection_data');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SELECTION_BYTES) {
    return makeCapacityResult({
      stored,
      geometry,
      scan,
      framing,
      typedSyntax,
      status: 'capacity',
      reason: 'aggregate',
      check,
    });
  }
  try {
    const parsed = AutonomousPersonalEvidenceSelectionV1OwnedDataSchema.parse(result);
    check();
    return deepFreeze(parsed);
  } catch {
    check();
    fail('invalid_autonomous_evidence_selection_data');
  }
}

function buildCandidateForUnit(input: {
  stored: AutonomousPersonalStoredSourceIdentityV4;
  descriptor: AutonomousPersonalStoredSourceIdentityV4['descriptor'];
  geometry: AutonomousSourceGeometryCompilationV3;
  scan: AutonomousPersonalSourceScanV1;
  syntax: AutonomousPersonalTypedSyntaxV1;
  unit: AutonomousPersonalSourceScanV1['units'][number];
  provider: AutonomousPersonalProviderUnitV1;
  unitId: string;
  statementSupported: boolean;
}): CandidateBuild[] {
  const { stored, descriptor, geometry, scan, syntax, unit, provider, unitId, statementSupported } =
    input;
  const typeRow = syntax.units[unit.index];
  if (!typeRow || typeRow.unitIndex !== unit.index) {
    fail('invalid_autonomous_evidence_selection_data');
  }
  const typedPositive = typeRow.kind === 'typed';
  const typedBundleList = typedPositive ? typeRow.preference.bundles : [];
  const category = provider.category;
  if (category === 'unknown') return [];
  const mappedBody = geometry.mappedHumanBody;
  const rawBody = stored.source.content;
  const rawHumanStart = scan.rawHumanRegion.start;
  const rawHumanEnd = scan.rawHumanRegion.end;
  const builds: CandidateBuild[] = [];

  const buildReference = (candidate: unknown): CandidateBuild => {
    const result = buildAutonomousPersonalClaimCandidateV1(candidate);
    if (result.kind === 'candidate_capacity') throw new CandidateCapacity();
    if (result.kind === 'aggregate_capacity') throw new AggregateCapacity();
    return { reference: result.reference, dependencyCount: result.dependencyCount };
  };

  if (typedPositive) {
    for (const bundle of typedBundleList) {
      const occurrence = bundle.evidence.spans[0];
      if (!occurrence || bundle.evidence.spans.length !== 1) {
        fail('invalid_autonomous_evidence_selection_data');
      }
      const rawSpan = { ...occurrence.raw };
      const mappedSpan = { ...occurrence.content };
      const literal = bundle.evidence.lexicalForm;
      if (
        mappedBody.slice(mappedSpan.start, mappedSpan.end) !== literal ||
        rawBody.slice(rawSpan.start, rawSpan.end) !== literal ||
        rawSpan.end > rawHumanEnd ||
        rawSpan.start < rawHumanStart
      ) {
        fail('invalid_autonomous_evidence_selection_data');
      }
      builds.push(
        buildReference({
          sourceId: stored.tuple.owner.sourceId,
          contentHash: stored.tuple.owner.contentHash,
          descriptorHash: stored.tuple.owner.descriptorHash,
          namespace: stored.tuple.owner.namespace,
          subjectId: stored.tuple.owner.binding.subjectId,
          sourceHash: stored.tuple.identity.sourceHash,
          policy: descriptor.policy,
          sourceEventTime: new Date(Date.parse(stored.source.reference_time)).toISOString(),
          unitId,
          unitIndex: unit.index,
          kind: 'typed_preference',
          category: 'preference',
          literal,
          rawSpan,
          mappedSpan,
          bundle,
        }),
      );
    }
    return builds;
  }

  if (!statementSupported) fail('invalid_autonomous_evidence_selection_data');
  const rawSpan = { start: unit.rawSpan.start, end: unit.rawSpan.end };
  const mappedSpan = { start: unit.mappedSpan.start, end: unit.mappedSpan.end };
  const literal = rawBody.slice(rawSpan.start, rawSpan.end);
  if (
    mappedBody.slice(mappedSpan.start, mappedSpan.end) !== literal ||
    rawSpan.start !== rawHumanStart + mappedSpan.start ||
    rawSpan.end !== rawHumanStart + mappedSpan.end
  ) {
    fail('invalid_autonomous_evidence_selection_data');
  }
  return [
    buildReference({
      sourceId: stored.tuple.owner.sourceId,
      contentHash: stored.tuple.owner.contentHash,
      descriptorHash: stored.tuple.owner.descriptorHash,
      namespace: stored.tuple.owner.namespace,
      subjectId: stored.tuple.owner.binding.subjectId,
      sourceHash: stored.tuple.identity.sourceHash,
      policy: descriptor.policy,
      sourceEventTime: new Date(Date.parse(stored.source.reference_time)).toISOString(),
      unitId,
      unitIndex: unit.index,
      kind: 'source_statement_record',
      category,
      literal,
      rawSpan,
      mappedSpan,
      bundle: null,
    }),
  ];
}

function rememberPrefixExceedsBound(
  body: string,
  tokens: readonly AutonomousSourceLexicalTokenV1[],
  unit: AutonomousPersonalSourceScanV1['units'][number],
  framingUnit: AutonomousPersonalFramingV1['units'][number],
  unitCount: number,
): boolean {
  if (
    framingUnit.headCode !== 'remember_prefix_i' &&
    framingUnit.headCode !== 'remember_prefix_i_am' &&
    framingUnit.headCode !== 'remember_prefix_i_have'
  )
    return false;
  if (unitCount !== 1 || unit.mappedSpan.start !== 0 || unit.mappedSpan.end !== body.length)
    return false;
  const localTokens = tokens.slice(unit.tokenSpan.start, unit.tokenSpan.end);
  const firstPersonToken = localTokens[3];
  if (firstPersonToken?.kind !== 'word') fail('invalid_autonomous_evidence_selection_data');
  const prefix = body.slice(0, firstPersonToken.start);
  return (
    Array.from(prefix).length > MAX_STATEMENT_CODE_POINTS ||
    Buffer.byteLength(prefix, 'utf8') > MAX_STATEMENT_BYTES
  );
}

/** Rebuild bounded source evidence and provider joins from persisted DATA. No storage authority or acceptance. */
export function compileAutonomousPersonalEvidenceSelectionV1(
  input: unknown,
  providerResponse: unknown,
  work: AutonomousPersonalTypedSyntaxWorkV1,
): AutonomousPersonalEvidenceSelectionV1 {
  const enteredAt = performance.now();
  const { check, typedSyntaxWork } = makeWorkCheck(work, enteredAt);
  check();

  let ownedInput: z.infer<typeof inputSchema>;
  try {
    const snapshot = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    ownedInput = inputSchema.parse(snapshot);
  } catch {
    check();
    fail('invalid_autonomous_evidence_input_data');
  }
  check();

  let stored: AutonomousPersonalStoredSourceIdentityV4;
  try {
    stored = reconstructAutonomousPersonalStoredSourceIdentityV4({
      source: ownedInput.source,
      descriptor: ownedInput.descriptor,
    });
  } catch {
    check();
    fail('invalid_autonomous_evidence_source_data');
  }
  check();
  if (
    !AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema.safeParse(stored).success ||
    stored.descriptorValidation !== 'compiled_descriptor'
  ) {
    fail('invalid_autonomous_evidence_source_data');
  }

  let geometry: AutonomousSourceGeometryCompilationV3;
  const geometryInput = geometryInputFromStored(stored);
  try {
    geometry = compileAutonomousSourceGeometryV3(geometryInput);
    checkReconstructedGeometry(stored, geometry);
  } catch {
    check();
    fail('invalid_autonomous_evidence_source_data');
  }
  check();

  let scan: AutonomousPersonalSourceScanV1;
  let framing: AutonomousPersonalFramingV1;
  try {
    scan = compileAutonomousPersonalSourceScanV1(geometryInput);
    check();
    framing = compileAutonomousPersonalFramingV1(geometryInput);
  } catch {
    check();
    fail('invalid_autonomous_evidence_source_data');
  }
  check();

  const syntaxScope = {
    namespace: stored.tuple.owner.namespace,
    issuer: stored.tuple.owner.issuer,
    actorReference: stored.tuple.owner.actorReference,
    binding: stored.tuple.owner.binding,
  };
  let typedSyntax: AutonomousPersonalTypedSyntaxV1;
  try {
    typedSyntax = compileAutonomousPersonalTypedSyntaxV1(
      { ...geometryInput, syntaxScope },
      typedSyntaxWork,
    );
  } catch (error) {
    check();
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) {
      if (error.reason === 'cancelled') fail('cancelled_autonomous_evidence_selection');
      if (error.reason === 'deadline') fail('deadline_autonomous_evidence_selection');
    }
    fail('invalid_autonomous_evidence_selection_data');
  }
  check();
  if (
    sourceScopeHashMismatch(geometry, scan, framing, typedSyntax) ||
    typedSyntax.syntaxScopeHash !==
      hashAutomaticCaptureV2({ domain: 'engram-autonomous-syntax-scope-v1', syntaxScope })
  ) {
    fail('invalid_autonomous_evidence_selection_data');
  }

  if (scan.status === 'indeterminate') {
    requireNoProviderResponse(providerResponse);
    if (typedSyntax.status !== 'not_interpreted' || typedSyntax.reason !== 'source_indeterminate')
      fail('invalid_autonomous_evidence_selection_data');
    return makeCapacityResult({
      stored,
      geometry,
      scan,
      framing,
      typedSyntax,
      status: 'not_interpreted',
      reason: 'source_indeterminate',
      check,
    });
  }
  if (scan.status === 'resource_limit') {
    requireNoProviderResponse(providerResponse);
    if (typedSyntax.status !== 'capacity' || typedSyntax.reason !== 'source_resource')
      fail('invalid_autonomous_evidence_selection_data');
    return makeCapacityResult({
      stored,
      geometry,
      scan,
      framing,
      typedSyntax,
      status: 'capacity',
      reason: 'source_resource',
      check,
    });
  }
  if (typedSyntax.status === 'not_interpreted') {
    fail('invalid_autonomous_evidence_selection_data');
  }
  if (scan.units.length > 32) {
    requireNoProviderResponse(providerResponse);
    return makeCapacityResult({
      stored,
      geometry,
      scan,
      framing,
      typedSyntax,
      status: 'capacity',
      reason: 'unit_count',
      check,
    });
  }
  if (typedSyntax.status === 'capacity') {
    requireNoProviderResponse(providerResponse);
    const reason = typedSyntax.reason === 'typed_metadata' ? 'typed_metadata' : 'aggregate';
    if (typedSyntax.reason !== 'typed_metadata' && typedSyntax.reason !== 'aggregate') {
      fail('invalid_autonomous_evidence_selection_data');
    }
    return makeCapacityResult({
      stored,
      geometry,
      scan,
      framing,
      typedSyntax,
      status: 'capacity',
      reason,
      check,
    });
  }

  const body = geometry.mappedHumanBody;
  const tokens = tokenizeMappedBody(body);
  if (!tokens || tokens.length !== scan.tokenCount) {
    fail('invalid_autonomous_evidence_selection_data');
  }
  for (const unit of scan.units) {
    const typeRow = typedSyntax.units[unit.index];
    const framingUnit = framing.units[unit.index];
    if (!typeRow || !framingUnit || typeRow.unitIndex !== unit.index) {
      fail('invalid_autonomous_evidence_selection_data');
    }
    if (typeRow.kind === 'typed') continue;
    const sharedFrame = framing.sourceScopeFindings.length > 0;
    const sharedVeto =
      sharedFrame ||
      framingUnit.observationCodes.includes('geometry_quote_overlap') ||
      framingUnit.observationCodes.includes('paired_text_quote_overlap') ||
      framingUnit.observationCodes.includes('report_complement') ||
      framingUnit.observationCodes.includes('question_terminal') ||
      framingUnit.observationCodes.includes('instruction_memory_pattern') ||
      framingUnit.sensitivityCodes.length > 0 ||
      framingUnit.observationCodes.includes('conditional_uncertainty_token');
    if (
      !sharedVeto &&
      statementHeadIsSupported(body, tokens, unit, framingUnit, scan.units.length) &&
      rememberPrefixExceedsBound(body, tokens, unit, framingUnit, scan.units.length)
    ) {
      requireNoProviderResponse(providerResponse);
      return makeCapacityResult({
        stored,
        geometry,
        scan,
        framing,
        typedSyntax,
        status: 'capacity',
        reason: 'aggregate',
        check,
      });
    }
  }

  const unitIds: string[] = [];
  for (const unit of scan.units) {
    check();
    unitIds.push(
      hashAutonomousPersonalSourceUnitIdV1({
        rawContentHash: scan.rawContentHash,
        unitIndex: unit.index,
        parentRawSpan: unit.rawSpan,
        parentMappedSpan: unit.mappedSpan,
      }),
    );
  }
  let providerRows: ReadonlyMap<string, AutonomousPersonalProviderUnitV1>;
  if (unitIds.length === 0) {
    requireNoProviderResponse(providerResponse);
    providerRows = new Map();
  } else {
    try {
      providerRows = providerRowById(
        validateAutonomousPersonalProviderResponseV1({
          response: providerResponse,
          unitIds,
        }),
      );
    } catch {
      check();
      fail('invalid_autonomous_evidence_provider_data');
    }
    check();
  }

  const typedRows = typedSyntax.units;
  const units: AutonomousPersonalEvidenceSelectionUnitV1[] = [];
  const occurrences: AutonomousPersonalEvidenceSelectionOccurrenceV1[] = [];
  let dependencyCount = 0;
  let unresolvedStart: number | null = null;
  let reportWithheldStart: number | null = null;
  let reportAmbiguousStart: number | null = null;

  const retroactiveAmbiguous = framing.sourceScopeFindings.some(
    (finding) => finding.code === 'ambiguous_retroactive_frame',
  );
  const retroactiveComplete = framing.sourceScopeFindings.some(
    (finding) => finding.code === 'retroactive_frame',
  );
  if (retroactiveAmbiguous) {
    for (const unit of scan.units) {
      units.push({
        unitIndex: unit.index,
        unitId: unitIds[unit.index]!,
        outcome: 'unresolved',
        kind: null,
        reason: 'retroactive_correction',
      });
    }
  } else if (retroactiveComplete) {
    for (const unit of scan.units) {
      units.push({
        unitIndex: unit.index,
        unitId: unitIds[unit.index]!,
        outcome: 'withheld',
        kind: null,
        reason: 'retroactive_correction',
      });
    }
  } else {
    const ambiguousFinding = framing.sourceScopeFindings
      .filter((finding) => finding.code === 'ambiguous_report_example_prefix')
      .sort((left, right) => left.fromUnitIndex - right.fromUnitIndex)[0];
    const completeFinding = framing.sourceScopeFindings
      .filter((finding) => finding.code === 'report_example_header')
      .sort((left, right) => left.fromUnitIndex - right.fromUnitIndex)[0];
    // The earliest report/example finding owns the entire remaining suffix.
    // A later incomplete header cannot downgrade an already known report frame.
    if (
      ambiguousFinding &&
      (!completeFinding || ambiguousFinding.fromUnitIndex <= completeFinding.fromUnitIndex)
    ) {
      reportAmbiguousStart = ambiguousFinding.fromUnitIndex;
    } else {
      reportWithheldStart = completeFinding?.fromUnitIndex ?? null;
    }

    for (const unit of scan.units) {
      check();
      const index = unit.index;
      const framingUnit = framing.units[index];
      const typeRow = typedRows[index];
      if (!framingUnit || !typeRow || typeRow.unitIndex !== index) {
        fail('invalid_autonomous_evidence_selection_data');
      }
      const baseUnit = { unitIndex: index, unitId: unitIds[index]! };
      if (unresolvedStart !== null && index > unresolvedStart) {
        units.push({ ...baseUnit, outcome: 'unresolved', kind: null, reason: 'ambiguous_scope' });
        continue;
      }
      if (reportAmbiguousStart !== null && index >= reportAmbiguousStart) {
        unresolvedStart ??= reportAmbiguousStart;
        units.push({ ...baseUnit, outcome: 'unresolved', kind: null, reason: 'ambiguous_scope' });
        continue;
      }
      if (reportWithheldStart !== null && index >= reportWithheldStart) {
        units.push({ ...baseUnit, outcome: 'withheld', kind: null, reason: 'source_frame' });
        continue;
      }

      const hasQuote =
        geometry.geometry.quoteRegions.some(
          (quote) => unit.mappedSpan.start < quote.end && unit.mappedSpan.end > quote.start,
        ) ||
        unit.observedCueCodes.includes('explicit_geometry_quote_overlap') ||
        unit.observedCueCodes.includes('paired_text_quote_overlap') ||
        framingUnit.observationCodes.includes('geometry_quote_overlap') ||
        framingUnit.observationCodes.includes('paired_text_quote_overlap');
      const hasReportComplement = framingUnit.observationCodes.includes('report_complement');
      if (hasQuote || hasReportComplement) {
        units.push({ ...baseUnit, outcome: 'withheld', kind: null, reason: 'source_frame' });
        continue;
      }
      if (framingUnit.observationCodes.includes('question_terminal')) {
        units.push({ ...baseUnit, outcome: 'withheld', kind: null, reason: 'question_terminal' });
        continue;
      }
      if (framingUnit.observationCodes.includes('instruction_memory_pattern')) {
        units.push({ ...baseUnit, outcome: 'withheld', kind: null, reason: 'instruction' });
        continue;
      }
      if (framingUnit.sensitivityCodes.length > 0) {
        units.push({ ...baseUnit, outcome: 'withheld', kind: null, reason: 'sensitive' });
        continue;
      }

      const provider = providerRows.get(unitIds[index]!);
      if (!provider) fail('invalid_autonomous_evidence_selection_data');
      const neutral = framingUnit.observationCodes.includes('neutral_greeting_shape');
      if (neutral) {
        if (
          provider.category !== 'unknown' &&
          provider.usefulness === 'not_memory' &&
          provider.risk === 'ordinary' &&
          provider.downgrade.length === 0
        ) {
          units.push({
            ...baseUnit,
            outcome: 'neutral',
            kind: null,
            reason: 'neutral_greeting',
          });
          continue;
        }
        const reason =
          provider.category === 'unknown' ||
          provider.usefulness === 'unknown' ||
          provider.risk === 'unknown'
            ? 'provider_unknown'
            : provider.risk === 'sensitive'
              ? 'provider_sensitive'
              : provider.downgrade.length > 0
                ? 'provider_downgrade'
                : 'provider_conflict';
        unresolvedStart ??= index;
        units.push({ ...baseUnit, outcome: 'unresolved', kind: null, reason });
        continue;
      }

      const typedPositive = typeRow.kind === 'typed';
      const conditionVeto = framingUnit.observationCodes.includes('conditional_uncertainty_token');
      const statementSupported = statementHeadIsSupported(
        body,
        tokens,
        unit,
        framingUnit,
        scan.units.length,
      );
      if (!typedPositive && conditionVeto) {
        units.push({
          ...baseUnit,
          outcome: 'withheld',
          kind: null,
          reason: 'statement_structure',
        });
        continue;
      }
      if (!typedPositive && !statementSupported) {
        const incompleteOrUnsupportedHead =
          framingUnit.headCode === 'unsupported_i_contraction' ||
          framingUnit.headCode === 'incomplete_i_head';
        const reason = incompleteOrUnsupportedHead ? 'unsupported_scope' : 'statement_structure';
        unresolvedStart ??= index;
        units.push({ ...baseUnit, outcome: 'unresolved', kind: null, reason });
        continue;
      }

      const providerConflictReason = providerReason(provider, typedPositive);
      if (providerConflictReason !== null) {
        unresolvedStart ??= index;
        units.push({
          ...baseUnit,
          outcome: 'unresolved',
          kind: null,
          reason: providerConflictReason,
        });
        continue;
      }

      let built: CandidateBuild[];
      try {
        built = buildCandidateForUnit({
          stored,
          descriptor: stored.descriptor,
          geometry,
          scan,
          syntax: typedSyntax,
          unit,
          provider,
          unitId: unitIds[index]!,
          statementSupported,
        });
      } catch (error) {
        if (error instanceof CandidateCapacity) {
          units.push({ ...baseUnit, outcome: 'withheld', kind: null, reason: 'claim_capacity' });
          continue;
        }
        if (error instanceof AggregateCapacity) {
          return makeCapacityResult({
            stored,
            geometry,
            scan,
            framing,
            typedSyntax,
            status: 'capacity',
            reason: 'aggregate',
            check,
          });
        }
        check();
        fail('invalid_autonomous_evidence_selection_data');
      }
      const candidateKind = typedPositive ? 'typed_preference' : 'source_statement_record';
      if (built.length === 0) fail('invalid_autonomous_evidence_selection_data');
      if (
        occurrences.length + built.length > MAX_CLAIM_OCCURRENCES ||
        dependencyCount + built.reduce((total, item) => total + item.dependencyCount, 0) >
          MAX_DEPENDENCIES
      ) {
        return makeCapacityResult({
          stored,
          geometry,
          scan,
          framing,
          typedSyntax,
          status: 'capacity',
          reason: 'aggregate',
          check,
        });
      }
      for (const item of built) {
        occurrences.push({
          ...item.reference,
          candidateIndex: occurrences.length,
        });
      }
      dependencyCount += built.reduce((total, item) => total + item.dependencyCount, 0);
      units.push({ ...baseUnit, outcome: 'candidate', kind: candidateKind, reason: null });
    }
  }

  check();
  return makeCompleteResult({
    stored,
    geometry,
    scan,
    framing,
    typedSyntax,
    units,
    occurrences,
    check,
  });
}
