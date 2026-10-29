import { performance } from 'perf_hooks';
import { compileAutonomousPersonalEvidenceSelectionV1 } from '../../../src/extraction/AutonomousPersonalEvidenceSelectionV1';
import { compileAutonomousPersonalFreshSourceV4 } from '../../../src/storage/AutonomousPersonalCaptureBeginV4';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import { compileAutonomousPersonalSourceScanV1 } from '../../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import { hashAutonomousPersonalSourceUnitIdV1 } from '../../../src/schemas/AutonomousPersonalClaimV3.schema';

function fixture(content: string) {
  const namespace = 'selection-boundary';
  const issuer = 'synthetic-issuer';
  const actorReference = 'synthetic-actor';
  const turn = 'synthetic-turn';
  const fresh = compileAutonomousPersonalFreshSourceV4({
    request: {
      version: 4,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      interpretationFamily: 'autonomous-personal-v1',
      namespace,
      issuer,
      actorReference,
      turn,
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30_000,
        providerReference: {
          routeId: 'synthetic-route',
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
      },
      source: {
        content,
        sourceMessageId: null,
        conversationId: null,
        senderId: null,
        sourceWorkflowId: null,
        quotedMessageId: null,
        sourceType: 'message',
        eventTime: { mode: 'explicit', value: '2026-02-01T12:00:00.000Z' },
        mapping: { mode: 'full_body' },
        quoteRegions: [],
      },
    },
    context: {
      storeHash: 'a'.repeat(64),
      namespace,
      issuer,
      actorReference,
      turn,
      binding: {
        bindingId: '10000000-0000-4000-8000-000000000001',
        revision: 1,
        subjectId: '10000000-0000-4000-8000-000000000002',
        fingerprint: 'b'.repeat(64),
      },
      instance: 'synthetic-instance',
      workflow: 'synthetic-workflow',
      execution: 'synthetic-attempt',
    },
    sourceId: '10000000-0000-4000-8000-000000000003',
    previousEpisodeUuid: null,
    createdAt: '2026-02-01T12:00:01.000Z',
  });
  const source = {
    ...fresh.producer,
    sender_name: null,
    trust_level: fresh.descriptor.requestedTrustLevel,
    confidence: null,
    review_status: 'accepted',
    updated_at: null,
    attributes: {
      [AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE]: fresh.tuple.owner,
      [AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE]: fresh.tuple.envelope,
    },
  };
  const scan = compileAutonomousPersonalSourceScanV1({
    rawContent: content,
    mapping: { mode: 'full_body' },
    quoteRegions: [],
  });
  const providerResponse = {
    version: 1,
    units: scan.units.map((unit) => ({
      unitId: hashAutonomousPersonalSourceUnitIdV1({
        rawContentHash: scan.rawContentHash,
        unitIndex: unit.index,
        parentRawSpan: unit.rawSpan,
        parentMappedSpan: unit.mappedSpan,
      }),
      category: 'personal_assertion',
      usefulness: 'personal_memory',
      risk: 'ordinary',
      downgrade: [] as string[],
    })),
  };
  return { source, descriptor: fresh.descriptor, providerResponse };
}

const work = () => ({
  absoluteMonotonicDeadlineMs: performance.now() + 30_000,
  signal: new AbortController().signal,
});

function select(input: ReturnType<typeof fixture>, lifetime: ReturnType<typeof work>) {
  return compileAutonomousPersonalEvidenceSelectionV1(
    { source: input.source, descriptor: input.descriptor },
    input.providerResponse,
    lifetime,
  );
}

describe('Autonomous evidence selection independent boundary checks', () => {
  test('a known question accounts only for itself and preserves a later whole assertion', () => {
    const input = fixture('What time is it? I adore ceramics.');
    const result = select(input, work());
    expect(result.status).toBe('complete');
    expect(result.units.map((unit) => [unit.outcome, unit.reason])).toEqual([
      ['withheld', 'question_terminal'],
      ['candidate', null],
    ]);
    expect(result.occurrences).toHaveLength(1);
    const span = result.occurrences[0].rawSpan;
    expect(input.source.content.slice(span.start, span.end)).toBe('I adore ceramics.');
  });

  test('an unknown prefix stays unresolved across a later question and assertion', () => {
    const input = fixture('Context first. What time is it? I adore ceramics.');
    input.providerResponse.units[0].usefulness = 'not_memory';
    const result = select(input, work());
    expect(result.units.map((unit) => unit.outcome)).toEqual([
      'unresolved',
      'unresolved',
      'unresolved',
    ]);
    expect(result.units.slice(1).map((unit) => unit.reason)).toEqual([
      'ambiguous_scope',
      'ambiguous_scope',
    ]);
    expect(result.occurrences).toEqual([]);
  });

  test('a positive model label cannot turn an exact greeting into accounted context', () => {
    const result = select(fixture('Hello! I adore ceramics.'), work());
    expect(result.units[0]).toMatchObject({ outcome: 'unresolved', reason: 'provider_conflict' });
    expect(result.units[1]).toMatchObject({ outcome: 'unresolved', reason: 'ambiguous_scope' });
    expect(result.occurrences).toEqual([]);
  });

  test('a later source-owned retroactive correction removes all earlier candidates', () => {
    const result = select(fixture('I adore ceramics. That was only a quote.'), work());
    expect(result.units.every((unit) => unit.outcome === 'withheld')).toBe(true);
    expect(result.occurrences).toEqual([]);
  });

  test('the earliest complete report frame owns its suffix despite later ambiguity', () => {
    const result = select(
      fixture('I adore jazz. Example: I work remotely. Report I like tea.'),
      work(),
    );
    expect(result.units.map((unit) => [unit.outcome, unit.reason])).toEqual([
      ['candidate', null],
      ['withheld', 'source_frame'],
      ['withheld', 'source_frame'],
    ]);
    expect(result.sourceCoverage.status).toBe('complete');
    expect(result.occurrences).toHaveLength(1);
  });

  test('an earlier ambiguous report prefix cannot be closed by a later complete header', () => {
    const result = select(
      fixture('I adore jazz. Report I like tea. Example: I work remotely.'),
      work(),
    );
    expect(result.units.map((unit) => [unit.outcome, unit.reason])).toEqual([
      ['candidate', null],
      ['unresolved', 'ambiguous_scope'],
      ['unresolved', 'ambiguous_scope'],
    ]);
    expect(result.sourceCoverage.status).toBe('partial');
    expect(result.occurrences).toHaveLength(1);
  });

  test('an expired or cancelled original work lifetime cannot produce a selection', () => {
    const input = fixture('I adore ceramics.');
    expect(() =>
      select(input, {
        ...work(),
        absoluteMonotonicDeadlineMs: performance.now() - 1,
      }),
    ).toThrow();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      select(input, {
        ...work(),
        signal: controller.signal,
      }),
    ).toThrow();
  });

  test.each(['I @ adore ceramics.', 'I, adore ceramics.', 'I — adore ceramics.'])(
    'does not skip punctuation after the first-person head: %s',
    (content) => {
      const result = select(fixture(content), work());
      expect(result.occurrences).toEqual([]);
      expect(result.units[0].outcome).toBe('unresolved');
    },
  );

  test('provider DATA is independently owned without invoking its getters', () => {
    const input = fixture('I adore ceramics.');
    let reads = 0;
    const provider = Object.defineProperty({}, 'version', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private-provider-sentinel');
      },
    });
    expect(() =>
      compileAutonomousPersonalEvidenceSelectionV1(
        { source: input.source, descriptor: input.descriptor },
        provider,
        work(),
      ),
    ).toThrow();
    expect(reads).toBe(0);
  });

  test('raw input getters are rejected without being invoked', () => {
    let reads = 0;
    const input = Object.defineProperty({}, 'source', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private-sentinel');
      },
    });
    expect(() => compileAutonomousPersonalEvidenceSelectionV1(input, null, work())).toThrow();
    expect(reads).toBe(0);
  });
});
