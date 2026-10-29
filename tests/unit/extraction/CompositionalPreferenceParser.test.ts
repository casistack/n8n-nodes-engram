import { createHash } from 'crypto';
import {
  COMPOSITIONAL_PREFERENCE_DESCRIPTOR,
  type CompositionalPreference,
  type CompositionalPreferenceNode,
} from '../../../src/schemas/CompositionalPreference.schema';
import type { CompositionalPreferenceInterpretationInput } from '../../../src/schemas/CompositionalPreferenceMeaning.schema';
import { interpretCompositionalPreferences } from '../../../src/extraction/CompositionalPreferenceParser';

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
): CompositionalPreferenceInterpretationInput {
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
    descriptor: { ...COMPOSITIONAL_PREFERENCE_DESCRIPTOR },
    rawContent,
    mappedContent,
    envelope,
    ...(options.check === undefined ? {} : { check: options.check }),
  };
}

function interpret(
  source: string,
  options?: Parameters<typeof makeInput>[1],
): CompositionalPreference {
  return interpretCompositionalPreferences(makeInput(source, options));
}

function nodeOfKind<K extends CompositionalPreferenceNode['kind']>(
  result: CompositionalPreference,
  kind: K,
): Array<Extract<CompositionalPreferenceNode, { kind: K }>> {
  return result.bundles
    .flatMap((bundle) => bundle.members)
    .filter(
      (node): node is Extract<CompositionalPreferenceNode, { kind: K }> => node.kind === kind,
    );
}

describe('interpretCompositionalPreferences', () => {
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
    let result: CompositionalPreference;
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
      expect(evidence.descriptor).toEqual(COMPOSITIONAL_PREFERENCE_DESCRIPTOR);
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
    expect(nodeOfKind(result, kind as CompositionalPreferenceNode['kind'])[0]).toMatchObject({
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
    ['Remember this: I like JSON.', 'instruction', 'unknown'],
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
    expect(interpretCompositionalPreferences(mismatched).reasons).toContain('content_mismatch');

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
    expect(interpretCompositionalPreferences(incomplete).reasons).toContain('incomplete_mapping');
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
      interpretCompositionalPreferences(
        makeInput('I prefer French.', {
          check: () => {
            throw cancel;
          },
        }),
      ),
    ).toThrow(cancel);

    let checks = 0;
    expect(() =>
      interpretCompositionalPreferences(
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
