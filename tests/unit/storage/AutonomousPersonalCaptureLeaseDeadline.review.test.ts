import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { dispatchNativeAutonomousPersonalCaptureV4 } from '../../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../../helpers/autonomousPersonalCaptureBackend';

describe('Autonomous Personal V4 lease deadline review cases', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-autonomous-v4-deadline-review-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('maps expiry during positive-row verification to budget_exhausted, without returning a handle', async () => {
    let monotonicNow = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => monotonicNow);

    const schema = AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema;
    const parse = schema.parse.bind(schema);
    let outputParseCount = 0;
    jest.spyOn(schema, 'parse').mockImplementation((value, params) => {
      const parsed = parse(value, params);
      outputParseCount += 1;
      // The first parse is the write candidate, the second is the positive
      // coherent readback, and the third is the registry's actual-row parse.
      // Let the registry's initial deadline check pass, then cross the deadline
      // while it compares the already-owned actual rows with the staged rows.
      if (outputParseCount === 3) monotonicNow = 100;
      return parsed;
    });

    const result = await dispatchNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed, { deadlineMs: 100 }),
      store,
    );

    expect(outputParseCount).toBe(3);
    expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
    expect(result).not.toHaveProperty('handle');
    const graph = await store.exportGraph();
    expect(graph.episodes).toHaveLength(1);
    expect(graph.automatic_operations_v1?.operations).toHaveLength(1);
    expect(graph.automatic_operations_v1?.operations[0].attempts[0].disposition).toBe('claim_won');
  });
});
