import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import type { GraphData } from '../../../src/schemas/GraphData.schema';
import { Neo4jStorage } from '../../../src/storage/Neo4jStorage';

type NeoRecord = { get(key: string): unknown };
type EnrolledGuardProbe = (tx: ManagedTransaction, guard: unknown) => Promise<unknown>;

function record(values: Record<string, unknown>): NeoRecord {
  return { get: (key) => values[key] };
}

function fakeSession(tx: ManagedTransaction): Session {
  return {
    executeWrite: async (callback: (transaction: ManagedTransaction) => Promise<unknown>) =>
      callback(tx),
    executeRead: async (callback: (transaction: ManagedTransaction) => Promise<unknown>) =>
      callback(tx),
    close: async () => undefined,
  } as unknown as Session;
}

describe('Neo4j native Source4 format witness gate', () => {
  let storage: Neo4jStorage;

  beforeEach(() => {
    storage = new Neo4jStorage('bolt://127.0.0.1:19788', 'neo4j', 'synthetic-unused');
    (storage as unknown as { initialized: boolean }).initialized = true;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.close();
  });

  const rawExecuteWrite = (
    nativeSession: Session,
    work: (tx: ManagedTransaction) => Promise<unknown>,
  ) =>
    (
      storage as unknown as {
        executeWrite(
          session: Session,
          callback: (tx: ManagedTransaction) => Promise<unknown>,
        ): Promise<unknown>;
      }
    ).executeWrite(nativeSession, work);

  it('skips the enrolled-format integrity guard for markerless legacy writes', async () => {
    let formatReads = 0;
    const queries: string[] = [];
    const tx = {
      run: jest.fn(async (query: string) => {
        queries.push(query);
        if (query.includes('RETURN lock.autonomous_source_format_v4 AS format')) {
          formatReads += 1;
          return { records: [record({ format: null })] };
        }
        if (query.includes('CALL {')) {
          // Sentinel over-limit data proves markerless legacy writes do not
          // open the enrolled-format full-graph preflight.
          return {
            records: [
              record({
                episode_count: 100_001,
                episode_char_total: 100 * 1024 * 1024 + 1,
                episode_char_max: 512 * 1024,
                operation_count: 100_001,
                operation_char_total: 0,
                operation_char_max: 0,
              }),
            ],
          };
        }
        return { records: [] };
      }),
    } as unknown as ManagedTransaction;
    const internals = storage as unknown as {
      assertEnrolledAutonomousPersonalRecordsInTransaction: EnrolledGuardProbe;
    };
    const probe = jest
      .spyOn(internals, 'assertEnrolledAutonomousPersonalRecordsInTransaction')
      .mockResolvedValue(undefined);
    const nativeSession = fakeSession(tx);
    const work = jest.fn(async () => 'legacy-write');

    await expect(rawExecuteWrite(nativeSession, work)).resolves.toBe('legacy-write');

    expect(formatReads).toBe(2);
    expect(probe).not.toHaveBeenCalled();
    expect(queries.some((query) => query.includes('CALL {'))).toBe(false);
    expect(queries.some((query) => query.includes('RETURN ep.attributes AS attributes'))).toBe(
      false,
    );
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('skips the enrolled-format integrity guard for markerless legacy reads', async () => {
    let formatReads = 0;
    const queries: string[] = [];
    const tx = {
      run: jest.fn(async (query: string) => {
        queries.push(query);
        if (query.includes('RETURN coalesce(lock.revision,0) AS revision')) {
          return {
            records: [record({ revision: neo4j.int(7), epoch: null, ledger_present: true })],
          };
        }
        if (query.includes('RETURN lock.autonomous_source_format_v4 AS format')) {
          formatReads += 1;
          return { records: [record({ format: null })] };
        }
        if (query.includes('CALL {')) {
          return {
            records: [record({ episode_count: 100_001, episode_char_total: 200_000_000 })],
          };
        }
        return { records: [] };
      }),
    } as unknown as ManagedTransaction;
    const nativeSession = fakeSession(tx);
    const legacyGraph = {
      version: '2.0',
      exported_at: '2026-10-27T00:00:00.000Z',
      group_id: 'legacy-with-old-ledger',
      entities: [],
      edges: [],
      episodes: [],
      automatic_operations_v1: { version: 1, operations: [] },
    } as GraphData;
    const internals = storage as unknown as {
      getSession: () => Session;
      graphInTransaction: (tx: ManagedTransaction, groupId?: string) => Promise<GraphData>;
      assertEnrolledAutonomousPersonalRecordsInTransaction: EnrolledGuardProbe;
    };
    jest.spyOn(internals, 'getSession').mockReturnValue(nativeSession);
    jest.spyOn(internals, 'graphInTransaction').mockResolvedValue(legacyGraph);
    const probe = jest
      .spyOn(internals, 'assertEnrolledAutonomousPersonalRecordsInTransaction')
      .mockResolvedValue(undefined);

    await expect(storage.readExtractionSnapshot('legacy-with-old-ledger')).resolves.toBe(
      legacyGraph,
    );

    expect(formatReads).toBe(1);
    expect(probe).not.toHaveBeenCalled();
    expect(queries.some((query) => query.includes('CALL {'))).toBe(false);
    expect(queries.some((query) => query.includes('RETURN ep.attributes AS attributes'))).toBe(
      false,
    );
  });

  it('runs the enrolled-record integrity guard before and after writes under exact integer witness 1', async () => {
    let formatReads = 0;
    let integrityGuards = 0;
    const queries: string[] = [];
    const tx = {
      run: jest.fn(async (query: string) => {
        queries.push(query);
        if (query.includes('RETURN lock.autonomous_source_format_v4 AS format')) {
          formatReads += 1;
          return { records: [record({ format: neo4j.int(1) })] };
        }
        if (query.includes('CALL {')) {
          return {
            records: [
              record({
                entity_count: 0,
                entity_chars: 0,
                entity_char_max: 0,
                edge_count: 0,
                edge_chars: 0,
                edge_char_max: 0,
                episode_count: 0,
                episode_chars: 0,
                episode_attribute_char_max: 0,
                operation_count: 0,
                operation_chars: 0,
                operation_char_max: 0,
              }),
            ],
          };
        }
        return { records: [] };
      }),
    } as unknown as ManagedTransaction;
    const internals = storage as unknown as {
      assertEnrolledAutonomousPersonalRecordsInTransaction: EnrolledGuardProbe;
    };
    // The former global-integrity helper was split by the approved markerless
    // compatibility rule: this enrolled-format guard owns the full Source4+B1b
    // checks; markerless stores use the separate candidate-only presence path.
    const originalProbe =
      internals.assertEnrolledAutonomousPersonalRecordsInTransaction.bind(storage);
    jest
      .spyOn(internals, 'assertEnrolledAutonomousPersonalRecordsInTransaction')
      .mockImplementation(async (nativeTx, guard) => {
        integrityGuards += 1;
        await originalProbe(nativeTx, guard);
      });

    await expect(rawExecuteWrite(fakeSession(tx), async () => 'registered-write')).resolves.toBe(
      'registered-write',
    );

    // Each pre/post full guard verifies the marker again inside its snapshot.
    expect(formatReads).toBe(4);
    expect(integrityGuards).toBe(2);
    expect(queries.filter((query) => query.startsWith('CALL {'))).toHaveLength(2);
    expect(queries.some((query) => query.includes('RETURN e LIMIT 100001'))).toBe(true);
    expect(queries.some((query) => query.includes('op.record_json AS record_json'))).toBe(true);
  });

  it.each([
    ['number one', 1],
    ['string one', '1'],
    ['boolean true', true],
    ['integer two', neo4j.int(2)],
  ])(
    'rejects malformed present witnesses (%s) before invoking the writer',
    async (_name, value) => {
      const queries: string[] = [];
      const tx = {
        run: jest.fn(async (query: string) => {
          queries.push(query);
          if (query.includes('RETURN lock.autonomous_source_format_v4 AS format')) {
            return { records: [record({ format: value })] };
          }
          return { records: [] };
        }),
      } as unknown as ManagedTransaction;
      const nativeSession = fakeSession(tx);
      const work = jest.fn(async () => 'must-not-run');

      await expect(rawExecuteWrite(nativeSession, work)).rejects.toThrow('invalid_native_format');

      expect(work).not.toHaveBeenCalled();
      expect(queries.some((query) => query.includes('CALL {'))).toBe(false);
    },
  );

  it('rejects unapproved witness enrollment and removal', async () => {
    for (const [before, after] of [
      [null, neo4j.int(1)],
      [neo4j.int(1), null],
    ] as const) {
      let format = before;
      const queries: string[] = [];
      const tx = {
        run: jest.fn(async (query: string) => {
          queries.push(query);
          if (query.includes('RETURN lock.autonomous_source_format_v4 AS format')) {
            return { records: [record({ format })] };
          }
          return { records: [] };
        }),
      } as unknown as ManagedTransaction;
      const nativeSession = fakeSession(tx);
      const internals = storage as unknown as {
        assertEnrolledAutonomousPersonalRecordsInTransaction: EnrolledGuardProbe;
      };
      const probe = jest
        .spyOn(internals, 'assertEnrolledAutonomousPersonalRecordsInTransaction')
        .mockResolvedValue(undefined);
      const work = jest.fn(async () => {
        format = after;
        return 'unapproved-format-change';
      });

      await expect(rawExecuteWrite(nativeSession, work)).rejects.toThrow('invalid_native_format');
      expect(work).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(before === null ? 0 : 1);
      expect(queries.some((query) => query.includes('CALL {'))).toBe(false);
      probe.mockRestore();
    }
  });
});
