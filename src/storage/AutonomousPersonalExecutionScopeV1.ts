import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import {
  AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS,
  type AutonomousPersonalExecutionBudgetConfiguredV1OwnedData,
  type AutonomousPersonalExecutionBudgetV1OwnedData,
} from '../schemas/AutonomousPersonalExecutionBudgetV1.schema';
import {
  AutonomousPersonalExecutionDiagnosticsV1Schema,
  AutonomousPersonalExecutionDiagnosticsStageV1Schema,
  type AutonomousPersonalExecutionDiagnosticsV1,
} from '../schemas/AutonomousPersonalExecutionDiagnosticsV1.schema';
import {
  AutonomousPersonalExecutionScopeDiagnosticsV1Schema,
  AutonomousPersonalExecutionScopePurposeV1Schema,
  type AutonomousPersonalExecutionScopeBudgetStopReasonV1,
  type AutonomousPersonalExecutionScopeDiagnosticsV1,
  type AutonomousPersonalExecutionScopeErrorReasonV1,
  type AutonomousPersonalExecutionScopeFirstStopV1,
  type AutonomousPersonalExecutionScopePurposeV1,
} from '../schemas/AutonomousPersonalExecutionScopeV1.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  compileAutonomousPersonalExecutionBudgetV1,
  resolveAutonomousPersonalExecutionBudgetV1,
} from './AutonomousPersonalExecutionBudgetV1';

declare const entryBrand: unique symbol;

/** Opaque, frozen, empty token. Only the module-private registry gives it meaning. */
export type AutonomousPersonalExecutionScopeEntryV1 = Readonly<{ [entryBrand]: true }>;

/** Genuine invocation/stage/syntax time exhaustion or cancellation only. */
export class AutonomousPersonalExecutionScopeBudgetError extends ExtractionBudgetError {
  constructor(
    budgetReason: 'deadline' | 'cancelled',
    readonly stopReason: AutonomousPersonalExecutionScopeBudgetStopReasonV1,
  ) {
    super(budgetReason);
    this.name = 'AutonomousPersonalExecutionScopeBudgetError';
  }
}

/** Fixed non-budget scope, configuration, clock and span-misuse failures. */
export class AutonomousPersonalExecutionScopeError extends Error {
  constructor(readonly reason: AutonomousPersonalExecutionScopeErrorReasonV1) {
    super(`Engram autonomous execution scope: ${reason}`);
    this.name = 'AutonomousPersonalExecutionScopeError';
  }
}

interface ScopeRecord {
  readonly purpose: AutonomousPersonalExecutionScopePurposeV1;
  readonly t0: number;
  readonly controller: AbortController;
  lastNow: number;
  bound: boolean;
  closed: boolean;
  running: boolean;
  fingerprint: string | null;
  configuredBudget: AutonomousPersonalExecutionBudgetConfiguredV1OwnedData | null;
  overallMs: number;
  originalDeadline: number | null;
  effectiveDeadline: number | null;
  syntaxAllowanceMs: number | null;
  effectiveReserveMs: number | null;
  completionEffectiveMs: number | null;
  lastReachedStage: AutonomousPersonalExecutionDiagnosticsV1['lastReachedStage'];
  parent: AbortSignal | undefined;
  parentListener: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  charged: number;
  depth: number;
  spanStart: number;
  failure: Error | undefined;
  firstStop: AutonomousPersonalExecutionScopeFirstStopV1 | null;
  /** Lazily cached default work; any clip drops it so an old deadline is never reused. */
  defaultWork: AutonomousPersonalTypedSyntaxWorkV1 | undefined;
}

interface WorkRegistration {
  readonly entry: object;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

const records = new WeakMap<object, ScopeRecord>();
const latestEntriesByContext = new WeakMap<object, object>();
const contextEntries = new WeakMap<object, WeakSet<object>>();
const works = new WeakMap<object, WorkRegistration>();
const ambient = new AsyncLocalStorage<object>();
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const nativeAddListener = EventTarget.prototype.addEventListener;
const nativeRemoveListener = EventTarget.prototype.removeEventListener;
const NativePromise = Promise;
const nativePromisePrototype = Promise.prototype;
const promiseThen = Promise.prototype.then;
const promiseConstructorDescriptor = Object.getOwnPropertyDescriptor(
  Promise.prototype,
  'constructor',
);
const promiseSpeciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
const ignore = (): void => undefined;

function sameDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

/**
 * Attach a rejection sink only after descriptor-only proof that the captured native then
 * cannot reach foreign code: no getter calls, prototype walking or caller mutation. If any
 * proof fails no observer is attached; the invalid callback keeps its own async risk.
 */
function observeNativePromiseRejection(value: object): void {
  try {
    if (utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== nativePromisePrototype) return;
    const own = Object.getOwnPropertyDescriptor(value, 'constructor');
    if (
      own !== undefined &&
      (own.get !== undefined || own.set !== undefined || own.value !== NativePromise)
    ) {
      return;
    }
    const inherited = Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor');
    if (
      !sameDescriptor(inherited, promiseConstructorDescriptor) ||
      inherited?.value !== NativePromise
    ) {
      return;
    }
    if (
      !sameDescriptor(
        Object.getOwnPropertyDescriptor(NativePromise, Symbol.species),
        promiseSpeciesDescriptor,
      )
    ) {
      return;
    }
    promiseThen.call(value, undefined, ignore);
  } catch {
    // No observer: a failed proof is never retried through foreign code.
  }
}
const { overallMs: overallBounds } = AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS;

function markStage(record: ScopeRecord, stage: unknown): void {
  try {
    const parsed = AutonomousPersonalExecutionDiagnosticsStageV1Schema.safeParse(stage);
    if (!parsed.success) return;
    record.lastReachedStage = parsed.data;
  } catch {
    // Optional diagnostic bookkeeping must not change execution behavior.
  }
}

function deepFreezeDiagnostic<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeDiagnostic(child);
    }
  }
  return value;
}

function fail(reason: AutonomousPersonalExecutionScopeErrorReasonV1): never {
  throw new AutonomousPersonalExecutionScopeError(reason);
}

function requireContext(context: unknown): object {
  if (context === null || typeof context !== 'object' || utilTypes.isProxy(context)) {
    fail('invalid_scope');
  }
  return context;
}

function requirePurpose(purpose: unknown): AutonomousPersonalExecutionScopePurposeV1 {
  const parsed =
    typeof purpose === 'string'
      ? AutonomousPersonalExecutionScopePurposeV1Schema.safeParse(purpose)
      : undefined;
  if (!parsed?.success) fail('invalid_scope');
  return parsed.data;
}

function nativeSignal(value: unknown): AbortSignal {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || !nativeAborted) {
    fail('invalid_configuration');
  }
  try {
    nativeAborted.call(value);
  } catch {
    fail('invalid_configuration');
  }
  return value as AbortSignal;
}

function isAborted(signal: AbortSignal): boolean {
  return nativeAborted!.call(signal);
}

/** Exact owner match: a genuine token registered for this exact, non-proxy context. */
function owned(entry: unknown, context: unknown): ScopeRecord {
  const record =
    entry !== null && typeof entry === 'object' ? records.get(entry as object) : undefined;
  if (!record) fail('invalid_scope');
  if (!contextEntries.get(requireContext(context))?.has(entry as object)) fail('foreign_scope');
  return record;
}

function latch(
  record: ScopeRecord,
  error: Error,
  stop: AutonomousPersonalExecutionScopeFirstStopV1,
): Error {
  if (record.failure) return record.failure;
  record.failure = error;
  record.firstStop = stop;
  if (error instanceof ExtractionBudgetError) record.controller.abort();
  return error;
}

function budgetStop(
  record: ScopeRecord,
  budgetReason: 'deadline' | 'cancelled',
  stop: AutonomousPersonalExecutionScopeBudgetStopReasonV1,
): Error {
  return latch(record, new AutonomousPersonalExecutionScopeBudgetError(budgetReason, stop), stop);
}

/** Reject nonfinite/backwards samples; the first failure is latched with its identity. */
function sample(record: ScopeRecord): number {
  const now = performance.now();
  if (!Number.isFinite(now)) {
    throw latch(
      record,
      new AutonomousPersonalExecutionScopeError('clock_invalid'),
      'clock_invalid',
    );
  }
  if (now < record.lastNow) {
    throw latch(
      record,
      new AutonomousPersonalExecutionScopeError('clock_regression'),
      'clock_regression',
    );
  }
  record.lastNow = now;
  return now;
}

/** Throws the latched failure, or latches and throws the first newly detected stop. */
function evaluate(record: ScopeRecord, stage?: WorkRegistration): void {
  if (record.failure) throw record.failure;
  if (record.parent && isAborted(record.parent)) {
    throw budgetStop(record, 'cancelled', 'parent_cancelled');
  }
  if (stage && isAborted(stage.signal)) throw budgetStop(record, 'cancelled', 'stage_cancelled');
  const now = sample(record);
  if (record.effectiveDeadline !== null && now >= record.effectiveDeadline) {
    throw budgetStop(record, 'deadline', 'invocation_deadline');
  }
  if (stage && now >= stage.deadline) throw budgetStop(record, 'deadline', 'stage_deadline');
  if (record.syntaxAllowanceMs !== null) {
    const total = record.charged + (record.depth > 0 ? now - record.spanStart : 0);
    if (total >= record.syntaxAllowanceMs) throw budgetStop(record, 'deadline', 'syntax_allowance');
  }
}

/** Own timer measures the time left to the ORIGINAL effective deadline, never a fresh allowance. */
function schedule(record: ScopeRecord, now: number): void {
  if (record.timer !== undefined) clearTimeout(record.timer);
  record.timer = undefined;
  if (record.failure || record.closed || record.effectiveDeadline === null) return;
  const timer = setTimeout(
    () => {
      record.timer = undefined;
      budgetStop(record, 'deadline', 'invocation_deadline');
    },
    Math.max(0, Math.ceil(record.effectiveDeadline - now)),
  );
  if (typeof timer === 'object') timer.unref?.();
  record.timer = timer;
}

/** Clears only this record's own timer/listener; never aborts the parent. */
function release(record: ScopeRecord): void {
  record.closed = true;
  if (record.timer !== undefined) clearTimeout(record.timer);
  record.timer = undefined;
  if (record.parent && record.parentListener) {
    nativeRemoveListener.call(record.parent, 'abort', record.parentListener);
  }
  record.parent = undefined;
  record.parentListener = undefined;
}

/** Capture the clock FIRST, then register an opaque token for this exact context and purpose. */
export function openAutonomousPersonalExecutionScopeV1(
  context: unknown,
  purpose: unknown,
): AutonomousPersonalExecutionScopeEntryV1 {
  let t0: number;
  try {
    t0 = performance.now();
  } catch (error) {
    // A WeakMap delete is identity-only and does not inspect a caller object or proxy.
    if (context !== null && typeof context === 'object') {
      latestEntriesByContext.delete(context as object);
    }
    throw error;
  }
  // T0 remains the first operation. Clear stale DATA before validation can fail.
  if (context !== null && typeof context === 'object') {
    latestEntriesByContext.delete(context as object);
  }
  const owner = requireContext(context);
  const checkedPurpose = requirePurpose(purpose);
  if (!Number.isFinite(t0) || t0 < 0) fail('clock_invalid');
  const entry = Object.freeze({});
  records.set(entry, {
    purpose: checkedPurpose,
    t0,
    controller: new AbortController(),
    lastNow: t0,
    bound: false,
    closed: false,
    running: false,
    fingerprint: null,
    configuredBudget: null,
    overallMs: 0,
    originalDeadline: null,
    effectiveDeadline: null,
    syntaxAllowanceMs: null,
    effectiveReserveMs: null,
    completionEffectiveMs: null,
    lastReachedStage: null,
    parent: undefined,
    parentListener: undefined,
    timer: undefined,
    charged: 0,
    depth: 0,
    spanStart: 0,
    failure: undefined,
    firstStop: null,
    defaultWork: undefined,
  });
  const owners = contextEntries.get(owner) ?? new WeakSet<object>();
  owners.add(entry);
  contextEntries.set(owner, owners);
  // A new outer invocation clears the association even when binding later fails.
  latestEntriesByContext.set(owner, entry);
  return entry as AutonomousPersonalExecutionScopeEntryV1;
}

/**
 * Bind once. T0 never changes; elapsed pre-bind time is charged as the synchronous entry
 * span (callers bind BEFORE their first await). An identical rebind is a no-op.
 */
export function bindAutonomousPersonalExecutionScopeV1(
  entry: AutonomousPersonalExecutionScopeEntryV1,
  context: unknown,
  budget: unknown,
  overallMs: unknown,
  parentSignal?: unknown,
): void {
  const record = owned(entry, context);
  if (record.closed) fail('scope_closed');

  let fingerprint: string | null;
  let allowance: number | null;
  let signal: AbortSignal | undefined;
  let overall: number;
  let configuredBudget: AutonomousPersonalExecutionBudgetConfiguredV1OwnedData | undefined;
  let effectiveReserve: number | undefined;
  try {
    if (
      typeof overallMs !== 'number' ||
      !Number.isSafeInteger(overallMs) ||
      overallMs < overallBounds.min ||
      overallMs > overallBounds.max ||
      budget === null ||
      typeof budget !== 'object' ||
      utilTypes.isProxy(budget)
    ) {
      throw new Error();
    }
    overall = overallMs;
    if (parentSignal !== undefined) signal = nativeSignal(parentSignal);
    const compiled: AutonomousPersonalExecutionBudgetV1OwnedData =
      compileAutonomousPersonalExecutionBudgetV1(budget);
    if (compiled.semantics !== 'configured') throw new Error();
    configuredBudget = compiled;
    const resolution = resolveAutonomousPersonalExecutionBudgetV1(compiled, {
      originalStartedAt: record.t0,
      configuredOverallMs: overall,
      originalOverallDeadlineAt: record.t0 + overall,
      existingLeaseDeadlineAt: record.t0 + overall,
    });
    fingerprint = resolution.fingerprint;
    allowance = resolution.syntaxAllowanceMs;
    effectiveReserve = resolution.finalizationReserveMs;
    if (fingerprint === null) throw new Error();
  } catch {
    fail('invalid_configuration');
  }
  if (configuredBudget === undefined || effectiveReserve === undefined) {
    fail('invalid_configuration');
  }

  if (record.bound) {
    if (
      record.fingerprint === fingerprint &&
      record.overallMs === overall &&
      record.parent === signal
    ) {
      return;
    }
    fail('configuration_conflict');
  }

  const now = sample(record);
  record.bound = true;
  record.fingerprint = fingerprint;
  record.configuredBudget = configuredBudget;
  record.overallMs = overall;
  record.originalDeadline = record.t0 + overall;
  record.effectiveDeadline = record.originalDeadline;
  record.syntaxAllowanceMs = allowance;
  record.effectiveReserveMs = effectiveReserve;
  record.charged = now - record.t0;
  if (signal) {
    record.parent = signal;
    if (isAborted(signal)) {
      budgetStop(record, 'cancelled', 'parent_cancelled');
    } else {
      const listener = () => {
        budgetStop(record, 'cancelled', 'parent_cancelled');
      };
      record.parentListener = listener;
      nativeAddListener.call(signal, 'abort', listener, { once: true });
    }
  }
  schedule(record, now);
  evaluate(record);
}

/** Clip the effective overall to an absolute lease deadline: never extends or re-anchors. */
export function clipAutonomousPersonalExecutionScopeLeaseV1(
  entry: AutonomousPersonalExecutionScopeEntryV1,
  context: unknown,
  leaseDeadlineMs: unknown,
): void {
  const record = owned(entry, context);
  if (
    typeof leaseDeadlineMs !== 'number' ||
    !Number.isFinite(leaseDeadlineMs) ||
    leaseDeadlineMs < 0
  ) {
    fail('invalid_configuration');
  }
  if (record.closed) fail('scope_closed');
  if (!record.bound) fail('scope_not_bound');
  if (leaseDeadlineMs < record.effectiveDeadline!) {
    record.effectiveDeadline = leaseDeadlineMs;
    // Narrower registered stage work stays valid; only the regenerable default is dropped.
    record.defaultWork = undefined;
    schedule(record, sample(record));
  }
  evaluate(record);
}

/** Idempotent. Keeps first-stop diagnostics; clears only this entry's own timer/listener. */
export function closeAutonomousPersonalExecutionScopeV1(
  entry: AutonomousPersonalExecutionScopeEntryV1,
  context: unknown,
): void {
  release(owned(entry, context));
}

/**
 * One-shot async scope. The final check runs on successful resolution; a rejection keeps
 * its original error object while any internal stop is only latched for later checks.
 */
export async function runAutonomousPersonalExecutionScopeV1<T>(
  entry: AutonomousPersonalExecutionScopeEntryV1,
  context: unknown,
  callback: () => Promise<T>,
): Promise<T> {
  const record = owned(entry, context);
  if (typeof callback !== 'function') fail('invalid_configuration');
  if (record.closed) fail('scope_closed');
  if (!record.bound) fail('scope_not_bound');
  if (record.running) fail('scope_already_running');
  const outer = ambient.getStore();
  if (outer !== undefined && outer !== entry) {
    const outerRecord = records.get(outer);
    if (outerRecord && !outerRecord.closed) fail('nested_scope');
  }
  record.running = true;
  try {
    // Liveness first: an expired, cancelled or latched entry never invokes the callback.
    evaluate(record);
    let result: T;
    try {
      result = await ambient.run(entry, callback);
    } catch (error) {
      try {
        evaluate(record);
      } catch {
        // Latched for later checks; the callback's own rejection is what propagates.
      }
      throw error;
    }
    if (record.failure === undefined) markStage(record, 'final_check');
    evaluate(record);
    return result;
  } finally {
    release(record);
  }
}

/** Fixed internal stage markers. Unknown/no configured scope is intentionally a no-op. */
export function markCurrentAutonomousPersonalExecutionStageV1(stage: unknown): void {
  try {
    const entry = ambient.getStore();
    const record = entry === undefined ? undefined : records.get(entry);
    if (
      record &&
      record.purpose === 'adminCapture' &&
      record.bound &&
      !record.closed &&
      record.failure === undefined
    ) {
      markStage(record, stage);
    }
  } catch {
    // Diagnostics never alter a capture decision.
  }
}

/** Record values returned by the trusted completion resolver; never grants or extends work. */
export function recordCurrentAutonomousPersonalExecutionCompletionV1(
  completionStartedAtMonotonicMs: number,
  completionDeadlineAtMonotonicMs: number,
  finalizationReserveMs: number,
): void {
  try {
    const entry = ambient.getStore();
    const record = entry === undefined ? undefined : records.get(entry);
    if (
      !record ||
      record.purpose !== 'adminCapture' ||
      !record.bound ||
      record.closed ||
      record.failure !== undefined ||
      !Number.isFinite(completionStartedAtMonotonicMs) ||
      !Number.isFinite(completionDeadlineAtMonotonicMs) ||
      !Number.isFinite(finalizationReserveMs) ||
      completionStartedAtMonotonicMs < record.t0 ||
      completionDeadlineAtMonotonicMs > record.effectiveDeadline! ||
      finalizationReserveMs < 0
    ) {
      return;
    }
    record.completionEffectiveMs = Math.max(
      0,
      completionDeadlineAtMonotonicMs - completionStartedAtMonotonicMs,
    );
    record.effectiveReserveMs = finalizationReserveMs;
    markStage(record, 'completion');
  } catch {
    // Diagnostics never alter a capture decision.
  }
}

/** Read the latest exact-context configured invocation after close; unbound entries omit DATA. */
export function getLatestAutonomousPersonalExecutionDiagnosticsV1(
  context: unknown,
): Readonly<AutonomousPersonalExecutionDiagnosticsV1> | null {
  try {
    const owner = requireContext(context);
    const entry = latestEntriesByContext.get(owner);
    const record = entry === undefined ? undefined : records.get(entry);
    if (
      !record ||
      !record.bound ||
      record.configuredBudget === null ||
      record.effectiveDeadline === null ||
      record.effectiveReserveMs === null
    ) {
      return null;
    }
    const now = performance.now();
    const validNow = Number.isFinite(now) && now >= record.lastNow && now >= record.t0;
    const budget = record.configuredBudget;
    const effectiveOverallMs = Math.max(0, record.effectiveDeadline - record.t0);
    const activeNow = validNow && record.depth > 0 ? Math.max(0, now - record.spanStart) : 0;
    const value = AutonomousPersonalExecutionDiagnosticsV1Schema.parse({
      version: 1,
      lastReachedStage: record.lastReachedStage,
      elapsedMs: validNow ? now - record.t0 : null,
      cumulativeSynchronousWorkMs: Math.max(0, record.charged + activeNow),
      configured: {
        overallMs: record.overallMs,
        completion: budget.completion,
        syntax: budget.syntax,
        finalizationReserve: budget.finalizationReserve,
      },
      effective: {
        overallMs: effectiveOverallMs,
        completionMs: record.completionEffectiveMs,
        syntaxMs:
          budget.syntax.mode === 'limited' ? budget.syntax.durationMs : record.syntaxAllowanceMs,
        finalizationReserveMs: record.effectiveReserveMs,
      },
      firstStop: record.firstStop,
    });
    return deepFreezeDiagnostic(value);
  } catch {
    // A malformed observation is omitted rather than changing the native result.
    return null;
  }
}

/** Current open entry for this exact context and purpose, for reuse by later native wrappers. */
export function currentAutonomousPersonalExecutionScopeV1(
  context: unknown,
  purpose: unknown,
): AutonomousPersonalExecutionScopeEntryV1 | undefined {
  const owner = requireContext(context);
  const checkedPurpose = requirePurpose(purpose);
  const current = ambient.getStore();
  const record = current === undefined ? undefined : records.get(current);
  if (
    !record ||
    record.closed ||
    record.purpose !== checkedPurpose ||
    !contextEntries.get(owner)?.has(current!)
  ) {
    return undefined;
  }
  return current as AutonomousPersonalExecutionScopeEntryV1;
}

/** Frozen native two-field typed work, registered by exact identity to this entry/stage. */
export function createAutonomousPersonalExecutionScopeWorkV1(
  entry: AutonomousPersonalExecutionScopeEntryV1,
  context: unknown,
  absoluteMonotonicDeadlineMs: unknown,
  stageSignal?: unknown,
): AutonomousPersonalTypedSyntaxWorkV1 {
  const record = owned(entry, context);
  if (record.closed) fail('scope_closed');
  if (!record.bound) fail('scope_not_bound');
  if (ambient.getStore() !== entry) fail('foreign_scope');
  if (
    typeof absoluteMonotonicDeadlineMs !== 'number' ||
    !Number.isFinite(absoluteMonotonicDeadlineMs) ||
    absoluteMonotonicDeadlineMs > record.effectiveDeadline!
  ) {
    fail('invalid_configuration');
  }
  const signal = stageSignal === undefined ? record.controller.signal : nativeSignal(stageSignal);
  const registration: WorkRegistration = { entry, deadline: absoluteMonotonicDeadlineMs, signal };
  // Evaluate the proposed stage (overall, stage deadline, cancellation, clock) before publishing.
  evaluate(record, registration);
  const work: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
    absoluteMonotonicDeadlineMs,
    signal,
  });
  evaluate(record, registration);
  works.set(work, registration);
  return work;
}

function activeRegistration(
  work: unknown,
  context: unknown,
): { registration: WorkRegistration; record: ScopeRecord } | undefined {
  const registration =
    work !== null && typeof work === 'object' ? works.get(work as object) : undefined;
  if (!registration) return undefined;
  const record = owned(registration.entry, context);
  if (record.closed) fail('scope_closed');
  if (ambient.getStore() !== registration.entry) fail('foreign_scope');
  return { registration, record };
}

/**
 * Check a work object. Unregistered work (including clones/proxies) reports `legacy` and is
 * unchanged; registered work is checked against both outer and stage bounds.
 */
export function checkAutonomousPersonalExecutionScopeWorkV1(
  work: unknown,
  context: unknown,
): 'legacy' | 'configured' {
  const active = activeRegistration(work, context);
  if (!active) return 'legacy';
  evaluate(active.record, active.registration);
  return 'configured';
}

/**
 * Run a fixed, code-owned SYNCHRONOUS span. Elapsed time is charged once at the outermost
 * span; waits between spans consume wall time only. Callback errors are rethrown unchanged.
 */
export function runAutonomousPersonalExecutionScopeSyntaxSpanV1<T>(
  work: unknown,
  context: unknown,
  callback: () => T,
): T {
  if (typeof callback !== 'function') fail('invalid_configuration');
  const active = activeRegistration(work, context);
  if (!active) return callback();
  return runSyntaxSpan(active.record, active.registration, callback);
}

/**
 * Consumer registration lookup for pure code that holds work but no native context. The work
 * must be registered to EXACTLY the active ambient entry; unknown or copied work is legacy,
 * while foreign or closed registered work fails. No context is exposed or fabricated.
 */
function activeAmbientRegistration(
  work: unknown,
): { registration: WorkRegistration; record: ScopeRecord } | undefined {
  const registration =
    work !== null && typeof work === 'object' ? works.get(work as object) : undefined;
  if (!registration) return undefined;
  const record = records.get(registration.entry);
  if (!record) fail('invalid_scope');
  if (record.closed) fail('scope_closed');
  if (!record.bound) fail('scope_not_bound');
  if (ambient.getStore() !== registration.entry) fail('foreign_scope');
  return { registration, record };
}

/**
 * Registered frozen default work for the active ambient scope, or undefined when no scope is
 * active. An active closed, unbound or failed scope throws and never falls back to legacy.
 * Deadline and signal come privately from the scope; the caller supplies nothing.
 */
export function currentAutonomousPersonalExecutionScopeWorkV1():
  | AutonomousPersonalTypedSyntaxWorkV1
  | undefined {
  const entry = ambient.getStore();
  if (entry === undefined) return undefined;
  const record = records.get(entry);
  if (!record) return undefined;
  if (record.closed) fail('scope_closed');
  if (!record.bound) fail('scope_not_bound');
  evaluate(record);
  const deadline = record.effectiveDeadline!;
  const cached = record.defaultWork;
  if (cached !== undefined && works.get(cached)?.deadline === deadline) return cached;

  const registration: WorkRegistration = { entry, deadline, signal: record.controller.signal };
  evaluate(record, registration);
  const work: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
    absoluteMonotonicDeadlineMs: deadline,
    signal: registration.signal,
  });
  evaluate(record, registration);
  works.set(work, registration);
  record.defaultWork = work;
  return work;
}

/** Context-free budget check: `legacy` for unknown work, `configured` after a live check. */
export function checkCurrentAutonomousPersonalExecutionScopeWorkV1(
  work: unknown,
): 'legacy' | 'configured' {
  const active = activeAmbientRegistration(work);
  if (!active) return 'legacy';
  evaluate(active.record, active.registration);
  return 'configured';
}

/** Context-free synchronous span sharing the explicit-context CPU counters. */
export function runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1<T>(
  work: unknown,
  callback: () => T,
): T {
  if (typeof callback !== 'function') fail('invalid_configuration');
  const active = activeAmbientRegistration(work);
  if (!active) return callback();
  return runSyntaxSpan(active.record, active.registration, callback);
}

function runSyntaxSpan<T>(
  record: ScopeRecord,
  registration: WorkRegistration,
  callback: () => T,
): T {
  if (utilTypes.isAsyncFunction(callback)) fail('async_span_misuse');

  evaluate(record, registration);
  if (record.depth === 0) record.spanStart = record.lastNow;
  record.depth++;
  let value: T | undefined;
  let threw = false;
  let original: unknown;
  try {
    value = callback();
  } catch (error) {
    threw = true;
    original = error;
  }
  record.depth--;
  let accounting: unknown;
  if (record.depth === 0) {
    try {
      record.charged += sample(record) - record.spanStart;
    } catch (error) {
      accounting = error;
    }
  }
  if (threw) {
    try {
      evaluate(record, registration);
    } catch {
      // Latched for subsequent checks; the callback's original error wins.
    }
    throw original;
  }
  if (accounting !== undefined) throw accounting;
  if (utilTypes.isPromise(value)) {
    observeNativePromiseRejection(value as object);
    fail('async_span_misuse');
  }
  evaluate(record, registration);
  return value as T;
}

/** Frozen bounded DATA. Reports only recorded values; never samples or fabricates elapsed. */
export function diagnoseAutonomousPersonalExecutionScopeV1(
  entry: AutonomousPersonalExecutionScopeEntryV1,
  context: unknown,
): Readonly<AutonomousPersonalExecutionScopeDiagnosticsV1> {
  const record = owned(entry, context);
  return Object.freeze(
    AutonomousPersonalExecutionScopeDiagnosticsV1Schema.parse({
      version: 1,
      purpose: record.purpose,
      bound: record.bound,
      closed: record.closed,
      fingerprint: record.fingerprint,
      originalDeadlineMs: record.originalDeadline,
      effectiveDeadlineMs: record.effectiveDeadline,
      syntaxAllowanceMs: record.syntaxAllowanceMs,
      chargedSyntaxMs: record.charged,
      activeDepth: record.depth,
      firstStop: record.firstStop,
    }),
  );
}
