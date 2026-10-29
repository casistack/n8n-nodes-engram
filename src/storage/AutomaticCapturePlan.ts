import { StagedExtractionSchema, type GraphData, type StagedExtraction } from '../schemas';
import { AutomaticCaptureOperationV2Schema } from '../schemas/AutomaticCaptureOperation.schema';
import {
  hashAutomaticCaptureV2,
  canonicalAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import { validateAutomaticPlanAt } from '../extraction/AutomaticClaims';
import { canonical, graphFingerprint, sourceFingerprint } from '../extraction/QueueState';
import type {
  AutomaticCaptureHandleRegistry,
  AutomaticCaptureLeaseFenceV2,
  PrivateConsumedAutomaticCaptureInvocation,
} from './AutomaticCaptureHandles';
import {
  assertAutomaticLedgerSourceIntegrity,
  automaticCaptureOperationIdentityForOwnedSource,
  reconcileAutomaticCaptureOperationIdentity,
  WRITE_OWNER_V2_ATTRIBUTE,
} from './AutomaticIdentity';

function invalidPlan(): never {
  throw new Error('Engram automatic memory: invalid_plan');
}

function parseBoundedGraph(value: unknown): GraphData {
  try {
    return parseLosslessAutomaticCaptureGraph(value);
  } catch {
    return invalidPlan();
  }
}

function sameLeaseFence(
  operation: ReturnType<typeof AutomaticCaptureOperationV2Schema.parse>,
  expected: AutomaticCaptureLeaseFenceV2,
): boolean {
  return (
    operation.state === 'leased' &&
    operation.identity.purpose === 'human_turn_memory' &&
    operation.identity.sourceId === expected.sourceId &&
    operation.operationId === expected.operationId &&
    hashAutomaticCaptureV2(operation.identity) === expected.identityHash &&
    hashAutomaticCaptureV2(operation.descriptor) === expected.descriptorHash &&
    operation.beginCallHash === expected.beginCallHash &&
    operation.generation === expected.generation &&
    operation.lease.token === expected.token &&
    operation.lease.claimKind === expected.claimKind &&
    operation.lease.renewedAt === expected.planTimestamp &&
    operation.retryCount === expected.retryCount &&
    operation.lastRetryCallHash === expected.lastRetryCallHash
  );
}

function assertNewIdsOnly(graph: GraphData, plan: StagedExtraction): void {
  const storedIds = new Set([
    ...graph.entities.map((record) => record.uuid),
    ...graph.edges.map((record) => record.uuid),
    ...graph.episodes.map((record) => record.uuid),
  ]);
  const stagedIds = new Set<string>();
  for (const item of [...plan.entities, ...plan.edges]) {
    if (storedIds.has(item.uuid) || stagedIds.has(item.uuid)) invalidPlan();
    stagedIds.add(item.uuid);
    if (item.group_id !== plan.group_id) invalidPlan();
  }

  const availableEntities = new Set([
    ...graph.entities
      .filter((entity) => entity.group_id === plan.group_id)
      .map((entity) => entity.uuid),
    ...plan.entities.map((entity) => entity.uuid),
  ]);
  for (const edge of plan.edges) {
    if (
      !availableEntities.has(edge.source_node_uuid) ||
      !availableEntities.has(edge.target_node_uuid)
    ) {
      invalidPlan();
    }
  }
}

/**
 * Applies only reconstructed literal-v1 creations for the one human source bound
 * to a consumed backend capability. This function verifies graph/fence structure,
 * but the backend caller must already have checked the current transaction clock,
 * lease expiry, current authority, store identity, and transaction ownership.
 *
 * Existing public `applyPlan` remains the legacy path and continues rejecting
 * V2-owned sources. This path never updates or replaces an existing graph row.
 */
export function applyHumanLiteralPlanV2(
  graphInput: GraphData,
  planInput: StagedExtraction,
  registry: AutomaticCaptureHandleRegistry,
  capability: PrivateConsumedAutomaticCaptureInvocation<'human_turn_memory'>,
): StagedExtraction {
  const invocation = registry.readConsumedInvocation(capability, 'human_turn_memory');
  const boundFence = invocation.boundFence;
  const graph = parseBoundedGraph(graphInput);

  const operations = graph.automatic_operations_v1?.operations ?? [];
  const matchingOperations = operations.filter(
    (operation) => operation.operationId === boundFence.operationId,
  );
  if (matchingOperations.length !== 1) invalidPlan();
  const parsedOperation = AutomaticCaptureOperationV2Schema.safeParse(matchingOperations[0]);
  if (!parsedOperation.success || !sameLeaseFence(parsedOperation.data, boundFence)) invalidPlan();
  const operation = parsedOperation.data;

  const sources = graph.episodes.filter((episode) => episode.uuid === boundFence.sourceId);
  if (sources.length !== 1) invalidPlan();
  const source = sources[0];
  if (
    source.group_id !== operation.identity.namespace ||
    source.role !== 'human' ||
    !Object.prototype.hasOwnProperty.call(source.attributes, WRITE_OWNER_V2_ATTRIBUTE)
  ) {
    invalidPlan();
  }

  try {
    const observedIdentity = automaticCaptureOperationIdentityForOwnedSource(
      source,
      operation.descriptor,
    );
    const reconciled = reconcileAutomaticCaptureOperationIdentity(
      observedIdentity,
      operation.identity,
    );
    if (
      !reconciled ||
      canonicalAutomaticCaptureV2(reconciled) !== canonicalAutomaticCaptureV2(operation.identity)
    )
      invalidPlan();
    assertAutomaticLedgerSourceIntegrity(graph);
  } catch {
    invalidPlan();
  }

  let ownedPlanInput: unknown;
  try {
    ownedPlanInput = cloneBoundedAutomaticCaptureJson<unknown>(planInput, 'plan');
  } catch {
    invalidPlan();
  }
  let plan: StagedExtraction;
  try {
    plan = StagedExtractionSchema.parse(ownedPlanInput);
  } catch {
    invalidPlan();
  }
  if (plan.entities.length > 64 || plan.edges.length > 128) invalidPlan();

  if (
    plan.group_id !== operation.identity.namespace ||
    plan.source_guards.length !== 1 ||
    plan.source_guards[0].uuid !== source.uuid ||
    plan.source_guards[0].hash !== sourceFingerprint(source) ||
    graphFingerprint(graph, plan.group_id) !== plan.graph_hash
  ) {
    invalidPlan();
  }

  try {
    if (!validateAutomaticPlanAt(graph, plan, boundFence.planTimestamp)) invalidPlan();
  } catch (error) {
    if (error instanceof ExtractionBudgetError) throw error;
    invalidPlan();
  }

  assertNewIdsOnly(graph, plan);

  // Keep graph-published rows separate from the returned validated plan. Zod's
  // `unknown` attribute values can otherwise preserve references to nested input.
  let graphPlan: StagedExtraction;
  try {
    graphPlan = cloneBoundedAutomaticCaptureJson<StagedExtraction>(plan, 'plan');
  } catch {
    invalidPlan();
  }

  // Parse a detached whole-graph candidate before publishing either changed array.
  // GraphDataSchema performs the ledger/root structural checks; the explicit
  // integrity assertion also verifies source/operation linkage in the candidate.
  let candidate: GraphData;
  try {
    candidate = parseLosslessAutomaticCaptureGraph({
      ...graph,
      entities: [...graph.entities, ...graphPlan.entities],
      edges: [...graph.edges, ...graphPlan.edges],
    });
    assertAutomaticLedgerSourceIntegrity(candidate);
  } catch {
    invalidPlan();
  }

  if (
    canonical(candidate.entities.slice(0, graph.entities.length)) !== canonical(graph.entities) ||
    canonical(candidate.edges.slice(0, graph.edges.length)) !== canonical(graph.edges)
  ) {
    invalidPlan();
  }

  graphInput.entities = candidate.entities;
  graphInput.edges = candidate.edges;
  return plan;
}
