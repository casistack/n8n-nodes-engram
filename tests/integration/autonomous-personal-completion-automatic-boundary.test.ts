import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GraphData } from '../../src/schemas/GraphData.schema';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';
import {
  autonomousPersonalAutomaticCompletionContract,
  type AutonomousPersonalAutomaticCompletionFixture,
} from '../helpers/autonomousPersonalAutomaticCompletionContract';

autonomousPersonalAutomaticCompletionContract(
  async (): Promise<AutonomousPersonalAutomaticCompletionFixture> => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'engram-automatic-completion-boundary-'));
    const file = join(directory, 'store.json');
    let store = new GraphologyStorage(file);
    let storeOpen = false;
    try {
      await store.initialize();
      storeOpen = true;
      const seed = await seedAutonomousPersonalCaptureSubject(store);
      return {
        get storage() {
          return store;
        },
        seed,
        readPersisted: async () => JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData,
        reopen: async () => {
          if (storeOpen) await store.close();
          storeOpen = false;
          store = new GraphologyStorage(file);
          await store.initialize();
          storeOpen = true;
        },
        cleanup: async () => {
          try {
            if (storeOpen) await store.close();
          } finally {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      try {
        if (storeOpen) await store.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
      throw error;
    }
  },
);
