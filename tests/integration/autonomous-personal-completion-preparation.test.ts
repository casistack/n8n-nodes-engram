import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';
import {
  autonomousPersonalCompletionPreparationContract,
  type AutonomousPersonalCompletionPreparationFixture,
} from '../helpers/autonomousPersonalCompletionPreparationContract';

autonomousPersonalCompletionPreparationContract(
  async (): Promise<AutonomousPersonalCompletionPreparationFixture> => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'engram-completion-preparation-'));
    const store = new GraphologyStorage(join(directory, 'store.json'));
    try {
      await store.initialize();
      const seed = await seedAutonomousPersonalCaptureSubject(store);
      return {
        store,
        seed,
        close: async () => {
          await store.close();
          fs.rmSync(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await store.close();
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  },
);
