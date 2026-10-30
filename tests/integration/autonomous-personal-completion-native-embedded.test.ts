import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { ExtractionMetadataV2Schema } from '../../src/schemas/ExtractionMetadata.schema';
import {
  consumeAutonomousPersonalCompletionBackendOutcomeV4,
  hasAutonomousPersonalCompletionBackendVerifierV4,
} from '../../src/storage/AutonomousPersonalCompletionBackendRegistryV4';
import {
  closeAutonomousPersonalCompletionV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import * as nativeOriginProjector from '../../src/storage/AutonomousPersonalNativeOriginV4';
import { AutonomousPersonalNativeOriginV4Error } from '../../src/storage/AutonomousPersonalNativeOriginV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

type ProviderBody = {
  messages: Array<{ role: string; content: string }>;
};

type ReceiptBranch =
  | 'human_autonomous_capture_committed'
  | 'human_autonomous_source_deferred_committed'
  | 'human_autonomous_source_verdict_committed';

describe('Graphology native completion proof V4', () => {
  let directory: string;
  let file: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;
  let handles: unknown[];

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-completion-embedded-'));
    file = join(directory, 'store.json');
    store = new GraphologyStorage(file);
    handles = [];
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    for (const handle of handles) closeAutonomousPersonalCompletionV4(store, handle);
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function contextFor(
    turn: string,
    intent: 'enabled' | 'disabled' = 'enabled',
    content = 'I prefer concise explanations.',
  ) {
    return nativeAutonomousPersonalCaptureContext(seed, {
      executionId: `execution:${turn}`,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content,
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: intent,
        automaticTurn: turn,
      },
    });
  }

  function installProvider(mode: 'success' | 'unavailable' | 'unexpected') {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (mode === 'unexpected') throw new Error('unexpected_native_provider_dispatch');
      if (mode === 'unavailable') return new Response('synthetic unavailable', { status: 503 });

      const body = JSON.parse(String(init?.body)) as ProviderBody;
      const user = JSON.parse(body.messages[1]!.content) as {
        units: Array<{ unitId: string }>;
      };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: user.units.map(({ unitId }) => ({
                    unitId,
                    category: 'preference',
                    risk: 'ordinary',
                    usefulness: 'personal_memory',
                    downgrade: [],
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  }

  async function prepare(
    turn: string,
    intent: 'enabled' | 'disabled' = 'enabled',
    providerMode: 'success' | 'unavailable' | 'unexpected' = 'success',
  ): Promise<unknown> {
    const fetchSpy = installProvider(providerMode);
    const prepared = await prepareNativeAutonomousPersonalCompletionV4(
      contextFor(turn, intent),
      store,
    );
    if (prepared.kind !== 'completion_prepared') {
      throw new Error(`Expected native completion handle, received ${prepared.kind}`);
    }
    handles.push(prepared.handle);
    if (providerMode === 'unexpected') expect(fetchSpy).not.toHaveBeenCalled();
    else if (providerMode === 'success') expect(fetchSpy).toHaveBeenCalledTimes(1);
    else expect(fetchSpy).toHaveBeenCalled();
    return prepared.handle;
  }

  async function nativeOutcome(handle: unknown) {
    expect(hasAutonomousPersonalCompletionBackendVerifierV4(store)).toBe(true);
    const token = await store.completeAutonomousPersonalCaptureForNativeV4!(handle);
    return {
      token,
      consume: (owner: object, key: unknown, outcome: unknown = token) =>
        consumeAutonomousPersonalCompletionBackendOutcomeV4(owner, key, outcome),
    };
  }

  it.each([
    ['occurrence', 'enabled', 'success', 'human_autonomous_capture_committed'],
    ['provider-deferred', 'enabled', 'unavailable', 'human_autonomous_source_deferred_committed'],
    ['source-verdict', 'disabled', 'unexpected', 'human_autonomous_source_verdict_committed'],
  ] as const)(
    'produces one exact proof outcome for the %s receipt branch',
    async (name, intent, providerMode, receiptKind) => {
      const turn = `native-proof-${name}`;
      const handle = await prepare(turn, intent, providerMode);
      const projectSpy = jest.spyOn(
        nativeOriginProjector,
        'projectAutonomousPersonalNativeOriginV4',
      );
      const { token, consume } = await nativeOutcome(handle);

      expect(Object.isFrozen(token)).toBe(true);
      expect(Reflect.ownKeys(token)).toEqual([]);
      expect(JSON.stringify(token)).toBe('{}');
      expect(token).not.toHaveProperty('proof');
      expect(token).not.toHaveProperty('nativeOrigin');

      const other = new GraphologyStorage();
      await other.initialize();
      try {
        expect(consume(other, handle)).toBeNull();
      } finally {
        await other.close();
      }
      expect(consume(store, {}, token)).toBeNull();
      expect(consume(store, handle, { ...(token as object) })).toBeNull();
      expect(consume(store, handle, new Proxy(token as object, {}))).toBeNull();
      expect(consume(store, handle, JSON.parse(JSON.stringify(token)) as object)).toBeNull();

      const result = consume(store, handle, token);
      expect(result?.observation).toEqual({ kind: 'matched' });
      expect(result?.observation).not.toHaveProperty('proof');
      expect(result?.observation).not.toHaveProperty('nativeOrigin');
      expect(result?.proof).not.toBeNull();
      expect(consume(store, handle, token)).toBeNull();
      expect(projectSpy).toHaveBeenCalledTimes(1);
      const projected = projectSpy.mock.results[0];
      const projectedInput = projectSpy.mock.calls[0]?.[0];
      const projectedPlan = projectSpy.mock.calls[0]?.[1];
      expect(projected?.type).toBe('return');
      const origin = result!.proof!.nativeOrigin;
      expect(origin).toBe(projected!.value);
      expect(origin.completionCallHash).toBe(projectedInput?.completionCallHash);
      expect(origin.identity).toEqual(projectedPlan?.operation.identity);
      expect(origin.instance).toBe(`instance:${turn}`);
      expect(origin.workflow).toBe(`workflow:${turn}`);
      expect(origin.execution).toBe(`execution:${turn}`);
      expect(origin.identity.turn).toBe(turn);
      expect(origin.completionCallHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(origin.terminalReceipt.kind).toBe(receiptKind satisfies ReceiptBranch);

      const graph = await store.exportGraph();
      const claim = graph.edges.find((edge) => {
        const claim = edge.attributes.engram_claim_v1;
        return (
          claim !== null &&
          typeof claim === 'object' &&
          (claim as { version?: unknown }).version === 3
        );
      });
      if (receiptKind === 'human_autonomous_capture_committed') {
        const value = graph.entities.find(
          (entity) => entity.attributes.engram_literal_v1 !== undefined,
        );
        if (!claim || !value) throw new Error('Expected the committed family4 claim/value pair');
        expect(ExtractionMetadataV2Schema.parse(claim.attributes.engram_extraction)).toMatchObject({
          review_status: 'accepted',
          threshold_decision: 'auto_accepted',
        });
        expect(ExtractionMetadataV2Schema.parse(value.attributes.engram_extraction)).toMatchObject({
          review_status: 'accepted',
          threshold_decision: 'auto_accepted',
        });
      } else {
        expect(claim).toBeUndefined();
      }
    },
  );

  it.each(['rename-after-replacement', 'chmod-after-replacement', 'directory-sync'] as const)(
    'does not attach proof when %s leaves a candidate visible without a resolved writer acknowledgement',
    async (fault) => {
      const handle = await prepare(`native-proof-unknown-ack-${fault}`);
      const before = fs.readFileSync(file);
      const originalRename = fs.promises.rename.bind(fs.promises);
      const rename = jest
        .spyOn(fs.promises, 'rename')
        .mockImplementation(async (source, target) => {
          await originalRename(source, target);
          if (String(target) === file && fault === 'rename-after-replacement') {
            throw new Error('synthetic_post_rename_rejection');
          }
        });
      const originalChmod = fs.promises.chmod.bind(fs.promises);
      if (fault === 'chmod-after-replacement') {
        jest.spyOn(fs.promises, 'chmod').mockImplementation(async (target, mode) => {
          if (String(target) === file) throw new Error('synthetic_post_replace_chmod_failure');
          return originalChmod(target, mode);
        });
      }
      if (fault === 'directory-sync') {
        const originalOpen = fs.promises.open.bind(fs.promises);
        jest.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
          const fileHandle = await originalOpen(target, flags, mode);
          if (String(target) !== directory || flags !== 'r') return fileHandle;
          return new Proxy(fileHandle, {
            get(targetHandle, property, receiver) {
              if (property === 'sync') {
                return async () => {
                  throw new Error('synthetic_directory_fsync_failure');
                };
              }
              const value = Reflect.get(targetHandle, property, receiver) as unknown;
              return typeof value === 'function' ? value.bind(targetHandle) : value;
            },
          });
        });
      }

      const { token, consume } = await nativeOutcome(handle);
      const result = consume(store, handle, token);

      expect(result?.observation).toEqual({ kind: 'matched' });
      expect(result?.proof).toBeNull();
      expect(rename.mock.calls.filter(([, target]) => String(target) === file)).toHaveLength(1);
      expect(fs.readFileSync(file)).not.toEqual(before);
      expect(
        JSON.parse(fs.readFileSync(file, 'utf8')).automatic_operations_v1.operations,
      ).toContainEqual(expect.objectContaining({ version: 4, state: 'committed' }));
    },
  );

  it('keeps a mismatched single readback as observation DATA without proof', async () => {
    const handle = await prepare('native-proof-mismatched-readback');
    const before = fs.readFileSync(file);
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      await originalRename(source, target);
      if (String(target) === file) await fs.promises.writeFile(file, before);
    });
    const originalOpen = fs.promises.open.bind(fs.promises);
    const open = jest.spyOn(fs.promises, 'open').mockImplementation(originalOpen);

    const { token, consume } = await nativeOutcome(handle);
    const result = consume(store, handle, token);

    expect(result?.observation).toEqual({ kind: 'unconfirmed' });
    expect(result?.proof).toBeNull();
    expect(rename.mock.calls.filter(([, target]) => String(target) === file)).toHaveLength(1);
    expect(open.mock.calls.filter(([target]) => String(target) === file)).toHaveLength(2);
  });

  it('does not attach proof when the original completion work expires after replacement', async () => {
    const handle = await prepare('native-proof-expired-after-replacement');
    const originalNow = performance.now.bind(performance);
    let replacementVisible = false;
    jest
      .spyOn(performance, 'now')
      .mockImplementation(() => originalNow() + (replacementVisible ? 6_000 : 0));
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      await originalRename(source, target);
      if (String(target) === file) replacementVisible = true;
    });

    const { token, consume } = await nativeOutcome(handle);
    const result = consume(store, handle, token);

    expect(result?.observation).toEqual({ kind: 'unconfirmed' });
    expect(result?.proof).toBeNull();
    expect(rename.mock.calls.filter(([, target]) => String(target) === file)).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(file, 'utf8')).automatic_operations_v1.operations,
    ).toContainEqual(expect.objectContaining({ version: 4, state: 'committed' }));
    // Expiry cannot mint proof, but an acknowledged durable write does not
    // make the persisted graph corrupt or require operator recovery.
    replacementVisible = false;
    expect((await store.exportGraph()).automatic_operations_v1?.operations).toContainEqual(
      expect.objectContaining({ version: 4, state: 'committed' }),
    );
  });

  it.each(['unknown-ack-timeout', 'known-ack-read-io'] as const)(
    'retains recovery protection for %s',
    async (fault) => {
      const handle = await prepare(`native-proof-recovery-${fault}`);
      const originalNow = performance.now.bind(performance);
      let offsetMs = 0;
      const clock = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => originalNow() + offsetMs);
      const originalRename = fs.promises.rename.bind(fs.promises);
      jest.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
        await originalRename(source, target);
        if (String(target) === file && fault === 'unknown-ack-timeout') {
          offsetMs = 6_000;
          throw new Error('synthetic_unknown_replacement_ack');
        }
      });
      let acknowledged = false;
      let injectedReadFailure = false;
      const originalOpen = fs.promises.open.bind(fs.promises);
      jest.spyOn(fs.promises, 'open').mockImplementation(async (target, flags, mode) => {
        if (acknowledged && String(target) === file && fault === 'known-ack-read-io') {
          injectedReadFailure = true;
          throw new Error('synthetic_known_ack_read_io_failure');
        }
        return originalOpen(target, flags, mode);
      });
      const { token, consume } = await store.withExtractionDiagnostics(
        (event) => {
          if (
            event.acknowledged &&
            store.getLastMutationDiagnostics()?.operation === 'autonomous_personal_completion_v4'
          ) {
            acknowledged = true;
          }
        },
        () => nativeOutcome(handle),
      );
      const result = consume(store, handle, token);
      expect(result?.observation).toEqual({ kind: 'unconfirmed' });
      expect(result?.proof).toBeNull();
      expect(acknowledged).toBe(fault === 'known-ack-read-io');
      expect(injectedReadFailure).toBe(fault === 'known-ack-read-io');
      expect(
        JSON.parse(fs.readFileSync(file, 'utf8')).automatic_operations_v1.operations,
      ).toContainEqual(expect.objectContaining({ version: 4, state: 'committed' }));
      clock.mockRestore();
      await expect(store.exportGraph()).rejects.toThrow('recovery_required');
    },
  );

  it.each(['invalid_input', 'conflict', 'capacity'] as const)(
    'preserves the native-origin %s reason before any graph replacement',
    async (reason) => {
      const handle = await prepare(`native-proof-origin-${reason}`);
      const before = fs.readFileSync(file);
      const rename = jest.spyOn(fs.promises, 'rename');
      jest
        .spyOn(nativeOriginProjector, 'projectAutonomousPersonalNativeOriginV4')
        .mockImplementation(() => {
          throw new AutonomousPersonalNativeOriginV4Error(reason);
        });

      const { token, consume } = await nativeOutcome(handle);
      const result = consume(store, handle, token);

      expect(result?.observation).toEqual({ kind: 'no_write', reason });
      expect(result?.proof).toBeNull();
      expect(rename).not.toHaveBeenCalled();
      expect(fs.readFileSync(file)).toEqual(before);
    },
  );

  it('keeps the DATA-only storage result unchanged and without proof fields', async () => {
    const handle = await prepare('native-proof-data-only-compat', 'disabled', 'unexpected');
    const result = await store.completeAutonomousPersonalCaptureV4!(handle);

    expect(result).toEqual({ kind: 'matched' });
    expect(result).not.toHaveProperty('proof');
    expect(result).not.toHaveProperty('nativeOrigin');
    expect(result).not.toHaveProperty('eligibleFirstCommit');
  });
});
