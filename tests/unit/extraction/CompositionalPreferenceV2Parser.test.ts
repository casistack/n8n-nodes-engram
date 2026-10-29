import { createHash } from 'crypto';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  type CompositionalPreferenceV2,
  type CompositionalPreferenceV2Node,
} from '../../../src/schemas/CompositionalPreferenceV2.schema';
import type { CompositionalPreferenceV2InterpretationInput } from '../../../src/schemas/CompositionalPreferenceV2Meaning.schema';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';
import {
  compileAutomaticPolicy,
  parseAutomaticPreferences,
} from '../../../src/extraction/AutomaticEvidence';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const BINDING_ID = '22222222-2222-4222-8222-222222222222';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeInput(
  mappedContent: string,
  options: {
    rawContent?: string;
    rawStart?: number;
    quoteRegions?: Array<{ start: number; end: number }>;
    check?: () => void;
  } = {},
): CompositionalPreferenceV2InterpretationInput {
  const rawContent = options.rawContent ?? mappedContent;
  const rawStart = options.rawStart ?? 0;
  const rawEnd = rawStart + mappedContent.length;
  const envelope = {
    version: 1 as const,
    namespace: 'tenant-test',
    issuer: 'test-adapter',
    actorReference: 'actor-1',
    bindingRef: {
      bindingId: BINDING_ID,
      revision: 1,
      subjectId: SUBJECT_ID,
      fingerprint: 'a'.repeat(64),
    },
    contentHash: sha256(mappedContent),
    rawContentHash: sha256(rawContent),
    mappingAuthority:
      rawContent === mappedContent ? ('whole_source' as const) : ('application_region' as const),
    humanRegion: { start: rawStart, end: rawEnd },
    mappings: [{ contentStart: 0, contentEnd: mappedContent.length, rawStart, rawEnd }],
    quoteRegions: options.quoteRegions ?? [],
    explicitIntent: false,
  };
  return {
    descriptor: { ...COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR },
    rawContent,
    mappedContent,
    envelope,
    ...(options.check === undefined ? {} : { check: options.check }),
  };
}

function interpret(
  source: string,
  options?: Parameters<typeof makeInput>[1],
): CompositionalPreferenceV2 {
  return interpretCompositionalPreferencesV2(makeInput(source, options));
}

const literalV1Policy = compileAutomaticPolicy({ profileId: 'conservative' });

function literalV1ClaimCount(source: string): number {
  const input = makeInput(source);
  const envelope = { ...(input.envelope as Record<string, unknown>), policy: literalV1Policy };
  return parseAutomaticPreferences(envelope as never, source).claims.length;
}

function nodeOfKind<K extends CompositionalPreferenceV2Node['kind']>(
  result: CompositionalPreferenceV2,
  kind: K,
): Array<Extract<CompositionalPreferenceV2Node, { kind: K }>> {
  return result.bundles
    .flatMap((bundle) => bundle.members)
    .filter(
      (node): node is Extract<CompositionalPreferenceV2Node, { kind: K }> => node.kind === kind,
    );
}

describe('interpretCompositionalPreferencesV2', () => {
  it('bounds quote-range scans before constructing an oversized lexical quote mask', () => {
    const originalSome = Array.prototype.some;
    let maximumScan = 0;
    const scan = jest.spyOn(Array.prototype, 'some').mockImplementation(function (
      this: unknown[],
      predicate,
      thisArg,
    ) {
      maximumScan = Math.max(maximumScan, this.length);
      return originalSome.call(this, predicate, thisArg);
    });
    let result: CompositionalPreferenceV2;
    try {
      result = interpret('"'.repeat(320));
    } finally {
      scan.mockRestore();
    }
    expect(result!.bundles).toHaveLength(0);
    expect(result!.reasons).toContain('quoted_content');
    expect(maximumScan).toBeLessThanOrEqual(64);
  });

  it.each([
    'I prefer French...?',
    'I prefer French.!?',
    'I prefer French..',
    'I prefer French. ?',
    'I prefer French!!',
    '? I prefer French.',
    '. I prefer French.',
    '! I prefer French.',
    '... I prefer French.',
    'I prefer French. ? I like tables.',
    'I prefer French! . I like tables.',
  ])('withholds terminal runs and orphan punctuation without discarding tokens: %s', (source) => {
    const result = interpret(source);
    expect(result.coverage).toBe('unknown');
    expect(result.bundles).toHaveLength(0);
  });

  it('parses the held-out G18 composition with exact evidence for each semantic slot', () => {
    const source =
      'I like responses in plain Australian English, with one worked example ahead of any technical terms.';
    const result = interpret(source);

    expect(result.coverage).toBe('complete');
    expect(result.bundles).toHaveLength(1);
    const bundle = result.bundles[0]!;
    expect(bundle.relation).toBe('single');
    expect(bundle.coupling).toBe('coupled');
    expect(bundle.members).toHaveLength(11);
    expect(bundle.attachments).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(bundle), 'utf8')).toBeLessThanOrEqual(32 * 1024);
    const outgoing = new Map<string, string[]>();
    for (const member of bundle.members) outgoing.set(member.nodeId, []);
    for (const edge of bundle.attachments) {
      outgoing.get(edge.ownerNodeId)?.push(edge.targetNodeId);
    }
    const pending = bundle.rootNodeIds.map((nodeId) => ({ nodeId, depth: 1 }));
    let maximumDepth = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const current = pending[index]!;
      maximumDepth = Math.max(maximumDepth, current.depth);
      for (const nodeId of outgoing.get(current.nodeId) ?? []) {
        pending.push({ nodeId, depth: current.depth + 1 });
      }
    }
    expect(maximumDepth).toBe(5);
    expect(bundle.members.map((node) => node.kind)).toEqual(
      expect.arrayContaining([
        'preference',
        'output',
        'language',
        'language_use',
        'count',
        'action',
        'ordering',
        'quantifier',
        'action_qualifier',
      ]),
    );
    expect(nodeOfKind(result, 'preference')[0]).toMatchObject({
      operator: 'like',
      polarity: 'affirmed',
    });
    expect(nodeOfKind(result, 'language')[0]).toMatchObject({
      base: 'English',
      region: 'Australian',
      languageTag: 'en-AU',
    });
    expect(nodeOfKind(result, 'language_use')[0]).toMatchObject({ value: 'plain' });
    expect(nodeOfKind(result, 'count')[0]).toMatchObject({ value: 1, mode: 'as_stated' });
    expect(nodeOfKind(result, 'action_qualifier').map((node) => node.value)).toEqual(
      expect.arrayContaining(['worked', 'technical']),
    );
    expect(nodeOfKind(result, 'quantifier')[0]).toMatchObject({ value: 'any' });
    expect(bundle.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'language_of' }),
        expect.objectContaining({ relation: 'has_ordering' }),
        expect.objectContaining({ relation: 'orders', position: 'first' }),
        expect.objectContaining({ relation: 'orders', position: 'second' }),
        expect.objectContaining({ relation: 'quantifies' }),
        expect.objectContaining({ relation: 'qualifies' }),
      ]),
    );
    for (const evidence of [
      bundle.evidence,
      ...bundle.members.map((node) => node.evidence),
      ...bundle.attachments.map((edge) => edge.evidence),
    ]) {
      expect(evidence.descriptor).toEqual(COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR);
      expect(evidence.spans).toHaveLength(1);
      const span = evidence.spans[0]!;
      expect(source.slice(span.content.start, span.content.end)).toBe(evidence.lexicalForm);
      expect(source.slice(span.raw.start, span.raw.end)).toBe(evidence.lexicalForm);
    }
  });

  it('composes a second held-out task, language-use, count, and action-qualifier bundle', () => {
    const result = interpret(
      'For summaries, I prefer answers in plain Canadian French with one practical example before any technical definitions.',
    );
    expect(result.coverage).toBe('complete');
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]).toMatchObject({ relation: 'single', coupling: 'coupled' });
    expect(nodeOfKind(result, 'task_scope')[0]).toMatchObject({ value: 'summary' });
    expect(nodeOfKind(result, 'output')[0]).toMatchObject({ value: 'answer' });
    expect(nodeOfKind(result, 'language')[0]).toMatchObject({
      base: 'French',
      region: 'Canadian',
      languageTag: 'fr-CA',
    });
    expect(nodeOfKind(result, 'count')[0]).toMatchObject({ mode: 'as_stated' });
    expect(nodeOfKind(result, 'action_qualifier').map((node) => node.value)).toEqual(
      expect.arrayContaining(['practical', 'technical']),
    );
  });

  it.each([
    ['I prefer Canadian French.', 'prefer', 'affirmed', 'fr-CA'],
    ['I prefer Kenyan Swahili.', 'prefer', 'affirmed', 'sw-KE'],
    ['I prefer British English.', 'prefer', 'affirmed', 'en-GB'],
    ['I like American English.', 'like', 'affirmed', 'en-US'],
    ['I prefer English (Australian).', 'prefer', 'affirmed', 'en-AU'],
    ['I like Spanish.', 'like', 'affirmed', 'es'],
    ['I like French.', 'like', 'affirmed', 'fr'],
    ["I don't prefer French.", 'prefer', 'negated', 'fr'],
    ["I don't like French.", 'like', 'negated', 'fr'],
    ['I do not like concise explanations.', 'like', 'negated', undefined],
    ['I dislike concise explanations.', 'dislike', 'affirmed', undefined],
  ])(
    'preserves the operator, negation, and explicit language for %s',
    (source, operator, polarity, tag) => {
      const result = interpret(source);
      expect(result.coverage).toBe('complete');
      expect(nodeOfKind(result, 'preference')[0]).toMatchObject({ operator, polarity });
      if (tag) expect(nodeOfKind(result, 'language')[0]).toMatchObject({ languageTag: tag });
    },
  );

  it.each([
    ['I prefer plain language explanations.', 'style', 'plain_language'],
    ['I prefer concise explanations.', 'length', 'concise'],
    ['I prefer brief explanations.', 'length', 'brief'],
    ['I prefer short explanations.', 'length', 'short'],
    ['I prefer long explanations.', 'length', 'long'],
    ['I like detailed explanations.', 'detail', 'detailed'],
    ['I like high-level answers.', 'detail', 'high_level'],
    ['I prefer formal responses.', 'register', 'formal'],
    ['I like informal explanations.', 'register', 'informal'],
    ['I prefer bullet points.', 'presentation', 'bullets'],
    ['I prefer numbered steps.', 'presentation', 'numbered_steps'],
    ['I like prose.', 'presentation', 'prose'],
    ['I prefer tables.', 'presentation', 'table'],
  ])('recognizes the reviewed target or single output modifier in %s', (source, kind, value) => {
    const result = interpret(source);
    expect(result.coverage).toBe('complete');
    expect(nodeOfKind(result, kind as CompositionalPreferenceV2Node['kind'])[0]).toMatchObject({
      value,
    });
  });

  it.each([
    ['I prefer one worked example.', 'as_stated', 'worked'],
    ['I prefer only one worked example.', 'only', 'worked'],
    ['I prefer exactly one practical example.', 'exactly', 'practical'],
  ])('preserves count mode and action qualifier in %s', (source, mode, qualifier) => {
    const result = interpret(source);
    expect(result.coverage).toBe('complete');
    expect(nodeOfKind(result, 'count')[0]).toMatchObject({ value: 1, mode });
    expect(nodeOfKind(result, 'action_qualifier')[0]).toMatchObject({ value: qualifier });
  });

  it.each([
    ['I prefer examples before definitions.', 'before', ['examples', 'definitions']],
    ['I prefer examples ahead of definitions.', 'before', ['examples', 'definitions']],
    ['I prefer definitions after examples.', 'before', ['examples', 'definitions']],
    ['I prefer examples followed by definitions.', 'followed_by', ['examples', 'definitions']],
    [
      'I prefer examples first, then definitions on request.',
      'first_then',
      ['examples', 'definitions'],
    ],
    [
      'I prefer explanations that start with definitions, then examples.',
      'start_with_then',
      ['definitions', 'examples'],
    ],
  ])('parses the directed ordering in %s', (source, relation, operandValues) => {
    const result = interpret(source);
    expect(result.coverage).toBe('complete');
    const bundle = result.bundles[0]!;
    const ordering = nodeOfKind(result, 'ordering')[0];
    expect(ordering).toMatchObject({ relation });
    const operandIds = (ordering as { operandNodeIds: string[] }).operandNodeIds;
    const actions = nodeOfKind(result, 'action');
    expect(operandIds.map((id) => actions.find((node) => node.nodeId === id)?.value)).toEqual(
      operandValues,
    );
    expect(bundle.coupling).toBe('coupled');
  });

  it('attaches any only to the right before operand and keeps its technical qualifier', () => {
    const result = interpret('I prefer examples before any technical terms.');
    expect(result.coverage).toBe('complete');
    const bundle = result.bundles[0]!;
    const order = nodeOfKind(result, 'ordering')[0] as { operandNodeIds: string[] };
    const secondAction = nodeOfKind(result, 'action').find(
      (node) => node.nodeId === order.operandNodeIds[1],
    );
    expect(secondAction).toMatchObject({ value: 'terminology' });
    expect(bundle.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'quantifies', ownerNodeId: secondAction?.nodeId }),
        expect.objectContaining({ relation: 'qualifies', ownerNodeId: secondAction?.nodeId }),
      ]),
    );
  });

  it('supports finite task scopes, frequency, and direct request conditions', () => {
    const scoped = interpret('For code reviews, I usually prefer concise explanations.');
    expect(scoped.coverage).toBe('complete');
    expect(nodeOfKind(scoped, 'task_scope')[0]).toMatchObject({ value: 'code_review' });
    expect(nodeOfKind(scoped, 'frequency')[0]).toMatchObject({ value: 'usually' });

    const requested = interpret('I prefer detailed explanations when requested.');
    expect(requested.coverage).toBe('complete');
    expect(nodeOfKind(requested, 'condition')[0]).toMatchObject({ value: 'on_request' });

    for (const [source, scope] of [
      ['For summaries, I prefer concise answers.', 'summary'],
      ['For planning, I like tables.', 'planning'],
      ['I prefer concise explanations for worked calculations.', 'worked_calculation'],
    ]) {
      const scopedResult = interpret(source);
      expect(scopedResult.coverage).toBe('complete');
      expect(nodeOfKind(scopedResult, 'task_scope')[0]).toMatchObject({ value: scope });
    }
  });

  it('keeps repeated-subject children independent and shared-subject ellipsis coupled', () => {
    const repeated = interpret('I prefer Canadian French, and I like concise explanations.');
    expect(repeated.coverage).toBe('complete');
    expect(repeated.bundles).toHaveLength(2);
    expect(repeated.bundles.map((bundle) => bundle.relation)).toEqual(['single', 'single']);

    const shared = interpret('I prefer Canadian French and like concise explanations.');
    expect(shared.coverage).toBe('complete');
    expect(shared.bundles).toHaveLength(1);
    expect(shared.bundles[0]).toMatchObject({ relation: 'allOf', coupling: 'coupled' });
    expect(shared.bundles[0]?.rootNodeIds).toHaveLength(2);
  });

  it.each([
    ['Do I prefer concise explanations?', 'question', 'none'],
    ['I might prefer concise explanations.', 'hypothetical', 'none'],
    ['If my notes are long, I prefer examples.', 'hypothetical', 'unknown'],
    ['My colleague prefers concise explanations.', 'third_party', 'none'],
    ['Someone said: I prefer French.', 'reported_statement', 'unknown'],
    ['Someone said. I prefer French.', 'reported_statement', 'unknown'],
    ['Hypothetically: I like tables.', 'hypothetical', 'unknown'],
    ['If asked, say "I prefer French".', 'quoted_content', 'none'],
    ['Use bullet points in the next answer.', 'instruction', 'none'],
    ['I prefer Canadian spelling.', 'unsupported_topic', 'unknown'],
    ['I prefer concise and very short explanations.', 'mixed_clauses', 'unknown'],
    ['I prefer any examples.', 'ambiguous_attachment', 'unknown'],
    ['I prefer a single example.', 'unsupported_topic', 'unknown'],
    ['I prefer examples and definitions.', 'mixed_clauses', 'unknown'],
    [
      'I prefer short explanations first, then detailed steps on request.',
      'unsupported_topic',
      'unknown',
    ],
    ['I prefer a single example.', 'unsupported_topic', 'unknown'],
    [
      'I prefer responses in Australian English with one mystical example before definitions.',
      'unsupported_grammar',
      'unknown',
    ],
    ['I prefer examples before definitions on request.', 'ambiguous_attachment', 'unknown'],
  ])('withholds unsupported source context for %s', (source, reason, coverage) => {
    const result = interpret(source);
    expect(result.coverage).toBe(coverage);
    expect(result.bundles).toHaveLength(0);
    expect(result.reasons).toContain(reason);
  });

  it('keeps the anchored Remember-this wrapper as source proof and accepts the complete body', () => {
    const source = 'Remember this: I like JSON.';
    const result = interpret(source);
    expect(result.coverage).toBe('complete');
    expect(result.bundles).toHaveLength(1);
    expect(result.sourceRequest).toMatchObject({
      kind: 'remember_this',
      scope: 'whole_single_preference',
      assertionBundleId: result.bundles[0]?.bundleId,
      assertionNodeId: result.bundles[0]?.rootNodeIds[0],
      evidence: { lexicalForm: 'Remember this: ' },
    });
    expect(nodeOfKind(result, 'format_selection')).toMatchObject([{ value: 'json' }]);
  });

  it('maps the wrapper at UTF-16 index zero through an astral application prefix', () => {
    const mappedContent = 'REMEMBER THIS:  I like Markdown.';
    const rawPrefix = '😀adapter:';
    const result = interpret(mappedContent, {
      rawContent: `${rawPrefix}${mappedContent}`,
      rawStart: rawPrefix.length,
    });
    expect(result.coverage).toBe('complete');
    expect(result.sourceRequest?.evidence).toMatchObject({
      lexicalForm: 'REMEMBER THIS:  ',
      spans: [
        {
          content: { start: 0, end: 'REMEMBER THIS:  '.length },
          raw: { start: rawPrefix.length, end: rawPrefix.length + 'REMEMBER THIS:  '.length },
        },
      ],
    });
  });

  it('bounds Remember-this proof before slicing at exact code-point and UTF-8 limits', () => {
    const wrapper = 'Remember this:';
    const exactCodePointWhitespace = ' '.repeat(2048 - Array.from(wrapper).length);
    const exactCodePointSource = `${wrapper}${exactCodePointWhitespace}I like JSON.`;
    const exactCodePointResult = interpret(exactCodePointSource);
    expect(exactCodePointResult.coverage).toBe('complete');
    expect(Array.from(exactCodePointResult.sourceRequest?.evidence.lexicalForm ?? '')).toHaveLength(
      2048,
    );

    const overCodePointSource = `${wrapper}${exactCodePointWhitespace} I like JSON.`;
    const overCodePointResult = interpret(overCodePointSource);
    expect(overCodePointResult.coverage).toBe('unknown');
    expect(overCodePointResult.bundles).toEqual([]);
    expect(overCodePointResult.sourceRequest).toBeUndefined();
    expect(overCodePointResult.reasons).toContain('clause_too_long');

    const exactByteWhitespace = '\n\r\t' + '\u3000'.repeat(1357) + '\u00a0'.repeat(4);
    const exactByteEvidence = `${wrapper}${exactByteWhitespace}`;
    expect(Buffer.byteLength(exactByteEvidence, 'utf8')).toBe(4096);
    const exactByteResult = interpret(`${exactByteEvidence}I like JSON.`);
    expect(exactByteResult.coverage).toBe('complete');
    expect(
      Buffer.byteLength(exactByteResult.sourceRequest?.evidence.lexicalForm ?? '', 'utf8'),
    ).toBe(4096);

    const overByteResult = interpret(`${exactByteEvidence}\u00a0I like JSON.`);
    expect(overByteResult.coverage).toBe('unknown');
    expect(overByteResult.bundles).toEqual([]);
    expect(overByteResult.sourceRequest).toBeUndefined();
    expect(overByteResult.reasons).toContain('clause_too_long');
  });

  it('propagates cancellation during an oversized wrapper scan', () => {
    const source = `Remember this:${' '.repeat(5000)}I like JSON.`;
    let checks = 0;
    const cancelledInput = makeInput(source, {
      check: () => {
        checks += 1;
      },
    });
    const baseline = interpretCompositionalPreferencesV2(cancelledInput);
    expect(baseline.coverage).toBe('unknown');
    expect(baseline.reasons).toContain('clause_too_long');
    expect(baseline.bundles).toEqual([]);
    expect(baseline.sourceRequest).toBeUndefined();
    const wrapperScanChecks = checks;

    const cancel = new Error('cancelled during wrapper scan');
    let cancellationChecks = 0;
    expect(() =>
      interpretCompositionalPreferencesV2(
        makeInput(source, {
          check: () => {
            cancellationChecks += 1;
            if (cancellationChecks === wrapperScanChecks) throw cancel;
          },
        }),
      ),
    ).toThrow(cancel);
    expect(cancellationChecks).toBe(wrapperScanChecks);
  });

  it('preserves base AST metadata overflow without attaching wrapper proof', () => {
    const body = Array.from({ length: 32 }, () => 'I prefer short explanations').join('. ');
    const result = interpret(`Remember this: ${body}.`);
    expect(result.coverage).toBe('unknown');
    expect(result.bundles).toEqual([]);
    expect(result.sourceRequest).toBeUndefined();
    expect(result.reasons).toContain('metadata_too_large');
  });

  it.each([
    'Remember this: I like JSON. I like tables.',
    'Remember this: If asked, say I like JSON.',
    'Remember this: "I like JSON."',
    'Remember this: Do I like JSON?',
    ' Remember this: I like JSON.',
    'Remember this:I like JSON.',
  ])('does not let a source-request wrapper widen whole-source grammar: %s', (source) => {
    const result = interpret(source);
    expect(result.coverage).not.toBe('complete');
    expect(result.bundles).toEqual([]);
    expect(result.sourceRequest).toBeUndefined();
  });

  it('covers all 1,202 generated literal-v1 base constructions with complete V2 ASTs', () => {
    const adjectives = [
      'long',
      'short',
      'plain English',
      'plain-English',
      'clear',
      'concise',
      'brief',
      'detailed',
      'thorough',
      'simple',
      'plain-language',
      'step-by-step',
      'technical',
      'nontechnical',
      'beginner-friendly',
      'accessible',
      'practical',
      'high-level',
      'in-depth',
      'succinct',
      'straightforward',
    ];
    const outputNouns = [
      'explanation',
      'explanations',
      'answer',
      'answers',
      'response',
      'responses',
      'summary',
      'summaries',
      'instruction',
      'instructions',
    ];
    const formatValues = [
      'bullet points',
      'numbered lists',
      'checklists',
      'short paragraphs',
      'paragraphs',
      'tables',
      'headings',
      'code blocks',
      'inline code',
      'plain text',
      'rich text',
      'markdown',
      'json',
      'csv',
      'yaml',
      'xml',
      'html',
      'latex',
      'diagrams',
      'charts',
      'lists',
      'prose',
      'no emojis',
      'fewer emojis',
    ];
    const presentationWords = [
      'friendly',
      'professional',
      'warm',
      'neutral',
      'direct',
      'conversational',
      'formal',
      'informal',
      'encouraging',
      'matter-of-fact',
      'concise',
      'polite',
    ];
    const languages = [
      'English',
      'Spanish',
      'French',
      'German',
      'Italian',
      'Portuguese',
      'Dutch',
      'Swedish',
      'Norwegian',
      'Danish',
      'Finnish',
      'Icelandic',
      'Polish',
      'Czech',
      'Slovak',
      'Ukrainian',
      'Russian',
      'Turkish',
      'Greek',
      'Arabic',
      'Hebrew',
      'Hindi',
      'Bengali',
      'Urdu',
      'Chinese',
      'Japanese',
      'Korean',
      'Thai',
      'Vietnamese',
      'Indonesian',
      'Malay',
      'Swahili',
      'Hausa',
      'Yoruba',
      'Igbo',
      'Akan',
      'Twi',
      'Amharic',
      'Somali',
      'Zulu',
      'Xhosa',
      'Tagalog',
      'Filipino',
      'Romanian',
      'Hungarian',
      'Persian',
      'Farsi',
    ];
    const sources: Array<{
      family: 'explanation' | 'format' | 'presentation' | 'language';
      text: string;
    }> = [];
    for (const adjective of ['', ...adjectives]) {
      for (const noun of outputNouns) {
        for (const suffix of ['', ' with examples', ' with steps']) {
          sources.push({
            family: 'explanation',
            text: `I prefer ${[adjective, noun].filter(Boolean).join(' ')}${suffix}.`,
          });
        }
      }
    }
    for (const value of formatValues) {
      for (const suffix of ['', ' format']) {
        sources.push({ family: 'format', text: `I prefer ${value}${suffix}.` });
      }
    }
    for (const value of presentationWords) {
      for (const facet of ['tone', 'style']) {
        sources.push({ family: 'presentation', text: `I prefer ${value} ${facet}.` });
      }
    }
    for (const language of languages) {
      for (const prefix of ['', 'in ', 'plain ', 'simple ', 'clear ']) {
        for (const suffix of ['', ' language']) {
          sources.push({ family: 'language', text: `I prefer ${prefix}${language}${suffix}.` });
        }
      }
    }

    expect(sources).toHaveLength(1202);
    const failures: string[] = [];
    const familyCounts = { explanation: 0, format: 0, presentation: 0, language: 0 };
    for (const fixture of sources) {
      familyCounts[fixture.family] += 1;
      if (literalV1ClaimCount(fixture.text) !== 1) {
        failures.push(`v1 rejected: ${fixture.text}`);
        continue;
      }
      const parsed = interpret(fixture.text);
      if (parsed.coverage !== 'complete' || parsed.bundles.length !== 1) {
        failures.push(`v2 ${parsed.coverage}/${parsed.reasons.join(',')}: ${fixture.text}`);
      }
    }
    expect(familyCounts).toEqual({ explanation: 660, format: 48, presentation: 24, language: 470 });
    expect(failures).toEqual([]);
  });

  it('preserves V2 compatibility targets and distinguishes inclusion from ordering', () => {
    const shortWithExamples = interpret('I prefer short explanations with examples.');
    expect(shortWithExamples.coverage).toBe('complete');
    expect(nodeOfKind(shortWithExamples, 'length')).toMatchObject([{ value: 'short' }]);
    expect(nodeOfKind(shortWithExamples, 'action')).toMatchObject([{ value: 'examples' }]);
    expect(shortWithExamples.bundles[0]?.attachments.map((edge) => edge.relation)).toContain(
      'includes',
    );
    expect(shortWithExamples.bundles[0]?.members.some((node) => node.kind === 'ordering')).toBe(
      false,
    );

    const format = interpret('I prefer JSON.');
    expect(nodeOfKind(format, 'format_selection')).toMatchObject([{ value: 'json' }]);

    const plainEnglish = interpret('I prefer plain-English instructions.');
    expect(nodeOfKind(plainEnglish, 'language')).toMatchObject([
      { representation: 'tagged', base: 'English', languageTag: 'en' },
    ]);
    expect(nodeOfKind(plainEnglish, 'language_use')).toMatchObject([{ value: 'plain' }]);
    expect(nodeOfKind(plainEnglish, 'style')).toEqual([]);

    const practical = interpret('I prefer practical explanations.');
    expect(nodeOfKind(practical, 'output_characteristic')).toMatchObject([{ value: 'practical' }]);
    expect(nodeOfKind(practical, 'action_qualifier')).toEqual([]);

    const technical = interpret('I prefer technical explanations.');
    expect(nodeOfKind(technical, 'output_characteristic')).toMatchObject([{ value: 'technical' }]);
    expect(nodeOfKind(technical, 'action_qualifier')).toEqual([]);

    const quality = interpret('I prefer polite style.');
    expect(nodeOfKind(quality, 'communication_quality')).toMatchObject([
      { facet: 'style', value: 'polite' },
    ]);

    const fewerEmojis = interpret('I prefer fewer emojis.');
    expect(nodeOfKind(fewerEmojis, 'emoji_usage')).toMatchObject([
      { value: 'fewer', comparisonBaseline: 'unspecified' },
    ]);

    const withSteps = interpret('I prefer explanations with steps.');
    expect(nodeOfKind(withSteps, 'action')).toMatchObject([{ value: 'steps' }]);
    expect(nodeOfKind(withSteps, 'presentation')).toEqual([]);

    const numberedLists = interpret('I prefer numbered lists.');
    expect(nodeOfKind(numberedLists, 'presentation')).toMatchObject([{ value: 'numbered_lists' }]);
    expect(
      nodeOfKind(numberedLists, 'presentation').some((node) => node.value === 'numbered_steps'),
    ).toBe(false);

    const named = interpret('I prefer Greek.');
    expect(nodeOfKind(named, 'language')).toMatchObject([
      {
        representation: 'named',
        registryId: 'literal-v1-safe-language-names',
        registryVersion: 1,
        name: 'Greek',
      },
    ]);
  });

  it.each([
    ['I do not like JSON.', 'format_selection'],
    ["I don't like friendly tone.", 'communication_quality'],
    ['I do not like French.', 'language'],
  ])('retains reviewed operator form for V2 target: %s', (source) => {
    const result = interpret(source);
    expect(result.coverage).toBe('complete');
    const preference = nodeOfKind(result, 'preference')[0];
    expect(preference).toMatchObject({ operator: 'like', polarity: 'negated' });
  });

  it('retains all four reviewed operator forms across output, format, quality, and language families', () => {
    const families = ['short explanations', 'JSON', 'friendly tone', 'French'];
    const operatorForms = [
      { prefix: 'I prefer ', operator: 'prefer', polarity: 'affirmed' },
      { prefix: 'I like ', operator: 'like', polarity: 'affirmed' },
      { prefix: 'I do not like ', operator: 'like', polarity: 'negated' },
      { prefix: "I don't like ", operator: 'like', polarity: 'negated' },
    ];
    for (const family of families) {
      for (const form of operatorForms) {
        const source = `${form.prefix}${family}.`;
        expect(literalV1ClaimCount(source)).toBe(1);
        const result = interpret(source);
        expect(result.coverage).toBe('complete');
        expect(nodeOfKind(result, 'preference')).toMatchObject([
          { operator: form.operator, polarity: form.polarity },
        ]);
      }
    }
  });

  it('withholds only the reviewed emoji operator exceptions from otherwise V1-safe forms', () => {
    for (const target of ['no emojis', 'fewer emojis']) {
      for (const [prefix, supported] of [
        ['I prefer ', true],
        ['I like ', true],
        ['I do not like ', false],
        ["I don't like ", false],
      ] as const) {
        const source = `${prefix}${target}.`;
        expect(literalV1ClaimCount(source)).toBe(1);
        const result = interpret(source);
        if (supported) {
          expect(result.coverage).toBe('complete');
          expect(nodeOfKind(result, 'emoji_usage')).toHaveLength(1);
        } else {
          expect(result.coverage).toBe('unknown');
          expect(result.bundles).toEqual([]);
          expect(result.reasons).toContain('unsupported_operator');
        }
      }
    }
  });

  it.each([
    ['I do not like no emojis.', 'unsupported_operator'],
    ["I don't like fewer emojis.", 'unsupported_operator'],
    ['I dislike no emojis.', 'unsupported_operator'],
  ])('withholds emoji operations outside the approved operator matrix: %s', (source, reason) => {
    const result = interpret(source);
    expect(result.coverage).toBe('unknown');
    expect(result.bundles).toEqual([]);
    expect(result.reasons).toContain(reason);
  });

  it('does not copy sensitive or unknown coupled material into the AST', () => {
    for (const [source, hidden] of [
      ['I prefer explanations about my HIV diagnosis.', 'HIV'],
      ['I prefer explanations about an unlisted subject.', 'unlisted subject'],
      ['I prefer Australian English with one mystical example before definitions.', 'mystical'],
    ]) {
      const result = interpret(source);
      expect(result.coverage).toBe('unknown');
      expect(result.bundles).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
  });

  it('withholds all candidates when a sibling preference is not fully reviewed', () => {
    const result = interpret('I prefer concise explanations. My manager prefers formal reports.');
    expect(result.coverage).toBe('unknown');
    expect(result.bundles).toEqual([]);
    expect(result.reasons).toContain('third_party');
  });

  it.each([
    'Hypothetically: I prefer French; I like tables.',
    'Someone said: I prefer French; I like tables.',
    'Someone said:\nI prefer French. I like tables.',
    'Suppose this is hypothetical: I prefer French. I like tables.',
    'Suppose this is hypothetical:\nI prefer French. I like tables.',
    'For this roleplay: I prefer French. I like tables.',
    'Someone said. I prefer French.',
    'Someone said: “I prefer French.’. I like tables.',
    'I prefer French. That was hypothetical.',
    'I prefer French. This is only a fictional example.',
    'I prefer French. Pretend someone else said that.',
    'I prefer French; I like tables.',
    'I prefer French. My colleague likes tables.',
    'I prefer French. The weather is nice.',
    'I prefer "French."',
  ])('withholds the entire candidate set when source context is not closed: %s', (source) => {
    const result = interpret(source);
    expect(result.coverage).toBe('unknown');
    expect(result.bundles).toEqual([]);
  });

  it('rejects malformed, nested, or unmatched quote delimiters as source context', () => {
    for (const source of [
      'Someone said: “I prefer French.’. I like tables.',
      'I prefer French. “I like tables.',
      'I prefer French. “nested “quote” text”.',
    ]) {
      const result = interpret(source);
      expect(result.coverage).toBe('unknown');
      expect(result.bundles).toEqual([]);
      expect(result.reasons).toContain('quoted_content');
    }
  });

  it('maps evidence through an attested wrapper without shifting UTF-16 offsets', () => {
    const source = 'I like French.';
    const prefix = '🗂 app wrapper: ';
    const raw = `${prefix}${source}`;
    const result = interpret(source, { rawContent: raw, rawStart: prefix.length });
    expect(result.coverage).toBe('complete');
    const evidence = result.bundles[0]!.members.find((node) => node.kind === 'language')!.evidence;
    const span = evidence.spans[0]!;
    expect(raw.slice(span.raw.start, span.raw.end)).toBe('French');
    expect(span.raw.start).toBe(prefix.length + source.indexOf('French'));
  });

  it('honors explicit quote regions and rejects forged hashes or incomplete mappings', () => {
    const source = 'I prefer French.';
    const quoted = interpret(source, { quoteRegions: [{ start: 0, end: source.length - 1 }] });
    expect(quoted.coverage).toBe('none');
    expect(quoted.reasons).toContain('quoted_content');

    const valid = makeInput(source);
    const mismatched = {
      ...valid,
      envelope: { ...(valid.envelope as object), contentHash: 'f'.repeat(64) },
    };
    expect(interpretCompositionalPreferencesV2(mismatched).reasons).toContain('content_mismatch');

    const incomplete = {
      ...valid,
      envelope: {
        ...(valid.envelope as object),
        mappings: [
          {
            contentStart: 0,
            contentEnd: source.length - 1,
            rawStart: 0,
            rawEnd: source.length - 1,
          },
        ],
      },
    };
    expect(interpretCompositionalPreferencesV2(incomplete).reasons).toContain('incomplete_mapping');
  });

  it('fails closed at the clause and bundle caps', () => {
    const longClause = `I prefer ${'x'.repeat(4090)}.`;
    expect(interpret(longClause).reasons).toContain('clause_too_long');

    const manyPredicates = Array.from({ length: 33 }, () => 'I prefer French').join('. ');
    const overflow = interpret(manyPredicates);
    expect(overflow.coverage).toBe('unknown');
    expect(overflow.bundles).toHaveLength(0);
    expect(overflow.reasons).toContain('too_many_bundles');
  });

  it('propagates cooperative cancellation from token and clause processing', () => {
    const cancel = new Error('cancelled');
    expect(() =>
      interpretCompositionalPreferencesV2(
        makeInput('I prefer French.', {
          check: () => {
            throw cancel;
          },
        }),
      ),
    ).toThrow(cancel);

    let checks = 0;
    expect(() =>
      interpretCompositionalPreferencesV2(
        makeInput('I prefer concise explanations.', {
          check: () => {
            checks += 1;
            if (checks === 12) throw cancel;
          },
        }),
      ),
    ).toThrow(cancel);
  });
});
