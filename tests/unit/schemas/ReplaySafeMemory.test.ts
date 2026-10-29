import {
  ReplaySafeMemoryWriteDiagnosticsSchema,
  ReplaySafeAuditDiagnosticsSchema,
  ReplaySafeFinalAssistantDiagnosticsSchema,
  MemoryCaptureLifecycleSchema,
} from '../../../src/schemas/ReplaySafeMemory.schema';

const receipt = {
  version: 2,
  kind: 'assistant_final_saved',
  persisted: true,
  operationId: '7f44b757-950c-4c52-b04b-5bcb0e6aa594',
  sourceId: '6e2bbe78-68f9-42da-b07e-867382d63a03',
  sourceHash: 'a'.repeat(64),
  descriptorHash: 'b'.repeat(64),
  terminalAt: '2026-10-25T12:00:00.000Z',
};
const empty = {
  state: 'not_requested',
  requested: 0,
  confirmedNew: 0,
  confirmedExisting: 0,
  unconfirmed: 0,
  reason: null,
};

describe('replay-safe invocation diagnostics', () => {
  it.each([
    {
      state: 'complete',
      requested: 2,
      confirmedNew: 1,
      confirmedExisting: 1,
      unconfirmed: 0,
      reason: null,
    },
    {
      state: 'partial',
      requested: 2,
      confirmedNew: 1,
      confirmedExisting: 0,
      unconfirmed: 0,
      reason: 'storage_error',
    },
    {
      state: 'failed',
      requested: 2,
      confirmedNew: 0,
      confirmedExisting: 0,
      unconfirmed: 0,
      reason: 'storage_error',
    },
    {
      state: 'unknown',
      requested: 2,
      confirmedNew: 1,
      confirmedExisting: 0,
      unconfirmed: 1,
      reason: 'acknowledgement_unknown',
    },
  ])('preserves a confirmed final independently of audit $state', (audit) => {
    const parsed = ReplaySafeMemoryWriteDiagnosticsSchema.parse({
      version: 2,
      should_process: false,
      finalAssistant: { state: 'persisted', terminalReceipt: receipt },
      audit,
    });
    expect(parsed.finalAssistant).toEqual({ state: 'persisted', terminalReceipt: receipt });
    expect(parsed.should_process).toBe(false);
  });

  it('supports audit-only batches without an assistant claim', () => {
    expect(
      ReplaySafeMemoryWriteDiagnosticsSchema.safeParse({
        version: 2,
        should_process: false,
        finalAssistant: { state: 'not_requested' },
        audit: empty,
      }).success,
    ).toBe(true);
  });

  it('reports an over-cap audit request honestly before any writes', () => {
    const result = ReplaySafeAuditDiagnosticsSchema.parse({
      ...empty,
      state: 'failed',
      requested: 33,
      reason: 'capacity',
    });
    expect(result.requested).toBe(33);
    expect(result.confirmedNew + result.confirmedExisting + result.unconfirmed).toBe(0);
    expect(
      ReplaySafeAuditDiagnosticsSchema.safeParse({ ...result, state: 'partial', confirmedNew: 1 })
        .success,
    ).toBe(false);
  });

  it.each([
    { ...empty, state: 'complete' },
    { ...empty, state: 'failed', reason: 'storage_error' },
    { ...empty, requested: 1 },
    { ...empty, state: 'complete', requested: 2, confirmedNew: 1 },
    { ...empty, state: 'partial', requested: 1, confirmedNew: 1, reason: 'storage_error' },
    { ...empty, state: 'failed', requested: 1, reason: 'acknowledgement_unknown' },
    { ...empty, state: 'unknown', requested: 1, unconfirmed: 1, reason: 'storage_error' },
    {
      ...empty,
      state: 'unknown',
      requested: 1,
      unconfirmed: 1,
      confirmedNew: 1,
      reason: 'acknowledgement_unknown',
    },
    { ...empty, state: 'complete', requested: 33, confirmedNew: 33 },
  ])('rejects inconsistent audit state %#', (audit) => {
    expect(ReplaySafeAuditDiagnosticsSchema.safeParse(audit).success).toBe(false);
  });

  it('distinguishes uncertain final persistence from a confirmed failure', () => {
    expect(
      ReplaySafeFinalAssistantDiagnosticsSchema.parse({ state: 'deferred', reason: 'in_progress' }),
    ).toEqual({ state: 'deferred', reason: 'in_progress' });
    expect(
      ReplaySafeFinalAssistantDiagnosticsSchema.safeParse({
        state: 'deferred',
        reason: 'storage_error',
      }).success,
    ).toBe(false);
    expect(
      ReplaySafeFinalAssistantDiagnosticsSchema.safeParse({
        state: 'unconfirmed',
        reason: 'acknowledgement_unknown',
      }).success,
    ).toBe(true);
    expect(
      ReplaySafeFinalAssistantDiagnosticsSchema.safeParse({
        state: 'failed',
        reason: 'acknowledgement_unknown',
      }).success,
    ).toBe(false);
    expect(
      ReplaySafeFinalAssistantDiagnosticsSchema.safeParse({
        state: 'unconfirmed',
        reason: 'storage_error',
      }).success,
    ).toBe(false);
    expect(
      ReplaySafeFinalAssistantDiagnosticsSchema.safeParse({ state: 'persisted' }).success,
    ).toBe(false);
  });

  it('accepts no raw error text or processing permission and adds no lifecycle default', () => {
    expect(
      ReplaySafeMemoryWriteDiagnosticsSchema.safeParse({
        version: 2,
        should_process: true,
        finalAssistant: { state: 'not_requested' },
        audit: empty,
      }).success,
    ).toBe(false);
    expect(
      ReplaySafeFinalAssistantDiagnosticsSchema.safeParse({
        state: 'failed',
        reason: 'private error text',
      }).success,
    ).toBe(false);
    expect(
      ReplaySafeFinalAssistantDiagnosticsSchema.safeParse({
        state: 'failed',
        reason: 'storage_error',
        raw: 'private text',
      }).success,
    ).toBe(false);
    expect(MemoryCaptureLifecycleSchema.optional().parse(undefined)).toBeUndefined();
  });
});
