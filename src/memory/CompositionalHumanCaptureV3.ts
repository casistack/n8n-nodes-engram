import { types as utilTypes } from 'util';
import { performance } from 'perf_hooks';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  cloneBoundedAutomaticCaptureJson,
  BoundedAutomaticCaptureJsonError,
} from '../storage/BoundedAutomaticCaptureJson';
import { isCompositionalFirstCommitResultForHandleV3 } from '../storage/CompositionalAutomaticCaptureHandlesV3';
import {
  CompositionalAutomaticCaptureBeginRequestV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  type CompositionalAutomaticCaptureBeginRequestV3,
  type CompositionalAutomaticCaptureTerminalReceiptV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalCaptureNonPermitResultV3Schema,
  type CompositionalCaptureNonPermitResultV3,
} from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import {
  CompositionalHumanCapturePublicResultV3Schema,
  CompositionalHumanCaptureReceiptSummaryV3Schema,
  type CompositionalHumanCapturePublicResultV3,
  type CompositionalHumanCapturePublicStatusV3,
  type CompositionalHumanCaptureReceiptSummaryV3,
} from '../schemas/CompositionalHumanCapturePublicResultV3.schema';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function plainDataObject(value: unknown): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (!plainDataObject(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    )
      return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !('value' in property)) return null;
      result[key] = property.value;
    }
    return result;
  } catch {
    return null;
  }
}

function initialClaim(value: unknown): { handle: object; claimKind: 'initial' | 'resume' } | null {
  const record = exactDataRecord(value, ['kind', 'claimKind', 'handle', 'eligibleFirstCommit']);
  if (
    !record ||
    record.kind !== 'claimed' ||
    record.eligibleFirstCommit !== false ||
    (record.claimKind !== 'initial' && record.claimKind !== 'resume')
  )
    return null;
  const handle = record.handle;
  if (
    handle === null ||
    typeof handle !== 'object' ||
    utilTypes.isProxy(handle) ||
    !Object.isFrozen(handle)
  )
    return null;
  try {
    if (Object.getPrototypeOf(handle) !== null || Reflect.ownKeys(handle).length !== 0) return null;
  } catch {
    return null;
  }
  return { handle, claimKind: record.claimKind };
}

function emptyCounts() {
  return {
    bundleCount: 0,
    persistedBundleCount: 0,
    distinctPersistedClaimCount: 0,
    byState: { accepted: 0, unchanged: 0, proposed: 0, rejected: 0, not_selected: 0 },
  } as const;
}

function receiptSummary(
  receipt: CompositionalAutomaticCaptureTerminalReceiptV3,
): CompositionalHumanCaptureReceiptSummaryV3 {
  if (receipt.kind === 'cancelled') {
    return {
      kind: 'cancelled',
      persisted: true,
      terminalAt: receipt.terminalAt,
      acceptedCoverage: 'none',
      counts: emptyCounts(),
    };
  }

  if (receipt.selection.kind === 'source_verdict') {
    return {
      kind: 'committed',
      persisted: true,
      terminalAt: receipt.terminalAt,
      interpretationCoverage: receipt.interpretationCoverage,
      acceptedCoverage: receipt.acceptedCoverage,
      reasons: [...receipt.reasons],
      selection: {
        kind: 'source_verdict',
        verdict: receipt.selection.verdict,
      },
      counts: emptyCounts(),
    };
  }

  const items = receipt.selection.items.map((item) => {
    if (item.state === 'deferred') throw new Error('Unexpected deferred terminal item');
    return {
      bundleIndex: item.bundleIndex,
      state: item.state,
      persisted: item.persisted,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
      ...(item.claimId === undefined ? {} : { claimId: item.claimId }),
    };
  });
  const byState = {
    accepted: items.filter((item) => item.state === 'accepted').length,
    unchanged: items.filter((item) => item.state === 'unchanged').length,
    proposed: items.filter((item) => item.state === 'proposed').length,
    rejected: items.filter((item) => item.state === 'rejected').length,
    not_selected: items.filter((item) => item.state === 'not_selected').length,
  };
  const persistedClaimIds = new Set(
    items.filter((item) => item.persisted).map((item) => item.claimId),
  );
  return {
    kind: 'committed',
    persisted: true,
    terminalAt: receipt.terminalAt,
    interpretationCoverage: receipt.interpretationCoverage,
    acceptedCoverage: receipt.acceptedCoverage,
    reasons: [...receipt.reasons],
    selection: { kind: 'bundles', items },
    counts: {
      bundleCount: items.length,
      persistedBundleCount: items.filter((item) => item.persisted).length,
      distinctPersistedClaimCount: persistedClaimIds.size,
      byState,
    },
  };
}

/** Bounded display data only; this does not authenticate a receipt or authorize processing. */
export function projectCompositionalCaptureReceiptSummaryV3(
  value: unknown,
  check: () => void = () => {},
): CompositionalHumanCaptureReceiptSummaryV3 {
  check();
  const owned = cloneBoundedAutomaticCaptureJson(value, 'beginRequest');
  check();
  const receipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(owned);
  check();
  const summary = CompositionalHumanCaptureReceiptSummaryV3Schema.parse(receiptSummary(receipt));
  const freeze = (item: unknown): void => {
    check();
    if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(summary);
  check();
  return summary;
}

function statusForDecision(kind: string): CompositionalHumanCapturePublicStatusV3 {
  switch (kind) {
    case 'in_progress':
    case 'legacy_unconfirmed':
    case 'source_only_unconfirmed':
    case 'conflict':
    case 'authority_changed':
    case 'clock_regression':
    case 'capacity':
    case 'resource_exhausted':
    case 'budget_exhausted':
    case 'interrupted':
    case 'acknowledgement_unknown':
    case 'not_found':
    case 'invalid_input':
    case 'unsupported_mode':
      return kind;
    default:
      return 'failed';
  }
}

function publicResult(input: {
  status: CompositionalHumanCapturePublicStatusV3;
  purpose: 'human_turn_memory' | null;
  sourceId?: string | null;
  should_process?: boolean;
  currentAuthority?: 'active' | 'changed' | 'revoked' | 'unknown' | 'not_evaluated';
  receiptSummary?: CompositionalHumanCaptureReceiptSummaryV3 | null;
}): CompositionalHumanCapturePublicResultV3 {
  const result = CompositionalHumanCapturePublicResultV3Schema.parse({
    version: 3,
    purpose: input.purpose,
    status: input.status,
    sourceId: input.sourceId ?? null,
    should_process: input.should_process ?? false,
    currentAuthority: input.currentAuthority ?? 'not_evaluated',
    receiptSummary: input.receiptSummary ?? null,
  });
  return deepFreeze(result);
}

function nonPermitProjection(
  result: CompositionalCaptureNonPermitResultV3,
  purpose: 'human_turn_memory',
): CompositionalHumanCapturePublicResultV3 {
  if (result.kind === 'committed') {
    return publicResult({
      purpose,
      status: 'committed_replay',
      sourceId: result.terminalReceipt.sourceId,
      currentAuthority: result.currentAuthority,
      receiptSummary: receiptSummary(result.terminalReceipt),
    });
  }
  if (result.kind === 'cancelled') {
    return publicResult({
      purpose,
      status: 'cancelled',
      sourceId: result.terminalReceipt.sourceId,
      currentAuthority: 'not_evaluated',
      receiptSummary: receiptSummary(result.terminalReceipt),
    });
  }
  const status = statusForDecision(result.kind);
  return publicResult({
    purpose,
    status,
    currentAuthority: status === 'authority_changed' ? 'unknown' : 'not_evaluated',
  });
}

function parseNonPermit(value: unknown): CompositionalCaptureNonPermitResultV3 | null {
  try {
    const owned = cloneBoundedAutomaticCaptureJson(value, 'beginRequest');
    const parsed = CompositionalCaptureNonPermitResultV3Schema.safeParse(owned);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isBudgetBoundFailure(error: unknown): boolean {
  return error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json';
}

/**
 * One-call native coordinator. Only the actual backend's initial completion
 * result, authenticated against the exact handle returned by begin, can set
 * `should_process`; this public object itself is data, never a capability.
 */
export async function captureCompositionalHumanMemoryV3(
  storage: IGraphStorage,
  input: CompositionalAutomaticCaptureBeginRequestV3,
): Promise<CompositionalHumanCapturePublicResultV3> {
  const startedAt = performance.now();
  let request: CompositionalAutomaticCaptureBeginRequestV3;
  try {
    request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
    );
  } catch (error) {
    return publicResult({
      status: isBudgetBoundFailure(error) ? 'resource_exhausted' : 'invalid_input',
      purpose: null,
    });
  }

  const deadlineAt = startedAt + request.settings.invocationDeadlineMs;
  const withinDeadline = () => performance.now() < deadlineAt;
  if (!withinDeadline())
    return publicResult({ status: 'budget_exhausted', purpose: 'human_turn_memory' });
  if (
    request.purpose !== 'human_turn_memory' ||
    !storage.beginAndClaimCompositionalCaptureV3 ||
    !storage.completeCompositionalHumanCaptureV3
  )
    return publicResult({ status: 'unsupported_mode', purpose: 'human_turn_memory' });

  const methodRequest: CompositionalCaptureBeginMethodRequestV3 = {
    request,
    mode: 'existingStore',
  };
  let beginResult: unknown;
  try {
    if (!withinDeadline())
      return publicResult({ status: 'budget_exhausted', purpose: 'human_turn_memory' });
    beginResult = await storage.beginAndClaimCompositionalCaptureV3(methodRequest);
  } catch {
    return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });
  }
  if (!withinDeadline())
    return publicResult({ status: 'budget_exhausted', purpose: 'human_turn_memory' });

  const claim = initialClaim(beginResult);
  if (claim) {
    if (claim.claimKind !== 'initial')
      return publicResult({ status: 'unsupported_mode', purpose: 'human_turn_memory' });
    if (!withinDeadline())
      return publicResult({ status: 'budget_exhausted', purpose: 'human_turn_memory' });

    let completionResult: unknown;
    try {
      completionResult = await storage.completeCompositionalHumanCaptureV3(claim.handle as never);
    } catch {
      return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });
    }

    // This predicate is intentionally the first operation on the returned
    // object: a fake result can be a proxy or accessor-bearing object.
    if (isCompositionalFirstCommitResultForHandleV3(completionResult, claim.handle)) {
      if (!withinDeadline())
        return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });
      const summary = receiptSummary(completionResult.terminalReceipt);
      if (!withinDeadline())
        return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });
      let result: CompositionalHumanCapturePublicResultV3;
      try {
        result = publicResult({
          status: 'first_capture_committed',
          purpose: 'human_turn_memory',
          sourceId: completionResult.terminalReceipt.sourceId,
          should_process: true,
          currentAuthority: 'active',
          receiptSummary: summary,
        });
      } catch {
        return publicResult({ status: 'failed', purpose: 'human_turn_memory' });
      }
      if (!withinDeadline())
        return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });
      return result;
    }
    if (!withinDeadline())
      return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });

    let safeCompletion: CompositionalCaptureNonPermitResultV3 | null = null;
    try {
      const owned = cloneBoundedAutomaticCaptureJson(completionResult, 'beginRequest');
      if (
        owned !== null &&
        typeof owned === 'object' &&
        !Array.isArray(owned) &&
        (owned as Record<string, unknown>).eligibleFirstCommit === true
      )
        return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });
      const parsed = CompositionalCaptureNonPermitResultV3Schema.safeParse(owned);
      if (parsed.success) safeCompletion = parsed.data;
    } catch {
      safeCompletion = null;
    }
    if (!withinDeadline())
      return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });
    if (!safeCompletion) return publicResult({ status: 'failed', purpose: 'human_turn_memory' });
    const projected = nonPermitProjection(safeCompletion, 'human_turn_memory');
    if (!withinDeadline())
      return publicResult({ status: 'acknowledgement_unknown', purpose: 'human_turn_memory' });
    return projected;
  }

  const safeBegin = parseNonPermit(beginResult);
  if (!safeBegin) return publicResult({ status: 'failed', purpose: 'human_turn_memory' });
  if (!withinDeadline())
    return publicResult({ status: 'budget_exhausted', purpose: 'human_turn_memory' });
  const projected = nonPermitProjection(safeBegin, 'human_turn_memory');
  if (!withinDeadline())
    return publicResult({ status: 'budget_exhausted', purpose: 'human_turn_memory' });
  return projected;
}
