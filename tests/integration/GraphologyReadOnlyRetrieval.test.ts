import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { getAutomaticClaimReadScope } from '../../src/storage/AutomaticClaimReadScope';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';

describe('retrieval needs read authority only', () => {
  it('returns a detached coherent snapshot without entering the mutation/rollback frame', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'engram-read-only-retrieval-'));
    const file = join(directory, 'store.json');
    const store = new GraphologyStorage(file);
    try {
      await store.initialize();
      await seedAutomaticCaptureSubject(store, 'synthetic-read-a');
      await seedAutomaticCaptureSubject(store, 'synthetic-read-b');
      const before = fs.readFileSync(file);
      const mutation = jest.spyOn(store as never, 'runMutation' as never).mockImplementation(() => {
        throw new Error('mutation_authority_unavailable');
      });
      const scope = () => getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
      const result = await store.readCompositionalRetrievalSnapshotV3(scope());
      expect(result.status).toBe('snapshot');
      if (result.status !== 'snapshot') throw new Error(result.status);
      expect(result.graph.entities.map((entity) => entity.group_id).sort()).toEqual([
        'synthetic-read-a',
        'synthetic-read-b',
      ]);
      expect(Object.prototype.hasOwnProperty.call(result.graph, 'group_id')).toBe(false);
      expect(Number.isFinite(Date.parse(result.graph.exported_at))).toBe(true);
      result.graph.entities.length = 0;
      const second = await store.readCompositionalRetrievalSnapshotV3(scope());
      expect(second.status).toBe('snapshot');
      if (second.status !== 'snapshot') throw new Error(second.status);
      expect(second.graph.entities).toHaveLength(2);
      expect(mutation).not.toHaveBeenCalled();
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(store.getLastMutationDiagnostics()).toMatchObject({
        operation: 'compositional_retrieval_snapshot_v3',
        success: true,
        snapshot_written: false,
        rollback_export_ms: 0,
        snapshot_write_ms: 0,
      });
    } finally {
      jest.restoreAllMocks();
      await store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
