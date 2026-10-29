import { createHash } from 'crypto';
import type { IExecuteFunctions } from 'n8n-workflow';
import {
  CompositionalCaptureReadRequestV3Schema,
  type CompositionalCaptureReadRequestV3,
} from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../schemas/CompositionalAutomaticCaptureV3.schema';

export type NativeCompositionalProcessingDomainV3 = Omit<
  CompositionalCaptureReadRequestV3,
  'version' | 'role'
>;

/** Attempt provenance from the native execution, never stable source identity. */
export function nativeCompositionalProcessingAttemptHashV3(
  ctx: Pick<IExecuteFunctions, 'getWorkflow' | 'getExecutionId' | 'getInstanceId'>,
  domainValue: unknown,
): string {
  try {
    const copy = cloneBoundedAutomaticCaptureJson<Record<string, unknown>>(
      domainValue,
      'beginRequest',
    );
    if (
      copy === null ||
      typeof copy !== 'object' ||
      Array.isArray(copy) ||
      Object.keys(copy).sort().join(',') !== 'actorReference,issuer,namespace,turn'
    )
      throw new Error('invalid');
    const domain = CompositionalCaptureReadRequestV3Schema.parse({
      ...copy,
      version: 3,
      role: 'human',
    });
    const execution = ctx.getExecutionId();
    const workflow = ctx.getWorkflow().id ?? null;
    const instance = ctx.getInstanceId();
    if (
      typeof execution !== 'string' ||
      !execution.trim() ||
      execution.length > 512 ||
      typeof instance !== 'string' ||
      !instance.trim() ||
      instance.length > 512 ||
      (workflow !== null &&
        (typeof workflow !== 'string' || !workflow.trim() || workflow.length > 512))
    )
      throw new Error('invalid');
    return createHash('sha256')
      .update(
        canonicalAutomaticCaptureV2({
          domain: 'engram-native-human-processing-v3',
          instance,
          workflow,
          execution,
          namespace: domain.namespace,
          issuer: domain.issuer,
          actorReference: domain.actorReference,
          turn: domain.turn,
        }),
        'utf8',
      )
      .digest('hex');
  } catch {
    throw new Error('Engram compositional memory: processing_attempt_required');
  }
}

/** Provenance comparison only; source/current authority still require actual-store validation. */
export function matchesNativeCompositionalOriginalAttemptV3(
  operationValue: unknown,
  expectedHash: unknown,
): boolean {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  try {
    const operation = CompositionalAutomaticCaptureOperationV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(operationValue, 'beginRequest'),
    );
    if (operation.state !== 'committed' || operation.generation !== 1) return false;
    const initial = operation.attempts[0];
    return (
      initial?.disposition === 'claim_won' &&
      initial.attemptHash === expectedHash &&
      initial.at === operation.createdAt &&
      operation.attempts.filter((attempt) => attempt.disposition === 'claim_won').length === 1
    );
  } catch {
    return false;
  }
}
