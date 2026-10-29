import { compileAutonomousPersonalEvidenceSelectionV1 } from '../../../src/extraction/AutonomousPersonalEvidenceSelectionV1';
import {
  compileAutonomousPersonalDescriptorV4,
  type AutonomousPersonalDescriptorV4Input,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { compileAutonomousPersonalSourceScanV1 } from '../../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import {
  compileAutonomousPersonalSourceTupleV4,
  type AutonomousPersonalSourceTupleV4Input,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import { hashAutonomousPersonalSourceUnitIdV1 } from '../../../src/schemas/AutonomousPersonalClaimV3.schema';
import { AutonomousPersonalProviderResponseV1Schema } from '../../../src/schemas/AutonomousPersonalProviderV1.schema';
import type { AutonomousPersonalEvidenceSelectionV1 } from '../../../src/schemas/AutonomousPersonalEvidenceSelectionV1.schema';
import { compileAutonomousPersonalTypedSyntaxV1 } from '../../../src/extraction/AutonomousPersonalTypedSyntaxV1';

const sourceId = '10000000-0000-4000-8000-000000000001';
const bindingId = '10000000-0000-4000-8000-000000000002';
const subjectId = '10000000-0000-4000-8000-000000000003';
const providerRoute = 'synthetic-route';
const timestamp = '2026-10-27T11:12:13.000Z';

const descriptorInput = (): AutonomousPersonalDescriptorV4Input => ({
  profileId: 'conservative',
  requestedTrustLevel: 'standard',
  intentSetting: false,
  invocationDeadlineMs: 30_000,
  providerReference: {
    routeId: providerRoute,
    configurationFingerprint: 'd'.repeat(64),
    protocol: 'openai-compatible-json-v1',
    configuredRequestLimit: 2,
    configuredTimeoutMs: 30_000,
    configuredRequestBytes: 262_144,
    configuredResponseBytes: 65_536,
    temperature: { mode: 'providerDefault' },
    responseFormat: 'json_object',
    outputTokenLimit: { mode: 'omit' },
  },
});

type MappingInput = AutonomousPersonalSourceTupleV4Input['mapping'];

function makeCapture(
  content: string,
  mapping: MappingInput = { mode: 'full_body' },
  quoteRegions: Array<{ start: number; end: number }> = [],
  namespace = 'workflow:evidence-test',
) {
  const descriptor = compileAutonomousPersonalDescriptorV4(descriptorInput());
  const capture: AutonomousPersonalSourceTupleV4Input = {
    scope: {
      storeHash: 'a'.repeat(64),
      namespace,
      issuer: 'n8n',
      actorReference: 'synthetic-user',
      turn: 'turn-evidence-test',
      binding: {
        bindingId,
        revision: 1,
        subjectId,
        fingerprint: 'b'.repeat(64),
      },
    },
    descriptor,
    producer: {
      uuid: sourceId,
      group_id: namespace,
      content,
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      reference_time: timestamp,
      previous_episode_uuid: null,
      source_message_id: 'message-evidence-test',
      idempotency_key: 'idempotency-evidence-test',
      conversation_id: 'conversation-evidence-test',
      sender_id: 'sender-evidence-test',
      source_workflow_id: 'workflow-evidence-test',
      source_execution_id: 'original-execution-evidence-test',
      quoted_message_id: null,
      created_at: timestamp,
    },
    eventTimeMode: 'explicit',
    mapping,
    quoteRegions,
  };
  const tuple = compileAutonomousPersonalSourceTupleV4(capture);
  const source = {
    ...capture.producer,
    updated_at: null,
    sender_name: null,
    trust_level: descriptor.requestedTrustLevel,
    confidence: null,
    review_status: 'accepted',
    attributes: {
      engram_write_owner_v4: tuple.owner,
      engram_source_envelope_v3: tuple.envelope,
    },
  };
  return { source, descriptor, capture };
}

type RowOverrides = Partial<{
  category:
    | 'preference'
    | 'work_role'
    | 'work_affiliation'
    | 'project'
    | 'skill'
    | 'interest'
    | 'broad_location'
    | 'self_description'
    | 'personal_assertion'
    | 'unknown';
  risk: 'ordinary' | 'sensitive' | 'unknown';
  usefulness: 'personal_memory' | 'not_memory' | 'unknown';
  downgrade: string[];
}>;

function responseFor(
  source: ReturnType<typeof makeCapture>['source'],
  mapping: MappingInput = { mode: 'full_body' },
  overrides: readonly RowOverrides[] = [],
) {
  const scan = compileAutonomousPersonalSourceScanV1({
    rawContent: source.content,
    mapping,
    quoteRegions: [],
  });
  if (scan.status !== 'complete') return null;
  const rows = scan.units.map((unit, index) => ({
    unitId: hashAutonomousPersonalSourceUnitIdV1({
      rawContentHash: scan.rawContentHash,
      unitIndex: unit.index,
      parentRawSpan: unit.rawSpan,
      parentMappedSpan: unit.mappedSpan,
    }),
    category: 'personal_assertion' as const,
    risk: 'ordinary' as const,
    usefulness: 'personal_memory' as const,
    downgrade: [] as string[],
    ...(overrides[index] ?? {}),
  }));
  return AutonomousPersonalProviderResponseV1Schema.parse({ version: 1, units: rows });
}

function work() {
  return {
    absoluteMonotonicDeadlineMs: performance.now() + 30_000,
    signal: new AbortController().signal,
  };
}

function compile(
  content: string,
  overrides: readonly RowOverrides[] = [],
  mapping: MappingInput = { mode: 'full_body' },
  quoteRegions: Array<{ start: number; end: number }> = [],
  namespace = 'workflow:evidence-test',
) {
  const capture = makeCapture(content, mapping, quoteRegions, namespace);
  const providerResponse = responseFor(capture.source, mapping, overrides);
  return compileAutonomousPersonalEvidenceSelectionV1(
    { source: capture.source, descriptor: capture.descriptor },
    providerResponse,
    work(),
  );
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

function expectComplete(
  report: AutonomousPersonalEvidenceSelectionV1,
): asserts report is Extract<AutonomousPersonalEvidenceSelectionV1, { status: 'complete' }> {
  expect(report.status).toBe('complete');
  if (report.status !== 'complete') throw new Error('Expected a complete evidence selection');
}

describe('AutonomousPersonalEvidenceSelectionV1 compiles bounded evidence DATA', () => {
  test('selects open-vocabulary whole statements without copying literals into output', () => {
    const content =
      'I adore jazz. I read novels. I work as a zorbologist. I sing. I bring examples.';
    const report = compile(content);
    expectComplete(report);
    expect(report.units.map((unit) => unit.outcome)).toEqual([
      'candidate',
      'candidate',
      'candidate',
      'candidate',
      'candidate',
    ]);
    expect(report.units.map((unit) => unit.kind)).toEqual(Array(5).fill('source_statement_record'));
    expect(
      report.occurrences.map((occurrence) =>
        content.slice(occurrence.rawSpan.start, occurrence.rawSpan.end),
      ),
    ).toEqual([
      'I adore jazz.',
      'I read novels.',
      'I work as a zorbologist.',
      'I sing.',
      'I bring examples.',
    ]);
    expect(report.occurrences.map((occurrence) => occurrence.candidateIndex)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(report).not.toHaveProperty('source');
    expect(report).not.toHaveProperty('rawContent');
    expect(JSON.stringify(report)).not.toContain('I adore jazz.');
    expectDeepFrozen(report);
  });

  test('keeps complete ALL2 preferences on the typed lane and preserves compound bundles', () => {
    const one = compile('I prefer concise explanations.', [{ category: 'preference' }]);
    expectComplete(one);
    expect(one.units[0]).toMatchObject({
      outcome: 'candidate',
      kind: 'typed_preference',
      reason: null,
    });
    expect(one.occurrences[0]?.category).toBe('preference');

    const compound = compile('I prefer Canadian French, and I like concise explanations.', [
      { category: 'preference' },
    ]);
    expectComplete(compound);
    expect(compound.units).toHaveLength(1);
    expect(compound.units[0]).toMatchObject({ outcome: 'candidate', kind: 'typed_preference' });
    expect(compound.occurrences).toHaveLength(2);
    expect(compound.occurrences[0]?.rawSpan).not.toEqual(compound.occurrences[1]?.rawSpan);

    const implicitSubject = compile('I prefer Canadian French and like concise explanations.', [
      { category: 'preference' },
    ]);
    expectComplete(implicitSubject);
    expect(implicitSubject.units[0]?.kind).toBe('typed_preference');
    expect(implicitSubject.occurrences).toHaveLength(1);
  });

  test('preserves regional language and example-before-terminology qualifiers in typed meaning', () => {
    const examples = [
      {
        text: 'I prefer explanations in plain British English, with one practical example before any technical terminology.',
        requiredTerms: [
          'British',
          'English',
          'practical',
          'example',
          'before',
          'technical',
          'terminology',
        ],
      },
      {
        text: 'I like responses in plain Australian English, with one worked example ahead of any technical terms.',
        requiredTerms: [
          'Australian',
          'English',
          'worked',
          'example',
          'ahead',
          'technical',
          'terms',
        ],
      },
    ] as const;

    for (const { text, requiredTerms } of examples) {
      const capture = makeCapture(text);
      const syntax = compileAutonomousPersonalTypedSyntaxV1(
        {
          rawContent: text,
          mapping: capture.capture.mapping,
          quoteRegions: capture.capture.quoteRegions,
          syntaxScope: {
            namespace: capture.capture.scope.namespace,
            issuer: capture.capture.scope.issuer,
            actorReference: capture.capture.scope.actorReference,
            binding: capture.capture.scope.binding,
          },
        },
        work(),
      );
      if (syntax.status !== 'complete') throw new Error('Expected complete typed syntax');
      const syntaxUnit = syntax.units[0];
      expect(syntaxUnit?.kind).toBe('typed');
      if (!syntaxUnit || syntaxUnit.kind !== 'typed') throw new Error('Expected a typed unit');
      const bundle = syntaxUnit.preference.bundles[0];
      expect(bundle).toBeDefined();
      if (!bundle) throw new Error('Expected a complete preference bundle');
      const serializedBundle = JSON.stringify(bundle);
      for (const term of requiredTerms) expect(serializedBundle).toContain(term);
      for (const evidenceSpan of bundle.evidence.spans) {
        expect(text.slice(evidenceSpan.raw.start, evidenceSpan.raw.end)).toBe(
          bundle.evidence.lexicalForm,
        );
      }

      const selected = compileAutonomousPersonalEvidenceSelectionV1(
        {
          source: capture.source,
          descriptor: capture.descriptor,
        },
        responseFor(capture.source, { mode: 'full_body' }, [{ category: 'preference' }]),
        work(),
      );
      expectComplete(selected);
      expect(selected.units).toHaveLength(1);
      expect(selected.units[0]).toMatchObject({
        outcome: 'candidate',
        kind: 'typed_preference',
        reason: null,
      });
      expect(selected.occurrences).toHaveLength(syntaxUnit.preference.bundles.length);
      expect(selected.occurrences.map(({ rawSpan }) => rawSpan)).toEqual(
        syntaxUnit.preference.bundles.flatMap((candidateBundle) =>
          candidateBundle.evidence.spans.map(({ raw }) => raw),
        ),
      );
      expect(
        selected.occurrences.map(({ rawSpan }) => text.slice(rawSpan.start, rawSpan.end)),
      ).toEqual(
        syntaxUnit.preference.bundles.flatMap((candidateBundle) =>
          candidateBundle.evidence.spans.map(() => candidateBundle.evidence.lexicalForm),
        ),
      );
    }
  });

  test('accounts independent questions and exact neutral greetings locally', () => {
    const result = compile('Hi! Do I like tea? I adore jazz.', [
      { usefulness: 'not_memory' },
      {},
      {},
    ]);
    expectComplete(result);
    expect(result.units.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ['neutral', 'neutral_greeting'],
      ['withheld', 'question_terminal'],
      ['candidate', null],
    ]);
    expect(result.sourceCoverage).toMatchObject({
      status: 'complete',
      candidateUnitCount: 1,
      neutralUnitCount: 1,
      withheldUnitCount: 1,
      unresolvedUnitCount: 0,
    });
  });

  test('does not let unknown prefixes, provider conflicts, or unsupported statement punctuation close a suffix', () => {
    const prefix = compile('Context first. I adore jazz.', [{ usefulness: 'not_memory' }, {}]);
    expectComplete(prefix);
    expect(prefix.units.map((unit) => [unit.outcome, unit.reason])).toEqual([
      ['unresolved', 'statement_structure'],
      ['unresolved', 'ambiguous_scope'],
    ]);
    expect(prefix.occurrences).toEqual([]);
    expect(prefix.sourceCoverage).toMatchObject({
      status: 'unknown',
      unresolvedReason: 'multiple',
    });

    const conflictedGreeting = compile('Hi! I adore jazz.', [
      { usefulness: 'personal_memory' },
      {},
    ]);
    expectComplete(conflictedGreeting);
    expect(conflictedGreeting.units.map((unit) => [unit.outcome, unit.reason])).toEqual([
      ['unresolved', 'provider_conflict'],
      ['unresolved', 'ambiguous_scope'],
    ]);

    const punctuated = compile('I @ adore ceramics. I work remotely.', [{}, {}]);
    expectComplete(punctuated);
    expect(punctuated.units.map((unit) => [unit.outcome, unit.reason])).toEqual([
      ['unresolved', 'statement_structure'],
      ['unresolved', 'ambiguous_scope'],
    ]);
  });

  test('applies report and retroactive source framing before local outcomes', () => {
    const report = compile('Here is an example: I adore jazz.');
    expectComplete(report);
    expect(
      report.units.every((unit) => unit.outcome === 'withheld' && unit.reason === 'source_frame'),
    ).toBe(true);
    expect(report.occurrences).toEqual([]);

    const retroactive = compile('I adore jazz. That was a quote.');
    expectComplete(retroactive);
    expect(
      retroactive.units.every(
        (unit) => unit.outcome === 'withheld' && unit.reason === 'retroactive_correction',
      ),
    ).toBe(true);
    expect(retroactive.occurrences).toEqual([]);
  });

  test('applies hard sensitivity vetoes even when provider returns ordinary personal memory', () => {
    const result = compile('I have diabetes. I enjoy pottery.', [{}, {}]);
    expectComplete(result);
    expect(result.units.map((unit) => [unit.outcome, unit.reason])).toEqual([
      ['withheld', 'sensitive'],
      ['candidate', null],
    ]);
    expect(result.occurrences).toHaveLength(1);
  });

  test('retains provider conflicts as unresolved data and never reroutes a typed mismatch', () => {
    const unknown = compile('I adore jazz.', [
      { category: 'unknown', risk: 'unknown', usefulness: 'unknown' },
    ]);
    expectComplete(unknown);
    expect(unknown.units[0]).toMatchObject({ outcome: 'unresolved', reason: 'provider_unknown' });

    const downgraded = compile('I adore jazz.', [{ downgrade: ['uncertain'] }]);
    expectComplete(downgraded);
    expect(downgraded.units[0]).toMatchObject({
      outcome: 'unresolved',
      reason: 'provider_downgrade',
    });

    const typedConflict = compile('I prefer concise explanations.', [{ category: 'interest' }]);
    expectComplete(typedConflict);
    expect(typedConflict.units[0]).toMatchObject({
      outcome: 'unresolved',
      kind: null,
      reason: 'typed_category_conflict',
    });
    expect(typedConflict.occurrences).toEqual([]);

    const sameLiteralByCategory = compile('I adore jazz.', [{ category: 'interest' }]);
    const sameLiteralPersonal = compile('I adore jazz.', [{ category: 'personal_assertion' }]);
    expectComplete(sameLiteralByCategory);
    expectComplete(sameLiteralPersonal);
    expect(sameLiteralByCategory.occurrences[0]?.key).toBe(sameLiteralPersonal.occurrences[0]?.key);
  });

  test('preserves application-region UTF-16 spans and blocks source quote overlap', () => {
    const wrapper = 'Application 🧭 human: ';
    const literal = 'I adore jazz 😀.';
    const application = compile(wrapper + literal + ' [footer]', [], {
      mode: 'application_region',
      humanRegion: { start: wrapper.length, end: wrapper.length + literal.length },
      applicationWrapper: { configurationFingerprint: 'c'.repeat(64) },
    });
    expectComplete(application);
    expect(application.occurrences).toHaveLength(1);
    expect(application.occurrences[0]?.rawSpan).toEqual({
      start: wrapper.length,
      end: wrapper.length + literal.length,
    });
    expect(application.occurrences[0]?.mappedSpan).toEqual({ start: 0, end: literal.length });
    expect(
      (wrapper + literal + ' [footer]').slice(
        application.occurrences[0]!.rawSpan.start,
        application.occurrences[0]!.rawSpan.end,
      ),
    ).toBe(literal);

    const applicationQuote = compile(
      wrapper + literal + ' [footer]',
      [],
      {
        mode: 'application_region',
        humanRegion: { start: wrapper.length, end: wrapper.length + literal.length },
        applicationWrapper: { configurationFingerprint: 'c'.repeat(64) },
      },
      [{ start: 0, end: literal.length }],
    );
    expectComplete(applicationQuote);
    expect(applicationQuote.units[0]).toMatchObject({
      outcome: 'withheld',
      reason: 'source_frame',
    });
    expect(applicationQuote.occurrences).toEqual([]);

    const quoted = compile('I adore jazz.', [], { mode: 'full_body' }, [{ start: 0, end: 13 }]);
    expectComplete(quoted);
    expect(quoted.units[0]).toMatchObject({ outcome: 'withheld', reason: 'source_frame' });
    expect(quoted.occurrences).toEqual([]);
  });

  test('matches frozen punctuation-separator uncertainty and report-complement vetoes', () => {
    const uncertainty = compile('I, think I adore jazz.', [{}]);
    expectComplete(uncertainty);
    expect(uncertainty.units[0]).toMatchObject({
      outcome: 'withheld',
      reason: 'statement_structure',
    });

    const reported = compile('I read that I work for Acme.', [{}]);
    expectComplete(reported);
    expect(reported.units[0]).toMatchObject({ outcome: 'withheld', reason: 'source_frame' });
    expect(reported.occurrences).toEqual([]);

    const punctuatedReport = compile('I read, that I work for Acme.', [{}]);
    expectComplete(punctuatedReport);
    expect(punctuatedReport.units[0]).toMatchObject({
      outcome: 'withheld',
      reason: 'source_frame',
    });
    expect(punctuatedReport.occurrences).toEqual([]);
  });

  test('returns no prefix on the 33-unit capacity branch and requires a null response', () => {
    const content = Array.from({ length: 33 }, (_, index) => `I adore jazz ${index}`).join('. ');
    const capture = makeCapture(content);
    const report = compileAutonomousPersonalEvidenceSelectionV1(
      { source: capture.source, descriptor: capture.descriptor },
      null,
      work(),
    );
    expect(report).toMatchObject({
      status: 'capacity',
      reason: 'unit_count',
      units: [],
      occurrences: [],
      sourceCoverage: {
        status: 'unknown',
        scanStatus: 'complete',
        sourceUnitCount: 33,
        candidateUnitCount: 0,
        neutralUnitCount: 0,
        withheldUnitCount: 0,
        unresolvedUnitCount: 33,
        unresolvedReason: 'interpretation_capacity',
      },
    });

    const maximumScannerUnits = Array.from(
      { length: 128 },
      (_, index) => `I read novels ${index}`,
    ).join('. ');
    const maximumCapture = makeCapture(maximumScannerUnits);
    const maximumReport = compileAutonomousPersonalEvidenceSelectionV1(
      {
        source: maximumCapture.source,
        descriptor: maximumCapture.descriptor,
      },
      null,
      work(),
    );
    expect(maximumReport).toMatchObject({
      status: 'capacity',
      reason: 'unit_count',
      units: [],
      occurrences: [],
      sourceCoverage: {
        status: 'unknown',
        scanStatus: 'complete',
        sourceUnitCount: 128,
        candidateUnitCount: 0,
        neutralUnitCount: 0,
        withheldUnitCount: 0,
        unresolvedUnitCount: 128,
        unresolvedReason: 'interpretation_capacity',
      },
    });
  });

  test('accepts the 32-unit and maximum bounded statement cases; withholds an over-cap item', () => {
    const content = Array.from({ length: 32 }, (_, index) => `I adore jazz ${index}`).join('. ');
    const maxUnits = compile(content);
    expectComplete(maxUnits);
    expect(maxUnits.units).toHaveLength(32);
    expect(maxUnits.occurrences).toHaveLength(32);
    expect(maxUnits.sourceCoverage).toMatchObject({
      status: 'complete',
      sourceUnitCount: 32,
      candidateUnitCount: 32,
    });
    expect(maxUnits.occurrences.flatMap(({ dependencies }) => dependencies)).toHaveLength(32);

    const legalLiteral = 'I ' + 'z'.repeat(2046);
    const legal = compile(legalLiteral);
    expectComplete(legal);
    expect(legal.units[0]?.outcome).toBe('candidate');
    expect(legal.occurrences[0]?.rawSpan.end - legal.occurrences[0]?.rawSpan.start).toBe(2048);

    const overCapLiteral = 'I ' + 'z'.repeat(2047);
    const overCap = compile(overCapLiteral);
    expectComplete(overCap);
    expect(overCap.units[0]).toMatchObject({ outcome: 'withheld', reason: 'claim_capacity' });
    expect(overCap.occurrences).toEqual([]);

    const maximumUtf8Literal = 'I 𐐀' + 'é'.repeat(2045);
    expect(Array.from(maximumUtf8Literal)).toHaveLength(2048);
    expect(Buffer.byteLength(maximumUtf8Literal, 'utf8')).toBe(4096);
    const maximumUtf8 = compile(maximumUtf8Literal);
    expectComplete(maximumUtf8);
    expect(maximumUtf8.units[0]?.outcome).toBe('candidate');
    expect(
      maximumUtf8.occurrences[0]?.rawSpan.end - maximumUtf8.occurrences[0]?.rawSpan.start,
    ).toBe(maximumUtf8Literal.length);
  });

  test('applies the per-claim JSON cap without dropping a typed qualifier or falling back', () => {
    const base =
      'For summaries, I usually prefer answers in plain Canadian French with one practical example before any technical definitions and like responses in plain Australian English with one worked example ahead of any technical terms.';
    const nearSource = base.split(' ').join(' '.repeat(50));
    const stressNamespace = 'n' + '\u0001'.repeat(127);
    const near = compile(
      nearSource,
      [{ category: 'preference' }],
      { mode: 'full_body' },
      [],
      stressNamespace,
    );
    expectComplete(near);
    expect(near.units[0]).toMatchObject({ outcome: 'candidate', kind: 'typed_preference' });
    expect(near.occurrences).toHaveLength(1);
    const nearLiteral = nearSource.slice(
      near.occurrences[0]!.rawSpan.start,
      near.occurrences[0]!.rawSpan.end,
    );
    expect(nearLiteral.trim().replace(/\s+/gu, ' ')).toBe(base.slice(0, -1));

    const overSource = base.split(' ').join('\u00a0'.repeat(45));
    expect(Array.from(overSource).length).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(overSource, 'utf8')).toBeLessThanOrEqual(4096);
    const over = compile(
      overSource,
      [{ category: 'preference' }],
      { mode: 'full_body' },
      [],
      stressNamespace,
    );
    expectComplete(over);
    expect(over.units[0]).toMatchObject({
      outcome: 'withheld',
      kind: null,
      reason: 'claim_capacity',
    });
    expect(over.occurrences).toEqual([]);
  });

  test('returns empty indeterminate and scanner-resource results with no provider prefix', () => {
    const indeterminateCapture = makeCapture('I adore jazz. "unfinished');
    const indeterminate = compileAutonomousPersonalEvidenceSelectionV1(
      {
        source: indeterminateCapture.source,
        descriptor: indeterminateCapture.descriptor,
      },
      null,
      work(),
    );
    expect(indeterminate).toMatchObject({
      status: 'not_interpreted',
      reason: 'source_indeterminate',
      units: [],
      occurrences: [],
      sourceCoverage: { status: 'unknown', scanStatus: 'indeterminate_suffix' },
    });

    const tokenLimitCapture = makeCapture(Array.from({ length: 8193 }, () => 'I').join(' '));
    const resource = compileAutonomousPersonalEvidenceSelectionV1(
      {
        source: tokenLimitCapture.source,
        descriptor: tokenLimitCapture.descriptor,
      },
      null,
      work(),
    );
    expect(resource).toMatchObject({
      status: 'capacity',
      reason: 'source_resource',
      units: [],
      occurrences: [],
      sourceCoverage: {
        status: 'not_reported',
        scanStatus: 'resource_limit',
        unresolvedReason: 'lexical_token_limit',
      },
    });
  });

  test('requires exact provider joins and refuses response data on an empty source', () => {
    const capture = makeCapture('I adore jazz. I read novels.');
    const response = responseFor(capture.source);
    if (!response) throw new Error('Expected complete scanner result');
    expect(() =>
      compileAutonomousPersonalEvidenceSelectionV1(
        {
          source: capture.source,
          descriptor: capture.descriptor,
        },
        { ...response, units: response.units.slice(0, 1) },
        work(),
      ),
    ).toThrow('invalid_autonomous_evidence_provider_data');

    const empty = makeCapture('');
    const emptySelection = compileAutonomousPersonalEvidenceSelectionV1(
      { source: empty.source, descriptor: empty.descriptor },
      null,
      work(),
    );
    expectComplete(emptySelection);
    expect(emptySelection.units).toEqual([]);
    expect(emptySelection.sourceCoverage).toMatchObject({
      status: 'complete',
      sourceUnitCount: 0,
      unresolvedUnitCount: 0,
    });
  });

  test('owns the raw Source4 wrapper before property access', () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'source', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    expect(() => compileAutonomousPersonalEvidenceSelectionV1(hostile, null, work())).toThrow(
      'invalid_autonomous_evidence_input_data',
    );
    expect(getterCalls).toBe(0);
  });

  test('reorders provider rows into recomputed source unit order', () => {
    const capture = makeCapture('I adore jazz. I read novels.');
    const response = responseFor(capture.source);
    if (!response) throw new Error('Expected complete scanner result');
    const sourceOrder = compileAutonomousPersonalEvidenceSelectionV1(
      { source: capture.source, descriptor: capture.descriptor },
      response,
      work(),
    );
    const reorderedResponse = { ...response, units: [...response.units].reverse() };
    const reordered = compileAutonomousPersonalEvidenceSelectionV1(
      {
        source: capture.source,
        descriptor: capture.descriptor,
      },
      reorderedResponse,
      work(),
    );
    expect(reordered).toEqual(sourceOrder);
  });
});
