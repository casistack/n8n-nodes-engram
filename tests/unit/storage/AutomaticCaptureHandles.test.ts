import { randomUUID } from 'crypto';
import {
  AutomaticCaptureLeaseFenceV2Schema,
  createAutomaticCaptureHandleRegistry,
  type AutomaticCaptureBeginInvocation,
  type AutomaticCaptureHandlePurpose,
  type PrivateOneUseAutomaticLeaseHandle,
} from '../../../src/storage/AutomaticCaptureHandles';

const descriptorHash = 'a'.repeat(64);
const identityHash = 'e'.repeat(64);
const sourceId = randomUUID();
const operationId = randomUUID();
const planTimestamp = '2026-10-25T12:00:00.000Z';

function initialFence<P extends AutomaticCaptureHandlePurpose>(
  invocation: AutomaticCaptureBeginInvocation<P>,
  overrides: Record<string, unknown> = {},
) {
  return AutomaticCaptureLeaseFenceV2Schema.parse({
    purpose: invocation.purpose,
    operationId,
    sourceId,
    descriptorHash,
    identityHash,
    beginCallHash: invocation.beginCallHash,
    state: 'leased',
    generation: 1,
    token: invocation.leaseToken,
    claimKind: 'initial',
    planTimestamp,
    retryCount: 0,
    ...overrides,
  });
}

function hiddenFrozenObject(value: object): void {
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.keys(value)).toEqual([]);
  expect(Object.getOwnPropertySymbols(value)).toEqual([]);
  expect(Object.getPrototypeOf(value)).toBeNull();
}

function invalidHandle<T extends AutomaticCaptureHandlePurpose>(
  registry: ReturnType<typeof createAutomaticCaptureHandleRegistry>,
  handle: object,
  purpose: T,
): void {
  expect(() =>
    registry.consumeForCompletion(handle as PrivateOneUseAutomaticLeaseHandle<T>, purpose),
  ).toThrow('Engram automatic memory: invalid_handle');
}

describe('private automatic capture lease handles', () => {
  it('authenticates opaque consumed invocations only by same-registry object identity and purpose', () => {
    const registry = createAutomaticCaptureHandleRegistry();
    const other = createAutomaticCaptureHandleRegistry();
    const begin = registry.startBegin('human_turn_memory');
    const handle = registry.recoverOrIssueInitial(begin.scope, initialFence(begin))!;
    const capability = registry.consumeForCompletion(handle, 'human_turn_memory');
    hiddenFrozenObject(capability);
    const first = registry.readConsumedInvocation(capability, 'human_turn_memory');
    const second = registry.readConsumedInvocation(capability, 'human_turn_memory');
    expect(first).not.toBe(second);
    expect(first.boundFence).not.toBe(second.boundFence);
    expect(first).toEqual(second);
    expect(first.retryScope).toBe(second.retryScope);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.boundFence)).toBe(true);
    expect(registry.isLiveHandle(handle, 'human_turn_memory')).toBe(false);
    for (const fake of [
      null,
      undefined,
      {},
      { ...capability },
      structuredClone(capability),
      JSON.parse(JSON.stringify(capability)),
      first,
      first.boundFence,
      handle,
    ]) {
      expect(() => registry.readConsumedInvocation(fake, 'human_turn_memory')).toThrow(
        'invalid_handle',
      );
    }
    expect(() => other.readConsumedInvocation(capability, 'human_turn_memory')).toThrow(
      'invalid_handle',
    );
    expect(() => registry.readConsumedInvocation(capability, 'assistant_final_save')).toThrow(
      'invalid_handle',
    );
    expect(
      registry.readConsumedInvocation(capability, 'human_turn_memory').completionCallHash,
    ).toBe(first.completionCallHash);
  });

  it('requires and freezes the initial persisted plan timestamp across callback recovery', () => {
    const registry = createAutomaticCaptureHandleRegistry();
    const begin = registry.startBegin('human_turn_memory');
    const fence = initialFence(begin);
    const missing = { ...fence } as Record<string, unknown>;
    delete missing.planTimestamp;
    expect(AutomaticCaptureLeaseFenceV2Schema.safeParse(missing).success).toBe(false);
    expect(registry.recoverOrIssueInitial(begin.scope, missing)).toBeNull();
    const handle = registry.recoverOrIssueInitial(begin.scope, fence)!;
    expect(
      registry.recoverOrIssueInitial(begin.scope, {
        ...fence,
        planTimestamp: '2026-10-25T12:00:01.000Z',
      }),
    ).toBeNull();
    expect(registry.recoverOrIssueInitial(begin.scope, fence)).toBe(handle);
    const capability = registry.consumeForCompletion(handle, 'human_turn_memory');
    fence.planTimestamp = '2026-10-25T12:00:02.000Z';
    expect(
      registry.readConsumedInvocation(capability, 'human_turn_memory').boundFence.planTimestamp,
    ).toBe(planTimestamp);
  });

  it('allows a renewed timestamp only on a new retry capability and rejects stale callback data', () => {
    const registry = createAutomaticCaptureHandleRegistry();
    const begin = registry.startBegin('human_turn_memory');
    const handle = registry.recoverOrIssueInitial(begin.scope, initialFence(begin))!;
    const original = registry.consumeForCompletion(handle, 'human_turn_memory');
    const use = registry.readConsumedInvocation(original, 'human_turn_memory');
    const renewed = {
      ...use.boundFence,
      retryCount: 1,
      lastRetryCallHash: use.retryIssueCallHash,
      planTimestamp: '2026-10-25T12:00:01.000Z',
    };
    const successor = registry.recoverOrIssueSuccessor(use.retryScope, renewed)!;
    expect(successor).not.toBeNull();
    expect(registry.recoverOrIssueSuccessor(use.retryScope, renewed)).toBe(successor);
    expect(
      registry.recoverOrIssueSuccessor(use.retryScope, { ...renewed, planTimestamp }),
    ).toBeNull();
    const next = registry.consumeForCompletion(successor, 'human_turn_memory');
    expect(
      registry.readConsumedInvocation(next, 'human_turn_memory').boundFence.planTimestamp,
    ).toBe(renewed.planTimestamp);
    expect(
      registry.readConsumedInvocation(original, 'human_turn_memory').boundFence.planTimestamp,
    ).toBe(planTimestamp);
  });

  it('recovers the same initial handle only for the same begin callback scope', () => {
    const registry = createAutomaticCaptureHandleRegistry();
    const invocation = registry.startBegin('human_turn_memory');
    const fence = initialFence(invocation);

    const first = registry.recoverOrIssueInitial(invocation.scope, fence);
    const callbackReplay = registry.recoverOrIssueInitial(invocation.scope, fence);
    expect(first).not.toBeNull();
    expect(callbackReplay).toBe(first);
    hiddenFrozenObject(first!);
    hiddenFrozenObject(invocation.scope);

    const differentSource = { ...fence, sourceId: randomUUID() };
    expect(registry.recoverOrIssueInitial(invocation.scope, differentSource)).toBeNull();

    // A new method invocation gets new nonce and token; same source/turn context
    // cannot recover the old call's lease capability.
    const secondInvocation = registry.startBegin('human_turn_memory');
    expect(secondInvocation.beginCallHash).not.toBe(invocation.beginCallHash);
    expect(secondInvocation.leaseToken).not.toBe(invocation.leaseToken);
    expect(registry.recoverOrIssueInitial(secondInvocation.scope, fence)).toBeNull();
  });

  it('rejects wrong purpose, copied, cloned, cross-registry, and reused handles synchronously', () => {
    const owner = createAutomaticCaptureHandleRegistry();
    const other = createAutomaticCaptureHandleRegistry();
    const invocation = owner.startBegin('human_turn_memory');
    const handle = owner.recoverOrIssueInitial(invocation.scope, initialFence(invocation));
    expect(handle).not.toBeNull();

    invalidHandle(other, handle!, 'human_turn_memory');
    invalidHandle(owner, handle!, 'assistant_final_save');
    invalidHandle(owner, { ...handle! }, 'human_turn_memory');
    invalidHandle(owner, structuredClone(handle!), 'human_turn_memory');

    const capability = owner.consumeForCompletion(handle!, 'human_turn_memory');
    hiddenFrozenObject(capability);
    const use = owner.readConsumedInvocation(capability, 'human_turn_memory');
    expect(use.purpose).toBe('human_turn_memory');
    expect(use.completionCallHash).toMatch(/^[a-f0-9]{64}$/);
    expect(use.retryIssueCallHash).toMatch(/^[a-f0-9]{64}$/);
    expect(use.completionCallHash).not.toBe(use.retryIssueCallHash);
    expect(use.boundFence).toEqual(initialFence(invocation));
    expect(use.retryScope).toBeDefined();
    expect(use).not.toBeInstanceOf(Promise);
    invalidHandle(owner, handle!, 'human_turn_memory');
    invalidHandle(owner, { ...use.retryScope }, 'human_turn_memory');
  });

  it('does not recover an initial capability across purpose or altered lease identity', () => {
    const registry = createAutomaticCaptureHandleRegistry();
    const human = registry.startBegin('human_turn_memory');
    const humanFence = initialFence(human);
    const assistant = registry.startBegin('assistant_final_save');

    expect(
      registry.recoverOrIssueInitial(human.scope, {
        ...humanFence,
        purpose: 'assistant_final_save',
      }),
    ).toBeNull();
    expect(assistant.purpose).toBe('assistant_final_save');
    expect(
      registry.recoverOrIssueInitial(assistant.scope, {
        ...humanFence,
        purpose: 'human_turn_memory',
        beginCallHash: assistant.beginCallHash,
        token: assistant.leaseToken,
      }),
    ).toBeNull();
  });

  it('issues one successor per callback scope with monotonic counts through three conflicts', () => {
    const registry = createAutomaticCaptureHandleRegistry();
    const begin = registry.startBegin('human_turn_memory');
    let handle = registry.recoverOrIssueInitial(begin.scope, initialFence(begin));
    expect(handle).not.toBeNull();

    for (let nextCount = 1; nextCount <= 3; nextCount += 1) {
      const use = registry.readConsumedInvocation(
        registry.consumeForCompletion(handle!, 'human_turn_memory'),
        'human_turn_memory',
      );
      expect(use.purpose).toBe('human_turn_memory');
      const nextFence = {
        ...use.boundFence,
        retryCount: nextCount,
        lastRetryCallHash: use.retryIssueCallHash,
      };
      const successor = registry.recoverOrIssueSuccessor(use.retryScope, nextFence);
      expect(successor).not.toBeNull();
      expect(registry.recoverOrIssueSuccessor(use.retryScope, nextFence)).toBe(successor);
      hiddenFrozenObject(successor!);

      if (nextCount < 3) {
        handle = successor;
        continue;
      }

      const finalUse = registry.readConsumedInvocation(
        registry.consumeForCompletion(successor!, 'human_turn_memory'),
        'human_turn_memory',
      );
      expect(finalUse.boundFence.retryCount).toBe(3);
      const fourthConflict = {
        ...finalUse.boundFence,
        retryCount: 4,
        lastRetryCallHash: finalUse.retryIssueCallHash,
      };
      expect(registry.recoverOrIssueSuccessor(finalUse.retryScope, fourthConflict)).toBeNull();
      expect(
        registry.recoverOrIssueSuccessor(use.retryScope, { ...nextFence, token: randomUUID() }),
      ).toBeNull();
    }
  });

  it('resumes with a fresh token while preserving the original begin hash and retry history', () => {
    const registry = createAutomaticCaptureHandleRegistry();
    const originalBeginHash = 'b'.repeat(64);
    const retryHash = 'c'.repeat(64);
    const previous = {
      purpose: 'human_turn_memory',
      operationId,
      sourceId,
      descriptorHash,
      identityHash,
      beginCallHash: originalBeginHash,
      state: 'failed',
      generation: 2,
      retryCount: 2,
      lastRetryCallHash: retryHash,
    };
    const resume = registry.startResume('human_turn_memory', previous);
    const resumedFence = AutomaticCaptureLeaseFenceV2Schema.parse({
      ...previous,
      state: 'leased',
      generation: 3,
      token: resume.leaseToken,
      claimKind: 'resume',
      planTimestamp: '2026-10-25T12:00:02.000Z',
    });

    const first = registry.recoverOrIssueResume(resume.scope, resumedFence);
    expect(first).not.toBeNull();
    expect(registry.recoverOrIssueResume(resume.scope, resumedFence)).toBe(first);
    expect(
      registry.recoverOrIssueResume(resume.scope, { ...resumedFence, planTimestamp }),
    ).toBeNull();
    const use = registry.readConsumedInvocation(
      registry.consumeForCompletion(first!, 'human_turn_memory'),
      'human_turn_memory',
    );
    expect(use.boundFence.beginCallHash).toBe(originalBeginHash);
    expect(use.boundFence.planTimestamp).toBe(resumedFence.planTimestamp);
    expect(use.boundFence.retryCount).toBe(2);
    expect(use.boundFence.lastRetryCallHash).toBe(retryHash);

    const resetCounter = { ...resumedFence, retryCount: 0, lastRetryCallHash: undefined };
    expect(registry.recoverOrIssueResume(resume.scope, resetCounter)).toBeNull();

    const anotherResume = registry.startResume('human_turn_memory', previous);
    expect(anotherResume.leaseToken).not.toBe(resume.leaseToken);
    expect(registry.recoverOrIssueResume(anotherResume.scope, resumedFence)).toBeNull();
  });

  it('gives assistant completion no graph-conflict retry scope', () => {
    const registry = createAutomaticCaptureHandleRegistry();
    const invocation = registry.startBegin('assistant_final_save');
    const fence = AutomaticCaptureLeaseFenceV2Schema.parse({
      purpose: 'assistant_final_save',
      operationId,
      sourceId,
      descriptorHash,
      identityHash,
      beginCallHash: invocation.beginCallHash,
      state: 'leased',
      generation: 1,
      token: invocation.leaseToken,
      claimKind: 'initial',
      planTimestamp,
      retryCount: 0,
    });
    const handle = registry.recoverOrIssueInitial(invocation.scope, fence);
    expect(handle).not.toBeNull();
    const use = registry.readConsumedInvocation(
      registry.consumeForCompletion(handle!, 'assistant_final_save'),
      'assistant_final_save',
    );
    expect(use.purpose).toBe('assistant_final_save');
    expect(use.retryIssueCallHash).toBeNull();
    expect('retryScope' in use).toBe(false);
  });
});
