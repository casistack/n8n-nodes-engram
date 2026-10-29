import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import type {
  AutonomousPersonalCompletionPlanV4,
  AutonomousPersonalCompletionPlanV4Input,
} from '../schemas/AutonomousPersonalCompletionPlanV4.schema';
import { compileAutonomousPersonalDescriptorV4 } from '../schemas/AutonomousPersonalDescriptorV4.schema';
import { hashAutonomousPersonalDescriptorV4 } from '../schemas/AutonomousPersonalDescriptorV4.schema';

function same(left: unknown, right: unknown): boolean {
  return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
}

export function outcomeAndReceiptJoinV4(
  input: AutonomousPersonalCompletionPlanV4Input,
  plan: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>,
): boolean {
  const receipt = plan.operation.terminalReceipt;
  switch (input.outcome.kind) {
    case 'response':
      if (receipt.kind === 'human_autonomous_capture_committed') return true;
      if (receipt.kind === 'human_autonomous_source_verdict_committed')
        return receipt.selection.outcome !== 'policy_not_selected';
      return (
        receipt.kind === 'human_autonomous_source_deferred_committed' &&
        receipt.selection.reason === 'interpretation_capacity'
      );
    case 'deferred':
      return (
        receipt.kind === 'human_autonomous_source_deferred_committed' &&
        receipt.selection.reason === input.outcome.reason
      );
    case 'no_dispatch':
      switch (input.outcome.reason) {
        case 'empty_source':
          return (
            receipt.kind === 'human_autonomous_source_verdict_committed' &&
            receipt.selection.outcome === 'known_no_memory'
          );
        case 'policy_not_selected':
          return (
            receipt.kind === 'human_autonomous_source_verdict_committed' &&
            receipt.selection.outcome === 'policy_not_selected'
          );
        case 'source_indeterminate':
          return (
            receipt.kind === 'human_autonomous_source_verdict_committed' &&
            receipt.selection.outcome === 'unknown_source'
          );
        case 'source_resource':
        case 'unit_count':
        case 'typed_metadata':
        case 'aggregate':
          return (
            receipt.kind === 'human_autonomous_source_deferred_committed' &&
            receipt.selection.reason === 'interpretation_capacity'
          );
      }
  }
}

export function inputAndPlanJoinV4(
  input: AutonomousPersonalCompletionPlanV4Input,
  plan: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>,
  check: () => void,
  requireAuditWitness = false,
): boolean {
  const scope = input.scope;
  const staged = input.stagedFresh;
  const leased = staged.operation;
  const terminal = plan.operation;
  const receipt = terminal.terminalReceipt;
  if (leased.version !== 4 || leased.state !== 'leased') return false;
  if (!outcomeAndReceiptJoinV4(input, plan)) return false;

  let compiledDescriptor;
  try {
    compiledDescriptor = compileAutonomousPersonalDescriptorV4(scope.request.settings);
  } catch {
    return false;
  }
  check();

  const identity = leased.identity;
  const fence = staged.fence;
  const context = scope.context;
  const request = scope.request;
  const firstAttempt = leased.attempts[0];
  if (
    request.namespace !== context.namespace ||
    request.issuer !== context.issuer ||
    request.actorReference !== context.actorReference ||
    request.turn !== context.turn ||
    context.namespace !== identity.namespace ||
    context.issuer !== identity.issuer ||
    context.actorReference !== identity.actorReference ||
    context.turn !== identity.turn ||
    context.storeHash !== identity.storeHash ||
    !same(context.binding, identity.binding) ||
    identity.role !== 'human' ||
    identity.purpose !== 'human_turn_memory' ||
    scope.sourceId !== staged.episode.uuid ||
    scope.sourceId !== identity.sourceId ||
    scope.sourceId !== fence.sourceId ||
    scope.operationId !== leased.operationId ||
    scope.operationId !== fence.operationId ||
    scope.leaseToken !== leased.lease.token ||
    scope.leaseToken !== fence.token ||
    scope.stableBeginHash !== leased.beginCallHash ||
    scope.attemptHash !== firstAttempt?.attemptHash ||
    scope.request.purpose !== 'human_turn_memory' ||
    staged.episode.group_id !== context.namespace ||
    !same(scope.descriptor, compiledDescriptor) ||
    !same(scope.descriptor, leased.descriptor) ||
    !same(terminal.identity, identity) ||
    !same(terminal.descriptor, leased.descriptor) ||
    terminal.version !== 4 ||
    terminal.state !== 'committed' ||
    terminal.generation !== leased.generation ||
    terminal.operationId !== scope.operationId ||
    terminal.createdAt !== leased.createdAt ||
    terminal.beginCallHash !== leased.beginCallHash ||
    terminal.completionCallHash !== input.completionCallHash ||
    terminal.lastObservedAt !== input.backendNow ||
    receipt.operationId !== scope.operationId ||
    receipt.sourceId !== scope.sourceId ||
    receipt.sourceHash !== identity.sourceHash ||
    receipt.descriptorHash !== identity.descriptorHash ||
    receipt.policyFingerprint !== identity.policyFingerprint ||
    receipt.terminalAt !== input.backendNow ||
    input.audit.action !== 'completion' ||
    input.audit.operationId !== scope.operationId ||
    input.audit.sourceId !== scope.sourceId ||
    input.audit.operationId !== terminal.operationId ||
    input.audit.sourceId !== terminal.identity.sourceId ||
    fence.version !== 4 ||
    fence.purpose !== 'human_turn_memory' ||
    fence.descriptorHash !== identity.descriptorHash ||
    fence.identityHash !== hashAutomaticCaptureV2(identity) ||
    fence.sourceHash !== identity.sourceHash ||
    fence.beginCallHash !== leased.beginCallHash ||
    fence.state !== 'leased' ||
    fence.generation !== leased.generation ||
    fence.claimKind !== 'initial' ||
    fence.retryCount !== leased.retryCount ||
    fence.planTimestamp !== leased.lease.renewedAt ||
    hashAutonomousPersonalDescriptorV4(scope.descriptor) !== identity.descriptorHash ||
    leased.generation !== 1 ||
    leased.retryCount !== 0 ||
    leased.lease.claimKind !== 'initial' ||
    firstAttempt?.disposition !== 'claim_won' ||
    firstAttempt.at !== leased.createdAt ||
    leased.lastRetryCallHash !== undefined
  ) {
    return false;
  }

  const stagedAttempts = leased.attempts;
  if (terminal.attempts.length < stagedAttempts.length) return false;
  for (let index = 0; index < terminal.attempts.length; index += 1) {
    check();
    const actual = terminal.attempts[index];
    if (index < stagedAttempts.length && !same(actual, stagedAttempts[index])) return false;
    if (index > 0 && actual?.disposition === 'claim_won') return false;
  }
  if (terminal.overflowCount < leased.overflowCount) return false;
  if (leased.auditTruncated === true && terminal.auditTruncated !== true) return false;

  let completionAuditAttempts = 0;
  for (const attempt of terminal.attempts) {
    check();
    if (attempt.attemptHash !== input.audit.attemptIdHash) continue;
    completionAuditAttempts += 1;
    if (attempt.disposition !== 'committed' || attempt.at !== receipt.terminalAt) return false;
  }
  // A truncated operation does not retain the caller audit hash, so readback
  // cannot prove that input-to-terminal join from DATA alone.
  return (
    completionAuditAttempts === 1 || (!requireAuditWitness && terminal.auditTruncated === true)
  );
}
