import { performance } from 'perf_hooks';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';

const READ_WINDOW_MS = 5_000;
const MAX_ATTEMPTS = 128;
const MAX_CONTEXT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const SOURCE_HYDRATIONS_PER_ATTEMPT = 4;

declare const scopeBrand: unique symbol;
/** Opaque in-process read token. Runtime instances have no enumerable fields. */
export type AutomaticClaimReadScope = Readonly<{ [scopeBrand]: true }>;

export interface AutomaticClaimReadScopeRemaining {
  readonly attemptsRemaining: number;
  readonly contextBytesRemaining: number;
  readonly snapshotBytesRemaining: number;
  readonly sourceHydrationsRemaining: number;
  readonly deadlineRemainingMs: number;
}

interface ScopeState {
  readonly budget: SourceHydrationBudget;
  readonly deadlineAt: number;
  attemptsRemaining: number;
  contextBytesRemaining: number;
  snapshotBytesRemaining: number;
}

const scopeByBudget = new WeakMap<SourceHydrationBudget, AutomaticClaimReadScope>();
const stateByScope = new WeakMap<object, ScopeState>();

function stateFor(scope: unknown): ScopeState | undefined {
  if (scope === null || typeof scope !== 'object') return undefined;
  return stateByScope.get(scope);
}

/** Returns the same private token for every call using the same budget object. */
export function getAutomaticClaimReadScope(budget: SourceHydrationBudget): AutomaticClaimReadScope {
  const existing = scopeByBudget.get(budget);
  if (existing) return existing;
  const scope = Object.freeze(Object.create(null)) as AutomaticClaimReadScope;
  const state: ScopeState = {
    budget,
    deadlineAt: performance.now() + READ_WINDOW_MS,
    attemptsRemaining: MAX_ATTEMPTS,
    contextBytesRemaining: MAX_CONTEXT_BYTES,
    snapshotBytesRemaining: MAX_SNAPSHOT_BYTES,
  };
  scopeByBudget.set(budget, scope);
  stateByScope.set(scope as object, state);
  return scope;
}

/** Reserves one backend attempt and four shared source hydrations before I/O. */
export function beginAutomaticClaimReadAttempt(scope: AutomaticClaimReadScope): boolean {
  const state = stateFor(scope);
  if (
    !state ||
    performance.now() >= state.deadlineAt ||
    state.attemptsRemaining < 1 ||
    !Number.isInteger(state.budget.remaining) ||
    state.budget.remaining < SOURCE_HYDRATIONS_PER_ATTEMPT
  ) {
    return false;
  }
  state.attemptsRemaining -= 1;
  state.budget.remaining -= SOURCE_HYDRATIONS_PER_ATTEMPT;
  return true;
}

/** Reserves bytes from an opened snapshot's own stat before reading it. */
export function reserveAutomaticClaimSnapshotBytes(
  scope: AutomaticClaimReadScope,
  bytes: number,
): boolean {
  const state = stateFor(scope);
  if (
    !state ||
    performance.now() >= state.deadlineAt ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > state.snapshotBytesRemaining
  ) {
    return false;
  }
  state.snapshotBytesRemaining -= bytes;
  return true;
}

/** Charges serialized context bytes before any complete proof context is returned. */
export function chargeAutomaticClaimContextBytes(
  scope: AutomaticClaimReadScope,
  bytes: number,
): boolean {
  const state = stateFor(scope);
  if (
    !state ||
    performance.now() >= state.deadlineAt ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > state.contextBytesRemaining
  ) {
    return false;
  }
  state.contextBytesRemaining -= bytes;
  return true;
}

/** Checks only token registration and the shared monotonic deadline. */
export function canUseAutomaticClaimReadScope(scope: AutomaticClaimReadScope): boolean {
  const state = stateFor(scope);
  return state !== undefined && performance.now() < state.deadlineAt;
}

/** A snapshot of remaining shared resources, or null for an unregistered token. */
export function getAutomaticClaimReadScopeRemaining(
  scope: AutomaticClaimReadScope,
): Readonly<AutomaticClaimReadScopeRemaining> | null {
  const state = stateFor(scope);
  if (!state) return null;
  return Object.freeze({
    attemptsRemaining: state.attemptsRemaining,
    contextBytesRemaining: state.contextBytesRemaining,
    snapshotBytesRemaining: state.snapshotBytesRemaining,
    sourceHydrationsRemaining: state.budget.remaining,
    deadlineRemainingMs: Math.max(0, state.deadlineAt - performance.now()),
  });
}
