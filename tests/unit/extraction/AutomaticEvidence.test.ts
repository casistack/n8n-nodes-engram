import {
  captureEnvelope,
  compileAutomaticPolicy,
  parseAutomaticPreferences,
} from '../../../src/extraction/AutomaticEvidence';
import {
  AutomaticSourceEnvelopeSchema,
  type AutomaticActor,
  type AutomaticSourceEnvelope,
} from '../../../src/schemas/AutomaticMemory.schema';

const bindingRef = {
  bindingId: 'e3115c17-e67f-4ec8-a6b7-ef232a5043e0',
  revision: 3,
  subjectId: '187a5ef7-67f0-45c8-b177-a74282a3c1e7',
  fingerprint: 'a'.repeat(64),
};
const baseActor: AutomaticActor = {
  namespace: 'workspace-a',
  issuer: 'trusted-workflow',
  actorReference: 'sender-42',
};
const conservative = compileAutomaticPolicy({ profileId: 'conservative' });

function capture(
  content: string,
  options: {
    rawContent?: string;
    actor?: AutomaticActor;
    intent?: boolean;
    policy?: ReturnType<typeof compileAutomaticPolicy>;
  } = {},
): AutomaticSourceEnvelope {
  const rawContent = options.rawContent ?? content;
  const result = captureEnvelope(
    content,
    rawContent,
    options.actor ?? baseActor,
    bindingRef,
    options.intent ?? false,
    options.policy ?? conservative,
  );
  if (!result.ok) throw new Error(`capture failed: ${result.reason}`);
  return result.envelope;
}

describe('automatic policy compilation', () => {
  it('defaults to the existing policy and compiles only code-owned profile settings', () => {
    const policy = compileAutomaticPolicy();
    expect(policy).toMatchObject({
      version: 1,
      profileId: 'existing',
      profileVersion: 1,
      policyId: 'legacy',
      policyVersion: 1,
      autoAccept: true,
      requiresExplicitIntent: false,
    });
    expect(compileAutomaticPolicy({ profileId: 'explicit' })).toMatchObject({
      policyId: 'literal-preferences',
      autoAccept: true,
      requiresExplicitIntent: true,
    });
    expect(compileAutomaticPolicy({ profileId: 'reviewFirst' })).toMatchObject({
      autoAccept: false,
      requiresExplicitIntent: false,
    });
    expect(() => compileAutomaticPolicy({ profileId: 'personalAssistant' } as never)).toThrow();
    expect(() =>
      compileAutomaticPolicy({ profileId: 'conservative', autoAccept: false } as never),
    ).toThrow();
  });

  it('returns frozen policy descriptors with stable profile fingerprints', () => {
    const first = compileAutomaticPolicy({ profileId: 'conservative' });
    const second = compileAutomaticPolicy({ profileId: 'conservative' });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('automatic source envelope capture', () => {
  it('maps the complete source by default and freezes the nested envelope', () => {
    const content = 'I prefer concise explanations.';
    const captured = captureEnvelope(content, content, baseActor, bindingRef, false, conservative);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.envelope.mappings).toEqual([
      { contentStart: 0, contentEnd: content.length, rawStart: 0, rawEnd: content.length },
    ]);
    expect(captured.envelope.humanRegion).toEqual({ start: 0, end: content.length });
    expect(captured.envelope.mappingAuthority).toBe('whole_source');
    expect(Object.isFrozen(captured.envelope)).toBe(true);
    expect(Object.isFrozen(captured.envelope.mappings)).toBe(true);
    expect(Object.isFrozen(captured.envelope.bindingRef)).toBe(true);
  });

  it('allows a substring only with explicit application-owned wrapper attestation', () => {
    const content = 'I prefer concise explanations.';
    const rawContent = `wrapper: ${content}`;
    const actor: AutomaticActor = {
      ...baseActor,
      applicationOwnedWrapper: true,
      humanRegion: { start: 9, end: 9 + content.length },
    };
    const captured = captureEnvelope(content, rawContent, actor, bindingRef, false, conservative);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.envelope.mappingAuthority).toBe('application_region');
    expect(captured.envelope.mappings[0]).toMatchObject({
      rawStart: 9,
      rawEnd: 9 + content.length,
    });
  });

  it('rejects report-like, quoted, conditional, suffixed, ambiguous, and bounds-only substrings', () => {
    const content = 'I prefer English';
    const wrappers = [
      `Alice said: ${content}`,
      `If asked, say "${content}"`,
      `When prompted, ${content}`,
      `${content}, but I do not prefer it`,
      'same and same',
    ];
    wrappers.forEach((rawContent) => {
      expect(
        captureEnvelope(content, rawContent, baseActor, bindingRef, false, conservative),
      ).toEqual({
        ok: false,
        reason: 'content_not_mapped',
      });
    });
    expect(
      captureEnvelope(
        content,
        `wrapper: ${content}`,
        { ...baseActor, humanRegion: { start: 9, end: 9 + content.length } },
        bindingRef,
        false,
        conservative,
      ),
    ).toEqual({ ok: false, reason: 'content_not_mapped' });
  });

  it('rejects partial, surrogate-splitting, and invalid Unicode mappings', () => {
    expect(
      captureEnvelope('same', 'same and same', baseActor, bindingRef, false, conservative),
    ).toEqual({
      ok: false,
      reason: 'content_not_mapped',
    });
    expect(
      captureEnvelope(
        'I prefer JSON',
        'prefix I prefer JSON suffix',
        {
          ...baseActor,
          humanRegion: { start: 7, end: 19 },
        },
        bindingRef,
        false,
        conservative,
      ),
    ).toEqual({ ok: false, reason: 'content_not_mapped' });
    expect(
      captureEnvelope(
        '😀',
        '😀',
        { ...baseActor, humanRegion: { start: 1, end: 2 } },
        bindingRef,
        false,
        conservative,
      ),
    ).toEqual({ ok: false, reason: 'invalid_region' });
    expect(captureEnvelope('\ud800', '\ud800', baseActor, bindingRef, false, conservative)).toEqual(
      { ok: false, reason: 'invalid_unicode' },
    );
  });

  it('accepts trusted application intent without a keyword and recognizes only an anchored wrapper', () => {
    const directIntent = capture('I like JSON.', { intent: true });
    expect(directIntent.explicitIntent).toBe(true);
    const anchored = capture('REMEMBER THIS: I like JSON.');
    expect(anchored.explicitIntent).toBe(true);
    const unanchored = capture('Can you remember this: I like JSON.');
    expect(unanchored.explicitIntent).toBe(false);
  });

  it('rejects invalid binding references and policy descriptors', () => {
    expect(
      captureEnvelope(
        'I like JSON.',
        'I like JSON.',
        baseActor,
        { ...bindingRef, revision: 0 },
        false,
        conservative,
      ),
    ).toEqual({
      ok: false,
      reason: 'invalid_binding',
    });
    expect(
      captureEnvelope('I like JSON.', 'I like JSON.', baseActor, bindingRef, false, {
        ...conservative,
        fingerprint: 'f'.repeat(64),
      }),
    ).toEqual({ ok: false, reason: 'invalid_policy' });
    expect(
      captureEnvelope(
        'I like JSON.',
        'I like JSON.',
        { ...baseActor, quoteRegions: [{ start: 0, end: 99 }] },
        bindingRef,
        false,
        conservative,
      ),
    ).toEqual({ ok: false, reason: 'invalid_quote_regions' });
  });
});

describe('automatic literal preference parsing', () => {
  it.each([
    'I do not like long explanations.',
    'I prefer plain English explanations.',
    'I like short answers.',
  ])('supports ordinary explanation wording without paraphrasing: %s', (content) => {
    const parsed = parseAutomaticPreferences(capture(content), content);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0].clause).toBe(content);
    expect(parsed.claims[0].polarity).toBe(
      content.startsWith('I do not') ? 'negative' : 'positive',
    );
  });
  it('parses a supported positive claim without changing literal case or internal whitespace', () => {
    const content = '  I prefer Detailed  explanations.  ';
    const raw = `chat: ${content}`;
    const source = capture(content, {
      rawContent: raw,
      actor: {
        ...baseActor,
        applicationOwnedWrapper: true,
        humanRegion: { start: 6, end: 6 + content.length },
      },
    });
    const parsed = parseAutomaticPreferences(source, content);
    expect(parsed.reasons).toEqual([]);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0]).toMatchObject({
      predicate: 'PREFERS',
      polarity: 'positive',
      literal: 'Detailed  explanations',
      clause: 'I prefer Detailed  explanations.',
      languageTag: 'und',
    });
    expect(content.slice(parsed.claims[0].objectSpan.start, parsed.claims[0].objectSpan.end)).toBe(
      'Detailed  explanations',
    );
    expect(
      raw.slice(parsed.claims[0].rawClauseSpan.start, parsed.claims[0].rawClauseSpan.end),
    ).toBe(parsed.claims[0].clause);
  });

  it.each(['I do not like bullet points.', "I don't like bullet points."])(
    'parses negative polarity for %s',
    (content) => {
      const parsed = parseAutomaticPreferences(capture(content), content);
      expect(parsed.claims[0]).toMatchObject({ polarity: 'negative', literal: 'bullet points' });
    },
  );

  it('strips an anchored Remember this wrapper while retaining original offsets', () => {
    const content = 'Remember this: I like JSON.';
    const parsed = parseAutomaticPreferences(capture(content), content);
    expect(parsed.claims[0].clause).toBe('I like JSON.');
    expect(parsed.claims[0].clauseSpan.start).toBe(content.indexOf('I like'));
  });

  it('rejects explicit-only claims until trusted intent is present', () => {
    const policy = compileAutomaticPolicy({ profileId: 'explicit' });
    const content = 'I prefer concise explanations.';
    expect(parseAutomaticPreferences(capture(content, { policy }), content)).toEqual({
      claims: [],
      reasons: ['explicit_intent_required'],
    });
    const trusted = capture(content, { policy, intent: true });
    expect(parseAutomaticPreferences(trusted, content).claims).toHaveLength(1);
  });

  it.each([
    ['I prefer concise answers about my HIV.', 'sensitive_topic'],
    ['I prefer concise answers about hiking.', 'unsupported_topic'],
    ['I prefer concise explanations? ', 'question'],
    ['I think I prefer concise explanations.', 'hypothetical'],
    ['My manager likes bullet points.', 'third_party'],
    ['Use bullet points.', 'instruction'],
    ['I prefer concise explanations. I like tables.', 'mixed_clauses'],
    ['I prefer "bullet points".', 'quoted_content'],
  ])('defers unsupported content %s', (content, reason) => {
    const parsed = parseAutomaticPreferences(capture(content), content);
    expect(parsed.claims).toEqual([]);
    expect(parsed.reasons).toEqual([reason]);
  });

  it('rejects explicit quoted regions, stale hashes, missing policy, forged policy, and forged mapping geometry', () => {
    const content = 'I prefer bullet points.';
    const quotedSource = capture(content, {
      actor: { ...baseActor, quoteRegions: [{ start: 9, end: 22 }] },
    });
    expect(parseAutomaticPreferences(quotedSource, content).reasons).toEqual(['quoted_content']);

    const source = capture(content);
    expect(parseAutomaticPreferences(source, `${content} `).reasons).toEqual(['content_mismatch']);

    const noPolicy = { ...source, policy: undefined } as unknown as AutomaticSourceEnvelope;
    expect(parseAutomaticPreferences(noPolicy, content).reasons).toEqual(['invalid_envelope']);

    const forgedPolicy = {
      ...source,
      policy: { ...source.policy, autoAccept: false },
    } as AutomaticSourceEnvelope;
    expect(parseAutomaticPreferences(forgedPolicy, content).reasons).toEqual(['invalid_envelope']);
    const staleFingerprint = {
      ...source,
      policy: { ...source.policy, fingerprint: 'f'.repeat(64) },
    } as AutomaticSourceEnvelope;
    expect(parseAutomaticPreferences(staleFingerprint, content).reasons).toEqual([
      'invalid_envelope',
    ]);
    const badVersion = {
      ...source,
      policy: { ...source.policy, profileVersion: 2 },
    } as unknown as AutomaticSourceEnvelope;
    expect(parseAutomaticPreferences(badVersion, content).reasons).toEqual(['invalid_envelope']);
    const badGeometry = {
      ...source,
      humanRegion: { start: 1, end: content.length + 1 },
    } as AutomaticSourceEnvelope;
    expect(parseAutomaticPreferences(badGeometry, content).reasons).toEqual(['invalid_envelope']);
    expect(AutomaticSourceEnvelopeSchema.safeParse(source).success).toBe(true);
  });

  it('preserves Unicode whitespace and maps UTF-16 spans after an astral display prefix', () => {
    const content = 'I prefer concise\u00a0\u00a0explanations.';
    const prefix = '😀 display: ';
    const raw = prefix + content;
    const source = capture(content, {
      rawContent: raw,
      actor: {
        ...baseActor,
        applicationOwnedWrapper: true,
        humanRegion: { start: prefix.length, end: raw.length },
      },
    });
    const parsed = parseAutomaticPreferences(source, content);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0].literal).toBe('concise\u00a0\u00a0explanations');
    expect(
      raw.slice(parsed.claims[0].rawObjectSpan.start, parsed.claims[0].rawObjectSpan.end),
    ).toBe(parsed.claims[0].literal);
  });

  it.each([
    'If I am asked, I prefer JSON.',
    'I do not think I like JSON.',
    'I do not like not using JSON.',
    'I prefer JSON tomorrow.',
    'I prefer JSON and I like tables.',
    'I prefer JSON; please use it.',
    "Alice said 'I prefer JSON.'",
    'I prefer concise explanations about my bank account.',
  ])('never returns candidate text for unsupported context: %s', (content) => {
    const parsed = parseAutomaticPreferences(capture(content), content);
    expect(parsed.claims).toEqual([]);
    expect(parsed.reasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(parsed)).not.toContain(content);
  });

  it('defers oversized source, object, and clause without truncating them', () => {
    const oversizedSource = '😀'.repeat(17000);
    expect(
      captureEnvelope(oversizedSource, oversizedSource, baseActor, bindingRef, false, conservative),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    const oversizedObject = `I prefer ${'clear '.repeat(400)}answers.`;
    expect(parseAutomaticPreferences(capture(oversizedObject), oversizedObject)).toEqual({
      claims: [],
      reasons: ['object_too_long'],
    });
    const oversizedClause = `I prefer ${'clear '.repeat(700)}answers.`;
    expect(parseAutomaticPreferences(capture(oversizedClause), oversizedClause)).toEqual({
      claims: [],
      reasons: ['clause_too_long'],
    });
  });
});
