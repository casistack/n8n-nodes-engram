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

  it('supports offset pagination when listing entities', async () => {
    const storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    await storage.initialize();

    await storage.addEntity({ name: 'Alice', group_id: 'g1', entity_type: 'person' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.addEntity({ name: 'Bob', group_id: 'g1', entity_type: 'person' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.addEntity({ name: 'Carol', group_id: 'g1', entity_type: 'person' });

    const explorer = new EngramExplorer();
    const context = createExecuteContext({
      tempDir,
      parameters: {
        resource: 'entity',
        operation: 'list',
        groupId: 'g1',
        limit: 1,
        offset: 1,
      },
    });

    const result = await explorer.execute.call(context);

    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json.name).toBe('Bob');
  });

  it('lists episodes using provenance filters and pagination', async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    await storage.appendEpisode({
      group_id: 'g1',
      content: 'Trusted human message',
      role: 'human',
      reference_time: '2026-07-15T10:00:00.000Z',
      episode_kind: 'active_human',
      trust_level: 'trusted',
      review_status: 'accepted',
      sender_id: 'sender-1',
    });
    await storage.appendEpisode({
      group_id: 'g1',
      content: 'Monitor summary',
      role: 'system',
      reference_time: '2026-07-15T11:00:00.000Z',
      episode_kind: 'monitor_summary',
      trust_level: 'unverified',
    });

    const explorer = new EngramExplorer();
    const context = createExecuteContext({
      tempDir,
      parameters: {
        resource: 'episode',
        operation: 'list',
        groupId: 'g1',
        episodeKindFilter: 'active_human',
        episodeTrustFilter: 'trusted',
        limit: 10,
        offset: 0,
      },
    });

    const result = await explorer.execute.call(context);

    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        content: 'Trusted human message',
        sender_id: 'sender-1',
        review_status: 'accepted',
      }),
    );
  });

  it('updates episode governance fields without changing provenance identity', async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const created = await storage.appendEpisode({
      group_id: 'g1',
      content: 'Candidate memory',
      role: 'human',
      reference_time: '2026-07-15T10:00:00.000Z',
      episode_kind: 'passive_human',
      source_message_id: 'message-1',
      trust_level: 'unverified',
    });

    const explorer = new EngramExplorer();
    const context = createExecuteContext({
      tempDir,
      parameters: {
        resource: 'episode',
        operation: 'update',
        uuid: created.episode.uuid,
        episodeTrustUpdate: 'trusted',
        episodeReviewUpdate: 'accepted',
        episodeConfidenceUpdate: '0.9',
        attributes: { reviewer: 'operator' },
      },
    });

    const result = await explorer.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        uuid: created.episode.uuid,
        source_message_id: 'message-1',
        episode_kind: 'passive_human',
        trust_level: 'trusted',
        review_status: 'accepted',
        confidence: 0.9,
        attributes: { reviewer: 'operator' },
      }),
    );
  });

  it('deletes an episode through the lifecycle contract', async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const created = await storage.appendEpisode({
      group_id: 'g1',
      content: 'Remove me',
      role: 'system',
      reference_time: '2026-07-15T10:00:00.000Z',
      episode_kind: 'tool_output',
    });

    const explorer = new EngramExplorer();
    const context = createExecuteContext({
      tempDir,
      parameters: {
        resource: 'episode',
        operation: 'delete',
        uuid: created.episode.uuid,
        repairEpisodeChain: 'enabled',
        episodeFactCleanup: 'unlink',
      },
    });

    const result = await explorer.execute.call(context);

    expect(result[0][0].json).toEqual(
      expect.objectContaining({
        episode_uuid: created.episode.uuid,
        deleted: true,
      }),
    );
  });

  it('records audited relationship review transitions', async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1' });
    const edge = await storage.addEdge({
      group_id: 'g1',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact: 'Alice may work at Acme',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'llm',
          confidence: 0.5,
          review_status: 'proposed',
          threshold_decision: 'pending_review',
          extracted_at: '2026-07-15T10:00:00.000Z',
          episode_uuids: [],
        },
      },
    });

    const explorer = new EngramExplorer();
    const context = createExecuteContext({
      tempDir,
      parameters: {
        resource: 'relationship',
        operation: 'review',
        uuid: edge.uuid,
        factReviewStatus: 'accepted',
        factReviewedBy: 'operator-1',
        factConfidenceOverride: '0.9',
      },
    });

    const result = await explorer.execute.call(context);
    const metadata = (result[0][0].json.attributes as Record<string, unknown>)
      .engram_extraction as Record<string, unknown>;
    expect(metadata).toEqual(
      expect.objectContaining({
        review_status: 'accepted',
        threshold_decision: 'manually_reviewed',
        confidence: 0.9,
        reviewed_by: 'operator-1',
      }),
    );
    expect(metadata.reviewed_at).toEqual(expect.any(String));
  });

  it('filters relationship search by source provenance and returns the provenance trace', async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1' });
    const episode = await storage.appendEpisode({
      group_id: 'g1',
      content: 'I work at Acme',
      role: 'human',
      reference_time: '2026-07-15T10:00:00.000Z',
      episode_kind: 'active_human',
      sender_id: 'sender-1',
      sender_name: 'Alice',
      trust_level: 'trusted',
      review_status: 'accepted',
      source_workflow_id: 'workflow-chat',
    });
    await storage.addEdge({
      group_id: 'g1',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact: 'Alice works at Acme',
      episodes: [episode.episode.uuid],
    });

    const explorer = new EngramExplorer();
    const context = createExecuteContext({
      tempDir,
      parameters: {
        resource: 'relationship',
        operation: 'search',
        groupId: 'g1',
        query: 'Alice works',
        searchMode: 'text',
        factSenderIdFilter: 'sender-1',
        factEpisodeKindFilter: 'active_human',
        factTrustFilter: 'trusted',
        factSourceWorkflowFilter: 'workflow-chat',
      },
    });

    const result = await explorer.execute.call(context);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json._provenance).toEqual([
      expect.objectContaining({
        source_episode_uuid: episode.episode.uuid,
        sender_id: 'sender-1',
        sender_name: 'Alice',
        episode_kind: 'active_human',
        trust_level: 'trusted',
        source_workflow_id: 'workflow-chat',
      }),
    ]);
  });

  it('returns an aggregate bounded retrieval audit only when diagnostics are enabled', async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1' });
    await storage.addEdge({
      group_id: 'g1',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact: 'Alice works at Acme',
    });

    const explorer = new EngramExplorer();
    const context = createExecuteContext({
      tempDir,
      parameters: {
        resource: 'relationship',
        operation: 'search',
        groupId: 'g1',
        query: 'Alice works',
        searchMode: 'text',
        retrievalDiagnostics: 'enabled',
        diagnosticsCandidateLimit: 1,
        diagnosticsContextTokenBudget: 128,
      },
    });

    const result = await explorer.execute.call(context);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json.results).toEqual([
      expect.objectContaining({ fact: 'Alice works at Acme' }),
    ]);
    expect(result[0][0].json._retrieval_audit).toEqual(
      expect.objectContaining({
        normalized_query: 'Alice works',
        candidate_limit: 1,
        context_budget: expect.objectContaining({ total_token_budget: 128 }),
      }),
    );
    expect(JSON.stringify(result[0][0].json)).not.toContain('test-key');
  });
});
