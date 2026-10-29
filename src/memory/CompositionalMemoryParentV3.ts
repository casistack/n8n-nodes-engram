import {
  CompositionalMemoryParentExpectedV3Schema,
  CompositionalMemoryParentResultV3Schema,
  type CompositionalMemoryParentReasonV3,
  type CompositionalMemoryParentResultV3,
} from '../schemas/CompositionalMemoryParentV3.schema';
import {
  isLiveCompositionalRuntimeReaderV3,
  getCompositionalRuntimeParentDataV3,
} from '../search/CompositionalRuntimeReaderV3';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import {
  compileCompositionalAutomaticDescriptorV3,
  CompositionalAutomaticEnvelopeV2Schema,
} from '../schemas/CompositionalAutomaticMemory.schema';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  compositionalCaptureSourceContentHashV3,
  reconcileCompositionalCaptureOperationIdentityV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import { reconstructCompositionalAutomaticSourceIdentityV3 } from '../storage/CompositionalAutomaticCaptureSourceTupleV3';
import { extractionMetadataFromAttributes } from '../schemas/ExtractionMetadata.schema';
import { matchesNativeCompositionalOriginalAttemptV3 } from '../utils/nativeCompositionalProcessingV3';
import { captureEnvelope } from '../extraction/AutomaticEvidence';

class ParentReadExpired extends Error {}
const reject = (reason: CompositionalMemoryParentReasonV3): CompositionalMemoryParentResultV3 => ({
  status: 'rejected',
  reason,
});
const same = (a: unknown, b: unknown) => hashAutomaticCaptureV2(a) === hashAutomaticCaptureV2(b);
function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** Fixed actual-reader inspection. Returned observations cannot be supplied back as permission. */
export function validateCompositionalMemoryParentV3(
  reader: unknown,
  expectedValue: unknown,
): CompositionalMemoryParentResultV3 {
  // Authenticate before inspecting any caller configuration or source locator.
  if (!isLiveCompositionalRuntimeReaderV3(reader)) return reject('invalid_reader');
  let externalFailed = false;
  let externalFailure: unknown;
  const check = () => {
    try {
      if (!isLiveCompositionalRuntimeReaderV3(reader)) throw new ParentReadExpired();
    } catch (error) {
      if (!(error instanceof ParentReadExpired)) {
        externalFailed = true;
        externalFailure = error;
      }
      throw error;
    }
  };
  let expected;
  try {
    expected = CompositionalMemoryParentExpectedV3Schema.safeParse(
      cloneBoundedAutomaticCaptureJson(expectedValue, 'beginRequest'),
    );
  } catch {
    return reject('invalid_input');
  }
  try {
    check();
  } catch (error) {
    if (externalFailed) throw externalFailure;
    if (error instanceof ParentReadExpired) return reject('budget_exhausted');
    throw error;
  }
  if (
    !expected.success ||
    expected.data.runtime.profileId === 'existing' ||
    !expected.data.runtime.capturedSourceId
  )
    return reject('invalid_input');
  const cfg = expected.data;
  const runtime = cfg.runtime;
  // This fixed accessor performs its own scope/byte checks and preserves external abort identity.
  const actual = getCompositionalRuntimeParentDataV3(reader, {
    capturedSourceId: runtime.capturedSourceId,
    namespace: cfg.namespace,
    issuer: runtime.actor.issuer,
    actorReference: runtime.actor.actorReference,
    turn: runtime.turnId,
  });
  if (actual.status !== 'parent_data') {
    if (actual.reason === 'invalid_reader') return reject('invalid_reader');
    if (actual.reason === 'budget_exhausted') return reject('budget_exhausted');
    if (['resource_exhausted', 'capacity', 'context_too_large'].includes(actual.reason))
      return reject('resource_exhausted');
    if (actual.reason === 'unsupported_parent') return reject('unsupported_parent');
    if (['missing_source', 'missing_operation'].includes(actual.reason))
      return reject('parent_not_found');
    return reject('parent_mismatch');
  }
  try {
    check();
    const op = actual.operation;
    const source = actual.source;
    if (op.state !== 'committed') return reject('parent_uncommitted');
    const receipt = op.terminalReceipt;
    if (
      receipt.kind !== 'human_compositional_capture_committed' &&
      receipt.kind !== 'human_compositional_source_verdict_committed'
    )
      return reject('unsupported_parent');
    if (
      source.uuid !== runtime.capturedSourceId ||
      source.group_id !== cfg.namespace ||
      source.role !== 'human' ||
      source.episode_kind !== 'active_human' ||
      source.content !== cfg.currentHumanInput ||
      op.identity.sourceId !== source.uuid ||
      op.identity.storeHash !== runtime.storeIdentity ||
      op.identity.namespace !== cfg.namespace ||
      op.identity.issuer !== runtime.actor.issuer ||
      op.identity.actorReference !== runtime.actor.actorReference ||
      op.identity.turn !== runtime.turnId ||
      op.identity.role !== 'human' ||
      op.identity.purpose !== 'human_turn_memory'
    )
      return reject('parent_mismatch');
    if (
      Date.parse(actual.backendNow) < Date.parse(op.lastObservedAt) ||
      Date.parse(actual.backendNow) < Date.parse(receipt.terminalAt)
    )
      return reject('clock_regression');
    const profileId = runtime.profileId;
    if (profileId === 'existing') return reject('invalid_input');
    const descriptor = compileCompositionalAutomaticDescriptorV3({
      profileId,
      requestedTrustLevel: 'standard',
      intentSetting: runtime.explicitIntent,
      invocationDeadlineMs: cfg.invocationDeadlineMs,
    });
    if (!same(descriptor, op.descriptor)) return reject('policy_changed');
    const reconstructed = reconstructCompositionalAutomaticSourceIdentityV3(
      source,
      op.descriptor,
      check,
    );
    check();
    const capturedIdentity = reconcileCompositionalCaptureOperationIdentityV3(
      reconstructed.identity,
      op.identity,
    );
    if (
      !capturedIdentity ||
      !same(capturedIdentity, op.identity) ||
      !same(reconstructed.owner.binding, actual.capturedBinding)
    )
      return reject('parent_mismatch');
    const binding = actual.currentBinding;
    const captured = actual.capturedBinding;
    if (
      !binding ||
      binding.state !== 'active' ||
      binding.namespace !== cfg.namespace ||
      binding.issuer !== runtime.actor.issuer ||
      binding.actorReference !== runtime.actor.actorReference ||
      binding.bindingId !== captured.bindingId ||
      binding.revision !== captured.revision ||
      binding.subjectId !== captured.subjectId ||
      binding.fingerprint !== captured.fingerprint ||
      actual.subject.uuid !== captured.subjectId ||
      actual.subject.group_id !== cfg.namespace ||
      extractionMetadataFromAttributes(actual.subject.attributes)?.review_status !== 'accepted' ||
      source.review_status !== 'accepted' ||
      source.trust_level !== descriptor.requestedTrustLevel
    )
      return reject('authority_changed');
    const full = cfg.currentHumanInput;
    const wrapper = runtime.actor.applicationOwnedWrapper === true;
    if ((!wrapper && runtime.actor.humanRegion) || (wrapper && !runtime.rawHumanContent))
      return reject('parent_mismatch');
    const region = wrapper ? runtime.actor.humanRegion : { start: 0, end: full.length };
    if (!region || region.end > full.length) return reject('parent_mismatch');
    const mapped = full.slice(region.start, region.end);
    if ((runtime.rawHumanContent ?? full) !== mapped) return reject('parent_mismatch');
    const intent = captureEnvelope(mapped, full, runtime.actor, captured, runtime.explicitIntent);
    if (!intent.ok) return reject('parent_mismatch');
    const envelope = CompositionalAutomaticEnvelopeV2Schema.parse({
      version: 2,
      namespace: cfg.namespace,
      issuer: runtime.actor.issuer,
      actorReference: runtime.actor.actorReference,
      bindingRef: captured,
      contentHash: compositionalCaptureSourceContentHashV3(mapped),
      rawContentHash: compositionalCaptureSourceContentHashV3(full),
      mappingAuthority: wrapper ? 'application_region' : 'whole_source',
      humanRegion: region,
      mappings: [
        { contentStart: 0, contentEnd: mapped.length, rawStart: region.start, rawEnd: region.end },
      ],
      quoteRegions: runtime.actor.quoteRegions ?? [],
      explicitIntent: intent.envelope.explicitIntent,
      policy: descriptor.policy,
    });
    if (!same(envelope, reconstructed.envelope.sourceEnvelope)) return reject('parent_mismatch');
    if (!matchesNativeCompositionalOriginalAttemptV3(op, cfg.expectedHumanProcessingAttemptHash))
      return reject('processing_attempt_mismatch');
    check();
    const result = freezeData(
      CompositionalMemoryParentResultV3Schema.parse({
        status: 'valid_parent_data',
        sourceId: source.uuid,
        operationId: op.operationId,
        terminalReceipt: receipt,
      }),
    );
    check();
    return result;
  } catch (error) {
    if (externalFailed) throw externalFailure;
    if (error instanceof ParentReadExpired) return reject('budget_exhausted');
    return reject('parent_mismatch');
  }
}
