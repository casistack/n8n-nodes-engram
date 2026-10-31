import * as current from '../../../src/storage/BoundedAutomaticCaptureJson';
import * as reference from '../../helpers/boundedAutomaticCaptureJson081Reference';

type Bound = current.AutomaticCaptureJsonBound;
interface CompatibilityCase {
  name: string;
  bound: Bound;
  make: () => unknown;
}
interface Comparison {
  ok: boolean;
  problems: string[];
}
interface CompatibilitySuite {
  corpus(): CompatibilityCase[];
  compareCase(name: string, bound: Bound, make: () => unknown): Comparison;
  detectorSelfTest(): { ok: boolean; undetected: string[] };
  rng(seed: number): () => number;
  genValue(random: () => number, depth: number, invalidRate: number): unknown;
}
const createSuite: (
  oldModule: typeof reference,
  newModule: typeof current,
) => CompatibilitySuite = require('../../helpers/boundedJsonCompatibilityCases.cjs');
const suite = createSuite(reference, current);

function equivalent(name: string, bound: Bound, make: () => unknown): void {
  const result = suite.compareCase(name, bound, make);
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
}

describe('bounded JSON clone compatibility with 0.8.1', () => {
  it('detects mutations rather than comparing an input with itself', () => {
    expect(suite.detectorSelfTest()).toMatchObject({ ok: true, undetected: [] });
  });

  it.each(suite.corpus())('$name', ({ name, bound, make }) => {
    equivalent(name, bound, make);
  });

  it.each<Bound>(['policyData', 'beginRequest', 'assistantIntent', 'plan', 'graph'])(
    'preserves nested arrays and descriptors under %s',
    (bound) => {
      const make = () => ({
        source_guards: [{}],
        entities: [],
        edges: [],
        episodes: [],
        data: { values: [-0, null, true, ['\u0000', '\ud800', 'British English']] },
      });
      equivalent(`all bounds ${bound}`, bound, make);
      // The corpus also covers rejected array roots; this explicitly reaches a valid
      // nested array for every named bound.
      expect(() => current.cloneBoundedAutomaticCaptureJson(make(), bound)).not.toThrow();
    },
  );

  it('keeps __proto__ as an own data property without polluting any prototype', () => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const input = JSON.parse('{"__proto__":{"synthetic_pollution":true},"constructor":1}');
    const output = current.cloneBoundedAutomaticCaptureJson<Record<string, unknown>>(
      input,
      'beginRequest',
    );
    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(output, '__proto__')).toMatchObject({
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
    expect(Object.getOwnPropertyDescriptor({}, 'synthetic_pollution')).toBeUndefined();
    expect(({} as Record<string, unknown>).synthetic_pollution).toBeUndefined();
  });

  it.each([-1, 0, 1])('preserves the policy node boundary at offset %i', (offset) => {
    const make = () => {
      // The frozen policy counts values and own keys (including array length).
      const values: unknown[] = new Array(offset === 0 ? 510 : 509).fill(null);
      if (offset !== 0) values[0] = offset < 0 ? [] : [null];
      return { a: values };
    };
    equivalent(`node cap ${offset}`, 'policyData', make);
    if (offset > 0) {
      expect(() => current.cloneBoundedAutomaticCaptureJson(make(), 'policyData')).toThrow(
        expect.objectContaining({ reason: 'nodes' }),
      );
    } else {
      expect(() => current.cloneBoundedAutomaticCaptureJson(make(), 'policyData')).not.toThrow();
    }
  });

  it.each<Bound>(['policyData', 'beginRequest', 'assistantIntent', 'plan', 'graph'])(
    'keeps depth checks at the exact %s boundary',
    (bound) => {
      for (const offset of [-1, 0, 1]) {
        const make = () => {
          let payload: unknown = null;
          for (
            let depth = 0;
            depth < current.AUTOMATIC_CAPTURE_JSON_BOUNDS[bound].maxDepth - 1 + offset;
            depth++
          ) {
            payload = { a: payload };
          }
          return { source_guards: [{}], entities: [], edges: [], episodes: [], payload };
        };
        equivalent(`depth ${bound} ${offset}`, bound, make);
        if (offset > 0) {
          expect(() => current.cloneBoundedAutomaticCaptureJson(make(), bound)).toThrow(
            expect.objectContaining({ reason: 'depth' }),
          );
        } else {
          expect(() => current.cloneBoundedAutomaticCaptureJson(make(), bound)).not.toThrow();
        }
      }
    },
  );

  it.each<Bound>(['policyData', 'beginRequest', 'assistantIntent'])(
    'preserves ASCII byte checks immediately around the %s cap',
    (bound) => {
      for (const offset of [-1, 0, 1]) {
        const make = () => ({
          a: 'x'.repeat(current.AUTOMATIC_CAPTURE_JSON_BOUNDS[bound].maxBytes - 8 + offset),
        });
        equivalent(`bytes ${bound} ${offset}`, bound, make);
        if (offset > 0) {
          expect(() => current.cloneBoundedAutomaticCaptureJson(make(), bound)).toThrow(
            expect.objectContaining({ reason: 'bytes' }),
          );
        } else {
          expect(() => current.cloneBoundedAutomaticCaptureJson(make(), bound)).not.toThrow();
        }
      }
    },
  );

  it('rejects getters without invoking them', () => {
    const getter = jest.fn(() => 'untrusted');
    const make = () => Object.defineProperty({}, 'value', { get: getter, enumerable: true });
    equivalent('getter remains inert', 'beginRequest', make);
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not define cloned object properties through Object.defineProperty', () => {
    const define = jest.spyOn(Object, 'defineProperty');
    let output: { nested: object };
    let branchCalls: unknown[];
    try {
      output = current.cloneBoundedAutomaticCaptureJson({ nested: { value: 1 } }, 'beginRequest');
      branchCalls = define.mock.calls.filter(
        ([target]) => target === output || target === output.nested,
      );
    } finally {
      define.mockRestore();
    }
    expect(branchCalls!).toEqual([]);
  });

  it.each([20260101, 20261031])('preserves values and first failures for seed %i', (seed) => {
    for (let index = 0; index < 200; index += 1) {
      const bound = index % 5 === 0 ? 'policyData' : 'beginRequest';
      equivalent(`seed ${seed} case ${index}`, bound, () =>
        suite.genValue(suite.rng((seed + index * 7919) >>> 0), 0, index % 3 === 0 ? 0.02 : 0),
      );
    }
  });
});
