import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EngramExplorer } from '../../../src/nodes/EngramExplorer/EngramExplorer.node';
import { createStorage } from '../../../src/storage/StorageFactory';
import { resolveStoragePath } from '../../../src/utils/helpers';

const mockFetch = jest.fn();
global.fetch = mockFetch;

function createExecuteContext(options: {
  tempDir: string;
  parameters?: Record<string, unknown>;
}) {
  const parameters: Record<string, unknown> = {
    backend: 'embedded',
    resource: 'entity',
    operation: 'search',
    groupId: 'g1',
    query: 'semantic query',
    limit: 10,
    minRelevanceScore: 0,
    searchMode: 'hybrid',
    embeddingModel: 'text-embedding-3-small',
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
    async getCredentials(name: string) {
      if (name === 'engramExtractionApi') {
        return {
          apiKey: 'test-key',
          baseUrl: 'https://embed.example.com/v1',
        };
      }
      throw new Error(`Unexpected credential: ${name}`);
    },
    getWorkflow() {
      return { id: 'wf-explorer-test' };
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
      return { name: 'Engram Explorer' };
    },
  } as never;
}

describe('EngramExplorer', () => {
  let tempDir: string;
  let persistPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-explorer-'));
    persistPath = resolveStoragePath({
      customStoragePath: tempDir,
      workflowId: 'wf-explorer-test',
    });
    mockFetch.mockReset();
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

  it('supports hybrid semantic search through the Explorer node', async () => {
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();

    await storage.addEntity({
      name: 'Alice',
      group_id: 'g1',
      summary: 'A developer',
      entity_type: 'person',
      name_embedding: [1, 0],
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: [1, 0], index: 0 }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    });

    const explorer = new EngramExplorer();
    const context = createExecuteContext({ tempDir });

    const result = await explorer.execute.call(context);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json.name).toBe('Alice');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
