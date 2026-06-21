import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EngramAdmin } from '../../../src/nodes/EngramAdmin/EngramAdmin.node';
import { createStorage } from '../../../src/storage/StorageFactory';
import { resolveStoragePath } from '../../../src/utils/helpers';

function createExecuteContext(options: {
  tempDir: string;
  operation: string;
  parameters?: Record<string, unknown>;
}) {
  const parameters: Record<string, unknown> = {
    backend: 'embedded',
    resource: 'lifecycle',
    operation: options.operation,
    customStoragePath: options.tempDir,
    ...options.parameters,
  };

  return {
    getInputData() {
      return [{ json: {} }];
    },
    getNodeParameter(name: string, itemIndex = 0, fallback?: unknown) {
      void itemIndex;
      return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback;
    },
    getWorkflow() {
      return { id: 'wf-admin-test' };
    },
    getWorkflowStaticData() {
      return {};
    },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
    getNode() {
      return { name: 'Engram Admin' };
    },
  } as never;
}

describe('EngramAdmin', () => {
  let tempDir: string;
  let persistPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-admin-'));
    persistPath = resolveStoragePath({
      customStoragePath: tempDir,
      workflowId: 'wf-admin-test',
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

  it('requires confirmation before clearAll executes', async () => {
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'clearAll',
      parameters: {
        confirmDestructive: false,
      },
    });

    await expect(admin.execute.call(context)).rejects.toThrow(
      'Confirm Destructive must be enabled to proceed with Clear All',
    );
  });

  it('returns quick diagnostics without scanning the full graph by default', async () => {
    const admin = new EngramAdmin();
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    await storage.addEntity({
      name: 'Alice',
      group_id: 'diag-group',
      summary: 'A person',
      entity_type: 'person',
    });

    const context = createExecuteContext({
      tempDir,
      operation: 'diagnostics',
      parameters: {
        resource: 'monitoring',
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        operation: 'diagnostics',
        status: 'ok',
        storage_backend: 'embedded',
        initialized: true,
        deep_checks: 'disabled',
      }),
    );
    expect(result[0][0].json.quick_checks).toEqual(
      expect.objectContaining({
        group_count: 1,
        entity_count: 1,
        edge_count: 0,
        episode_count: 0,
      }),
    );
    expect(result[0][0].json.embedded_storage).toEqual(
      expect.objectContaining({
        workflow_id: 'wf-admin-test',
        persist_path: persistPath,
        custom_storage_path_configured: true,
      }),
    );
  });

  it('runs opt-in deep diagnostics for graph quality checks', async () => {
    const admin = new EngramAdmin();
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();
    const alice = await storage.addEntity({
      name: 'Alice',
      group_id: 'diag-group',
      summary: 'A person',
      entity_type: 'person',
      name_embedding: [0.1, 0.2],
    });
    const bob = await storage.addEntity({
      name: 'Bob',
      group_id: 'diag-group',
      summary: 'A person',
      entity_type: 'person',
    });
    await storage.addEdge({
      group_id: 'diag-group',
      source_node_uuid: alice.uuid,
      target_node_uuid: bob.uuid,
      name: 'KNOWS',
      fact: 'Alice knows Bob',
      fact_embedding: [0.3, 0.4],
    });

    const context = createExecuteContext({
      tempDir,
      operation: 'diagnostics',
      parameters: {
        resource: 'monitoring',
        includeDeepChecks: 'enabled',
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json.deep_checks).toEqual(
      expect.objectContaining({
        scanned_full_graph: true,
        active_edge_count: 1,
        expired_edge_count: 0,
        invalidated_edge_count: 0,
        dangling_edge_count: 0,
        duplicate_entity_name_groups: 0,
        entities_with_name_embeddings: 1,
        edges_with_fact_embeddings: 1,
      }),
    );
  });

  it('rejects import payloads that do not match the graph schema', async () => {
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'import',
      parameters: {
        resource: 'portability',
        importData: {
          version: '1.0',
          exported_at: 'not-a-date',
          entities: [],
          edges: [],
          episodes: [],
        },
      },
    });

    await expect(admin.execute.call(context)).rejects.toThrow('Invalid import data format');
  });

  it('imports valid graph schema payloads', async () => {
    const admin = new EngramAdmin();
    const context = createExecuteContext({
      tempDir,
      operation: 'import',
      parameters: {
        resource: 'portability',
        importData: {
          version: '1.0',
          exported_at: new Date().toISOString(),
          entities: [],
          edges: [],
          episodes: [],
        },
      },
    });

    const result = await admin.execute.call(context);

    expect(result[0][0].json).toEqual({
      success: true,
      operation: 'import',
      imported: {
        entities: 0,
        edges: 0,
        episodes: 0,
      },
    });
  });
});
