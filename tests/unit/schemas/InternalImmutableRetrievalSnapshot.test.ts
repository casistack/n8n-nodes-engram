import {
  CompositionalRetrievalSnapshotV3Schema as publicSchema,
  InternalImmutableCompositionalRetrievalSnapshotV3Schema as internalSchema,
} from '../../../src/schemas/CompositionalRetrievalSnapshotV3.schema';
import * as lossless from '../../../src/storage/LosslessAutomaticCaptureGraph';
import {
  getOwnedImmutableGraphData,
  parseImmutableGraphData,
} from '../../../src/storage/ImmutableGraphSnapshot';

const graph = () => ({
  version: '2.0' as const,
  exported_at: '2026-10-26T10:00:00.000Z',
  entities: [],
  edges: [],
  episodes: [],
});
const wrap = (value: unknown) => ({
  status: 'snapshot',
  graph: value,
  backendNow: '2026-10-26T10:00:00.123Z',
});
const privateGraph = (value: unknown) => {
  const parsed = internalSchema.parse(wrap(value));
  if (parsed.status !== 'snapshot') throw new Error('Expected validated snapshot');
  return parsed.graph;
};

describe('internal immutable retrieval data ownership', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fully reparses general factory roots while only reusing private validated roots', () => {
    const general = parseImmutableGraphData(graph());
    const parser = jest.spyOn(lossless, 'parseLosslessAutomaticCaptureGraph');
    const first = privateGraph(general);
    expect(first).not.toBe(general);
    expect(first).toEqual(general);
    expect(parser).toHaveBeenCalledTimes(1);
    parser.mockClear();
    expect(privateGraph(first)).toBe(first);
    expect(parser).not.toHaveBeenCalled();
  });

  it('does not trust caller-frozen roots or let the public parser reuse a private brand', () => {
    const frozen = Object.freeze(graph());
    const parser = jest.spyOn(lossless, 'parseLosslessAutomaticCaptureGraph');
    const owned = privateGraph(frozen);
    expect(owned).not.toBe(frozen);
    expect(parser).toHaveBeenCalledTimes(1);
    parser.mockClear();
    const result = publicSchema.parse(wrap(owned));
    if (result.status !== 'snapshot') throw new Error('Expected snapshot');
    expect(result.graph).not.toBe(owned);
    expect(Object.isFrozen(result.graph)).toBe(false);
    expect(getOwnedImmutableGraphData(result.graph)).toBeUndefined();
    expect(parser).toHaveBeenCalledTimes(1);
    result.graph.episodes.push(...[]);
  });

  it('rejects a general scoped root on every submission without privately branding it', () => {
    const scoped = parseImmutableGraphData({ ...graph(), group_id: 'synthetic-group' });
    const parser = jest.spyOn(lossless, 'parseLosslessAutomaticCaptureGraph');
    for (let i = 0; i < 2; i++) {
      parser.mockClear();
      expect(internalSchema.parse(wrap(scoped))).toEqual({
        status: 'invalid',
        reason: 'invalid_snapshot',
      });
      expect(parser).toHaveBeenCalledTimes(1);
    }
  });

  it('revalidates wrapper keys and clock even for privately branded graph data', () => {
    const owned = privateGraph(graph());
    for (const input of [
      { ...wrap(owned), backendNow: 'yesterday' },
      { ...wrap(owned), extra: true },
    ])
      expect(internalSchema.parse(input)).toEqual({
        status: 'invalid',
        reason: 'invalid_snapshot',
      });
  });

  it('freezes its own arrays while preserving public result mutability and caller isolation', () => {
    const input = graph();
    const owned = privateGraph(input);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.episodes)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.episodes)).toBe(false);
    expect(() => owned.episodes.push({} as never)).toThrow(TypeError);
    expect(input.episodes).toHaveLength(0);
  });

  it('matches public refusal classes without invoking proxy or accessor traps', () => {
    let traps = 0;
    const accessor = graph();
    Object.defineProperty(accessor, 'then', {
      enumerable: true,
      get() {
        traps++;
        return undefined;
      },
    });
    const proxy = new Proxy(graph(), {
      get() {
        traps++;
        throw new Error('Unexpected trap');
      },
    });
    for (const value of [
      accessor,
      proxy,
      Object.assign(Object.create({ custom: true }), graph()),
      { ...graph(), functionValue: () => undefined },
      { ...graph(), entities: Array.from({ length: 100_001 }, () => null) },
    ])
      expect(internalSchema.parse(wrap(value))).toEqual(publicSchema.parse(wrap(value)));
    expect(traps).toBe(0);
  });
});
