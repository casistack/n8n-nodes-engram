import * as LosslessGraph from '../../../src/storage/LosslessAutomaticCaptureGraph';
import {
  getOwnedImmutableGraphData,
  parseImmutableGraphData,
} from '../../../src/storage/ImmutableGraphSnapshot';
import type { GraphData } from '../../../src/schemas';
import { CURRENT_GRAPH_DATA_VERSION } from '../../../src/schemas/GraphData.schema';

const realParse = LosslessGraph.parseLosslessAutomaticCaptureGraph;

function rawGraph(): Record<string, unknown> {
  // Complete current graph with no defaults to apply, as plain native JSON.
  return JSON.parse(
    JSON.stringify({
      version: CURRENT_GRAPH_DATA_VERSION,
      exported_at: '2026-10-31T00:00:00.000Z',
      entities: [
        {
          uuid: '00000000-0000-4000-8000-0000000000a1',
          name: 'Synthetic',
          group_id: 'immutable-unit',
          summary: '',
          entity_type: 'concept',
          name_embedding: null,
          attributes: { nested: { list: [1, { deep: true }] } },
          created_at: '2026-10-31T00:00:00.000Z',
          updated_at: '2026-10-31T00:00:00.000Z',
        },
      ],
      edges: [],
      episodes: [],
    }),
  ) as Record<string, unknown>;
}

function defaultParsed(): GraphData {
  return realParse(rawGraph());
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

afterEach(() => jest.restoreAllMocks());

describe('ImmutableGraphSnapshot factory', () => {
  it('leaves the default lossless parser fresh and mutable', () => {
    const first = defaultParsed();
    const second = defaultParsed();
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Object.isFrozen(first.entities[0]!.attributes)).toBe(false);
    expect(getOwnedImmutableGraphData(first)).toBeUndefined();
  });

  it('fully parses raw input into a detached deep-frozen registered copy', () => {
    const parse = jest.spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph');
    const raw = rawGraph();
    const owned = parseImmutableGraphData(raw);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(owned).not.toBe(raw);
    expect(isDeepFrozen(owned)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(getOwnedImmutableGraphData(owned)).toBe(owned);
    expect(getOwnedImmutableGraphData(raw)).toBeUndefined();
    expect(owned).toEqual(realParse(rawGraph()));
    expect(Object.getPrototypeOf(owned)).toBe(Object.prototype);
  });

  it('reuses only its own registered root without another schema parse', () => {
    const owned = parseImmutableGraphData(rawGraph());
    const parse = jest.spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph');
    expect(parseImmutableGraphData(owned)).toBe(owned);
    expect(parse).not.toHaveBeenCalled();
  });

  it('never trusts caller-frozen input, even a deep-frozen copy of an owned root', () => {
    const owned = parseImmutableGraphData(rawGraph());
    const forged = structuredClone(owned) as GraphData;
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    };
    freeze(forged);
    expect(getOwnedImmutableGraphData(forged)).toBeUndefined();
    const parse = jest.spyOn(LosslessGraph, 'parseLosslessAutomaticCaptureGraph');
    const again = parseImmutableGraphData(forged);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(again).not.toBe(forged);
    expect(getOwnedImmutableGraphData(again)).toBe(again);
  });

  it('fully rejects invalid frozen input instead of registering it', () => {
    const bad = Object.freeze({ ...rawGraph(), entities: Object.freeze([Object.freeze({})]) });
    expect(() => parseImmutableGraphData(bad)).toThrow();
    expect(getOwnedImmutableGraphData(bad)).toBeUndefined();
  });

  it('makes nested tampering impossible and keeps the source independent', () => {
    const raw = rawGraph();
    const owned = parseImmutableGraphData(raw);
    const attributes = owned.entities[0]!.attributes as { nested: { list: unknown[] } };
    expect(() => {
      attributes.nested.list.push(2);
    }).toThrow(TypeError);
    expect(() => {
      (owned.entities as unknown[]).length = 0;
    }).toThrow(TypeError);
    // Mutating the caller's source after the parse cannot reach the owned copy.
    (
      (raw.entities as Array<Record<string, unknown>>)[0]!.attributes as Record<string, unknown>
    ).nested = 'changed';
    expect(attributes.nested.list).toEqual([1, { deep: true }]);
  });

  it('never registers accessor or proxy caller objects', () => {
    const proxied = new Proxy(rawGraph(), {});
    const accessor = rawGraph();
    Object.defineProperty(accessor, 'entities', { enumerable: true, get: () => [] });
    for (const input of [proxied, accessor]) {
      let result: GraphData | undefined;
      try {
        result = parseImmutableGraphData(input);
      } catch {
        result = undefined;
      }
      // Either the existing bounded parser rejects it, or the result is a separate copy.
      expect(getOwnedImmutableGraphData(input)).toBeUndefined();
      if (result) {
        expect(result).not.toBe(input);
        expect(isDeepFrozen(result)).toBe(true);
      }
    }
    expect(getOwnedImmutableGraphData(null)).toBeUndefined();
    expect(getOwnedImmutableGraphData('graph')).toBeUndefined();
  });
});
