import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import { z } from 'zod';
import { AutomaticAssistantFinalWriterResultV2Schema } from '../schemas/AutomaticAssistantCapture.schema';
import {
  AutomaticCaptureSourceOwnerStoredV2Schema,
  AutomaticOperationDescriptorV2Schema,
  hashAutomaticCaptureV2,
  canonicalAutomaticCaptureV2,
  type AutomaticOperationDescriptorV2,
  type AutomaticOperationIdentityV2,
} from '../schemas/AutomaticCapture.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../schemas/AutomaticCaptureReceipt.schema';
import {
  AutonomousPersonalAssistantDescriptorSettingsV4Schema,
  AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema,
  AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema,
  AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema,
  type AutonomousPersonalAssistantFinalPlanDataV4,
  type AutonomousPersonalAssistantFinalPreparationV4,
  type AutonomousPersonalAssistantFinalReconciliationV4,
} from '../schemas/AutonomousPersonalAssistantFinalV4.schema';
import { AssistantWriteAuthorityReferenceV4Schema } from '../schemas/AssistantWriteAuthorityReferenceV4.schema';
import { AutomaticCaptureOperationV2Schema } from '../schemas/AutomaticCaptureOperation.schema';
import { EpisodicNodeSchema, type EpisodicNode, type GraphData } from '../schemas';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import { AutonomousPersonalMemoryParentIntegrityV4Error } from './AutonomousPersonalMemoryParentIntegrityV4';
import {
  AutonomousPersonalRecordIntegrityV4Error,
  assertAutonomousPersonalRecordIntegrityV4,
} from './AutonomousPersonalRecordIntegrityV4';
import {
  assertAutomaticBindingRegistryIntegrity,
  assertAutomaticLedgerSourceIntegrity,
  autonomousPersonalAssistantOperationIdentityV4,
  automaticWriteOwnerIdempotencyKey,
  prepareAutomaticEpisodeInput,
  reconcileAutomaticCaptureOperationIdentity,
  WRITE_OWNER_V2_ATTRIBUTE,
} from './AutomaticIdentity';
import { hasAutomaticCaptureCapacity } from './AutomaticCaptureCapacity';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject,
} from './BoundedAutomaticCaptureJson';
import { assertAutonomousPersonalMemoryCurrentParentGraphV4 } from './AutonomousPersonalMemoryParentIntegrityV4';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { getOwnedImmutableGraphData } from './ImmutableGraphSnapshot';

type DecisionReason = Extract<
  z.infer<typeof AutomaticAssistantFinalWriterResultV2Schema>,
  { kind: 'decision' }
>['reason'];

type WorkState = Readonly<{ deadline: number; signal: AbortSignal }>;

const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

class AssistantFinalPlanFailure extends Error {
  constructor(readonly reason: DecisionReason) {
    super(reason);
    this.name = 'AutonomousPersonalAssistantFinalPlanV4Failure';
  }
}

function fail(reason: DecisionReason): never {
  throw new AssistantFinalPlanFailure(reason);
}

function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
  } catch {
    return false;
  }
}

function readWork(value: unknown): WorkState {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value) ||
    nativeAbortSignalAbortedGetter === undefined
  ) {
    fail('invalid_input');
  }
  try {
    const keys = Reflect.ownKeys(value);
    const deadline = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
    const signal = Object.getOwnPropertyDescriptor(value, 'signal');
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal') ||
      !deadline ||
      !deadline.enumerable ||
      !('value' in deadline) ||
      typeof deadline.value !== 'number' ||
      !Number.isFinite(deadline.value) ||
      !signal ||
      !signal.enumerable ||
      !('value' in signal) ||
      signal.value === null ||
      typeof signal.value !== 'object' ||
      utilTypes.isProxy(signal.value)
    ) {
      fail('invalid_input');
    }
    nativeAbortSignalAbortedGetter.call(signal.value);
    return { deadline: deadline.value, signal: signal.value as AbortSignal };
  } catch (error) {
    if (error instanceof AssistantFinalPlanFailure) throw error;
    fail('invalid_input');
  }
}

class StickyPlannerCheck {
  private callbackFailed = false;
  private callbackFailure: unknown;
  private stopFailure: AssistantFinalPlanFailure | undefined;
  private work: WorkState | undefined;

  constructor(private readonly callback: () => void) {}

  start(): void {
    if (
      typeof this.callback !== 'function' ||
      utilTypes.isProxy(this.callback) ||
      utilTypes.isAsyncFunction(this.callback)
    ) {
      fail('invalid_input');
    }
    this.invokeCallback();
  }

  setWork(value: unknown): void {
    this.work = readWork(value);
  }

  check = (): void => {
    if (this.callbackFailed) throw this.callbackFailure;
    if (this.stopFailure) throw this.stopFailure;
    try {
      this.runtimeCheck();
      this.invokeCallback();
      this.runtimeCheck();
    } catch (error) {
      if (this.callbackFailed) throw this.callbackFailure;
      if (error instanceof AssistantFinalPlanFailure) {
        this.stopFailure = error;
        throw error;
      }
      const mapped = new AssistantFinalPlanFailure('invalid_input');
      this.stopFailure = mapped;
      throw mapped;
    }
  };

  rethrowCallbackFailure(): void {
    if (this.callbackFailed) throw this.callbackFailure;
  }

  getStopFailure(): AssistantFinalPlanFailure | undefined {
    return this.stopFailure;
  }

  private invokeCallback(): void {
    if (this.callbackFailed) throw this.callbackFailure;
    try {
      this.callback();
    } catch (error) {
      this.callbackFailed = true;
      this.callbackFailure = error;
      throw error;
    }
  }

  private runtimeCheck(): void {
    const work = this.work;
    if (!work) return;
    if (nativeAbortSignalAbortedGetter?.call(work.signal)) fail('budget_exhausted');
    const now = performance.now();
    if (!Number.isFinite(now)) fail('invalid_input');
    if (now >= work.deadline) fail('budget_exhausted');
  }
}

function ownedPlanData(
  value: unknown,
  check: () => void,
): AutonomousPersonalAssistantFinalPlanDataV4 {
  let owned: unknown;
  try {
    owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  } catch (error) {
    check();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      fail('capacity');
    }
    fail('invalid_input');
  }
  check();
  let parsed;
  try {
    parsed = AutonomousPersonalAssistantFinalPlanDataV4OwnedDataSchema.safeParse(owned);
  } catch {
    check();
    fail('invalid_input');
  }
  check();
  if (!parsed.success || !same(owned, parsed.data)) fail('invalid_input');
  return parsed.data;
}

function ownedGraph(value: unknown, check: () => void): GraphData {
  check();
  try {
    // Never mutated: the candidate below is a fresh full parse of spread copies.
    const graph = getOwnedImmutableGraphData(value) ?? parseLosslessAutomaticCaptureGraph(value);
    check();
    return graph;
  } catch (error) {
    check();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      fail('capacity');
    }
    fail('invalid_input');
  }
}

function parentReference(plan: AutonomousPersonalAssistantFinalPlanDataV4) {
  const identity = plan.origin.identity;
  return AssistantWriteAuthorityReferenceV4Schema.parse({
    kind: 'owned_human_turn_v4',
    parentFamily: 'autonomous-personal-v1',
    parentOperationId: plan.origin.terminalReceipt.operationId,
    sourceId: identity.sourceId,
    sourceHash: identity.sourceHash,
    descriptorHash: identity.descriptorHash,
    requestedAuthorityHash: identity.requestedAuthorityHash,
  });
}

function descriptorFor(
  plan: AutonomousPersonalAssistantFinalPlanDataV4,
): AutomaticOperationDescriptorV2 {
  const settings = AutonomousPersonalAssistantDescriptorSettingsV4Schema.parse({
    lifecycle: 'replaySafeV2',
    purpose: 'assistant_final_save',
    interpreterId: 'assistant-final-write-v1',
    semanticVersion: 1,
    grammarVersion: null,
    lexiconVersion: null,
    requestedTrustLevel: null,
    intentSetting: null,
    invocationDeadlineMs: plan.intent.invocationDeadlineMs,
    policy: null,
    assistantWriteAuthority: parentReference(plan),
  });
  return AutomaticOperationDescriptorV2Schema.parse({
    version: 2,
    lifecycle: settings.lifecycle,
    purpose: settings.purpose,
    executionMode: 'synchronous',
    interpreterId: settings.interpreterId,
    semanticVersion: settings.semanticVersion,
    grammarVersion: settings.grammarVersion,
    lexiconVersion: settings.lexiconVersion,
    requestedTrustLevel: settings.requestedTrustLevel,
    intentSetting: settings.intentSetting,
    invocationDeadlineMs: settings.invocationDeadlineMs,
    policy: settings.policy,
    assistantWriteAuthority: settings.assistantWriteAuthority,
    // The V4 settings object has the exact stored V2 settings fields and uses
    // the established V2 canonical hash recipe. The old V2 input parser remains
    // V2-only; this parsed descriptor is the stored representation.
    settingsHash: hashAutomaticCaptureV2(settings),
  });
}

function parentEpisode(
  graph: GraphData,
  plan: AutonomousPersonalAssistantFinalPlanDataV4,
  check: () => void,
): EpisodicNode {
  let found: EpisodicNode | undefined;
  for (const episode of graph.episodes) {
    check();
    if (episode.uuid === plan.origin.identity.sourceId) {
      if (found) fail('conflict');
      found = episode;
    }
  }
  check();
  if (!found) fail('authority_changed');
  const observation = plan.intent.humanObservation;
  if (
    observation.kind === 'message' &&
    observation.content !== plan.nativeSnapshot.config.currentHumanQuery &&
    observation.content !== found.content
  ) {
    fail('conflict');
  }
  return found;
}

function latestNamespaceTail(
  graph: GraphData,
  namespace: string,
  backendNow: string,
  check: () => void,
): string | null {
  const episodes: EpisodicNode[] = [];
  const referencedPredecessors = new Set<string>();
  for (const episode of graph.episodes) {
    check();
    if (episode.group_id !== namespace) continue;
    episodes.push(episode);
    if (episode.previous_episode_uuid) referencedPredecessors.add(episode.previous_episode_uuid);
  }
  check();
  let latestAny: EpisodicNode | undefined;
  let latestTail: EpisodicNode | undefined;
  for (const episode of episodes) {
    check();
    if (!latestAny || afterInStableOrder(episode, latestAny)) latestAny = episode;
    if (
      !referencedPredecessors.has(episode.uuid) &&
      (!latestTail || afterInStableOrder(episode, latestTail))
    ) {
      latestTail = episode;
    }
  }
  check();
  const previous = latestTail ?? latestAny;
  if (previous && Date.parse(previous.created_at) > Date.parse(backendNow)) {
    // The candidate may not precede its selected same-namespace chain tail.
    fail('clock_regression');
  }
  return previous?.uuid ?? null;
}

function afterInStableOrder(left: EpisodicNode, right: EpisodicNode): boolean {
  const leftTime = Date.parse(left.created_at);
  const rightTime = Date.parse(right.created_at);
  if (leftTime !== rightTime) return leftTime > rightTime;
  // The same stable UUID tie-break is available in both backend graph snapshots.
  return left.uuid > right.uuid;
}

function buildAssistantEpisode(
  graph: GraphData,
  plan: AutonomousPersonalAssistantFinalPlanDataV4,
  descriptor: AutomaticOperationDescriptorV2,
  backendNow: string,
  check: () => void,
): EpisodicNode {
  check();
  const producer = plan.intent.finalAssistant;
  const referenceTime =
    producer.eventTime.mode === 'explicit' ? producer.eventTime.value : backendNow;
  const episode = EpisodicNodeSchema.parse({
    uuid: plan.sourceId,
    group_id: plan.nativeSnapshot.config.namespace,
    content: producer.content,
    role: 'ai',
    source_type: producer.sourceType,
    reference_time: referenceTime,
    created_at: backendNow,
    updated_at: backendNow,
    previous_episode_uuid: latestNamespaceTail(
      graph,
      plan.nativeSnapshot.config.namespace,
      backendNow,
      check,
    ),
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
      turn: plan.nativeSnapshot.config.turn,
      role: 'assistant',
    }),
    episode_kind: 'assistant_reply',
    attributes: {},
  });
  check();
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = AutomaticCaptureSourceOwnerStoredV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: plan.nativeSnapshot.config.storeHash,
    namespace: plan.nativeSnapshot.config.namespace,
    turn: plan.nativeSnapshot.config.turn,
    role: 'assistant',
    issuer: plan.nativeSnapshot.config.issuer,
    actorReference: plan.nativeSnapshot.config.actorReference,
    binding: null,
    assistantWriteAuthority: descriptor.assistantWriteAuthority,
    purpose: 'assistant_final_save',
    requestedTrustLevel: null,
    intentSetting: null,
    intentEvidence: null,
    eventTimeMode: producer.eventTime.mode,
    eventTimeHash: hashAutomaticCaptureV2({
      mode: producer.eventTime.mode,
      normalizedReferenceTime: new Date(Date.parse(referenceTime)).toISOString(),
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
    sourceContentHash: createHash('sha256').update(producer.content, 'utf8').digest('hex'),
    settingsHash: descriptor.settingsHash,
    policy: null,
  });
  const validated = prepareAutomaticEpisodeInput(episode);
  check();
  return validated;
}

function sameFinalSource(
  source: EpisodicNode,
  plan: AutonomousPersonalAssistantFinalPlanDataV4,
  descriptor: AutomaticOperationDescriptorV2,
): boolean {
  const producer = plan.intent.finalAssistant;
  try {
    const owner = AutomaticCaptureSourceOwnerStoredV2Schema.parse(
      source.attributes[WRITE_OWNER_V2_ATTRIBUTE],
    );
    return (
      owner.purpose === 'assistant_final_save' &&
      owner.storeHash === plan.nativeSnapshot.config.storeHash &&
      owner.namespace === plan.nativeSnapshot.config.namespace &&
      owner.issuer === plan.nativeSnapshot.config.issuer &&
      owner.actorReference === plan.nativeSnapshot.config.actorReference &&
      owner.turn === plan.nativeSnapshot.config.turn &&
      owner.assistantWriteAuthority.kind === 'owned_human_turn_v4' &&
      same(owner.assistantWriteAuthority, descriptor.assistantWriteAuthority) &&
      owner.settingsHash === descriptor.settingsHash &&
      owner.eventTimeMode === producer.eventTime.mode &&
      source.group_id === plan.nativeSnapshot.config.namespace &&
      source.role === 'ai' &&
      source.episode_kind === 'assistant_reply' &&
      source.source_type === producer.sourceType &&
      source.content === producer.content &&
      source.source_message_id === producer.sourceMessageId &&
      source.conversation_id === producer.conversationId &&
      source.sender_id === producer.senderId &&
      source.sender_name === producer.senderName &&
      source.source_workflow_id === producer.sourceWorkflowId &&
      source.source_execution_id === producer.originalSourceExecutionId &&
      source.quoted_message_id === producer.quotedMessageId &&
      source.idempotency_key ===
        automaticWriteOwnerIdempotencyKey({
          turn: plan.nativeSnapshot.config.turn,
          role: 'assistant',
        }) &&
      (producer.eventTime.mode !== 'explicit' || source.reference_time === producer.eventTime.value)
    );
  } catch {
    return false;
  }
}

function sourceIdentityMatchesOperation(
  source: EpisodicNode,
  operation: Extract<
    NonNullable<GraphData['automatic_operations_v1']>['operations'][number],
    { version: 2 }
  >,
): boolean {
  try {
    const observed = autonomousPersonalAssistantOperationIdentityV4(source, operation.descriptor);
    const reconciled = reconcileAutomaticCaptureOperationIdentity(observed, operation.identity);
    return reconciled !== null && same(reconciled, operation.identity);
  } catch {
    return false;
  }
}

function existingAssistantRows(
  graph: GraphData,
  plan: AutonomousPersonalAssistantFinalPlanDataV4,
  check: () => void,
): {
  sources: EpisodicNode[];
  operations: NonNullable<GraphData['automatic_operations_v1']>['operations'];
} {
  const config = plan.nativeSnapshot.config;
  const idempotencyKey = automaticWriteOwnerIdempotencyKey({
    turn: config.turn,
    role: 'assistant',
  });
  const sources: EpisodicNode[] = [];
  for (const source of graph.episodes) {
    check();
    if (source.group_id === config.namespace && source.idempotency_key === idempotencyKey) {
      sources.push(source);
    }
  }
  const operations: NonNullable<GraphData['automatic_operations_v1']>['operations'] = [];
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (
      operation.identity.namespace === config.namespace &&
      operation.identity.turn === config.turn &&
      operation.identity.role === 'assistant'
    ) {
      operations.push(operation);
    }
  }
  return { sources, operations };
}

function inspectExistingAssistant(
  graph: GraphData,
  plan: AutonomousPersonalAssistantFinalPlanDataV4,
  descriptor: AutomaticOperationDescriptorV2,
  check: () => void,
):
  | { kind: 'none' }
  | { kind: 'replay'; terminalReceipt: z.infer<typeof AutomaticCaptureTerminalReceiptV2Schema> }
  | { kind: 'decision'; reason: DecisionReason } {
  const { sources, operations } = existingAssistantRows(graph, plan, check);
  if (sources.length > 1 || operations.length > 1) return { kind: 'decision', reason: 'conflict' };
  if (sources.length === 0 && operations.length === 0) return { kind: 'none' };
  const source = sources[0];
  const operation = operations[0];
  if (source && !operation) return { kind: 'decision', reason: 'source_only_unconfirmed' };
  if (operation?.version === 1) return { kind: 'decision', reason: 'legacy_unconfirmed' };
  if (!source || !operation || operation.version !== 2) {
    return { kind: 'decision', reason: 'conflict' };
  }
  if (operation.state === 'leased') return { kind: 'decision', reason: 'in_progress' };
  if (operation.state === 'cancelled') return { kind: 'decision', reason: 'cancelled_replay' };
  if (operation.state !== 'committed' || !sameFinalSource(source, plan, descriptor)) {
    return { kind: 'decision', reason: 'conflict' };
  }
  if (
    !same(operation.descriptor, descriptor) ||
    operation.identity.purpose !== 'assistant_final_save' ||
    operation.identity.sourceId !== source.uuid
  ) {
    return { kind: 'decision', reason: 'conflict' };
  }
  if (!sourceIdentityMatchesOperation(source, operation)) {
    return { kind: 'decision', reason: 'conflict' };
  }
  const receipt = AutomaticCaptureTerminalReceiptV2Schema.safeParse(operation.terminalReceipt);
  if (
    !receipt.success ||
    receipt.data.kind !== 'assistant_final_saved' ||
    receipt.data.operationId !== operation.operationId ||
    receipt.data.sourceId !== source.uuid ||
    receipt.data.sourceHash !== operation.identity.sourceHash ||
    receipt.data.descriptorHash !== hashAutomaticCaptureV2(operation.descriptor)
  ) {
    return { kind: 'decision', reason: 'conflict' };
  }
  check();
  return { kind: 'replay', terminalReceipt: receipt.data };
}

function assertUnusedIds(
  graph: GraphData,
  plan: AutonomousPersonalAssistantFinalPlanDataV4,
  check: () => void,
): void {
  const { sourceId, operationId } = plan;
  if (sourceId === operationId) fail('conflict');
  for (const records of [graph.entities, graph.edges, graph.episodes]) {
    for (const record of records) {
      check();
      if (record.uuid === sourceId || record.uuid === operationId) fail('conflict');
    }
  }
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (operation.operationId === sourceId || operation.operationId === operationId)
      fail('conflict');
  }
}

function freezeData<T>(value: T, check: () => void): T {
  check();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeData(child, check);
    Object.freeze(value);
  }
  return value;
}

function mapParentFailure(error: unknown): DecisionReason {
  if (!(error instanceof AutonomousPersonalMemoryParentIntegrityV4Error)) return 'conflict';
  switch (error.reason) {
    case 'unsupported_mode':
      return 'unsupported_mode';
    case 'authority_changed':
      return 'authority_changed';
    case 'clock_regression':
      return 'clock_regression';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'resource_exhausted':
      return 'capacity';
    case 'storage_unavailable':
      return 'storage_error';
    case 'invalid_configuration':
      return 'invalid_input';
    case 'invalid_lineage':
    case 'parent_not_found':
    case 'parent_mismatch':
    case 'invalid_snapshot':
      return 'conflict';
  }
}

function mapPlanningFailure(error: unknown, check: StickyPlannerCheck): DecisionReason {
  check.rethrowCallbackFailure();
  const stop = check.getStopFailure();
  if (stop) return stop.reason;
  if (error instanceof AssistantFinalPlanFailure) return error.reason;
  if (error instanceof AutonomousPersonalMemoryParentIntegrityV4Error)
    return mapParentFailure(error);
  if (error instanceof AutonomousPersonalRecordIntegrityV4Error) {
    return error.reason === 'snapshot_capacity' ? 'capacity' : 'conflict';
  }
  if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
    return 'capacity';
  }
  return 'invalid_input';
}

function validateCurrentSnapshot(
  graphValue: unknown,
  planValue: unknown,
  backendNowValue: unknown,
  workValue: unknown,
  control: StickyPlannerCheck,
): {
  graph: GraphData;
  plan: AutonomousPersonalAssistantFinalPlanDataV4;
  backendNow: string;
  check: () => void;
} {
  control.start();
  control.setWork(workValue);
  const check = control.check;
  check();
  const plan = ownedPlanData(planValue, check);
  let backendNow: string;
  try {
    backendNow = z.string().datetime().parse(backendNowValue);
  } catch {
    check();
    fail('invalid_input');
  }
  check();
  const graph = ownedGraph(graphValue, check);
  assertAssistantGraphIntegrity(
    graph,
    workValue as AutonomousPersonalTypedSyntaxWorkV1,
    check,
    control,
  );
  try {
    assertAutonomousPersonalMemoryCurrentParentGraphV4(
      graph,
      plan.origin,
      plan.nativeSnapshot.config,
      backendNow,
      check,
    );
  } catch (error) {
    control.rethrowCallbackFailure();
    if (error instanceof AutonomousPersonalMemoryParentIntegrityV4Error) {
      throw new AssistantFinalPlanFailure(mapParentFailure(error));
    }
    throw error;
  }
  check();
  parentEpisode(graph, plan, check);
  return { graph, plan, backendNow, check };
}

function assertAssistantGraphIntegrity(
  graph: GraphData,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  check: () => void,
  control: StickyPlannerCheck,
): void {
  try {
    assertAutomaticLedgerSourceIntegrity(graph, check);
    check();
    assertAutomaticBindingRegistryIntegrity(graph, check);
    check();
    assertAutonomousPersonalRecordIntegrityV4(graph, typedSyntaxWork, check);
    check();
  } catch (error) {
    control.rethrowCallbackFailure();
    if (error instanceof AssistantFinalPlanFailure) throw error;
    if (
      error instanceof AutonomousPersonalRecordIntegrityV4Error &&
      error.reason === 'snapshot_capacity'
    ) {
      fail('capacity');
    }
    fail('conflict');
  }
}

function asPreparationResult(value: unknown): AutonomousPersonalAssistantFinalPreparationV4 {
  return AutonomousPersonalAssistantFinalPreparationV4OwnedDataSchema.parse(value);
}

function asReconciliationResult(value: unknown): AutonomousPersonalAssistantFinalReconciliationV4 {
  return AutonomousPersonalAssistantFinalReconciliationV4OwnedDataSchema.parse(value);
}

/** Pure DATA planner for one atomic assistant-source / committed-operation candidate. */
export function prepareAutonomousPersonalAssistantFinalV4(
  graphValue: unknown,
  planDataValue: unknown,
  backendNow: string,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  trustedCheck: () => void,
): AutonomousPersonalAssistantFinalPreparationV4 {
  const control = new StickyPlannerCheck(trustedCheck);
  try {
    const validated = validateCurrentSnapshot(
      graphValue,
      planDataValue,
      backendNow,
      typedSyntaxWork,
      control,
    );
    const { graph, plan, backendNow: capturedAt, check } = validated;
    check();
    const descriptor = descriptorFor(plan);
    check();
    const existing = inspectExistingAssistant(graph, plan, descriptor, check);
    if (existing.kind === 'replay') {
      return freezeData(asPreparationResult(existing), check);
    }
    if (existing.kind === 'decision') {
      return freezeData(asPreparationResult(existing), check);
    }
    assertUnusedIds(graph, plan, check);
    check();

    const episode = buildAssistantEpisode(graph, plan, descriptor, capturedAt, check);
    const identity: AutomaticOperationIdentityV2 = autonomousPersonalAssistantOperationIdentityV4(
      episode,
      descriptor,
    );
    const descriptorHash = hashAutomaticCaptureV2(descriptor);
    const terminalReceipt = AutomaticCaptureTerminalReceiptV2Schema.parse({
      version: 2,
      kind: 'assistant_final_saved',
      operationId: plan.operationId,
      sourceId: episode.uuid,
      sourceHash: identity.sourceHash,
      descriptorHash,
      terminalAt: capturedAt,
      persisted: true,
    });
    const operation = AutomaticCaptureOperationV2Schema.parse({
      version: 2,
      operationId: plan.operationId,
      identity,
      descriptor,
      createdAt: capturedAt,
      lastObservedAt: capturedAt,
      attempts: [
        { attemptHash: plan.intent.memoryAttemptHash, at: capturedAt, disposition: 'claim_won' },
      ],
      overflowCount: 0,
      auditTruncated: false,
      beginCallHash: plan.beginCallHash,
      retryCount: 0,
      state: 'committed',
      generation: 1,
      completionCallHash: plan.completionCallHash,
      terminalReceipt,
    });
    check();

    let candidate: GraphData;
    try {
      candidate = parseLosslessAutomaticCaptureGraph({
        ...graph,
        episodes: [...graph.episodes, episode],
        automatic_operations_v1: {
          version: 1,
          operations: [...(graph.automatic_operations_v1?.operations ?? []), operation],
        },
      });
    } catch (error) {
      if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
        fail('capacity');
      }
      fail('conflict');
    }
    check();
    assertAssistantGraphIntegrity(candidate, typedSyntaxWork, check, control);
    if (!hasAutomaticCaptureCapacity(candidate, check)) fail('capacity');
    check();
    const result = asPreparationResult({ kind: 'candidate', graph: candidate, terminalReceipt });
    check();
    return freezeData(result, check);
  } catch (error) {
    control.rethrowCallbackFailure();
    const reason = mapPlanningFailure(error, control);
    return Object.freeze(asPreparationResult({ kind: 'decision', reason }));
  }
}

/** Reconciles only the exact source, operation IDs, and call hashes allocated for one call. */
export function reconcileAutonomousPersonalAssistantFinalV4(
  graphValue: unknown,
  planDataValue: unknown,
  backendNow: string,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  trustedCheck: () => void,
): AutonomousPersonalAssistantFinalReconciliationV4 {
  const control = new StickyPlannerCheck(trustedCheck);
  try {
    const validated = validateCurrentSnapshot(
      graphValue,
      planDataValue,
      backendNow,
      typedSyntaxWork,
      control,
    );
    const { graph, plan, check } = validated;
    check();
    const descriptor = descriptorFor(plan);
    const { sources, operations } = existingAssistantRows(graph, plan, check);
    if (sources.length !== 1 || operations.length !== 1) {
      return freezeData(asReconciliationResult({ kind: 'unconfirmed' }), check);
    }
    const source = sources[0]!;
    const operation = operations[0]!;
    if (
      operation.version !== 2 ||
      operation.state !== 'committed' ||
      source.uuid !== plan.sourceId ||
      operation.operationId !== plan.operationId ||
      operation.beginCallHash !== plan.beginCallHash ||
      operation.completionCallHash !== plan.completionCallHash ||
      !same(operation.descriptor, descriptor) ||
      !sameFinalSource(source, plan, descriptor) ||
      operation.identity.sourceId !== source.uuid
    ) {
      return freezeData(asReconciliationResult({ kind: 'unconfirmed' }), check);
    }
    if (!sourceIdentityMatchesOperation(source, operation)) {
      return freezeData(asReconciliationResult({ kind: 'unconfirmed' }), check);
    }
    const receipt = AutomaticCaptureTerminalReceiptV2Schema.safeParse(operation.terminalReceipt);
    if (
      !receipt.success ||
      receipt.data.kind !== 'assistant_final_saved' ||
      receipt.data.operationId !== plan.operationId ||
      receipt.data.sourceId !== plan.sourceId ||
      receipt.data.sourceHash !== operation.identity.sourceHash ||
      receipt.data.descriptorHash !== hashAutomaticCaptureV2(operation.descriptor)
    ) {
      return freezeData(asReconciliationResult({ kind: 'unconfirmed' }), check);
    }
    check();
    return freezeData(
      asReconciliationResult({ kind: 'matched', terminalReceipt: receipt.data }),
      check,
    );
  } catch (error) {
    control.rethrowCallbackFailure();
    return Object.freeze(asReconciliationResult({ kind: 'unconfirmed' }));
  }
}
