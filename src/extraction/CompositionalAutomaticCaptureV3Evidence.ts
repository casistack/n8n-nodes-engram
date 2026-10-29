import { z } from 'zod';
import { interpretCompositionalPreferencesV2WithExecutionReport } from './CompositionalPreferenceV2Parser';
import { AutomaticSourceEnvelopeSchema } from '../schemas/AutomaticMemory.schema';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  CompositionalPreferenceV2Schema,
  snapshotBoundedCompositionalJson,
} from '../schemas/CompositionalPreferenceV2.schema';
import {
  CompositionalAutomaticCaptureInterpretationEvidenceV3Schema,
  type CompositionalAutomaticCaptureInterpretationEvidenceV3,
} from '../schemas/CompositionalAutomaticCaptureInterpretationEvidenceV3.schema';
import {
  CompositionalAutomaticCaptureEvidenceReportV3Schema,
  type CompositionalAutomaticCaptureEvidenceReportV3,
} from '../schemas/CompositionalAutomaticCaptureEvidenceReportV3.schema';
import {
  CompositionalAutomaticOperationIdentityV3Schema,
  compositionalCaptureInterpreterResultHashV3,
  reconcileCompositionalCaptureOperationIdentityV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { reconstructCompositionalAutomaticSourceIdentityV3 } from '../storage/CompositionalAutomaticCaptureSourceTupleV3';

function fail(code: string): never {
  throw new Error(`Engram compositional capture: ${code}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((nested) => deepFreeze(nested));
    Object.freeze(value);
  }
  return value;
}

function stickyCheck(check: () => void): () => void {
  let failed = false;
  let failure: unknown;
  return () => {
    if (failed) throw failure;
    try {
      check();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
}

function toSyntaxEnvelope(value: unknown): z.infer<typeof AutomaticSourceEnvelopeSchema> {
  const operational = value as Record<string, unknown>;
  const fields = { ...operational };
  delete fields.version;
  delete fields.policy;
  return AutomaticSourceEnvelopeSchema.parse({ version: 1, ...fields });
}

/**
 * Interpret the exact source bytes under the unchanged V2 syntax parser.
 * Returned evidence is reproducibility data only and does not grant admission.
 */
export function interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
  sourceValue: unknown,
  descriptorValue: unknown,
  capturedIdentityValue: unknown,
  check: () => void = () => {},
): CompositionalAutomaticCaptureEvidenceReportV3 {
  const checkSticky = stickyCheck(check);
  checkSticky();
  const snapshot = cloneBoundedAutomaticCaptureJson<{
    source: unknown;
    descriptor: unknown;
    capturedIdentity: unknown;
  }>(
    { source: sourceValue, descriptor: descriptorValue, capturedIdentity: capturedIdentityValue },
    'beginRequest',
  );
  checkSticky();

  const reconstructed = reconstructCompositionalAutomaticSourceIdentityV3(
    snapshot.source,
    snapshot.descriptor,
    checkSticky,
  );
  const capturedResult = CompositionalAutomaticOperationIdentityV3Schema.safeParse(
    snapshot.capturedIdentity,
  );
  if (!capturedResult.success) fail('identity_mismatch');
  const reconciledIdentity = reconcileCompositionalCaptureOperationIdentityV3(
    reconstructed.identity,
    capturedResult.data,
  );
  if (!reconciledIdentity) fail('identity_mismatch');

  checkSticky();
  const syntaxEnvelope = toSyntaxEnvelope(reconstructed.envelope.sourceEnvelope);
  const parserExecution = interpretCompositionalPreferencesV2WithExecutionReport({
    descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    rawContent: reconstructed.source.content,
    mappedContent: reconstructed.mappedContent,
    envelope: syntaxEnvelope,
    check: checkSticky,
  });
  // The parser can return a fixed result after an internal catch. A sticky
  // recheck ensures a swallowed budget/cancellation exception cannot mint data.
  checkSticky();

  let resultSnapshot: unknown;
  try {
    resultSnapshot = snapshotBoundedCompositionalJson(parserExecution.result, 32768);
  } catch {
    fail('result_capacity');
  }
  if (resultSnapshot === undefined) fail('result_capacity');
  const result = CompositionalPreferenceV2Schema.safeParse(resultSnapshot);
  if (!result.success) fail('invalid_interpreter_result');

  checkSticky();
  const interpreterResultHash = compositionalCaptureInterpreterResultHashV3(
    reconstructed.sourceId,
    reconciledIdentity.sourceHash,
    reconstructed.descriptorHash,
    result.data,
  );
  checkSticky();
  const evidence = CompositionalAutomaticCaptureInterpretationEvidenceV3Schema.parse({
    version: 3,
    kind: 'non_authoritative_interpretation_evidence',
    sourceId: reconstructed.sourceId,
    sourceHash: reconciledIdentity.sourceHash,
    descriptorHash: reconstructed.descriptorHash,
    interpreterResultHash,
    result: result.data,
  });
  checkSticky();
  const report = CompositionalAutomaticCaptureEvidenceReportV3Schema.parse({
    evidence,
    branch: parserExecution.branch,
  });
  checkSticky();
  const frozen = deepFreeze(report);
  checkSticky();
  return frozen;
}

/** Preserve the original evidence-only API and returned shape. */
export function interpretCompositionalHumanSourceV3Evidence(
  sourceValue: unknown,
  descriptorValue: unknown,
  capturedIdentityValue: unknown,
  check: () => void = () => {},
): CompositionalAutomaticCaptureInterpretationEvidenceV3 {
  return interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
    sourceValue,
    descriptorValue,
    capturedIdentityValue,
    check,
  ).evidence;
}
