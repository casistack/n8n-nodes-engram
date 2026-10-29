import { performance } from 'perf_hooks';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  AutomaticCaptureBeginRequestV2Schema,
  hashAutomaticCaptureV2,
  type AutomaticCaptureBeginRequestV2,
} from '../schemas/AutomaticCapture.schema';
import {
  AutomaticCapturePublicResultV2Schema,
  type AutomaticCapturePublicResultV2,
} from '../schemas/AutomaticCaptureApi.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { planAutomaticClaims } from '../extraction/AutomaticClaims';
import { ExtractionBudgetError, ExtractionDiagnostics } from '../extraction/ExtractionDiagnostics';

/** Internal native coordinator. Never accepts a result, policy, handle or processing flag as input. */
export async function captureReplaySafeHumanMemory(
  storage: IGraphStorage,
  input: AutomaticCaptureBeginRequestV2,
): Promise<AutomaticCapturePublicResultV2> {
  const stopped = (
    status: AutomaticCapturePublicResultV2['status'],
    sourcePersistence: AutomaticCapturePublicResultV2['sourcePersistence'] = 'unknown',
  ): AutomaticCapturePublicResultV2 =>
    AutomaticCapturePublicResultV2Schema.parse({
      version: 2,
      purpose: null,
      status,
      sourceId: null,
      sourcePersistence,
      should_process: false,
      currentAuthority: 'not_evaluated',
      receiptSummary: null,
    });
  let request: AutomaticCaptureBeginRequestV2;
  try {
    request = AutomaticCaptureBeginRequestV2Schema.parse(
      cloneBoundedAutomaticCaptureJson(input, 'beginRequest'),
    );
  } catch {
    return stopped('invalid_input', 'not_persisted');
  }
  if (
    request.purpose !== 'human_turn_memory' ||
    !storage.beginAndClaimAutomaticCaptureV2 ||
    !storage.completeHumanCaptureV2 ||
    !storage.readExtractionSnapshot
  )
    return stopped('unsupported_mode');
  const expires = performance.now() + request.settings.invocationDeadlineMs;
  const check = () => {
    if (performance.now() >= expires) throw new ExtractionBudgetError('deadline');
  };
  try {
    check();
    const begin = await storage.beginAndClaimAutomaticCaptureV2(request, 'existingStore');
    check();
    if (begin.kind !== 'claimed') {
      if (begin.kind === 'capacity') return stopped('capacity', begin.sourcePersistence);
      if (begin.kind === 'invalid_input') return stopped('invalid_input', 'not_persisted');
      if (begin.kind === 'conflict') return stopped('conflict');
      // Inspection can describe a durable historical result, but cannot turn a replay into permission.
      if (
        storage.getAutomaticCaptureOutcomeV2 &&
        [
          'committed_replay',
          'cancelled_replay',
          'legacy_unconfirmed',
          'source_only_unconfirmed',
          'in_progress',
          'resume_available',
        ].includes(begin.kind)
      ) {
        const result = await storage.getAutomaticCaptureOutcomeV2({
          version: 2,
          namespace: request.namespace,
          issuer: request.issuer,
          actorReference: request.actorReference,
          turn: request.turn,
          role: 'human',
        });
        check();
        if (result.should_process) return stopped('failed');
        return AutomaticCapturePublicResultV2Schema.parse(result);
      }
      return stopped(
        begin.kind === 'cancelled_replay'
          ? 'cancelled'
          : begin.kind === 'committed_replay'
            ? 'failed'
            : begin.kind,
      );
    }
    if (begin.purpose !== 'human_turn_memory') return stopped('unsupported_mode');
    let handle = begin.leaseHandle;
    for (let attempt = 0; attempt < 4; attempt++) {
      check();
      const graph = await storage.readExtractionSnapshot(request.namespace);
      check();
      const operation = graph.automatic_operations_v1?.operations.find(
        (item) => item.operationId === begin.operationId,
      );
      if (
        operation?.version !== 2 ||
        operation.state !== 'leased' ||
        operation.descriptor.purpose !== 'human_turn_memory' ||
        operation.identity.sourceId !== begin.sourceId ||
        hashAutomaticCaptureV2(operation.descriptor) !== begin.descriptorHash ||
        operation.generation !== 1 ||
        operation.lease.claimKind !== 'initial'
      )
        return stopped('failed');
      const outcome = new ExtractionDiagnostics().finish();
      outcome.status = 'succeeded';
      const plan = planAutomaticClaims(
        graph,
        request.namespace,
        [begin.sourceId],
        operation.descriptor.policy,
        outcome,
        operation.lease.renewedAt,
        check,
      );
      check();
      const completed = await storage.completeHumanCaptureV2(handle, plan);
      check();
      if (completed.kind === 'graph_conflict_retry') {
        handle = completed.retryHandle;
        continue;
      }
      if (
        completed.kind !== 'committed' ||
        completed.terminalReceipt.kind !== 'human_capture_committed'
      )
        return stopped('failed');
      const terminal = completed.terminalReceipt;
      const itemCounts = {
        accepted: 0,
        proposed: 0,
        rejected: 0,
        deferred: 0,
        not_selected: 0,
        unchanged: 0,
      };
      for (const item of terminal.receipt.items) itemCounts[item.state]++;
      return AutomaticCapturePublicResultV2Schema.parse({
        version: 2,
        purpose: 'human_turn_memory',
        status: completed.eligibleFirstCommit ? 'first_capture_committed' : 'committed_replay',
        sourceId: begin.sourceId,
        sourcePersistence: 'persisted',
        should_process: completed.eligibleFirstCommit,
        currentAuthority: completed.currentAuthority,
        receiptSummary: {
          persisted: terminal.receipt.persisted,
          commitAt: terminal.receipt.commitAt,
          receiptInspectionComplete: terminal.receiptInspectionComplete,
          interpretationCoverage: terminal.interpretationCoverage,
          acceptedCoverage: terminal.acceptedCoverage,
          itemCounts,
        },
      });
    }
  } catch {
    // A timeout or uncertain write never causes another begin, completion, Agent or provider call.
  }
  return stopped('failed');
}
