import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import {
  dispatchNativeAutonomousPersonalCaptureV4,
  getAutonomousPersonalCaptureBeginV4InternalResultSchema,
} from '../../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../../helpers/autonomousPersonalCaptureBackend';

describe('Autonomous Personal V4 exact committed-proof boundaries', () => {
  let directory: string;
  let store: GraphologyStorage;
  let seed: Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-autonomous-v4-proof-'));
    store = new GraphologyStorage(join(directory, 'store.json'));
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retains a proven commit budget failure after unknown acknowledgment without a second write', async () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const schema = AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema;
    const parse = schema.parse.bind(schema);
    let parses = 0;
    jest.spyOn(schema, 'parse').mockImplementation((value, options) => {
      const result = parse(value, options);
      if (++parses === 3) now = 100;
      return result;
    });

    const internal = store as unknown as {
      runMutation(
        work: () => unknown | Promise<unknown>,
        options?: { operation?: string },
      ): Promise<unknown>;
    };
    const mutate = internal.runMutation.bind(store);
    let writes = 0;
    jest.spyOn(internal, 'runMutation').mockImplementation(async (work, options) => {
      const result = await mutate(work, options);
      if (options?.operation === 'autonomous_personal_begin_v4') {
        writes += 1;
        throw new Error('synthetic acknowledgement loss after the real durable write');
      }
      return result;
    });

    const result = await dispatchNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed, { deadlineMs: 100 }),
      store,
    );
    expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
    expect(result).not.toHaveProperty('handle');
    expect(writes).toBe(1);
    expect(parses).toBe(3);
    const actual = await store.exportGraph();
    expect(actual.episodes).toHaveLength(1);
    expect(actual.automatic_operations_v1?.operations).toHaveLength(1);
  });

  it.each([1, 2])(
    'preserves budget expiry at claimed-result parse boundary %s',
    async (boundary) => {
      let now = 0;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      const schema = getAutonomousPersonalCaptureBeginV4InternalResultSchema();
      const parse = schema.parse.bind(schema);
      let claimedParses = 0;
      jest.spyOn(schema, 'parse').mockImplementation((value, options) => {
        if (
          value !== null &&
          typeof value === 'object' &&
          'kind' in value &&
          value.kind === 'claimed' &&
          ++claimedParses === boundary
        ) {
          now = 100;
        }
        return parse(value, options);
      });
      const result = await dispatchNativeAutonomousPersonalCaptureV4(
        nativeAutonomousPersonalCaptureContext(seed, { deadlineMs: 100 }),
        store,
      );
      expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
      expect(result).not.toHaveProperty('handle');
      expect(claimedParses).toBe(boundary);
      const actual = await store.exportGraph();
      expect(actual.episodes).toHaveLength(1);
      expect(actual.automatic_operations_v1?.operations).toHaveLength(1);
    },
  );

  it('rejects an altered immutable operation counter without changing persisted records', async () => {
    const schema = AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema;
    const parse = schema.parse.bind(schema);
    let parses = 0;
    jest.spyOn(schema, 'parse').mockImplementation((value, options) => {
      const result = parse(value, options);
      if (++parses === 3 && result.kind === 'same_initial_scope_candidate')
        result.operation.overflowCount += 1;
      return result;
    });

    const result = await dispatchNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed),
      store,
    );
    expect(result).toEqual({ kind: 'conflict', eligibleFirstCommit: false });
    expect(parses).toBe(3);
    expect(result).not.toHaveProperty('handle');
    const actual = await store.exportGraph();
    expect(actual.episodes).toHaveLength(1);
    expect(actual.automatic_operations_v1?.operations[0].overflowCount).toBe(0);
  });
});
