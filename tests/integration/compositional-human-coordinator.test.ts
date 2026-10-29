import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { captureCompositionalHumanMemoryV3 } from '../../src/memory/CompositionalHumanCaptureV3';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import type { GraphData } from '../../src/schemas';

describe('native V3 human capture coordinator', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let request: ReturnType<typeof CompositionalAutomaticCaptureBeginRequestV3Schema.parse>;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-v3-human-coordinator-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    await store.initialize();
    const seeded = await seedAutomaticCaptureSubject(store);
    request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...seeded.request,
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      source: { ...seeded.request.source, content: 'What games are on today?' },
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const actual = () => JSON.parse(fs.readFileSync(file, 'utf8')) as GraphData;

  it('permits the first durable zero-fact source verdict, then returns its historical receipt as replay', async () => {
    const first = await captureCompositionalHumanMemoryV3(store, request);
    expect(first).toMatchObject({
      status: 'first_capture_committed',
      should_process: true,
      currentAuthority: 'active',
      receiptSummary: {
        kind: 'committed',
        interpretationCoverage: 'none',
        acceptedCoverage: 'none',
        selection: { kind: 'source_verdict' },
        counts: {
          bundleCount: 0,
          distinctPersistedClaimCount: 0,
        },
      },
    });
    const originalId = first.sourceId;
    const replayRequest = structuredClone(request);
    replayRequest.attemptIdHash = 'a'.repeat(64);
    const replay = await captureCompositionalHumanMemoryV3(store, replayRequest);
    expect(replay).toMatchObject({
      status: 'committed_replay',
      sourceId: originalId,
      should_process: false,
      receiptSummary: first.receiptSummary,
    });
    expect(actual().episodes).toHaveLength(1);
  });

  it('permits a first ReviewFirst proposed bundle without claiming fact acceptance', async () => {
    request.settings.profileId = 'reviewFirst';
    request.source.content =
      'I prefer explanations in plain British English, with one practical example before technical terms.';

    const result = await captureCompositionalHumanMemoryV3(store, request);

    expect(result.status).toBe('first_capture_committed');
    expect(result.should_process).toBe(true);
    expect(result.receiptSummary).toMatchObject({
      kind: 'committed',
      acceptedCoverage: 'none',
      selection: { kind: 'bundles' },
    });
    if (
      result.receiptSummary?.kind !== 'committed' ||
      result.receiptSummary.selection.kind !== 'bundles'
    )
      throw new Error('Expected proposed bundle summary');
    expect(result.receiptSummary.selection.items.some((item) => item.state === 'proposed')).toBe(
      true,
    );
    expect(result.receiptSummary.counts.byState.proposed).toBeGreaterThan(0);
  });

  it('projects an accepted bundle and withholds source details on changed-content conflict', async () => {
    request.source.content =
      'I prefer explanations in plain British English, with one practical example before technical terms.';
    const first = await captureCompositionalHumanMemoryV3(store, request);
    expect(first.should_process).toBe(true);
    expect(first.receiptSummary?.kind).toBe('committed');

    const changed = structuredClone(request);
    changed.attemptIdHash = 'b'.repeat(64);
    changed.source.content += ' Please change the original event.';
    const conflict = await captureCompositionalHumanMemoryV3(store, changed);

    expect(conflict).toMatchObject({
      status: 'conflict',
      sourceId: null,
      should_process: false,
      receiptSummary: null,
    });
    expect(actual().episodes).toHaveLength(1);
  });

  it('does not repeat begin or completion after an uncertain completion acknowledgement', async () => {
    const originalComplete = store.completeCompositionalHumanCaptureV3.bind(store);
    let beginCalls = 0;
    let completeCalls = 0;
    const wrapped = store as unknown as IGraphStorage;
    const originalBegin = store.beginAndClaimCompositionalCaptureV3.bind(store);
    jest.spyOn(store, 'beginAndClaimCompositionalCaptureV3').mockImplementation(async (input) => {
      beginCalls += 1;
      return originalBegin(input);
    });
    jest.spyOn(store, 'completeCompositionalHumanCaptureV3').mockImplementation(async (handle) => {
      completeCalls += 1;
      await originalComplete(handle);
      return { kind: 'acknowledgement_unknown', eligibleFirstCommit: false } as never;
    });

    const uncertain = await captureCompositionalHumanMemoryV3(wrapped, request);

    expect(uncertain).toMatchObject({
      status: 'acknowledgement_unknown',
      sourceId: null,
      should_process: false,
      receiptSummary: null,
    });
    expect(beginCalls).toBe(1);
    expect(completeCalls).toBe(1);
    jest.restoreAllMocks();
    const later = await captureCompositionalHumanMemoryV3(store, request);
    expect(later).toMatchObject({ status: 'committed_replay', should_process: false });
  });

  it('does not trust a structural positive result or inspect accessor fields', async () => {
    const originalBegin = store.beginAndClaimCompositionalCaptureV3.bind(store);
    const originalComplete = store.completeCompositionalHumanCaptureV3.bind(store);
    let beginCalls = 0;
    let completeCalls = 0;
    let getterCalls = 0;
    jest.spyOn(store, 'beginAndClaimCompositionalCaptureV3').mockImplementation(async (input) => {
      beginCalls += 1;
      return originalBegin(input);
    });
    jest.spyOn(store, 'completeCompositionalHumanCaptureV3').mockImplementation(async (handle) => {
      completeCalls += 1;
      await originalComplete(handle);
      return Object.defineProperty({}, 'eligibleFirstCommit', {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return true;
        },
      }) as never;
    });

    const result = await captureCompositionalHumanMemoryV3(store, request);

    expect(result).toMatchObject({
      status: 'failed',
      sourceId: null,
      should_process: false,
      receiptSummary: null,
    });
    expect(getterCalls).toBe(0);
    expect(beginCalls).toBe(1);
    expect(completeCalls).toBe(1);
  });

  it('does not call completion when begin returns uncertain acknowledgement', async () => {
    let completeCalls = 0;
    const fake: IGraphStorage = {
      beginAndClaimCompositionalCaptureV3: async (
        _input: CompositionalCaptureBeginMethodRequestV3,
      ) =>
        ({
          kind: 'acknowledgement_unknown',
          eligibleFirstCommit: false,
        }) as never,
      completeCompositionalHumanCaptureV3: async () => {
        completeCalls += 1;
        return { kind: 'invalid_handle', eligibleFirstCommit: false } as never;
      },
    } as unknown as IGraphStorage;

    const result = await captureCompositionalHumanMemoryV3(fake, request);

    expect(result).toMatchObject({ status: 'acknowledgement_unknown', should_process: false });
    expect(completeCalls).toBe(0);
  });

  it('checks the method-entry deadline after a slow begin and never calls completion', async () => {
    request.settings.invocationDeadlineMs = 100;
    let beginCalls = 0;
    let completeCalls = 0;
    const fake = {
      beginAndClaimCompositionalCaptureV3: async () => {
        beginCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { kind: 'in_progress', eligibleFirstCommit: false };
      },
      completeCompositionalHumanCaptureV3: async () => {
        completeCalls += 1;
        return { kind: 'invalid_handle', eligibleFirstCommit: false };
      },
    } as unknown as IGraphStorage;

    const result = await captureCompositionalHumanMemoryV3(fake, request);

    expect(result).toMatchObject({ status: 'budget_exhausted', should_process: false });
    expect(beginCalls).toBe(1);
    expect(completeCalls).toBe(0);
  });
});
