import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { GraphDataSchema } from '../../src/schemas';
import { EngramChatMessageHistory } from '../../src/memory/EngramChatMessageHistory';

describe('fixed published-schema compatibility fixtures', () => {
  const directory = join(__dirname, '../fixtures/compatibility');
  const manifest = JSON.parse(fs.readFileSync(join(directory, 'manifest.json'), 'utf8'));
  test.each(Object.keys(manifest))(
    '%s remains readable and unchanged after new writes',
    async (file) => {
      const bytes = fs.readFileSync(join(directory, file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest[file].sha256);
      const original = GraphDataSchema.parse(JSON.parse(bytes.toString()));
      const work = fs.mkdtempSync(join(tmpdir(), 'engram-published-store-'));
      const storageFile = join(work, 'store.json');
      fs.writeFileSync(storageFile, bytes);
      let storage = new GraphologyStorage(storageFile);
      try {
        await storage.initialize();
        const before = await storage.readExtractionSnapshot();
        for (const kind of ['entities', 'edges', 'episodes'] as const)
          expect(before[kind]).toEqual(original[kind]);
        const defaults = new EngramChatMessageHistory({
          storage,
          groupId: 'synthetic-compatibility',
          contextWindow: 10,
        });
        expect((await defaults.getMessages()).map((message) => message.content)).toEqual(
          original.episodes.map((episode) => episode.content),
        );
        const filtered = new EngramChatMessageHistory({
          storage,
          groupId: 'synthetic-compatibility',
          contextWindow: 10,
          policy: { historyFilter: 'provenance' },
        });
        expect((await filtered.getMessages()).map((message) => message.content)).toEqual([
          'I prefer concise explanations.',
          'Understood.',
        ]);
        await storage.appendEpisodes([
          {
            group_id: 'synthetic-compatibility',
            content: 'A new legitimate message.',
            role: 'human',
            reference_time: '2026-10-26T10:00:00.000Z',
            episode_kind: 'active_human',
          },
        ]);
        await storage.close();
        storage = new GraphologyStorage(storageFile);
        await storage.initialize();
        const after = await storage.readExtractionSnapshot();
        for (const kind of ['entities', 'edges', 'episodes'] as const) {
          const persisted = new Map(after[kind].map((record) => [record.uuid, record]));
          for (const record of original[kind]) expect(persisted.get(record.uuid)).toEqual(record);
        }
        expect(after.episodes).toHaveLength(original.episodes.length + 1);
        expect(after.episodes.at(-1)?.previous_episode_uuid).toBe(original.episodes.at(-1)?.uuid);
      } finally {
        await storage.close();
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
  );
});
