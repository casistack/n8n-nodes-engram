import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import * as AutomaticCaptureSchema from '../../../src/schemas/AutomaticCapture.schema';
import { GraphDataSchema, type GraphData } from '../../../src/schemas/GraphData.schema';
import { canonicalAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from '../../../src/storage/BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from '../../../src/storage/LosslessAutomaticCaptureGraph';

/** Verbatim copy of the pre-fast-path normalization check, used as the differential oracle. */
function oldParseLossless(value: unknown): GraphData {
  const bounded = cloneBoundedAutomaticCaptureJson<GraphData>(value, 'graph');
  const parsed = GraphDataSchema.parse(bounded);
  const beforeRoot = bounded as unknown as Record<string, unknown>;
  const afterRoot = parsed as unknown as Record<string, unknown>;
  if (
    canonicalAutomaticCaptureV2(Object.keys(beforeRoot).sort()) !==
    canonicalAutomaticCaptureV2(Object.keys(afterRoot).sort())
  )
    throw new Error('Engram automatic capture: record_normalization');
  for (const key of Object.keys(beforeRoot)) {
    if (['entities', 'edges', 'episodes', 'automatic_operations_v1'].includes(key)) continue;
    if (
      canonicalAutomaticCaptureV2(beforeRoot[key]) !== canonicalAutomaticCaptureV2(afterRoot[key])
    )
      throw new Error('Engram automatic capture: record_normalization');
  }
  for (const key of ['entities', 'edges', 'episodes'] as const) {
    if (bounded[key].length !== parsed[key].length)
      throw new Error('Engram automatic capture: record_normalization');
    for (let index = 0; index < bounded[key].length; index++) {
      if (
        canonicalAutomaticCaptureV2(bounded[key][index]) !==
        canonicalAutomaticCaptureV2(parsed[key][index])
      )
        throw new Error('Engram automatic capture: record_normalization');
    }
  }
  const beforeOperations = bounded.automatic_operations_v1?.operations ?? [];
  const afterOperations = parsed.automatic_operations_v1?.operations ?? [];
  if (beforeOperations.length !== afterOperations.length)
    throw new Error('Engram automatic capture: record_normalization');
  for (let index = 0; index < beforeOperations.length; index++) {
    if (
      canonicalAutomaticCaptureV2(beforeOperations[index]) !==
      canonicalAutomaticCaptureV2(afterOperations[index])
    )
      throw new Error('Engram automatic capture: record_normalization');
  }
  return parsed;
}

type Outcome = { ok: true; value: string } | { ok: false; name: string; message: string };

function outcome(parse: (value: unknown) => GraphData, input: unknown): Outcome {
  try {
    return { ok: true, value: canonicalAutomaticCaptureV2(parse(input)) };
  } catch (error) {
    const failure = error as Error;
    return { ok: false, name: failure.constructor.name, message: failure.message };
  }
}

function nestedLarge(depth: number, width: number): Record<string, unknown> {
  const build = (level: number): unknown =>
    level === 0
      ? { leaf: 'x'.repeat(256), numbers: [0, 1.5, -2, 1e21], flag: true, none: null }
      : {
          list: Array.from({ length: width }, (_, index) => ({ index, child: build(level - 1) })),
          text: `level-${level}`,
        };
  return { big: build(depth) };
}

function reverseKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).reverse()) as T;
}

interface CorpusCase {
  readonly name: string;
  readonly build: () => unknown;
  readonly jsonSafe: boolean;
}

function withEntityAttributes(attributes: Record<string, unknown>): unknown {
  const { graph } = makeHumanFixture();
  graph.entities[0].attributes = { ...graph.entities[0].attributes, ...attributes };
  return graph;
}

const corpus: CorpusCase[] = [
  { name: 'unmodified fixture', build: () => makeHumanFixture().graph, jsonSafe: true },
  {
    name: 'nested large attributes',
    build: () => withEntityAttributes(nestedLarge(4, 3)),
    jsonSafe: true,
  },
  {
    name: 'record key reorder',
    build: () => {
      const { graph } = makeHumanFixture();
      graph.entities[0] = reverseKeys(graph.entities[0]);
      graph.episodes[0] = reverseKeys(graph.episodes[0]);
      return reverseKeys(graph as unknown as Record<string, unknown>);
    },
    jsonSafe: true,
  },
  {
    name: 'nested attribute key reorder',
    build: () => withEntityAttributes({ a: reverseKeys({ z: 1, y: { q: 1, p: 2 }, x: [1, 2] }) }),
    jsonSafe: true,
  },
  {
    name: 'undefined attribute',
    build: () => withEntityAttributes({ u: undefined }),
    jsonSafe: false,
  },
  {
    name: 'undefined array element',
    build: () => withEntityAttributes({ u: [1, undefined] }),
    jsonSafe: false,
  },
  {
    name: 'negative zero',
    build: () => withEntityAttributes({ z: -0, n: [-0, 0] }),
    jsonSafe: true,
  },
  { name: 'NaN', build: () => withEntityAttributes({ v: Number.NaN }), jsonSafe: false },
  { name: 'Infinity', build: () => withEntityAttributes({ v: Infinity }), jsonSafe: false },
  { name: 'Date', build: () => withEntityAttributes({ d: new Date(0) }), jsonSafe: false },
  { name: 'Map', build: () => withEntityAttributes({ m: new Map([['k', 1]]) }), jsonSafe: false },
  {
    name: 'getter',
    build: () => {
      const attributes: Record<string, unknown> = {};
      Object.defineProperty(attributes, 'g', { enumerable: true, get: () => 1 });
      return withEntityAttributes({ nested: attributes });
    },
    jsonSafe: false,
  },
  {
    name: 'proxy',
    build: () => withEntityAttributes({ p: new Proxy({ a: 1 }, {}) }),
    jsonSafe: false,
  },
  {
    name: 'cycle',
    build: () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return withEntityAttributes({ c: cyclic });
    },
    jsonSafe: false,
  },
  {
    name: 'class instance',
    build: () => withEntityAttributes({ k: new (class Synthetic {})() }),
    jsonSafe: false,
  },
  {
    name: 'own __proto__ attribute',
    build: () =>
      withEntityAttributes(JSON.parse('{"__proto__":{"synthetic":"preserve"}}') as object as never),
    jsonSafe: true,
  },
  {
    name: 'nested own __proto__ data',
    build: () =>
      withEntityAttributes({
        nested: JSON.parse('{"__proto__":{"value":"retained data"}}') as unknown,
      }),
    jsonSafe: true,
  },
  {
    name: 'unknown root field',
    build: () => ({ ...makeHumanFixture().graph, synthetic_unknown_root: { v: 1 } }),
    jsonSafe: true,
  },
  {
    name: 'root metadata with own __proto__',
    build: () => ({
      ...makeHumanFixture().graph,
      metadata: JSON.parse('{"__proto__":{"synthetic":"preserve"}}') as unknown,
    }),
    jsonSafe: true,
  },
  {
    name: 'same-shaped value change (untrimmed sender_name)',
    build: () => {
      const { graph } = makeHumanFixture();
      graph.episodes[0].sender_name = '  Synthetic Sender  ';
      return graph;
    },
    jsonSafe: true,
  },
  {
    name: 'default-normalized record (removed field)',
    build: () => {
      const { graph } = makeHumanFixture();
      delete (graph.entities[0] as unknown as Record<string, unknown>).attributes;
      return graph;
    },
    jsonSafe: true,
  },
  {
    name: 'default-normalized record (removed summary)',
    build: () => {
      const { graph } = makeHumanFixture();
      delete (graph.entities[0] as unknown as Record<string, unknown>).summary;
      return graph;
    },
    jsonSafe: true,
  },
  {
    name: 'beyond bounded depth',
    build: () => {
      let deep: Record<string, unknown> = { end: 1 };
      for (let index = 0; index < 80; index++) deep = { deep };
      return withEntityAttributes({ deep });
    },
    jsonSafe: true,
  },
];

describe('lossless equality fast path differential', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(corpus.map((entry) => [entry.name, entry] as const))(
    'keeps the old verdict and error class for %s',
    (_name, entry) => {
      // ONE generated input: fixtures embed fresh UUIDs/hashes per build, and both
      // parsers clone their input, so sharing it is safe and keeps outputs comparable.
      const input = entry.build();
      const before = entry.jsonSafe ? JSON.stringify(input) : undefined;
      const expected = outcome(oldParseLossless, input);
      const actual = outcome(parseLosslessAutomaticCaptureGraph, input);
      expect(actual).toEqual(expected);
      if (before !== undefined) expect(JSON.stringify(input)).toBe(before);
    },
  );

  it('covers both accepting and rejecting verdicts of the old implementation', () => {
    const outcomes = corpus.map((entry) => outcome(oldParseLossless, entry.build()));
    expect(outcomes.some((entry) => entry.ok)).toBe(true);
    expect(
      outcomes.some((entry) => !entry.ok && entry.message.includes('record_normalization')),
    ).toBe(true);
    expect(
      outcomes.some((entry) => !entry.ok && entry.name === 'BoundedAutomaticCaptureJsonError'),
    ).toBe(true);
  });

  /**
   * Calls of the canonical recipe made by the lossless comparison, observed AFTER the
   * fixture exists. GraphDataSchema.parse legitimately calls the recipe itself (descriptor
   * and policy hash checks on operations), so those calls are allowed and filtered out:
   *  - record comparisons: an object argument that is an entity/edge/episode (`uuid`) or an
   *    operation (`operationId`) record;
   *  - sorted-root-key comparisons: an array argument made only of strings.
   */
  function observeCanonicalCalls(input: unknown, run: () => unknown) {
    const spy = jest.spyOn(AutomaticCaptureSchema, 'canonicalAutomaticCaptureV2');
    spy.mockClear();
    const result = outcomeOf(run);
    const args = spy.mock.calls.map(([value]) => value);
    spy.mockRestore();
    const isRecord = (value: unknown) =>
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ('uuid' in (value as object) || 'operationId' in (value as object));
    return {
      result,
      recordCalls: args.filter(isRecord),
      rootKeyCalls: args.filter(
        (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
      ) as string[][],
      input,
    };
  }

  function outcomeOf(run: () => unknown): Outcome {
    try {
      run();
      return { ok: true, value: '' };
    } catch (error) {
      const failure = error as Error;
      return { ok: false, name: failure.constructor.name, message: failure.message };
    }
  }

  it('builds no canonical strings per record when every subtree is provably equal', () => {
    const graph = withEntityAttributes(nestedLarge(4, 3)) as GraphData; // fixture built BEFORE the spy
    const observed = observeCanonicalCalls(graph, () => parseLosslessAutomaticCaptureGraph(graph));
    expect(observed.result.ok).toBe(true);
    expect(observed.recordCalls).toHaveLength(0);
    // Exactly the two sorted-root-key comparisons (before and after Zod).
    const expectedKeys = Object.keys(graph).sort();
    expect(observed.rootKeyCalls).toEqual([expectedKeys, expectedKeys]);
  });

  it('treats a nested own __proto__ attribute as reference-identical (legitimate fast ===)', () => {
    const graph = withEntityAttributes({
      nested: JSON.parse('{"__proto__":{"value":"retained data"}}') as unknown,
    }) as GraphData;
    const observed = observeCanonicalCalls(graph, () => parseLosslessAutomaticCaptureGraph(graph));
    expect(observed.result.ok).toBe(true);
    expect(observed.recordCalls).toHaveLength(0);
  });

  const fallbackCases: Array<[string, () => GraphData, string]> = [
    [
      'sender_name.trim changes a same-shaped value',
      () => {
        const { graph } = makeHumanFixture();
        graph.episodes[0].sender_name = '  Synthetic Sender  ';
        return graph;
      },
      'episodes',
    ],
    [
      'an own __proto__ entity attribute is not normalized away',
      () =>
        withEntityAttributes(
          JSON.parse('{"__proto__":{"synthetic":"preserve"}}') as Record<string, unknown>,
        ) as GraphData,
      'entities',
    ],
  ];

  it.each(fallbackCases)(
    'rejects with the old exact reason and runs the canonical fallback when %s',
    (_name, build) => {
      const input = build(); // ONE input, fixture built before any spy
      const before = JSON.stringify(input);
      const oldVerdict = outcome(oldParseLossless, input);
      expect(oldVerdict).toMatchObject({
        ok: false,
        message: 'Engram automatic capture: record_normalization',
      });
      const observed = observeCanonicalCalls(input, () =>
        parseLosslessAutomaticCaptureGraph(input),
      );
      expect(observed.result).toEqual({
        ok: false,
        name: (oldVerdict as { name: string }).name,
        message: (oldVerdict as { message: string }).message,
      });
      // The fast path could not prove equality, so the canonical comparison of the
      // offending record (bounded copy and parsed copy) really executed.
      expect(observed.recordCalls.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(input)).toBe(before);
    },
  );
});

/*
 * Coverage note: the undefined, NaN, Infinity, Date, Map, getter, proxy, cycle, class-instance
 * and excess-depth corpus cases above are rejected by cloneBoundedAutomaticCaptureJson before
 * the equality helper runs. They prove the public verdict is unchanged, not that the private
 * helper's guard branches execute. The helper is deliberately not exported. The only cases
 * here that make the helper return "unknown" and force the canonical fallback are the
 * sender_name.trim value change (same keys, different value) and the own `__proto__` entity
 * attribute, both verified through the canonical-call observation above. A nested own
 * `__proto__` attribute is reference-identical between the clone and Zod's output, so it
 * is decided by the legitimate `===` shortcut and does not exercise the fallback.
 */
