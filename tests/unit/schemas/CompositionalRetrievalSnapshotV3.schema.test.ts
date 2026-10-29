import {
  CompositionalRetrievalSnapshotV3Schema,
  CompositionalUnscopedGraphDataV3Schema,
} from '../../../src/schemas/CompositionalRetrievalSnapshotV3.schema';

function graph() {
  return {
    version: '2.0' as const,
    exported_at: '2026-10-26T10:00:00.000Z',
    entities: [],
    edges: [],
    episodes: [],
  };
}

function snapshot(value: unknown) {
  return CompositionalRetrievalSnapshotV3Schema.safeParse(value);
}

function data(value: unknown) {
  const parsed = snapshot(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

describe('compositional full-root V3 retrieval snapshot schema', () => {
  it('accepts a detached unscoped graph and canonical UTC millisecond time', () => {
    const inputGraph = graph();
    const parsed = snapshot({
      status: 'snapshot',
      graph: inputGraph,
      backendNow: '2026-10-26T10:00:00.123Z',
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.status !== 'snapshot') throw new Error('Expected snapshot');
    expect(parsed.data.graph).toEqual(inputGraph);
    expect(Object.prototype.hasOwnProperty.call(parsed.data.graph, 'group_id')).toBe(false);
    expect(parsed.data.graph).not.toBe(inputGraph);
  });

  it.each([
    '2026-10-26T10:00:00Z',
    '2026-10-26T10:00:00.12Z',
    '2026-10-26T10:00:00.123+00:00',
    '2026-02-30T10:00:00.123Z',
  ])('rejects noncanonical backend time %s', (backendNow) => {
    expect(data({ status: 'snapshot', graph: graph(), backendNow })).toEqual({
      status: 'invalid',
      reason: 'invalid_snapshot',
    });
  });

  it('rejects a scoped graph root and any graph normalization', () => {
    expect(
      data({
        status: 'snapshot',
        graph: { ...graph(), group_id: 'namespace-a' },
        backendNow: '2026-10-26T10:00:00.123Z',
      }),
    ).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });
    expect(
      data({
        status: 'snapshot',
        graph: { ...graph(), unexpected: 'must not be stripped' },
        backendNow: '2026-10-26T10:00:00.123Z',
      }),
    ).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });
  });

  it('maps graph byte/node bounds to deferred resource exhaustion', () => {
    const hostileGraph = {
      ...graph(),
      entities: Array.from({ length: 100_001 }, () => null),
    };
    expect(
      data({
        status: 'snapshot',
        graph: hostileGraph,
        backendNow: '2026-10-26T10:00:00.123Z',
      }),
    ).toEqual({ status: 'deferred', reason: 'resource_exhausted' });
  });

  it('rejects accessor-backed graph fields without invoking them at either schema entry point', () => {
    let reads = 0;
    const hostileGraph = graph();
    Object.defineProperty(hostileGraph, 'then', {
      enumerable: true,
      get() {
        reads += 1;
        return undefined;
      },
    });

    expect(CompositionalUnscopedGraphDataV3Schema.safeParse(hostileGraph).success).toBe(false);
    expect(
      data({
        status: 'snapshot',
        graph: hostileGraph,
        backendNow: '2026-10-26T10:00:00.123Z',
      }),
    ).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });
    expect(reads).toBe(0);
  });

  it('rejects proxy graphs without invoking traps at either schema entry point', () => {
    let traps = 0;
    const hostileGraph = new Proxy(graph(), {
      get() {
        traps += 1;
        throw new Error('unexpected get');
      },
      ownKeys() {
        traps += 1;
        throw new Error('unexpected ownKeys');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('unexpected getPrototypeOf');
      },
    });

    expect(CompositionalUnscopedGraphDataV3Schema.safeParse(hostileGraph).success).toBe(false);
    expect(
      data({
        status: 'snapshot',
        graph: hostileGraph,
        backendNow: '2026-10-26T10:00:00.123Z',
      }),
    ).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });
    expect(traps).toBe(0);
  });

  it('owns the result wrapper before reading accessors or thenables', () => {
    let reads = 0;
    const accessor = {
      status: 'snapshot',
      backendNow: '2026-10-26T10:00:00.123Z',
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'graph', {
      enumerable: true,
      get() {
        reads += 1;
        return graph();
      },
    });
    Object.defineProperty(accessor, 'then', {
      enumerable: true,
      get() {
        reads += 1;
        return undefined;
      },
    });
    expect(data(accessor)).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });

    const thenable = {
      status: 'snapshot',
      graph: graph(),
      backendNow: '2026-10-26T10:00:00.123Z',
    };
    Object.defineProperty(thenable, 'then', {
      enumerable: true,
      get() {
        reads += 1;
        return undefined;
      },
    });
    expect(data(thenable)).toEqual({ status: 'invalid', reason: 'invalid_snapshot' });
    expect(reads).toBe(0);
  });

  it('bounds failure metadata before validating its reason', () => {
    let reads = 0;
    const hostileReason = {};
    Object.defineProperty(hostileReason, 'then', {
      enumerable: true,
      get() {
        reads += 1;
        return undefined;
      },
    });
    expect(data({ status: 'deferred', reason: hostileReason })).toEqual({
      status: 'invalid',
      reason: 'invalid_snapshot',
    });
    expect(reads).toBe(0);
  });

  it.each([
    { status: 'deferred', reason: 'budget_exhausted' },
    { status: 'deferred', reason: 'resource_exhausted' },
    { status: 'deferred', reason: 'concurrent_snapshot' },
    { status: 'unavailable', reason: 'missing_store' },
    { status: 'unavailable', reason: 'recovery_required' },
    { status: 'unavailable', reason: 'storage_error' },
    { status: 'invalid', reason: 'invalid_scope' },
    { status: 'invalid', reason: 'invalid_snapshot' },
  ])('accepts fixed failure result %#', (result) => {
    expect(data(result)).toEqual(result);
  });
});
