import { createHash } from 'crypto';
import { AutomaticSourceEnvelopeSchema } from '../schemas/AutomaticMemory.schema';
import {
  CompositionalPreferenceDescriptorSchema,
  CompositionalPreferenceSchema,
  type CompositionalPreference,
  type CompositionalPreferenceBundle,
  type CompositionalPreferenceEdge,
  type CompositionalPreferenceNode,
  type CompositionalPreferenceReason,
  COMPOSITIONAL_PREFERENCE_DESCRIPTOR,
  snapshotBoundedCompositionalJson,
  validateCompositionalPreferenceEvidence,
} from '../schemas/CompositionalPreference.schema';
import {
  CompositionalPreferenceInterpretationInputSchema,
  type CompositionalPreferenceInterpretationInput,
} from '../schemas/CompositionalPreferenceMeaning.schema';

type TokenKind = 'word' | 'punctuation' | 'quote';

interface Token {
  readonly kind: TokenKind;
  readonly raw: string;
  readonly folded: string;
  readonly start: number;
  readonly end: number;
}

interface TokenRange {
  readonly start: number;
  readonly end: number;
}

interface SentenceRange extends TokenRange {
  readonly terminal?: string;
  readonly terminalEnd?: number;
}

interface ParseFailure {
  readonly ok: false;
  readonly reason: CompositionalPreferenceReason;
}

interface ParseSuccess {
  readonly ok: true;
  readonly bundle: CompositionalPreferenceBundle;
}

type PredicateParse = ParseFailure | ParseSuccess;

interface ParsedTarget {
  readonly ok: true;
  readonly targetNodeId: string;
  readonly next: number;
  readonly nodes: CompositionalPreferenceNode[];
  readonly attachments: CompositionalPreferenceEdge[];
  readonly orderingRelation?: 'before' | 'followed_by' | 'first_then' | 'start_with_then';
  readonly directConditionOwner?: string;
  readonly conditionStart?: number;
  readonly conditionEnd?: number;
  readonly hasOutputOrder: boolean;
  readonly hasLanguage: boolean;
}

interface ParsedAction {
  readonly ok: true;
  readonly nodeId: string;
  readonly action: 'examples' | 'terminology' | 'definitions' | 'steps';
  readonly next: number;
}

interface ParsedLanguage {
  readonly nodeId: string;
  readonly usageNodeId?: string;
  readonly next: number;
  readonly languageStart: number;
  readonly languageEnd: number;
  readonly usageStart?: number;
  readonly usageEnd?: number;
}

interface ScopeMatch {
  readonly value: 'code_review' | 'worked_calculation' | 'summary' | 'planning';
  readonly next: number;
  readonly start: number;
  readonly end: number;
}

interface WorkItem {
  readonly bundle?: CompositionalPreferenceBundle;
  readonly region?: { start: number; end: number };
  readonly reason?: CompositionalPreferenceReason;
  readonly disposition: 'complete' | 'withheld' | 'recognized';
}

interface SentenceAnalysis {
  readonly sentence: SentenceRange;
  readonly context: CompositionalPreferenceReason | null;
  readonly candidateStart: number | null;
}

const EXPECTED_DESCRIPTOR = JSON.stringify(COMPOSITIONAL_PREFERENCE_DESCRIPTOR);
const OPERATORS = new Set(['prefer', 'like', 'dislike']);
const MODAL_WORDS = new Set(['might', 'could', 'would', 'may', 'perhaps', 'maybe', 'possibly']);
const SENSITIVE_WORDS = new Set([
  'abortion',
  'addiction',
  'adhd',
  'aids',
  'alcoholism',
  'anxiety',
  'autism',
  'cancer',
  'depression',
  'diagnosis',
  'disability',
  'disease',
  'hiv',
  'medication',
  'medical',
  'mental',
  'muslim',
  'opioid',
  'password',
  'pregnancy',
  'prescription',
  'religion',
  'sexuality',
  'trauma',
  'treatment',
]);

const OUTPUTS = new Map<string, 'explanation' | 'answer' | 'response'>([
  ['explanation', 'explanation'],
  ['explanations', 'explanation'],
  ['answer', 'answer'],
  ['answers', 'answer'],
  ['response', 'response'],
  ['responses', 'response'],
]);

const PRESENTATIONS = new Map<string, 'bullets' | 'numbered_steps' | 'prose' | 'table'>([
  ['bullets', 'bullets'],
  ['prose', 'prose'],
  ['table', 'table'],
  ['tables', 'table'],
]);

const LANGUAGES = new Map<string, 'English' | 'French' | 'Swahili' | 'Spanish'>([
  ['english', 'English'],
  ['french', 'French'],
  ['swahili', 'Swahili'],
  ['spanish', 'Spanish'],
]);

const REGIONS = new Map<string, 'British' | 'American' | 'Australian' | 'Canadian' | 'Kenyan'>([
  ['british', 'British'],
  ['american', 'American'],
  ['australian', 'Australian'],
  ['canadian', 'Canadian'],
  ['kenyan', 'Kenyan'],
]);

const LANGUAGE_TAGS: Record<
  string,
  'en' | 'en-GB' | 'en-US' | 'en-AU' | 'fr' | 'fr-CA' | 'sw' | 'sw-KE' | 'es'
> = {
  'English:': 'en',
  'English:British': 'en-GB',
  'English:American': 'en-US',
  'English:Australian': 'en-AU',
  'French:': 'fr',
  'French:Canadian': 'fr-CA',
  'Swahili:': 'sw',
  'Swahili:Kenyan': 'sw-KE',
  'Spanish:': 'es',
};

function asciiFold(value: string): string {
  let folded = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    folded += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  return folded;
}

function isWhitespace(value: string): boolean {
  return /^\s$/u.test(value);
}

function isPunctuation(value: string): boolean {
  return /^\p{P}$/u.test(value);
}

function isQuote(value: string): boolean {
  return (
    value === '"' ||
    value === "'" ||
    value === '“' ||
    value === '”' ||
    value === '‘' ||
    value === '’'
  );
}

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}\p{M}]/u.test(value);
}

function codePointAt(value: string, index: number): { value: string; next: number } {
  const point = value.codePointAt(index);
  if (point === undefined) return { value: '', next: index };
  const character = String.fromCodePoint(point);
  return { value: character, next: index + character.length };
}

function lex(content: string, check?: () => void): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < content.length) {
    check?.();
    const current = codePointAt(content, index);
    if (isWhitespace(current.value)) {
      index = current.next;
      continue;
    }
    if (isQuote(current.value)) {
      tokens.push({
        kind: 'quote',
        raw: current.value,
        folded: current.value,
        start: index,
        end: current.next,
      });
      index = current.next;
      continue;
    }
    if (isWordCharacter(current.value)) {
      const start = index;
      index = current.next;
      while (index < content.length) {
        check?.();
        const next = codePointAt(content, index);
        if (isWordCharacter(next.value)) {
          index = next.next;
          continue;
        }
        const previous = content.slice(index - 1, index);
        const after = codePointAt(content, next.next);
        if (
          (next.value === "'" || next.value === '-') &&
          previous.length > 0 &&
          after.value.length > 0 &&
          isWordCharacter(previous) &&
          isWordCharacter(after.value)
        ) {
          index = next.next;
          continue;
        }
        break;
      }
      const raw = content.slice(start, index);
      tokens.push({ kind: 'word', raw, folded: asciiFold(raw), start, end: index });
      continue;
    }
    const kind: TokenKind = isPunctuation(current.value) ? 'punctuation' : 'punctuation';
    tokens.push({
      kind,
      raw: current.value,
      folded: current.value,
      start: index,
      end: current.next,
    });
    index = current.next;
  }
  return tokens;
}

function segmentSentences(
  tokens: Token[],
  check?: () => void,
  quoteRanges: Array<{ start: number; end: number }> = [],
): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  let start = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    check?.();
    const token = tokens[index];
    const insideQuote = quoteRanges.some(
      (quote) => token.start >= quote.start && token.end <= quote.end,
    );
    if (!insideQuote && token.kind === 'punctuation' && ['.', '!', '?', ';'].includes(token.raw)) {
      const terminalStart = index;
      let terminal = token.raw;
      let terminalEnd = token.end;
      // Keep the entire terminal run, including orphan runs. Otherwise a later
      // question marker can disappear after a period has closed the fragment.
      while (index + 1 < tokens.length) {
        check?.();
        const next = tokens[index + 1];
        if (
          next.kind !== 'punctuation' ||
          !['.', '!', '?', ';'].includes(next.raw) ||
          quoteRanges.some((quote) => next.start >= quote.start && next.end <= quote.end)
        )
          break;
        index += 1;
        terminal += next.raw;
        terminalEnd = next.end;
      }
      ranges.push({ start, end: terminalStart, terminal, terminalEnd });
      start = index + 1;
    }
  }
  if (start < tokens.length) ranges.push({ start, end: tokens.length });
  return ranges;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class AstBuilder {
  readonly nodes: CompositionalPreferenceNode[] = [];
  readonly edges: CompositionalPreferenceEdge[] = [];
  private readonly rawOffset: number;
  private readonly sourceIdentity: string;
  private readonly content: string;
  private readonly tokens: Token[];
  private readonly check?: () => void;

  constructor(
    content: string,
    tokens: Token[],
    rawOffset: number,
    sourceIdentity: string,
    check?: () => void,
  ) {
    this.content = content;
    this.tokens = tokens;
    this.rawOffset = rawOffset;
    this.sourceIdentity = sourceIdentity;
    this.check = check;
  }

  evidence(start: number, end: number) {
    this.check?.();
    if (start < 0 || end <= start || !this.tokens[start] || !this.tokens[end - 1]) {
      throw new Error('Evidence must cover at least one source token');
    }
    const contentStart = this.tokens[start].start;
    const contentEnd = this.tokens[end - 1].end;
    return {
      descriptor: { ...COMPOSITIONAL_PREFERENCE_DESCRIPTOR },
      spans: [
        {
          content: { start: contentStart, end: contentEnd },
          raw: { start: this.rawOffset + contentStart, end: this.rawOffset + contentEnd },
        },
      ],
      lexicalForm: this.content.slice(contentStart, contentEnd),
    };
  }

  nodeId(kind: string, start: number, end: number): string {
    this.check?.();
    const first = this.tokens[start];
    const last = this.tokens[end - 1];
    if (!first || !last) throw new Error('Node evidence range is empty');
    const digest = sha256(`${this.sourceIdentity}\u0000${kind}\u0000${first.start}:${last.end}`);
    return `n_${digest.slice(0, 32)}`;
  }

  addNode(node: CompositionalPreferenceNode): void {
    this.check?.();
    this.nodes.push(node);
  }

  savepoint(): { nodes: number; edges: number } {
    return { nodes: this.nodes.length, edges: this.edges.length };
  }

  rollback(savepoint: { nodes: number; edges: number }): void {
    this.nodes.length = savepoint.nodes;
    this.edges.length = savepoint.edges;
  }

  checkpoint(): void {
    this.check?.();
  }

  addEdge(
    relation: CompositionalPreferenceEdge['relation'],
    ownerNodeId: string,
    targetNodeId: string,
    start: number,
    end: number,
    position?: 'first' | 'second',
  ): void {
    this.check?.();
    const base = {
      ownerNodeId,
      targetNodeId,
      evidence: this.evidence(start, end),
    };
    if (relation === 'orders') {
      if (!position) throw new Error('Ordering edge requires a position');
      this.edges.push({ ...base, relation, position });
    } else {
      this.edges.push({ ...base, relation } as CompositionalPreferenceEdge);
    }
  }
}

function makeEmptyResult(
  coverage: 'none' | 'unknown',
  reasons: CompositionalPreferenceReason[] = [],
  withheld: Array<{
    sourceRegion?: { start: number; end: number };
    reason: CompositionalPreferenceReason;
  }> = [],
): CompositionalPreference {
  const uniqueReasons = [...new Set(reasons)].slice(0, 16);
  const candidate = {
    version: 1 as const,
    descriptor: { ...COMPOSITIONAL_PREFERENCE_DESCRIPTOR },
    coverage,
    bundles: [],
    withheld: withheld.slice(0, 32),
    reasons: uniqueReasons,
  };
  const parsed = CompositionalPreferenceSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return {
    version: 1,
    descriptor: { ...COMPOSITIONAL_PREFERENCE_DESCRIPTOR },
    coverage: 'unknown',
    bundles: [],
    withheld: [],
    reasons: ['invalid_ast_integrity'],
  };
}

function makeResult(
  coverage: CompositionalPreference['coverage'],
  bundles: CompositionalPreferenceBundle[],
  withheld: Array<{
    sourceRegion?: { start: number; end: number };
    reason: CompositionalPreferenceReason;
  }>,
  reasons: CompositionalPreferenceReason[],
): CompositionalPreference {
  const candidate = {
    version: 1 as const,
    descriptor: { ...COMPOSITIONAL_PREFERENCE_DESCRIPTOR },
    coverage,
    bundles,
    withheld,
    reasons: [...new Set(reasons)].slice(0, 16),
  };
  const parsed = CompositionalPreferenceSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const metadataOverflow = parsed.error.issues.some((issue) => issue.message.includes('32 KiB'));
  return makeEmptyResult('unknown', [
    metadataOverflow ? 'metadata_too_large' : 'invalid_ast_integrity',
  ]);
}

function regionFor(tokens: Token[], range: TokenRange): { start: number; end: number } | undefined {
  const first = tokens[range.start];
  const last = tokens[range.end - 1];
  if (!first || !last || first.start >= last.end) return undefined;
  return { start: first.start, end: last.end };
}

function isWord(token: Token | undefined, value: string): boolean {
  return token?.kind === 'word' && token.folded === value;
}

function sameTokens(tokens: Token[], start: number, values: string[]): boolean {
  if (start + values.length > tokens.length) return false;
  return values.every((value, offset) => isWord(tokens[start + offset], value));
}

function isComma(token: Token | undefined): boolean {
  return token?.kind === 'punctuation' && token.raw === ',';
}

function containsSensitiveToken(tokens: Token[], range: TokenRange, check?: () => void): boolean {
  for (let index = range.start; index < range.end; index += 1) {
    check?.();
    const token = tokens[index];
    if (token?.kind === 'word' && SENSITIVE_WORDS.has(token.folded)) return true;
  }
  return false;
}

function operatorAfterSubject(tokens: Token[], subjectIndex: number, end: number): boolean {
  let cursor = subjectIndex + 1;
  if (isWord(tokens[cursor], 'usually')) cursor += 1;
  if (sameTokens(tokens, cursor, ['do', 'not'])) cursor += 2;
  else if (isWord(tokens[cursor], "don't")) cursor += 1;
  return cursor < end && OPERATORS.has(tokens[cursor]?.folded ?? '');
}

function findPotentialSpeakerPreferenceStart(
  tokens: Token[],
  range: TokenRange,
  check?: () => void,
): number | null {
  let cursor = range.start;
  if (isWord(tokens[cursor], 'for')) {
    const scope = parseTaskScope(tokens, cursor + 1, range.end);
    if (scope && isComma(tokens[scope.next])) cursor = scope.next + 1;
  }
  for (let index = cursor; index < range.end; index += 1) {
    check?.();
    if (isWord(tokens[index], 'i') && operatorAfterSubject(tokens, index, range.end)) return index;
  }
  return null;
}

function beginsExplicitPreferenceUnit(
  tokens: Token[],
  range: TokenRange,
  check?: () => void,
): boolean {
  let expected = range.start;
  if (isWord(tokens[expected], 'for')) {
    const scope = parseTaskScope(tokens, expected + 1, range.end);
    if (!scope || !isComma(tokens[scope.next])) return false;
    expected = scope.next + 1;
  }
  return (
    isWord(tokens[expected], 'i') &&
    findPotentialSpeakerPreferenceStart(tokens, range, check) === expected
  );
}

function isRetroactiveContext(tokens: Token[], range: TokenRange, check?: () => void): boolean {
  const first = tokens[range.start]?.folded;
  if (first !== 'this' && first !== 'that' && first !== 'it') return false;
  let hasCopula = false;
  let hasQualifier = false;
  for (let index = range.start + 1; index < range.end; index += 1) {
    check?.();
    const value = tokens[index]?.folded;
    hasCopula ||= value === 'was' || value === 'is' || value === 'were';
    hasQualifier ||=
      value === 'hypothetical' ||
      value === 'fictional' ||
      value === 'fiction' ||
      value === 'roleplay';
  }
  return hasCopula && hasQualifier;
}

function contextReason(
  tokens: Token[],
  range: SentenceRange,
  quoted: boolean,
  check?: () => void,
): CompositionalPreferenceReason | null {
  const values = new Set<string>();
  let hasModal = false;
  let hasGenericCondition = false;
  let hasSay = false;
  let hasReported = false;
  let hasRoleplayOrScenario = false;
  for (let index = range.start; index < range.end; index += 1) {
    check?.();
    const token = tokens[index];
    if (!token) continue;
    values.add(token.folded);
    hasModal ||= MODAL_WORDS.has(token.folded);
    hasReported ||= token.folded === 'reported';
    hasSay ||= token.folded === 'say';
    hasRoleplayOrScenario ||= token.folded === 'roleplay' || token.folded === 'scenario';
    if (
      token.folded === 'if' ||
      token.folded === 'unless' ||
      token.folded === 'provided' ||
      (token.folded === 'when' && tokens[index + 1]?.folded !== 'requested')
    ) {
      hasGenericCondition = true;
    }
  }
  const has = (value: string) => values.has(value);
  const first = tokens[range.start]?.folded ?? '';
  const second = tokens[range.start + 1]?.folded ?? '';
  const third = tokens[range.start + 2]?.folded ?? '';
  if (isRetroactiveContext(tokens, range, check)) return 'hypothetical';
  if (['suppose', 'imagine', 'assume', 'fictional', 'scenario', 'roleplay'].includes(first)) {
    return 'hypothetical';
  }
  if (first === 'pretend') return 'instruction';
  if (first === 'for' && hasRoleplayOrScenario) return 'hypothetical';
  const potentialReport =
    (first === 'someone' && (second === 'said' || second === 'reported')) ||
    (first === 'my' &&
      ['manager', 'colleague', 'coworker', 'friend', 'doctor'].includes(second) &&
      ['said', 'reported'].includes(third)) ||
    hasReported;
  if (potentialReport) return 'reported_statement';
  if (quoted) return 'quoted_content';
  if (range.terminal === '?' || (first === 'do' && second === 'i')) return 'question';
  if (first === 'if' && hasSay) return 'instruction';
  if (first === 'hypothetically' || first === 'theoretically' || hasModal) return 'hypothetical';
  if (hasGenericCondition) return 'hypothetical';
  if (
    ['my', 'someone', 'somebody', 'he', 'she', 'they', 'colleague', 'manager', 'coworker'].includes(
      first,
    ) ||
    (first === 'the' && ['user', 'person', 'manager', 'colleague'].includes(second))
  ) {
    return 'third_party';
  }
  if (
    ['use', 'please', 'remember', 'say', 'tell', 'write', 'make', 'keep'].includes(first) ||
    (first === 'if' && has('say'))
  ) {
    return 'instruction';
  }
  const candidateStart = findPotentialSpeakerPreferenceStart(tokens, range, check);
  if (candidateStart !== null && first !== 'i') {
    for (let index = range.start; index < candidateStart; index += 1) {
      check?.();
      if (tokens[index]?.raw === ':') return 'unsupported_grammar';
    }
  }
  return null;
}

function textQuoteMask(
  tokens: Token[],
  contentLength: number,
  check?: () => void,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let openStart: number | undefined;
  let opening = '';
  for (const token of tokens) {
    check?.();
    if (token.kind !== 'quote') continue;
    if (token.raw === '“' || token.raw === '‘') {
      if (openStart === undefined) {
        openStart = token.start;
        opening = token.raw;
      }
    } else if (token.raw === '”' || token.raw === '’') {
      if (openStart !== undefined) {
        ranges.push({ start: openStart, end: token.end });
        openStart = undefined;
        opening = '';
      }
    } else if (token.raw === '"' || token.raw === "'") {
      if (openStart === undefined) {
        openStart = token.start;
        opening = token.raw;
      } else if (opening === token.raw) {
        ranges.push({ start: openStart, end: token.end });
        openStart = undefined;
        opening = '';
      }
    }
  }
  if (openStart !== undefined) ranges.push({ start: openStart, end: contentLength });
  return ranges;
}

function hasWellFormedQuoteSyntax(tokens: Token[], check?: () => void): boolean {
  let opening: string | undefined;
  for (const token of tokens) {
    check?.();
    if (token.kind !== 'quote') continue;
    if (opening === undefined) {
      if (token.raw === '”' || token.raw === '’') return false;
      opening = token.raw;
      continue;
    }
    const expectedClosing = opening === '“' ? '”' : opening === '‘' ? '’' : opening;
    if (token.raw !== expectedClosing) return false;
    opening = undefined;
  }
  return opening === undefined;
}

function isQuoted(
  tokens: Token[],
  range: SentenceRange,
  textRanges: Array<{ start: number; end: number }>,
  explicitRanges: Array<{ start: number; end: number }>,
  check?: () => void,
): boolean {
  let firstBodyToken: Token | undefined;
  let lastBodyToken: Token | undefined;
  for (let index = range.start; index < range.end; index += 1) {
    check?.();
    const token = tokens[index];
    if (!token || token.kind === 'quote') continue;
    firstBodyToken ??= token;
    lastBodyToken = token;
  }
  if (!firstBodyToken || !lastBodyToken) return false;
  const region = { start: firstBodyToken.start, end: lastBodyToken.end };
  for (const quote of textRanges) {
    check?.();
    if (region.start < quote.end && region.end > quote.start) return true;
  }
  for (const quote of explicitRanges) {
    check?.();
    if (region.start < quote.end && region.end > quote.start) return true;
  }
  return false;
}

function isOffsetQuoted(
  offset: number,
  textRanges: Array<{ start: number; end: number }>,
  explicitRanges: Array<{ start: number; end: number }>,
  check?: () => void,
): boolean {
  for (const quote of textRanges) {
    check?.();
    if (offset >= quote.start && offset < quote.end) return true;
  }
  for (const quote of explicitRanges) {
    check?.();
    if (offset >= quote.start && offset < quote.end) return true;
  }
  return false;
}

function sensitiveFailure(
  tokens: Token[],
  range: TokenRange,
  check?: () => void,
  fallback: CompositionalPreferenceReason = 'unsupported_grammar',
): CompositionalPreferenceReason {
  if (containsSensitiveToken(tokens, range, check)) return 'sensitive_scope';
  for (let index = range.start; index < range.end; index += 1) {
    check?.();
    if (tokens[index]?.folded === 'any') return 'ambiguous_attachment';
  }
  return fallback;
}

function nodeIdFor(builder: AstBuilder, kind: string, start: number, end: number): string {
  return builder.nodeId(kind, start, end);
}

function addActionNode(
  builder: AstBuilder,
  nounStart: number,
  nounEnd: number,
  action: 'examples' | 'terminology' | 'definitions' | 'steps',
): string {
  const nodeId = nodeIdFor(builder, 'action', nounStart, nounEnd);
  builder.addNode({
    nodeId,
    kind: 'action',
    value: action,
    evidence: builder.evidence(nounStart, nounEnd),
  });
  return nodeId;
}

function parseTaskScope(tokens: Token[], start: number, _end: number): ScopeMatch | null {
  const first = tokens[start]?.folded;
  if (first === 'planning') {
    return { value: 'planning', next: start + 1, start, end: start + 1 };
  }
  if (first === 'summary' || first === 'summaries') {
    return { value: 'summary', next: start + 1, start, end: start + 1 };
  }
  if (
    sameTokens(tokens, start, ['code', 'review']) ||
    sameTokens(tokens, start, ['code', 'reviews'])
  ) {
    return { value: 'code_review', next: start + 2, start, end: start + 2 };
  }
  if (
    sameTokens(tokens, start, ['worked', 'calculation']) ||
    sameTokens(tokens, start, ['worked', 'calculations'])
  ) {
    return { value: 'worked_calculation', next: start + 2, start, end: start + 2 };
  }
  return null;
}

function createTaskScope(
  builder: AstBuilder,
  scope: ScopeMatch,
): { nodeId: string; evidenceStart: number; evidenceEnd: number } {
  const nodeId = nodeIdFor(builder, 'task_scope', scope.start, scope.end);
  builder.addNode({
    nodeId,
    kind: 'task_scope',
    value: scope.value,
    evidence: builder.evidence(scope.start, scope.end),
  });
  return { nodeId, evidenceStart: scope.start, evidenceEnd: scope.end };
}

function parseLanguagePhrase(
  tokens: Token[],
  start: number,
  end: number,
  builder: AstBuilder,
): ParsedLanguage | null {
  let cursor = start;
  const usageStart = isWord(tokens[cursor], 'plain') ? cursor : undefined;
  if (usageStart !== undefined) cursor += 1;
  const phraseStart = cursor;
  let base: 'English' | 'French' | 'Swahili' | 'Spanish' | undefined;
  let region: 'British' | 'American' | 'Australian' | 'Canadian' | 'Kenyan' | undefined;
  let phraseEnd = cursor;

  const firstRegion = REGIONS.get(tokens[cursor]?.folded ?? '');
  const regionBase = LANGUAGES.get(tokens[cursor + 1]?.folded ?? '');
  if (firstRegion && regionBase) {
    region = firstRegion;
    base = regionBase;
    phraseEnd = cursor + 2;
  } else {
    const baseWord = LANGUAGES.get(tokens[cursor]?.folded ?? '');
    if (!baseWord) return null;
    base = baseWord;
    phraseEnd = cursor + 1;
    if (
      tokens[phraseEnd]?.raw === '(' &&
      REGIONS.has(tokens[phraseEnd + 1]?.folded ?? '') &&
      tokens[phraseEnd + 2]?.raw === ')'
    ) {
      region = REGIONS.get(tokens[phraseEnd + 1].folded);
      phraseEnd += 3;
    }
  }

  const tag = LANGUAGE_TAGS[`${base}:${region ?? ''}`];
  if (!tag) return null;
  const languageStart = phraseStart;
  const languageEnd = phraseEnd;
  const nodeId = nodeIdFor(builder, 'language', languageStart, languageEnd);
  builder.addNode({
    nodeId,
    kind: 'language',
    base,
    ...(region === undefined ? {} : { region }),
    languageTag: tag,
    evidence: builder.evidence(languageStart, languageEnd),
  });

  let usageNodeId: string | undefined;
  if (usageStart !== undefined) {
    const usageEnd = usageStart + 1;
    usageNodeId = nodeIdFor(builder, 'language_use', usageStart, usageEnd);
    builder.addNode({
      nodeId: usageNodeId,
      kind: 'language_use',
      value: 'plain',
      targetNodeId: nodeId,
      evidence: builder.evidence(usageStart, usageEnd),
    });
    builder.addEdge('qualifies', nodeId, usageNodeId, usageStart, usageEnd);
  }

  return {
    nodeId,
    ...(usageNodeId === undefined ? {} : { usageNodeId }),
    next: phraseEnd,
    languageStart,
    languageEnd,
    ...(usageStart === undefined ? {} : { usageStart, usageEnd: usageStart + 1 }),
  };
}

type ActionMatch = ParsedAction | ParseFailure | null;

function parseAction(
  tokens: Token[],
  start: number,
  end: number,
  builder: AstBuilder,
  allowAny: boolean,
): ActionMatch {
  let cursor = start;
  const quantifierStart = isWord(tokens[cursor], 'any') ? cursor : undefined;
  if (quantifierStart !== undefined) {
    if (!allowAny) return { ok: false, reason: 'ambiguous_attachment' };
    cursor += 1;
  }

  let countStart: number | undefined;
  let countEnd: number | undefined;
  let mode: 'as_stated' | 'only' | 'exactly' = 'as_stated';
  if (isWord(tokens[cursor], 'only') || isWord(tokens[cursor], 'exactly')) {
    mode = tokens[cursor].folded as 'only' | 'exactly';
    countStart = cursor;
    cursor += 1;
    if (!isWord(tokens[cursor], 'one')) return { ok: false, reason: 'unsupported_grammar' };
    countEnd = cursor + 1;
    cursor += 1;
  } else if (isWord(tokens[cursor], 'one')) {
    countStart = cursor;
    countEnd = cursor + 1;
    cursor += 1;
  }

  let qualifierStart: number | undefined;
  let qualifier: 'worked' | 'practical' | 'technical' | undefined;
  const maybeQualifier = tokens[cursor]?.folded;
  if (
    maybeQualifier === 'worked' ||
    maybeQualifier === 'practical' ||
    maybeQualifier === 'technical'
  ) {
    qualifierStart = cursor;
    qualifier = maybeQualifier;
    cursor += 1;
  }

  const noun = tokens[cursor]?.folded;
  let action: ParsedAction['action'] | undefined;
  if (noun === 'example' || noun === 'examples') action = 'examples';
  else if (noun === 'terminology' || noun === 'terms') action = 'terminology';
  else if (noun === 'definition' || noun === 'definitions') action = 'definitions';
  else if (noun === 'steps') action = 'steps';
  if (!action) {
    if (countStart !== undefined || qualifier !== undefined || quantifierStart !== undefined) {
      return {
        ok: false,
        reason: sensitiveFailure(tokens, { start, end }, () => builder.checkpoint()),
      };
    }
    return null;
  }
  if (
    ((qualifier === 'worked' || qualifier === 'practical') && action !== 'examples') ||
    (qualifier === 'technical' && action !== 'terminology' && action !== 'definitions')
  ) {
    return { ok: false, reason: 'unsupported_topic' };
  }
  if (countStart !== undefined && action !== 'examples') {
    return { ok: false, reason: 'unsupported_topic' };
  }

  const actionStart = cursor;
  const actionEnd = cursor + 1;
  const actionNodeId = addActionNode(builder, actionStart, actionEnd, action);

  if (countStart !== undefined && countEnd !== undefined) {
    const countNodeId = nodeIdFor(builder, 'count', countStart, countEnd);
    builder.addNode({
      nodeId: countNodeId,
      kind: 'count',
      value: 1,
      mode,
      evidence: builder.evidence(countStart, countEnd),
    });
    builder.addEdge('counts', actionNodeId, countNodeId, countStart, countEnd);
  }

  if (qualifierStart !== undefined && qualifier !== undefined) {
    const qualifierNodeId = nodeIdFor(
      builder,
      'action_qualifier',
      qualifierStart,
      qualifierStart + 1,
    );
    builder.addNode({
      nodeId: qualifierNodeId,
      kind: 'action_qualifier',
      value: qualifier,
      targetNodeId: actionNodeId,
      evidence: builder.evidence(qualifierStart, qualifierStart + 1),
    });
    builder.addEdge('qualifies', actionNodeId, qualifierNodeId, qualifierStart, qualifierStart + 1);
  }

  if (quantifierStart !== undefined) {
    const quantifierNodeId = nodeIdFor(builder, 'quantifier', quantifierStart, quantifierStart + 1);
    builder.addNode({
      nodeId: quantifierNodeId,
      kind: 'quantifier',
      value: 'any',
      evidence: builder.evidence(quantifierStart, quantifierStart + 1),
    });
    builder.addEdge(
      'quantifies',
      actionNodeId,
      quantifierNodeId,
      quantifierStart,
      quantifierStart + 1,
    );
  }

  return { ok: true, nodeId: actionNodeId, action, next: actionEnd };
}

interface ParsedOrdering {
  readonly ok: true;
  readonly nodeId: string;
  readonly next: number;
  readonly relation: 'before' | 'followed_by' | 'first_then' | 'start_with_then';
  readonly left: ParsedAction;
  readonly right: ParsedAction;
}

type OrderingMatch = ParsedOrdering | ParseFailure | null;

function parseOrdering(
  tokens: Token[],
  start: number,
  end: number,
  builder: AstBuilder,
  allowRequestCondition: boolean,
): OrderingMatch {
  const savepoint = builder.savepoint();
  const left = parseAction(tokens, start, end, builder, false);
  if (!left) {
    builder.rollback(savepoint);
    return null;
  }
  if (!left.ok) return left;

  let cursor = left.next;
  let relation: ParsedOrdering['relation'];
  const connectorStart = cursor;
  let connectorEnd: number;
  let invert = false;
  let allowsAny = false;
  if (isWord(tokens[cursor], 'before')) {
    relation = 'before';
    connectorEnd = cursor + 1;
    allowsAny = true;
  } else if (sameTokens(tokens, cursor, ['ahead', 'of'])) {
    relation = 'before';
    connectorEnd = cursor + 2;
    allowsAny = true;
  } else if (sameTokens(tokens, cursor, ['followed', 'by'])) {
    relation = 'followed_by';
    connectorEnd = cursor + 2;
  } else if (isWord(tokens[cursor], 'after')) {
    relation = 'before';
    connectorEnd = cursor + 1;
    invert = true;
  } else if (
    isWord(tokens[cursor], 'first') &&
    isComma(tokens[cursor + 1]) &&
    isWord(tokens[cursor + 2], 'then')
  ) {
    relation = 'first_then';
    connectorEnd = cursor + 3;
  } else {
    builder.rollback(savepoint);
    return null;
  }

  const right = parseAction(tokens, connectorEnd, end, builder, allowsAny);
  if (!right) return { ok: false, reason: 'unsupported_grammar' };
  if (!right.ok) return right;
  cursor = right.next;

  if (isWord(tokens[cursor], 'on') && isWord(tokens[cursor + 1], 'request')) {
    if (!allowRequestCondition || relation !== 'first_then') {
      return { ok: false, reason: 'ambiguous_attachment' };
    }
    const conditionStart = cursor;
    const conditionEnd = cursor + 2;
    const conditionNodeId = nodeIdFor(builder, 'condition', conditionStart, conditionEnd);
    builder.addNode({
      nodeId: conditionNodeId,
      kind: 'condition',
      value: 'on_request',
      evidence: builder.evidence(conditionStart, conditionEnd),
    });
    builder.addEdge('conditions', right.nodeId, conditionNodeId, conditionStart, conditionEnd);
    cursor = conditionEnd;
  } else if (isWord(tokens[cursor], 'when') && isWord(tokens[cursor + 1], 'requested')) {
    if (!allowRequestCondition || relation !== 'first_then') {
      return { ok: false, reason: 'ambiguous_attachment' };
    }
    const conditionStart = cursor;
    const conditionEnd = cursor + 2;
    const conditionNodeId = nodeIdFor(builder, 'condition', conditionStart, conditionEnd);
    builder.addNode({
      nodeId: conditionNodeId,
      kind: 'condition',
      value: 'on_request',
      evidence: builder.evidence(conditionStart, conditionEnd),
    });
    builder.addEdge('conditions', right.nodeId, conditionNodeId, conditionStart, conditionEnd);
    cursor = conditionEnd;
  }

  if (cursor !== end) {
    if (isWord(tokens[cursor], 'on') || isWord(tokens[cursor], 'when')) {
      return { ok: false, reason: 'ambiguous_attachment' };
    }
    return {
      ok: false,
      reason: sensitiveFailure(tokens, { start: cursor, end }, () => builder.checkpoint()),
    };
  }
  const first = invert ? right : left;
  const second = invert ? left : right;
  const orderStart = connectorStart;
  const orderEnd = connectorEnd;
  const orderNodeId = nodeIdFor(builder, 'ordering', orderStart, orderEnd);
  builder.addNode({
    nodeId: orderNodeId,
    kind: 'ordering',
    relation,
    operandNodeIds: [first.nodeId, second.nodeId],
    evidence: builder.evidence(orderStart, orderEnd),
  });
  builder.addEdge('orders', orderNodeId, first.nodeId, orderStart, orderEnd, 'first');
  builder.addEdge('orders', orderNodeId, second.nodeId, orderStart, orderEnd, 'second');
  return { ok: true, nodeId: orderNodeId, next: cursor, relation, left, right };
}

interface OutputModifier {
  readonly kind: 'style' | 'length' | 'detail' | 'register';
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function parseOutputModifier(tokens: Token[], start: number, _end: number): OutputModifier | null {
  if (sameTokens(tokens, start, ['plain', 'language'])) {
    return { kind: 'style', value: 'plain_language', start, end: start + 2 };
  }
  const word = tokens[start]?.folded;
  if (word === 'concise' || word === 'brief' || word === 'short' || word === 'long') {
    return { kind: 'length', value: word, start, end: start + 1 };
  }
  if (word === 'detailed') return { kind: 'detail', value: 'detailed', start, end: start + 1 };
  if (word === 'high-level') return { kind: 'detail', value: 'high_level', start, end: start + 1 };
  if (word === 'formal' || word === 'informal') {
    return { kind: 'register', value: word, start, end: start + 1 };
  }
  return null;
}

function addOutputNode(
  builder: AstBuilder,
  start: number,
  end: number,
  value: 'explanation' | 'answer' | 'response',
): string {
  const nodeId = nodeIdFor(builder, 'output', start, end);
  builder.addNode({
    nodeId,
    kind: 'output',
    value,
    evidence: builder.evidence(start, end),
  });
  return nodeId;
}

function addOutputModifier(
  builder: AstBuilder,
  outputNodeId: string,
  modifier: OutputModifier,
): string {
  const nodeId = nodeIdFor(builder, modifier.kind, modifier.start, modifier.end);
  const evidence = builder.evidence(modifier.start, modifier.end);
  if (modifier.kind === 'style') {
    builder.addNode({ nodeId, kind: 'style', value: 'plain_language', evidence });
  } else if (modifier.kind === 'length') {
    builder.addNode({
      nodeId,
      kind: 'length',
      value: modifier.value as 'concise' | 'brief' | 'short' | 'long',
      evidence,
    });
  } else if (modifier.kind === 'detail') {
    builder.addNode({
      nodeId,
      kind: 'detail',
      value: modifier.value as 'detailed' | 'high_level',
      evidence,
    });
  } else {
    builder.addNode({
      nodeId,
      kind: 'register',
      value: modifier.value as 'formal' | 'informal',
      evidence,
    });
  }
  builder.addEdge('modifies', outputNodeId, nodeId, modifier.start, modifier.end);
  return nodeId;
}

function addPresentationNode(
  builder: AstBuilder,
  start: number,
  end: number,
  value: 'bullets' | 'numbered_steps' | 'prose' | 'table',
): string {
  const nodeId = nodeIdFor(builder, 'presentation', start, end);
  builder.addNode({
    nodeId,
    kind: 'presentation',
    value,
    evidence: builder.evidence(start, end),
  });
  return nodeId;
}

function addOutputOrdering(
  builder: AstBuilder,
  outputNodeId: string,
  ordering: ParsedOrdering,
  edgeStart: number,
  edgeEnd: number,
): void {
  builder.addEdge('has_ordering', outputNodeId, ordering.nodeId, edgeStart, edgeEnd);
}

function parseStartWithOrdering(
  tokens: Token[],
  start: number,
  end: number,
  builder: AstBuilder,
): ParsedOrdering | ParseFailure | null {
  let cursor = start;
  if (!isWord(tokens[cursor], 'that')) return null;
  cursor += 1;
  if (!isWord(tokens[cursor], 'start') && !isWord(tokens[cursor], 'starts')) return null;
  cursor += 1;
  if (!isWord(tokens[cursor], 'with')) return null;
  cursor += 1;
  const left = parseAction(tokens, cursor, end, builder, false);
  if (!left) return { ok: false, reason: 'unsupported_grammar' };
  if (!left.ok) return left;
  cursor = left.next;
  if (!isComma(tokens[cursor]) || !isWord(tokens[cursor + 1], 'then')) {
    return { ok: false, reason: 'unsupported_grammar' };
  }
  const orderingEvidenceStart = start;
  const orderingEvidenceEnd = cursor + 2;
  cursor += 2;
  const right = parseAction(tokens, cursor, end, builder, false);
  if (!right) return { ok: false, reason: 'unsupported_grammar' };
  if (!right.ok) return right;
  cursor = right.next;
  if (cursor !== end) {
    return {
      ok: false,
      reason: sensitiveFailure(tokens, { start: cursor, end }, () => builder.checkpoint()),
    };
  }
  const nodeId = nodeIdFor(builder, 'ordering', orderingEvidenceStart, orderingEvidenceEnd);
  builder.addNode({
    nodeId,
    kind: 'ordering',
    relation: 'start_with_then',
    operandNodeIds: [left.nodeId, right.nodeId],
    evidence: builder.evidence(orderingEvidenceStart, orderingEvidenceEnd),
  });
  builder.addEdge(
    'orders',
    nodeId,
    left.nodeId,
    orderingEvidenceStart,
    orderingEvidenceEnd,
    'first',
  );
  builder.addEdge(
    'orders',
    nodeId,
    right.nodeId,
    orderingEvidenceStart,
    orderingEvidenceEnd,
    'second',
  );
  return { ok: true, nodeId, next: cursor, relation: 'start_with_then', left, right };
}

function parseOutputTarget(
  tokens: Token[],
  start: number,
  end: number,
  builder: AstBuilder,
  languagePrefix?: ParsedLanguage,
): ParsedTarget | ParseFailure | null {
  const savepoint = builder.savepoint();
  let cursor = start;
  let modifier: OutputModifier | null = null;
  if (!languagePrefix) {
    modifier = parseOutputModifier(tokens, cursor, end);
    if (modifier) cursor = modifier.end;
  }
  const outputValue = OUTPUTS.get(tokens[cursor]?.folded ?? '');
  if (!outputValue) {
    builder.rollback(savepoint);
    return null;
  }
  const outputStart = cursor;
  const outputEnd = cursor + 1;
  const outputNodeId = addOutputNode(builder, outputStart, outputEnd, outputValue);
  const language = languagePrefix;
  if (language) {
    builder.addEdge(
      'language_of',
      outputNodeId,
      language.nodeId,
      language.languageStart,
      language.languageEnd,
    );
  }
  if (modifier) addOutputModifier(builder, outputNodeId, modifier);
  cursor = outputEnd;

  if (!language && isWord(tokens[cursor], 'in')) {
    const inIndex = cursor;
    const parsedLanguage = parseLanguagePhrase(tokens, cursor + 1, end, builder);
    if (!parsedLanguage) {
      return {
        ok: false,
        reason: sensitiveFailure(
          tokens,
          { start: cursor + 1, end },
          () => builder.checkpoint(),
          'unsupported_topic',
        ),
      };
    }
    builder.addEdge('language_of', outputNodeId, parsedLanguage.nodeId, inIndex, inIndex + 1);
    languagePrefix = parsedLanguage;
    cursor = parsedLanguage.next;
  }

  if (isComma(tokens[cursor]) && isWord(tokens[cursor + 1], 'with')) cursor += 1;
  if (isWord(tokens[cursor], 'with')) {
    const withIndex = cursor;
    if (!languagePrefix) return { ok: false, reason: 'unsupported_grammar' };
    if (modifier) return { ok: false, reason: 'unsupported_grammar' };
    const ordering = parseOrdering(tokens, cursor + 1, end, builder, false);
    if (!ordering) return { ok: false, reason: 'unsupported_grammar' };
    if (!ordering.ok) return ordering;
    addOutputOrdering(builder, outputNodeId, ordering, withIndex, withIndex + 1);
    cursor = ordering.next;
    return {
      ok: true,
      targetNodeId: outputNodeId,
      next: cursor,
      nodes: builder.nodes,
      attachments: builder.edges,
      orderingRelation: ordering.relation,
      hasOutputOrder: true,
      hasLanguage: true,
    };
  }

  if (isWord(tokens[cursor], 'that')) {
    if (modifier) return { ok: false, reason: 'unsupported_grammar' };
    const ordering = parseStartWithOrdering(tokens, cursor, end, builder);
    if (!ordering) return { ok: false, reason: 'unsupported_grammar' };
    if (!ordering.ok) return ordering;
    addOutputOrdering(builder, outputNodeId, ordering, cursor, cursor + 3);
    cursor = ordering.next;
    return {
      ok: true,
      targetNodeId: outputNodeId,
      next: cursor,
      nodes: builder.nodes,
      attachments: builder.edges,
      orderingRelation: 'start_with_then',
      hasOutputOrder: true,
      hasLanguage: languagePrefix !== undefined,
    };
  }

  if (cursor !== end) {
    return {
      ok: false,
      reason: sensitiveFailure(
        tokens,
        { start: cursor, end },
        () => builder.checkpoint(),
        'unsupported_topic',
      ),
    };
  }
  if (languagePrefix && modifier) return { ok: false, reason: 'unsupported_grammar' };
  return {
    ok: true,
    targetNodeId: outputNodeId,
    next: cursor,
    nodes: builder.nodes,
    attachments: builder.edges,
    hasOutputOrder: false,
    hasLanguage: languagePrefix !== undefined,
  };
}

function parsePresentationTarget(
  tokens: Token[],
  start: number,
  end: number,
  builder: AstBuilder,
): ParsedTarget | null {
  let value: 'bullets' | 'numbered_steps' | 'prose' | 'table' | undefined;
  let size = 1;
  if (sameTokens(tokens, start, ['bullet', 'points'])) {
    value = 'bullets';
    size = 2;
  } else if (sameTokens(tokens, start, ['numbered', 'steps'])) {
    value = 'numbered_steps';
    size = 2;
  } else {
    value = PRESENTATIONS.get(tokens[start]?.folded ?? '');
  }
  if (!value || start + size !== end) return null;
  const nodeId = addPresentationNode(builder, start, start + size, value);
  return {
    ok: true,
    targetNodeId: nodeId,
    next: end,
    nodes: builder.nodes,
    attachments: builder.edges,
    hasOutputOrder: false,
    hasLanguage: false,
  };
}

function parseTarget(
  tokens: Token[],
  start: number,
  end: number,
  builder: AstBuilder,
): ParsedTarget | ParseFailure {
  const ordering = parseOrdering(tokens, start, end, builder, true);
  if (ordering) {
    if (!ordering.ok) return ordering;
    return {
      ok: true,
      targetNodeId: ordering.nodeId,
      next: ordering.next,
      nodes: builder.nodes,
      attachments: builder.edges,
      orderingRelation: ordering.relation,
      hasOutputOrder: false,
      hasLanguage: false,
    };
  }

  const simpleActionSavepoint = builder.savepoint();
  const action = parseAction(tokens, start, end, builder, false);
  if (action) {
    if (!action.ok) return action;
    if (action.next === end) {
      return {
        ok: true,
        targetNodeId: action.nodeId,
        next: action.next,
        nodes: builder.nodes,
        attachments: builder.edges,
        hasOutputOrder: false,
        hasLanguage: false,
      };
    }
    builder.rollback(simpleActionSavepoint);
  }

  const languageSavepoint = builder.savepoint();
  const language = parseLanguagePhrase(tokens, start, end, builder);
  if (language) {
    if (language.next === end) {
      return {
        ok: true,
        targetNodeId: language.nodeId,
        next: language.next,
        nodes: builder.nodes,
        attachments: builder.edges,
        hasOutputOrder: false,
        hasLanguage: true,
      };
    }
    const output = parseOutputTarget(tokens, language.next, end, builder, language);
    if (output) {
      if (!output.ok) return output;
      return output;
    }
    builder.rollback(languageSavepoint);
  }

  const presentationSavepoint = builder.savepoint();
  const presentation = parsePresentationTarget(tokens, start, end, builder);
  if (presentation) return presentation;
  builder.rollback(presentationSavepoint);

  const output = parseOutputTarget(tokens, start, end, builder);
  if (output) {
    if (!output.ok) return output;
    return output;
  }
  return {
    ok: false,
    reason: sensitiveFailure(
      tokens,
      { start, end },
      () => builder.checkpoint(),
      'unsupported_topic',
    ),
  };
}

function parseTrailingScope(
  tokens: Token[],
  start: number,
  end: number,
  check?: () => void,
): { scope: ScopeMatch; forIndex: number } | null {
  for (let index = start + 1; index < end; index += 1) {
    check?.();
    if (!isWord(tokens[index], 'for')) continue;
    const scope = parseTaskScope(tokens, index + 1, end);
    if (scope && scope.next === end) return { scope, forIndex: index };
  }
  return null;
}

function parseRequestSuffix(
  tokens: Token[],
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (end - start >= 2 && isWord(tokens[end - 2], 'on') && isWord(tokens[end - 1], 'request')) {
    return { start: end - 2, end };
  }
  if (end - start >= 2 && isWord(tokens[end - 2], 'when') && isWord(tokens[end - 1], 'requested')) {
    return { start: end - 2, end };
  }
  return null;
}

function makeBundleId(sourceIdentity: string, tokens: Token[], range: TokenRange): string {
  const first = tokens[range.start];
  const last = tokens[range.end - 1];
  if (!first || !last) throw new Error('Bundle source range is empty');
  return `b_${sha256(`${sourceIdentity}\u0000bundle\u0000${first.start}:${last.end}`).slice(0, 32)}`;
}

function parsePredicate(
  content: string,
  tokens: Token[],
  range: TokenRange,
  rawOffset: number,
  sourceIdentity: string,
  check?: () => void,
  implicitSubject = false,
): PredicateParse {
  check?.();
  if (range.start >= range.end) return { ok: false, reason: 'unsupported_grammar' };
  const builder = new AstBuilder(content, tokens, rawOffset, sourceIdentity, check);
  let cursor = range.start;
  let prefixScope: ScopeMatch | undefined;
  let trailingScope: { scope: ScopeMatch; forIndex: number } | null = null;

  if (!implicitSubject && isWord(tokens[cursor], 'for')) {
    const scope = parseTaskScope(tokens, cursor + 1, range.end);
    if (!scope || !isComma(tokens[scope.next])) {
      return {
        ok: false,
        reason: containsSensitiveToken(tokens, range, check)
          ? 'sensitive_scope'
          : 'unsupported_scope',
      };
    }
    prefixScope = scope;
    cursor = scope.next + 1;
  }

  const sourceStart = range.start;
  const predicateStart = cursor;
  if (!implicitSubject) {
    if (!isWord(tokens[cursor], 'i')) return { ok: false, reason: 'unsupported_grammar' };
    cursor += 1;
  }

  let frequencyStart: number | undefined;
  if (isWord(tokens[cursor], 'usually')) {
    frequencyStart = cursor;
    cursor += 1;
  }

  let polarity: 'affirmed' | 'negated' = 'affirmed';
  let negation: 'none' | 'do_not' | 'dont' = 'none';
  if (sameTokens(tokens, cursor, ['do', 'not'])) {
    polarity = 'negated';
    negation = 'do_not';
    cursor += 2;
  } else if (isWord(tokens[cursor], "don't")) {
    polarity = 'negated';
    negation = 'dont';
    cursor += 1;
  }

  const operatorStart = cursor;
  const operatorText = tokens[cursor]?.folded;
  if (!operatorText || !OPERATORS.has(operatorText)) {
    return {
      ok: false,
      reason: operatorText === 'not' ? 'unsupported_operator' : 'unsupported_grammar',
    };
  }
  if (polarity === 'negated' && operatorText === 'dislike') {
    return { ok: false, reason: 'unsupported_operator' };
  }
  const operator = operatorText as 'prefer' | 'like' | 'dislike';
  const operatorEnd = cursor + 1;
  cursor = operatorEnd;

  trailingScope = prefixScope ? null : parseTrailingScope(tokens, cursor, range.end, check);
  const bodyEnd = trailingScope?.forIndex ?? range.end;
  const request = parseRequestSuffix(tokens, cursor, bodyEnd);
  let target: ParsedTarget | ParseFailure;
  let rootConditionRange: { start: number; end: number } | undefined;
  const targetSavepoint = builder.savepoint();
  target = parseTarget(tokens, cursor, bodyEnd, builder);
  if (!target.ok && request && !prefixScope) {
    builder.rollback(targetSavepoint);
    const coreEnd = request.start;
    const coreSavepoint = builder.savepoint();
    const coreTarget = parseTarget(tokens, cursor, coreEnd, builder);
    if (!coreTarget.ok) return coreTarget;
    const coreNode = builder.nodes.find((node) => node.nodeId === coreTarget.targetNodeId);
    if (
      coreTarget.orderingRelation !== undefined ||
      coreNode?.kind === 'action' ||
      coreNode?.kind === 'ordering'
    ) {
      builder.rollback(coreSavepoint);
      return { ok: false, reason: 'ambiguous_attachment' };
    }
    target = coreTarget;
    rootConditionRange = request;
  }
  if (!target.ok) return target;

  if (trailingScope && (rootConditionRange || prefixScope)) {
    return { ok: false, reason: 'ambiguous_attachment' };
  }
  if (trailingScope && (target.hasOutputOrder || target.orderingRelation !== undefined)) {
    return { ok: false, reason: 'ambiguous_attachment' };
  }

  let frequencyNodeId: string | undefined;
  if (frequencyStart !== undefined) {
    frequencyNodeId = nodeIdFor(builder, 'frequency', frequencyStart, frequencyStart + 1);
    builder.addNode({
      nodeId: frequencyNodeId,
      kind: 'frequency',
      value: 'usually',
      evidence: builder.evidence(frequencyStart, frequencyStart + 1),
    });
  }

  let conditionNodeId: string | undefined;
  let conditionRange: { start: number; end: number } | undefined;
  if (rootConditionRange) {
    conditionRange = rootConditionRange;
    conditionNodeId = nodeIdFor(builder, 'condition', conditionRange.start, conditionRange.end);
    builder.addNode({
      nodeId: conditionNodeId,
      kind: 'condition',
      value: 'on_request',
      evidence: builder.evidence(conditionRange.start, conditionRange.end),
    });
  }

  const scope = prefixScope ?? trailingScope?.scope;
  let scopeNodeId: string | undefined;
  if (scope) scopeNodeId = createTaskScope(builder, scope).nodeId;

  const preferenceId = nodeIdFor(builder, 'preference', predicateStart, operatorEnd);
  const preferenceEvidenceStart = implicitSubject ? operatorStart : predicateStart;
  const preferenceEvidence = builder.evidence(preferenceEvidenceStart, operatorEnd);
  const attachmentNodeIds: string[] = [];
  if (frequencyNodeId) attachmentNodeIds.push(frequencyNodeId);
  if (conditionNodeId) attachmentNodeIds.push(conditionNodeId);
  if (scopeNodeId) attachmentNodeIds.push(scopeNodeId);
  builder.addNode({
    nodeId: preferenceId,
    kind: 'preference',
    subject: 'speaker',
    operator,
    polarity,
    negation,
    targetNodeId: target.targetNodeId,
    attachmentNodeIds,
    evidence: preferenceEvidence,
  });
  builder.addEdge('targets', preferenceId, target.targetNodeId, operatorStart, operatorEnd);
  if (frequencyNodeId && frequencyStart !== undefined) {
    builder.addEdge('frequency', preferenceId, frequencyNodeId, frequencyStart, frequencyStart + 1);
  }
  if (conditionNodeId && conditionRange) {
    builder.addEdge(
      'conditions',
      preferenceId,
      conditionNodeId,
      conditionRange.start,
      conditionRange.end,
    );
  }
  if (scopeNodeId && scope) {
    const scopeEdgeStart = prefixScope ? sourceStart : (trailingScope?.forIndex ?? scope.start);
    builder.addEdge('scopes', preferenceId, scopeNodeId, scopeEdgeStart, scope.end);
  }

  const bundle = {
    bundleId: makeBundleId(sourceIdentity, tokens, range),
    relation: 'single' as const,
    coupling:
      target.orderingRelation === undefined ? ('independent' as const) : ('coupled' as const),
    rootNodeIds: [preferenceId],
    members: builder.nodes,
    attachments: builder.edges,
    evidence: builder.evidence(sourceStart, range.end),
    coverage: 'complete' as const,
  };
  return { ok: true, bundle };
}

interface PredicateSplit {
  readonly kind: 'independent' | 'shared';
  readonly ranges: TokenRange[];
  readonly separatorIndices: number[];
  readonly implicitSubject: boolean[];
}

function splitConjunction(
  tokens: Token[],
  range: TokenRange,
  check?: () => void,
): PredicateSplit | null | ParseFailure {
  const andIndices: number[] = [];
  let excessiveConjunctions = false;
  for (let index = range.start; index < range.end; index += 1) {
    check?.();
    if (isWord(tokens[index], 'and')) {
      if (andIndices.length >= 33) excessiveConjunctions = true;
      else andIndices.push(index);
    }
  }
  if (excessiveConjunctions) return { ok: false, reason: 'too_many_bundles' };
  if (andIndices.length === 0) return null;

  const repeatedIndices: number[] = [];
  const sharedIndices: number[] = [];
  for (const index of andIndices) {
    check?.();
    const next = index + 1;
    if (isWord(tokens[next], 'i')) repeatedIndices.push(index);
    else if (OPERATORS.has(tokens[next]?.folded ?? '')) sharedIndices.push(index);
    else return { ok: false, reason: 'mixed_clauses' };
  }

  if (sharedIndices.length > 0) {
    if (sharedIndices.length !== 1 || repeatedIndices.length > 0) {
      return { ok: false, reason: 'mixed_clauses' };
    }
    const andIndex = sharedIndices[0];
    const commaIndex = isComma(tokens[andIndex - 1]) ? andIndex - 1 : andIndex;
    return {
      kind: 'shared',
      ranges: [
        { start: range.start, end: commaIndex },
        { start: andIndex + 1, end: range.end },
      ],
      separatorIndices: [andIndex],
      implicitSubject: [false, true],
    };
  }

  if (repeatedIndices.length >= 32) {
    return { ok: false, reason: 'too_many_bundles' };
  }

  const ranges: TokenRange[] = [];
  const separatorIndices: number[] = [];
  let cursor = range.start;
  for (const andIndex of repeatedIndices) {
    check?.();
    const commaIndex = isComma(tokens[andIndex - 1]) ? andIndex - 1 : andIndex;
    ranges.push({ start: cursor, end: commaIndex });
    separatorIndices.push(andIndex);
    cursor = andIndex + 1;
  }
  ranges.push({ start: cursor, end: range.end });
  if (ranges.some((item) => item.start >= item.end)) return { ok: false, reason: 'mixed_clauses' };
  return {
    kind: 'independent',
    ranges,
    separatorIndices,
    implicitSubject: ranges.map(() => false),
  };
}

function combineSharedPredicates(
  content: string,
  tokens: Token[],
  fullRange: TokenRange,
  first: CompositionalPreferenceBundle,
  second: CompositionalPreferenceBundle,
  andIndex: number,
  rawOffset: number,
  sourceIdentity: string,
  check?: () => void,
): CompositionalPreferenceBundle {
  check?.();
  const firstRoot = first.rootNodeIds[0];
  const secondRoot = second.rootNodeIds[0];
  if (!firstRoot || !secondRoot) throw new Error('Conjunction requires explicit predicate roots');
  const edgeBuilder = new AstBuilder(content, tokens, rawOffset, sourceIdentity, check);
  edgeBuilder.addEdge('all_of', firstRoot, secondRoot, andIndex, andIndex + 1);
  const nodes = [...first.members, ...second.members];
  const edges = [...first.attachments, ...second.attachments, ...edgeBuilder.edges];
  return {
    bundleId: makeBundleId(sourceIdentity, tokens, fullRange),
    relation: 'allOf',
    coupling: 'coupled',
    rootNodeIds: [firstRoot, secondRoot],
    members: nodes,
    attachments: edges,
    evidence: edgeBuilder.evidence(fullRange.start, fullRange.end),
    coverage: 'complete',
  };
}

function parseSentenceWork(
  content: string,
  tokens: Token[],
  range: SentenceRange,
  rawOffset: number,
  sourceIdentity: string,
  check?: () => void,
): WorkItem[] {
  check?.();
  const split = splitConjunction(tokens, range, check);
  if (split && 'ok' in split) {
    return [
      {
        disposition: 'withheld',
        region: regionFor(tokens, range),
        reason: split.reason,
      },
    ];
  }
  if (!split) {
    const parsed = parsePredicate(content, tokens, range, rawOffset, sourceIdentity, check);
    return parsed.ok
      ? [{ disposition: 'complete', bundle: parsed.bundle }]
      : [{ disposition: 'withheld', region: regionFor(tokens, range), reason: parsed.reason }];
  }

  if (split.kind === 'independent') {
    const items: WorkItem[] = [];
    for (let index = 0; index < split.ranges.length; index += 1) {
      check?.();
      const predicateRange = split.ranges[index];
      const parsed = parsePredicate(
        content,
        tokens,
        predicateRange,
        rawOffset,
        sourceIdentity,
        check,
        split.implicitSubject[index],
      );
      items.push(
        parsed.ok
          ? { disposition: 'complete', bundle: parsed.bundle }
          : {
              disposition: 'withheld',
              region: regionFor(tokens, predicateRange),
              reason: parsed.reason,
            },
      );
    }
    return items;
  }

  const firstRange = split.ranges[0];
  const secondRange = split.ranges[1];
  const andIndex = split.separatorIndices[0];
  if (!firstRange || !secondRange || andIndex === undefined) {
    return [
      {
        disposition: 'withheld',
        region: regionFor(tokens, range),
        reason: 'mixed_clauses',
      },
    ];
  }
  const first = parsePredicate(content, tokens, firstRange, rawOffset, sourceIdentity, check);
  const second = parsePredicate(
    content,
    tokens,
    secondRange,
    rawOffset,
    sourceIdentity,
    check,
    true,
  );
  if (!first.ok || !second.ok) {
    return [
      {
        disposition: 'withheld',
        region: regionFor(tokens, range),
        reason: !first.ok ? first.reason : !second.ok ? second.reason : 'mixed_clauses',
      },
    ];
  }
  const bundle = combineSharedPredicates(
    content,
    tokens,
    range,
    first.bundle,
    second.bundle,
    andIndex,
    rawOffset,
    sourceIdentity,
    check,
  );
  return [{ disposition: 'complete', bundle }];
}

function capacityFailure(reason: CompositionalPreferenceReason): CompositionalPreference {
  return makeEmptyResult('unknown', [reason]);
}

/**
 * Builds the reviewed, bounded compositional AST from a complete mapped source.
 * A successful AST is syntactic output only; it does not prove entailment or
 * grant acceptance authority. Unsupported text is represented by fixed reason
 * codes and source offsets only.
 */
export function interpretCompositionalPreferences(
  input: CompositionalPreferenceInterpretationInput,
): CompositionalPreference {
  const rawCheck = (input as { check?: unknown } | null)?.check;
  if (typeof rawCheck === 'function') rawCheck();

  const descriptorValue = (input as { descriptor?: unknown } | null)?.descriptor;
  const descriptor = CompositionalPreferenceDescriptorSchema.safeParse(descriptorValue);
  if (!descriptor.success || JSON.stringify(descriptor.data) !== EXPECTED_DESCRIPTOR) {
    return makeEmptyResult('unknown', ['unsupported_grammar']);
  }

  const inputShape = CompositionalPreferenceInterpretationInputSchema.safeParse(input);
  if (!inputShape.success) return makeEmptyResult('unknown', ['invalid_envelope']);
  const supplied = inputShape.data;
  supplied.check?.();

  let envelopeSnapshot: unknown;
  try {
    envelopeSnapshot = snapshotBoundedCompositionalJson(supplied.envelope, 16384);
  } catch {
    envelopeSnapshot = undefined;
  }
  if (envelopeSnapshot === undefined) return makeEmptyResult('unknown', ['invalid_envelope']);
  supplied.check?.();

  const emptySourceResult = {
    version: 1 as const,
    descriptor: { ...COMPOSITIONAL_PREFERENCE_DESCRIPTOR },
    coverage: 'none' as const,
    bundles: [],
    withheld: [],
    reasons: [],
  };
  const sourceValidation = validateCompositionalPreferenceEvidence({
    preference: emptySourceResult,
    rawContent: supplied.rawContent,
    mappedContent: supplied.mappedContent,
    envelope: envelopeSnapshot,
  });
  if (!sourceValidation.ok) return makeEmptyResult('unknown', [sourceValidation.reason]);
  const envelope = AutomaticSourceEnvelopeSchema.safeParse(envelopeSnapshot);
  if (!envelope.success) return makeEmptyResult('unknown', ['invalid_envelope']);

  const sourceIdentity = sha256(
    `${envelope.data.rawContentHash}\u0000${envelope.data.contentHash}\u0000${EXPECTED_DESCRIPTOR}`,
  );
  const tokens = lex(supplied.mappedContent, supplied.check);
  let quoteTokens = 0;
  for (const token of tokens) {
    supplied.check?.();
    // Match the envelope's 32-region budget before constructing lexical quote
    // masks, which otherwise make later per-token range checks quadratic.
    if (token.kind === 'quote' && ++quoteTokens > 64) {
      return makeEmptyResult('unknown', ['quoted_content']);
    }
  }
  if (!hasWellFormedQuoteSyntax(tokens, supplied.check)) {
    return makeEmptyResult('unknown', ['quoted_content']);
  }
  const textQuotes = textQuoteMask(tokens, supplied.mappedContent.length, supplied.check);
  const explicitQuotes = envelope.data.quoteRegions.map((region) => {
    supplied.check?.();
    return { ...region };
  });
  const allQuotes = [...textQuotes, ...explicitQuotes];
  const sentences = segmentSentences(tokens, supplied.check, allQuotes);
  const malformedTerminal = sentences.find(
    (sentence) => sentence.start === sentence.end || (sentence.terminal?.length ?? 0) > 1,
  );
  if (malformedTerminal) {
    return makeEmptyResult('unknown', [
      malformedTerminal.terminal?.includes('?') ? 'question' : 'unsupported_grammar',
    ]);
  }

  // Semicolons are not a reviewed sentence boundary for this grammar. A
  // semicolon can connect a preference to framing text, so keep the whole
  // mapped source out of the AST.
  for (const token of tokens) {
    supplied.check?.();
    if (
      token.raw === ';' &&
      !isOffsetQuoted(token.start, textQuotes, explicitQuotes, supplied.check)
    ) {
      return makeEmptyResult('unknown', ['mixed_clauses']);
    }
  }

  const sentenceAnalyses: SentenceAnalysis[] = [];
  let directCandidateCount = 0;
  let potentialCandidateCount = 0;
  let frameReason: CompositionalPreferenceReason | undefined;
  let retroactiveFrame = false;
  let unownedSentence = false;

  for (const sentence of sentences) {
    supplied.check?.();
    if (sentence.start >= sentence.end) continue;
    const firstToken = tokens[sentence.start];
    const lastToken = tokens[sentence.end - 1];
    if (!firstToken || !lastToken) continue;
    const sentenceEnd = sentence.terminalEnd ?? lastToken.end;
    if (
      Buffer.byteLength(supplied.mappedContent.slice(firstToken.start, sentenceEnd), 'utf8') > 4096
    ) {
      return makeEmptyResult('unknown', ['clause_too_long']);
    }

    const quoted = isQuoted(tokens, sentence, textQuotes, explicitQuotes, supplied.check);
    const potentialStart = findPotentialSpeakerPreferenceStart(tokens, sentence, supplied.check);
    const potentialUnquoted =
      potentialStart !== null &&
      !isOffsetQuoted(
        tokens[potentialStart]?.start ?? -1,
        textQuotes,
        explicitQuotes,
        supplied.check,
      );
    if (potentialUnquoted) potentialCandidateCount += 1;
    const context = contextReason(tokens, sentence, quoted, supplied.check);
    const hasRetroactiveFrame = isRetroactiveContext(tokens, sentence, supplied.check);
    retroactiveFrame ||= hasRetroactiveFrame;
    if (context && context !== 'question' && context !== 'quoted_content') frameReason ??= context;

    const beginsDirect =
      !quoted && context === null && beginsExplicitPreferenceUnit(tokens, sentence, supplied.check);
    if (beginsDirect) directCandidateCount += 1;
    if (!beginsDirect) unownedSentence = true;

    const candidateStart = potentialUnquoted ? potentialStart : null;
    sentenceAnalyses.push({
      sentence,
      context,
      candidateStart,
    });
  }

  if (directCandidateCount > 32 || potentialCandidateCount > 32) {
    return makeEmptyResult('unknown', ['too_many_bundles']);
  }

  if (directCandidateCount === 0) {
    if (potentialCandidateCount > 0) {
      const questionOnly = sentenceAnalyses
        .filter((analysis) => analysis.candidateStart !== null)
        .every((analysis) => analysis.context === 'question');
      if (!questionOnly || frameReason || retroactiveFrame) {
        return makeEmptyResult('unknown', [
          frameReason ?? (retroactiveFrame ? 'hypothetical' : 'unsupported_grammar'),
        ]);
      }
    }
    const contextReasons = sentenceAnalyses
      .map((analysis) => analysis.context)
      .filter((reason): reason is CompositionalPreferenceReason => reason !== null);
    return makeEmptyResult('none', contextReasons);
  }

  // Every nonempty source unit must be an independently complete, reviewed
  // first-person preference. This deliberately withholds candidate sets with
  // dangling report/hypothesis frames, retroactive qualifiers, unknown text,
  // or a sibling that cannot be parsed in full.
  if (
    frameReason ||
    retroactiveFrame ||
    unownedSentence ||
    potentialCandidateCount !== directCandidateCount
  ) {
    return makeEmptyResult('unknown', [
      frameReason ?? (retroactiveFrame ? 'hypothetical' : 'unsupported_grammar'),
    ]);
  }

  const bundles: CompositionalPreferenceBundle[] = [];
  const reasons = new Set<CompositionalPreferenceReason>();
  let semanticNodeCount = 0;
  let preferenceCount = 0;
  let edgeCount = 0;

  for (const analysis of sentenceAnalyses) {
    supplied.check?.();
    const sentenceWork = parseSentenceWork(
      supplied.mappedContent,
      tokens,
      analysis.sentence,
      envelope.data.mappings[0].rawStart,
      sourceIdentity,
      supplied.check,
    );
    if (sentenceWork.some((item) => item.disposition !== 'complete' || !item.bundle)) {
      const reason = sentenceWork.find((item) => item.reason)?.reason ?? 'unsupported_grammar';
      return makeEmptyResult('unknown', [reason]);
    }
    for (const item of sentenceWork) {
      supplied.check?.();
      if (!item.bundle) return makeEmptyResult('unknown', ['invalid_ast_integrity']);
      if (bundles.length >= 32) return capacityFailure('too_many_bundles');
      let bundlePreferences = 0;
      for (const node of item.bundle.members) {
        supplied.check?.();
        if (node.kind === 'preference') bundlePreferences += 1;
      }
      semanticNodeCount += item.bundle.members.length;
      preferenceCount += bundlePreferences;
      edgeCount += item.bundle.attachments.length;
      if (semanticNodeCount > 128 || preferenceCount > 32 || edgeCount > 128) {
        return capacityFailure('too_many_nodes');
      }
      bundles.push(item.bundle);
    }
  }
  if (bundles.length === 0) return makeEmptyResult('none', [...reasons]);

  const result = makeResult('complete', bundles, [], [...reasons]);
  const evidenceValidation = validateCompositionalPreferenceEvidence({
    preference: result,
    rawContent: supplied.rawContent,
    mappedContent: supplied.mappedContent,
    envelope: envelopeSnapshot,
  });
  if (!evidenceValidation.ok) return makeEmptyResult('unknown', [evidenceValidation.reason]);
  return result;
}
