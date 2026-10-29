import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';
import {
  corruptProviderOperation,
  providerTamperContract,
} from '../helpers/autonomousPersonalProviderTamperContract';

providerTamperContract(async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-provider-tamper-'));
  const file = join(directory, 'store.json');
  const store = new GraphologyStorage(file);
  await store.initialize();
  const seed = await seedAutonomousPersonalCaptureSubject(store);
  return {
    store,
    seed,
    nativeState: async () => fs.readFileSync(file, 'utf8'),
    corrupt: async (kind) => {
      const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
      const source = graph.episodes.find(
        (episode: { group_id: string }) => episode.group_id === seed.request.namespace,
      );
      if (kind === 'source_content') source.content = 'I prefer an altered source.';
      if (kind === 'source_owner') source.attributes.engram_write_owner_v4 = { invalid: true };
      if (kind === 'source_envelope')
        source.attributes.engram_source_envelope_v3 = { invalid: true };
      if (kind === 'source_missing') graph.episodes = [];
      if (kind === 'operation_missing') graph.automatic_operations_v1.operations = [];
      else corruptProviderOperation(graph.automatic_operations_v1.operations[0], kind);
      fs.writeFileSync(file, JSON.stringify(graph));
    },
    close: async () => {
      await store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
});
