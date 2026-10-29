import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import type { GraphData } from '../../src/schemas';
import * as evidence from '../../src/extraction/CompositionalAutomaticCaptureV3Evidence';

describe('embedded atomic V3 capture completion', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let input: CompositionalCaptureBeginMethodRequestV3;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-v3-complete-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    const seeded = await seedAutomaticCaptureSubject(store);
    input = {
      mode: 'existingStore',
      request: CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
        ...seeded.request,
        version: 3,
        preferenceInterpreter: 'compositionalV2',
        source: {
          ...seeded.request.source,
          content: 'What games are on today?',
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
  const begin = async (content?: string) => {
    if (content) input.request.source.content = content;
    const result = await store.beginAndClaimCompositionalCaptureV3(input);
    if (result.kind !== 'claimed') throw new Error(`Expected a private handle, got ${result.kind}`);
    return result.handle;
  };

  it('commits an honest zero-fact source verdict without changing the extraction epoch', async () => {
    const handle = await begin();
    const before = actual();
    const parser = jest.spyOn(
      evidence,
      'interpretCompositionalHumanSourceV3EvidenceWithExecutionReport',
    );

    const result = await store.completeCompositionalHumanCaptureV3(handle);

    expect(result).toMatchObject({ kind: 'committed', eligibleFirstCommit: true });
    expect(parser).toHaveBeenCalledTimes(2);
    const after = actual();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.metadata?.extraction_epoch).toBe(before.metadata?.extraction_epoch);
    const operation = after.automatic_operations_v1!.operations[0];
    if (operation.version !== 3 || operation.state !== 'committed')
      throw new Error('Expected a committed V3 operation');
    expect(operation.terminalReceipt.kind).toBe('human_compositional_source_verdict_committed');
    expect(operation.terminalReceipt.acceptedCoverage).toBe('none');
    expect(operation.attempts.map((attempt) => attempt.disposition)).toEqual([
      'claim_won',
      'committed',
    ]);
  });

  it('commits complete bundle rows and advances the extraction epoch only for fact changes', async () => {
    const handle = await begin(
      'I prefer explanations in plain British English, with one practical example before technical terms.',
    );
    const before = actual();

    const result = await store.completeCompositionalHumanCaptureV3(handle);

    expect(result).toMatchObject({ kind: 'committed', eligibleFirstCommit: true });
    const after = actual();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.edges.length).toBeGreaterThan(before.edges.length);
    expect(after.metadata?.extraction_epoch).not.toBe(before.metadata?.extraction_epoch);
    const operation = after.automatic_operations_v1!.operations[0];
    if (operation.version !== 3 || operation.state !== 'committed')
      throw new Error('Expected a committed V3 operation');
    expect(operation.terminalReceipt.kind).toBe('human_compositional_capture_committed');
    expect(operation.attempts.map((attempt) => attempt.disposition)).toEqual([
      'claim_won',
      'committed',
    ]);
  });

  it('recovers the same completion after a lost acknowledgement without a second write', async () => {
    const handle = await begin();
    const internal = store as unknown as {
      runMutation: (work: () => unknown, options: unknown) => Promise<unknown>;
    };
    const run = internal.runMutation.bind(store);
    let calls = 0;
    jest.spyOn(internal, 'runMutation').mockImplementation(async (work, options) => {
      const result = await run(work, options);
      if (++calls === 1) throw new Error('synthetic-ack-loss');
      return result;
    });

    const result = await store.completeCompositionalHumanCaptureV3(handle);

    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'same_call_ack_recovered',
      eligibleFirstCommit: true,
    });
    expect(calls).toBe(2);
    const operation = actual().automatic_operations_v1!.operations[0];
    if (operation.version !== 3 || operation.state !== 'committed')
      throw new Error('Expected a committed V3 operation');
    expect(operation.attempts.map((attempt) => attempt.disposition)).toEqual([
      'claim_won',
      'committed',
    ]);
  });

  it('does not return a permit or leave facts after an atomic snapshot write failure', async () => {
    const handle = await begin(
      'I prefer explanations in plain British English, with one practical example before technical terms.',
    );
    const before = fs.readFileSync(file, 'utf8');
    jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('synthetic-write-failure'));

    const result = await store.completeCompositionalHumanCaptureV3(handle);

    expect(result).toMatchObject({ kind: 'acknowledgement_unknown', eligibleFirstCommit: false });
    const after = actual();
    expect(after.entities).toEqual((JSON.parse(before) as GraphData).entities);
    expect(after.edges).toEqual((JSON.parse(before) as GraphData).edges);
    expect(after.episodes).toEqual((JSON.parse(before) as GraphData).episodes);
    expect(after.automatic_operations_v1!.operations[0].state).toBe('leased');
  });

  it('rejects a forged handle before storage access', async () => {
    const exportSpy = jest.spyOn(store, 'exportGraph');
    const before = fs.readFileSync(file, 'utf8');

    const result = await store.completeCompositionalHumanCaptureV3({} as never);

    expect(result).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
    expect(exportSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not recreate a missing store during completion', async () => {
    const handle = await begin();
    fs.unlinkSync(file);

    const result = await store.completeCompositionalHumanCaptureV3(handle);

    expect(result).toMatchObject({ kind: 'storage_error', eligibleFirstCommit: false });
    expect(fs.existsSync(file)).toBe(false);
  });
});
