import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStorage } from '../../../src/storage/StorageFactory';
import { resolveStoragePath } from '../../../src/utils/helpers';
import { EngramTrigger } from '../../../src/nodes/EngramTrigger/EngramTrigger.node';
import type { GraphData } from '../../../src/schemas';

function makeUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
}

function createPollContext(options: {
  tempDir: string;
  event: 'new_entity' | 'new_episode' | 'new_relationship';
  groupId?: string;
  workflowId?: string;
  staticData?: Record<string, unknown>;
}) {
  const workflowId = options.workflowId ?? 'wf-trigger-test';
  const staticData = options.staticData ?? {};
  const parameters: Record<string, unknown> = {
    backend: 'embedded',
    event: options.event,
    groupId: options.groupId ?? '',
    customStoragePath: options.tempDir,
  };

  return {
    getNodeParameter(name: string, fallback?: unknown) {
      return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback;
    },
    getWorkflowStaticData() {
      return staticData;
    },
    getWorkflow() {
      return { id: workflowId };
    },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    getNode() {
      return { name: 'Engram Trigger' };
    },
  } as never;
}

describe('EngramTrigger', () => {
  let tempDir: string;
  let persistPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-trigger-'));
    persistPath = resolveStoragePath({
      customStoragePath: tempDir,
      workflowId: 'wf-trigger-test',
    });
  });

  afterEach(async () => {
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    await storage.clearAll();
    await storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('watches all groups when Group ID is blank', async () => {
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();

    await storage.addEntity({
      name: 'Alice',
      group_id: 'group-a',
      entity_type: 'person',
    });
    await storage.addEntity({
      name: 'Bob',
      group_id: 'group-b',
      entity_type: 'person',
    });

    const trigger = new EngramTrigger();
    const staticData: Record<string, unknown> = {};
    const context = createPollContext({
      tempDir,
      event: 'new_entity',
      groupId: '',
      staticData,
    });

    const result = await trigger.poll.call(context);
    expect(result).not.toBeNull();
    expect(result![0]).toHaveLength(2);

    const names = result![0].map((item) => item.json.name).sort();
    expect(names).toEqual(['Alice', 'Bob']);

    const secondResult = await trigger.poll.call(context);
    expect(secondResult).toBeNull();
    expect(staticData.__engramTriggerCursor).toBeDefined();
  });

  it('does not lose events when more than 100 items are created between polls', async () => {
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();

    for (let i = 0; i < 105; i++) {
      await storage.addEpisode({
        group_id: 'group-a',
        content: `Episode ${i}`,
        role: 'human',
        reference_time: new Date().toISOString(),
      });
    }

    const trigger = new EngramTrigger();
    const context = createPollContext({
      tempDir,
      event: 'new_episode',
      groupId: 'group-a',
    });

    const result = await trigger.poll.call(context);
    expect(result).not.toBeNull();
    expect(result![0]).toHaveLength(105);
  });

  it('uses a deterministic cursor when multiple records share the same timestamp', async () => {
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();

    const sharedTime = '2026-03-21T12:00:00.000Z';
    const initialData: GraphData = {
      version: '2.0',
      exported_at: sharedTime,
      group_id: 'group-a',
      entities: [
        {
          uuid: makeUuid(1),
          name: 'Alpha',
          group_id: 'group-a',
          summary: '',
          entity_type: 'person',
          name_embedding: null,
          attributes: {},
          created_at: sharedTime,
          updated_at: sharedTime,
        },
        {
          uuid: makeUuid(2),
          name: 'Bravo',
          group_id: 'group-a',
          summary: '',
          entity_type: 'person',
          name_embedding: null,
          attributes: {},
          created_at: sharedTime,
          updated_at: sharedTime,
        },
      ],
      edges: [],
      episodes: [],
    };
    await storage.importGraph(initialData);

    const trigger = new EngramTrigger();
    const staticData: Record<string, unknown> = {};
    const context = createPollContext({
      tempDir,
      event: 'new_entity',
      groupId: 'group-a',
      staticData,
    });

    const firstResult = await trigger.poll.call(context);
    expect(firstResult).not.toBeNull();
    expect(firstResult![0].map((item) => item.json.uuid)).toEqual([makeUuid(1), makeUuid(2)]);

    const followUpData: GraphData = {
      version: '2.0',
      exported_at: sharedTime,
      group_id: 'group-a',
      entities: [
        {
          uuid: makeUuid(3),
          name: 'Charlie',
          group_id: 'group-a',
          summary: '',
          entity_type: 'person',
          name_embedding: null,
          attributes: {},
          created_at: sharedTime,
          updated_at: sharedTime,
        },
      ],
      edges: [],
      episodes: [],
    };
    await storage.importGraph(followUpData);

    const secondResult = await trigger.poll.call(context);
    expect(secondResult).not.toBeNull();
    expect(secondResult![0]).toHaveLength(1);
    expect(secondResult![0][0].json.uuid).toBe(makeUuid(3));
  });
});
