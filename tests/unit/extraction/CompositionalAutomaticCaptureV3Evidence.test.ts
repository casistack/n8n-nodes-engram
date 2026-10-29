import { randomUUID, createHash } from 'crypto';
import { z } from 'zod';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import * as CompositionalPreferenceV2Parser from '../../../src/extraction/CompositionalPreferenceV2Parser';
import {
  interpretCompositionalHumanSourceV3Evidence,
  interpretCompositionalHumanSourceV3EvidenceWithExecutionReport,
} from '../../../src/extraction/CompositionalAutomaticCaptureV3Evidence';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  type CompositionalPreferenceV2,
} from '../../../src/schemas/CompositionalPreferenceV2.schema';
import { AutomaticSourceEnvelopeSchema } from '../../../src/schemas/AutomaticMemory.schema';
import { COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  compositionalCaptureInterpreterResultHashV3,
} from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { AutomaticWriteOwnerSchema } from '../../../src/schemas/AutomaticClaim.schema';
import { GraphDataSchema, type GraphData } from '../../../src/schemas/GraphData.schema';
import { WRITE_OWNER_ATTRIBUTE } from '../../../src/storage/AutomaticIdentity';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import type { CompositionalAutomaticHumanSourceBuildV3 } from '../../../src/schemas/CompositionalAutomaticCaptureSourceBuildV3.schema';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture(content = 'I prefer concise explanations.') {
  const original = makeHumanFixture(`compositional-v3-evidence-${randomUUID()}`);
  const oldOwner = AutomaticWriteOwnerSchema.parse(
    original.human.attributes[WRITE_OWNER_ATTRIBUTE],
  );
  const graph: GraphData = GraphDataSchema.parse({
    version: '2.0',
    exported_at: '2026-10-25T13:00:00.000Z',
    group_id: original.human.group_id,
    entities: original.graph.entities.filter(
      (entity) => entity.uuid === original.binding.subjectId,
    ),
    edges: [],
    episodes: [],
  });
  const input: CompositionalAutomaticHumanSourceBuildV3 = {
    sourceId: randomUUID(),
    storeHash: 'd'.repeat(64),
    capturedAt: '2026-10-25T13:00:00.000Z',
    previousEpisodeId: null,
    request: {
      version: 3,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      preferenceInterpreter: 'compositionalV2',
      namespace: original.human.group_id,
      issuer: oldOwner.issuer,
      actorReference: oldOwner.actor,
      turn: `compositional-v3-turn-${randomUUID()}`,
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30_000,
      },
      source: {
        content,
        sourceMessageId: 'synthetic-v3-message',
        conversationId: 'synthetic-v3-conversation',
        senderId: 'synthetic-v3-sender',
        senderName: 'Synthetic V3 display',
        sourceWorkflowId: 'synthetic-v3-producer',
        originalSourceExecutionId: 'synthetic-v3-original-execution',
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
      attemptIdHash: sha('private audit attempt'),
    },
  };
  const built = buildCompositionalHumanCaptureSourceV3(graph, input);
  return { ...built, graph, input };
}

function copyEpisode<T>(episode: T): T {
  return JSON.parse(JSON.stringify(episode)) as T;
}

function syntaxEnvelope(episode: {
  attributes: Record<string, unknown>;
}): z.infer<typeof AutomaticSourceEnvelopeSchema> {
  const wrapper = episode.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE] as {
    sourceEnvelope: Record<string, unknown>;
  };
  const fields = { ...wrapper.sourceEnvelope };
  delete fields.version;
  delete fields.policy;
  return AutomaticSourceEnvelopeSchema.parse({ version: 1, ...fields });
}

function directParserResult(
  episode: { content: string; attributes: Record<string, unknown> },
  mappedContent: string,
): CompositionalPreferenceV2 {
  return CompositionalPreferenceV2Parser.interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: episode.content,
    mappedContent,
    envelope: syntaxEnvelope(episode),
  });
}

describe('non-authoritative V3 interpretation evidence', () => {
  it('projects a whole-source envelope and preserves the unchanged parser result exactly', () => {
    const built = fixture();
    const direct = directParserResult(built.episode, built.episode.content);
    const evidence = interpretCompositionalHumanSourceV3Evidence(
      built.episode,
      built.descriptor,
      built.identity,
    );
    const report = interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
      built.episode,
      built.descriptor,
      built.identity,
    );

    expect(evidence.result).toEqual(direct);
    expect(report.evidence).toEqual(evidence);
    expect(JSON.stringify(report.evidence)).toBe(JSON.stringify(evidence));
    expect(report.branch).toBe('complete_ast');
    expect(evidence.sourceHash).toBe(built.identity.sourceHash);
    expect(evidence.interpreterResultHash).toBe(
      compositionalCaptureInterpreterResultHashV3(
        evidence.sourceId,
        evidence.sourceHash,
        evidence.descriptorHash,
        evidence.result,
      ),
    );
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.result.bundles)).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.evidence.result.bundles)).toBe(true);
  });

  it('calls the V2 parser execution reporter exactly once per source-evidence report', () => {
    const built = fixture();
    const parserSpy = jest.spyOn(
      CompositionalPreferenceV2Parser,
      'interpretCompositionalPreferencesV2WithExecutionReport',
    );
    try {
      const report = interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
        built.episode,
        built.descriptor,
        built.identity,
      );
      expect(report.branch).toBe('complete_ast');
      expect(parserSpy).toHaveBeenCalledTimes(1);
    } finally {
      parserSpy.mockRestore();
    }
  });

  it('uses only the exact mapped application region and retains its stored mapping authority', () => {
    const built = fixture();
    const prefix = 'Synthetic wrapper 🤖: ';
    const body = 'I prefer JSON examples.';
    built.input.request.source.content = `${prefix}${body}\nfooter text`;
    built.input.request.source.applicationOwnedWrapper = true;
    built.input.request.source.humanRegion = {
      start: prefix.length,
      end: prefix.length + body.length,
    };
    const source = buildCompositionalHumanCaptureSourceV3(built.graph, built.input);
    const actualEnvelope = syntaxEnvelope(source.episode);
    expect(actualEnvelope.mappingAuthority).toBe('application_region');

    const evidence = interpretCompositionalHumanSourceV3Evidence(
      source.episode,
      source.descriptor,
      source.identity,
    );
    expect(evidence.result).toEqual(directParserResult(source.episode, body));
    expect(JSON.stringify(evidence.result)).not.toContain('footer text');
    const firstBundle = evidence.result.bundles[0];
    if (firstBundle) {
      const allEvidence = firstBundle.members.flatMap((member) =>
        'evidence' in member ? member.evidence.spans : [],
      );
      expect(allEvidence.every((span) => span.raw.start >= prefix.length)).toBe(true);
      expect(allEvidence.every((span) => span.raw.end <= prefix.length + body.length)).toBe(true);
    }
  });

  it('keeps a full-source application-region marker in the syntax projection', () => {
    const built = fixture();
    built.input.request.source.applicationOwnedWrapper = true;
    built.input.request.source.humanRegion = {
      start: 0,
      end: built.input.request.source.content.length,
    };
    const source = buildCompositionalHumanCaptureSourceV3(built.graph, built.input);
    expect(syntaxEnvelope(source.episode).mappingAuthority).toBe('application_region');

    const evidence = interpretCompositionalHumanSourceV3Evidence(
      source.episode,
      source.descriptor,
      source.identity,
    );
    expect(evidence.result).toEqual(directParserResult(source.episode, source.episode.content));
  });

  it('preserves parser outcomes and reports the actual bounded execution branch', () => {
    const cases: Array<{
      content: string;
      coverage: 'none' | 'unknown';
      reason: string;
      branch: string;
    }> = [
      { content: 'Hello there.', coverage: 'none', reason: '', branch: 'completed_none' },
      {
        content: 'Do I prefer concise explanations?',
        coverage: 'none',
        reason: 'question',
        branch: 'completed_none',
      },
      {
        content: 'I prefer Canadian spelling.',
        coverage: 'unknown',
        reason: 'unsupported_topic',
        branch: 'unsupported_meaning',
      },
      {
        content: '"'.repeat(320),
        coverage: 'unknown',
        reason: 'quoted_content',
        branch: 'quote_token_limit',
      },
      {
        content: 'I prefer French!!',
        coverage: 'unknown',
        reason: 'unsupported_grammar',
        branch: 'malformed_terminal',
      },
      {
        content: 'I prefer concise and very short explanations.',
        coverage: 'unknown',
        reason: 'mixed_clauses',
        branch: 'malformed_framing',
      },
    ];

    for (const sample of cases) {
      const built = fixture(sample.content);
      const direct = directParserResult(built.episode, built.episode.content);
      const report = interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
        built.episode,
        built.descriptor,
        built.identity,
      );
      expect(report.evidence.result).toEqual(direct);
      expect(report.evidence.result.coverage).toBe(sample.coverage);
      expect(report.branch).toBe(sample.branch);
      if (sample.reason) expect(report.evidence.result.reasons).toContain(sample.reason);
    }
  });

  it('reconciles only reviewed mutable source fields while preserving the captured source hash', () => {
    const built = fixture();
    const reviewed = copyEpisode(built.episode);
    reviewed.updated_at = '2026-10-25T13:10:00.000Z';
    reviewed.review_status = 'rejected';
    reviewed.trust_level = 'untrusted';
    reviewed.attributes.engram_extraction_queue_v1 = { status: 'complete' };
    const evidence = interpretCompositionalHumanSourceV3Evidence(
      reviewed,
      built.descriptor,
      built.identity,
    );
    expect(evidence.sourceHash).toBe(built.identity.sourceHash);

    const changedProducer = copyEpisode(built.episode);
    changedProducer.source_execution_id = 'different-original-execution';
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(
        changedProducer,
        built.descriptor,
        built.identity,
      ),
    ).toThrow('identity_mismatch');
  });

  it('fails closed on changed source, owner, envelope, descriptor, policy and captured identity', () => {
    const built = fixture();

    const changedSource = copyEpisode(built.episode);
    changedSource.content = 'A different source.';
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(changedSource, built.descriptor, built.identity),
    ).toThrow();

    const changedNamespace = copyEpisode(built.episode);
    changedNamespace.group_id = 'other-namespace';
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(
        changedNamespace,
        built.descriptor,
        built.identity,
      ),
    ).toThrow();

    const changedDescriptor = copyEpisode(built.descriptor);
    changedDescriptor.invocationDeadlineMs += 1;
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(built.episode, changedDescriptor, built.identity),
    ).toThrow('descriptor_mismatch');

    const changedPolicy = copyEpisode(built.episode);
    const wrapper = changedPolicy.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE] as {
      sourceEnvelope: { policy: { fingerprint: string } };
    };
    wrapper.sourceEnvelope.policy.fingerprint = 'a'.repeat(64);
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(changedPolicy, built.descriptor, built.identity),
    ).toThrow();

    const changedIdentity = copyEpisode(built.identity);
    changedIdentity.originalProducerHash = 'f'.repeat(64);
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(built.episode, built.descriptor, changedIdentity),
    ).toThrow('identity_mismatch');
  });

  it('rejects oversized and executable input before interpreting and keeps cancellation sticky', () => {
    const built = fixture();
    const oversized = copyEpisode(built.episode);
    oversized.attributes.extra = 'x'.repeat(600 * 1024);
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(oversized, built.descriptor, built.identity),
    ).toThrow();

    const accessor = copyEpisode(built.episode) as Record<string, unknown>;
    Object.defineProperty(accessor, 'content', {
      enumerable: true,
      get: () => built.episode.content,
    });
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(accessor, built.descriptor, built.identity),
    ).toThrow();

    const cancellation = new Error('synthetic parser cancellation');
    expect(() =>
      interpretCompositionalHumanSourceV3Evidence(
        built.episode,
        built.descriptor,
        built.identity,
        () => {
          throw cancellation;
        },
      ),
    ).toThrow(cancellation);

    let parserEntered = false;
    const caughtCancellation = new Error('synthetic late cancellation');
    const parserSpy = jest.spyOn(
      CompositionalPreferenceV2Parser,
      'interpretCompositionalPreferencesV2WithExecutionReport',
    );
    parserSpy.mockImplementation((input) => {
      parserEntered = true;
      try {
        input.check?.();
      } catch {
        return {
          result: {
            version: 2,
            descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
            coverage: 'none',
            bundles: [],
            withheld: [],
            reasons: [],
          } as CompositionalPreferenceV2,
          branch: 'completed_none',
        };
      }
      throw new Error('The test reporter expected cancellation');
    });
    try {
      expect(() =>
        interpretCompositionalHumanSourceV3Evidence(
          built.episode,
          built.descriptor,
          built.identity,
          () => {
            if (parserEntered) throw caughtCancellation;
          },
        ),
      ).toThrow(caughtCancellation);
    } finally {
      parserSpy.mockRestore();
    }
  });

  it('returns no capability fields and cannot be parsed as a terminal receipt', () => {
    const built = fixture();
    const evidence = interpretCompositionalHumanSourceV3Evidence(
      built.episode,
      built.descriptor,
      built.identity,
    );
    expect(evidence).not.toHaveProperty('operationId');
    expect(evidence).not.toHaveProperty('state');
    expect(evidence).not.toHaveProperty('lease');
    expect(evidence).not.toHaveProperty('shouldProcess');
    expect(evidence).not.toHaveProperty('eligible');
    expect(evidence).not.toHaveProperty('receipt');
    expect(CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(evidence).success).toBe(
      false,
    );
  });
});
