import { createHash } from 'crypto';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  type CompositionalPreferenceV2,
  type CompositionalPreferenceV2Evidence,
} from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { compileAutonomousPersonalFramingV1 } from '../../../src/schemas/AutonomousPersonalFramingV1.schema';
import { compileAutonomousPersonalSourceScanV1 } from '../../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import { compileAutonomousSourceGeometryV3 } from '../../../src/schemas/AutonomousSourceGeometryV3.schema';
import {
  AutonomousPersonalTypedSyntaxFailureV1,
  compileAutonomousPersonalTypedSyntaxV1,
} from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import * as V2Parser from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';

const NAMESPACE = 'typed-syntax-test';
const ISSUER = 'synthetic-workflow';
const ACTOR = 'synthetic-user';
const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const BINDING_ID = '22222222-2222-4222-8222-222222222222';
const FINGERPRINT = 'a'.repeat(64);

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function scope() {
  return {
    namespace: NAMESPACE,
    issuer: ISSUER,
    actorReference: ACTOR,
    binding: {
      bindingId: BINDING_ID,
      revision: 3,
      subjectId: SUBJECT_ID,
      fingerprint: FINGERPRINT,
    },
  };
}

function input(
  rawContent: string,
  mapping:
    | { mode: 'full_body' }
    | {
        mode: 'application_region';
        humanRegion: { start: number; end: number };
        applicationWrapper: { configurationFingerprint: string };
      } = { mode: 'full_body' },
  quoteRegions: Array<{ start: number; end: number }> = [],
) {
  return { rawContent, mapping, quoteRegions, syntaxScope: scope() };
}

function work(
  signal: AbortSignal = new AbortController().signal,
  deadline = performance.now() + 30_000,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return { absoluteMonotonicDeadlineMs: deadline, signal };
}

function expectFailure(
  invoke: () => unknown,
  reason: 'invalid_input' | 'cancelled' | 'deadline' | 'internal',
  sentinel?: string,
): void {
  let caught: unknown;
  try {
    invoke();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AutonomousPersonalTypedSyntaxFailureV1);
  expect((caught as AutonomousPersonalTypedSyntaxFailureV1).reason).toBe(reason);
  expect((caught as Error).message).not.toContain(sentinel ?? 'private-source-sentinel');
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function parserInput(
  rawContent: string,
  mappedContent: string,
  rawStart: number,
  syntaxScope: ReturnType<typeof scope>,
) {
  const rawEnd = rawStart + mappedContent.length;
  return {
    descriptor: { ...COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR },
    rawContent,
    mappedContent,
    envelope: {
      version: 1 as const,
      namespace: syntaxScope.namespace,
      issuer: syntaxScope.issuer,
      actorReference: syntaxScope.actorReference,
      bindingRef: syntaxScope.binding,
      contentHash: sha256(mappedContent),
      rawContentHash: sha256(rawContent),
      mappingAuthority: 'application_region' as const,
      humanRegion: { start: rawStart, end: rawEnd },
      mappings: [{ contentStart: 0, contentEnd: mappedContent.length, rawStart, rawEnd }],
      quoteRegions: [],
      explicitIntent: false,
    },
  };
}

function shiftEvidence(evidence: CompositionalPreferenceV2Evidence, mappedOffset: number): void {
  for (const span of evidence.spans) {
    span.content.start += mappedOffset;
    span.content.end += mappedOffset;
  }
}

function shiftPreference(
  preference: CompositionalPreferenceV2,
  mappedOffset: number,
): CompositionalPreferenceV2 {
  const shifted = structuredClone(preference);
  for (const bundle of shifted.bundles) {
    shiftEvidence(bundle.evidence, mappedOffset);
    for (const member of bundle.members) shiftEvidence(member.evidence, mappedOffset);
    for (const attachment of bundle.attachments) shiftEvidence(attachment.evidence, mappedOffset);
  }
  if (shifted.sourceRequest) shiftEvidence(shifted.sourceRequest.evidence, mappedOffset);
  return shifted;
}

function expectEvidenceInsideUnit(
  preference: CompositionalPreferenceV2,
  rawContent: string,
  mappedContent: string,
  rawSpan: { start: number; end: number },
  mappedSpan: { start: number; end: number },
): void {
  const evidence: CompositionalPreferenceV2Evidence[] = [];
  for (const bundle of preference.bundles) {
    evidence.push(bundle.evidence);
    evidence.push(...bundle.members.map((member) => member.evidence));
    evidence.push(...bundle.attachments.map((attachment) => attachment.evidence));
  }
  if (preference.sourceRequest) evidence.push(preference.sourceRequest.evidence);
  for (const item of evidence) {
    for (const span of item.spans) {
      expect(span.raw.start).toBeGreaterThanOrEqual(rawSpan.start);
      expect(span.raw.end).toBeLessThanOrEqual(rawSpan.end);
      expect(span.content.start).toBeGreaterThanOrEqual(mappedSpan.start);
      expect(span.content.end).toBeLessThanOrEqual(mappedSpan.end);
      expect(span.raw.start - rawSpan.start).toBe(span.content.start - mappedSpan.start);
      expect(rawContent.slice(span.raw.start, span.raw.end)).toBe(
        mappedContent.slice(span.content.start, span.content.end),
      );
    }
  }
}

function expectMeaningInvariant(
  actual: CompositionalPreferenceV2,
  baseline: CompositionalPreferenceV2,
): void {
  const actualMeaning = projectCompositionalPreferenceV2Meaning({
    preference: actual,
    namespace: NAMESPACE,
    subjectId: SUBJECT_ID,
  });
  const baselineMeaning = projectCompositionalPreferenceV2Meaning({
    preference: baseline,
    namespace: NAMESPACE,
    subjectId: SUBJECT_ID,
  });
  expect(actualMeaning.ok).toBe(true);
  expect(baselineMeaning.ok).toBe(true);
  if (actualMeaning.ok && baselineMeaning.ok) {
    expect(actualMeaning.fingerprint).toBe(baselineMeaning.fingerprint);
    expect(actualMeaning.canonicalJson).toBe(baselineMeaning.canonicalJson);
  }
}

function typedRow(
  report: ReturnType<typeof compileAutonomousPersonalTypedSyntaxV1>,
  index: number,
) {
  expect(report.status).toBe('complete');
  if (report.status !== 'complete') throw new Error('Expected complete syntax report');
  const row = report.units[index];
  expect(row).toBeDefined();
  if (!row || row.kind !== 'typed') throw new Error(`Expected typed row at ${index}`);
  return row;
}

describe('AutonomousPersonalTypedSyntaxV1 is bounded translated syntax DATA', () => {
  test('returns a detached, frozen row for every unit and preserves normal V2 nonmatches', () => {
    const rawContent = 'Hi! I adore jazz. I prefer concise explanations. I like clear answers.';
    const compiled = compileAutonomousPersonalTypedSyntaxV1(input(rawContent), work());

    expect(compiled.status).toBe('complete');
    if (compiled.status !== 'complete') return;
    expect(compiled.units.map((row) => row.unitIndex)).toEqual([0, 1, 2, 3]);
    expect(compiled.units.map((row) => row.kind)).toEqual([
      'nonmatch',
      'nonmatch',
      'typed',
      'typed',
    ]);
    expect(compiled.units[1]?.kind).toBe('nonmatch');
    const scan = compileAutonomousPersonalSourceScanV1({
      rawContent,
      mapping: { mode: 'full_body' },
      quoteRegions: [],
    });
    const openUnit = scan.units[1]!;
    const openText = rawContent.slice(openUnit.mappedSpan.start, openUnit.mappedSpan.end);
    const openBaseline = V2Parser.interpretCompositionalPreferencesV2WithExecutionReport(
      parserInput(rawContent, openText, openUnit.rawSpan.start, scope()),
    );
    expect(compiled.units[1]).toMatchObject({
      kind: 'nonmatch',
      parserBranch: openBaseline.branch,
      reasons: openBaseline.result.reasons,
    });
    expect(compiled.units[1]).not.toHaveProperty('eligible');
    expect(compiled.units[1]).not.toHaveProperty('accepted');
    expect(compiled).not.toHaveProperty('rawContent');
    expect(compiled).not.toHaveProperty('mappedContent');
    expectDeepFrozen(compiled);

    const mutatedInput = input(rawContent);
    const before = compileAutonomousPersonalTypedSyntaxV1(mutatedInput, work());
    mutatedInput.rawContent = 'changed after compile';
    expect(before).toEqual(compiled);
  });

  test('preserves schema-valid complete-branch diagnostics as nonmatches', () => {
    const rawContent = 'I prefer concise explanations.';
    const baseline = V2Parser.interpretCompositionalPreferencesV2WithExecutionReport(
      parserInput(rawContent, rawContent, 0, scope()),
    );
    expect(baseline.branch).toBe('complete_ast');
    const diagnostic = structuredClone(baseline);
    diagnostic.result.reasons = ['unsupported_grammar'];
    const parser = jest
      .spyOn(V2Parser, 'interpretCompositionalPreferencesV2WithExecutionReport')
      .mockReturnValue(diagnostic);
    try {
      const report = compileAutonomousPersonalTypedSyntaxV1(input(rawContent), work());
      expect(report).toMatchObject({
        status: 'complete',
        units: [
          {
            unitIndex: 0,
            kind: 'nonmatch',
            parserBranch: 'complete_ast',
            reasons: ['unsupported_grammar'],
          },
        ],
      });
    } finally {
      parser.mockRestore();
    }
  });

  test('recomputes exact nested geometry, scanner, framing and syntax-scope hashes', () => {
    const body = 'I prefer concise explanations. I like clear answers.';
    const prefix = '😀 application display: ';
    const rawContent = `${prefix}${body} [footer]`;
    const selected = input(
      rawContent,
      {
        mode: 'application_region',
        humanRegion: { start: prefix.length, end: prefix.length + body.length },
        applicationWrapper: { configurationFingerprint: 'c'.repeat(64) },
      },
      [],
    );
    const report = compileAutonomousPersonalTypedSyntaxV1(selected, work());
    const geometryInput = {
      rawContent,
      mapping: selected.mapping,
      quoteRegions: selected.quoteRegions,
    };
    const geometry = compileAutonomousSourceGeometryV3(geometryInput);
    const scan = compileAutonomousPersonalSourceScanV1(geometryInput);
    const framing = compileAutonomousPersonalFramingV1(geometryInput);

    expect(report).toMatchObject({
      version: 1,
      rawContentHash: geometry.geometry.rawContentHash,
      mappedContentHash: geometry.geometry.mappedContentHash,
      geometryHash: geometry.geometryHash,
      sourceScanHash: hashAutomaticCaptureV2({
        domain: 'engram-autonomous-source-scan-v1',
        sourceScan: scan,
      }),
      framingHash: hashAutomaticCaptureV2({
        domain: 'engram-autonomous-framing-v1',
        framing,
      }),
      syntaxScopeHash: hashAutomaticCaptureV2({
        domain: 'engram-autonomous-syntax-scope-v1',
        syntaxScope: selected.syntaxScope,
      }),
    });
    expect(report.rawContentHash).not.toBe(report.mappedContentHash);
    expect(report).not.toHaveProperty('mappedHumanBody');
  });

  test('preserves two-bundle and coupled-bundle ALL2 results with exact Unicode-offset translation', () => {
    const body =
      'I prefer Canadian French, and I like concise explanations. I prefer Canadian French and like concise explanations.';
    const prefix = '🧭 application wrapper: ';
    const rawContent = `${prefix}${body} footer`;
    const selected = input(rawContent, {
      mode: 'application_region',
      humanRegion: { start: prefix.length, end: prefix.length + body.length },
      applicationWrapper: { configurationFingerprint: 'd'.repeat(64) },
    });
    const report = compileAutonomousPersonalTypedSyntaxV1(selected, work());
    expect(report.status).toBe('complete');
    if (report.status !== 'complete') return;
    expect(report.units).toHaveLength(2);

    const bodyOffset = prefix.length;
    const mappedBody = body;
    const scan = compileAutonomousPersonalSourceScanV1({
      rawContent,
      mapping: selected.mapping,
      quoteRegions: selected.quoteRegions,
    });
    const firstRow = typedRow(report, 0);
    const secondRow = typedRow(report, 1);
    expect(firstRow.preference.bundles).toHaveLength(2);
    expect(secondRow.preference.bundles).toHaveLength(1);
    expect(secondRow.preference.bundles[0]).toMatchObject({
      relation: 'allOf',
      coupling: 'coupled',
    });

    for (const [index, row] of [firstRow, secondRow].entries()) {
      const unit = scan.units[index]!;
      const mappedUnit = mappedBody.slice(unit.mappedSpan.start, unit.mappedSpan.end);
      const baseline = V2Parser.interpretCompositionalPreferencesV2WithExecutionReport(
        parserInput(
          rawContent,
          mappedUnit,
          bodyOffset + unit.mappedSpan.start,
          selected.syntaxScope,
        ),
      );
      expect(baseline.branch).toBe('complete_ast');
      const translated = shiftPreference(baseline.result, unit.mappedSpan.start);
      expect(row.preference).toEqual(translated);
      expectEvidenceInsideUnit(
        row.preference,
        rawContent,
        mappedBody,
        unit.rawSpan,
        unit.mappedSpan,
      );
      expectMeaningInvariant(row.preference, baseline.result);
    }
  });

  test('defers a real positive ALL2 result when full-source span translation crosses 32 KiB', () => {
    const richClause =
      'I like responses in plain Australian English, with one worked example ahead of any technical terms';
    const body = `${Array.from({ length: 4 }, () => richClause).join(', and ')}.`;
    const prefix = ' '.repeat(50_000);
    const rawContent = `${prefix}${body}`;
    const baseline = V2Parser.interpretCompositionalPreferencesV2WithExecutionReport(
      parserInput(rawContent, body, prefix.length, scope()),
    );
    expect(baseline.branch).toBe('complete_ast');
    expect(baseline.result.coverage).toBe('complete');
    expect(baseline.result.bundles).toHaveLength(4);
    const baselineBytes = Buffer.byteLength(JSON.stringify(baseline.result), 'utf8');
    const translatedBytes = Buffer.byteLength(
      JSON.stringify(shiftPreference(baseline.result, prefix.length)),
      'utf8',
    );
    expect(baselineBytes).toBe(32_689);
    expect(baselineBytes).toBeLessThanOrEqual(32 * 1024);
    expect(translatedBytes).toBe(33_091);
    expect(translatedBytes).toBeGreaterThan(32 * 1024);

    const scan = compileAutonomousPersonalSourceScanV1({
      rawContent,
      mapping: { mode: 'full_body' },
      quoteRegions: [],
    });
    expect(scan.status).toBe('complete');
    expect(scan.units).toHaveLength(1);
    expect(scan.units[0]?.rawSpan.start).toBe(prefix.length);

    const report = compileAutonomousPersonalTypedSyntaxV1(input(rawContent), work());
    expect(report).toMatchObject({
      status: 'capacity',
      reason: 'typed_metadata',
      units: [],
    });
  });

  test('keeps 32 Source4 quote regions out of the legacy V1 envelope while parsing an unquoted unit', () => {
    const leadWords = Array.from({ length: 32 }, (_, index) => `token${index}`);
    const lead = `${leadWords.join(' ')}.`;
    const quoteRegions: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    for (const token of leadWords) {
      quoteRegions.push({ start: cursor, end: cursor + token.length });
      cursor += token.length + 1;
    }
    const rawContent = `${lead} I prefer concise explanations.`;
    const spy = jest.spyOn(V2Parser, 'interpretCompositionalPreferencesV2WithExecutionReport');
    try {
      const report = compileAutonomousPersonalTypedSyntaxV1(
        input(rawContent, { mode: 'full_body' }, quoteRegions),
        work(),
      );
      expect(report.status).toBe('complete');
      if (report.status !== 'complete') return;
      expect(report.units).toHaveLength(2);
      expect(report.units[0]).toMatchObject({
        unitIndex: 0,
        kind: 'source_blocked',
        finding: 'quote',
      });
      expect(report.units[1]?.kind).toBe('typed');
      expect(spy).toHaveBeenCalledTimes(1);
      const parsedUnit = report.units[1];
      if (parsedUnit?.kind === 'typed') {
        const scan = compileAutonomousPersonalSourceScanV1({
          rawContent,
          mapping: { mode: 'full_body' },
          quoteRegions,
        });
        const unit = scan.units[1]!;
        expectEvidenceInsideUnit(
          parsedUnit.preference,
          rawContent,
          rawContent,
          unit.rawSpan,
          unit.mappedSpan,
        );
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('anchors Remember-this evidence at original mapped zero and blocks invalid local scopes', () => {
    const body = 'Remember this: I like JSON.';
    const prefix = '😀 display: ';
    const rawContent = `${prefix}${body} footer`;
    const selected = input(rawContent, {
      mode: 'application_region',
      humanRegion: { start: prefix.length, end: prefix.length + body.length },
      applicationWrapper: { configurationFingerprint: 'e'.repeat(64) },
    });
    const anchored = compileAutonomousPersonalTypedSyntaxV1(selected, work());
    const anchoredRow = typedRow(anchored, 0);
    expect(anchoredRow.preference.sourceRequest).toMatchObject({
      kind: 'remember_this',
      scope: 'whole_single_preference',
      evidence: {
        lexicalForm: 'Remember this: ',
        spans: [
          {
            content: { start: 0, end: 'Remember this: '.length },
            raw: {
              start: prefix.length,
              end: prefix.length + 'Remember this: '.length,
            },
          },
        ],
      },
    });

    const invalidScopes = [
      ' Remember this: I like JSON.',
      'Remember this: I like JSON. I like tables.',
      'Context. Remember this: I like JSON.',
    ];
    for (const raw of invalidScopes) {
      let report: ReturnType<typeof compileAutonomousPersonalTypedSyntaxV1>;
      try {
        report = compileAutonomousPersonalTypedSyntaxV1(input(raw), work());
      } catch (error) {
        throw new Error(
          `Remember scope fixture failed for ${JSON.stringify(raw)}: ${String(error)}`,
        );
      }
      expect(report.status).toBe('complete');
      if (report.status !== 'complete') continue;
      const remembered = report.units.filter((row) => row.kind === 'source_blocked');
      expect(remembered.length).toBeGreaterThan(0);
      expect(remembered.every((row) => row.finding === 'remember_scope')).toBe(true);
      expect(report.units.some((row) => row.kind === 'typed')).toBe(false);
    }
  });

  test('returns no prefix for scanner indeterminacy and all-or-nothing capacity limits', () => {
    const indeterminate = compileAutonomousPersonalTypedSyntaxV1(
      input('I prefer concise explanations. “unfinished quote'),
      work(),
    );
    expect(indeterminate).toMatchObject({
      status: 'not_interpreted',
      reason: 'source_indeterminate',
      units: [],
    });

    const thirtyThreeUnits = Array.from(
      { length: 33 },
      () => 'I prefer concise explanations.',
    ).join(' ');
    const unitCapacity = compileAutonomousPersonalTypedSyntaxV1(input(thirtyThreeUnits), work());
    expect(unitCapacity).toMatchObject({ status: 'capacity', reason: 'unit_count', units: [] });

    const tokenCapacity = compileAutonomousPersonalTypedSyntaxV1(
      input('word '.repeat(8_193)),
      work(),
    );
    expect(tokenCapacity).toMatchObject({
      status: 'capacity',
      reason: 'source_resource',
      units: [],
    });

    const tooManyBundles = Array.from(
      { length: 17 },
      () => 'I prefer Canadian French, and I like concise explanations.',
    ).join(' ');
    const aggregateCapacity = compileAutonomousPersonalTypedSyntaxV1(input(tooManyBundles), work());
    expect(aggregateCapacity).toMatchObject({
      status: 'capacity',
      reason: 'aggregate',
      units: [],
    });
  });

  test('fails closed on malformed raw input and preserves fixed redacted failure categories', () => {
    const sentinel = 'private-source-sentinel';
    const getterInput = Object.defineProperty({}, 'rawContent', {
      enumerable: true,
      get: () => {
        throw new Error(sentinel);
      },
    });
    let traps = 0;
    const nestedGetter = input('I prefer tea.');
    Object.defineProperty(nestedGetter.syntaxScope, 'issuer', {
      enumerable: true,
      get: () => {
        traps += 1;
        return ISSUER;
      },
    });
    const proxy = new Proxy(input('I prefer tea.'), {
      get: () => {
        traps += 1;
        return undefined;
      },
    });
    expectFailure(
      () => compileAutonomousPersonalTypedSyntaxV1(getterInput, work()),
      'invalid_input',
      sentinel,
    );
    expectFailure(
      () => compileAutonomousPersonalTypedSyntaxV1(nestedGetter, work()),
      'invalid_input',
    );
    expectFailure(() => compileAutonomousPersonalTypedSyntaxV1(proxy, work()), 'invalid_input');
    for (const extra of [
      { mappedContent: 'forged' },
      { unit: { index: 0 } },
      { units: [] },
      { scan: {} },
      { framing: {} },
      { ast: {} },
      { parserReport: {} },
      { interpretation: true },
      { check: () => ++traps },
    ]) {
      expectFailure(
        () =>
          compileAutonomousPersonalTypedSyntaxV1({ ...input('I prefer tea.'), ...extra }, work()),
        'invalid_input',
      );
    }
    expect(traps).toBe(0);

    const cancelled = new AbortController();
    cancelled.abort();
    expectFailure(
      () => compileAutonomousPersonalTypedSyntaxV1(input('I prefer tea.'), work(cancelled.signal)),
      'cancelled',
    );
    expectFailure(
      () =>
        compileAutonomousPersonalTypedSyntaxV1(
          input('I prefer tea.'),
          work(new AbortController().signal, performance.now() - 1),
        ),
      'deadline',
    );

    let workGetterCalls = 0;
    const hostileWork = Object.defineProperty({}, 'absoluteMonotonicDeadlineMs', {
      enumerable: true,
      get: () => {
        workGetterCalls += 1;
        return performance.now() + 5000;
      },
    });
    expectFailure(
      () => compileAutonomousPersonalTypedSyntaxV1(input('I prefer tea.'), hostileWork as never),
      'internal',
    );
    expect(workGetterCalls).toBe(0);

    let fakeSignalGetterCalls = 0;
    const fakeSignal = Object.defineProperty({}, 'aborted', {
      enumerable: true,
      get: () => {
        fakeSignalGetterCalls += 1;
        return false;
      },
    });
    expectFailure(
      () =>
        compileAutonomousPersonalTypedSyntaxV1(input('I prefer tea.'), {
          absoluteMonotonicDeadlineMs: performance.now() + 5000,
          signal: fakeSignal as never,
        }),
      'internal',
    );
    expect(fakeSignalGetterCalls).toBe(0);

    const invalidDeadline = work(new AbortController().signal, Number.NaN);
    expectFailure(
      () => compileAutonomousPersonalTypedSyntaxV1(input('I prefer tea.'), invalidDeadline),
      'internal',
    );
  });

  test('reads a native signal through its intrinsic state and never starts background work', () => {
    const controller = new AbortController();
    let abortedGetterCalls = 0;
    Object.defineProperty(controller.signal, 'aborted', {
      configurable: true,
      get: () => {
        abortedGetterCalls += 1;
        return true;
      },
    });
    const startedAt = performance.now();
    const report = compileAutonomousPersonalTypedSyntaxV1(
      input('I prefer concise explanations.'),
      work(controller.signal),
    );
    expect(report.status).toBe('complete');
    expect(abortedGetterCalls).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(report).not.toBeInstanceOf(Promise);
  });

  test('does not perform I/O and exposes only internal parser DATA, never acceptance authority', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Unexpected network access');
    });
    try {
      const report = compileAutonomousPersonalTypedSyntaxV1(
        input('I prefer concise explanations.'),
        work(),
      );
      const row = typedRow(report, 0);
      expect(row).not.toHaveProperty('accepted');
      expect(row).not.toHaveProperty('claimId');
      expect(report).not.toHaveProperty('authority');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
