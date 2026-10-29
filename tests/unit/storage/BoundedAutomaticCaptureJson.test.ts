import { runInNewContext } from 'vm';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from '../../../src/storage/BoundedAutomaticCaptureJson';

describe('bounded automatic capture JSON clone', () => {
  it('tightens only the new policy data mode for bytes, nodes and depth', () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20; index++) deep = { child: deep };
    for (const [value, reason] of [
      [{ value: 'x'.repeat(20_000) }, 'bytes'],
      [{ values: Array(600).fill(true) }, 'nodes'],
      [deep, 'depth'],
    ] as const) {
      expect(cloneBoundedAutomaticCaptureJson(value, 'beginRequest')).toEqual(value);
      try {
        cloneBoundedAutomaticCaptureJson(value, 'policyData');
        throw new Error('Expected the policy data ceiling to reject input');
      } catch (error) {
        expect(error).toBeInstanceOf(BoundedAutomaticCaptureJsonError);
        expect((error as BoundedAutomaticCaptureJsonError).reason).toBe(reason);
      }
    }
  });

  it('accepts structuredClone and genuine cross-realm plain objects', () => {
    const original = { request: { source: { content: 'hello' } }, list: [1, 2] };
    const cloned = cloneBoundedAutomaticCaptureJson<typeof original>(
      structuredClone(original),
      'beginRequest',
    );
    expect(cloned).toEqual(original);

    const crossRealm = runInNewContext('({ request: { source: { content: "hello" } } })');
    expect(cloneBoundedAutomaticCaptureJson(crossRealm, 'beginRequest')).toEqual({
      request: { source: { content: 'hello' } },
    });
  });

  it('continues to reject class instances and fake native Object constructors', () => {
    class CustomRecord {
      value = 'no';
    }
    const FakeObject = function Object() {};
    Object.setPrototypeOf(FakeObject.prototype, null);
    const fake = Object.create(FakeObject.prototype) as Record<string, unknown>;
    Object.defineProperty(fake, 'value', { value: 'no', enumerable: true });

    expect(() => cloneBoundedAutomaticCaptureJson(new CustomRecord(), 'beginRequest')).toThrow(
      'bounded_json_invalid',
    );
    expect(() => cloneBoundedAutomaticCaptureJson(fake, 'beginRequest')).toThrow(
      'bounded_json_invalid',
    );
  });

  it('does not execute constructor name or prototype accessors while rejecting fake realms', () => {
    let traps = 0;
    const namePrototype = Object.create(null) as Record<string, unknown>;
    const nameConstructor = function FakeConstructor() {};
    Object.defineProperty(nameConstructor, 'name', {
      get: () => {
        traps += 1;
        return 'Object';
      },
    });
    Object.defineProperty(nameConstructor, 'prototype', { value: namePrototype });
    Object.defineProperty(namePrototype, 'constructor', { value: nameConstructor });

    const getterPrototype = Object.create(null) as Record<string, unknown>;
    const prototypeConstructor = () => undefined;
    Object.defineProperty(prototypeConstructor, 'name', { value: 'Object' });
    Object.defineProperty(prototypeConstructor, 'prototype', {
      get: () => {
        traps += 1;
        return getterPrototype;
      },
    });
    Object.defineProperty(getterPrototype, 'constructor', { value: prototypeConstructor });

    for (const prototype of [namePrototype, getterPrototype]) {
      const value = Object.create(prototype) as Record<string, unknown>;
      for (const bound of ['beginRequest', 'assistantIntent', 'policyData'] as const) {
        expect(() => cloneBoundedAutomaticCaptureJson(value, bound)).toThrow(
          'bounded_json_invalid',
        );
        expect(() => cloneBoundedAutomaticCaptureJson({ nested: value }, bound)).toThrow(
          'bounded_json_invalid',
        );
      }
    }
    expect(traps).toBe(0);
  });

  it('reports bounded resource failures separately from malformed JSON-like data', () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    for (const [value, bound, reason] of [
      [{ value: 'x'.repeat(512 * 1024) }, 'beginRequest', 'bytes'],
      [{ entities: [], edges: [], episodes: Array(100_001).fill(null) }, 'graph', 'nodes'],
      [deep, 'beginRequest', 'depth'],
      [
        Object.defineProperty({}, 'value', { enumerable: true, get: () => 'no' }),
        'beginRequest',
        'invalid_json',
      ],
    ] as const) {
      try {
        cloneBoundedAutomaticCaptureJson(value, bound);
        throw new Error('Expected the bounded JSON clone to reject input');
      } catch (error) {
        expect(error).toBeInstanceOf(BoundedAutomaticCaptureJsonError);
        expect((error as BoundedAutomaticCaptureJsonError).reason).toBe(reason);
        expect((error as Error).message).toBe('Engram automatic memory: bounded_json_invalid');
      }
    }
  });

  it('uses a separate 1 MiB assistant intent bound for two maximum escaped sources', () => {
    const value = {
      human: '\u0001'.repeat(65_536),
      assistant: '\u0002'.repeat(65_536),
    };
    const cloned = cloneBoundedAutomaticCaptureJson<typeof value>(value, 'assistantIntent');
    expect(cloned.human).toHaveLength(65_536);
    expect(cloned.assistant).toHaveLength(65_536);
    expect(() => cloneBoundedAutomaticCaptureJson(value, 'beginRequest')).toThrow(
      BoundedAutomaticCaptureJsonError,
    );

    const oversized = { ...value, extra: '\u0003'.repeat(180_000) };
    try {
      cloneBoundedAutomaticCaptureJson(oversized, 'assistantIntent');
      throw new Error('Expected the assistant intent bound to reject oversized input');
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedAutomaticCaptureJsonError);
      expect((error as BoundedAutomaticCaptureJsonError).reason).toBe('bytes');
    }
  });

  it('classifies missing or accessor-backed plan arrays as malformed JSON-like input', () => {
    const accessorPlan: Record<string, unknown> = {
      entities: [],
      edges: [],
    };
    Object.defineProperty(accessorPlan, 'source_guards', {
      enumerable: true,
      get: () => [],
    });

    for (const value of [{}, accessorPlan]) {
      expect(() => cloneBoundedAutomaticCaptureJson(value, 'plan')).toThrow(
        BoundedAutomaticCaptureJsonError,
      );
      try {
        cloneBoundedAutomaticCaptureJson(value, 'plan');
      } catch (error) {
        expect((error as BoundedAutomaticCaptureJsonError).reason).toBe('invalid_json');
      }
    }
  });
});
