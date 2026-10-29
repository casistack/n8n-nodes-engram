import { randomUUID } from 'crypto';
import {
  createAutomaticCaptureHandleRegistry,
  AutomaticCaptureLeaseFenceV2Schema,
  type AutomaticCaptureHandlePurpose,
} from '../../../src/storage/AutomaticCaptureHandles';
import {
  createAutomaticCaptureInternalResultSchemas,
  AutomaticCapturePublicResultV2Schema,
} from '../../../src/schemas/AutomaticCaptureApi.schema';

function initial<P extends AutomaticCaptureHandlePurpose>(purpose: P) {
  const registry = createAutomaticCaptureHandleRegistry();
  const invocation = registry.startBegin(purpose);
  const fence = AutomaticCaptureLeaseFenceV2Schema.parse({
    purpose,
    operationId: randomUUID(),
    sourceId: randomUUID(),
    descriptorHash: 'a'.repeat(64),
    identityHash: 'e'.repeat(64),
    beginCallHash: invocation.beginCallHash,
    state: 'leased',
    generation: 1,
    token: invocation.leaseToken,
    claimKind: 'initial',
    planTimestamp: '2026-10-25T12:00:00.000Z',
    retryCount: 0,
  });
  const handle = registry.recoverOrIssueInitial(invocation.scope, fence)!;
  const claimed = {
    kind: 'claimed',
    purpose,
    sourceId: fence.sourceId,
    operationId: fence.operationId,
    descriptorHash: fence.descriptorHash,
    sourcePersistence: 'persisted',
    leaseHandle: handle,
  };
  return {
    registry,
    fence,
    handle,
    claimed,
    schemas: createAutomaticCaptureInternalResultSchemas(registry),
  };
}

describe('registry-bound capture internal result validation', () => {
  it.each(['human_turn_memory', 'assistant_final_save'] as const)(
    'preserves the exact live %s handle without consuming or exposing it',
    (purpose) => {
      const { registry, schemas, handle, claimed } = initial(purpose);
      expect(registry.isLiveHandle(handle, purpose, 'initial')).toBe(true);
      expect(registry.isLiveHandle(handle, purpose, 'resume')).toBe(false);
      const parsed = schemas.AutomaticCaptureBeginInternalResultV2Schema.parse(claimed);
      if (parsed.kind !== 'claimed') throw new Error('Expected claimed handle');
      expect(parsed.leaseHandle).toBe(handle);
      expect(registry.isLiveHandle(handle, purpose)).toBe(true);
      expect(Object.keys(handle)).toEqual([]);
      expect(Object.getOwnPropertySymbols(handle)).toEqual([]);
      expect(Object.isFrozen(handle)).toBe(true);
      expect(() => registry.consumeForCompletion(handle, purpose)).not.toThrow();
    },
  );

  it('rejects forged, copied, serialized, cloned, wrong-purpose and other-registry handles', () => {
    const { registry, schemas, handle, claimed } = initial('human_turn_memory');
    const other = createAutomaticCaptureHandleRegistry();
    for (const fake of [
      null,
      undefined,
      'handle',
      {},
      Object.freeze({}),
      { ...handle },
      JSON.parse(JSON.stringify(handle)),
      structuredClone(handle),
    ]) {
      expect(registry.isLiveHandle(fake, 'human_turn_memory')).toBe(false);
      expect(
        schemas.AutomaticCaptureBeginInternalResultV2Schema.safeParse({
          ...claimed,
          leaseHandle: fake,
        }).success,
      ).toBe(false);
    }
    expect(registry.isLiveHandle(handle, 'assistant_final_save')).toBe(false);
    expect(other.isLiveHandle(handle, 'human_turn_memory')).toBe(false);
    expect(
      createAutomaticCaptureInternalResultSchemas(
        other,
      ).AutomaticCaptureBeginInternalResultV2Schema.safeParse(claimed).success,
    ).toBe(false);
    expect(
      schemas.AutomaticCaptureBeginInternalResultV2Schema.safeParse({
        ...claimed,
        purpose: 'assistant_final_save',
      }).success,
    ).toBe(false);
    expect(registry.isLiveHandle(handle, 'human_turn_memory')).toBe(true);
  });

  it('does not let schema success survive a later consume or become a backend permit', () => {
    const { registry, schemas, handle, claimed } = initial('human_turn_memory');
    const parsed = schemas.AutomaticCaptureBeginInternalResultV2Schema.parse(claimed);
    if (parsed.kind !== 'claimed' || parsed.purpose !== 'human_turn_memory')
      throw new Error('Expected human handle');
    registry.consumeForCompletion(handle, 'human_turn_memory');
    expect(registry.isLiveHandle(handle, 'human_turn_memory')).toBe(false);
    expect(schemas.AutomaticCaptureBeginInternalResultV2Schema.safeParse(claimed).success).toBe(
      false,
    );
    expect(() => registry.consumeForCompletion(parsed.leaseHandle, 'human_turn_memory')).toThrow(
      'invalid_handle',
    );
    expect(JSON.stringify(parsed)).not.toContain('token');
  });

  it('requires a genuine resume capability and retains its original object identity', () => {
    const { registry, schemas, fence, handle } = initial('human_turn_memory');
    const previous = {
      purpose: fence.purpose,
      operationId: fence.operationId,
      sourceId: fence.sourceId,
      descriptorHash: fence.descriptorHash,
      identityHash: fence.identityHash,
      beginCallHash: fence.beginCallHash,
      retryCount: 0,
      state: 'failed',
      generation: 1,
    };
    const invocation = registry.startResume('human_turn_memory', previous);
    const resumedFence = {
      ...fence,
      generation: 2,
      token: invocation.leaseToken,
      claimKind: 'resume',
    };
    const resumedHandle = registry.recoverOrIssueResume(invocation.scope, resumedFence)!;
    expect(registry.isLiveHandle(resumedHandle, 'human_turn_memory', 'resume')).toBe(true);
    const result = {
      kind: 'resumed',
      purpose: 'human_turn_memory',
      sourceId: fence.sourceId,
      operationId: fence.operationId,
      leaseHandle: resumedHandle,
    };
    const parsed = schemas.AutomaticCaptureResumeInternalResultV2Schema.parse(result);
    if (parsed.kind !== 'resumed') throw new Error('Expected resumed result');
    expect(parsed.leaseHandle).toBe(resumedHandle);
    expect(
      schemas.AutomaticCaptureResumeInternalResultV2Schema.safeParse({
        ...result,
        leaseHandle: handle,
      }).success,
    ).toBe(false);
    expect(
      schemas.AutomaticCaptureBeginInternalResultV2Schema.safeParse({
        ...result,
        kind: 'claimed',
        descriptorHash: fence.descriptorHash,
        sourcePersistence: 'persisted',
      }).success,
    ).toBe(false);
  });

  it('validates a backend-issued human retry successor without consuming it', () => {
    const { registry, schemas, fence, handle } = initial('human_turn_memory');
    const consumed = registry.readConsumedInvocation(
      registry.consumeForCompletion(handle, 'human_turn_memory'),
      'human_turn_memory',
    );
    const successor = registry.recoverOrIssueSuccessor(consumed.retryScope, {
      ...fence,
      retryCount: 1,
      lastRetryCallHash: consumed.retryIssueCallHash,
    })!;
    const result = {
      kind: 'graph_conflict_retry',
      retryHandle: successor,
      eligibleFirstCommit: false,
    };
    const parsed = schemas.AutomaticHumanCompletionInternalResultV2Schema.parse(result);
    if (parsed.kind !== 'graph_conflict_retry') throw new Error('Expected retry result');
    expect(parsed.retryHandle).toBe(successor);
    expect(registry.isLiveHandle(successor, 'human_turn_memory')).toBe(true);
    expect(
      schemas.AutomaticHumanCompletionInternalResultV2Schema.safeParse({
        ...result,
        retryHandle: handle,
      }).success,
    ).toBe(false);
    expect(
      schemas.AutomaticHumanCompletionInternalResultV2Schema.safeParse({
        ...result,
        eligibleFirstCommit: true,
      }).success,
    ).toBe(false);
  });

  it.each(['assistant_final_saved', 'committed_replay'] as const)(
    'requires a persisted caller source for the %s public success',
    (status) => {
      const result = {
        version: 2,
        purpose: status === 'assistant_final_saved' ? 'assistant_final_save' : 'human_turn_memory',
        status,
        sourceId: randomUUID(),
        sourcePersistence: 'persisted',
        should_process: false,
        currentAuthority: 'active',
        receiptSummary: null,
      };
      expect(AutomaticCapturePublicResultV2Schema.safeParse(result).success).toBe(true);
      expect(
        AutomaticCapturePublicResultV2Schema.safeParse({ ...result, sourceId: null }).success,
      ).toBe(false);
      for (const sourcePersistence of ['not_persisted', 'unknown']) {
        expect(
          AutomaticCapturePublicResultV2Schema.safeParse({ ...result, sourcePersistence }).success,
        ).toBe(false);
      }
    },
  );
});
