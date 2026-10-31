import * as LosslessGraph from '../../../src/storage/LosslessAutomaticCaptureGraph';
import {
  cloneOwnedImmutableGraphData,
  getOwnedImmutableGraphData,
  parseImmutableGraphData,
} from '../../../src/storage/ImmutableGraphSnapshot';
import type { GraphData } from '../../../src/schemas';
import { CURRENT_GRAPH_DATA_VERSION } from '../../../src/schemas/GraphData.schema';

const realParse = LosslessGraph.parseLosslessAutomaticCaptureGraph;

function rawGraph(): Record<string, unknown> {
  const entity: Record<string, unknown> = {
    uuid: '00000000-0000-4000-8000-0000000000b1',
    name: 'Synthetic',
    group_id: 'plan037-unit',
    summary: '',
    entity_type: 'concept',
    name_embedding: [-0, 0.5],
    attributes: { nested: { list: [1, { deep: true }] }, zero: -0 },
    created_at: '2026-10-31T00:00:00.000Z',
    updated_at: '2026-10-31T00:00:00.000Z',
  };
  return {
    version: CURRENT_GRAPH_DATA_VERSION,
    exported_at: '2026-10-31T00:00:00.000Z',
    entities: [entity],
    edges: [],
    episodes: [],
  };
}

/** Walks both values in parallel: same prototypes, keys, values (Object.is), no sharing. */
function expectSameShapeNoSharing(actual: unknown, expected: unknown, owned: unknown): void {
  if (expected === null || typeof expected !== 'object') {
    expect(Object.is(actual, expected)).toBe(true);
    return;
  }
  expect(actual).not.toBe(owned);
  expect(Object.isFrozen(actual)).toBe(false);
  expect(Array.isArray(actual)).toBe(Array.isArray(expected));
  expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(expected));
  expect(Reflect.ownKeys(actual as object)).toEqual(Reflect.ownKeys(expected));
  for (const key of Object.keys(expected)) {
    expectSameShapeNoSharing(
      (actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key],
      (owned as Record<string, unknown>)[key],
    );
  }
}

describe('plan037 owned immutable clone', () => {
  it('matches the default parser output shape, including -0 and prototypes', () => {
    const owned = parseImmutableGraphData(rawGraph());
    const clone = cloneOwnedImmutableGraphData(owned);
    expectSameShapeNoSharing(clone, realParse(rawGraph()), owned);
    // Whatever sign the owned root holds for zero is carried over unchanged.
    expect(
      Object.is(clone.entities[0]!.name_embedding![0], owned.entities[0]!.name_embedding![0]),
    ).toBe(true);
    expect(getOwnedImmutableGraphData(clone)).toBeUndefined();
  });

  it('keeps null-prototype objects null-prototype (structuredClone does not)', () => {
    const owned = parseImmutableGraphData(rawGraph());
    const expected = realParse(rawGraph());
    const clone = cloneOwnedImmutableGraphData(owned);
    const protos = (value: unknown, out: unknown[] = []): unknown[] => {
      if (value === null || typeof value !== 'object') return out;
      out.push(Object.getPrototypeOf(value));
      Object.values(value).forEach((child) => protos(child, out));
      return out;
    };
    expect(protos(clone)).toEqual(protos(expected));
  });

  it('is fully mutable and cannot reach the immutable root', () => {
    const owned = parseImmutableGraphData(rawGraph());
    const clone = cloneOwnedImmutableGraphData(owned);
    (clone.entities[0]!.attributes as { nested: { list: unknown[] } }).nested.list.push(2);
    clone.entities.length = 0;
    expect(owned.entities).toHaveLength(1);
    expect((owned.entities[0]!.attributes as { nested: { list: unknown[] } }).nested.list).toEqual([
      1,
      { deep: true },
    ]);
  });

  it('rejects caller data, including deep-frozen copies of an owned root', () => {
    const owned = parseImmutableGraphData(rawGraph());
    const forged = JSON.parse(JSON.stringify(owned)) as GraphData;
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    };
    freeze(forged);
    expect(() => cloneOwnedImmutableGraphData(forged)).toThrow();
    expect(() => cloneOwnedImmutableGraphData(realParse(rawGraph()))).toThrow();
    expect(() => cloneOwnedImmutableGraphData(null as never)).toThrow();
  });

  it('leaves the default parser fresh, mutable and unregistered', () => {
    const parsed = realParse(rawGraph());
    expect(Object.isFrozen(parsed)).toBe(false);
    expect(getOwnedImmutableGraphData(parsed)).toBeUndefined();
  });
});
