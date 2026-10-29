import { createHash } from 'crypto';
import { inspectLiteralCompositionalPairCompatibilityV1 as inspect } from '../../../src/extraction/LiteralCompositionalPairCompatibilityV1';
import { LiteralCompositionalPairCompatibilityResultV1Schema } from '../../../src/schemas/LiteralCompositionalPairCompatibilityV1.schema';
import { interpretCompositionalPreferencesV2 } from '../../../src/extraction/CompositionalPreferenceV2Parser';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
import { COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR } from '../../../src/schemas/CompositionalPreferenceV2.schema';
import type { CompositionalAutomaticClaimMeaningV2 } from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import {
  captureEnvelope,
  compileAutomaticPolicy,
  parseAutomaticPreferences,
} from '../../../src/extraction/AutomaticEvidence';

const SUBJECT = '11111111-1111-4111-8111-111111111111';
const BINDING = '22222222-2222-4222-8222-222222222222';
const namespace = ' exact pair tenant ';
const binding = {
  bindingId: BINDING,
  revision: 1,
  subjectId: SUBJECT,
  fingerprint: 'a'.repeat(64),
};
const actor = { namespace, issuer: 'synthetic-app', actorReference: 'synthetic-human' };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function meaning(source: string): CompositionalAutomaticClaimMeaningV2 {
  const preference = interpretCompositionalPreferencesV2({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: source,
    mappedContent: source,
    envelope: {
      version: 1,
      ...actor,
      bindingRef: binding,
      contentHash: sha(source),
      rawContentHash: sha(source),
      mappingAuthority: 'whole_source',
      humanRegion: { start: 0, end: source.length },
      mappings: [
        { contentStart: 0, contentEnd: source.length, rawStart: 0, rawEnd: source.length },
      ],
      quoteRegions: [],
      explicitIntent: false,
    },
  });
  expect(preference.coverage).toBe('complete');
  const projection = projectCompositionalPreferenceV2Meaning({
    preference,
    namespace,
    subjectId: SUBJECT,
  });
  if (!projection.ok) throw new Error(`Synthetic source not projected: ${source}`);
  return projection.meaning;
}
const olds = {
  O_SHORT: 'I prefer short explanations.',
  O_NOT_LONG: "I don't like long explanations.",
  O_SHORT_EXAMPLES: 'I prefer short explanations with examples.',
};
const news = {
  N_LANGUAGE: 'I like plain Australian English.',
  N_ORDER:
    'I prefer explanations in English with one practical example before any technical terms.',
  N_RICH:
    'I like responses in plain Kenyan Swahili, with one worked example before any technical terms.',
};
const request = (old = olds.O_SHORT, next = news.N_RICH) => {
  const newMeaning = meaning(next);
  if (next === news.N_ORDER) {
    // Typed N_ORDER is independently reviewed but currently not raw-produced
    // without language by ALL2. This data-only fixture drops that full subtree;
    // it does not establish source entailment or extend the frozen parser.
    const b = newMeaning.bundles[0];
    const paths = new Set(
      b.nodes.filter((n) => n.kind === 'language' || n.kind === 'language_use').map((n) => n.path),
    );
    b.nodes = b.nodes.filter((n) => !paths.has(n.path));
    b.edges = b.edges.filter((e) => !paths.has(e.targetPath) && !paths.has(e.ownerPath));
  }
  return { oldMeaning: meaning(old), newMeaning };
};

describe('closed literal/compositional conditional pair compatibility', () => {
  it.each([
    ['O_SHORT', 'N_LANGUAGE'],
    ['O_SHORT', 'N_ORDER'],
    ['O_SHORT', 'N_RICH'],
    ['O_NOT_LONG', 'N_LANGUAGE'],
    ['O_NOT_LONG', 'N_ORDER'],
    ['O_NOT_LONG', 'N_RICH'],
    ['O_SHORT_EXAMPLES', 'N_ORDER'],
    ['O_SHORT_EXAMPLES', 'N_RICH'],
  ] as const)('covers every exact typed pair %s:%s', (old, next) => {
    const result = inspect(request(olds[old], news[next]));
    expect(result.status).toBe('compatible_constraints');
    if (result.status !== 'compatible_constraints') throw new Error(JSON.stringify(result));
    expect(result.ruleId).toBe(`${old}:${next}`);
    expect(LiteralCompositionalPairCompatibilityResultV1Schema.parse(result)).toEqual(result);
    expect(result.oldCoverage.nodePaths.length).toBe(meaning(olds[old]).bundles[0].nodes.length);
    expect(result.newCoverage.nodePaths.length).toBe(
      request(olds[old], news[next]).newMeaning.bundles[0].nodes.length,
    );
    expect(result.oldCoverage.edgeKeys.length).toBe(meaning(olds[old]).bundles[0].edges.length);
    expect(result.newCoverage.edgeKeys.length).toBe(
      request(olds[old], news[next]).newMeaning.bundles[0].edges.length,
    );
    expect(result.oldCoverage.predicateDependencies).toHaveLength(1);
    expect(result.newCoverage.predicateDependencies).toHaveLength(1);
    expect(result).not.toHaveProperty('should_process');
    expect(result).not.toHaveProperty('accepted');
  });
  it('retains original supported V1 sources for both restored-store controls', () => {
    for (const source of [olds.O_SHORT_EXAMPLES, olds.O_NOT_LONG]) {
      const capture = captureEnvelope(
        source,
        source,
        actor,
        binding,
        false,
        compileAutomaticPolicy({ profileId: 'conservative' }),
      );
      expect(capture.ok).toBe(true);
      if (!capture.ok) throw new Error('V1 capture');
      const parsed = parseAutomaticPreferences(capture.envelope, source);
      expect(parsed.claims).toHaveLength(1);
      expect(inspect(request(source)).status).toBe('compatible_constraints');
    }
  });
  it.each([
    'I prefer responses in plain Canadian French, with one practical example ahead of any technical terms.',
    'I like explanations in clear American English, with one worked example before any terminology.',
    'I prefer responses in simple British English, with one practical example before any terminology.',
  ])('supports held-out complete compositions without a sentence exception: %s', (source) => {
    expect(inspect(request(olds.O_SHORT_EXAMPLES, source)).status).toBe('compatible_constraints');
  });
  it('preserves different prefer/like operators and complete regional atoms in commitments', () => {
    const prefer = inspect(request('I prefer short explanations.', 'I prefer Australian English.'));
    const like = inspect(request('I like short explanations.', 'I like Canadian French.'));
    expect(prefer.status).toBe('compatible_constraints');
    expect(like.status).toBe('compatible_constraints');
    if (prefer.status !== 'compatible_constraints' || like.status !== 'compatible_constraints')
      throw new Error('fixture');
    expect(prefer.oldMeaningHash).not.toBe(like.oldMeaningHash);
    expect(prefer.newMeaningHash).not.toBe(like.newMeaningHash);
  });
  it.each([
    ['I prefer long explanations.', news.N_RICH],
    [olds.O_SHORT, 'I prefer long explanations.'],
    [olds.O_NOT_LONG, 'I prefer long explanations.'],
    [olds.O_SHORT_EXAMPLES, news.N_LANGUAGE],
    [
      olds.O_SHORT,
      'I prefer responses in English with exactly one practical example before any technical terms.',
    ],
    ['I prefer detailed explanations.', news.N_RICH],
    ['I prefer short answers.', news.N_RICH],
    [olds.O_SHORT, 'I prefer answers in English.'],
    [olds.O_SHORT, 'I prefer responses in English when requested.'],
    [olds.O_SHORT, 'I prefer short responses.'],
  ])('withholds unreviewed or opposed whole shapes: %s / %s', (old, next) => {
    expect(inspect(request(old, next)).status).toBe('unknown_constraints');
  });
  it.each(['followed_by', 'reverse_operands'] as const)(
    'withholds an unreviewed complete typed ordering: %s',
    (change) => {
      const input = request();
      const bundle = input.newMeaning.bundles[0];
      if (change === 'followed_by') {
        const ordering = bundle.nodes.find((n) => n.kind === 'ordering');
        if (ordering?.kind !== 'ordering') throw new Error('fixture');
        ordering.relation = 'followed_by';
      } else {
        const rebase = (path: string) =>
          path.replace('.first', '.TEMP').replace('.second', '.first').replace('.TEMP', '.second');
        bundle.nodes = bundle.nodes.map((n) => ({ ...n, path: rebase(n.path) }));
        bundle.edges = bundle.edges.map((e) => ({
          ...e,
          ownerPath: rebase(e.ownerPath),
          targetPath: rebase(e.targetPath),
          ...(e.relation === 'orders'
            ? { position: e.position === 'first' ? ('second' as const) : ('first' as const) }
            : {}),
        }));
      }
      expect(inspect(input)).toMatchObject({
        status: 'unknown_constraints',
        reason: 'unsupported_new_shape',
      });
    },
  );
  it.each(['modifier', 'condition', 'scope'] as const)(
    'withholds an extra subtree without dropping it: %s',
    (extra) => {
      const input = request();
      const b = input.newMeaning.bundles[0];
      if (extra === 'modifier') {
        b.nodes.push({ path: 'p0.target.modifier', kind: 'length', value: 'short' });
        b.edges.push({
          ownerPath: 'p0.target',
          targetPath: 'p0.target.modifier',
          relation: 'modifies',
        });
      } else if (extra === 'condition') {
        b.nodes.push({ path: 'p0.condition', kind: 'condition', value: 'on_request' });
        b.edges.push({ ownerPath: 'p0', targetPath: 'p0.condition', relation: 'conditions' });
      } else {
        b.nodes.push({ path: 'p0.scope', kind: 'task_scope', value: 'planning' });
        b.edges.push({ ownerPath: 'p0', targetPath: 'p0.scope', relation: 'scopes' });
      }
      expect(inspect(input)).toMatchObject({
        status: 'unknown_constraints',
        reason: extra === 'modifier' ? 'invalid_input' : 'unsupported_new_shape',
      });
    },
  );
  it('withholds a second complete preference instead of proving only the first bundle', () => {
    const input = request();
    input.newMeaning.bundles.push(...meaning('I like English.').bundles);
    expect(inspect(input)).toMatchObject({
      status: 'unknown_constraints',
      reason: 'invalid_input',
    });
  });
  it('does not accept added current-status authority flags', () => {
    const input = request();
    expect(inspect({ ...input, accepted: true }).status).toBe('unknown_constraints');
    expect(inspect({ ...input, trusted: true }).status).toBe('unknown_constraints');
    // Actual rejected/proposed/manual/revoked eligibility is not representable
    // as a caller boolean; an actual-root runtime must keep those blockers.
  });
  it('checks exact namespace/subject identity without trimming', () => {
    const input = request();
    input.newMeaning.namespace = namespace.trim();
    expect(inspect(input)).toMatchObject({
      status: 'unknown_constraints',
      reason: 'identity_mismatch',
    });
    input.newMeaning.namespace = namespace;
    input.newMeaning.subjectId = BINDING;
    expect(inspect(input)).toMatchObject({
      status: 'unknown_constraints',
      reason: 'identity_mismatch',
    });
  });
  it('is independent of node and edge serialization order and covers no partial subset', () => {
    const input = request();
    const before = copy(input);
    const first = inspect(input);
    input.oldMeaning.bundles[0].nodes.reverse();
    input.oldMeaning.bundles[0].edges.reverse();
    input.newMeaning.bundles[0].nodes.reverse();
    input.newMeaning.bundles[0].edges.reverse();
    const second = inspect(input);
    expect(second.status).toBe(first.status);
    if (first.status !== 'compatible_constraints' || second.status !== 'compatible_constraints')
      throw new Error('fixture');
    expect(second.ruleId).toEqual(first.ruleId);
    expect(second.oldCoverage.nodePaths).toEqual(first.oldCoverage.nodePaths);
    expect(second.oldCoverage.edgeKeys).toEqual(first.oldCoverage.edgeKeys);
    expect(second.newCoverage.nodePaths).toEqual(first.newCoverage.nodePaths);
    expect(second.newCoverage.edgeKeys).toEqual(first.newCoverage.edgeKeys);
    expect(before.newMeaning.namespace).toBe(namespace);
  });
  it('rejects source-context withheld forms rather than accepting a fabricated substring projection', () => {
    for (const source of [
      'Alice said: I prefer short explanations.',
      'If asked, I prefer short explanations.',
      'I prefer short explanations. That was fictional.',
    ]) {
      const envelope = {
        version: 1 as const,
        ...actor,
        bindingRef: binding,
        contentHash: sha(source),
        rawContentHash: sha(source),
        mappingAuthority: 'whole_source' as const,
        humanRegion: { start: 0, end: source.length },
        mappings: [
          { contentStart: 0, contentEnd: source.length, rawStart: 0, rawEnd: source.length },
        ],
        quoteRegions: [],
        explicitIntent: false,
      };
      expect(
        interpretCompositionalPreferencesV2({
          descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
          rawContent: source,
          mappedContent: source,
          envelope,
        }).coverage,
      ).not.toBe('complete');
    }
  });
  it('rejects then/getter/proxy/cyclic/oversized inputs before any Zod raw-object access', () => {
    let calls = 0;
    for (const key of ['then', 'oldMeaning']) {
      const input = {};
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          calls++;
          throw new Error('secret');
        },
      });
      expect(inspect(input)).toMatchObject({
        status: 'unknown_constraints',
        reason: 'invalid_input',
      });
    }
    const proxy = new Proxy(
      {},
      {
        get() {
          calls++;
          throw new Error('secret');
        },
        ownKeys() {
          calls++;
          throw new Error('secret');
        },
        getPrototypeOf() {
          calls++;
          throw new Error('secret');
        },
      },
    );
    expect(inspect(proxy).status).toBe('unknown_constraints');
    expect(calls).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(inspect(cycle).status).toBe('unknown_constraints');
    expect(inspect({ unknown: 'x'.repeat(512 * 1024 + 1) }).status).toBe('unknown_constraints');
  });
  it('propagates cancellation and leaves the supplied meanings unchanged', () => {
    const input = request();
    const before = copy(input);
    const cancelled = new Error('cancelled');
    let checks = 0;
    expect(() =>
      inspect(input, () => {
        if (++checks === 12) throw cancelled;
      }),
    ).toThrow(cancelled);
    expect(checks).toBe(12);
    expect(input).toEqual(before);
  });
});
