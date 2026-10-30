import { performance } from 'perf_hooks';
import { types } from 'util';
import { SourceHydrationBudgetSchema } from '../schemas/ExtractionPolicy.schema';
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

export type AutomaticClaimReadScopeConfigurationReason =
  | 'invalid_budget'
  | 'invalid_deadline'
  | 'scope_configuration_conflict';

const CONFIGURATION_MESSAGES: Readonly<Record<AutomaticClaimReadScopeConfigurationReason, string>> =
  {
    invalid_budget: 'Automatic claim read scope budget is invalid',
    invalid_deadline: 'Automatic claim read scope deadline is invalid',
    scope_configuration_conflict: 'Automatic claim read scope configuration conflicts',
  };

/** Bounded configuration failure; never carries caller-provided data. */
export class AutomaticClaimReadScopeConfigurationError extends Error {
  readonly reason: AutomaticClaimReadScopeConfigurationReason;

  constructor(reason: AutomaticClaimReadScopeConfigurationReason) {
    super(CONFIGURATION_MESSAGES[reason]);
    this.name = 'AutomaticClaimReadScopeConfigurationError';
    this.reason = reason;
  }
}

const scopeByBudget = new WeakMap<SourceHydrationBudget, AutomaticClaimReadScope>();
const stateByScope = new WeakMap<object, ScopeState>();
/** Budgets registered through the explicit-deadline factory, with their absolute deadline. */
const configuredDeadlineByBudget = new WeakMap<object, number>();

function stateFor(scope: unknown): ScopeState | undefined {
  if (scope === null || typeof scope !== 'object') return undefined;
  return stateByScope.get(scope);
}

function createScope(budget: SourceHydrationBudget, deadlineAt: number): AutomaticClaimReadScope {
  const scope = Object.freeze(Object.create(null)) as AutomaticClaimReadScope;
  const state: ScopeState = {
    budget,
    deadlineAt,
    attemptsRemaining: MAX_ATTEMPTS,
    contextBytesRemaining: MAX_CONTEXT_BYTES,
    snapshotBytesRemaining: MAX_SNAPSHOT_BYTES,
  };
  scopeByBudget.set(budget, scope);
  stateByScope.set(scope as object, state);
  return scope;
}

/** Reads only own writable data descriptors; never invokes traps, getters or setters. */
function isValidConfiguredBudget(budget: unknown): budget is SourceHydrationBudget {
  if (budget === null || typeof budget !== 'object') return false;
  if (types.isProxy(budget)) return false;
  const prototype = Object.getPrototypeOf(budget);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.isFrozen(budget)) return false;
  const remaining = Object.getOwnPropertyDescriptor(budget, 'remaining');
  const deferred = Object.getOwnPropertyDescriptor(budget, 'deferred');
  if (!remaining || !deferred) return false;
  for (const descriptor of [remaining, deferred]) {
    if (!('value' in descriptor) || descriptor.writable !== true) return false;
  }
  // Primitive check precedes Zod so nested objects/proxies are never inspected (e.g. `then`).
  if (typeof remaining.value !== 'number' || typeof deferred.value !== 'number') return false;
  return SourceHydrationBudgetSchema.safeParse({
    remaining: remaining.value,
    deferred: deferred.value,
  }).success;
}

/**
 * Returns the same private token for every call using the same budget object.
 * Budgets registered through the explicit-deadline factory are rejected here.
 */
export function getAutomaticClaimReadScope(budget: SourceHydrationBudget): AutomaticClaimReadScope {
  const existing = scopeByBudget.get(budget);
  if (existing) {
    if (configuredDeadlineByBudget.has(budget)) {
      throw new AutomaticClaimReadScopeConfigurationError('scope_configuration_conflict');
    }
    return existing;
  }
  return createScope(budget, performance.now() + READ_WINDOW_MS);
}

/**
 * Returns the private token for a budget with an explicit absolute monotonic deadline
 * (same timebase as performance.now()). The deadline is never rebased by the clock; a
 * past deadline yields an already-expired scope. The same budget object only maps to
 * one scope and one deadline.
 */
export function getAutomaticClaimReadScopeWithAbsoluteDeadline(
  budget: SourceHydrationBudget,
  deadlineAt: number,
): AutomaticClaimReadScope {
  if (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt)) {
    throw new AutomaticClaimReadScopeConfigurationError('invalid_deadline');
  }
  if (!isValidConfiguredBudget(budget)) {
    throw new AutomaticClaimReadScopeConfigurationError('invalid_budget');
  }
  const existing = scopeByBudget.get(budget);
  if (existing) {
    if (configuredDeadlineByBudget.get(budget) !== deadlineAt) {
      throw new AutomaticClaimReadScopeConfigurationError('scope_configuration_conflict');
    }
    return existing;
  }
  const scope = createScope(budget, deadlineAt);
  configuredDeadlineByBudget.set(budget, deadlineAt);
  return scope;
}

/** Checks the exact existing private scope/budget association without creating or resetting it. */
export function isAutomaticClaimReadScopeForBudget(
  scope: unknown,
  budget: SourceHydrationBudget,
): scope is AutomaticClaimReadScope {
  const state = stateFor(scope);
  return state !== undefined && state.budget === budget && scopeByBudget.get(budget) === scope;
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
