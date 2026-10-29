import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import type { GraphData } from '../../src/schemas';
import { EntityEdgeSchema } from '../../src/schemas/EntityEdge.schema';

describe('embedded V3 atomic initial capture admission', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let input: CompositionalCaptureBeginMethodRequestV3;
  let binding: Awaited<ReturnType<typeof seedAutomaticCaptureSubject>>['binding'];
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-v3-begin-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    const seeded = await seedAutomaticCaptureSubject(store);
    binding = seeded.binding;
    input = {
      mode: 'existingStore',
      request: CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
        ...seeded.request,
        version: 3,
        preferenceInterpreter: 'compositionalV2',
        source: {
          ...seeded.request.source,
          content:
            'I prefer explanations in plain British English, with one practical example before any technical terminology.',
        },
      }),
    };
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const actual = () => JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;

  it('durably appends one original human source and initial lease before returning a private handle', async () => {
    const before = actual();
    const result = await store.beginAndClaimCompositionalCaptureV3(input);
    expect(result.kind).toBe('claimed');
    expect(result.eligibleFirstCommit).toBe(false);
    const graph = actual();
    expect(graph.entities).toEqual(before.entities);
    expect(graph.edges).toEqual(before.edges);
    expect(graph.episodes).toHaveLength(1);
    expect(graph.episodes[0]).toMatchObject({
      content: input.request.source.content,
      source_execution_id: null,
      episode_kind: 'active_human',
      role: 'human',
    });
    expect(graph.episodes[0].attributes.engram_write_owner_v1).toBeUndefined();
    expect(graph.episodes[0].attributes.engram_write_owner_v2).toBeUndefined();
    expect(graph.automatic_operations_v1!.operations).toHaveLength(1);
    expect(graph.automatic_operations_v1!.operations[0]).toMatchObject({
      version: 3,
      state: 'leased',
      generation: 1,
      lease: { claimKind: 'initial' },
    });
    if (result.kind !== 'claimed') throw new Error('Expected private lease');
    expect(Object.keys(result.handle)).toEqual([]);
    expect(JSON.parse(JSON.stringify(result.handle))).toEqual({});
    expect(result).not.toHaveProperty('should_process');
  });

  it('reuses the original event across another delivery attempt without changing source provenance', async () => {
    expect((await store.beginAndClaimCompositionalCaptureV3(input)).kind).toBe('claimed');
    const before = actual();
    const replay = structuredClone(input);
    replay.request.attemptIdHash = 'c'.repeat(64);
    expect(await store.beginAndClaimCompositionalCaptureV3(replay)).toEqual({
      kind: 'in_progress',
      eligibleFirstCommit: false,
    });
    const after = actual();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.automatic_operations_v1!.operations).toHaveLength(1);
    expect(after.automatic_operations_v1!.operations[0].attempts).toHaveLength(2);
  });

  it.each(['content', 'policy', 'producer', 'namespace'] as const)(
    'rejects changed event %s without rewriting existing source or graph',
    async (kind) => {
      await store.beginAndClaimCompositionalCaptureV3(input);
      const before = fs.readFileSync(file, 'utf8');
      const replay = structuredClone(input);
      replay.request.attemptIdHash = 'd'.repeat(64);
      if (kind === 'content') replay.request.source.content += ' Extra.';
      else if (kind === 'policy') replay.request.settings.profileId = 'reviewFirst';
      else if (kind === 'producer')
        replay.request.source.originalSourceExecutionId = 'changed-original';
      else replay.request.namespace += ' ';
      expect((await store.beginAndClaimCompositionalCaptureV3(replay)).kind).not.toBe('claimed');
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    },
  );

  it('serializes independent first arrivals without duplicating episodes or lease ownership', async () => {
    const other = new GraphologyStorage(file);
    await other.initialize();
    try {
      const second = structuredClone(input);
      second.request.attemptIdHash = 'e'.repeat(64);
      const results = await Promise.all([
        store.beginAndClaimCompositionalCaptureV3(input),
        other.beginAndClaimCompositionalCaptureV3(second),
      ]);
      expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'in_progress')).toHaveLength(1);
      expect(actual().episodes).toHaveLength(1);
      expect(actual().automatic_operations_v1!.operations).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it('recovers only the same invocation after an acknowledged write result is lost', async () => {
    const internal = store as unknown as {
      runMutation: (fn: () => unknown, options: unknown) => Promise<unknown>;
    };
    const run = internal.runMutation.bind(store);
    let calls = 0;
    jest.spyOn(internal, 'runMutation').mockImplementation(async (fn, options) => {
      const result = await run(fn, options);
      if (++calls === 1) throw new Error('synthetic-ack-loss');
      return result;
    });
    expect((await store.beginAndClaimCompositionalCaptureV3(input)).kind).toBe('claimed');
    expect(calls).toBe(2);
    expect(actual().episodes).toHaveLength(1);
    expect(actual().automatic_operations_v1!.operations).toHaveLength(1);
  });

  it('does not retry a failed source+operation snapshot or leave a source-only record', async () => {
    const before = fs.readFileSync(file, 'utf8');
    const rename = jest
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(new Error('synthetic-failure'));
    expect(await store.beginAndClaimCompositionalCaptureV3(input)).toEqual({
      kind: 'acknowledgement_unknown',
      eligibleFirstCommit: false,
    });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not recreate a missing existing store', async () => {
    fs.unlinkSync(file);
    expect((await store.beginAndClaimCompositionalCaptureV3(input)).kind).toBe(
      'acknowledgement_unknown',
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each(['before_mutation', 'after_commit'] as const)(
    'cannot return a handle after deadline expires %s',
    async (when) => {
      input.request.settings.invocationDeadlineMs = 500;
      const before = fs.readFileSync(file, 'utf8');
      const internal = store as unknown as {
        runMutation: (fn: () => unknown, options: unknown) => Promise<unknown>;
      };
      const run = internal.runMutation.bind(store);
      let calls = 0;
      jest.spyOn(internal, 'runMutation').mockImplementation(async (fn, options) => {
        calls++;
        if (when === 'before_mutation') await new Promise((resolve) => setTimeout(resolve, 650));
        const result = await run(fn, options);
        if (when === 'after_commit') await new Promise((resolve) => setTimeout(resolve, 650));
        return result;
      });
      expect(await store.beginAndClaimCompositionalCaptureV3(input)).toEqual({
        kind: 'budget_exhausted',
        eligibleFirstCommit: false,
      });
      expect(calls).toBe(1);
      if (when === 'before_mutation') expect(fs.readFileSync(file, 'utf8')).toBe(before);
      else {
        expect(actual().episodes).toHaveLength(1);
        expect(actual().automatic_operations_v1!.operations[0].state).toBe('leased');
      }
    },
  );

  it('rejects unsafe caller input before reading or writing storage', async () => {
    let getters = 0;
    const hostile = Object.defineProperty({}, 'request', {
      enumerable: true,
      get: () => ++getters,
    });
    const spy = jest.spyOn(store, 'exportGraph');
    expect(await store.beginAndClaimCompositionalCaptureV3(hostile as never)).toEqual({
      kind: 'invalid_input',
      eligibleFirstCommit: false,
    });
    expect(getters).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('retains old-family ownership without converting the same event to V3', async () => {
    const { preferenceInterpreter: _interpreter, ...legacy } = input.request;
    expect((await store.beginAndClaimAutomaticCaptureV2({ ...legacy, version: 2 })).kind).toBe(
      'claimed',
    );
    const before = fs.readFileSync(file, 'utf8');
    expect((await store.beginAndClaimCompositionalCaptureV3(input)).kind).toBe('unsupported_mode');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not record another attempt after current authority is revoked', async () => {
    await store.beginAndClaimCompositionalCaptureV3(input);
    await store.automaticBindingCommand({
      action: 'revoke',
      namespace: input.request.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic revocation',
    });
    const before = fs.readFileSync(file, 'utf8');
    const replay = structuredClone(input);
    replay.request.attemptIdHash = 'f'.repeat(64);
    expect(await store.beginAndClaimCompositionalCaptureV3(replay)).toEqual({
      kind: 'authority_changed',
      eligibleFirstCommit: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('rejects an unrelated cross-category UUID collision without appending or rewriting the store', async () => {
    const graph = actual();
    const subject = graph.entities[0];
    graph.edges.push(
      EntityEdgeSchema.parse({
        uuid: subject.uuid,
        group_id: subject.group_id,
        source_node_uuid: subject.uuid,
        target_node_uuid: subject.uuid,
        name: 'SYNTHETIC',
        fact: 'Unrelated synthetic record',
        created_at: subject.created_at,
        updated_at: subject.updated_at,
      }),
    );
    const before = JSON.stringify(graph);
    fs.writeFileSync(file, before);
    expect(await store.beginAndClaimCompositionalCaptureV3(input)).toEqual({
      kind: 'invalid_input',
      eligibleFirstCommit: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
