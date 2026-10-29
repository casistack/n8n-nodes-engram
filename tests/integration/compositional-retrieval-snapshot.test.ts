import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  beginAutomaticClaimReadAttempt,
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../src/storage/AutomaticClaimReadScope';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import type { GraphData } from '../../src/schemas';
import { EpisodicNodeSchema } from '../../src/schemas/EpisodicNode.schema';

describe('embedded full-root V3 retrieval snapshot', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-v3-retrieval-snapshot-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    await seedAutomaticCaptureSubject(store, 'retrieval-namespace-a');
    await seedAutomaticCaptureSubject(store, 'retrieval-namespace-b');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const readStoredGraph = () => JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;

  it('preserves embedded recent order for unlinked equal-time episodes and late older records', async () => {
    await store.close();
    const graph = readStoredGraph();
    const make = (uuid: string, time: string) =>
      EpisodicNodeSchema.parse({
        uuid,
        group_id: 'retrieval-namespace-a',
        role: 'human',
        content: '{"genuine":"human JSON"}',
        reference_time: time,
        created_at: time,
      });
    graph.episodes.push(
      make('ffffffff-ffff-4fff-8fff-ffffffffffff', '2026-10-24T13:00:00.000Z'),
      make('00000000-0000-4000-8000-000000000001', '2026-10-24T13:00:00.000Z'),
      make('00000000-0000-4000-8000-000000000002', '2026-10-24T12:00:00.000Z'),
    );
    fs.writeFileSync(file, JSON.stringify(graph));
    store = new GraphologyStorage(file);
    await store.initialize();
    const before = fs.readFileSync(file, 'utf8');
    const recent = await store.getRecentEpisodes('retrieval-namespace-a', 100);
    const result = await store.readCompositionalRetrievalSnapshotV3(
      getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
    );
    if (result.status !== 'snapshot') throw new Error(JSON.stringify(result));
    expect(
      result.graph.episodes.filter((episode) => episode.group_id === 'retrieval-namespace-a'),
    ).toEqual(recent);
    expect(result.graph.episodes.map((e) => e.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('returns the coherent unscoped full graph without writing, migrating, or revising it', async () => {
    const beforeText = fs.readFileSync(file, 'utf8');
    const before = readStoredGraph();
    const migrationBefore = await store.getMigrationStatus();
    const budget = { remaining: 4, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);

    const result = await store.readCompositionalRetrievalSnapshotV3(scope);

    expect(result.status).toBe('snapshot');
    if (result.status !== 'snapshot') throw new Error('Expected a full retrieval snapshot');
    expect(result.graph.entities.map((entity) => entity.group_id).sort()).toEqual([
      'retrieval-namespace-a',
      'retrieval-namespace-b',
    ]);
    expect(Object.prototype.hasOwnProperty.call(result.graph, 'group_id')).toBe(false);
    expect(result.graph.episodes).toEqual(before.episodes);
    expect(result.graph.edges).toEqual(before.edges);
    expect(result.graph.metadata?.extraction_epoch).toBe(before.metadata?.extraction_epoch);
    expect(Number.isFinite(Date.parse(result.backendNow))).toBe(true);
    expect(result.backendNow).toHaveLength(24);
    expect(budget.remaining).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeText);
    expect(await store.getMigrationStatus()).toEqual(migrationBefore);
  });

  it('rejects invalid and expired scopes before filesystem access', async () => {
    const open = jest.spyOn(fs.promises, 'open');
    const stat = jest.spyOn(fs.promises, 'stat');

    expect(await store.readCompositionalRetrievalSnapshotV3({} as never)).toEqual({
      status: 'invalid',
      reason: 'invalid_scope',
    });
    expect(open).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();

    const now = jest.spyOn(performance, 'now').mockReturnValue(10_000);
    const expiredScope = getAutomaticClaimReadScope({ remaining: 8, deferred: 0 });
    now.mockReturnValue(15_001);
    expect(await store.readCompositionalRetrievalSnapshotV3(expiredScope)).toEqual({
      status: 'deferred',
      reason: 'budget_exhausted',
    });
    expect(open).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it('checks the scope while waiting for the embedded file lock', async () => {
    const lockPath = `${file}.lock`;
    fs.writeFileSync(lockPath, 'held by another writer');
    const stat = jest.spyOn(fs.promises, 'stat');
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    const scope = getAutomaticClaimReadScope({ remaining: 8, deferred: 0 });
    let calls = 0;
    now.mockImplementation(() => {
      calls += 1;
      return calls === 10 ? 5_001 : 0;
    });

    const result = await store.readCompositionalRetrievalSnapshotV3(scope);

    expect(result).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
    expect(stat.mock.calls.some(([path]) => path === lockPath)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('charges a backend attempt independently of the intake reservation', async () => {
    const budget = { remaining: 8, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    expect(budget.remaining).toBe(4);

    const result = await store.readCompositionalRetrievalSnapshotV3(scope);

    expect(result.status).toBe('snapshot');
    expect(budget.remaining).toBe(0);
  });

  it('fails closed for recovery-required stores before filesystem access', async () => {
    (store as unknown as { recoveryRequired: boolean }).recoveryRequired = true;
    const open = jest.spyOn(fs.promises, 'open');
    const result = await store.readCompositionalRetrievalSnapshotV3(
      getAutomaticClaimReadScope({ remaining: 8, deferred: 0 }),
    );

    expect(result).toEqual({ status: 'unavailable', reason: 'recovery_required' });
    expect(open).not.toHaveBeenCalled();
  });

  it('reports missing backing storage without recreating it', async () => {
    fs.unlinkSync(file);
    const budget = { remaining: 8, deferred: 0 };
    const result = await store.readCompositionalRetrievalSnapshotV3(
      getAutomaticClaimReadScope(budget),
    );

    expect(result).toEqual({ status: 'unavailable', reason: 'missing_store' });
    expect(budget.remaining).toBe(4);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reports snapshot byte exhaustion after stat and preserves the file', async () => {
    const before = fs.readFileSync(file, 'utf8');
    const budget = { remaining: 8, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    expect(reserveAutomaticClaimSnapshotBytes(scope, 100 * 1024 * 1024)).toBe(true);

    const result = await store.readCompositionalRetrievalSnapshotV3(scope);

    expect(result).toEqual({ status: 'deferred', reason: 'resource_exhausted' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('defers when the backing file is replaced during the snapshot read', async () => {
    const replacement = join(directory, 'replacement.json');
    fs.writeFileSync(replacement, fs.readFileSync(file, 'utf8'));
    const originalStat = fs.promises.stat.bind(fs.promises);
    let replaced = false;
    jest.spyOn(fs.promises, 'stat').mockImplementation(async (...args) => {
      const [path, options] = args;
      if (String(path) === file && !replaced) {
        replaced = true;
        fs.renameSync(file, `${file}.old`);
        fs.renameSync(replacement, file);
      }
      return originalStat(path, options as never) as never;
    });

    const result = await store.readCompositionalRetrievalSnapshotV3(
      getAutomaticClaimReadScope({ remaining: 8, deferred: 0 }),
    );

    expect(result).toEqual({ status: 'deferred', reason: 'concurrent_snapshot' });
    expect(replaced).toBe(true);
  });
});
