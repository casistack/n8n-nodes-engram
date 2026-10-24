import { mkdtemp, rm, readFile, unlink, access } from 'fs/promises';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { StorageAccumulator } from '../../../src/storage/StorageDiagnostics';
import { QueueLimitsSchema } from '../../../src/schemas';
describe('operation-local storage diagnostics', () => {
  it('isolates overlapping mutations without a shared last-result read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-observer-'));
    const storage = new GraphologyStorage(join(dir, 'store.json'));
    await storage.initialize();
    const first = new StorageAccumulator(),
      second = new StorageAccumulator();
    try {
      await Promise.all([
        storage.withExtractionDiagnostics(
          (value) => first.observe(value),
          async () => {
            await storage.addEntity({ group_id: 'one', name: 'A' });
            await storage.addEntity({ group_id: 'one', name: 'B' });
          },
        ),
        storage.withExtractionDiagnostics(
          (value) => second.observe(value),
          async () => {
            await storage.addEntity({ group_id: 'two', name: 'C' });
          },
        ),
      ]);
      expect(first.snapshot()).toMatchObject({
        operations: 2,
        unconfirmed: 0,
        samples: { snapshot_write_ms: 2, lock_wait_ms: 2, transaction_ms: 0 },
      });
      expect(second.snapshot()).toMatchObject({
        operations: 1,
        unconfirmed: 0,
        transaction_ms: null,
        samples: { serialization_ms: 1 },
      });
      expect(JSON.stringify(first.snapshot())).not.toContain('group');
    } finally {
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('records unavailable and invalid measurements honestly', () => {
    const value = new StorageAccumulator();
    expect(value.snapshot()).toBeNull();
    value.observe({ PRIVATE: 'secret' });
    expect(value.snapshot()).toMatchObject({
      operations: 0,
      invalid_samples: 1,
      lock_wait_ms: null,
    });
    expect(JSON.stringify(value.snapshot())).not.toContain('PRIVATE');
  });
  it('preserves the old snapshot on a failed atomic rename and records an unconfirmed write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-write-failure-'));
    const file = join(dir, 'store.json');
    const storage = new GraphologyStorage(file);
    await storage.initialize();
    await storage.addEntity({ group_id: 'one', name: 'Preserved' });
    const before = await readFile(file, 'utf8');
    const metrics = new StorageAccumulator();
    const failure = Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' });
    const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(failure);
    try {
      await expect(
        storage.withExtractionDiagnostics(
          (value) => metrics.observe(value),
          () => storage.addEntity({ group_id: 'one', name: 'Uncommitted' }),
        ),
      ).rejects.toThrow('Synthetic disk full');
      expect(await readFile(file, 'utf8')).toBe(before);
      expect((await storage.listEntities('one')).map((entity) => entity.name)).toEqual([
        'Preserved',
      ]);
      expect(metrics.snapshot()).toMatchObject({
        operations: 1,
        unconfirmed: 1,
        samples: { snapshot_write_ms: 1, serialization_ms: 1 },
      });
    } finally {
      rename.mockRestore();
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('cannot turn a successful write into a failed save when an observer throws', async () => {
    const storage = new GraphologyStorage();
    await storage.initialize();
    try {
      await storage.withExtractionDiagnostics(
        () => {
          throw new Error('diagnostics failure');
        },
        () => storage.addEntity({ group_id: 'one', name: 'Committed' }),
      );
      expect((await storage.listEntities('one')).map((entity) => entity.name)).toEqual([
        'Committed',
      ]);
    } finally {
      await storage.close();
    }
  });
  it('keeps file and directory fsync enabled for ordinary writes after queue activation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-queue-sync-'));
    const file = join(dir, 'store.json');
    const storage = new GraphologyStorage(file);
    await storage.initialize();
    try {
      await storage.appendEpisodesWithExtraction(
        [
          {
            group_id: 'one',
            content: 'Alder likes cobalt.',
            role: 'human',
            episode_kind: 'active_human',
            reference_time: '2026-10-24T12:00:00Z',
          },
        ],
        [0],
        { route_id: 'local', config_hash: 'a'.repeat(64) },
        QueueLimitsSchema.parse({}),
      );
      const writer = jest.spyOn(storage as any, 'writeTextAtomic');
      const synced: string[] = [];
      const open = fs.promises.open.bind(fs.promises);
      const openSpy = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        jest.spyOn(handle, 'sync').mockImplementation(async () => {
          synced.push(String(args[0]));
          await sync();
        });
        return handle;
      });
      await storage.addEntity({ group_id: 'one', name: 'Ordinary writer' });
      expect(writer.mock.calls[0][2]).toBe(true);
      expect(synced).toContain(dir);
      expect(synced).toContain(tmpdir());
      expect(synced.some((file) => file.endsWith('.tmp'))).toBe(true);
      openSpy.mockRestore();
      writer.mockRestore();
      const fresh = new GraphologyStorage(file);
      await fresh.initialize();
      try {
        expect(
          (
            await fresh.extractionQueueCommand({
              action: 'status',
              group_id: 'one',
              binding: { route_id: 'local', config_hash: 'a'.repeat(64) },
            })
          ).pending,
        ).toBe(1);
        expect((await fresh.listEntities('one')).map((entity) => entity.name)).toEqual([
          'Ordinary writer',
        ]);
      } finally {
        await fresh.close();
      }
      await unlink(file);
      await expect(storage.readExtractionSnapshot('one')).rejects.toThrow('store_missing');
      await expect(
        storage.extractionQueueCommand({
          action: 'claim',
          group_id: 'one',
          binding: { route_id: 'local', config_hash: 'a'.repeat(64) },
        }),
      ).rejects.toThrow('store_missing');
      await expect(access(file)).rejects.toThrow();
    } finally {
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
