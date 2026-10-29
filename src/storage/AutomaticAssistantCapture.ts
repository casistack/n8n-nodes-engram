import { createHash } from 'crypto';
import { z } from 'zod';
import { captureEnvelope } from '../extraction/AutomaticEvidence';
import { AutomaticWriteOwnerSchema } from '../schemas/AutomaticClaim.schema';
import { AutomaticCaptureOperationV2Schema } from '../schemas/AutomaticCaptureOperation.schema';
import {
  AutomaticAssistantBuiltSourceV2Schema,
  AutomaticAssistantCaptureAuthorizationContextV2Schema,
  AutomaticAssistantCaptureAuthorizationDataV2Schema,
  AutomaticAssistantCaptureBeginInputV2Schema,
  AutomaticAssistantCaptureBeginPreparationV2Schema,
  AutomaticAssistantCaptureCompletionContextV2Schema,
  AutomaticAssistantCaptureCompletionPreparationV2Schema,
  AutomaticAssistantCaptureIntentV2Schema,
  AutomaticAssistantCompletionInvocationV2Schema,
  AutomaticAssistantFinalWriterResultV2Schema,
  AutomaticAssistantDescriptorBuildResultV2Schema,
  AutomaticAssistantDescriptorSettingsV2Schema,
  AutomaticAssistantSourceBuildV2Schema,
  type AutomaticAssistantBuiltSourceV2,
  type AutomaticAssistantCaptureAuthorizationDataV2,
  type AutomaticAssistantCaptureBeginInputV2,
  type AutomaticAssistantCaptureBeginPreparationV2,
  type AutomaticAssistantCaptureCompletionContextV2,
  type AutomaticAssistantCaptureCompletionPreparationV2,
  type AutomaticAssistantCaptureIntentV2,
  type AutomaticAssistantCompletionInvocationV2,
  type AutomaticAssistantDescriptorBuildResultV2,
  type AutomaticAssistantFinalWriterResultV2,
  type AutomaticAssistantSourceBuildV2,
} from '../schemas/AutomaticAssistantCapture.schema';
import { type AutomaticCaptureOperationV2 as Operation } from '../schemas/AutomaticCaptureOperation.schema';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  AutomaticOperationDescriptorV2Schema,
  automaticOperationDescriptorSettingsHashV2,
  canonicalAutomaticCaptureV2 as canonical,
  hashAutomaticCaptureV2,
  type AssistantWriteAuthorityReferenceV2,
  type AutomaticOperationDescriptorV2,
  type AutomaticOperationIdentityV2,
} from '../schemas/AutomaticCapture.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../schemas/AutomaticCaptureReceipt.schema';
import { AUTOMATIC_LEDGER_LIMITS as limits } from '../schemas/AutomaticLedgerPrimitives.schema';
import { AutomaticSourceEnvelopeSchema } from '../schemas/AutomaticMemory.schema';
import { EpisodicNodeSchema, type EpisodicNode, type GraphData } from '../schemas';
import {
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  reconcileCompositionalCaptureOperationIdentityV3,
  type CompositionalAutomaticCaptureOperationV3,
  type CompositionalAutomaticOperationIdentityV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticDescriptorV3Schema,
  hashCompositionalAutomaticDescriptorV3,
  type CompositionalAutomaticDescriptorV3,
} from '../schemas/CompositionalAutomaticMemory.schema';
import type {
  AutomaticCaptureHandleRegistry,
  AutomaticCaptureLeaseFenceV2,
  PrivateConsumedAutomaticCaptureInvocation,
  PrivateOneUseAutomaticLeaseHandle,
} from './AutomaticCaptureHandles';
import { AutomaticCaptureLeaseFenceV2Schema } from './AutomaticCaptureHandles';
import { validateAutomaticCaptureCandidate } from './AutomaticCaptureCapacity';
import { withAutomaticCaptureAttemptV2 } from './AutomaticCaptureAudit';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import {
  assertAutomaticBinding,
  assertAutomaticLedgerSourceIntegrity,
  automaticCaptureOperationIdentityForOwnedSource,
  automaticWriteOwnerIdempotencyKey,
  prepareAutomaticEpisodeInput,
  reconcileAutomaticCaptureOperationIdentity,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  assertAutomaticBindingIdentity,
  WRITE_OWNER_V2_ATTRIBUTE,
} from './AutomaticIdentity';
import { reconstructCompositionalAutomaticSourceIdentityV3 } from './CompositionalAutomaticCaptureSourceTupleV3';

declare const assistantAuthorizationBrand: unique symbol;
declare const consumedAssistantAuthorizationBrand: unique symbol;

/** Opaque internal token. It has no runtime fields and is never serialized. */
export type PrivateAutomaticAssistantWriteAuthorizationV2 = object & {
  readonly [assistantAuthorizationBrand]: true;
};

/** Distinct token after the one synchronous begin consumption. */
export type PrivateConsumedAutomaticAssistantWriteAuthorizationV2 = object & {
  readonly [consumedAssistantAuthorizationBrand]: true;
};

export interface AutomaticAssistantCaptureAuthorizationRegistry {
  authorize(
    intentValue: unknown,
    graphValue: unknown,
    contextValue: unknown,
    check?: () => void,
  ): PrivateAutomaticAssistantWriteAuthorizationV2 | null;
  consumeForBegin(
    authorization: PrivateAutomaticAssistantWriteAuthorizationV2,
    intentValue: unknown,
  ): PrivateConsumedAutomaticAssistantWriteAuthorizationV2;
  bindAssistantLease(
    authorization: PrivateConsumedAutomaticAssistantWriteAuthorizationV2,
    handle: PrivateOneUseAutomaticLeaseHandle<'assistant_final_save'>,
    persistedFenceValue: unknown,
  ): void;
  authorizationForAssistantLease(
    handle: PrivateOneUseAutomaticLeaseHandle<'assistant_final_save'>,
  ): PrivateConsumedAutomaticAssistantWriteAuthorizationV2 | null;
}

interface AuthorizationRecord {
  readonly owner: RegistryState;
  readonly data: AutomaticAssistantCaptureAuthorizationDataV2;
  consumed: boolean;
  consumedCapability?: object;
  beginInvocationHash?: string;
  expectedFence?: AutomaticCaptureLeaseFenceV2;
  boundHandle?: object;
}

interface RegistryState {
  readonly handleRegistry: AutomaticCaptureHandleRegistry;
  readonly issued: WeakMap<object, AuthorizationRecord>;
  readonly consumed: WeakMap<object, AuthorizationRecord>;
  readonly assistantLeases: WeakMap<object, AuthorizationRecord>;
}

const registryStates = new WeakMap<object, RegistryState>();

function opaque<T extends object>(): T {
  return Object.freeze(Object.create(null)) as T;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

function fixed(code: string): Error {
  return new Error(`Engram automatic capture: ${code}`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseIntent(value: unknown): AutomaticAssistantCaptureIntentV2 {
  return AutomaticAssistantCaptureIntentV2Schema.parse(
    cloneBoundedAutomaticCaptureJson(value, 'assistantIntent'),
  );
}

function recordForAuthorization(
  registry: AutomaticAssistantCaptureAuthorizationRegistry,
  capability: unknown,
  intent?: AutomaticAssistantCaptureIntentV2,
): AuthorizationRecord {
  const state = registryStates.get(registry as object);
  if (!state || capability === null || typeof capability !== 'object')
    throw fixed('invalid_authorization');
  const record = state.consumed.get(capability as object);
  if (!record || record.owner !== state || !record.consumed) throw fixed('invalid_authorization');
  if (
    intent &&
    (hashAutomaticCaptureV2(intent) !== record.data.intentHash ||
      !deepEqual(intent, record.data.intent))
  )
    throw fixed('invalid_authorization');
  return record;
}

function beginInvocationHash(input: AutomaticAssistantCaptureBeginInputV2): string {
  return hashAutomaticCaptureV2({
    storeHash: input.storeHash,
    sourceId: input.sourceId,
    operationId: input.operationId,
    beginCallHash: input.beginCallHash,
    leaseToken: input.leaseToken,
  });
}

function bindBeginInvocation(
  record: AuthorizationRecord,
  input: AutomaticAssistantCaptureBeginInputV2,
): void {
  const hash = beginInvocationHash(input);
  if (record.beginInvocationHash !== undefined && record.beginInvocationHash !== hash)
    throw fixed('invalid_authorization');
  record.beginInvocationHash = hash;
}

function snapshotGraph(graphValue: unknown): GraphData {
  const graph = parseLosslessAutomaticCaptureGraph(graphValue);
  assertAutomaticLedgerSourceIntegrity(graph);
  return graph;
}

interface CurrentHumanAuthority {
  readonly graph: GraphData;
  readonly source: EpisodicNode;
  readonly operation:
    | Extract<Operation, { state: 'committed' }>
    | Extract<CompositionalAutomaticCaptureOperationV3, { state: 'committed' }>;
  readonly descriptor: AutomaticOperationDescriptorV2 | CompositionalAutomaticDescriptorV3;
  readonly identity: AutomaticOperationIdentityV2 | CompositionalAutomaticOperationIdentityV3;
  readonly authority: AssistantWriteAuthorityReferenceV2;
  readonly currentAuthority: 'active' | 'changed' | 'revoked' | 'unknown';
}

function currentHumanAuthorityStatus(
  graph: GraphData,
  source: EpisodicNode,
  descriptor: AutomaticOperationDescriptorV2,
  envelope: z.infer<typeof AutomaticSourceEnvelopeSchema>,
  check: () => void,
): CurrentHumanAuthority['currentAuthority'] {
  if (source.review_status !== 'accepted' || source.trust_level !== descriptor.requestedTrustLevel)
    return 'changed';
  let checkFailure: { value: unknown } | undefined;
  const checked = () => {
    try {
      check();
    } catch (error) {
      checkFailure = { value: error };
      throw error;
    }
  };
  try {
    assertAutomaticBinding(graph, envelope, checked);
    return 'active';
  } catch (error) {
    if (checkFailure) throw checkFailure.value;
    if (error instanceof Error && error.message.includes('binding_revoked')) return 'revoked';
    if (
      error instanceof Error &&
      /binding_changed|missing_binding|subject_not_accepted|subject_not_found|namespace_mismatch/u.test(
        error.message,
      )
    )
      return 'changed';
    return 'unknown';
  }
}

function currentCompositionalHumanAuthorityStatus(
  graph: GraphData,
  source: EpisodicNode,
  descriptor: CompositionalAutomaticDescriptorV3,
  owner: CompositionalAutomaticCaptureOperationV3['identity'],
  check: () => void,
): CurrentHumanAuthority['currentAuthority'] {
  if (source.review_status !== 'accepted' || source.trust_level !== descriptor.requestedTrustLevel)
    return 'changed';
  let checkFailure: { value: unknown } | undefined;
  const checked = () => {
    try {
      check();
    } catch (error) {
      checkFailure = { value: error };
      throw error;
    }
  };
  try {
    assertAutomaticBindingIdentity(
      graph,
      owner.namespace,
      owner.issuer,
      owner.actorReference,
      owner.binding,
      checked,
    );
    return 'active';
  } catch (error) {
    if (checkFailure) throw checkFailure.value;
    if (error instanceof Error && error.message.includes('binding_revoked')) return 'revoked';
    if (
      error instanceof Error &&
      /binding_changed|missing_binding|subject_not_accepted|subject_not_found|namespace_mismatch/u.test(
        error.message,
      )
    )
      return 'changed';
    return 'unknown';
  }
}

function locateAndValidateHumanAuthority(
  graph: GraphData,
  intent: AutomaticAssistantCaptureIntentV2,
  storeHash: string,
  check: () => void,
): CurrentHumanAuthority | null {
  let checkFailure: { value: unknown } | undefined;
  const checked = () => {
    try {
      check();
    } catch (error) {
      checkFailure = { value: error };
      throw error;
    }
  };
  const human = intent.humanTurn;
  const operations = (graph.automatic_operations_v1?.operations ?? []).filter((operation) => {
    checked();
    return (
      operation.identity.namespace === human.namespace &&
      operation.identity.turn === human.turn &&
      operation.identity.role === 'human'
    );
  });
  const idempotencyKey = automaticWriteOwnerIdempotencyKey({ turn: human.turn, role: 'human' });
  const sources = graph.episodes.filter((source) => {
    checked();
    return (
      source.group_id === human.namespace &&
      source.role === 'human' &&
      source.idempotency_key === idempotencyKey
    );
  });
  if (operations.length !== 1 || sources.length !== 1) return null;
  const operation = operations[0];
  const source = sources[0];
  if (operation.version === 3) {
    if (
      operation.state !== 'committed' ||
      operation.identity.purpose !== 'human_turn_memory' ||
      (operation.terminalReceipt.kind !== 'human_compositional_capture_committed' &&
        operation.terminalReceipt.kind !== 'human_compositional_source_verdict_committed') ||
      operation.identity.sourceId !== source.uuid ||
      operation.identity.storeHash !== storeHash ||
      operation.identity.namespace !== human.namespace ||
      operation.identity.issuer !== human.issuer ||
      operation.identity.actorReference !== human.actorReference ||
      operation.identity.turn !== human.turn ||
      source.group_id !== human.namespace ||
      source.role !== 'human'
    ) {
      return null;
    }

    try {
      checked();
      const reconstructed = reconstructCompositionalAutomaticSourceIdentityV3(
        source,
        operation.descriptor,
        checked,
      );
      const envelopeWrapper = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(
        reconstructed.envelope,
      );
      const envelope = envelopeWrapper.sourceEnvelope;
      const descriptor = CompositionalAutomaticDescriptorV3Schema.parse(reconstructed.descriptor);
      const owner = reconstructed.owner;
      const receipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.safeParse(
        operation.terminalReceipt,
      );
      if (
        !receipt.success ||
        (receipt.data.kind !== 'human_compositional_capture_committed' &&
          receipt.data.kind !== 'human_compositional_source_verdict_committed') ||
        receipt.data.operationId !== operation.operationId ||
        receipt.data.sourceId !== source.uuid ||
        receipt.data.sourceHash !== operation.identity.sourceHash ||
        receipt.data.descriptorHash !== operation.identity.descriptorHash ||
        owner.purpose !== 'human_turn_memory' ||
        owner.role !== 'human' ||
        owner.lifecycle !== intent.lifecycle ||
        owner.storeHash !== storeHash ||
        owner.namespace !== human.namespace ||
        owner.issuer !== human.issuer ||
        owner.actorReference !== human.actorReference ||
        owner.turn !== human.turn ||
        source.content !== human.input.content ||
        descriptor.purpose !== 'human_turn_memory' ||
        operation.identity.descriptorHash !== hashCompositionalAutomaticDescriptorV3(descriptor)
      ) {
        return null;
      }

      const actualRegion = envelope.humanRegion;
      const requestedRegion = human.input.humanRegion ?? {
        start: 0,
        end: human.input.content.length,
      };
      const wrapperMatches =
        (human.input.applicationOwnedWrapper === true) ===
        (envelope.mappingAuthority === 'application_region');
      if (
        !wrapperMatches ||
        canonical(actualRegion) !== canonical(requestedRegion) ||
        canonical(envelope.quoteRegions) !== canonical(human.input.quoteRegions)
      ) {
        return null;
      }

      const identity = reconstructed.identity;
      const reconciledIdentity = reconcileCompositionalCaptureOperationIdentityV3(
        identity,
        operation.identity,
      );
      if (
        !reconciledIdentity ||
        hashAutomaticCaptureV2(reconciledIdentity) !== hashAutomaticCaptureV2(operation.identity)
      ) {
        return null;
      }
      const authority: AssistantWriteAuthorityReferenceV2 = {
        kind: 'owned_human_turn',
        sourceId: source.uuid,
        sourceHash: operation.identity.sourceHash,
        descriptorHash: operation.identity.descriptorHash,
        requestedAuthorityHash: operation.identity.requestedAuthorityHash,
      };
      const currentAuthority = currentCompositionalHumanAuthorityStatus(
        graph,
        source,
        descriptor,
        operation.identity,
        checked,
      );
      return {
        graph,
        source,
        operation,
        descriptor,
        identity: operation.identity,
        authority,
        currentAuthority,
      };
    } catch (error) {
      if (checkFailure) throw checkFailure.value;
      return null;
    }
  }

  if (
    operation.version !== 2 ||
    operation.state !== 'committed' ||
    operation.identity.purpose !== 'human_turn_memory' ||
    operation.terminalReceipt.kind !== 'human_capture_committed' ||
    operation.identity.sourceId !== source.uuid ||
    operation.identity.storeHash !== storeHash ||
    operation.identity.namespace !== human.namespace ||
    operation.identity.issuer !== human.issuer ||
    operation.identity.actorReference !== human.actorReference ||
    operation.identity.turn !== human.turn ||
    source.group_id !== human.namespace ||
    source.role !== 'human'
  )
    return null;

  try {
    checked();
    prepareAutomaticEpisodeInput(source);
    const owner = AutomaticCaptureSourceOwnerV2Schema.parse(
      source.attributes[WRITE_OWNER_V2_ATTRIBUTE],
    );
    const legacyOwner = AutomaticWriteOwnerSchema.parse(source.attributes[WRITE_OWNER_ATTRIBUTE]);
    const envelope = AutomaticSourceEnvelopeSchema.parse(
      source.attributes[SOURCE_ENVELOPE_ATTRIBUTE],
    );
    const descriptor = AutomaticOperationDescriptorV2Schema.parse(operation.descriptor);
    if (
      owner.purpose !== 'human_turn_memory' ||
      descriptor.purpose !== 'human_turn_memory' ||
      owner.storeHash !== storeHash ||
      owner.namespace !== human.namespace ||
      owner.issuer !== human.issuer ||
      owner.actorReference !== human.actorReference ||
      owner.turn !== human.turn ||
      legacyOwner.store !== storeHash ||
      legacyOwner.namespace !== human.namespace ||
      legacyOwner.issuer !== human.issuer ||
      legacyOwner.actor !== human.actorReference ||
      legacyOwner.turn !== human.turn ||
      source.content !== human.input.content
    )
      return null;

    const mapped = human.input.humanRegion
      ? human.input.content.slice(human.input.humanRegion.start, human.input.humanRegion.end)
      : human.input.content;
    const reconstructed = captureEnvelope(
      mapped,
      human.input.content,
      {
        namespace: human.namespace,
        issuer: human.issuer,
        actorReference: human.actorReference,
        quoteRegions: human.input.quoteRegions,
        ...(human.input.applicationOwnedWrapper
          ? {
              applicationOwnedWrapper: true as const,
              humanRegion: human.input.humanRegion!,
            }
          : {}),
      },
      owner.binding,
      owner.intentSetting,
      descriptor.policy,
    );
    if (
      !reconstructed.ok ||
      canonical(reconstructed.envelope) !== canonical(envelope) ||
      canonical(envelope.bindingRef) !== canonical(owner.binding) ||
      canonical(envelope.policy) !== canonical(descriptor.policy) ||
      canonical(legacyOwner.binding) !== canonical(owner.binding) ||
      canonical(legacyOwner.policy) !== canonical(owner.policy)
    )
      return null;
    const identity = automaticCaptureOperationIdentityForOwnedSource(source, descriptor);
    const reconciledIdentity = reconcileAutomaticCaptureOperationIdentity(
      identity,
      operation.identity,
    );
    if (
      !reconciledIdentity ||
      hashAutomaticCaptureV2(operation.identity) !== hashAutomaticCaptureV2(reconciledIdentity)
    )
      return null;
    const authority = {
      kind: 'owned_human_turn' as const,
      sourceId: source.uuid,
      sourceHash: operation.identity.sourceHash,
      descriptorHash: hashAutomaticCaptureV2(descriptor),
      requestedAuthorityHash: operation.identity.requestedAuthorityHash,
    };
    const currentAuthority = currentHumanAuthorityStatus(
      graph,
      source,
      descriptor,
      envelope,
      checked,
    );
    return { graph, source, operation, descriptor, identity, authority, currentAuthority };
  } catch (error) {
    if (checkFailure) throw checkFailure.value;
    return null;
  }
}

function revalidateAuthorization(
  graph: GraphData,
  record: AuthorizationRecord,
  storeHash: string,
  check: () => void,
): CurrentHumanAuthority | null {
  if (storeHash !== record.data.storeHash) return null;
  const current = locateAndValidateHumanAuthority(graph, record.data.intent, storeHash, check);
  if (
    !current ||
    current.operation.operationId !== record.data.humanOperationId ||
    hashAutomaticCaptureV2(current.operation.identity) !== record.data.humanIdentityHash ||
    canonical(current.authority) !== canonical(record.data.humanAuthority)
  )
    return null;
  return current;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function assistantDescriptor(
  data: AutomaticAssistantCaptureAuthorizationDataV2,
): AutomaticAssistantDescriptorBuildResultV2 {
  const settings = AutomaticAssistantDescriptorSettingsV2Schema.parse({
    lifecycle: 'replaySafeV2',
    purpose: 'assistant_final_save',
    interpreterId: 'assistant-final-write-v1',
    semanticVersion: 1,
    grammarVersion: null,
    lexiconVersion: null,
    requestedTrustLevel: null,
    intentSetting: null,
    invocationDeadlineMs: data.intent.invocationDeadlineMs,
    policy: null,
    assistantWriteAuthority: data.humanAuthority,
  });
  const descriptor = AutomaticOperationDescriptorV2Schema.parse({
    version: 2,
    lifecycle: settings.lifecycle,
    purpose: settings.purpose,
    executionMode: 'synchronous',
    interpreterId: settings.interpreterId,
    semanticVersion: settings.semanticVersion,
    grammarVersion: null,
    lexiconVersion: null,
    requestedTrustLevel: null,
    intentSetting: null,
    invocationDeadlineMs: settings.invocationDeadlineMs,
    policy: null,
    assistantWriteAuthority: settings.assistantWriteAuthority,
    settingsHash: automaticOperationDescriptorSettingsHashV2(settings),
  });
  return AutomaticAssistantDescriptorBuildResultV2Schema.parse({
    descriptor,
    descriptorHash: hashAutomaticCaptureV2(descriptor),
  });
}

function fenceFor(
  operation: Extract<Operation, { state: 'leased' }>,
): AutomaticCaptureLeaseFenceV2 {
  return {
    purpose: 'assistant_final_save',
    state: 'leased',
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    descriptorHash: hashAutomaticCaptureV2(operation.descriptor),
    identityHash: hashAutomaticCaptureV2(operation.identity),
    beginCallHash: operation.beginCallHash,
    generation: operation.generation,
    token: operation.lease.token,
    claimKind: operation.lease.claimKind,
    planTimestamp: operation.lease.renewedAt,
    retryCount: 0,
  };
}

function sameFence(
  left: AutomaticCaptureLeaseFenceV2,
  right: AutomaticCaptureLeaseFenceV2,
): boolean {
  return deepEqual(left, right);
}

function assistantDecision(
  kind: Exclude<
    Extract<AutomaticAssistantCaptureBeginPreparationV2, { kind: 'decision' }>['decision']['kind'],
    'capacity'
  >,
): AutomaticAssistantCaptureBeginPreparationV2 {
  return { kind: 'decision', decision: { kind } };
}

type AssistantAttemptDisposition =
  | 'committed_replay'
  | 'in_progress'
  | 'cancelled_replay'
  | 'unsupported_mode';

function assistantAttemptCandidate(
  graph: GraphData,
  operation: Operation,
  input: AutomaticAssistantCaptureBeginInputV2,
  disposition: AssistantAttemptDisposition,
  check: () => void,
): { graph: GraphData; writeRequired: boolean } {
  const next = withAutomaticCaptureAttemptV2(operation, {
    attemptHash: input.intent.attemptIdHash,
    at: input.backendNow,
    disposition,
  });
  if (!next || next === operation) return { graph, writeRequired: false };

  const candidate = validateAutomaticCaptureCandidate(
    {
      ...graph,
      automatic_operations_v1: {
        version: 1,
        operations: graph.automatic_operations_v1!.operations.map((stored) =>
          stored.operationId === operation.operationId ? next : stored,
        ),
      },
    },
    check,
  );
  return candidate ? { graph: candidate, writeRequired: true } : { graph, writeRequired: false };
}

function assistantDecisionWithAttempt(
  graph: GraphData,
  operation: Operation,
  input: AutomaticAssistantCaptureBeginInputV2,
  kind: Parameters<typeof assistantDecision>[0],
  disposition: AssistantAttemptDisposition,
  check: () => void,
): AutomaticAssistantCaptureBeginPreparationV2 {
  const audited = assistantAttemptCandidate(graph, operation, input, disposition, check);
  if (!audited.writeRequired) return assistantDecision(kind);
  return AutomaticAssistantCaptureBeginPreparationV2Schema.parse({
    kind: 'prepared_decision',
    graph: audited.graph,
    decision: { kind },
  });
}

/**
 * Construct one internal registry. It only authenticates caller-supplied graph snapshots as
 * structured evidence. Backend callers must use a fresh coherent actual-store snapshot and
 * revalidate again inside each begin/completion transaction before any write.
 */
export function createAutomaticAssistantCaptureAuthorizationRegistry(
  handleRegistry: AutomaticCaptureHandleRegistry,
): AutomaticAssistantCaptureAuthorizationRegistry {
  const state: RegistryState = {
    handleRegistry,
    issued: new WeakMap(),
    consumed: new WeakMap(),
    assistantLeases: new WeakMap(),
  };
  const registry: AutomaticAssistantCaptureAuthorizationRegistry = {
    authorize(intentValue, graphValue, contextValue, workCheck = () => {}) {
      workCheck();
      let intent: AutomaticAssistantCaptureIntentV2;
      let context: z.infer<typeof AutomaticAssistantCaptureAuthorizationContextV2Schema>;
      let graph: GraphData;
      try {
        intent = parseIntent(intentValue);
        context = AutomaticAssistantCaptureAuthorizationContextV2Schema.parse(
          cloneBoundedAutomaticCaptureJson(contextValue, 'beginRequest'),
        );
        graph = snapshotGraph(graphValue);
      } catch {
        workCheck();
        return null;
      }
      workCheck();
      const current = locateAndValidateHumanAuthority(graph, intent, context.storeHash, workCheck);
      if (!current || current.currentAuthority !== 'active') return null;
      const data = AutomaticAssistantCaptureAuthorizationDataV2Schema.parse({
        intent,
        intentHash: hashAutomaticCaptureV2(intent),
        storeHash: context.storeHash,
        humanOperationId: current.operation.operationId,
        humanIdentityHash: hashAutomaticCaptureV2(current.operation.identity),
        humanAuthority: current.authority,
      });
      const record: AuthorizationRecord = {
        owner: state,
        data: freeze(data),
        consumed: false,
      };
      const capability = opaque<PrivateAutomaticAssistantWriteAuthorizationV2>();
      state.issued.set(capability, record);
      return capability;
    },

    consumeForBegin(authorization, intentValue) {
      const record = state.issued.get(authorization as object);
      if (!record || record.owner !== state || record.consumed)
        throw fixed('invalid_authorization');
      let intent: AutomaticAssistantCaptureIntentV2;
      try {
        intent = parseIntent(intentValue);
      } catch {
        throw fixed('invalid_authorization');
      }
      if (hashAutomaticCaptureV2(intent) !== record.data.intentHash)
        throw fixed('invalid_authorization');
      record.consumed = true;
      const capability = opaque<PrivateConsumedAutomaticAssistantWriteAuthorizationV2>();
      record.consumedCapability = capability;
      state.consumed.set(capability, record);
      return capability;
    },

    bindAssistantLease(authorization, handle, persistedFenceValue) {
      const record = state.consumed.get(authorization as object);
      if (
        !record ||
        record.owner !== state ||
        !record.consumed ||
        !record.expectedFence ||
        !handleRegistry.isLiveHandle(handle, 'assistant_final_save', 'initial')
      )
        throw fixed('invalid_authorization');
      const parsedFence = AutomaticCaptureLeaseFenceV2Schema.safeParse(persistedFenceValue);
      if (!parsedFence.success || !sameFence(record.expectedFence, parsedFence.data))
        throw fixed('invalid_authorization');
      if (record.boundHandle && record.boundHandle !== handle) throw fixed('invalid_authorization');
      const existing = state.assistantLeases.get(handle as object);
      if (existing && existing !== record) throw fixed('invalid_authorization');
      record.boundHandle = handle as object;
      state.assistantLeases.set(handle as object, record);
    },

    authorizationForAssistantLease(handle) {
      const record = state.assistantLeases.get(handle as object);
      if (
        !record ||
        record.owner !== state ||
        !record.consumed ||
        record.boundHandle !== handle ||
        !record.consumedCapability
      )
        return null;
      return record.consumedCapability as PrivateConsumedAutomaticAssistantWriteAuthorizationV2;
    },
  };
  registryStates.set(registry as object, state);
  return Object.freeze(registry);
}

/** Build the fixed write-only descriptor from a consumed, backend-local authorization. */
export function buildAssistantCaptureDescriptorV2(
  registry: AutomaticAssistantCaptureAuthorizationRegistry,
  authorization: PrivateConsumedAutomaticAssistantWriteAuthorizationV2,
  intentValue: unknown,
): AutomaticAssistantDescriptorBuildResultV2 {
  const intent = parseIntent(intentValue);
  const record = recordForAuthorization(registry, authorization, intent);
  return freeze(assistantDescriptor(record.data));
}

function assertUnusedSourceId(graph: GraphData, sourceId: string, operationId?: string): void {
  if (
    sourceId === operationId ||
    [...graph.entities, ...graph.edges, ...graph.episodes].some(
      (record) => record.uuid === sourceId || record.uuid === operationId,
    ) ||
    graph.automatic_operations_v1?.operations.some(
      (operation) => operation.operationId === sourceId || operation.operationId === operationId,
    )
  )
    throw fixed('source_id_conflict');
}

function sourceMatchesIntent(
  source: EpisodicNode,
  intent: AutomaticAssistantCaptureIntentV2,
  descriptor: AutomaticOperationDescriptorV2,
  authority: AssistantWriteAuthorityReferenceV2,
  storeHash: string,
): boolean {
  const producer = intent.finalAssistant;
  try {
    const owner = AutomaticCaptureSourceOwnerV2Schema.parse(
      source.attributes[WRITE_OWNER_V2_ATTRIBUTE],
    );
    const expectedEventTime =
      producer.eventTime.mode === 'explicit' ? producer.eventTime.value : null;
    return (
      owner.purpose === 'assistant_final_save' &&
      owner.storeHash === storeHash &&
      owner.namespace === intent.humanTurn.namespace &&
      owner.issuer === intent.humanTurn.issuer &&
      owner.actorReference === intent.humanTurn.actorReference &&
      owner.turn === intent.humanTurn.turn &&
      canonical(owner.assistantWriteAuthority) === canonical(authority) &&
      owner.settingsHash === descriptor.settingsHash &&
      owner.eventTimeMode === producer.eventTime.mode &&
      source.group_id === intent.humanTurn.namespace &&
      source.role === 'ai' &&
      source.episode_kind === 'assistant_reply' &&
      source.source_type === 'message' &&
      source.content === producer.content &&
      source.source_message_id === producer.sourceMessageId &&
      source.conversation_id === producer.conversationId &&
      source.sender_id === producer.senderId &&
      source.source_workflow_id === producer.sourceWorkflowId &&
      source.source_execution_id === producer.originalSourceExecutionId &&
      source.quoted_message_id === producer.quotedMessageId &&
      source.idempotency_key ===
        automaticWriteOwnerIdempotencyKey({ turn: intent.humanTurn.turn, role: 'assistant' }) &&
      (expectedEventTime === null || source.reference_time === expectedEventTime)
    );
  } catch {
    return false;
  }
}

function buildAssistantSourceFromValidatedGraph(
  graph: GraphData,
  input: AutomaticAssistantSourceBuildV2,
  record: AuthorizationRecord,
  current: CurrentHumanAuthority,
  workCheck: () => void,
): AutomaticAssistantBuiltSourceV2 {
  if (current.currentAuthority !== 'active') throw fixed('authority_changed');
  workCheck();
  assertUnusedSourceId(graph, input.sourceId);
  if (
    input.previousEpisodeId !== null &&
    !graph.episodes.some(
      (episode) =>
        episode.uuid === input.previousEpisodeId &&
        episode.group_id === input.intent.humanTurn.namespace,
    )
  )
    throw fixed('invalid_predecessor');

  const builtDescriptor = assistantDescriptor(record.data);
  const producer = input.intent.finalAssistant;
  const referenceTime =
    producer.eventTime.mode === 'explicit' ? producer.eventTime.value : input.capturedAt;
  const episode = EpisodicNodeSchema.parse({
    uuid: input.sourceId,
    group_id: input.intent.humanTurn.namespace,
    content: producer.content,
    role: 'ai',
    source_type: 'message',
    reference_time: referenceTime,
    created_at: input.capturedAt,
    updated_at: input.capturedAt,
    previous_episode_uuid: input.previousEpisodeId,
    source_message_id: producer.sourceMessageId,
    conversation_id: producer.conversationId,
    sender_id: producer.senderId,
    sender_name: producer.senderName,
    source_workflow_id: producer.sourceWorkflowId,
    source_execution_id: producer.originalSourceExecutionId,
    quoted_message_id: producer.quotedMessageId,
    trust_level: 'unverified',
    review_status: 'proposed',
    idempotency_key: automaticWriteOwnerIdempotencyKey({
      turn: input.intent.humanTurn.turn,
      role: 'assistant',
    }),
    episode_kind: 'assistant_reply',
    attributes: {},
  });
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: input.storeHash,
    namespace: input.intent.humanTurn.namespace,
    turn: input.intent.humanTurn.turn,
    role: 'assistant',
    issuer: input.intent.humanTurn.issuer,
    actorReference: input.intent.humanTurn.actorReference,
    binding: null,
    assistantWriteAuthority: record.data.humanAuthority,
    purpose: 'assistant_final_save',
    requestedTrustLevel: null,
    intentSetting: null,
    intentEvidence: null,
    eventTimeMode: producer.eventTime.mode,
    eventTimeHash: hashAutomaticCaptureV2({
      mode: producer.eventTime.mode,
      normalizedReferenceTime: new Date(referenceTime).toISOString(),
    }),
    stableProducerHash: hashAutomaticCaptureV2({
      source_workflow_id: episode.source_workflow_id,
      source_message_id: episode.source_message_id,
      conversation_id: episode.conversation_id,
      sender_id: episode.sender_id,
      source_type: episode.source_type,
      episode_kind: episode.episode_kind,
      quoted_message_id: episode.quoted_message_id,
    }),
    sourceContentHash: sha256(producer.content),
    settingsHash: builtDescriptor.descriptor.settingsHash,
    policy: null,
  });
  const validated = prepareAutomaticEpisodeInput(episode);
  const identity = automaticCaptureOperationIdentityForOwnedSource(
    validated,
    builtDescriptor.descriptor,
  );
  // The human is re-read above, and this comparison guards accidental cross-store plumbing.
  if (
    current.operation.identity.sourceId !== current.authority.sourceId ||
    record.data.humanAuthority.sourceId !== current.authority.sourceId
  )
    throw fixed('authority_changed');
  workCheck();
  return freeze(
    AutomaticAssistantBuiltSourceV2Schema.parse({
      episode: validated,
      descriptor: builtDescriptor.descriptor,
      descriptorHash: builtDescriptor.descriptorHash,
      identity,
    }),
  );
}

/**
 * Pure assistant source construction. It never adds a human envelope, v1 owner,
 * claim, or extraction fact. The backend must atomically append this source with
 * the initial operation and reauthenticate the parent in the write transaction.
 */
export function buildAssistantCaptureSourceV2(
  graphValue: unknown,
  inputValue: AutomaticAssistantSourceBuildV2,
  registry: AutomaticAssistantCaptureAuthorizationRegistry,
  authorization: PrivateConsumedAutomaticAssistantWriteAuthorizationV2,
  workCheck: () => void = () => {},
): AutomaticAssistantBuiltSourceV2 {
  workCheck();
  const input = AutomaticAssistantSourceBuildV2Schema.parse(
    cloneBoundedAutomaticCaptureJson(inputValue, 'assistantIntent'),
  );
  const record = recordForAuthorization(registry, authorization, input.intent);
  if (input.storeHash !== record.data.storeHash) throw fixed('invalid_authorization');
  const graph = snapshotGraph(graphValue);
  const current = revalidateAuthorization(graph, record, input.storeHash, workCheck);
  if (!current) throw fixed('authority_changed');
  return buildAssistantSourceFromValidatedGraph(graph, input, record, current, workCheck);
}

function sameBeginRequest(
  source: EpisodicNode,
  operation: Operation,
  input: AutomaticAssistantCaptureBeginInputV2,
  descriptor: AutomaticOperationDescriptorV2,
  authority: AssistantWriteAuthorityReferenceV2,
): boolean {
  if (
    operation.identity.purpose !== 'assistant_final_save' ||
    operation.identity.role !== 'assistant' ||
    operation.identity.storeHash !== input.storeHash ||
    operation.identity.namespace !== input.intent.humanTurn.namespace ||
    operation.identity.issuer !== input.intent.humanTurn.issuer ||
    operation.identity.actorReference !== input.intent.humanTurn.actorReference ||
    operation.identity.turn !== input.intent.humanTurn.turn ||
    operation.descriptor.purpose !== 'assistant_final_save' ||
    hashAutomaticCaptureV2(operation.descriptor) !== hashAutomaticCaptureV2(descriptor) ||
    !sourceMatchesIntent(source, input.intent, descriptor, authority, input.storeHash)
  )
    return false;
  try {
    prepareAutomaticEpisodeInput(source);
    const observed = automaticCaptureOperationIdentityForOwnedSource(source, operation.descriptor);
    return reconcileAutomaticCaptureOperationIdentity(observed, operation.identity) !== null;
  } catch {
    return false;
  }
}

function assistantReplayReadDecision(
  reason: Extract<AutomaticAssistantFinalWriterResultV2, { kind: 'decision' }>['reason'],
): AutomaticAssistantFinalWriterResultV2 {
  return AutomaticAssistantFinalWriterResultV2Schema.parse({
    kind: 'decision',
    reason,
    eligibleFirstCommit: false,
  });
}

/**
 * Read an exact historical assistant receipt from a coherent graph snapshot. This is a
 * capability-free inspection path: it never creates authority, a lease, or a write candidate,
 * and its result must not be used to load memory or continue agent execution. Backends must
 * supply a fresh actual-store snapshot; revoked or changed parent authority is reported while
 * the persisted receipt remains historical evidence only.
 */
export function readAutomaticAssistantCaptureReplayV2(
  graphValue: unknown,
  intentValue: unknown,
  contextValue: unknown,
  workCheck: () => void = () => {},
): AutomaticAssistantFinalWriterResultV2 {
  workCheck();
  let graph: GraphData;
  let intent: AutomaticAssistantCaptureIntentV2;
  let context: z.infer<typeof AutomaticAssistantCaptureAuthorizationContextV2Schema>;
  try {
    graph = snapshotGraph(graphValue);
    intent = parseIntent(intentValue);
    context = AutomaticAssistantCaptureAuthorizationContextV2Schema.parse(
      cloneBoundedAutomaticCaptureJson(contextValue, 'beginRequest'),
    );
  } catch {
    workCheck();
    return assistantReplayReadDecision('invalid_input');
  }

  workCheck();
  const current = locateAndValidateHumanAuthority(graph, intent, context.storeHash, workCheck);
  if (!current) return assistantReplayReadDecision('authority_changed');

  const authorizationData = AutomaticAssistantCaptureAuthorizationDataV2Schema.safeParse({
    intent,
    intentHash: hashAutomaticCaptureV2(intent),
    storeHash: context.storeHash,
    humanOperationId: current.operation.operationId,
    humanIdentityHash: hashAutomaticCaptureV2(current.operation.identity),
    humanAuthority: current.authority,
  });
  if (!authorizationData.success) return assistantReplayReadDecision('authority_changed');
  const descriptor = assistantDescriptor(authorizationData.data).descriptor;
  const { humanTurn } = intent;
  const assistantOperations = (graph.automatic_operations_v1?.operations ?? []).filter(
    (operation) => {
      workCheck();
      return (
        operation.identity.namespace === humanTurn.namespace &&
        operation.identity.turn === humanTurn.turn &&
        operation.identity.role === 'assistant'
      );
    },
  );
  const assistantIdempotencyKey = automaticWriteOwnerIdempotencyKey({
    turn: humanTurn.turn,
    role: 'assistant',
  });
  const assistantSources = graph.episodes.filter((source) => {
    workCheck();
    return (
      source.group_id === humanTurn.namespace &&
      source.role === 'ai' &&
      source.idempotency_key === assistantIdempotencyKey
    );
  });
  if (assistantOperations.length !== 1 || assistantSources.length !== 1)
    return assistantReplayReadDecision('conflict');

  const operation = assistantOperations[0];
  const source = assistantSources[0];
  if (
    operation.version !== 2 ||
    operation.state !== 'committed' ||
    operation.identity.purpose !== 'assistant_final_save' ||
    operation.identity.storeHash !== context.storeHash ||
    operation.identity.namespace !== humanTurn.namespace ||
    operation.identity.issuer !== humanTurn.issuer ||
    operation.identity.actorReference !== humanTurn.actorReference ||
    operation.identity.turn !== humanTurn.turn ||
    operation.identity.role !== 'assistant' ||
    operation.identity.sourceId !== source.uuid ||
    operation.descriptor.purpose !== 'assistant_final_save' ||
    hashAutomaticCaptureV2(operation.descriptor) !== hashAutomaticCaptureV2(descriptor) ||
    !sourceMatchesIntent(source, intent, descriptor, current.authority, context.storeHash)
  )
    return assistantReplayReadDecision('conflict');

  try {
    prepareAutomaticEpisodeInput(source);
    const observedIdentity = automaticCaptureOperationIdentityForOwnedSource(
      source,
      operation.descriptor,
    );
    const reconciledIdentity = reconcileAutomaticCaptureOperationIdentity(
      observedIdentity,
      operation.identity,
    );
    if (
      !reconciledIdentity ||
      hashAutomaticCaptureV2(reconciledIdentity) !== hashAutomaticCaptureV2(operation.identity)
    )
      return assistantReplayReadDecision('conflict');
  } catch {
    return assistantReplayReadDecision('conflict');
  }

  const terminalReceipt = AutomaticCaptureTerminalReceiptV2Schema.safeParse(
    operation.terminalReceipt,
  );
  if (
    !terminalReceipt.success ||
    terminalReceipt.data.kind !== 'assistant_final_saved' ||
    terminalReceipt.data.operationId !== operation.operationId ||
    terminalReceipt.data.sourceId !== source.uuid ||
    terminalReceipt.data.sourceHash !== operation.identity.sourceHash ||
    terminalReceipt.data.descriptorHash !== hashAutomaticCaptureV2(operation.descriptor) ||
    !terminalReceipt.data.persisted
  )
    return assistantReplayReadDecision('conflict');

  return freeze(
    AutomaticAssistantFinalWriterResultV2Schema.parse({
      kind: 'committed_replay',
      terminalReceipt: terminalReceipt.data,
      currentAuthority: current.currentAuthority,
      eligibleFirstCommit: false,
    }),
  );
}

/** Prepare one atomic assistant source + initial lease candidate. */
export function prepareAssistantCaptureBeginV2(
  graphValue: unknown,
  inputValue: unknown,
  registry: AutomaticAssistantCaptureAuthorizationRegistry,
  authorization: PrivateConsumedAutomaticAssistantWriteAuthorizationV2,
  workCheck: () => void = () => {},
): AutomaticAssistantCaptureBeginPreparationV2 {
  let checkFailure: { value: unknown } | undefined;
  const check = () => {
    try {
      workCheck();
    } catch (error) {
      checkFailure = { value: error };
      throw error;
    }
  };
  check();
  let record: AuthorizationRecord;
  try {
    record = recordForAuthorization(registry, authorization);
  } catch {
    return assistantDecision('invalid_input');
  }

  let graph: GraphData;
  let input: AutomaticAssistantCaptureBeginInputV2;
  try {
    graph = snapshotGraph(graphValue);
    input = AutomaticAssistantCaptureBeginInputV2Schema.parse(
      cloneBoundedAutomaticCaptureJson(inputValue, 'assistantIntent'),
    );
  } catch {
    check();
    return assistantDecision('invalid_input');
  }

  try {
    record = recordForAuthorization(registry, authorization, input.intent);
    bindBeginInvocation(record, input);
  } catch {
    return assistantDecision('invalid_input');
  }
  if (input.storeHash !== record.data.storeHash) return assistantDecision('invalid_input');

  const current = revalidateAuthorization(graph, record, input.storeHash, check);
  if (!current || current.currentAuthority !== 'active')
    return assistantDecision('authority_changed');
  if (Date.parse(input.backendNow) < Date.parse(current.operation.lastObservedAt))
    return assistantDecision('clock_regression');

  const descriptor = assistantDescriptor(record.data).descriptor;
  const idempotencyKey = automaticWriteOwnerIdempotencyKey({
    turn: input.intent.humanTurn.turn,
    role: 'assistant',
  });
  const operations = (graph.automatic_operations_v1?.operations ?? []).filter((operation) => {
    check();
    return (
      operation.identity.namespace === input.intent.humanTurn.namespace &&
      operation.identity.turn === input.intent.humanTurn.turn &&
      operation.identity.role === 'assistant'
    );
  });
  const sources = graph.episodes.filter((source) => {
    check();
    return (
      source.group_id === input.intent.humanTurn.namespace &&
      source.idempotency_key === idempotencyKey
    );
  });
  if (operations.length > 1 || sources.length > 1) return assistantDecision('conflict');

  const operation = operations[0];
  const source = sources[0];
  if (operation || source) {
    if (!operation && source) return assistantDecision('source_only_unconfirmed');
    if (operation?.version === 1) return assistantDecision('legacy_unconfirmed');
    if (!operation || !source || operation.version !== 2) return assistantDecision('conflict');
    if (!sameBeginRequest(source, operation, input, descriptor, record.data.humanAuthority))
      return assistantDecision('conflict');
    if (Date.parse(input.backendNow) < Date.parse(operation.lastObservedAt))
      return assistantDecision('clock_regression');
    if (operation.state === 'committed') {
      const terminalReceipt = AutomaticCaptureTerminalReceiptV2Schema.safeParse(
        operation.terminalReceipt,
      );
      if (!terminalReceipt.success || terminalReceipt.data.kind !== 'assistant_final_saved')
        return assistantDecision('conflict');
      const audited = assistantAttemptCandidate(graph, operation, input, 'committed_replay', check);
      return AutomaticAssistantCaptureBeginPreparationV2Schema.parse({
        kind: 'prepared_replay',
        graph: audited.graph,
        terminalReceipt: terminalReceipt.data,
        currentAuthority: current.currentAuthority,
        auditWriteRequired: audited.writeRequired,
      });
    }
    if (operation.state === 'cancelled')
      return assistantDecisionWithAttempt(
        graph,
        operation,
        input,
        'cancelled_replay',
        'cancelled_replay',
        check,
      );
    if (
      operation.state === 'leased' &&
      operation.generation === 1 &&
      operation.lease.claimKind === 'initial' &&
      operation.retryCount === 0 &&
      operation.lastRetryCallHash === undefined &&
      operation.beginCallHash === input.beginCallHash &&
      operation.lease.token === input.leaseToken &&
      operation.identity.sourceId === input.sourceId &&
      operation.operationId === input.operationId &&
      Date.parse(input.backendNow) < Date.parse(operation.lease.expiresAt)
    ) {
      const leaseFence = fenceFor(operation);
      record.expectedFence = leaseFence;
      return AutomaticAssistantCaptureBeginPreparationV2Schema.parse({
        kind: 'prepared_claim',
        graph,
        operation,
        leaseFence,
        writeRequired: false,
      });
    }
    if (
      operation.state === 'leased' &&
      Date.parse(input.backendNow) >= Date.parse(operation.lease.expiresAt)
    )
      return assistantDecisionWithAttempt(
        graph,
        operation,
        input,
        'unsupported_mode',
        'unsupported_mode',
        check,
      );
    return operation.state === 'leased' || operation.state === 'captured'
      ? assistantDecisionWithAttempt(graph, operation, input, 'in_progress', 'in_progress', check)
      : assistantDecisionWithAttempt(
          graph,
          operation,
          input,
          'unsupported_mode',
          'unsupported_mode',
          check,
        );
  }

  try {
    assertUnusedSourceId(graph, input.sourceId, input.operationId);
  } catch {
    return assistantDecision('conflict');
  }

  let built: AutomaticAssistantBuiltSourceV2;
  try {
    built = buildAssistantSourceFromValidatedGraph(
      graph,
      {
        intent: input.intent,
        sourceId: input.sourceId,
        storeHash: input.storeHash,
        capturedAt: input.backendNow,
        previousEpisodeId: input.previousEpisodeId,
      },
      record,
      current,
      check,
    );
  } catch (error) {
    if (checkFailure) throw checkFailure.value;
    if (error instanceof Error && error.message.includes('authority_changed'))
      return assistantDecision('authority_changed');
    if (error instanceof Error && error.message.includes('source_id_conflict'))
      return assistantDecision('conflict');
    return assistantDecision('invalid_input');
  }

  const duration = Math.min(
    limits.maxLeaseMs,
    Math.max(limits.minLeaseMs, input.intent.invocationDeadlineMs + limits.storageGraceMs),
  );
  const expiresAt = Date.parse(input.backendNow) + duration;
  if (!Number.isFinite(expiresAt) || expiresAt > 8.64e15)
    return assistantDecision('clock_regression');
  const candidateOperation = AutomaticCaptureOperationV2Schema.safeParse({
    version: 2,
    operationId: input.operationId,
    identity: built.identity,
    descriptor: built.descriptor,
    createdAt: input.backendNow,
    lastObservedAt: input.backendNow,
    attempts: [
      { attemptHash: input.intent.attemptIdHash, at: input.backendNow, disposition: 'claim_won' },
    ],
    overflowCount: 0,
    auditTruncated: false,
    beginCallHash: input.beginCallHash,
    retryCount: 0,
    state: 'leased',
    generation: 1,
    lease: {
      token: input.leaseToken,
      acquiredAt: input.backendNow,
      renewedAt: input.backendNow,
      expiresAt: new Date(expiresAt).toISOString(),
      claimKind: 'initial',
    },
  });
  if (!candidateOperation.success || candidateOperation.data.state !== 'leased')
    return assistantDecision('invalid_input');
  const candidate = validateAutomaticCaptureCandidate(
    {
      ...graph,
      episodes: [...graph.episodes, built.episode],
      automatic_operations_v1: {
        version: 1,
        operations: [...(graph.automatic_operations_v1?.operations ?? []), candidateOperation.data],
      },
    },
    check,
  );
  if (!candidate)
    return AutomaticAssistantCaptureBeginPreparationV2Schema.parse({
      kind: 'decision',
      decision: { kind: 'capacity', sourcePersistence: 'not_persisted' },
    });
  const leaseFence = fenceFor(candidateOperation.data);
  record.expectedFence = leaseFence;
  return AutomaticAssistantCaptureBeginPreparationV2Schema.parse({
    kind: 'prepared_claim',
    graph: candidate,
    operation: candidateOperation.data,
    leaseFence,
    writeRequired: true,
  });
}

function operationMatchesFence(
  operation: Operation,
  fence: AutomaticCaptureLeaseFenceV2,
): operation is Extract<Operation, { state: 'leased' | 'committed' }> {
  if (
    operation.identity.purpose !== 'assistant_final_save' ||
    operation.identity.role !== 'assistant' ||
    operation.operationId !== fence.operationId ||
    operation.identity.sourceId !== fence.sourceId ||
    hashAutomaticCaptureV2(operation.descriptor) !== fence.descriptorHash ||
    hashAutomaticCaptureV2(operation.identity) !== fence.identityHash ||
    operation.beginCallHash !== fence.beginCallHash ||
    operation.generation !== fence.generation ||
    operation.retryCount !== 0 ||
    operation.lastRetryCallHash !== undefined
  )
    return false;
  if (operation.state === 'leased') {
    return (
      operation.lease.token === fence.token &&
      operation.lease.claimKind === 'initial' &&
      fence.claimKind === 'initial' &&
      operation.lease.renewedAt === fence.planTimestamp
    );
  }
  return operation.state === 'committed' && fence.claimKind === 'initial';
}

/**
 * Prepare the assistant's write-only terminal receipt. The passed invocation must
 * come from the same backend's synchronously consumed lease handle. This helper
 * reauthenticates the parent against a fresh coherent graph and never plans or
 * applies human claims.
 */
export function prepareAssistantFinalCompletionV2(
  graphValue: unknown,
  registry: AutomaticAssistantCaptureAuthorizationRegistry,
  handle: PrivateOneUseAutomaticLeaseHandle<'assistant_final_save'>,
  consumedInvocation: PrivateConsumedAutomaticCaptureInvocation<'assistant_final_save'>,
  contextValue: unknown,
  workCheck: () => void = () => {},
): AutomaticAssistantCaptureCompletionPreparationV2 {
  const state = registryStates.get(registry as object);
  if (!state) return { kind: 'decision', reason: 'invalid_handle' };
  let invocation: AutomaticAssistantCompletionInvocationV2;
  let record: AuthorizationRecord | undefined;
  try {
    invocation = AutomaticAssistantCompletionInvocationV2Schema.parse(
      state.handleRegistry.readConsumedInvocation(
        consumedInvocation as PrivateConsumedAutomaticCaptureInvocation<'assistant_final_save'>,
        'assistant_final_save',
      ),
    );
    record = state.assistantLeases.get(handle as object);
  } catch {
    return { kind: 'decision', reason: 'invalid_handle' };
  }
  if (
    !record ||
    record.owner !== state ||
    !record.consumed ||
    !record.consumedCapability ||
    record.boundHandle !== handle ||
    !record.expectedFence ||
    !sameFence(record.expectedFence, invocation.boundFence)
  )
    return { kind: 'decision', reason: 'invalid_handle' };

  workCheck();
  let graph: GraphData;
  let context: AutomaticAssistantCaptureCompletionContextV2;
  try {
    graph = snapshotGraph(graphValue);
    context = AutomaticAssistantCaptureCompletionContextV2Schema.parse(
      cloneBoundedAutomaticCaptureJson(contextValue, 'beginRequest'),
    );
  } catch {
    workCheck();
    return { kind: 'decision', reason: 'invalid_input' };
  }
  workCheck();
  const current = revalidateAuthorization(graph, record, context.storeHash, workCheck);
  if (!current) return { kind: 'decision', reason: 'authority_changed' };

  const matches = (graph.automatic_operations_v1?.operations ?? []).filter((operation) => {
    workCheck();
    return operation.operationId === invocation.boundFence.operationId;
  });
  if (matches.length !== 1 || matches[0].version !== 2)
    return { kind: 'decision', reason: 'fenced' };
  const operation = matches[0];
  if (!operationMatchesFence(operation, invocation.boundFence))
    return { kind: 'decision', reason: 'fenced' };
  const sources = graph.episodes.filter((source) => {
    workCheck();
    return source.uuid === invocation.boundFence.sourceId;
  });
  if (sources.length !== 1) return { kind: 'decision', reason: 'fenced' };
  const source = sources[0];
  const descriptor = assistantDescriptor(record.data).descriptor;
  if (
    hashAutomaticCaptureV2(operation.descriptor) !== hashAutomaticCaptureV2(descriptor) ||
    !sourceMatchesIntent(
      source,
      record.data.intent,
      operation.descriptor,
      record.data.humanAuthority,
      context.storeHash,
    )
  )
    return { kind: 'decision', reason: 'fenced' };
  try {
    const observed = automaticCaptureOperationIdentityForOwnedSource(source, operation.descriptor);
    if (!reconcileAutomaticCaptureOperationIdentity(observed, operation.identity))
      return { kind: 'decision', reason: 'fenced' };
  } catch {
    return { kind: 'decision', reason: 'fenced' };
  }
  if (Date.parse(context.backendNow) < Date.parse(operation.lastObservedAt))
    return { kind: 'decision', reason: 'clock_regression' };

  if (operation.state === 'committed') {
    const receipt = AutomaticCaptureTerminalReceiptV2Schema.safeParse(operation.terminalReceipt);
    if (
      operation.completionCallHash !== invocation.completionCallHash ||
      !receipt.success ||
      receipt.data.kind !== 'assistant_final_saved' ||
      receipt.data.operationId !== operation.operationId ||
      receipt.data.sourceId !== source.uuid ||
      receipt.data.sourceHash !== operation.identity.sourceHash ||
      receipt.data.descriptorHash !== invocation.boundFence.descriptorHash ||
      receipt.data.terminalAt !== operation.terminalReceipt.terminalAt ||
      !receipt.data.persisted
    )
      return { kind: 'decision', reason: 'fenced' };
    return {
      kind: 'ack_recovered',
      terminalReceipt: receipt.data,
      currentAuthority: current.currentAuthority,
    };
  }

  if (
    operation.state !== 'leased' ||
    operation.lease.token !== invocation.boundFence.token ||
    operation.lease.claimKind !== 'initial' ||
    Date.parse(context.backendNow) >= Date.parse(operation.lease.expiresAt)
  )
    return { kind: 'decision', reason: 'fenced' };
  if (current.currentAuthority !== 'active')
    return { kind: 'decision', reason: 'authority_changed' };
  workCheck();

  const terminalReceipt = AutomaticCaptureTerminalReceiptV2Schema.safeParse({
    version: 2,
    kind: 'assistant_final_saved',
    operationId: operation.operationId,
    sourceId: source.uuid,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: invocation.boundFence.descriptorHash,
    terminalAt: context.backendNow,
    persisted: true,
  });
  if (!terminalReceipt.success || terminalReceipt.data.kind !== 'assistant_final_saved')
    return { kind: 'decision', reason: 'capacity' };
  const { lease: _lease, ...base } = operation;
  void _lease;
  const committed = AutomaticCaptureOperationV2Schema.safeParse({
    ...base,
    state: 'committed',
    lastObservedAt: context.backendNow,
    completionCallHash: invocation.completionCallHash,
    terminalReceipt: terminalReceipt.data,
  });
  if (!committed.success || committed.data.state !== 'committed')
    return { kind: 'decision', reason: 'capacity' };
  const candidate = validateAutomaticCaptureCandidate(
    {
      ...graph,
      automatic_operations_v1: {
        version: 1,
        operations: graph.automatic_operations_v1!.operations.map((item) =>
          item.operationId === operation.operationId ? committed.data : item,
        ),
      },
    },
    workCheck,
  );
  if (!candidate) return { kind: 'decision', reason: 'capacity' };
  return AutomaticAssistantCaptureCompletionPreparationV2Schema.parse({
    kind: 'prepared_commit',
    graph: candidate,
    operation: committed.data,
    terminalReceipt: terminalReceipt.data,
  });
}
