import { createHash } from 'crypto';
import { compileAutonomousSourceGeometryV3 } from '../../../src/schemas/AutonomousSourceGeometryV3.schema';
import type { AutonomousSourceGeometryInputV3 } from '../../../src/schemas/AutonomousSourceGeometryV3.schema';
import {
  AutonomousPersonalSourceScanV1OwnedDataSchema as OwnedDataSchema,
  AutonomousPersonalSourceScanV1Schema as Schema,
  compileAutonomousPersonalSourceScanV1 as compile,
  type AutonomousPersonalSourceScanV1 as ScanReport,
} from '../../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import { cloneBoundedAutomaticCaptureJson } from '../../../src/storage/BoundedAutomaticCaptureJson';

const invalidCode = 'invalid_autonomous_source_scan_data';
const allCueCodes = [
  'explicit_geometry_quote_overlap',
  'paired_text_quote_overlap',
  'balanced_bracket_present',
  'conditional_or_uncertainty_token',
  'modal_token',
  'generic_temporal_token',
] as const;

const makeInput = (
  rawContent: string,
  mapping: AutonomousSourceGeometryInputV3['mapping'] = { mode: 'full_body' },
  quoteRegions: AutonomousSourceGeometryInputV3['quoteRegions'] = [],
): AutonomousSourceGeometryInputV3 => ({ rawContent, mapping, quoteRegions });

const compileRaw = (
  rawContent: string,
  mapping?: AutonomousSourceGeometryInputV3['mapping'],
  quoteRegions?: AutonomousSourceGeometryInputV3['quoteRegions'],
): ScanReport => compile(makeInput(rawContent, mapping, quoteRegions));

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function measureBoundedShape(value: unknown, depth = 0): { nodes: number; maxDepth: number } {
  let nodes = 1;
  let maxDepth = depth;
  if (Array.isArray(value)) {
    nodes += Reflect.ownKeys(value).length;
    for (const child of value) {
      const nested = measureBoundedShape(child, depth + 1);
      nodes += nested.nodes;
      maxDepth = Math.max(maxDepth, nested.maxDepth);
    }
  } else if (value !== null && typeof value === 'object') {
    const keys = Reflect.ownKeys(value);
    nodes += keys.length;
    for (const key of keys) {
      const nested = measureBoundedShape(
        (value as Record<string, unknown>)[String(key)],
        depth + 1,
      );
      nodes += nested.nodes;
      maxDepth = Math.max(maxDepth, nested.maxDepth);
    }
  }
  return { nodes, maxDepth };
}

function assertSpanMapping(report: ScanReport): void {
  const region = report.rawHumanRegion;
  expect(region.end - region.start).toBe(report.mappedUtf16Length);
  expect(region.end).toBeLessThanOrEqual(report.rawUtf16Length);
  const spans = [
    ...report.units.map((unit) => ({ raw: unit.rawSpan, mapped: unit.mappedSpan })),
    ...report.coverage.whitespaceGaps.map((gap) => ({ raw: gap.rawSpan, mapped: gap.mappedSpan })),
    ...(report.coverage.indeterminateSpan
      ? [
          {
            raw: report.coverage.indeterminateSpan.rawSpan,
            mapped: report.coverage.indeterminateSpan.mappedSpan,
          },
        ]
      : []),
  ];
  for (const { raw, mapped } of spans) {
    expect(raw.end - raw.start).toBe(mapped.end - mapped.start);
    expect(raw.start).toBe(region.start + mapped.start);
    expect(raw.end).toBe(region.start + mapped.end);
    expect(mapped.start).toBeGreaterThanOrEqual(0);
    expect(mapped.end).toBeLessThanOrEqual(report.mappedUtf16Length);
  }
}

function assertCoveragePartition(report: ScanReport): void {
  const spans = [
    ...report.units.map(({ mappedSpan }) => mappedSpan),
    ...report.coverage.whitespaceGaps.map(({ mappedSpan }) => mappedSpan),
    ...(report.coverage.indeterminateSpan ? [report.coverage.indeterminateSpan.mappedSpan] : []),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  for (const span of spans) {
    expect(span.start).toBe(cursor);
    expect(span.end).toBeGreaterThanOrEqual(span.start);
    cursor = span.end;
  }
  expect(cursor).toBe(report.mappedUtf16Length);
  assertSpanMapping(report);
}

function assertTokenPartition(report: ScanReport, complete: boolean): void {
  let tokenCursor = 0;
  for (const [index, unit] of report.units.entries()) {
    expect(unit.index).toBe(index);
    expect(unit.tokenSpan.start).toBe(tokenCursor);
    expect(unit.tokenSpan.end).toBeGreaterThan(unit.tokenSpan.start);
    expect(unit.tokenSpan.end).toBeLessThanOrEqual(report.tokenCount ?? -1);
    tokenCursor = unit.tokenSpan.end;
  }
  if (complete) expect(tokenCursor).toBe(report.tokenCount);
}

function expectFixedFacadeFailure(value: unknown, sentinel?: string): void {
  const result = Schema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.message)).toEqual([invalidCode]);
  expect(JSON.stringify(result.error.issues)).not.toContain(sentinel ?? 'sentinel-source-text');
}

describe('autonomous source scan v1 is bounded mechanical DATA', () => {
  test('derives exact full-body, application-region, full-span, and empty geometry metadata', () => {
    const fullInput = makeInput('  alpha. beta!?  ');
    const full = compile(fullInput);
    const fullGeometry = compileAutonomousSourceGeometryV3(fullInput);
    expect(full.rawHumanRegion).toEqual({ start: 0, end: fullInput.rawContent.length });
    expect(full.rawUtf16Length).toBe(fullInput.rawContent.length);
    expect(full.mappedUtf16Length).toBe(fullInput.rawContent.length);
    expect(full.rawContentHash).toBe(sha256(fullInput.rawContent));
    expect(full.mappedContentHash).toBe(sha256(fullInput.rawContent));
    expect(full.geometryHash).toBe(fullGeometry.geometryHash);
    expect(full.rawContentHash).toBe(full.mappedContentHash);
    assertCoveragePartition(full);

    const rawContent = '😀 prefix | I prefer 😀 tea. suffix';
    const body = 'I prefer 😀 tea.';
    const start = rawContent.indexOf(body);
    const quotedEmojiStart = body.indexOf('😀');
    const applicationInput = makeInput(
      rawContent,
      {
        mode: 'application_region',
        humanRegion: { start, end: start + body.length },
        applicationWrapper: { configurationFingerprint: 'a'.repeat(64) },
      },
      [{ start: quotedEmojiStart, end: quotedEmojiStart + 2 }],
    );
    const application = compile(applicationInput);
    const applicationGeometry = compileAutonomousSourceGeometryV3(applicationInput);
    expect(application.rawHumanRegion).toEqual({ start, end: start + body.length });
    expect(application.rawContentHash).toBe(sha256(rawContent));
    expect(application.mappedContentHash).toBe(sha256(body));
    expect(application.geometryHash).toBe(applicationGeometry.geometryHash);
    expect(application.rawContentHash).not.toBe(application.mappedContentHash);
    expect(application.units[0].observedCueCodes).toContain('explicit_geometry_quote_overlap');
    assertCoveragePartition(application);

    const fullSpanInput = makeInput('same. body!', {
      mode: 'application_region',
      humanRegion: { start: 0, end: 'same. body!'.length },
      applicationWrapper: { configurationFingerprint: 'b'.repeat(64) },
    });
    const fullSpan = compile(fullSpanInput);
    expect(fullSpan.rawHumanRegion).toEqual({ start: 0, end: fullSpan.rawUtf16Length });
    expect(fullSpan.rawContentHash).toBe(fullSpan.mappedContentHash);
    expect(fullSpan.rawUtf16Length).toBe(fullSpan.mappedUtf16Length);

    const empty = compileRaw('');
    expect(empty).toMatchObject({
      rawHumanRegion: { start: 0, end: 0 },
      rawUtf16Length: 0,
      mappedUtf16Length: 0,
      tokenCount: 0,
      status: 'complete',
      coverage: { status: 'complete', whitespaceGaps: [], indeterminateSpan: null },
      units: [],
    });
    expect(empty.rawContentHash).toBe(sha256(''));
    expect(empty.rawContentHash).toBe(empty.mappedContentHash);
    assertCoveragePartition(empty);
  });

  test('partitions complete coverage and reports whitespace-only input without invented units', () => {
    const report = compileRaw('  alpha.  beta!? \t');
    expect(report.status).toBe('complete');
    expect(report.coverage).toMatchObject({ status: 'complete', indeterminateSpan: null });
    expect(report.units.map((unit) => unit.boundaryCode)).toEqual(['period', 'question']);
    expect(report.units.map((unit) => unit.index)).toEqual([0, 1]);
    assertCoveragePartition(report);
    assertTokenPartition(report, true);

    const whitespace = compileRaw(' \t\n');
    expect(whitespace.status).toBe('complete');
    expect(whitespace.tokenCount).toBe(0);
    expect(whitespace.units).toEqual([]);
    expect(whitespace.coverage.whitespaceGaps).toHaveLength(1);
    expect(whitespace.coverage.whitespaceGaps[0].mappedSpan).toEqual({ start: 0, end: 3 });
    assertCoveragePartition(whitespace);
    assertTokenPartition(whitespace, true);
  });

  test('accepts 32 valid quote regions and rejects quote count, order, overlap, and bounds violations', () => {
    const rawContent = Array.from({ length: 32 }, () => 'x').join(' ');
    const quoteRegions = Array.from({ length: 32 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
    }));
    const accepted = compileRaw(rawContent, { mode: 'full_body' }, quoteRegions);
    expect(accepted.status).toBe('complete');
    expect(accepted.units).toHaveLength(1);
    expect(accepted.units[0].observedCueCodes).toContain('explicit_geometry_quote_overlap');

    const invalidInputs = [
      makeInput(rawContent, { mode: 'full_body' }, [...quoteRegions, { start: 0, end: 1 }]),
      makeInput(rawContent, { mode: 'full_body' }, [...quoteRegions].reverse()),
      makeInput(rawContent, { mode: 'full_body' }, [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
      ]),
      makeInput(rawContent, { mode: 'full_body' }, [{ start: 0, end: rawContent.length + 1 }]),
      makeInput(rawContent, { mode: 'full_body' }, [{ start: 1, end: 1 }]),
    ];
    for (const input of invalidInputs) expect(() => compile(input)).toThrow(invalidCode);
  });

  test.each([
    ['single period', 'alpha.', 'period'],
    ['single exclamation', 'alpha!', 'exclamation'],
    ['single question', 'alpha?', 'question'],
    ['input end', 'alpha', 'end_of_input'],
    ['question dominates exclamation', 'alpha!?', 'question'],
    ['question dominates period', 'alpha?.', 'question'],
    ['exclamation dominates period', 'alpha!.', 'exclamation'],
    ['question dominates a mixed run', 'alpha!?.', 'question'],
  ] as const)('uses deterministic terminal precedence for %s', (_name, raw, expected) => {
    const report = compileRaw(raw);
    expect(report.status).toBe('complete');
    expect(report.units).toHaveLength(1);
    expect(report.units[0].boundaryCode).toBe(expected);
    expect(report.units[0].rawSpan).toEqual({ start: 0, end: raw.length });
  });

  test('keeps terminal marks separated only by whitespace in one prioritized terminal run', () => {
    const raw = 'alpha? \t.! beta!';
    const report = compileRaw(raw);
    expect(report.status).toBe('complete');
    expect(report.units).toHaveLength(2);
    expect(report.units.map((unit) => unit.boundaryCode)).toEqual(['question', 'exclamation']);
    expect(raw.slice(report.units[0].rawSpan.start, report.units[0].rawSpan.end)).toBe(
      'alpha? \t.!',
    );
    expect(raw.slice(report.units[1].rawSpan.start, report.units[1].rawSpan.end)).toBe('beta!');
    expect(report.coverage.whitespaceGaps).toHaveLength(1);
    assertCoveragePartition(report);
  });

  test('does not invent sentence boundaries from newlines, commas, colons, or semicolons', () => {
    for (const raw of ['alpha\nbeta.', 'alpha, beta.', 'alpha: beta.', 'alpha; beta.']) {
      const report = compileRaw(raw);
      expect(report.status).toBe('complete');
      expect(report.units).toHaveLength(1);
      expect(report.units[0].boundaryCode).toBe('period');
      expect(raw.slice(report.units[0].rawSpan.start, report.units[0].rawSpan.end)).toBe(raw);
      assertCoveragePartition(report);
    }
  });

  test('keeps periods inside decimals, dotted components, initialisms, initials, and listed abbreviations coupled', () => {
    const examples = [
      'The value is 3.14 mg!',
      'Use example.com and a.中 values!',
      'U.K. details follow!',
      'I met J. Doe today!',
      'Mr. Smith arrived!',
      'Mrs. Smith arrived!',
      'Ms. Smith arrived!',
      'Dr. Smith arrived!',
      'Prof. Smith arrived!',
      'Sr. Smith arrived!',
      'Jr. Smith arrived!',
      'St. Smith arrived!',
      'Vs. Smith arrived!',
      'Etc. examples follow!',
      'E.g. one example follows!',
      'I.e. one example follows!',
    ];
    for (const raw of examples) {
      const report = compileRaw(raw);
      expect(report.status).toBe('complete');
      expect(report.units).toHaveLength(1);
      expect(report.units[0].boundaryCode).toBe(raw.endsWith('!') ? 'exclamation' : 'period');
      expect(raw.slice(report.units[0].rawSpan.start, report.units[0].rawSpan.end)).toBe(raw);
    }

    const separated = compileRaw('Dr. Smith arrived! Next.');
    expect(separated.units).toHaveLength(2);
    expect(separated.units.map((unit) => unit.boundaryCode)).toEqual(['exclamation', 'period']);

    const ellipsis = compileRaw('first. The next is uncertain... maybe later.');
    expect(ellipsis.status).toBe('indeterminate');
    expect(ellipsis.coverage).toMatchObject({
      status: 'indeterminate_suffix',
      indeterminateSpan: { reasonCode: 'ambiguous_period_boundary' },
    });
    expect(ellipsis.units).toHaveLength(1);
    expect(ellipsis.units[0].tokenSpan.end).toBeLessThan(ellipsis.tokenCount!);
    expect(OwnedDataSchema.parse(ellipsis)).toEqual(ellipsis);
    expectDeepFrozen(ellipsis);
    assertCoveragePartition(ellipsis);
    assertTokenPartition(ellipsis, false);
  });

  test('keeps punctuation inside balanced quote and bracket regions from splitting a unit', () => {
    const examples = [
      'before "a. b? c!" after.',
      'before “a. b? c!” after.',
      'before ‘a. b? c!’ after.',
      "before 'a. b? c!' after.",
      'before (a. [b? {c!}]) after.',
    ];
    for (const raw of examples) {
      const report = compileRaw(raw);
      expect(report.status).toBe('complete');
      expect(report.units).toHaveLength(1);
      expect(report.units[0].boundaryCode).toBe('period');
      expect(raw.slice(report.units[0].rawSpan.start, report.units[0].rawSpan.end)).toBe(raw);
    }
  });

  test('allows nested quotes only across single and double families with exact matching delimiters', () => {
    for (const raw of [
      'before "outer ‘inner. text’ outer" after.',
      'before ‘outer "inner. text" outer’ after.',
    ]) {
      const report = compileRaw(raw);
      expect(report.status).toBe('complete');
      expect(report.units).toHaveLength(1);
      expect(report.units[0].boundaryCode).toBe('period');
    }

    for (const raw of ['before “outer "inner” after.', "before ‘outer 'inner’ after."]) {
      const report = compileRaw(raw);
      expect(report.status).toBe('indeterminate');
      expect(report.coverage.indeterminateSpan?.reasonCode).toBe('mismatched_quote');
      assertCoveragePartition(report);
    }
  });

  test('treats straight and curly internal apostrophes as word characters, not quote delimiters', () => {
    for (const raw of ["don't stop.", 'I’m ready.']) {
      const report = compileRaw(raw);
      expect(report.status).toBe('complete');
      expect(report.units).toHaveLength(1);
      expect(report.tokenCount).toBe(3);
      expect(report.units[0].tokenSpan).toEqual({ start: 0, end: 3 });
      expect(report.units[0].boundaryCode).toBe('period');
    }
  });

  test.each([
    ['unmatched quote', 'first. “unfinished', 'unmatched_quote'],
    ['mismatched quote', 'first. “unfinished"', 'mismatched_quote'],
    ['unmatched bracket', 'first. (unfinished', 'unmatched_bracket'],
    ['mismatched bracket', 'first. [unfinished)', 'mismatched_bracket'],
    ['escaped quote', String.raw`first. \"unfinished`, 'unsupported_quote_escape'],
  ] as const)('returns a single unresolved suffix for %s', (_name, raw, reasonCode) => {
    const report = compileRaw(raw);
    expect(report.status).toBe('indeterminate');
    expect(report.resourceReason).toBeNull();
    expect(report.tokenCount).toBeLessThanOrEqual(8192);
    expect(report.coverage.status).toBe('indeterminate_suffix');
    expect(report.coverage.indeterminateSpan).toMatchObject({ reasonCode });
    expect(report.coverage.indeterminateSpan?.mappedSpan.end).toBe(raw.length);
    expect(report.coverage.indeterminateSpan?.rawSpan.end).toBe(raw.length);
    expectDeepFrozen(report);
    assertCoveragePartition(report);
    assertTokenPartition(report, false);
  });

  test('accepts nesting through depth eight and reports a ninth level as indeterminate', () => {
    const depthEight = `${'('.repeat(8)}inside${')'.repeat(8)}.`;
    const complete = compileRaw(depthEight);
    expect(complete.status).toBe('complete');
    expect(complete.units).toHaveLength(1);
    expect(complete.units[0].observedCueCodes).toContain('balanced_bracket_present');

    const depthNine = `${'('.repeat(9)}inside${')'.repeat(9)}.`;
    const overflow = compileRaw(depthNine);
    expect(overflow.status).toBe('indeterminate');
    expect(overflow.coverage.indeterminateSpan?.reasonCode).toBe('nesting_limit');
    expectDeepFrozen(overflow);
    assertCoveragePartition(overflow);
  });

  test('reports only the six bounded observations, uniquely and in canonical order', () => {
    const raw = 'if I could while "quoted" (group) if could while.';
    const report = compileRaw(raw, { mode: 'full_body' }, [{ start: 0, end: raw.length }]);
    expect(report.status).toBe('complete');
    expect(report.units).toHaveLength(1);
    expect(report.units[0].observedCueCodes).toEqual(allCueCodes);
    expect(new Set(report.units[0].observedCueCodes).size).toBe(6);
    expect(report).not.toHaveProperty('tokens');
    expect(report).not.toHaveProperty('rawContent');
    expect(report).not.toHaveProperty('mappedHumanBody');
    for (const key of ['eligible', 'accepted', 'sourceVerdict', 'dispatch', 'actor', 'authority'])
      expect(report).not.toHaveProperty(key);
    expect(JSON.stringify(report)).not.toContain(raw);
  });

  test('detects cue tokens anywhere in a unit without adding semantic verdict fields', () => {
    const report = compileRaw('A plain statement may mention maybe and could while continuing.');
    expect(report.status).toBe('complete');
    expect(report.units).toHaveLength(1);
    expect(report.units[0].observedCueCodes).toEqual([
      'conditional_or_uncertainty_token',
      'modal_token',
      'generic_temporal_token',
    ]);
  });

  test('maps astral and combining Unicode code points to exact UTF-16 spans', () => {
    const raw = 'Aé中م𠀀 ١ e\u0301 😀!';
    const report = compileRaw(raw);
    expect(report.status).toBe('complete');
    expect(report.rawUtf16Length).toBe(raw.length);
    expect(report.mappedUtf16Length).toBe(raw.length);
    expect(report.tokenCount).toBe(5);
    expect(report.units).toEqual([
      expect.objectContaining({
        rawSpan: { start: 0, end: raw.length },
        mappedSpan: { start: 0, end: raw.length },
        tokenSpan: { start: 0, end: 5 },
        boundaryCode: 'exclamation',
      }),
    ]);
    assertCoveragePartition(report);
    assertTokenPartition(report, true);
  });

  test('returns a complete exact 8,192-token scan and no prefix at token 8,193', () => {
    const atLimit = compileRaw(Array.from({ length: 8192 }, () => 'x').join(' '));
    expect(atLimit.status).toBe('complete');
    expect(atLimit.tokenCount).toBe(8192);
    expect(atLimit.resourceReason).toBeNull();
    expect(atLimit.units).toHaveLength(1);
    assertTokenPartition(atLimit, true);

    const overLimit = compileRaw(Array.from({ length: 8193 }, () => 'x').join(' '));
    expect(overLimit).toMatchObject({
      status: 'resource_limit',
      tokenCount: null,
      resourceReason: { kind: 'lexical_token_limit', observedMinimum: 8193 },
      units: [],
      coverage: { status: 'not_reported', whitespaceGaps: [], indeterminateSpan: null },
    });
    expectDeepFrozen(overLimit);
  });

  test('returns 128 complete units, then no prefix at unit 129', () => {
    const atLimit = compileRaw(Array.from({ length: 128 }, () => 'x.').join(' '));
    expect(atLimit.status).toBe('complete');
    expect(atLimit.units).toHaveLength(128);
    expect(atLimit.tokenCount).toBe(256);
    assertCoveragePartition(atLimit);
    assertTokenPartition(atLimit, true);

    const overLimit = compileRaw(Array.from({ length: 129 }, () => 'x.').join(' '));
    expect(overLimit).toMatchObject({
      status: 'resource_limit',
      tokenCount: null,
      resourceReason: { kind: 'unit_limit', observedMinimum: 129 },
      units: [],
      coverage: { status: 'not_reported', whitespaceGaps: [], indeterminateSpan: null },
    });
    expectDeepFrozen(overLimit);
  });

  test('summarizes 33–128 units mechanically without a dispatch or defer field', () => {
    const report = compileRaw(Array.from({ length: 33 }, () => 'x.').join(' '));
    expect(report.status).toBe('complete');
    expect(report.units).toHaveLength(33);
    expect(report).not.toHaveProperty('dispatch');
    expect(report).not.toHaveProperty('shouldDispatch');
    expect(report).not.toHaveProperty('defer');
    assertCoveragePartition(report);
    assertTokenPartition(report, true);
  });

  test('checks token overflow before closing unit 129 on the same terminal token', () => {
    const raw = `${Array.from({ length: 128 }, () => 'x.').join(' ')} ${Array.from(
      { length: 7936 },
      () => 'x',
    ).join(' ')}.`;
    const report = compileRaw(raw);
    expect(report).toMatchObject({
      status: 'resource_limit',
      tokenCount: null,
      resourceReason: { kind: 'lexical_token_limit', observedMinimum: 8193 },
      units: [],
      coverage: { status: 'not_reported', whitespaceGaps: [], indeterminateSpan: null },
    });
  });

  test('measures an actual maximum-shape compiler report within unchanged bounds', () => {
    const fillers = Array.from({ length: 6784 }, (_, index) =>
      index < 5887 ? 'abcdefgh' : 'abcdefg',
    );
    const units: string[] = [];
    for (let unitIndex = 0; unitIndex < 128; unitIndex += 1) {
      const unitFillers = fillers.slice(unitIndex * 53, (unitIndex + 1) * 53);
      units.push(
        [
          'if',
          'I',
          'could',
          'while',
          '"',
          'quoted',
          '"',
          '(',
          'bracket',
          ')',
          ...unitFillers,
          '.',
        ].join(' '),
      );
    }
    const rawContent = ` ${units.join(' ')} `;
    expect(rawContent.length).toBe(65_536);
    expect(Buffer.byteLength(rawContent, 'utf8')).toBe(65_536);

    const report = compileRaw(rawContent, { mode: 'full_body' }, [
      { start: 0, end: rawContent.length },
    ]);
    expect(report.status).toBe('complete');
    expect(report.tokenCount).toBe(8192);
    expect(report.units).toHaveLength(128);
    expect(report.coverage.whitespaceGaps).toHaveLength(129);
    expect(report.units.every((unit) => unit.observedCueCodes.length === 6)).toBe(true);
    const serialized = JSON.stringify(report);
    expect(Buffer.byteLength(serialized, 'utf8')).toBe(54_015);
    const shape = measureBoundedShape(report);
    expect(shape).toEqual({ nodes: 6_835, maxDepth: 5 });
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(65_536);
    expect(shape.nodes).toBeLessThanOrEqual(16_384);
    expect(shape.maxDepth).toBeLessThanOrEqual(32);
    expect(() => cloneBoundedAutomaticCaptureJson(report, 'beginRequest')).not.toThrow();
    expect(() => Schema.parse(report)).not.toThrow();
    assertCoveragePartition(report);
    assertTokenPartition(report, true);
  }, 30_000);

  test('owns raw inputs before parsing and returns only detached deeply frozen data', () => {
    const input = makeInput('alpha. beta!', { mode: 'full_body' }, [{ start: 0, end: 5 }]);
    const report = compile(input);
    const snapshot = structuredClone(report);
    input.quoteRegions[0].start = 2;
    input.quoteRegions.reverse();
    (input.mapping as { mode: string }).mode = 'tampered';
    expect(report).toEqual(snapshot);
    expectDeepFrozen(report);

    const facadeInput = structuredClone(snapshot);
    const parsed = Schema.parse(facadeInput);
    (facadeInput.units[0] as unknown as { boundaryCode: string }).boundaryCode = 'tampered';
    facadeInput.coverage.whitespaceGaps.push({
      rawSpan: { start: 0, end: 0 },
      mappedSpan: { start: 0, end: 0 },
    });
    expect(parsed).toEqual(snapshot);
    expectDeepFrozen(parsed);
    expect(OwnedDataSchema.parse(snapshot)).toEqual(snapshot);
  });

  test('exposes no text or authority and treats standalone parsed hashes as opaque metadata', () => {
    const raw = 'prefix | exact human body.';
    const start = raw.indexOf('exact');
    const report = compileRaw(raw, {
      mode: 'application_region',
      humanRegion: { start, end: raw.length },
      applicationWrapper: { configurationFingerprint: 'c'.repeat(64) },
    });
    expect(report).not.toHaveProperty('rawContent');
    expect(report).not.toHaveProperty('mappedHumanBody');
    expect(report).not.toHaveProperty('tokens');
    expect(report).not.toHaveProperty('sourceText');
    for (const key of ['owner', 'identity', 'authority', 'accepted', 'eligible', 'sourceVerdict'])
      expect(report).not.toHaveProperty(key);
    expect(JSON.stringify(report)).not.toContain(raw);

    const forged = structuredClone(report);
    forged.rawContentHash = 'd'.repeat(64);
    forged.mappedContentHash = 'e'.repeat(64);
    forged.geometryHash = 'f'.repeat(64);
    const parsed = Schema.parse(forged);
    expect(parsed.rawContentHash).toBe('d'.repeat(64));
    expect(parsed.mappedContentHash).toBe('e'.repeat(64));
    expect(parsed.geometryHash).toBe('f'.repeat(64));
    expectDeepFrozen(parsed);
  });

  test('strictly rejects intrinsic span, partition, hash-format, and unknown-field tampering', () => {
    const original = compileRaw('  alpha.  beta!  ');
    const mutations: Array<(report: ScanReport & Record<string, unknown>) => void> = [
      (report) => {
        report.rawHumanRegion.start = 1;
      },
      (report) => {
        report.rawHumanRegion = { start: 1, end: 1 };
        report.mappedUtf16Length = 0;
        report.tokenCount = 0;
        report.units = [];
        report.coverage.whitespaceGaps = [];
      },
      (report) => {
        report.units[0].rawSpan.start += 1;
      },
      (report) => {
        report.units[0].mappedSpan.end += 1;
      },
      (report) => {
        report.units[0].tokenSpan.end = 9999;
      },
      (report) => {
        report.units[1].index = 0;
      },
      (report) => {
        const rawFirst = report.units[0].rawSpan;
        const mappedFirst = report.units[0].mappedSpan;
        report.units[0].rawSpan = report.units[1].rawSpan;
        report.units[0].mappedSpan = report.units[1].mappedSpan;
        report.units[1].rawSpan = rawFirst;
        report.units[1].mappedSpan = mappedFirst;
      },
      (report) => {
        report.coverage.whitespaceGaps = [];
      },
      (report) => {
        report.coverage.whitespaceGaps.reverse();
      },
      (report) => {
        report.units[0].boundaryCode = 'end_of_input';
      },
      (report) => {
        report.geometryHash = 'not-a-hash';
      },
      (report) => {
        report.status = 'complete';
        report.coverage.status = 'indeterminate_suffix';
      },
      (report) => {
        (report as Record<string, unknown>).accepted = true;
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(original) as ScanReport & Record<string, unknown>;
      mutate(candidate);
      const result = Schema.safeParse(candidate);
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues.map((issue) => issue.message)).toEqual([invalidCode]);
    }
  });

  test('uses one fixed redacted error for malformed raw inputs and report data', () => {
    const sentinel = 'private raw sentinel must not be returned';
    const invalidInputs: unknown[] = [
      { ...makeInput(sentinel), unknown: true },
      makeInput('\ud800'),
      makeInput('abc', { mode: 'unknown' } as never),
      makeInput('abc', { mode: 'application_region', humanRegion: { start: 1, end: 2 } } as never),
      makeInput('😀.', {
        mode: 'application_region',
        humanRegion: { start: 1, end: 3 },
        applicationWrapper: { configurationFingerprint: 'a'.repeat(64) },
      }),
      makeInput('😀.', { mode: 'full_body' }, [{ start: 1, end: 2 }]),
    ];
    for (const input of invalidInputs) {
      expect(() => compile(input)).toThrow(invalidCode);
      expectFixedFacadeFailure(input, sentinel);
    }

    const malformedReport = { ...compileRaw('alpha.'), privateText: sentinel };
    expect(() => Schema.parse(malformedReport)).toThrow(invalidCode);
    expectFixedFacadeFailure(malformedReport, sentinel);
  });

  test('rejects getters, proxies, thenables, and toJSON without invoking user code on every raw facade', () => {
    let traps = 0;
    const getter = (key: string, value: unknown = 'synthetic') => {
      const object = {} as Record<string, unknown>;
      Object.defineProperty(object, key, {
        enumerable: true,
        get: () => {
          traps += 1;
          return value;
        },
      });
      return object;
    };
    const proxy = new Proxy(
      {},
      {
        get: () => {
          traps += 1;
          return undefined;
        },
        ownKeys: () => {
          traps += 1;
          return [];
        },
      },
    );
    const thenable = getter('then', undefined);
    const withToJson = { toJSON: () => ++traps };
    const inputWithMappingGetter = {
      rawContent: 'safe.',
      mapping: getter('mode'),
      quoteRegions: [],
    };
    const quoteGetter: unknown[] = [];
    Object.defineProperty(quoteGetter, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        traps += 1;
        return { start: 0, end: 1 };
      },
    });
    quoteGetter.length = 1;
    const inputWithQuoteGetter = {
      rawContent: 'x.',
      mapping: { mode: 'full_body' },
      quoteRegions: quoteGetter,
    };

    const compilerInputs = [
      getter('rawContent'),
      proxy,
      thenable,
      withToJson,
      inputWithMappingGetter,
      inputWithQuoteGetter,
    ];
    for (const input of compilerInputs) expect(() => compile(input)).toThrow(invalidCode);

    const valid = compileRaw('alpha.');
    const reportWithGetter = getter('version');
    const reportWithNestedGetter = { ...valid, units: getter('0') };
    const reportInputs = [reportWithGetter, proxy, thenable, withToJson, reportWithNestedGetter];
    for (const input of reportInputs) {
      expect(() => Schema.parse(input)).toThrow(invalidCode);
      expect(Schema.safeParse(input).success).toBe(false);
    }
    expect(traps).toBe(0);
  });
});
