import { compileAutonomousPersonalEvidenceSelectionV1 } from '../../../src/extraction/AutonomousPersonalEvidenceSelectionV1';
import { buildAutonomousPersonalClaimCandidateV1 } from '../../../src/extraction/AutonomousPersonalClaimCandidateV1';
import { AutonomousPersonalRuntimeDisplayV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalRuntimeSearchV4.schema';
import {
  AutonomousPersonalDescriptorV4Schema,
  compileAutonomousPersonalDescriptorV4,
  type AutonomousPersonalDescriptorV4Input,
} from '../../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { compileAutonomousPersonalSourceScanV1 } from '../../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import {
  compileAutonomousPersonalSourceTupleV4,
  type AutonomousPersonalSourceTupleV4Input,
} from '../../../src/schemas/AutonomousPersonalSourceV4.schema';
import {
  AutonomousPersonalClaimV3Schema,
  hashAutonomousPersonalSourceUnitIdV1,
} from '../../../src/schemas/AutonomousPersonalClaimV3.schema';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { AutonomousPersonalProviderResponseV1Schema } from '../../../src/schemas/AutonomousPersonalProviderV1.schema';
import { readNativeAutonomousPersonalStatementContextV1 } from '../../../src/utils/autonomousPersonalStatementContext';

const sourceId = '10000000-0000-4000-8000-000000000001';
const bindingId = '10000000-0000-4000-8000-000000000002';
const subjectId = '10000000-0000-4000-8000-000000000003';
const timestamp = '2026-10-27T11:12:13.000Z';
const OPT_IN = { version: 1, mode: 'literal_context_qualified' } as const;
const MARKER = 'context_conditional_v1';

const descriptorInput = (optIn: boolean): AutonomousPersonalDescriptorV4Input => ({
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
  ...(optIn ? { statementContext: OPT_IN } : {}),
});

function makeCapture(content: string, optIn: boolean) {
  const descriptor = compileAutonomousPersonalDescriptorV4(descriptorInput(optIn));
  const capture: AutonomousPersonalSourceTupleV4Input = {
    scope: {
      storeHash: 'a'.repeat(64),
      namespace: 'workflow:context-test',
      issuer: 'n8n',
      actorReference: 'synthetic-user',
      turn: 'turn-context-test',
      binding: { bindingId, revision: 1, subjectId, fingerprint: 'b'.repeat(64) },
    },
    descriptor,
    producer: {
      uuid: sourceId,
      group_id: 'workflow:context-test',
      content,
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      reference_time: timestamp,
      previous_episode_uuid: null,
      source_message_id: 'message-context-test',
      idempotency_key: 'idempotency-context-test',
      conversation_id: 'conversation-context-test',
      sender_id: 'sender-context-test',
      source_workflow_id: 'workflow-context-test',
      source_execution_id: 'original-execution-context-test',
      quoted_message_id: null,
      created_at: timestamp,
    },
    eventTimeMode: 'explicit',
    mapping: { mode: 'full_body' },
    quoteRegions: [],
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
  return { source, descriptor };
}

function select(content: string, optIn: boolean, category = 'personal_assertion') {
  const { source, descriptor } = makeCapture(content, optIn);
  const scan = compileAutonomousPersonalSourceScanV1({
    rawContent: content,
    mapping: { mode: 'full_body' },
    quoteRegions: [],
  });
  if (scan.status !== 'complete') throw new Error('expected a complete scan');
  // Favorable synthetic provider rows: ratings are necessary, never the thing under test.
  const response = AutonomousPersonalProviderResponseV1Schema.parse({
    version: 1,
    units: scan.units.map((unit) => ({
      unitId: hashAutonomousPersonalSourceUnitIdV1({
        rawContentHash: scan.rawContentHash,
        unitIndex: unit.index,
        parentRawSpan: unit.rawSpan,
        parentMappedSpan: unit.mappedSpan,
      }),
      category,
      risk: 'ordinary',
      usefulness: 'personal_memory',
      downgrade: [],
    })),
  });
  return compileAutonomousPersonalEvidenceSelectionV1({ source, descriptor }, response, {
    absoluteMonotonicDeadlineMs: performance.now() + 30_000,
    signal: new AbortController().signal,
  });
}

function outcomes(content: string, optIn: boolean, category?: string) {
  const report = select(content, optIn, category);
  if (report.status !== 'complete') throw new Error('expected a complete selection');
  return report;
}

describe('descriptor statementContext is optional, versioned and absent for legacy policies', () => {
  test('a legacy descriptor never gains the key and its hashes do not depend on it', () => {
    const legacy = compileAutonomousPersonalDescriptorV4(descriptorInput(false));
    expect(Object.prototype.hasOwnProperty.call(legacy, 'statementContext')).toBe(false);
    const { settingsHash, ...body } = legacy;
    expect(settingsHash).toBe(
      hashAutomaticCaptureV2({ domain: 'engram-autonomous-settings-v1', settings: body }),
    );
    expect(AutonomousPersonalDescriptorV4Schema.parse(JSON.parse(JSON.stringify(legacy)))).toEqual(
      legacy,
    );
  });

  test('opting in is explicit, changes the settings hash and round-trips', () => {
    const legacy = compileAutonomousPersonalDescriptorV4(descriptorInput(false));
    const optedIn = compileAutonomousPersonalDescriptorV4(descriptorInput(true));
    expect(optedIn.statementContext).toEqual(OPT_IN);
    expect(optedIn.settingsHash).not.toBe(legacy.settingsHash);
    expect(AutonomousPersonalDescriptorV4Schema.parse(JSON.parse(JSON.stringify(optedIn)))).toEqual(
      optedIn,
    );
    expect(() =>
      compileAutonomousPersonalDescriptorV4({
        ...descriptorInput(false),
        statementContext: { version: 1, mode: 'anything_else' },
      }),
    ).toThrow();
    expect(() =>
      compileAutonomousPersonalDescriptorV4({ ...descriptorInput(false), statementContext: {} }),
    ).toThrow();
  });

  test('a flagged descriptor edited back to legacy is rejected, not rewritten', () => {
    const optedIn = compileAutonomousPersonalDescriptorV4(descriptorInput(true));
    const { statementContext: _removed, ...stripped } = optedIn;
    expect(AutonomousPersonalDescriptorV4Schema.safeParse(stripped).success).toBe(false);
  });
});

describe('native statement context control defaults OFF', () => {
  test('missing and explicit off emit nothing; the opt-in value is versioned', () => {
    expect(readNativeAutonomousPersonalStatementContextV1({})).toBeUndefined();
    expect(
      readNativeAutonomousPersonalStatementContextV1({ automaticStatementContextMode: 'off' }),
    ).toBeUndefined();
    expect(
      readNativeAutonomousPersonalStatementContextV1({
        automaticStatementContextMode: 'contextQualifiedV1',
      }),
    ).toEqual(OPT_IN);
  });

  test('malformed raw parameters fail closed', () => {
    for (const bad of ['on', true, 1, null, ['x']]) {
      expect(() =>
        readNativeAutonomousPersonalStatementContextV1({ automaticStatementContextMode: bad }),
      ).toThrow();
    }
    expect(() => readNativeAutonomousPersonalStatementContextV1([])).toThrow();
    expect(() => readNativeAutonomousPersonalStatementContextV1(null)).toThrow();
    expect(() => readNativeAutonomousPersonalStatementContextV1(new Proxy({}, {}))).toThrow();
  });
});

describe('context-qualified selection (flag off versus on)', () => {
  const accepted = [
    'I review pull requests first thing when I start work.',
    'I keep my phone on silent whenever I am in a meeting.',
    'When I start work, I review pull requests first.',
    'Whenever the team ships on a Friday, I keep a notebook by my desk.',
    "I don't answer messages when I am driving.",
    'I tidy the café́ corner when I start work 🚀.',
  ];

  test.each(accepted)('off withholds or leaves unresolved, on keeps the literal: %s', (content) => {
    const off = outcomes(content, false);
    expect(off.occurrences).toHaveLength(0);
    expect(off.units[0]?.outcome).not.toBe('candidate');

    const on = outcomes(content, true);
    expect(on.units[0]).toMatchObject({ outcome: 'candidate', kind: 'source_statement_record' });
    expect(on.occurrences).toHaveLength(1);
    const occurrence = on.occurrences[0]!;
    expect(occurrence.kind).toBe('source_statement_record');
    expect(occurrence.qualification).toBe(MARKER);
    // Full literal, original order, qualifiers and raw UTF-16 offsets.
    expect(content.slice(occurrence.rawSpan.start, occurrence.rawSpan.end)).toBe(content);
    expect(occurrence.rawSpan).toEqual(occurrence.mappedSpan);
  });

  test('a plain statement with no condition has no marker under either policy', () => {
    const content = 'I review pull requests first thing in the morning.';
    for (const optIn of [false, true]) {
      const report = outcomes(content, optIn);
      expect(report.occurrences).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(report.occurrences[0], 'qualification')).toBe(
        false,
      );
    }
  });

  const stillWithheld = [
    '"When I start work, I review pull requests first."',
    'I review pull requests when I start work if time allows.',
    'I might review pull requests when I start work.',
    'I would review pull requests when I start work.',
    'I think I review pull requests when I start work.',
    'Maybe I review pull requests when I start work.',
    'I review pull requests when I start work and when I finish.',
    'I review pull requests while I start work when I can.',
    'I wonder whether I review pull requests when I start work.',
    'If I start work, I review pull requests first.',
    'When I start work, if I can, I review pull requests first.',
    'When you ask, I want you to always reply tersely.',
    'He said I review pull requests when I start work.',
    'I heard that they review pull requests when they start work.',
    'I take insulin when I travel.',
    'When I start work I review pull requests first.',
    'When I start work, review pull requests first.',
    'When, I review pull requests first.',
    'Do I review pull requests when I start work?',
  ];

  test.each(stillWithheld)('never becomes a record with the flag on: %s', (content) => {
    for (const optIn of [false, true]) {
      const report = outcomes(content, optIn);
      expect(report.occurrences).toHaveLength(0);
      expect(report.units.every((unit) => unit.outcome !== 'candidate')).toBe(true);
    }
  });

  test.each(['unknown', 'preference'])(
    'provider ratings are necessary, never sufficient (category %s)',
    (category) => {
      const content = 'When I start work, I review pull requests first.';
      const on = outcomes(content, true, category);
      if (category === 'unknown') {
        expect(on.occurrences).toHaveLength(0);
        expect(on.units[0]?.outcome).toBe('unresolved');
      }
      // Without the policy, no rating can admit the same unit.
      expect(outcomes(content, false, category).occurrences).toHaveLength(0);
    },
  );
});

describe('qualification marker is part of claim identity and round-trips', () => {
  const literal = 'I review pull requests first thing when I start work.';
  const base = () => {
    const descriptor = compileAutonomousPersonalDescriptorV4(descriptorInput(true));
    return {
      sourceId,
      contentHash: 'c'.repeat(64),
      descriptorHash: 'e'.repeat(64),
      namespace: 'workflow:context-test',
      subjectId,
      sourceHash: 'f'.repeat(64),
      policy: descriptor.policy,
      sourceEventTime: timestamp,
      unitId: '1'.repeat(64),
      unitIndex: 0,
      kind: 'source_statement_record' as const,
      category: 'personal_assertion' as const,
      literal,
      rawSpan: { start: 0, end: literal.length },
      mappedSpan: { start: 0, end: literal.length },
      bundle: null,
    };
  };

  test('absent marker leaves the legacy claim and reference without the key', () => {
    const result = buildAutonomousPersonalClaimCandidateV1(base());
    if (result.kind !== 'candidate') throw new Error('expected a candidate');
    expect(Object.prototype.hasOwnProperty.call(result.claim, 'qualification')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.reference, 'qualification')).toBe(false);
  });

  test('present marker reaches claim and reference, changes identity, and survives parsing', () => {
    const plain = buildAutonomousPersonalClaimCandidateV1(base());
    const marked = buildAutonomousPersonalClaimCandidateV1({ ...base(), qualification: MARKER });
    if (plain.kind !== 'candidate' || marked.kind !== 'candidate') throw new Error('candidate');
    expect(marked.claim).toMatchObject({ qualification: MARKER, evidence: { literal } });
    expect(marked.reference.qualification).toBe(MARKER);
    expect(marked.claim.key).not.toBe(plain.claim.key);
    expect(marked.reference.meaningHash).not.toBe(plain.reference.meaningHash);
    const reparsed = AutonomousPersonalClaimV3Schema.parse(
      JSON.parse(JSON.stringify(marked.claim)),
    );
    expect(reparsed).toEqual(marked.claim);
  });

  test('stripping or adding the marker on a stored claim breaks its key (conflict, not rewrite)', () => {
    const plain = buildAutonomousPersonalClaimCandidateV1(base());
    const marked = buildAutonomousPersonalClaimCandidateV1({ ...base(), qualification: MARKER });
    if (plain.kind !== 'candidate' || marked.kind !== 'candidate') throw new Error('candidate');
    const { qualification: _q, ...stripped } = marked.claim as typeof marked.claim & {
      qualification?: string;
    };
    expect(AutonomousPersonalClaimV3Schema.safeParse(stripped).success).toBe(false);
    expect(
      AutonomousPersonalClaimV3Schema.safeParse({ ...plain.claim, qualification: MARKER }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalClaimV3Schema.safeParse({ ...marked.claim, qualification: 'other' })
        .success,
    ).toBe(false);
  });

  test('a typed candidate rejects the statement-only marker', () => {
    expect(() =>
      buildAutonomousPersonalClaimCandidateV1({
        ...base(),
        kind: 'typed_preference',
        category: 'preference',
        qualification: MARKER,
      }),
    ).toThrow();
  });
});

describe('retrieval display carries the marker', () => {
  const source = {
    sourceMessageId: 'm',
    conversationId: 'c',
    senderId: 's',
    senderName: null,
    episodeKind: 'active_human',
    trustLevel: 'standard',
    reviewStatus: 'accepted',
    referenceTime: timestamp,
    sourceWorkflowId: null,
    sourceExecutionId: null,
  };
  const display = {
    kind: 'source_statement_record',
    statementLiteral: 'I review pull requests first thing when I start work.',
    sourceEventTime: timestamp,
    confidence: null,
    source,
  };

  test('present and absent markers both parse and are preserved exactly', () => {
    const plain = AutonomousPersonalRuntimeDisplayV4OwnedDataSchema.parse(display);
    expect(Object.prototype.hasOwnProperty.call(plain, 'qualification')).toBe(false);
    const marked = AutonomousPersonalRuntimeDisplayV4OwnedDataSchema.parse({
      ...display,
      qualification: MARKER,
    });
    expect(marked).toMatchObject({ qualification: MARKER });
    expect(
      AutonomousPersonalRuntimeDisplayV4OwnedDataSchema.safeParse({
        ...display,
        qualification: 'unversioned',
      }).success,
    ).toBe(false);
  });
});

// Golden values generated from the unchanged 0.8.3 runtime, not from this implementation.
const LEGACY_083_GOLDEN = [
  {
    content: 'I prefer concise explanations.',
    descriptorHash: '49334d55057b12cc63f1f57398773bd7c36f73ba54d75d755a3ec525fbf713d0',
    sourceHash: 'c0f9f313db3286323bda3d9622bec470e43b8ba0990c2cd17d1b9f72360612c4',
    selectionHash: '619f184e1e5e2c8d22acaebd49f461c82c725c4c0b97c82eaf913b63f5e77a31',
  },
  {
    content: 'I work as a ceramicist.',
    descriptorHash: '49334d55057b12cc63f1f57398773bd7c36f73ba54d75d755a3ec525fbf713d0',
    sourceHash: '9c450e4befba86a6506f4158cce1fd46db2b431f5814cbe4ac54638b94d60fc8',
    selectionHash: 'affb05447b90e1c8054368085d2b7fface2d3172cd2a5a314f9f8e7f3a70984f',
  },
  {
    content: 'I do not like long explanations.',
    descriptorHash: '49334d55057b12cc63f1f57398773bd7c36f73ba54d75d755a3ec525fbf713d0',
    sourceHash: '64b798a0bfc367edd7a3d9a10ec96adec7623a9f0a017093ad62649d74679f28',
    selectionHash: 'e108ad84d6e722ebe6f6de46db4e72e067662af15b0ad68a001ef8fe396ae241',
  },
  {
    content: 'When you explain a topic, I prefer numbered instructions.',
    descriptorHash: '49334d55057b12cc63f1f57398773bd7c36f73ba54d75d755a3ec525fbf713d0',
    sourceHash: '34ccc33589e8460d37d9d8913c82e3c982b2cdd818c2879bddc348b2b7a25c0c',
    selectionHash: '8cddd2003fe965e675f89319154bf7f41860ddced340cf0dadded647d45be499',
  },
] as const;
describe('legacy 0.8.3 canonical identity and selection compatibility', () => {
  test.each(LEGACY_083_GOLDEN)('preserves $content without adding policy fields', (expected) => {
    const capture = makeCapture(expected.content, false);
    expect(hashAutomaticCaptureV2(capture.descriptor)).toBe(expected.descriptorHash);
    expect(hashAutomaticCaptureV2(capture.source)).toBe(expected.sourceHash);
    expect(hashAutomaticCaptureV2(select(expected.content, false))).toBe(expected.selectionHash);
  });
});
