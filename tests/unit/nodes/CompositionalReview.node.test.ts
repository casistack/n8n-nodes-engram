import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EngramExplorer } from '../../../src/nodes/EngramExplorer/EngramExplorer.node';
import { embeddedAutomaticCaptureStoreHash } from '../../../src/storage/AutomaticCaptureStore';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { compositionalClaimReviewFamily } from '../../../src/utils/compositionalClaimReview';
import { createStorage } from '../../../src/storage/StorageFactory';

describe('Explorer compositional paired review dispatch', () => {
  let directory: string;
  let file: string;
  let f: ReturnType<typeof makeCompositionalCommittedClaimFixture>;
  beforeEach(() => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-explorer-rich-review-'));
    file = join(directory, 'synthetic-review-workflow-engram.json');
    f = makeCompositionalCommittedClaimFixture(
      'proposed',
      embeddedAutomaticCaptureStoreHash(file)!,
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await createStorage({ backend: 'embedded', persistPath: file }).close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const execute = async (extra: Record<string, unknown> = {}, version = 3) => {
    fs.writeFileSync(file, JSON.stringify(f.graph));
    const parameters: Record<string, unknown> = {
      backend: 'embedded',
      resource: 'relationship',
      operation: 'review',
      uuid: f.request.edgeId,
      factReviewStatus: 'accepted',
      factReviewedBy: 'synthetic-operator',
      customStoragePath: directory,
      ...extra,
    };
    const context = {
      getInputData: () => [{ json: {} }],
      getNodeParameter: (name: string, _i = 0, fallback?: unknown) =>
        Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
      getWorkflow: () => ({ id: 'synthetic-review-workflow' }),
      getWorkflowStaticData: () => ({}),
      getNode: () => ({ name: 'Engram Explorer', typeVersion: version }),
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
      getCredentials: jest.fn(() => {
        throw new Error('Unexpected credential access');
      }),
    };
    return new EngramExplorer().execute.call(context as never);
  };

  it('runs native Explorer v3 through actual atomic paired storage and keeps original receipt/source', async () => {
    const output = await execute();
    expect(output[0][0].json).toMatchObject({
      uuid: f.request.edgeId,
      _paired_review: { version: 3, outcome: 'reviewed' },
    });
    const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof f.graph;
    const edge = graph.edges[0];
    const value = graph.entities.find((row) => row.uuid === edge.target_node_uuid)!;
    expect(edge.attributes.engram_extraction).toEqual(value.attributes.engram_extraction);
    expect(edge.attributes.engram_extraction).toMatchObject({
      review_status: 'accepted',
      confidence: null,
      reviewed_by: 'synthetic-operator',
    });
    expect(graph.episodes).toEqual(f.graph.episodes);
    expect(graph.automatic_operations_v1).toEqual(f.graph.automatic_operations_v1);
  });

  it.each(['0.9', 'null'])(
    'rejects explicit rich confidence override %s before writing',
    async (value) => {
      await expect(execute({ factConfidenceOverride: value })).rejects.toThrow(
        'Confidence override is unavailable',
      );
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(f.graph);
    },
  );

  it.each([1, 2])('requires Explorer v3 for rich claims, version=%s', async (version) => {
    await expect(execute({}, version)).rejects.toThrow('unsupported_mode');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(f.graph);
  });

  it.each([{}, { version: 999 }, { version: 1, generation: 'compositional-preferences-v2' }])(
    'rejects malformed/unknown rich markers before the old edge-only path',
    async (marker) => {
      f.graph.edges[0].attributes.engram_claim_v1 = marker;
      await expect(execute()).rejects.toThrow('invalid_claim');
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(f.graph);
    },
  );

  it('keeps ordinary and old version-one dispatch while inspecting only bounded owned marker data', () => {
    expect(compositionalClaimReviewFamily({ ordinary: 'x'.repeat(600_000) })).toBe('ordinary');
    expect(compositionalClaimReviewFamily({ engram_claim_v1: { version: 1 } })).toBe('literal');
    expect(compositionalClaimReviewFamily(f.graph.edges[0].attributes)).toBe('compositional');
    let traps = 0;
    const attrs = Object.defineProperty({}, 'engram_claim_v1', {
      enumerable: true,
      get: () => (++traps, {}),
    });
    expect(compositionalClaimReviewFamily(attrs)).toBe('invalid');
    expect(compositionalClaimReviewFamily(new Proxy({}, { get: () => (++traps, {}) }))).toBe(
      'invalid',
    );
    expect(traps).toBe(0);
  });
});
