import type { ManagedTransaction } from 'neo4j-driver';
import { Neo4jStorage } from '../../../src/storage/Neo4jStorage';
import { createNeo4jCompositionalReadChargeV3 } from '../../../src/storage/Neo4jCompositionalReadBudgetV3';
import {
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';

describe('Neo4j V3 scoped raw materialization hook', () => {
  let store: Neo4jStorage;
  beforeEach(() => {
    store = new Neo4jStorage('bolt://127.0.0.1:19787', 'neo4j', 'synthetic-unused');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
  });
  const graph = (
    tx: ManagedTransaction,
    read: { check: () => void; charge: (value: unknown) => void },
  ) =>
    (
      store as unknown as {
        graphInTransaction(
          tx: ManagedTransaction,
          group: undefined,
          mode: string,
          read: { check: () => void; charge: (value: unknown) => void },
        ): Promise<unknown>;
      }
    ).graphInTransaction(tx, undefined, 'automatic_capture', read);

  it('rejects native bytes before attribute decoding or the next query', async () => {
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    reserveAutomaticClaimSnapshotBytes(scope, 100 * 1024 * 1024 - 16);
    const charge = createNeo4jCompositionalReadChargeV3(scope, () => {});
    const run = jest.fn(async () => ({
      records: [
        {
          get: () => ({ properties: { attributes: 'x'.repeat(64) } }),
        },
      ],
    }));
    const decode = jest.spyOn(store as never, 'recordToEntity' as never);
    await expect(
      graph({ run } as unknown as ManagedTransaction, { check: () => {}, charge }),
    ).rejects.toThrow('snapshot_limit');
    expect(run).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
  });

  it('checks cancellation after awaited native reads before touching rows', async () => {
    const aborted = new Error('synthetic cancellation');
    let cancelled = false;
    const check = () => {
      if (cancelled) throw aborted;
    };
    const charge = jest.fn();
    const run = jest.fn(async () => {
      cancelled = true;
      return { records: [] };
    });
    await expect(graph({ run } as unknown as ManagedTransaction, { check, charge })).rejects.toBe(
      aborted,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(charge).not.toHaveBeenCalled();
  });

  it('charges raw operation JSON before JSON.parse', async () => {
    const exhausted = new Error('synthetic byte reservation');
    const run = jest.fn(async (query: string) => ({
      records: query.includes('MATCH (op:AutomaticOperation)')
        ? [{ get: (key: string) => (key === 'record_json' ? '{broken' : 'synthetic') }]
        : [],
    }));
    const charge = (value: unknown) => {
      if (Object.prototype.hasOwnProperty.call(value, 'record_json')) throw exhausted;
    };
    const parse = jest.spyOn(JSON, 'parse');
    await expect(
      graph({ run } as unknown as ManagedTransaction, { check: () => {}, charge }),
    ).rejects.toBe(exhausted);
    expect(parse).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(6);
    expect(run.mock.calls[0]?.[0]).toContain('RETURN lock.autonomous_source_format_v4 AS format');
    expect(run.mock.calls.some(([query]) => query.includes('MATCH (op:AutomaticOperation)'))).toBe(
      true,
    );
  });
});
