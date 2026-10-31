/* eslint-disable @typescript-eslint/no-explicit-any */
import { runInNewContext } from 'vm';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import { provenIdenticalLosslessGraphData } from '../../../src/storage/LosslessAutomaticCaptureGraph';

/** Structural walker input only: the proof never validates schemas, so plain shapes suffice. */
function baseGraph(): Record<string, unknown> {
  return {
    version: '2.0',
    exported_at: '2026-10-30T00:00:00.000Z',
    group_id: 'synthetic-group',
    metadata: { extraction_epoch: 'epoch-1', note: 'synthetic' },
    entities: [{ uuid: 'e1', name: 'Entity', attributes: { list: [1, 2.5, { deep: null }] } }],
    edges: [{ uuid: 'd1', fact: 'Fact', attributes: { flag: true } }],
    episodes: [{ uuid: 'p1', content: 'Content', attributes: { text: 'x' } }],
    automatic_operations_v1: {
      version: 1,
      operations: [{ operationId: 'o1', state: 'committed', identity: { turn: 't' } }],
    },
  };
}

const asGraph = (value: unknown) => value as GraphData;

function prove(
  left: unknown,
  right: unknown,
  options?: { check?: () => void; maxNodes?: number },
): boolean {
  return provenIdenticalLosslessGraphData(asGraph(left), asGraph(right), options);
}

function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, child]) => [key, reorderKeys(child)]),
    );
  }
  return value;
}

function mutated(change: (graph: Record<string, any>) => void): Record<string, unknown> {
  // baseGraph() builds fresh in-realm objects on every call. structuredClone must NOT be
  // used: under Jest it returns foreign-realm prototypes, which the proof rejects by design.
  const graph = baseGraph() as Record<string, any>;
  change(graph);
  return graph;
}

describe('provenIdenticalLosslessGraphData', () => {
  it('proves identical graphs', () => {
    expect(prove(baseGraph(), baseGraph())).toBe(true);
    const shared = baseGraph();
    expect(prove(shared, shared)).toBe(true);
  });

  it('ignores key order everywhere', () => {
    expect(prove(baseGraph(), reorderKeys(baseGraph()))).toBe(true);
  });

  it('accepts null-prototype and ordinary objects interchangeably', () => {
    const nullProto = Object.assign(Object.create(null), { a: 1, b: { c: 'x' } }) as object;
    const left = mutated((graph) => {
      graph.metadata = { a: 1, b: { c: 'x' } };
    });
    const right = mutated((graph) => {
      graph.metadata = nullProto;
    });
    expect(prove(left, right)).toBe(true);
  });

  it.each([
    ['version', (graph: Record<string, any>) => (graph.version = '1.0')],
    ['exported_at', (graph: Record<string, any>) => (graph.exported_at = '2027-01-01T00:00:00Z')],
    ['group_id', (graph: Record<string, any>) => (graph.group_id = 'other')],
    ['metadata entry', (graph: Record<string, any>) => (graph.metadata.note = 'changed')],
    ['an entity', (graph: Record<string, any>) => (graph.entities[0].name = 'Changed')],
    ['an edge', (graph: Record<string, any>) => (graph.edges[0].fact = 'Changed')],
    ['an episode', (graph: Record<string, any>) => (graph.episodes[0].content = 'Changed')],
    [
      'a ledger operation',
      (graph: Record<string, any>) => (graph.automatic_operations_v1.operations[0].state = 'x'),
    ],
    [
      'a nested value',
      (graph: Record<string, any>) => (graph.entities[0].attributes.list[2].deep = 'not null'),
    ],
  ])('returns false when %s differs', (_name, change) => {
    expect(prove(baseGraph(), mutated(change))).toBe(false);
    expect(prove(mutated(change), baseGraph())).toBe(false);
  });

  it('returns false for one-sided and renamed keys at the root and nested', () => {
    const extraRoot = mutated((graph) => {
      graph.synthetic_unknown_root = 1;
    });
    expect(prove(baseGraph(), extraRoot)).toBe(false);
    expect(prove(extraRoot, baseGraph())).toBe(false);
    const missingRoot = mutated((graph) => {
      delete graph.metadata;
    });
    expect(prove(baseGraph(), missingRoot)).toBe(false);
    expect(prove(missingRoot, baseGraph())).toBe(false);
    const renamed = mutated((graph) => {
      graph.metadata = { extraction_epoch: 'epoch-1', other_key: 'synthetic' };
    });
    expect(prove(baseGraph(), renamed)).toBe(false);
    const nestedExtra = mutated((graph) => {
      graph.entities[0].attributes.extra = true;
    });
    expect(prove(baseGraph(), nestedExtra)).toBe(false);
  });

  it('returns false for array length and element type differences', () => {
    const longer = mutated((graph) => {
      graph.entities[0].attributes.list.push(3);
    });
    expect(prove(baseGraph(), longer)).toBe(false);
    expect(prove(longer, baseGraph())).toBe(false);
    const arrayVsObject = mutated((graph) => {
      graph.entities[0].attributes.list = { 0: 1, 1: 2.5, 2: { deep: null } };
    });
    expect(prove(baseGraph(), arrayVsObject)).toBe(false);
    expect(prove(arrayVsObject, baseGraph())).toBe(false);
  });

  it('rejects a plain-looking object from a foreign realm (only this realm Object.prototype is plain)', () => {
    const foreign = runInNewContext(
      '({ extraction_epoch: "epoch-1", note: "synthetic" })',
    ) as object;
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    const inRealm = mutated(() => undefined);
    const withForeign = mutated((graph) => {
      graph.metadata = foreign;
    });
    expect(prove(inRealm, withForeign)).toBe(false);
    expect(prove(withForeign, withForeign)).toBe(false);
    const foreignArray = runInNewContext('[1, 2]') as unknown[];
    const arrays = (value: unknown) =>
      mutated((graph) => {
        graph.entities[0].attributes.list = value;
      });
    // Arrays are identified with Array.isArray, which is realm-independent.
    expect(prove(arrays(foreignArray), arrays([1, 2]))).toBe(true);
  });

  it('treats -0 and 0 as identical (same canonical form)', () => {
    const zero = mutated((graph) => {
      graph.entities[0].attributes.z = 0;
    });
    const negativeZero = mutated((graph) => {
      graph.entities[0].attributes.z = -0;
    });
    expect(prove(zero, negativeZero)).toBe(true);
    expect(prove(negativeZero, zero)).toBe(true);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['undefined', undefined],
    ['bigint', (globalThis as unknown as { BigInt: (value: number) => unknown }).BigInt(1)],
    ['symbol', Symbol('synthetic')],
    ['function', () => 1],
  ])('returns false for a non-JSON primitive (%s) even when both sides hold it', (_n, value) => {
    const make = () =>
      mutated((graph) => {
        graph.entities[0].attributes.v = value;
      });
    expect(prove(make(), make())).toBe(false);
  });

  it('returns false on a type mismatch of equal-looking primitives', () => {
    const number = mutated((graph) => {
      graph.entities[0].attributes.v = 1;
    });
    const text = mutated((graph) => {
      graph.entities[0].attributes.v = '1';
    });
    expect(prove(number, text)).toBe(false);
  });

  describe('a SHARED nested object (same reference on both sides) is still inspected', () => {
    class Synthetic {
      value = 1;
    }
    const hostile: Array<[string, () => unknown]> = [
      [
        'getter',
        () => {
          const target: Record<string, unknown> = {};
          Object.defineProperty(target, 'g', { enumerable: true, get: () => 1 });
          return target;
        },
      ],
      [
        'setter-only accessor',
        () => {
          const target: Record<string, unknown> = {};
          Object.defineProperty(target, 's', { enumerable: true, set: () => undefined });
          return target;
        },
      ],
      ['Proxy', () => new Proxy({ a: 1 }, {})],
      ['undefined value', () => ({ u: undefined })],
      ['NaN', () => ({ n: Number.NaN })],
      ['Infinity', () => ({ n: Infinity })],
      ['Date', () => new Date(0)],
      ['Map', () => new Map([['k', 1]])],
      [
        'array hole',
        () => {
          // eslint-disable-next-line no-sparse-arrays
          return [1, , 3];
        },
      ],
      ['class instance', () => new Synthetic()],
      [
        'non-enumerable property',
        () => Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }),
      ],
      ['symbol key', () => ({ [Symbol('k')]: 1 })],
      ['own __proto__ key', () => JSON.parse('{"__proto__":{"x":1}}') as unknown],
    ];

    it.each(hostile)('returns false for a shared %s and does not throw', (_name, build) => {
      const shared = build();
      const left = mutated((graph) => {
        graph.entities[0].attributes.shared = shared;
      });
      const right = mutated((graph) => {
        graph.entities[0].attributes.shared = shared;
      });
      expect(() => prove(left, right)).not.toThrow();
      expect(prove(left, right)).toBe(false);
    });

    it('does not take an identity shortcut for a shared clean object either (inspects it)', () => {
      const shared = { a: [1, { b: 'x' }] };
      const left = mutated((graph) => {
        graph.entities[0].attributes.shared = shared;
      });
      const right = mutated((graph) => {
        graph.entities[0].attributes.shared = shared;
      });
      expect(prove(left, right)).toBe(true);
    });

    it('rejects a hostile root', () => {
      const root = baseGraph();
      Object.defineProperty(root, 'metadata', { enumerable: true, get: () => ({}) });
      expect(prove(root, root)).toBe(false);
      expect(prove([], [])).toBe(false);
      expect(prove(null, null)).toBe(false);
      expect(prove(new Proxy(baseGraph(), {}), baseGraph())).toBe(false);
    });
  });

  describe('bounds', () => {
    function chain(length: number): Record<string, unknown> {
      let node: Record<string, unknown> = { end: 1 };
      for (let index = 0; index < length; index += 1) node = { next: node };
      return node;
    }

    it('proves a moderately deep graph and rejects depth beyond the bounded clone depth', () => {
      const ok = () =>
        mutated((graph) => {
          graph.entities[0].attributes.chain = chain(20);
        });
      expect(prove(ok(), ok())).toBe(true);
      const deep = () =>
        mutated((graph) => {
          graph.entities[0].attributes.chain = chain(70);
        });
      expect(prove(deep(), deep())).toBe(false);
    });

    it('returns false when the node cap is lower than the graph and true otherwise', () => {
      expect(prove(baseGraph(), baseGraph(), { maxNodes: 3 })).toBe(false);
      expect(prove(baseGraph(), baseGraph(), { maxNodes: 10_000 })).toBe(true);
      expect(prove(baseGraph(), baseGraph(), { maxNodes: 0 })).toBe(false);
    });

    it('accepts a cap exactly equal to the visited node count and rejects one fewer', () => {
      let exact = -1;
      for (let cap = 0; cap < 500 && exact < 0; cap += 1) {
        if (prove(baseGraph(), baseGraph(), { maxNodes: cap })) exact = cap;
      }
      expect(exact).toBeGreaterThan(3);
      expect(prove(baseGraph(), baseGraph(), { maxNodes: exact })).toBe(true);
      expect(prove(baseGraph(), baseGraph(), { maxNodes: exact - 1 })).toBe(false);
    });

    it('cannot raise the cap and ignores an invalid cap', () => {
      expect(prove(baseGraph(), baseGraph(), { maxNodes: Number.MAX_SAFE_INTEGER })).toBe(true);
      expect(prove(baseGraph(), baseGraph(), { maxNodes: Number.NaN })).toBe(true);
      expect(prove(baseGraph(), baseGraph(), { maxNodes: -5 })).toBe(true);
    });
  });

  describe('check callback', () => {
    function bigGraph(): Record<string, unknown> {
      return mutated((graph) => {
        graph.entities[0].attributes.many = Array.from({ length: 3000 }, (_, index) => index);
      });
    }

    it('runs at the start and at the end', () => {
      const check = jest.fn();
      expect(prove(baseGraph(), baseGraph(), { check })).toBe(true);
      expect(check).toHaveBeenCalledTimes(2);
    });

    it('runs periodically on large graphs', () => {
      const check = jest.fn();
      expect(prove(bigGraph(), bigGraph(), { check })).toBe(true);
      expect(check.mock.calls.length).toBeGreaterThan(2);
    });

    it.each([1, 2])('propagates an exception thrown by the %ith check (start/end)', (nth) => {
      const failure = new Error('synthetic check failure');
      let calls = 0;
      const check = () => {
        calls += 1;
        if (calls === nth) throw failure;
      };
      expect(() => prove(baseGraph(), baseGraph(), { check })).toThrow(failure);
    });

    it('propagates an exception thrown mid-walk instead of returning false', () => {
      const failure = new Error('synthetic mid-walk failure');
      let calls = 0;
      const check = () => {
        calls += 1;
        if (calls === 2) throw failure;
      };
      expect(() => prove(bigGraph(), bigGraph(), { check })).toThrow(failure);
    });

    it('propagates a check exception even when the graphs differ', () => {
      const failure = new Error('synthetic differing failure');
      const check = () => {
        throw failure;
      };
      expect(() =>
        prove(
          baseGraph(),
          mutated((graph) => (graph.version = '1.0')),
          { check },
        ),
      ).toThrow(failure);
    });

    /** Runs the proof and reports whether it threw, and exactly what, even for falsy values. */
    function outcomeOfProof(left: unknown, right: unknown, check: () => void) {
      let didThrow = false;
      let thrown: unknown;
      let returned: boolean | undefined;
      try {
        returned = prove(left, right, { check });
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      return { didThrow, thrown, returned };
    }

    /** Number of check calls a quiet run of the same inputs makes (start + periodic + end). */
    function totalChecks(left: unknown, right: unknown): number {
      const counter = jest.fn();
      prove(left, right, { check: counter });
      return counter.mock.calls.length;
    }

    const THROWN_VALUES: Array<[string, unknown]> = [
      ['NaN', Number.NaN],
      ['undefined', undefined],
      ['null', null],
      ['0', 0],
      ['empty string', ''],
      ['false', false],
      ['an Error', new Error('synthetic')],
    ];

    describe.each(THROWN_VALUES)('a check that throws %s', (_name, value) => {
      const positions: Array<[string, () => { left: unknown; right: unknown; nth: number }]> = [
        ['at the start', () => ({ left: baseGraph(), right: baseGraph(), nth: 1 })],
        ['mid-walk', () => ({ left: bigGraph(), right: bigGraph(), nth: 2 })],
        [
          'at the end',
          () => {
            const left = bigGraph();
            const right = bigGraph();
            return { left, right, nth: totalChecks(left, right) };
          },
        ],
        [
          'at the end when the graphs differ',
          () => {
            const left = baseGraph();
            const right = mutated((graph) => (graph.version = '1.0'));
            return { left, right, nth: totalChecks(left, right) };
          },
        ],
        [
          'mid-walk when the graphs differ after the checkpoint',
          () => {
            const left = bigGraph();
            const right = bigGraph();
            (
              right.entities as Array<{ attributes: { many: number[] } }>
            )[0]!.attributes.many[2999] = -1;
            return { left, right, nth: 2 };
          },
        ],
      ];

      it.each(positions)('propagates the exact thrown value %s', (_position, build) => {
        const { left, right, nth } = build();
        expect(nth).toBeGreaterThanOrEqual(1);
        let calls = 0;
        const result = outcomeOfProof(left, right, () => {
          calls += 1;
          if (calls === nth) throw value;
        });
        expect(result.didThrow).toBe(true);
        expect(Object.is(result.thrown, value)).toBe(true);
        expect(result.returned).toBeUndefined();
      });
    });

    it('does not turn a hostile graph into a throw when the check is quiet', () => {
      const check = jest.fn();
      const hostileGraph = mutated((graph) => {
        graph.entities[0].attributes.p = new Proxy({}, {});
      });
      expect(prove(hostileGraph, hostileGraph, { check })).toBe(false);
    });
  });

  it('does not mutate or freeze either input', () => {
    const left = baseGraph();
    const right = reorderKeys(baseGraph());
    const leftBefore = JSON.stringify(left);
    const rightBefore = JSON.stringify(right);
    expect(prove(left, right)).toBe(true);
    expect(JSON.stringify(left)).toBe(leftBefore);
    expect(JSON.stringify(right)).toBe(rightBefore);
    expect(Object.isFrozen(left)).toBe(false);
    expect(Object.isFrozen(right)).toBe(false);
  });

  it('works on deeply frozen inputs', () => {
    const freeze = (value: unknown): unknown => {
      if (value !== null && typeof value === 'object') {
        Object.values(value as object).forEach(freeze);
        Object.freeze(value);
      }
      return value;
    };
    expect(prove(freeze(baseGraph()), freeze(baseGraph()))).toBe(true);
  });
});
