import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { compositionalClaimReviewPairHashV3 } from '../../src/storage/CompositionalClaimReviewV3';
import { makeCompositionalCommittedClaimFixture } from '../helpers/compositionalCommittedClaimFixture';
import { validateCompositionalQualifiedClaimReadV3 } from '../../src/extraction/CompositionalQualifiedClaimReadV3';

describe('embedded atomic compositional operator review', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let f: ReturnType<typeof makeCompositionalCommittedClaimFixture>;
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-rich-review-'));
    file = join(directory, 'store.json');
    f = makeCompositionalCommittedClaimFixture(
      'proposed',
      embeddedAutomaticCaptureStoreHash(file)!,
    );
    fs.writeFileSync(file, JSON.stringify(f.graph));
    store = new GraphologyStorage(file);
    await store.initialize();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const command = async (reviewStatus: 'accepted' | 'proposed' | 'rejected' = 'accepted') => {
    const edge = (await store.getEdge(f.request.edgeId))!;
    const value = (await store.getEntity(edge.target_node_uuid))!;
    return {
      version: 3 as const,
      namespace: f.request.namespace,
      edgeId: edge.uuid,
      expectedPairHash: compositionalClaimReviewPairHashV3({
        namespace: f.request.namespace,
        edge,
        value,
      }),
      reviewStatus,
      reviewedBy: 'synthetic-operator',
    };
  };
  const actual = () => JSON.parse(fs.readFileSync(file, 'utf8')) as typeof f.graph;

  it('reviews both rows across accepted/rejected/proposed states and retains original provenance', async () => {
    for (const reviewStatus of ['accepted', 'rejected', 'proposed'] as const) {
      const result = await store.reviewCompositionalClaimV3(await command(reviewStatus));
      expect(result.kind).toBe('reviewed');
      const snapshot = actual();
      expect(snapshot.episodes).toEqual(f.graph.episodes);
      expect(snapshot.automatic_operations_v1).toEqual(f.graph.automatic_operations_v1);
      expect(snapshot.entities[0]).toEqual(f.graph.entities[0]);
      const read = validateCompositionalQualifiedClaimReadV3(snapshot, {
        ...f.request,
        now: new Date().toISOString(),
      });
      expect(read).toMatchObject({
        status: 'valid_data',
        creationReview: 'proposed',
        currentReview: reviewStatus,
      });
    }
    await store.close();
    store = new GraphologyStorage(file);
    await store.initialize();
    expect((await store.getEdge(f.request.edgeId))!.attributes.engram_extraction).toMatchObject({
      review_status: 'proposed',
      threshold_decision: 'manually_reviewed',
    });
  });

  it('does not write for a repeated coherent review or a stale optimistic guard', async () => {
    const first = await command();
    expect((await store.reviewCompositionalClaimV3(first)).kind).toBe('reviewed');
    const before = fs.readFileSync(file, 'utf8');
    expect((await store.reviewCompositionalClaimV3(await command())).kind).toBe('unchanged');
    expect(await store.reviewCompositionalClaimV3(first)).toEqual({
      kind: 'decision',
      reason: 'conflict',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('serializes competing operators across independent file writers', async () => {
    const other = new GraphologyStorage(file);
    await other.initialize();
    try {
      const input = await command();
      const results = await Promise.all([
        store.reviewCompositionalClaimV3(input),
        other.reviewCompositionalClaimV3({ ...input, reviewedBy: 'another-synthetic-operator' }),
      ]);
      expect(results.filter((r) => r.kind === 'reviewed')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'decision' && r.reason === 'conflict')).toHaveLength(
        1,
      );
      const snapshot = actual();
      const edge = snapshot.edges[0];
      const value = snapshot.entities.find((row) => row.uuid === edge.target_node_uuid)!;
      expect(edge.attributes.engram_extraction).toEqual(value.attributes.engram_extraction);
    } finally {
      await other.close();
    }
  });

  it('keeps both original rows when atomic snapshot replacement fails', async () => {
    const input = await command();
    const before = fs.readFileSync(file, 'utf8');
    jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('synthetic-storage-failure'));
    expect(await store.reviewCompositionalClaimV3(input)).toEqual({
      kind: 'acknowledgement_unknown',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(await store.getEdge(input.edgeId)).toEqual(f.graph.edges[0]);
  });

  it('reports acknowledgement uncertainty after commit without retrying or undoing the pair', async () => {
    const input = await command();
    const internal = store as unknown as {
      runMutation: (fn: () => unknown, options: unknown) => Promise<unknown>;
    };
    const run = internal.runMutation.bind(store);
    const spy = jest.spyOn(internal, 'runMutation').mockImplementation(async (fn, options) => {
      await run(fn, options);
      throw new Error('synthetic-ack-loss');
    });
    expect(await store.reviewCompositionalClaimV3(input)).toEqual({
      kind: 'acknowledgement_unknown',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const snapshot = actual();
    const edge = snapshot.edges[0];
    const value = snapshot.entities.find((row) => row.uuid === edge.target_node_uuid)!;
    expect(edge.attributes.engram_extraction).toEqual(value.attributes.engram_extraction);
    expect(edge.attributes.engram_extraction).toMatchObject({ review_status: 'accepted' });
    expect(snapshot.automatic_operations_v1).toEqual(f.graph.automatic_operations_v1);
  });

  it('does not recreate a missing store or silently operate in memory-only mode', async () => {
    const input = await command();
    fs.unlinkSync(file);
    expect(await store.reviewCompositionalClaimV3(input)).toEqual({
      kind: 'acknowledgement_unknown',
    });
    expect(fs.existsSync(file)).toBe(false);
    const memory = new GraphologyStorage();
    await memory.initialize();
    try {
      expect(await memory.reviewCompositionalClaimV3(input)).toEqual({
        kind: 'decision',
        reason: 'unsupported_mode',
      });
    } finally {
      await memory.close();
    }
  });

  it('rejects input accessors before storage work', async () => {
    let getters = 0;
    const input = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => ++getters,
    });
    expect(await store.reviewCompositionalClaimV3(input as never)).toEqual({
      kind: 'decision',
      reason: 'invalid_input',
    });
    expect(getters).toBe(0);
    expect(actual()).toEqual(f.graph);
  });
});
