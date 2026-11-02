import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { extractionMetadataFromAttributes } from '../schemas/ExtractionMetadata.schema';
import type { AutonomousPersonalNativeMemoryConfigV4 } from '../schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalNativeOriginV4 } from '../schemas/AutonomousPersonalNativeOriginV4.schema';
import {
  AutonomousPersonalMemoryParentReaderV4ReasonSchema,
  type AutonomousPersonalMemoryParentReaderV4Reason,
} from '../schemas/AutonomousPersonalMemoryParentReaderV4.schema';
import { compileAutonomousPersonalDescriptorV4 } from '../schemas/AutonomousPersonalDescriptorV4.schema';
import { AutonomousPersonalOperationV4OwnedDataSchema } from '../schemas/AutonomousPersonalOperationV4.schema';
import { reconstructAutonomousPersonalStoredSourceIdentityV4 } from '../schemas/AutonomousPersonalSourceV4.schema';
import type { GraphData } from '../schemas/GraphData.schema';
import { findAutomaticBinding } from './AutomaticIdentity';

export class AutonomousPersonalMemoryParentIntegrityV4Error extends Error {
  readonly reason: AutonomousPersonalMemoryParentReaderV4Reason;

  constructor(reason: AutonomousPersonalMemoryParentReaderV4Reason) {
    const parsedReason = AutonomousPersonalMemoryParentReaderV4ReasonSchema.safeParse(reason);
    super('Engram autonomous personal parent integrity failed');
    this.name = 'AutonomousPersonalMemoryParentIntegrityV4Error';
    this.reason = parsedReason.success ? parsedReason.data : 'invalid_snapshot';
    Object.freeze(this);
  }
}

interface StickyCheck {
  readonly check: () => void;
  readonly rethrowFailure: () => void;
}

function stickyCheck(callback: () => void): StickyCheck {
  let failed = false;
  let failure: unknown;
  const check = () => {
    if (failed) throw failure;
    try {
      callback();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
  return {
    check,
    rethrowFailure: () => {
      if (failed) throw failure;
    },
  };
}

function reject(reason: AutonomousPersonalMemoryParentReaderV4Reason): never {
  throw new AutonomousPersonalMemoryParentIntegrityV4Error(reason);
}

function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
  } catch {
    return false;
  }
}

/**
 * Assert the actual current V4 parent joins on a complete graph already owned and checked by
 * the caller. This helper performs no I/O, indexing, graph copy, lineage authentication, or
 * authority issuance. ParentReader callers must keep their B1b index and source-integrity
 * checks on this same graph before invoking it.
 */
export function assertAutonomousPersonalMemoryCurrentParentGraphV4(
  graph: GraphData,
  origin: AutonomousPersonalNativeOriginV4,
  config: AutonomousPersonalNativeMemoryConfigV4,
  backendNow: string,
  trustedCheck: () => void,
): void {
  const trusted = stickyCheck(trustedCheck);
  try {
    // 4. Locate the single parent source and Operation4.
    const sourceId = origin.identity.sourceId;
    const operationId = origin.terminalReceipt.operationId;
    const sources: GraphData['episodes'] = [];
    for (const episode of graph.episodes) {
      trusted.check();
      if (episode.uuid === sourceId) sources.push(episode);
    }
    trusted.check();
    const operations = graph.automatic_operations_v1?.operations ?? [];
    const byId: Array<(typeof operations)[number]> = [];
    const bySource: Array<(typeof operations)[number]> = [];
    for (const candidate of operations) {
      trusted.check();
      if (candidate.operationId === operationId) byId.push(candidate);
      if (candidate.identity.sourceId === sourceId) bySource.push(candidate);
    }
    trusted.check();
    if (sources.length === 0 && byId.length === 0 && bySource.length === 0) {
      return reject('parent_not_found');
    }
    if (sources.length !== 1 || byId.length !== 1 || bySource.length !== 1) {
      return reject('invalid_snapshot');
    }
    const source = sources[0]!;
    const storedOperation = byId[0]!;
    if (storedOperation !== bySource[0] || storedOperation.version !== 4) {
      return reject('parent_mismatch');
    }
    const parsedOperation = AutonomousPersonalOperationV4OwnedDataSchema.safeParse(storedOperation);
    if (!parsedOperation.success) return reject('invalid_snapshot');
    const operation = parsedOperation.data;
    if (
      operation.state !== 'committed' ||
      operation.generation !== 1 ||
      operation.retryCount !== 0 ||
      operation.lastRetryCallHash !== undefined ||
      operation.lastResumeCause !== undefined
    ) {
      return reject('parent_mismatch');
    }
    const firstAttempt = operation.attempts[0];
    let claimsWon = 0;
    for (const attempt of operation.attempts) {
      trusted.check();
      if (attempt.disposition === 'claim_won') claimsWon += 1;
    }
    if (
      !firstAttempt ||
      firstAttempt.disposition !== 'claim_won' ||
      firstAttempt.attemptHash !== origin.attemptHash ||
      firstAttempt.at !== operation.createdAt ||
      operation.createdAt !== source.created_at ||
      claimsWon !== 1 ||
      source.source_execution_id !== origin.execution
    ) {
      return reject('parent_mismatch');
    }
    trusted.check();

    // 5. Strict stored-source / descriptor / identity / receipt joins.
    let reconstructed: ReturnType<typeof reconstructAutonomousPersonalStoredSourceIdentityV4>;
    try {
      reconstructed = reconstructAutonomousPersonalStoredSourceIdentityV4({
        source,
        descriptor: operation.descriptor,
      });
    } catch {
      trusted.rethrowFailure();
      return reject('invalid_snapshot');
    }
    trusted.check();
    if (
      !same(reconstructed.tuple.identity, operation.identity) ||
      !same(reconstructed.tuple.identity, origin.identity) ||
      !same(operation.terminalReceipt, origin.terminalReceipt) ||
      operation.completionCallHash !== origin.completionCallHash
    ) {
      return reject('parent_mismatch');
    }

    let currentDescriptor: ReturnType<typeof compileAutonomousPersonalDescriptorV4>;
    try {
      currentDescriptor = compileAutonomousPersonalDescriptorV4({
        profileId: config.profileId,
        requestedTrustLevel: 'standard',
        intentSetting: config.explicitIntent,
        invocationDeadlineMs: config.invocationDeadlineMs,
        ...(config.executionBudget === undefined
          ? {}
          : { executionBudget: config.executionBudget }),
        ...(config.statementContext === undefined
          ? {}
          : { statementContext: config.statementContext }),
        providerReference: config.providerReference,
      });
    } catch {
      trusted.rethrowFailure();
      return reject('invalid_configuration');
    }
    if (!same(operation.descriptor, currentDescriptor)) return reject('authority_changed');

    // The committed row has no lease; only monotonic backend time is required.
    const now = Date.parse(backendNow);
    if (
      !Number.isFinite(now) ||
      now < Date.parse(operation.lastObservedAt) ||
      now < Date.parse(operation.terminalReceipt.terminalAt)
    ) {
      return reject('clock_regression');
    }

    // 6. Current authority: source review/trust, active binding, accepted subject.
    if (
      source.review_status !== 'accepted' ||
      source.trust_level !== operation.descriptor.requestedTrustLevel
    ) {
      return reject('authority_changed');
    }
    const binding = findAutomaticBinding(
      graph,
      config.namespace,
      config.issuer,
      config.actorReference,
      trusted.check,
    );
    trusted.check();
    const expected = origin.identity.binding;
    if (
      !binding ||
      binding.state !== 'active' ||
      binding.bindingId !== expected.bindingId ||
      binding.revision !== expected.revision ||
      binding.subjectId !== expected.subjectId ||
      binding.fingerprint !== expected.fingerprint
    ) {
      return reject('authority_changed');
    }
    const subjects: GraphData['entities'] = [];
    for (const entity of graph.entities) {
      trusted.check();
      if (entity.uuid === binding.subjectId) subjects.push(entity);
    }
    trusted.check();
    const subject = subjects[0];
    if (
      subjects.length !== 1 ||
      !subject ||
      subject.group_id !== config.namespace ||
      extractionMetadataFromAttributes(subject.attributes)?.review_status !== 'accepted'
    ) {
      return reject('authority_changed');
    }

    // 7. Current raw human query against the original stored source and geometry.
    const geometry = reconstructed.tuple.envelope.geometry;
    const mapping = config.sourceMapping;
    const query = config.currentHumanQuery;
    if (geometry.mode !== mapping.mode || !same(geometry.quoteRegions, config.quoteRegions)) {
      return reject('parent_mismatch');
    }
    if (mapping.mode === 'full_body') {
      if (query !== source.content) return reject('parent_mismatch');
    } else {
      const region = geometry.humanRegion;
      if (
        !region ||
        region.start !== mapping.humanRegion.start ||
        region.end !== mapping.humanRegion.end ||
        config.rawHumanContent !== query ||
        source.content.slice(region.start, region.end) !== query
      ) {
        return reject('parent_mismatch');
      }
    }
  } catch (error) {
    trusted.rethrowFailure();
    if (error instanceof AutonomousPersonalMemoryParentIntegrityV4Error) throw error;
    return reject('invalid_snapshot');
  }
}
