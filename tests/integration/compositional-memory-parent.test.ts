import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { embeddedAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { loadCompositionalRuntimeReaderV3 } from '../../src/search/CompositionalRuntimeReaderV3';
import { validateCompositionalMemoryParentV3 as validate } from '../../src/memory/CompositionalMemoryParentV3';
import type { CompositionalMemoryParentExpectedV3 } from '../../src/schemas/CompositionalMemoryParentV3.schema';
import type { AutomaticBindingRecord } from '../../src/schemas/AutomaticOperations.schema';

describe('fixed current parent from an actual embedded read snapshot', () => {
  let directory: string;
  let store: GraphologyStorage;
  let expected: CompositionalMemoryParentExpectedV3;
  let binding: AutomaticBindingRecord;
  const path = () => join(directory, 'store.json');
  const seed = async (
    content = 'I prefer explanations in plain British English, with one practical example before any technical terminology.',
    profileId: 'conservative' | 'reviewFirst' = 'conservative',
    wrapper = false,
    quoteRegions: Array<{ start: number; end: number }> = [],
  ) => {
    const seeded = await seedAutomaticCaptureSubject(store);
    binding = seeded.binding;
    const prefix = 'Human: ';
    const request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
      ...seeded.request,
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      settings: { ...seeded.request.settings, profileId },
      source: {
        ...seeded.request.source,
        content: wrapper ? prefix + content : content,
        applicationOwnedWrapper: wrapper ? true : null,
        humanRegion: wrapper ? { start: prefix.length, end: prefix.length + content.length } : null,
        quoteRegions,
      },
    });
    const begin = await store.beginAndClaimCompositionalCaptureV3({
      mode: 'existingStore',
      request,
    });
    if (begin.kind !== 'claimed') throw new Error(JSON.stringify(begin));
    const result = await store.completeCompositionalHumanCaptureV3(begin.handle);
    if (!result.eligibleFirstCommit) throw new Error(JSON.stringify(result));
    const storeIdentity = embeddedAutomaticCaptureStoreHash(path());
    if (!storeIdentity) throw new Error('Expected configured store identity');
    expected = {
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      namespace: request.namespace,
      currentHumanInput: request.source.content,
      expectedHumanProcessingAttemptHash: request.attemptIdHash,
      invocationDeadlineMs: request.settings.invocationDeadlineMs,
      runtime: {
        profileId,
        actor: {
          namespace: request.namespace,
          issuer: request.issuer,
          actorReference: request.actorReference,
          quoteRegions,
          ...(wrapper
            ? { applicationOwnedWrapper: true, humanRegion: request.source.humanRegion! }
            : {}),
        },
        storeIdentity,
        turnId: request.turn,
        capturedSourceId: result.terminalReceipt.sourceId,
        explicitIntent: false,
        ...(wrapper ? { rawHumanContent: content } : {}),
      },
    };
  };
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-current-parent-v3-'));
    store = new GraphologyStorage(path());
    await store.initialize();
    await seed();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const reader = async (check?: () => void) => {
    const budget = { remaining: 512, deferred: 0 };
    const loaded = await loadCompositionalRuntimeReaderV3(
      store,
      { namespace: expected.namespace },
      { budget, ...(check ? { check } : {}) },
    );
    if (loaded.status !== 'ready') throw new Error(JSON.stringify(loaded));
    return { reader: loaded.reader, budget };
  };

  it('validates one actual parent, charges its context once, and never changes storage', async () => {
    const before = fs.readFileSync(path(), 'utf8');
    const r = await reader();
    const result = validate(r.reader, expected);
    expect(result.status).toBe('valid_parent_data');
    expect(r.budget.remaining).toBe(500);
    expect(validate(r.reader, expected)).toEqual(result);
    expect(r.budget.remaining).toBe(500);
    expect(fs.readFileSync(path(), 'utf8')).toBe(before);
  });

  it.each([
    ['What games are on today?', 'conservative'],
    ['I prefer concise explanations.', 'reviewFirst'],
  ] as const)(
    'allows a real conversation parent without accepted facts: %s',
    async (content, profileId) => {
      await seed(content, profileId);
      const r = await reader();
      const result = validate(r.reader, expected);
      expect(result.status).toBe('valid_parent_data');
      if (result.status === 'valid_parent_data')
        expect(result.terminalReceipt.acceptedCoverage).toBe('none');
    },
  );

  it.each(['store', 'actor', 'turn', 'source', 'namespace', 'content', 'execution'] as const)(
    'rejects a changed current %s without writing',
    async (field) => {
      const r = await reader();
      const changed = structuredClone(expected);
      if (field === 'store') changed.runtime.storeIdentity = 'f'.repeat(64);
      if (field === 'actor') changed.runtime.actor.actorReference = 'synthetic-other-actor';
      if (field === 'turn') changed.runtime.turnId = 'synthetic-other-event';
      if (field === 'source') changed.runtime.capturedSourceId = randomUUID();
      if (field === 'namespace')
        changed.namespace = changed.runtime.actor.namespace = 'synthetic-other-namespace';
      if (field === 'content') changed.currentHumanInput += ' ';
      if (field === 'execution') changed.expectedHumanProcessingAttemptHash = 'f'.repeat(64);
      const before = fs.readFileSync(path(), 'utf8');
      expect(validate(r.reader, changed).status).toBe('rejected');
      expect(fs.readFileSync(path(), 'utf8')).toBe(before);
    },
  );

  it.each(['profile', 'deadline', 'intent'] as const)(
    'requires the exact captured policy/settings: %s',
    async (field) => {
      const r = await reader();
      const changed = structuredClone(expected);
      if (field === 'profile') changed.runtime.profileId = 'reviewFirst';
      if (field === 'deadline') changed.invocationDeadlineMs = 1000;
      if (field === 'intent') changed.runtime.explicitIntent = true;
      expect(validate(r.reader, changed)).toEqual({ status: 'rejected', reason: 'policy_changed' });
    },
  );

  it('compares protected wrapper and exact UTF-16 body rather than stripping display text', async () => {
    await seed('🙂 I prefer British English.', 'conservative', true);
    const r = await reader();
    expect(validate(r.reader, expected).status).toBe('valid_parent_data');
    const changed = structuredClone(expected);
    changed.runtime.actor.humanRegion!.start += 1;
    expect(validate(r.reader, changed).status).toBe('rejected');
    const raw = structuredClone(expected);
    raw.runtime.rawHumanContent = 'I prefer British English.';
    expect(validate(r.reader, raw).status).toBe('rejected');
  });

  it('requires the protected quote mapping even when the text looks like a preference', async () => {
    const content = 'I prefer British English.';
    await seed(content, 'conservative', false, [{ start: 0, end: content.length }]);
    const r = await reader();
    const result = validate(r.reader, expected);
    expect(result.status).toBe('valid_parent_data');
    if (result.status === 'valid_parent_data')
      expect(result.terminalReceipt.acceptedCoverage).toBe('none');
    const changed = structuredClone(expected);
    changed.runtime.actor.quoteRegions = [];
    expect(validate(r.reader, changed)).toEqual({ status: 'rejected', reason: 'parent_mismatch' });
  });

  it('requires the currently accepted subject independently of an active binding', async () => {
    const subject = await store.getEntity(binding.subjectId);
    if (!subject) throw new Error('Expected synthetic subject');
    const metadata = subject.attributes.engram_extraction as Record<string, unknown>;
    await store.updateEntity(subject.uuid, {
      attributes: {
        ...subject.attributes,
        engram_extraction: { ...metadata, review_status: 'rejected' },
      },
    });
    const r = await reader();
    expect(validate(r.reader, expected)).toEqual({
      status: 'rejected',
      reason: 'authority_changed',
    });
  });

  it.each(['binding', 'trust', 'review'] as const)(
    'uses current authority from the same root: %s',
    async (field) => {
      if (field === 'binding')
        await store.automaticBindingCommand({
          action: 'revoke',
          namespace: expected.namespace,
          bindingId: binding.bindingId,
          expectedRevision: binding.revision,
          authorizedBy: 'synthetic-reviewer',
          reason: 'Synthetic revocation',
        });
      else
        await store.updateEpisode(
          expected.runtime.capturedSourceId!,
          field === 'trust' ? { trust_level: 'unverified' } : { review_status: 'proposed' },
        );
      const r = await reader();
      expect(validate(r.reader, expected)).toEqual({
        status: 'rejected',
        reason: 'authority_changed',
      });
    },
  );

  it('rejects foreign/copied readers before inspecting configuration accessors', async () => {
    const r = await reader();
    let reads = 0;
    const hostile = Object.defineProperty({}, 'runtime', { enumerable: true, get: () => ++reads });
    expect(validate(structuredClone(r.reader), hostile)).toEqual({
      status: 'rejected',
      reason: 'invalid_reader',
    });
    expect(validate(new Proxy({}, { get: () => ++reads }), hostile).status).toBe('rejected');
    expect(reads).toBe(0);
    expect(validate(r.reader, hostile)).toEqual({ status: 'rejected', reason: 'invalid_input' });
    expect(reads).toBe(0);
  });

  it('preserves external abort identity and hides expired readers before source inspection', async () => {
    const aborted = new Error('synthetic cancellation');
    let cancel = false;
    const r = await reader(() => {
      if (cancel) throw aborted;
    });
    cancel = true;
    expect(() => validate(r.reader, expected)).toThrow(aborted);
    const fresh = await reader();
    const clock = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 6000);
    try {
      expect(validate(fresh.reader, expected).status).toBe('rejected');
    } finally {
      clock.mockRestore();
    }
  });
});
