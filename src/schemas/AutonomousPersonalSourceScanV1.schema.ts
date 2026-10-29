import { z } from 'zod';
import {
  isAutonomousWhitespaceCodePointV1,
  isAutonomousWordCodePointV1,
} from '../extraction/AutonomousUnicodeV1';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { compileAutonomousSourceGeometryV3 } from './AutonomousSourceGeometryV3.schema';
import type { AutonomousSourceLexicalTokenV1 as Token } from './AutonomousSourceLexicalTokenV1.schema';
import {
  AUTONOMOUS_SOURCE_LEXICAL_TOKEN_LIMIT_V1,
  nextCodePoint,
  previousCodePoint,
  quoteRole,
  quoteFamily,
  tokenizeMappedBody,
} from '../extraction/AutonomousSourceLexerV1';

const MAX_UTF16_UNITS = 65_536;
const MAX_LEXICAL_TOKENS = AUTONOMOUS_SOURCE_LEXICAL_TOKEN_LIMIT_V1;
const MAX_SOURCE_UNITS = 128;
const MAX_NESTING_DEPTH = 8;
const MAX_REPORT_BYTES = 64 * 1024;
const HASH_64 = /^[a-f0-9]{64}$/u;

const hashSchema = z.string().regex(HASH_64);
const utf16OffsetSchema = z.number().int().safe().min(0).max(MAX_UTF16_UNITS);
const tokenIndexSchema = z.number().int().safe().min(0).max(MAX_LEXICAL_TOKENS);

const rawHumanRegionSchema = z
  .object({
    start: utf16OffsetSchema,
    end: utf16OffsetSchema,
  })
  .strict();

const sourceSpanSchema = z
  .object({
    start: utf16OffsetSchema,
    end: utf16OffsetSchema,
  })
  .strict()
  .refine((span) => span.start < span.end, 'Source span must be nonempty');

const tokenSpanSchema = z
  .object({
    start: tokenIndexSchema,
    end: tokenIndexSchema,
  })
  .strict()
  .refine((span) => span.start < span.end, 'Token span must be nonempty');

const boundaryCodeSchema = z.enum(['period', 'exclamation', 'question', 'end_of_input']);
const cueCodeSchema = z.enum([
  'explicit_geometry_quote_overlap',
  'paired_text_quote_overlap',
  'balanced_bracket_present',
  'conditional_or_uncertainty_token',
  'modal_token',
  'generic_temporal_token',
]);
const cueCodeOrder: Readonly<Record<z.infer<typeof cueCodeSchema>, number>> = Object.freeze({
  explicit_geometry_quote_overlap: 0,
  paired_text_quote_overlap: 1,
  balanced_bracket_present: 2,
  conditional_or_uncertainty_token: 3,
  modal_token: 4,
  generic_temporal_token: 5,
});

const indeterminateReasonSchema = z.enum([
  'unmatched_quote',
  'mismatched_quote',
  'unmatched_bracket',
  'mismatched_bracket',
  'unsupported_quote_escape',
  'nesting_limit',
  'ambiguous_period_boundary',
]);

const resourceReasonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lexical_token_limit'), observedMinimum: z.literal(8_193) }).strict(),
  z.object({ kind: z.literal('unit_limit'), observedMinimum: z.literal(129) }).strict(),
]);

const spanPairSchema = z
  .object({ rawSpan: sourceSpanSchema, mappedSpan: sourceSpanSchema })
  .strict();

const indeterminateSpanSchema = spanPairSchema.extend({
  reasonCode: indeterminateReasonSchema,
});

const whitespaceGapSchema = spanPairSchema;

const unitSchema = z
  .object({
    index: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(MAX_SOURCE_UNITS - 1),
    rawSpan: sourceSpanSchema,
    mappedSpan: sourceSpanSchema,
    tokenSpan: tokenSpanSchema,
    boundaryCode: boundaryCodeSchema,
    observedCueCodes: z.array(cueCodeSchema).max(6),
  })
  .strict()
  .superRefine((unit, context) => {
    for (let index = 1; index < unit.observedCueCodes.length; index += 1) {
      const previous = unit.observedCueCodes[index - 1];
      const current = unit.observedCueCodes[index];
      if (cueCodeOrder[previous] >= cueCodeOrder[current]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Observed cue codes must be unique and in canonical order',
          path: ['observedCueCodes', index],
        });
      }
    }
  });

const coverageSchema = z
  .object({
    status: z.enum(['complete', 'indeterminate_suffix', 'not_reported']),
    whitespaceGaps: z.array(whitespaceGapSchema).max(MAX_SOURCE_UNITS + 1),
    indeterminateSpan: indeterminateSpanSchema.nullable(),
  })
  .strict();

const scanReportBodySchema = z
  .object({
    version: z.literal(1),
    rawContentHash: hashSchema,
    mappedContentHash: hashSchema,
    geometryHash: hashSchema,
    rawUtf16Length: utf16OffsetSchema,
    mappedUtf16Length: utf16OffsetSchema,
    rawHumanRegion: rawHumanRegionSchema,
    tokenCount: z.number().int().safe().min(0).max(MAX_LEXICAL_TOKENS).nullable(),
    status: z.enum(['complete', 'indeterminate', 'resource_limit']),
    resourceReason: resourceReasonSchema.nullable(),
    coverage: coverageSchema,
    units: z.array(unitSchema).max(MAX_SOURCE_UNITS),
  })
  .strict()
  .superRefine((report, context) => {
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_REPORT_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source scan report exceeds 64 KiB',
      });
    }

    const { rawHumanRegion, rawUtf16Length, mappedUtf16Length } = report;
    const regionWidth = rawHumanRegion.end - rawHumanRegion.start;
    if (
      rawHumanRegion.start > rawHumanRegion.end ||
      rawHumanRegion.end > rawUtf16Length ||
      regionWidth !== mappedUtf16Length ||
      (regionWidth === 0 && (rawUtf16Length !== 0 || rawHumanRegion.start !== 0))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Raw human region must exactly map the complete mapped body',
        path: ['rawHumanRegion'],
      });
      return;
    }

    if (
      rawHumanRegion.start === 0 &&
      rawHumanRegion.end === rawUtf16Length &&
      (rawUtf16Length !== mappedUtf16Length || report.rawContentHash !== report.mappedContentHash)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A full-span human region must preserve source hashes and length',
        path: ['rawHumanRegion'],
      });
    }

    const rawOffset = rawHumanRegion.start;
    const verifySpanPair = (
      pair: { rawSpan: { start: number; end: number }; mappedSpan: { start: number; end: number } },
      path: Array<string | number>,
    ) => {
      const { rawSpan, mappedSpan } = pair;
      if (
        rawSpan.end - rawSpan.start !== mappedSpan.end - mappedSpan.start ||
        rawSpan.start !== rawOffset + mappedSpan.start ||
        rawSpan.end !== rawOffset + mappedSpan.end ||
        mappedSpan.end > mappedUtf16Length ||
        rawSpan.end > rawUtf16Length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Raw and mapped spans must follow the exact geometry offset',
          path,
        });
      }
    };

    for (const [index, gap] of report.coverage.whitespaceGaps.entries()) {
      verifySpanPair(gap, ['coverage', 'whitespaceGaps', index]);
      const previous = report.coverage.whitespaceGaps[index - 1];
      if (previous && previous.mappedSpan.end > gap.mappedSpan.start) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Whitespace gaps must be ordered and disjoint',
          path: ['coverage', 'whitespaceGaps', index],
        });
      }
    }
    if (report.coverage.indeterminateSpan) {
      verifySpanPair(report.coverage.indeterminateSpan, ['coverage', 'indeterminateSpan']);
    }
    for (const [index, unit] of report.units.entries()) {
      verifySpanPair(unit, ['units', index]);
      const previous = report.units[index - 1];
      if (previous && previous.mappedSpan.end > unit.mappedSpan.start) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unit spans must be ordered and disjoint',
          path: ['units', index, 'mappedSpan'],
        });
      }
      if (unit.tokenSpan.end > (report.tokenCount ?? MAX_LEXICAL_TOKENS)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unit token span exceeds the report token count',
          path: ['units', index, 'tokenSpan'],
        });
      }
      if (unit.index !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unit indexes must be contiguous and ordered',
          path: ['units', index, 'index'],
        });
      }
    }

    const status = report.status;
    const { coverage, tokenCount, resourceReason, units } = report;
    if (status === 'complete') {
      if (
        resourceReason !== null ||
        coverage.status !== 'complete' ||
        coverage.indeterminateSpan !== null ||
        tokenCount === null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Complete scan metadata has inconsistent status fields',
        });
      }
      for (const [index, unit] of units.entries()) {
        if (unit.boundaryCode === 'end_of_input' && index !== units.length - 1) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Only the final complete unit may end at input end',
            path: ['units', index, 'boundaryCode'],
          });
        }
      }
      validateCoveragePartition(
        mappedUtf16Length,
        units,
        coverage.whitespaceGaps,
        mappedUtf16Length,
        tokenCount,
        context,
      );
    } else if (status === 'indeterminate') {
      if (
        resourceReason !== null ||
        coverage.status !== 'indeterminate_suffix' ||
        coverage.indeterminateSpan === null ||
        tokenCount === null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Indeterminate scan metadata has inconsistent status fields',
        });
      } else {
        const suffix = coverage.indeterminateSpan;
        if (
          suffix.mappedSpan.end !== mappedUtf16Length ||
          suffix.mappedSpan.start >= suffix.mappedSpan.end ||
          units.some((unit) => unit.boundaryCode === 'end_of_input')
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Indeterminate span must be one nonempty suffix after a closed prefix',
            path: ['coverage', 'indeterminateSpan'],
          });
        }
        const prefixTokenEnd = units.at(-1)?.tokenSpan.end ?? 0;
        if (prefixTokenEnd >= tokenCount) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Indeterminate suffix must contain at least one lexical token',
            path: ['tokenCount'],
          });
        }
        validateCoveragePartition(
          mappedUtf16Length,
          units,
          coverage.whitespaceGaps,
          suffix.mappedSpan.start,
          tokenCount,
          context,
        );
      }
    } else {
      const expectedMinimum = resourceReason?.kind === 'lexical_token_limit' ? 8_193 : 129;
      if (
        resourceReason === null ||
        resourceReason.observedMinimum !== expectedMinimum ||
        coverage.status !== 'not_reported' ||
        coverage.indeterminateSpan !== null ||
        coverage.whitespaceGaps.length !== 0 ||
        units.length !== 0 ||
        tokenCount !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Resource-limited scan metadata must not include a partial prefix',
        });
      }
    }
  });

export const AutonomousPersonalSourceScanV1OwnedDataSchema = scanReportBodySchema;

export type AutonomousPersonalSourceScanV1 = z.infer<
  typeof AutonomousPersonalSourceScanV1OwnedDataSchema
>;

type RawHumanRegion = z.infer<typeof rawHumanRegionSchema>;
type SourceSpan = z.infer<typeof sourceSpanSchema>;
type SpanPair = z.infer<typeof spanPairSchema>;
type BoundaryCode = z.infer<typeof boundaryCodeSchema>;
type CueCode = z.infer<typeof cueCodeSchema>;
type IndeterminateReason = z.infer<typeof indeterminateReasonSchema>;

interface ClosedUnit {
  readonly start: number;
  readonly end: number;
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly boundaryCode: BoundaryCode;
}

interface DelimiterFrame {
  readonly kind: 'bracket' | 'quote';
  readonly opener: number;
  readonly start: number;
}

interface PairedRegion {
  readonly start: number;
  readonly end: number;
}

type ScanResult =
  | {
      readonly status: 'complete';
      readonly tokenCount: number;
      readonly units: ClosedUnit[];
      readonly gaps: SourceSpan[];
      readonly quotePairs: PairedRegion[];
      readonly bracketPairs: PairedRegion[];
    }
  | {
      readonly status: 'indeterminate';
      readonly tokenCount: number;
      readonly units: ClosedUnit[];
      readonly gaps: SourceSpan[];
      readonly quotePairs: PairedRegion[];
      readonly bracketPairs: PairedRegion[];
      readonly suffix: SourceSpan;
      readonly reason: IndeterminateReason;
    }
  | {
      readonly status: 'resource_limit';
      readonly reason: 'lexical_token_limit';
      readonly observedMinimum: 8_193;
    }
  | {
      readonly status: 'resource_limit';
      readonly reason: 'unit_limit';
      readonly observedMinimum: 129;
    };

function asciiWordEquals(body: string, token: Token, expected: string): boolean {
  if (token.kind !== 'word' || token.end - token.start !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = body.charCodeAt(token.start + index);
    const lower = actual >= 0x41 && actual <= 0x5a ? actual + 0x20 : actual;
    if (lower !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function isAsciiSingleLetter(body: string, token: Token): boolean {
  if (token.kind !== 'word' || token.end - token.start !== 1) return false;
  const code = body.charCodeAt(token.start);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isPeriodToken(token: Token | undefined): boolean {
  return token?.kind === 'punctuation' && token.codePoint === 0x2e;
}

function isTerminalToken(token: Token | undefined): boolean {
  return (
    token?.kind === 'punctuation' &&
    (token.codePoint === 0x2e || token.codePoint === 0x21 || token.codePoint === 0x3f)
  );
}

function hasAdjacentWordCodePoints(body: string, period: Token): boolean {
  const before = previousCodePoint(body, period.start);
  const after = period.end < body.length ? nextCodePoint(body, period.end).codePoint : undefined;
  return (
    before !== undefined &&
    after !== undefined &&
    isAutonomousWordCodePointV1(before) &&
    isAutonomousWordCodePointV1(after)
  );
}

function isDottedInitialismTrailingPeriod(
  body: string,
  tokens: readonly Token[],
  periodIndex: number,
): boolean {
  let currentPeriod = periodIndex;
  let groups = 0;
  while (currentPeriod >= 1) {
    const letter = tokens[currentPeriod - 1];
    const period = tokens[currentPeriod];
    if (!letter || !period || !isAsciiSingleLetter(body, letter) || letter.end !== period.start) {
      break;
    }
    groups += 1;
    const priorPeriodIndex = currentPeriod - 2;
    if (
      priorPeriodIndex >= 1 &&
      isPeriodToken(tokens[priorPeriodIndex]) &&
      tokens[priorPeriodIndex].end === letter.start
    ) {
      currentPeriod = priorPeriodIndex;
    } else {
      break;
    }
  }
  return groups >= 2;
}

function isDottedAbbreviationTrailingPeriod(
  body: string,
  tokens: readonly Token[],
  periodIndex: number,
): boolean {
  const previous = tokens[periodIndex - 1];
  const period = tokens[periodIndex];
  if (!previous || !period || previous.end !== period.start) return false;
  const singleWordAbbreviations = ['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc'];
  if (
    singleWordAbbreviations.some((abbreviation) => asciiWordEquals(body, previous, abbreviation))
  ) {
    return true;
  }

  if (!asciiWordEquals(body, previous, 'g') && !asciiWordEquals(body, previous, 'e')) return false;
  const priorPeriod = tokens[periodIndex - 2];
  const priorWord = tokens[periodIndex - 3];
  if (!priorPeriod || !priorWord || !isPeriodToken(priorPeriod)) return false;
  if (priorPeriod.end !== previous.start || priorWord.end !== priorPeriod.start) return false;
  return (
    (asciiWordEquals(body, priorWord, 'e') && asciiWordEquals(body, previous, 'g')) ||
    (asciiWordEquals(body, priorWord, 'i') && asciiWordEquals(body, previous, 'e'))
  );
}

function isSingleInitialBeforeName(
  body: string,
  tokens: readonly Token[],
  periodIndex: number,
): boolean {
  const initial = tokens[periodIndex - 1];
  const period = tokens[periodIndex];
  const next = tokens[periodIndex + 1];
  return Boolean(
    initial &&
    period &&
    initial.end === period.start &&
    isUppercaseAsciiSingleLetter(body, initial) &&
    next &&
    next.start >= period.end &&
    next.kind === 'word',
  );
}

function isUppercaseAsciiSingleLetter(body: string, token: Token): boolean {
  return (
    token.kind === 'word' &&
    token.end - token.start === 1 &&
    body.charCodeAt(token.start) >= 0x41 &&
    body.charCodeAt(token.start) <= 0x5a
  );
}

function periodIsCoupled(body: string, tokens: readonly Token[], periodIndex: number): boolean {
  const period = tokens[periodIndex];
  if (!period) return false;
  return (
    hasAdjacentWordCodePoints(body, period) ||
    isDottedInitialismTrailingPeriod(body, tokens, periodIndex) ||
    isSingleInitialBeforeName(body, tokens, periodIndex) ||
    isDottedAbbreviationTrailingPeriod(body, tokens, periodIndex)
  );
}

function isBracketOpener(codePoint: number): boolean {
  return codePoint === 0x28 || codePoint === 0x5b || codePoint === 0x7b;
}

function isBracketCloser(codePoint: number): boolean {
  return codePoint === 0x29 || codePoint === 0x5d || codePoint === 0x7d;
}

function matchingBracket(open: number, close: number): boolean {
  return (
    (open === 0x28 && close === 0x29) ||
    (open === 0x5b && close === 0x5d) ||
    (open === 0x7b && close === 0x7d)
  );
}

function isOpeningQuoteRole(role: ReturnType<typeof quoteRole>): boolean {
  return role === 'curly_single_open' || role === 'curly_double_open';
}

function isClosingQuoteRole(role: ReturnType<typeof quoteRole>): boolean {
  return role === 'curly_single_close' || role === 'curly_double_close';
}

function quoteRolesMatch(open: number, close: number): boolean {
  return (open === 0x2018 && close === 0x2019) || (open === 0x201c && close === 0x201d);
}

function addGap(gaps: SourceSpan[], start: number, end: number): void {
  if (start < end) gaps.push({ start, end });
}

function scanSegments(body: string, tokens: readonly Token[]): ScanResult {
  const units: ClosedUnit[] = [];
  const gaps: SourceSpan[] = [];
  const quotePairs: PairedRegion[] = [];
  const bracketPairs: PairedRegion[] = [];
  const stack: DelimiterFrame[] = [];
  let unitStart: number | null = null;
  let unitTokenStart = 0;
  let partitionEnd = 0;

  const indeterminate = (reason: IndeterminateReason, tokenStart: number): ScanResult => {
    const suffixStart = unitStart ?? tokenStart;
    return {
      status: 'indeterminate',
      tokenCount: tokens.length,
      units,
      gaps,
      quotePairs,
      bracketPairs,
      suffix: { start: suffixStart, end: body.length },
      reason,
    };
  };

  const closeUnit = (endTokenIndex: number, boundaryCode: BoundaryCode): ScanResult | null => {
    if (unitStart === null || endTokenIndex < unitTokenStart) return null;
    const end = tokens[endTokenIndex]?.end;
    if (end === undefined) return null;
    units.push({
      start: unitStart,
      end,
      tokenStart: unitTokenStart,
      tokenEnd: endTokenIndex + 1,
      boundaryCode,
    });
    partitionEnd = end;
    unitStart = null;
    unitTokenStart = endTokenIndex + 1;
    if (units.length > MAX_SOURCE_UNITS) {
      return {
        status: 'resource_limit',
        reason: 'unit_limit',
        observedMinimum: 129,
      };
    }
    return null;
  };

  let tokenIndex = 0;
  while (tokenIndex < tokens.length) {
    const token = tokens[tokenIndex];
    if (unitStart === null) {
      addGap(gaps, partitionEnd, token.start);
      unitStart = token.start;
      unitTokenStart = tokenIndex;
    }

    const role = token.kind === 'quote' ? quoteRole(token.codePoint) : null;
    if (role !== null) {
      if (token.start > 0 && body.charCodeAt(token.start - 1) === 0x5c) {
        return indeterminate('unsupported_quote_escape', token.start);
      }

      const top = stack.at(-1);
      if (role === 'symmetric_single' || role === 'symmetric_double') {
        if (top?.kind === 'quote' && top.opener === token.codePoint) {
          stack.pop();
          quotePairs.push({ start: top.start, end: token.end });
        } else if (
          stack.some(
            (frame) =>
              frame.kind === 'quote' && quoteFamily(frame.opener) === quoteFamily(token.codePoint),
          )
        ) {
          return indeterminate('mismatched_quote', token.start);
        } else {
          if (stack.length >= MAX_NESTING_DEPTH) {
            return indeterminate('nesting_limit', token.start);
          }
          stack.push({ kind: 'quote', opener: token.codePoint, start: token.start });
        }
      } else if (isOpeningQuoteRole(role)) {
        if (
          stack.some(
            (frame) =>
              frame.kind === 'quote' && quoteFamily(frame.opener) === quoteFamily(token.codePoint),
          )
        ) {
          return indeterminate('mismatched_quote', token.start);
        }
        if (stack.length >= MAX_NESTING_DEPTH) {
          return indeterminate('nesting_limit', token.start);
        }
        stack.push({ kind: 'quote', opener: token.codePoint, start: token.start });
      } else if (isClosingQuoteRole(role)) {
        if (!top || top.kind !== 'quote') {
          return indeterminate(top ? 'mismatched_quote' : 'unmatched_quote', token.start);
        }
        if (
          quoteFamily(top.opener) !== quoteFamily(token.codePoint) ||
          !quoteRolesMatch(top.opener, token.codePoint)
        ) {
          return indeterminate('mismatched_quote', token.start);
        }
        stack.pop();
        quotePairs.push({ start: top.start, end: token.end });
      }
      tokenIndex += 1;
      continue;
    }

    if (isBracketOpener(token.codePoint)) {
      if (stack.length >= MAX_NESTING_DEPTH) {
        return indeterminate('nesting_limit', token.start);
      }
      stack.push({ kind: 'bracket', opener: token.codePoint, start: token.start });
      tokenIndex += 1;
      continue;
    }
    if (isBracketCloser(token.codePoint)) {
      const top = stack.at(-1);
      if (!top || top.kind !== 'bracket') {
        return indeterminate(top ? 'mismatched_bracket' : 'unmatched_bracket', token.start);
      }
      if (!matchingBracket(top.opener, token.codePoint)) {
        return indeterminate('mismatched_bracket', token.start);
      }
      stack.pop();
      bracketPairs.push({ start: top.start, end: token.end });
      tokenIndex += 1;
      continue;
    }

    if (stack.length > 0 || !isTerminalToken(token)) {
      tokenIndex += 1;
      continue;
    }

    let runEnd = tokenIndex;
    let periods = 0;
    let hasExclamation = false;
    let hasQuestion = false;
    while (runEnd < tokens.length && isTerminalToken(tokens[runEnd])) {
      const runToken = tokens[runEnd];
      if (runToken.codePoint === 0x2e) periods += 1;
      if (runToken.codePoint === 0x21) hasExclamation = true;
      if (runToken.codePoint === 0x3f) hasQuestion = true;
      runEnd += 1;
    }

    if (periods > 1) {
      return indeterminate('ambiguous_period_boundary', token.start);
    }

    let boundaryCode: BoundaryCode | null = null;
    if (hasQuestion) boundaryCode = 'question';
    else if (hasExclamation) boundaryCode = 'exclamation';
    else if (periods === 1 && !periodIsCoupled(body, tokens, tokenIndex)) {
      boundaryCode = 'period';
    }

    if (boundaryCode !== null) {
      const resource = closeUnit(runEnd - 1, boundaryCode);
      if (resource) return resource;
      tokenIndex = runEnd;
    } else {
      tokenIndex = runEnd;
    }
  }

  if (stack.length > 0) {
    const firstOpen = stack[0];
    return indeterminate(
      firstOpen.kind === 'quote' ? 'unmatched_quote' : 'unmatched_bracket',
      firstOpen.start,
    );
  }

  if (unitStart !== null) {
    const resource = closeUnit(tokens.length - 1, 'end_of_input');
    if (resource) return resource;
  }

  addGap(gaps, partitionEnd, body.length);
  return { status: 'complete', tokenCount: tokens.length, units, gaps, quotePairs, bracketPairs };
}

function isWhitespaceOnlyBetween(body: string, start: number, end: number): boolean {
  let offset = start;
  while (offset < end) {
    const { codePoint, width } = nextCodePoint(body, offset);
    if (!isAutonomousWhitespaceCodePointV1(codePoint)) return false;
    offset += width;
  }
  return true;
}

function tokenWordSequenceEquals(
  body: string,
  tokens: readonly Token[],
  tokenIndex: number,
  sequence: readonly string[],
  tokenEnd: number,
): boolean {
  if (tokenIndex + sequence.length > tokenEnd) return false;
  for (let offset = 0; offset < sequence.length; offset += 1) {
    const token = tokens[tokenIndex + offset];
    if (!token || !asciiWordEquals(body, token, sequence[offset])) return false;
    if (
      offset > 0 &&
      !isWhitespaceOnlyBetween(body, tokens[tokenIndex + offset - 1].end, token.start)
    ) {
      return false;
    }
  }
  return true;
}

function observedCuesForUnit(
  body: string,
  tokens: readonly Token[],
  unit: ClosedUnit,
  geometryQuoteRegions: readonly SourceSpan[],
  quotePairs: readonly PairedRegion[],
  bracketPairs: readonly PairedRegion[],
): CueCode[] {
  const cues: CueCode[] = [];
  if (geometryQuoteRegions.some((region) => region.start < unit.end && unit.start < region.end)) {
    cues.push('explicit_geometry_quote_overlap');
  }
  if (quotePairs.some((region) => region.start < unit.end && unit.start < region.end)) {
    cues.push('paired_text_quote_overlap');
  }
  if (bracketPairs.some((region) => region.start < unit.end && unit.start < region.end)) {
    cues.push('balanced_bracket_present');
  }

  let hasConditionalCue = false;
  let hasModalCue = false;
  let hasGenericTemporalCue = false;
  for (let index = unit.tokenStart; index < unit.tokenEnd; index += 1) {
    if (tokenWordSequenceEquals(body, tokens, index, ['if'], unit.tokenEnd))
      hasConditionalCue = true;
    if (
      tokenWordSequenceEquals(body, tokens, index, ['unless'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['provided'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['assuming'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['supposing'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['hypothetically'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['maybe'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['perhaps'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['might'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['could'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['would'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['as', 'if'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['in', 'case'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['as', 'long', 'as'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['on', 'condition'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['were', 'to'], unit.tokenEnd)
    ) {
      hasConditionalCue = true;
    }
    if (
      tokenWordSequenceEquals(body, tokens, index, ['might'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['could'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['would'], unit.tokenEnd)
    ) {
      hasModalCue = true;
    }
    if (
      tokenWordSequenceEquals(body, tokens, index, ['when'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['whenever'], unit.tokenEnd) ||
      tokenWordSequenceEquals(body, tokens, index, ['while'], unit.tokenEnd)
    ) {
      hasGenericTemporalCue = true;
    }
  }
  if (hasConditionalCue) cues.push('conditional_or_uncertainty_token');
  if (hasModalCue) cues.push('modal_token');
  if (hasGenericTemporalCue) cues.push('generic_temporal_token');
  return cues;
}

function toRawSpan(mappedSpan: SourceSpan, rawHumanRegion: RawHumanRegion): SourceSpan {
  return {
    start: rawHumanRegion.start + mappedSpan.start,
    end: rawHumanRegion.start + mappedSpan.end,
  };
}

function toSpanPair(mappedSpan: SourceSpan, rawHumanRegion: RawHumanRegion): SpanPair {
  return { rawSpan: toRawSpan(mappedSpan, rawHumanRegion), mappedSpan: { ...mappedSpan } };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function invalidAutonomousSourceScanData(): z.ZodError {
  return new z.ZodError([
    { code: z.ZodIssueCode.custom, path: [], message: 'invalid_autonomous_source_scan_data' },
  ]);
}

function assertReportByteLimit(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_REPORT_BYTES) {
    throw invalidAutonomousSourceScanData();
  }
}

function ownAndParseReport(value: unknown): AutonomousPersonalSourceScanV1 {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  assertReportByteLimit(owned);
  return deepFreeze(AutonomousPersonalSourceScanV1OwnedDataSchema.parse(owned));
}

/** Bounded facade for metadata-only scan reports; it proves no source authority. */
export const AutonomousPersonalSourceScanV1Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalSourceScanV1 {
    try {
      return ownAndParseReport(value);
    } catch {
      throw invalidAutonomousSourceScanData();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalSourceScanV1> {
    try {
      return { success: true, data: ownAndParseReport(value) };
    } catch {
      return { success: false, error: invalidAutonomousSourceScanData() };
    }
  },
});

function validateCoveragePartition(
  mappedLength: number,
  units: readonly z.infer<typeof unitSchema>[],
  gaps: readonly z.infer<typeof whitespaceGapSchema>[],
  partitionEnd: number,
  tokenCount: number | null,
  context: z.RefinementCtx,
): void {
  const segments = [
    ...units.map((unit) => ({ start: unit.mappedSpan.start, end: unit.mappedSpan.end })),
    ...gaps.map((gap) => ({ start: gap.mappedSpan.start, end: gap.mappedSpan.end })),
  ].sort((left, right) => left.start - right.start || left.end - right.end);

  let expectedStart = 0;
  for (const [index, segment] of segments.entries()) {
    if (
      segment.start !== expectedStart ||
      segment.end <= segment.start ||
      segment.end > partitionEnd
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Coverage spans must form an ordered non-overlapping partition',
        path: ['coverage'],
      });
      break;
    }
    expectedStart = segment.end;
    if (index === segments.length - 1 && expectedStart !== partitionEnd) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Coverage spans must reach the partition end',
        path: ['coverage'],
      });
    }
  }
  if (segments.length === 0 && partitionEnd !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Nonempty source must be represented by coverage spans',
      path: ['coverage'],
    });
  }
  if (expectedStart !== partitionEnd) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Coverage spans do not reach the partition end',
      path: ['coverage'],
    });
  }

  let expectedTokenStart = 0;
  for (const [index, unit] of units.entries()) {
    if (unit.tokenSpan.start !== expectedTokenStart) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unit token spans must be contiguous and ordered',
        path: ['units', index, 'tokenSpan'],
      });
      break;
    }
    expectedTokenStart = unit.tokenSpan.end;
  }
  if (tokenCount !== null && expectedTokenStart > tokenCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unit token spans exceed the source token count',
      path: ['units'],
    });
  }
  if (tokenCount !== null && partitionEnd === mappedLength && expectedTokenStart !== tokenCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Complete unit token spans must account for all lexical tokens',
      path: ['units'],
    });
  }
}

function makeReport(
  geometry: ReturnType<typeof compileAutonomousSourceGeometryV3>['geometry'],
  geometryHash: string,
  body: string,
  tokens: readonly Token[],
  scan: ScanResult,
): AutonomousPersonalSourceScanV1 {
  const rawHumanRegion = geometry.humanRegion
    ? { ...geometry.humanRegion }
    : { start: 0, end: geometry.rawUtf16Length };

  if (scan.status === 'resource_limit') {
    const resourceReason =
      scan.reason === 'lexical_token_limit'
        ? { kind: 'lexical_token_limit' as const, observedMinimum: 8_193 as const }
        : { kind: 'unit_limit' as const, observedMinimum: 129 as const };
    return {
      version: 1,
      rawContentHash: geometry.rawContentHash,
      mappedContentHash: geometry.mappedContentHash,
      geometryHash,
      rawUtf16Length: geometry.rawUtf16Length,
      mappedUtf16Length: geometry.mappedUtf16Length,
      rawHumanRegion,
      tokenCount: null,
      status: 'resource_limit',
      resourceReason,
      coverage: { status: 'not_reported', whitespaceGaps: [], indeterminateSpan: null },
      units: [],
    };
  }

  const { quotePairs, bracketPairs } = scan;
  const units = scan.units.map((unit, index) => ({
    index,
    rawSpan: toRawSpan({ start: unit.start, end: unit.end }, rawHumanRegion),
    mappedSpan: { start: unit.start, end: unit.end },
    tokenSpan: { start: unit.tokenStart, end: unit.tokenEnd },
    boundaryCode: unit.boundaryCode,
    observedCueCodes: observedCuesForUnit(
      body,
      tokens,
      unit,
      geometry.quoteRegions,
      quotePairs,
      bracketPairs,
    ),
  }));

  const gaps = scan.gaps.map((gap) => toSpanPair(gap, rawHumanRegion));
  if (scan.status === 'indeterminate') {
    return {
      version: 1,
      rawContentHash: geometry.rawContentHash,
      mappedContentHash: geometry.mappedContentHash,
      geometryHash,
      rawUtf16Length: geometry.rawUtf16Length,
      mappedUtf16Length: geometry.mappedUtf16Length,
      rawHumanRegion,
      tokenCount: scan.tokenCount,
      status: 'indeterminate',
      resourceReason: null,
      coverage: {
        status: 'indeterminate_suffix',
        whitespaceGaps: gaps,
        indeterminateSpan: {
          ...toSpanPair(scan.suffix, rawHumanRegion),
          reasonCode: scan.reason,
        },
      },
      units,
    };
  }
  return {
    version: 1,
    rawContentHash: geometry.rawContentHash,
    mappedContentHash: geometry.mappedContentHash,
    geometryHash,
    rawUtf16Length: geometry.rawUtf16Length,
    mappedUtf16Length: geometry.mappedUtf16Length,
    rawHumanRegion,
    tokenCount: scan.tokenCount,
    status: 'complete',
    resourceReason: null,
    coverage: { status: 'complete', whitespaceGaps: gaps, indeterminateSpan: null },
    units,
  };
}

/** Compile deterministic token/boundary DATA only; no acceptance or authority follows. */
export function compileAutonomousPersonalSourceScanV1(
  input: unknown,
): AutonomousPersonalSourceScanV1 {
  try {
    // Own the complete raw source request before passing it to any Zod facade.
    const ownedInput = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    const compilation = compileAutonomousSourceGeometryV3(ownedInput);
    const body = compilation.mappedHumanBody;
    const tokens = tokenizeMappedBody(body);
    let scan: ScanResult;
    if (tokens === null) {
      scan = {
        status: 'resource_limit',
        reason: 'lexical_token_limit',
        observedMinimum: 8_193,
      };
    } else {
      scan = scanSegments(body, tokens);
    }

    const report = makeReport(
      compilation.geometry,
      compilation.geometryHash,
      body,
      tokens ?? [],
      scan,
    );
    assertReportByteLimit(report);
    return deepFreeze(AutonomousPersonalSourceScanV1OwnedDataSchema.parse(report));
  } catch {
    throw invalidAutonomousSourceScanData();
  }
}
