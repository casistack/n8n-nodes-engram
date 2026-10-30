import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  AutomaticSourceEnvelopeSchema,
  AutomaticBindingReferenceSchema,
} from '../schemas/AutomaticMemory.schema';
import {
  compileAutonomousPersonalFramingV1,
  type AutonomousPersonalFramingV1,
} from '../schemas/AutonomousPersonalFramingV1.schema';
import {
  compileAutonomousPersonalSourceScanV1,
  type AutonomousPersonalSourceScanV1,
} from '../schemas/AutonomousPersonalSourceScanV1.schema';
import {
  compileAutonomousSourceGeometryV3,
  type AutonomousSourceGeometryCompilationV3,
  type AutonomousSourceGeometryInputV3,
} from '../schemas/AutonomousSourceGeometryV3.schema';
import {
  AutonomousPersonalTypedSyntaxV1OwnedDataSchema,
  type AutonomousPersonalTypedSyntaxV1,
  type AutonomousPersonalTypedSyntaxWorkV1,
} from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  CompositionalPreferenceV2ExecutionReportSchema,
  type CompositionalPreferenceV2ExecutionReport,
} from '../schemas/CompositionalPreferenceV2Execution.schema';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  CompositionalPreferenceV2Schema,
  type CompositionalPreferenceV2,
  type CompositionalPreferenceV2Evidence,
  snapshotBoundedCompositionalJson,
  validateCompositionalPreferenceV2Evidence,
} from '../schemas/CompositionalPreferenceV2.schema';
import { type CompositionalPreferenceV2MeaningProjectionResult } from '../schemas/CompositionalPreferenceV2Meaning.schema';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { projectCompositionalPreferenceV2Meaning } from './CompositionalPreferenceV2Meaning';
import { interpretCompositionalPreferencesV2WithExecutionReport } from './CompositionalPreferenceV2Parser';
import { isAutonomousWhitespaceCodePointV1 } from './AutonomousUnicodeV1';
import {
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject,
} from '../storage/BoundedAutomaticCaptureJson';
import {
  checkCurrentAutonomousPersonalExecutionScopeWorkV1,
  runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1,
} from '../storage/AutonomousPersonalExecutionScopeV1';

const HASH_64 = /^[a-f0-9]{64}$/u;
const SOURCE_MAX_UTF16 = 65_536;
const REPORT_MAX_BYTES = 512 * 1024;
const WORK_CEILING_MS = 5_000;

const regionSchema = z
  .object({
    start: z.number().int().safe().min(0).max(SOURCE_MAX_UTF16),
    end: z.number().int().safe().min(1).max(SOURCE_MAX_UTF16),
  })
  .strict()
  .refine((region) => region.start < region.end);

const mappingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('full_body') }).strict(),
  z
    .object({
      mode: z.literal('application_region'),
      humanRegion: regionSchema,
      applicationWrapper: z
        .object({ configurationFingerprint: z.string().regex(HASH_64) })
        .strict(),
    })
    .strict(),
]);

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function sourceScopeText(maximum: number) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0 && isWellFormedUnicode(value));
}

const syntaxScopeSchema = z
  .object({
    namespace: sourceScopeText(128),
    issuer: sourceScopeText(256),
    actorReference: sourceScopeText(512),
    binding: AutomaticBindingReferenceSchema,
  })
  .strict();

const inputSchema = z
  .object({
    rawContent: z.string().max(SOURCE_MAX_UTF16),
    mapping: mappingSchema,
    quoteRegions: z.array(regionSchema).max(32),
    syntaxScope: syntaxScopeSchema,
  })
  .strict();

type TypedSyntaxInput = z.infer<typeof inputSchema>;
type SyntaxScope = z.infer<typeof syntaxScopeSchema>;
type SourceUnit = AutonomousPersonalSourceScanV1['units'][number];

const failureReasonSchema = z.enum(['invalid_input', 'cancelled', 'deadline', 'internal']);
export type AutonomousPersonalTypedSyntaxFailureReasonV1 = z.infer<typeof failureReasonSchema>;

export class AutonomousPersonalTypedSyntaxFailureV1 extends Error {
  readonly reason: AutonomousPersonalTypedSyntaxFailureReasonV1;

  constructor(reason: AutonomousPersonalTypedSyntaxFailureReasonV1) {
    super('Engram autonomous typed syntax failed');
    this.name = 'AutonomousPersonalTypedSyntaxFailureV1';
    this.reason = reason;
    Object.freeze(this);
  }
}

function fail(reason: AutonomousPersonalTypedSyntaxFailureReasonV1): never {
  throw new AutonomousPersonalTypedSyntaxFailureV1(reason);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

function readWorkContext(value: unknown): {
  readonly deadline: number;
  readonly signal: AbortSignal;
} {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  )
    fail('internal');
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal')
    )
      fail('internal');
    const deadlineProperty = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
    const signalProperty = Object.getOwnPropertyDescriptor(value, 'signal');
    if (
      !deadlineProperty ||
      !deadlineProperty.enumerable ||
      !('value' in deadlineProperty) ||
      !signalProperty ||
      !signalProperty.enumerable ||
      !('value' in signalProperty) ||
      typeof deadlineProperty.value !== 'number' ||
      !Number.isFinite(deadlineProperty.value) ||
      signalProperty.value === null ||
      typeof signalProperty.value !== 'object' ||
      utilTypes.isProxy(signalProperty.value) ||
      nativeAbortSignalAbortedGetter === undefined
    )
      fail('internal');
    nativeAbortSignalAbortedGetter.call(signalProperty.value);
    return {
      deadline: deadlineProperty.value,
      signal: signalProperty.value as AbortSignal,
    };
  } catch (error) {
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
    fail('internal');
  }
}

function createStickyWorkCheck(work: unknown, enteredAt: number): () => void {
  const supplied = readWorkContext(work);
  if (!Number.isFinite(enteredAt)) fail('internal');
  const deadline = Math.min(supplied.deadline, enteredAt + WORK_CEILING_MS);
  let firstFailure: AutonomousPersonalTypedSyntaxFailureV1 | undefined;
  const latch = (reason: AutonomousPersonalTypedSyntaxFailureReasonV1): never => {
    firstFailure ??= new AutonomousPersonalTypedSyntaxFailureV1(reason);
    throw firstFailure;
  };
  const abortedGetter = nativeAbortSignalAbortedGetter;
  if (abortedGetter === undefined) fail('internal');
  return () => {
    if (firstFailure) throw firstFailure;
    try {
      if (abortedGetter.call(supplied.signal)) latch('cancelled');
      const now = performance.now();
      if (!Number.isFinite(now)) latch('internal');
      if (now >= deadline) latch('deadline');
    } catch (error) {
      if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) {
        if (!firstFailure) firstFailure = error;
        throw firstFailure;
      }
      latch('internal');
    }
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function mapReferences(
  geometry: AutonomousSourceGeometryCompilationV3,
  scan: AutonomousPersonalSourceScanV1,
  framing: AutonomousPersonalFramingV1,
  syntaxScope: SyntaxScope,
) {
  const sourceScanHash = hashAutomaticCaptureV2({
    domain: 'engram-autonomous-source-scan-v1',
    sourceScan: scan,
  });
  const framingHash = hashAutomaticCaptureV2({
    domain: 'engram-autonomous-framing-v1',
    framing,
  });
  const syntaxScopeHash = hashAutomaticCaptureV2({
    domain: 'engram-autonomous-syntax-scope-v1',
    syntaxScope,
  });
  return {
    version: 1 as const,
    rawContentHash: geometry.geometry.rawContentHash,
    mappedContentHash: geometry.geometry.mappedContentHash,
    geometryHash: geometry.geometryHash,
    sourceScanHash,
    framingHash,
    syntaxScopeHash,
  };
}

function makeOutput(
  refs: ReturnType<typeof mapReferences>,
  status: 'not_interpreted' | 'capacity',
  reason:
    | 'source_indeterminate'
    | 'source_resource'
    | 'unit_count'
    | 'typed_metadata'
    | 'aggregate',
  check: () => void,
): AutonomousPersonalTypedSyntaxV1 {
  check();
  const output = AutonomousPersonalTypedSyntaxV1OwnedDataSchema.parse({
    ...refs,
    status,
    reason,
    units: [],
  });
  check();
  return deepFreeze(output);
}

function isRememberHead(
  headCode: AutonomousPersonalFramingV1['units'][number]['headCode'],
): boolean {
  return (
    headCode === 'remember_prefix_i' ||
    headCode === 'remember_prefix_i_am' ||
    headCode === 'remember_prefix_i_have'
  );
}

function startsRememberThisPrefix(value: string): boolean {
  const prefix = 'remember this:';
  const observedPrefix = value
    .slice(0, prefix.length)
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (value.length <= prefix.length || observedPrefix !== prefix) return false;
  const next = value.codePointAt(prefix.length);
  return next !== undefined && isAutonomousWhitespaceCodePointV1(next);
}

function blockedFinding(
  unit: SourceUnit,
  framingUnit: AutonomousPersonalFramingV1['units'][number],
  scan: AutonomousPersonalSourceScanV1,
  framing: AutonomousPersonalFramingV1,
  geometry: AutonomousSourceGeometryCompilationV3,
): 'quote' | 'framing' | 'question' | 'instruction' | 'sensitive' | 'remember_scope' | null {
  const sourceFrame = framing.sourceScopeFindings.some(
    (finding) =>
      finding.scope === 'whole_source' ||
      (finding.scope === 'unit_through_eof' && unit.index >= finding.fromUnitIndex),
  );
  if (sourceFrame || framingUnit.observationCodes.includes('report_complement')) return 'framing';

  const unitScan = scan.units[unit.index];
  if (!unitScan) fail('internal');
  const geometryQuote = geometry.geometry.quoteRegions.some(
    (quote) => unit.mappedSpan.start < quote.end && unit.mappedSpan.end > quote.start,
  );
  if (
    geometryQuote ||
    framingUnit.observationCodes.includes('geometry_quote_overlap') ||
    framingUnit.observationCodes.includes('paired_text_quote_overlap') ||
    unitScan.observedCueCodes.includes('explicit_geometry_quote_overlap') ||
    unitScan.observedCueCodes.includes('paired_text_quote_overlap')
  )
    return 'quote';
  if (framingUnit.observationCodes.includes('question_terminal')) return 'question';
  if (framingUnit.observationCodes.includes('instruction_memory_pattern')) return 'instruction';
  if (framingUnit.sensitivityCodes.length > 0) return 'sensitive';

  const firstUnit = framing.units[0];
  const firstScanUnit = scan.units[0];
  const firstUnitText =
    firstScanUnit === undefined
      ? ''
      : geometry.mappedHumanBody.slice(
          firstScanUnit.mappedSpan.start,
          firstScanUnit.mappedSpan.end,
        );
  const globallyAnchoredRemember =
    firstUnit !== undefined &&
    scan.units.length > 1 &&
    (isRememberHead(firstUnit.headCode) || startsRememberThisPrefix(firstUnitText));
  const localRememberPrefix = startsRememberThisPrefix(
    geometry.mappedHumanBody.slice(unit.mappedSpan.start, unit.mappedSpan.end),
  );
  if (
    (isRememberHead(framingUnit.headCode) || localRememberPrefix) &&
    (unit.mappedSpan.start !== 0 || scan.units.length !== 1 || globallyAnchoredRemember)
  )
    return 'remember_scope';
  if (globallyAnchoredRemember) return 'remember_scope';
  return null;
}

function syntaxEnvelope(
  rawContent: string,
  rawContentHash: string,
  scope: SyntaxScope,
  humanRegion: { start: number; end: number },
  mappedContent: string,
): z.infer<typeof AutomaticSourceEnvelopeSchema> {
  const candidate = {
    version: 1 as const,
    namespace: scope.namespace,
    issuer: scope.issuer,
    actorReference: scope.actorReference,
    bindingRef: scope.binding,
    contentHash: sha256(mappedContent),
    rawContentHash,
    mappingAuthority: 'application_region' as const,
    humanRegion,
    mappings: [
      {
        contentStart: 0,
        contentEnd: mappedContent.length,
        rawStart: humanRegion.start,
        rawEnd: humanRegion.end,
      },
    ],
    quoteRegions: [],
    explicitIntent: false,
  };
  const parsed = AutomaticSourceEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) fail('internal');
  if (humanRegion.end > rawContent.length) fail('internal');
  return parsed.data;
}

function translateEvidence(
  evidence: CompositionalPreferenceV2Evidence,
  unit: SourceUnit,
  scan: AutonomousPersonalSourceScanV1,
  geometry: AutonomousSourceGeometryCompilationV3,
  check: () => void,
): void {
  const rawOffset = scan.rawHumanRegion.start;
  for (const span of evidence.spans) {
    check();
    const localStart = span.content.start;
    const localEnd = span.content.end;
    const globalStart = unit.mappedSpan.start + localStart;
    const globalEnd = unit.mappedSpan.start + localEnd;
    if (
      localStart < 0 ||
      localEnd <= localStart ||
      localEnd > unit.mappedSpan.end - unit.mappedSpan.start ||
      globalEnd > geometry.geometry.mappedUtf16Length ||
      span.raw.start < unit.rawSpan.start ||
      span.raw.end > unit.rawSpan.end ||
      span.raw.start !== rawOffset + globalStart ||
      span.raw.end !== rawOffset + globalEnd ||
      geometry.geometry.quoteRegions.some(
        (quote) => globalStart < quote.end && globalEnd > quote.start,
      )
    )
      fail('internal');
    span.content.start = globalStart;
    span.content.end = globalEnd;
  }
}

function translatePreference(
  value: unknown,
  unit: SourceUnit,
  scan: AutonomousPersonalSourceScanV1,
  geometry: AutonomousSourceGeometryCompilationV3,
  rawContent: string,
  scope: SyntaxScope,
  check: () => void,
): CompositionalPreferenceV2 {
  check();
  const snapshot = snapshotBoundedCompositionalJson(value, 32768);
  if (snapshot === undefined) fail('internal');
  let preference = CompositionalPreferenceV2Schema.parse(snapshot);
  const beforeMeaning = projectCompositionalPreferenceV2Meaning({
    preference,
    namespace: scope.namespace,
    subjectId: scope.binding.subjectId,
    check,
  });
  const meaningFailure = capacityReason(beforeMeaning);
  if (meaningFailure !== null) throw meaningFailure;
  if (!beforeMeaning.ok) fail('internal');

  const translate = (evidence: CompositionalPreferenceV2Evidence) =>
    translateEvidence(evidence, unit, scan, geometry, check);
  if (preference.sourceRequest) translate(preference.sourceRequest.evidence);
  for (const bundle of preference.bundles) {
    check();
    translate(bundle.evidence);
    for (const member of bundle.members) translate(member.evidence);
    for (const attachment of bundle.attachments) translate(attachment.evidence);
  }
  const translatedBytes = Buffer.byteLength(JSON.stringify(preference), 'utf8');
  if (translatedBytes > 32 * 1024) {
    throw new AutonomousPersonalSyntaxCapacity('typed_metadata');
  }
  preference = CompositionalPreferenceV2Schema.parse(preference);

  const rawHumanRegion = scan.rawHumanRegion;
  const fullHumanRegion =
    geometry.geometry.mode === 'full_body'
      ? { start: 0, end: geometry.geometry.rawUtf16Length }
      : geometry.geometry.humanRegion;
  if (!fullHumanRegion) fail('internal');
  const fullEnvelope = syntaxEnvelope(
    rawContent,
    geometry.geometry.rawContentHash,
    scope,
    fullHumanRegion,
    geometry.mappedHumanBody,
  );
  if (
    fullHumanRegion.start !== rawHumanRegion.start ||
    fullHumanRegion.end !== rawHumanRegion.end ||
    geometry.mappedHumanBody !== rawContent.slice(rawHumanRegion.start, rawHumanRegion.end)
  )
    fail('internal');
  check();
  const evidenceValidation = validateCompositionalPreferenceV2Evidence({
    preference,
    rawContent,
    mappedContent: geometry.mappedHumanBody,
    envelope: fullEnvelope,
  });
  check();
  if (!evidenceValidation.ok) fail('internal');

  if (preference.sourceRequest && (unit.mappedSpan.start !== 0 || scan.units.length !== 1)) {
    fail('internal');
  }
  const afterMeaning = projectCompositionalPreferenceV2Meaning({
    preference,
    namespace: scope.namespace,
    subjectId: scope.binding.subjectId,
    check,
  });
  const afterMeaningFailure = capacityReason(afterMeaning);
  if (afterMeaningFailure !== null) throw afterMeaningFailure;
  if (!afterMeaning.ok || afterMeaning.canonicalJson !== beforeMeaning.canonicalJson)
    fail('internal');
  check();
  return preference;
}

class AutonomousPersonalSyntaxCapacity extends Error {
  readonly reason: 'typed_metadata' | 'aggregate';

  constructor(reason: 'typed_metadata' | 'aggregate') {
    super('Autonomous syntax capacity');
    this.reason = reason;
  }
}

function capacityReason(
  result: CompositionalPreferenceV2MeaningProjectionResult,
): AutonomousPersonalSyntaxCapacity | null {
  if (result.ok) return null;
  if (result.reason === 'metadata_too_large')
    return new AutonomousPersonalSyntaxCapacity('typed_metadata');
  if (
    result.reason === 'too_many_bundles' ||
    result.reason === 'too_many_nodes' ||
    result.reason === 'nesting_exceeded'
  )
    return new AutonomousPersonalSyntaxCapacity('aggregate');
  return null;
}

function isCompletePositive(report: CompositionalPreferenceV2ExecutionReport): boolean {
  return (
    report.branch === 'complete_ast' &&
    report.result.coverage === 'complete' &&
    report.result.reasons.length === 0 &&
    report.result.bundles.length > 0 &&
    report.result.withheld.length === 0 &&
    report.result.bundles.every((bundle) => bundle.coverage === 'complete')
  );
}

function inputFromOwned(value: unknown): TypedSyntaxInput {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
    return inputSchema.parse(owned);
  } catch {
    fail('invalid_input');
  }
}

function safeParseParserReport(value: unknown): CompositionalPreferenceV2ExecutionReport {
  const parsed = CompositionalPreferenceV2ExecutionReportSchema.safeParse(value);
  if (!parsed.success) fail('internal');
  return parsed.data;
}

function checkInternalFailure(check: () => void, error: unknown): never {
  check();
  if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
  fail('internal');
}

/**
 * Sticky check for registered configured work. The first scope error is latched and rethrown
 * by identity: it is never remapped to a typed-syntax reason or `internal`.
 */
function createConfiguredWorkCheck(work: unknown): () => void {
  readWorkContext(work);
  let firstFailure: unknown;
  let failed = false;
  return () => {
    if (failed) throw firstFailure;
    try {
      checkCurrentAutonomousPersonalExecutionScopeWorkV1(work);
    } catch (error) {
      failed = true;
      firstFailure = error;
      throw error;
    }
  };
}

export function compileAutonomousPersonalTypedSyntaxV1(
  input: unknown,
  work: AutonomousPersonalTypedSyntaxWorkV1,
): AutonomousPersonalTypedSyntaxV1 {
  // Unknown or copied work keeps the exact legacy five-second branch. Registered work for a
  // foreign or closed scope throws here, before any compilation.
  if (checkCurrentAutonomousPersonalExecutionScopeWorkV1(work) === 'configured') {
    const configuredCheck = createConfiguredWorkCheck(work);
    configuredCheck();
    return runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1(work, () =>
      compileWithCheck(input, configuredCheck),
    );
  }
  const enteredAt = performance.now();
  return compileWithCheck(input, createStickyWorkCheck(work, enteredAt));
}

function compileWithCheck(input: unknown, check: () => void): AutonomousPersonalTypedSyntaxV1 {
  check();
  const owned = inputFromOwned(input);
  check();

  const geometryInput: AutonomousSourceGeometryInputV3 = {
    rawContent: owned.rawContent,
    mapping: owned.mapping,
    quoteRegions: owned.quoteRegions,
  };
  let geometry: AutonomousSourceGeometryCompilationV3;
  try {
    geometry = compileAutonomousSourceGeometryV3(geometryInput);
  } catch {
    check();
    fail('invalid_input');
  }
  check();

  let scan: AutonomousPersonalSourceScanV1;
  let framing: AutonomousPersonalFramingV1;
  try {
    scan = compileAutonomousPersonalSourceScanV1(geometryInput);
    check();
    framing = compileAutonomousPersonalFramingV1(geometryInput);
  } catch (error) {
    checkInternalFailure(check, error);
  }
  check();

  const expectedScanHash = hashAutomaticCaptureV2({
    domain: 'engram-autonomous-source-scan-v1',
    sourceScan: scan,
  });
  if (
    scan.rawContentHash !== geometry.geometry.rawContentHash ||
    scan.mappedContentHash !== geometry.geometry.mappedContentHash ||
    scan.geometryHash !== geometry.geometryHash ||
    framing.rawContentHash !== scan.rawContentHash ||
    framing.mappedContentHash !== scan.mappedContentHash ||
    framing.geometryHash !== geometry.geometryHash ||
    framing.sourceScanHash !== expectedScanHash ||
    framing.scanStatus !== scan.status
  )
    fail('internal');
  if (scan.status === 'complete' && framing.units.length !== scan.units.length) fail('internal');

  const refs = mapReferences(geometry, scan, framing, owned.syntaxScope);
  check();
  if (scan.status === 'indeterminate')
    return makeOutput(refs, 'not_interpreted', 'source_indeterminate', check);
  if (scan.status === 'resource_limit')
    return makeOutput(refs, 'capacity', 'source_resource', check);
  if (scan.units.length > 32) return makeOutput(refs, 'capacity', 'unit_count', check);

  const rows: AutonomousPersonalTypedSyntaxV1['units'] = [];
  let bundleCount = 0;
  let rootCount = 0;
  let semanticNodeCount = 0;
  let edgeCount = 0;

  for (const unit of scan.units) {
    check();
    const framingUnit = framing.units[unit.index];
    if (!framingUnit || framingUnit.unitIndex !== unit.index) fail('internal');
    const blocked = blockedFinding(unit, framingUnit, scan, framing, geometry);
    if (blocked !== null) {
      rows.push({ unitIndex: unit.index, kind: 'source_blocked', finding: blocked });
      continue;
    }

    const mappedText = geometry.mappedHumanBody.slice(unit.mappedSpan.start, unit.mappedSpan.end);
    if (
      mappedText.length === 0 ||
      mappedText !== owned.rawContent.slice(unit.rawSpan.start, unit.rawSpan.end) ||
      unit.rawSpan.start !== scan.rawHumanRegion.start + unit.mappedSpan.start ||
      unit.rawSpan.end !== scan.rawHumanRegion.start + unit.mappedSpan.end
    )
      fail('internal');

    const localEnvelope = syntaxEnvelope(
      owned.rawContent,
      geometry.geometry.rawContentHash,
      owned.syntaxScope,
      unit.rawSpan,
      mappedText,
    );
    let parserReport: CompositionalPreferenceV2ExecutionReport;
    try {
      parserReport = safeParseParserReport(
        interpretCompositionalPreferencesV2WithExecutionReport({
          descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
          rawContent: owned.rawContent,
          mappedContent: mappedText,
          envelope: localEnvelope,
          check,
        }),
      );
    } catch (error) {
      checkInternalFailure(check, error);
    }
    check();

    if (
      parserReport.result.sourceRequest &&
      (unit.mappedSpan.start !== 0 || scan.units.length !== 1)
    ) {
      rows.push({ unitIndex: unit.index, kind: 'source_blocked', finding: 'remember_scope' });
      continue;
    }

    const positive = isCompletePositive(parserReport);
    if (
      !positive &&
      parserReport.branch === 'complete_ast' &&
      parserReport.result.reasons.length === 0
    )
      fail('internal');
    if (!positive) {
      rows.push({
        unitIndex: unit.index,
        kind: 'nonmatch',
        parserBranch: parserReport.branch,
        reasons: parserReport.result.reasons,
      });
      continue;
    }

    let translated: CompositionalPreferenceV2;
    try {
      translated = translatePreference(
        parserReport.result,
        unit,
        scan,
        geometry,
        owned.rawContent,
        owned.syntaxScope,
        check,
      );
    } catch (error) {
      if (error instanceof AutonomousPersonalSyntaxCapacity) {
        return makeOutput(refs, 'capacity', error.reason, check);
      }
      checkInternalFailure(check, error);
    }

    bundleCount += translated.bundles.length;
    rootCount += translated.bundles.reduce((total, bundle) => total + bundle.rootNodeIds.length, 0);
    semanticNodeCount += translated.bundles.reduce(
      (total, bundle) => total + bundle.members.length,
      0,
    );
    edgeCount += translated.bundles.reduce((total, bundle) => total + bundle.attachments.length, 0);
    if (bundleCount > 32 || rootCount > 32 || semanticNodeCount > 128 || edgeCount > 128) {
      return makeOutput(refs, 'capacity', 'aggregate', check);
    }
    rows.push({ unitIndex: unit.index, kind: 'typed', preference: translated });
  }

  const output = {
    ...refs,
    status: 'complete' as const,
    units: rows,
  };
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, 'utf8') > REPORT_MAX_BYTES) {
    return makeOutput(refs, 'capacity', 'aggregate', check);
  }
  check();
  try {
    const parsed = AutonomousPersonalTypedSyntaxV1OwnedDataSchema.parse(output);
    check();
    return deepFreeze(parsed);
  } catch {
    check();
    fail('internal');
  }
}
