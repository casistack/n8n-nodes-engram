import { CURRENT_GRAPH_DATA_VERSION } from '../../../src/schemas/GraphData.schema';
import {
  getOwnedImmutableGraphData,
  parseImmutableGraphData,
  tryRebaseOwnedGraphExport,
} from '../../../src/storage/ImmutableGraphSnapshot';
import type { GraphData } from '../../../src/schemas';

const OLD = '2026-01-01T00:00:00.000Z';
const NOW = '2026-01-02T03:04:05.678Z';
function graph(time = OLD): GraphData {
  return { version: CURRENT_GRAPH_DATA_VERSION, exported_at: time, entities: [], edges: [], episodes: [] };
}
function counter(throwAt?: number) {
  const error = new Error('synthetic cancellation');
  let calls = 0;
  return { check: () => { if (++calls === throwAt) throw error; }, error, calls: () => calls };
}

describe('owned snapshot export rebasing', () => {
  test('shares only frozen owned children after proving current data equality', () => {
    const root = parseImmutableGraphData(graph());
    const current = graph(NOW);
    const hit = tryRebaseOwnedGraphExport(root, current, () => {});
    expect(hit).toBeDefined();
    expect(getOwnedImmutableGraphData(hit)).toBe(hit);
    expect(hit).not.toBe(root);
    expect(hit).not.toBe(current);
    expect(hit!.entities).toBe(root.entities);
    expect(hit!.entities).not.toBe(current.entities);
    expect(hit).toEqual(current);
    expect(Object.isFrozen(hit)).toBe(true);
    expect(root.exported_at).toBe(OLD);
  });

  test.each(['2026-01-02T03:04:05Z', '2026-02-30T00:00:00.000Z', 'not-a-date'])(
    'declines noncanonical or invalid timestamp %s', (time) => {
      expect(tryRebaseOwnedGraphExport(parseImmutableGraphData(graph()), graph(time), () => {})).toBeUndefined();
    },
  );

  test('never trusts a caller-frozen copy as an owned root', () => {
    const forged = Object.freeze(graph());
    expect(tryRebaseOwnedGraphExport(forged, graph(NOW), () => {})).toBeUndefined();
    expect(getOwnedImmutableGraphData(forged)).toBeUndefined();
  });

  test('rejects changed namespace, metadata and unknown root fields without registering the export', () => {
    const root = parseImmutableGraphData(graph());
    for (const extra of [{ group_id: 'another-namespace' }, { metadata: { changed: true } }, { unknown: true }]) {
      const current = { ...graph(NOW), ...extra };
      expect(tryRebaseOwnedGraphExport(root, current, () => {})).toBeUndefined();
      expect(getOwnedImmutableGraphData(current)).toBeUndefined();
    }
  });

  test('declines proxies and timestamp getters without invoking caller code', () => {
    const root = parseImmutableGraphData(graph());
    const getter = jest.fn(() => NOW);
    const accessor = graph(NOW);
    Object.defineProperty(accessor, 'exported_at', { enumerable: true, get: getter });
    expect(tryRebaseOwnedGraphExport(root, accessor, () => {})).toBeUndefined();
    expect(tryRebaseOwnedGraphExport(root, new Proxy(graph(NOW), {}), () => {})).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  test('propagates cancellation at every guard and leaves input roots unchanged', () => {
    const root = parseImmutableGraphData(graph());
    const current = graph(NOW);
    const before = JSON.stringify([root, current]);
    const full = counter();
    expect(tryRebaseOwnedGraphExport(root, current, full.check)).toBeDefined();
    expect(full.calls()).toBeGreaterThanOrEqual(3);
    for (let at = 1; at <= full.calls(); at++) {
      const probe = counter(at);
      expect(() => tryRebaseOwnedGraphExport(root, current, probe.check)).toThrow(probe.error);
      expect(JSON.stringify([root, current])).toBe(before);
    }
  });
});

// Exercise the private operation boundary without changing its visibility in product code.
type SnapshotState = { live: boolean; root?: GraphData };
type SnapshotBoundary = {
  nativePreStateV4(state: SnapshotState, check: () => void): GraphData;
};

describe('native operation snapshot lifetime', () => {
  let storage: import('../../../src/storage/GraphologyStorage').GraphologyStorage;
  let boundary: SnapshotBoundary;
  beforeEach(async () => {
    const { GraphologyStorage } = await import('../../../src/storage/GraphologyStorage');
    storage = new GraphologyStorage();
    await storage.initialize();
    boundary = storage as unknown as SnapshotBoundary;
  });
  afterEach(async () => { await storage.close(); });

  test('consumes a proven root once and returns detached mutable data on the next call', async () => {
    const root = parseImmutableGraphData(JSON.parse(JSON.stringify(await storage.exportGraph())));
    const state: SnapshotState = { live: true, root };
    const hit = boundary.nativePreStateV4(state, () => {});
    expect(getOwnedImmutableGraphData(hit)).toBe(hit);
    expect(state.root).toBeUndefined();
    const fresh = boundary.nativePreStateV4(state, () => {});
    expect(getOwnedImmutableGraphData(fresh)).toBeUndefined();
    expect(Object.isFrozen(fresh)).toBe(false);
    expect(fresh.entities).not.toBe(hit.entities);
  });

  test('expired contexts and differing roots return fresh unowned data without changing Core', async () => {
    const original = await storage.exportGraph();
    const root = parseImmutableGraphData(JSON.parse(JSON.stringify(original)));
    const changed = parseImmutableGraphData(JSON.parse(JSON.stringify({ ...original, group_id: 'unrelated-scope' })));
    for (const state of [{ live: false, root }, { live: true, root: changed }]) {
      const result = boundary.nativePreStateV4(state, () => {});
      expect(getOwnedImmutableGraphData(result)).toBeUndefined();
      expect(Object.isFrozen(result)).toBe(false);
      expect(state.root).toBeUndefined();
      expect(result.group_id).toBeUndefined();
    }
    const after = await storage.exportGraph();
    expect(after.entities).toEqual(original.entities);
    expect(after.episodes).toEqual(original.episodes);
    expect(after.edges).toEqual(original.edges);
  });

  test('cancellation consumes the context root and preserves the stored graph', async () => {
    const before = await storage.exportGraph();
    const root = parseImmutableGraphData(JSON.parse(JSON.stringify(before)));
    const state: SnapshotState = { live: true, root };
    const error = new Error('synthetic cancellation');
    expect(() => boundary.nativePreStateV4(state, () => { throw error; })).toThrow(error);
    expect(state.root).toBeUndefined();
    const after = await storage.exportGraph();
    expect(after.entities).toEqual(before.entities);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.edges).toEqual(before.edges);
    expect(getOwnedImmutableGraphData(boundary.nativePreStateV4(state, () => {}))).toBeUndefined();
  });
});
