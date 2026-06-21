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
