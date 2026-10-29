import { createHash } from 'crypto';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { CompositionalPreferenceV2ExecutionReportSchema } from '../../../src/schemas/CompositionalPreferenceV2Execution.schema';
import type { CompositionalPreferenceV2InterpretationInput } from '../../../src/schemas/CompositionalPreferenceV2Meaning.schema';
import {
  interpretCompositionalPreferencesV2,
  interpretCompositionalPreferencesV2WithExecutionReport,
} from '../../../src/extraction/CompositionalPreferenceV2Parser';

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
  return {
    descriptor: { ...COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR },
    rawContent,
    mappedContent,
    envelope: {
      version: 1,
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
      mappingAuthority: rawContent === mappedContent ? 'whole_source' : 'application_region',
      humanRegion: { start: rawStart, end: rawEnd },
      mappings: [{ contentStart: 0, contentEnd: mappedContent.length, rawStart, rawEnd }],
      quoteRegions: options.quoteRegions ?? [],
      explicitIntent: false,
    },
    ...(options.check === undefined ? {} : { check: options.check }),
  };
}

function report(source: string) {
  return interpretCompositionalPreferencesV2WithExecutionReport(makeInput(source));
}

describe('compositional V2 internal execution report', () => {
  it.each([
    'I prefer concise explanations.',
    'Do I prefer concise explanations?',
    'I prefer Canadian spelling.',
    'I prefer French!!',
    '“I prefer French.',
    'If asked, say "I prefer French".',
  ])('projects the exact existing public AST result for %s', (source) => {
    const input = makeInput(source);
    const publicResult = interpretCompositionalPreferencesV2(input);
    const reportedResult = interpretCompositionalPreferencesV2WithExecutionReport(input).result;
    expect(reportedResult).toEqual(publicResult);
    expect(JSON.stringify(reportedResult)).toBe(JSON.stringify(publicResult));
  });

  it('distinguishes malformed terminal framing from semantic unsupported grammar with the same public reason', () => {
    const malformedTerminal = report('I prefer French!!');
    const unsupportedMeaning = report(
      'I prefer responses in Australian English with one mystical example before definitions.',
    );

    expect(malformedTerminal.result.coverage).toBe('unknown');
    expect(malformedTerminal.result.reasons).toContain('unsupported_grammar');
    expect(malformedTerminal.branch).toBe('malformed_terminal');
    expect(unsupportedMeaning.result.coverage).toBe('unknown');
    expect(unsupportedMeaning.result.reasons).toContain('unsupported_grammar');
    expect(unsupportedMeaning.branch).toBe('unsupported_meaning');
  });

  it.each([
    'I prefer concise and very short explanations.',
    'I prefer French and.',
    'I prefer French and and tables.',
  ])('reports malformed predicate coordination as framing: %s', (source) => {
    const result = report(source);
    expect(result.result.coverage).toBe('unknown');
    expect(result.result.reasons).toContain('mixed_clauses');
    expect(result.branch).toBe('malformed_framing');
  });

  it('distinguishes quote-token overflow from a completed no-preference result with valid quoted text', () => {
    const overflowInput = makeInput('"'.repeat(320));
    const overflow = interpretCompositionalPreferencesV2WithExecutionReport(overflowInput);
    const validQuoted = report('If asked, say "I prefer French".');

    expect(overflow.result.reasons).toEqual(['quoted_content']);
    expect(overflow.branch).toBe('quote_token_limit');
    expect(validQuoted.result.coverage).toBe('none');
    expect(validQuoted.result.reasons).toContain('quoted_content');
    expect(validQuoted.branch).toBe('completed_none');
  });

  it('reports malformed quotes, integrity failures, and resource limits at their actual exits', () => {
    const malformedQuote = report('I prefer French. “I like tables.');
    const integrityInput = makeInput('I prefer French.');
    const envelope = integrityInput.envelope as Record<string, unknown>;
    integrityInput.envelope = { ...envelope, contentHash: 'f'.repeat(64) };
    const integrity = interpretCompositionalPreferencesV2WithExecutionReport(integrityInput);
    const resourceLimit = report(`I prefer ${'x'.repeat(4090)}.`);
    const oversizedSource = report('x'.repeat(65_537));

    expect(malformedQuote.branch).toBe('malformed_quote');
    expect(integrity.result.reasons).toContain('content_mismatch');
    expect(integrity.branch).toBe('source_integrity_failure');
    expect(resourceLimit.result.reasons).toContain('clause_too_long');
    expect(resourceLimit.branch).toBe('resource_limit');
    expect(oversizedSource.result.reasons).toContain('source_too_large');
    expect(oversizedSource.branch).toBe('resource_limit');
  });

  it('reports a completed no-preference interpretation separately from unsupported meaning', () => {
    const noPreference = report('Do I prefer concise explanations?');
    const unsupported = report('I prefer Canadian spelling.');

    expect(noPreference.result.coverage).toBe('none');
    expect(noPreference.result.reasons).toContain('question');
    expect(noPreference.branch).toBe('completed_none');
    expect(unsupported.result.coverage).toBe('unknown');
    expect(unsupported.result.reasons).toContain('unsupported_topic');
    expect(unsupported.branch).toBe('unsupported_meaning');
  });

  it('propagates cancellation rather than returning a completion branch', () => {
    const cancel = new Error('cancelled during parser work');
    let checks = 0;
    const input = makeInput('I prefer concise explanations.', {
      check: () => {
        checks += 1;
        if (checks === 12) throw cancel;
      },
    });
    let caught: unknown;
    try {
      interpretCompositionalPreferencesV2WithExecutionReport(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cancel);
  });

  it('rejects structurally contradictory branch/result pairs', () => {
    const noPreference = report('Do I prefer concise explanations?').result;
    const unsupported = report('I prefer Canadian spelling.').result;

    expect(() =>
      CompositionalPreferenceV2ExecutionReportSchema.parse({
        result: noPreference,
        branch: 'complete_ast',
      }),
    ).toThrow();
    expect(() =>
      CompositionalPreferenceV2ExecutionReportSchema.parse({
        result: unsupported,
        branch: 'completed_none',
      }),
    ).toThrow();
  });
});
