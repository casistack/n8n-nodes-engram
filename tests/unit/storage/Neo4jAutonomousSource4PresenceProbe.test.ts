import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { performance } from 'perf_hooks';
import { Neo4jStorage } from '../../../src/storage/Neo4jStorage';
import {
  beginAutomaticClaimReadAttempt,
  getAutomaticClaimReadScope,
} from '../../../src/storage/AutomaticClaimReadScope';
import { createNeo4jCompositionalReadChargeV3 } from '../../../src/storage/Neo4jCompositionalReadBudgetV3';

type NeoRecord = { get(key: string): unknown };

function record(values: Record<string, unknown>): NeoRecord {
  return { get: (key) => values[key] };
}

type EnrolledPreflightStats = {
  entity_count: number;
  entity_chars: number;
  entity_char_max: number;
  edge_count: number;
  edge_chars: number;
  edge_char_max: number;
  episode_count: number;
  episode_chars: number;
  episode_attribute_char_max: number;
  operation_count: number;
  operation_chars: number;
  operation_char_max: number;
};

const enrolledStats = (
  overrides: Partial<EnrolledPreflightStats> = {},
): EnrolledPreflightStats => ({
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
  ...overrides,
});

type MarkerlessPresence = {
  source_count: unknown;
  operation_count: unknown;
};

type MarkerlessCandidateStats = {
  candidate_count: unknown;
  total_attribute_chars: unknown;
  max_attribute_chars: unknown;
};

function createOrdinaryGuard() {
  const budget = { remaining: 512, deferred: 0 };
  const scope = getAutomaticClaimReadScope(budget);
  const signal = new AbortController().signal;
  const work = {
    absoluteMonotonicDeadlineMs: performance.now() + 5_000,
    signal,
  };
  const check = () => {
    if (performance.now() >= work.absoluteMonotonicDeadlineMs || signal.aborted)
      throw new Error('Engram compositional capture: budget_exhausted');
  };
  const charge = createNeo4jCompositionalReadChargeV3(scope, check);
  return {
    work,
    scope,
    read: {
      check,
      charge,
      begin: () => {
        check();
        if (!beginAutomaticClaimReadAttempt(scope))
          throw new Error('Engram compositional capture: budget_exhausted');
        check();
      },
    },
  };
}

describe('Neo4j enrolled V4 preflight and markerless Source4 presence bounds', () => {
  let store: Neo4jStorage;

  beforeEach(() => {
    store = new Neo4jStorage('bolt://127.0.0.1:19787', 'neo4j', 'synthetic-unused');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
  });

  const runEnrolledPreflight = (summary: Record<string, unknown>) => {
    const run = jest.fn(async (query: string) =>
      query.includes('CALL {') ? { records: [record(summary)] } : { records: [] },
    );
    const internal = store as unknown as {
      preflightAutonomousPersonalGlobalGraphInTransaction: (
        tx: ManagedTransaction,
      ) => Promise<void>;
    };
    const result = internal.preflightAutonomousPersonalGlobalGraphInTransaction.call(store, {
      run,
    } as unknown as ManagedTransaction);
    return { result, run };
  };

  it.each([
    [
      'combined Entity, edge and Episode count',
      enrolledStats({ entity_count: 40_000, edge_count: 40_000, episode_count: 20_001 }),
      'snapshot_limit',
    ],
    ['Operation4 row count', enrolledStats({ operation_count: 100_001 }), 'snapshot_limit'],
    [
      'Episode attribute character count',
      enrolledStats({ episode_attribute_char_max: 512 * 1024 + 1 }),
      'native_attributes_too_large',
    ],
    [
      'Operation4 per-row character count',
      enrolledStats({ operation_char_max: 32 * 1024 + 1 }),
      'invalid_native_record',
    ],
    ['missing aggregate field', { ...enrolledStats(), entity_count: undefined }, 'snapshot_limit'],
    [
      'nonnumeric aggregate field',
      { ...enrolledStats(), episode_count: 'synthetic-invalid' },
      'snapshot_limit',
    ],
    [
      'combined serialized character count',
      enrolledStats({
        episode_chars: 60 * 1024 * 1024,
        operation_chars: 40 * 1024 * 1024 + 1,
      }),
      'snapshot_limit',
    ],
  ])(
    'rejects excessive enrolled %s from scalar preflight before graph payload reads',
    async (_name, summary, expectedError) => {
      const { result, run } = runEnrolledPreflight(summary as Record<string, unknown>);
      await expect(result).rejects.toThrow(expectedError as string);
      expect(run).toHaveBeenCalledTimes(1);
      const query = run.mock.calls[0][0];
      expect(query).toContain('entity_count');
      expect(query).toContain('episode_attribute_char_max');
      expect(query).toContain('operation_char_max');
      expect(query).toMatch(/MATCH \(e:Entity\)\s+WITH e LIMIT 100001/);
      expect(query).toMatch(/MATCH \(\)-\[r:RELATES_TO\]->\(\)\s+WITH r LIMIT 100001/);
      expect(query).toMatch(/MATCH \(ep:Episode\)\s+WITH ep LIMIT 100001/);
      expect(query).toMatch(/MATCH \(op:AutomaticOperation\)\s+WITH op LIMIT 100001/);
      expect(query).not.toContain('RETURN ep.attributes AS attributes');
      expect(query).not.toContain('RETURN op.record_json AS record_json');
    },
  );

  it('keeps the 100MiB ASCII ceiling at the exact enrolled preflight boundary', async () => {
    const { result, run } = runEnrolledPreflight(
      enrolledStats({ episode_count: 200, episode_chars: 100 * 1024 * 1024 }),
    );
    await expect(result).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('episode_chars');
    expect(run.mock.calls[0][0]).toContain('operation_chars');
  });

  it('keeps the 32KiB Operation4 row ceiling at the exact enrolled preflight boundary', async () => {
    const { result, run } = runEnrolledPreflight(
      enrolledStats({
        operation_count: 1,
        operation_chars: 32 * 1024,
        operation_char_max: 32 * 1024,
      }),
    );
    await expect(result).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  function runMarkerlessProbe(queryResult: (query: string) => { records: NeoRecord[] }) {
    const run = jest.fn(async (query: string) => queryResult(query));
    const getGuard = jest.fn(() => createOrdinaryGuard());
    const internal = store as unknown as {
      assertNoUnregisteredAutonomousPersonalSourceRowsInTransaction: (
        tx: ManagedTransaction,
        getGuard: () => unknown,
      ) => Promise<void>;
    };
    const result = internal.assertNoUnregisteredAutonomousPersonalSourceRowsInTransaction.call(
      store,
      { run } as unknown as ManagedTransaction,
      getGuard,
    );
    return { result, run, getGuard };
  }

  const markerlessQueryResult =
    (
      initial: MarkerlessPresence,
      candidateStats?: MarkerlessCandidateStats,
      candidates: Array<{ uuid: string; attributes: string }> = [],
    ) =>
    (query: string): { records: NeoRecord[] } => {
      if (query.includes('RETURN source_count, operation_count'))
        return { records: [record(initial)] };
      if (query.includes('RETURN count(ep) AS candidate_count'))
        return candidateStats ? { records: [record(candidateStats)] } : { records: [] };
      if (query.includes('RETURN ep.uuid AS uuid, ep.attributes AS attributes'))
        return {
          records: candidates.map(({ uuid, attributes }) => record({ uuid, attributes })),
        };
      return { records: [] };
    };

  it('leaves Claim1/2 shared keys and a lone reserved value type on the markerless legacy path', async () => {
    const legacyEpisodeAttributes = [
      '{"engram_claim_v1":{"version":2}}',
      '{"engram_literal_v1":{"family":"legacy"}}',
    ];
    const legacyEntityTypes = ['autonomous_personal_value'];
    const legacyOperationRecords = ['{"version":3,"status":"legacy"}'];
    const sourceCount = legacyEpisodeAttributes.filter(
      (attributes) =>
        attributes.includes('engram_write_owner_v4') ||
        attributes.includes('engram_source_envelope_v3'),
    ).length;
    const operationCount = legacyOperationRecords.filter((json) =>
      json.startsWith('{"version":4'),
    ).length;
    expect(sourceCount).toBe(0);
    expect(operationCount).toBe(0);

    const { result, run, getGuard } = runMarkerlessProbe(
      markerlessQueryResult({ source_count: sourceCount, operation_count: operationCount }),
    );

    await expect(result).resolves.toBeUndefined();
    expect(legacyEpisodeAttributes).toHaveLength(2);
    expect(legacyEntityTypes).toEqual(['autonomous_personal_value']);
    expect(legacyOperationRecords).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('$owner_key');
    expect(run.mock.calls[0][0]).toContain('$envelope_key');
    expect(run.mock.calls[0][0]).not.toContain('engram_claim_v1');
    expect(run.mock.calls[0][0]).not.toContain('engram_literal_v1');
    expect(run.mock.calls[0][0]).not.toContain('autonomous_personal_value');
    expect(run.mock.calls[0][0]).not.toContain('RETURN e.type');
    expect(run.mock.calls[0][0]).not.toContain('RETURN ep.attributes AS attributes');
    expect(getGuard).not.toHaveBeenCalled();
  });

  it('rejects markerless Operation4 presence from the scalar probe without loading its row', async () => {
    const { result, run, getGuard } = runMarkerlessProbe(
      markerlessQueryResult({ source_count: 0, operation_count: 1 }),
    );

    await expect(result).rejects.toThrow('unregistered_native_format');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain(`op.record_json STARTS WITH '{"version":4'`);
    expect(run.mock.calls[0][0]).not.toContain('RETURN op.record_json AS record_json');
    expect(getGuard).not.toHaveBeenCalled();
  });

  it('bounds Source4 candidate reads and lets text/nested legacy false positives pass', async () => {
    const attributes = JSON.stringify({
      note: 'engram_write_owner_v4 appears as ordinary text',
      nested: { engram_claim_v1: { version: 2 } },
    });
    const { result, run, getGuard } = runMarkerlessProbe(
      markerlessQueryResult(
        { source_count: 1, operation_count: 0 },
        {
          candidate_count: 1,
          total_attribute_chars: attributes.length,
          max_attribute_chars: attributes.length,
        },
        [{ uuid: 'candidate-source', attributes }],
      ),
    );

    await expect(result).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][0]).toContain('RETURN source_count, operation_count');
    expect(run.mock.calls[1][0]).toMatch(/WITH ep LIMIT 100001/);
    expect(run.mock.calls[1][0]).toContain('max_attribute_chars');
    expect(run.mock.calls[2][0]).toMatch(/ORDER BY ep.uuid LIMIT 100001/);
    expect(run.mock.calls[2][0]).toContain('RETURN ep.uuid AS uuid, ep.attributes AS attributes');
    expect(run.mock.calls.some(([query]) => query.includes('MATCH (e:Entity)'))).toBe(false);
    expect(run.mock.calls[0][0]).toContain('MATCH (op:AutomaticOperation)');
    expect(
      run.mock.calls.some(([query]) => query.includes('RETURN op.record_json AS record_json')),
    ).toBe(false);
    expect(getGuard).toHaveBeenCalledTimes(1);
  });

  it('rejects a markerless top-level Source4 key even when its value is malformed', async () => {
    const attributes = '{"engram_write_owner_v4":null}';
    const { result, run, getGuard } = runMarkerlessProbe(
      markerlessQueryResult(
        { source_count: 1, operation_count: 0 },
        {
          candidate_count: 1,
          total_attribute_chars: attributes.length,
          max_attribute_chars: attributes.length,
        },
        [{ uuid: 'candidate-source', attributes }],
      ),
    );

    await expect(result).rejects.toThrow('unregistered_native_format');
    expect(run).toHaveBeenCalledTimes(3);
    expect(getGuard).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'candidate count',
      { source_count: 100_001, operation_count: 0 },
      { candidate_count: 100_001, total_attribute_chars: 0, max_attribute_chars: 0 },
      'snapshot_limit',
    ],
    [
      'aggregate candidate characters',
      { source_count: 1, operation_count: 0 },
      {
        candidate_count: 1,
        total_attribute_chars: 100 * 1024 * 1024 + 1,
        max_attribute_chars: 1,
      },
      'snapshot_limit',
    ],
    [
      'per-row candidate characters',
      { source_count: 1, operation_count: 0 },
      {
        candidate_count: 1,
        total_attribute_chars: 512 * 1024 + 1,
        max_attribute_chars: 512 * 1024 + 1,
      },
      'native_attributes_too_large',
    ],
  ])(
    'fails closed on oversized markerless Source4 %s before loading candidate attributes',
    async (_name, initial, candidateStats, expectedError) => {
      const { result, run, getGuard } = runMarkerlessProbe(
        markerlessQueryResult(
          initial as MarkerlessPresence,
          candidateStats as MarkerlessCandidateStats,
        ),
      );
      await expect(result).rejects.toThrow(expectedError as string);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][0]).toContain('RETURN count(ep) AS candidate_count');
      expect(run.mock.calls.some(([query]) => query.includes('RETURN ep.uuid AS uuid'))).toBe(
        false,
      );
      expect(getGuard).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['missing scalar summary row', []],
    ['malformed source count', [record({ source_count: 'synthetic-invalid', operation_count: 0 })]],
  ])('rejects ambiguous markerless %s before candidate inspection', async (_name, rows) => {
    const { result, run, getGuard } = runMarkerlessProbe(() => ({ records: rows as NeoRecord[] }));
    await expect(result).rejects.toThrow('invalid_native_format');
    expect(run).toHaveBeenCalledTimes(1);
    expect(getGuard).not.toHaveBeenCalled();
  });

  it('enforces the UTF-8 byte ceiling during the enrolled full graph decode before JSON parsing', async () => {
    const prefix = '{"engram_write_owner_v4":null,"padding":"';
    const suffix = '"}';
    const neededBytes = 512 * 1024 + 1 - Buffer.byteLength(prefix + suffix);
    const protectedAttributes = `${prefix}${'😀'.repeat(Math.ceil(neededBytes / 4))}${suffix}`;
    const characterCount = protectedAttributes.length;
    const byteCount = Buffer.byteLength(protectedAttributes, 'utf8');
    expect(characterCount).toBeLessThanOrEqual(512 * 1024);
    expect(byteCount).toBeGreaterThan(512 * 1024);

    const properties = {
      uuid: '889f4349-197f-44c0-81a5-753e5507b7d3',
      group_id: 'native-group',
      content: 'protected source',
      role: 'human',
      source_type: 'message',
      reference_time: '2026-10-29T00:00:00.000Z',
      created_at: '2026-10-29T00:00:00.000Z',
      updated_at: null,
      attributes: protectedAttributes,
    };
    const run = jest.fn(async (query: string) => {
      if (query.includes('RETURN lock.autonomous_source_format_v4 AS format'))
        return { records: [record({ format: neo4j.int(1) })] };
      if (query.includes('CALL {'))
        return {
          records: [
            record(
              enrolledStats({
                episode_count: 1,
                episode_chars: characterCount,
                episode_attribute_char_max: characterCount,
              }),
            ),
          ],
        };
      if (query.includes('MATCH (e:Entity)')) return { records: [] };
      if (query.includes('MATCH ()-[r:RELATES_TO]')) return { records: [] };
      if (query.includes('MATCH (e:Episode)')) return { records: [record({ e: { properties } })] };
      if (query.includes('RETURN lock.epoch AS epoch'))
        return { records: [record({ epoch: null, automatic_operations_present: false })] };
      if (query.includes('MATCH (op:AutomaticOperation)')) return { records: [] };
      return { records: [] };
    });
    const internal = store as unknown as {
      assertEnrolledAutonomousPersonalRecordsInTransaction: (
        tx: ManagedTransaction,
        guard: ReturnType<typeof createOrdinaryGuard>,
      ) => Promise<unknown>;
    };
    const guard = createOrdinaryGuard();
    const events: string[] = [];
    const originalCharge = guard.read.charge;
    const chargeSpy = jest.spyOn(guard.read, 'charge').mockImplementation((value) => {
      if (value === properties) events.push('raw-episode-charged');
      return originalCharge(value);
    });
    const originalParse = JSON.parse;
    let protectedAttributeParses = 0;
    const parseSpy = jest.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text === protectedAttributes) {
        protectedAttributeParses++;
        events.push('protected-attributes-parse');
      }
      return originalParse(text, reviver);
    });

    await expect(
      internal.assertEnrolledAutonomousPersonalRecordsInTransaction.call(
        store,
        { run } as unknown as ManagedTransaction,
        guard,
      ),
    ).rejects.toThrow('native_attributes_too_large');
    expect(run.mock.calls.some(([query]) => query.includes('MATCH (e:Entity)'))).toBe(true);
    expect(run.mock.calls.some(([query]) => query.includes('MATCH (op:AutomaticOperation)'))).toBe(
      true,
    );
    expect(chargeSpy).toHaveBeenCalledWith(properties);
    expect(events).toEqual(['raw-episode-charged']);
    expect(protectedAttributeParses).toBe(0);
    parseSpy.mockRestore();
  });
});
