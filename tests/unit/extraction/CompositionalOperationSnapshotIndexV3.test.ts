import { makeCompositionalCaptureFixture } from '../../helpers/compositionalCaptureFixture';
import { buildCompositionalHumanCaptureSourceV3 } from '../../../src/storage/CompositionalAutomaticCaptureSourceV3';
import { CompositionalAutomaticCaptureOperationV3Schema } from '../../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import { interpretCompositionalHumanSourceV3EvidenceWithExecutionReport } from '../../../src/extraction/CompositionalAutomaticCaptureV3Evidence';
import { projectCompositionalPreferenceV2Meaning } from '../../../src/extraction/CompositionalPreferenceV2Meaning';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import * as BoundedJson from '../../../src/storage/BoundedAutomaticCaptureJson';
import * as Identity from '../../../src/storage/AutomaticIdentity';
import * as Lossless from '../../../src/storage/LosslessAutomaticCaptureGraph';
import {
  CompositionalSnapshotIndexErrorV3,
  createCompositionalOperationSnapshotIndexV3,
  getOwnedCompositionalSnapshotV3,
} from '../../../src/extraction/CompositionalSnapshotIndexV3';
import { createCompositionalOverlapBatchInspectorV3 } from '../../../src/extraction/CompositionalOverlapBatchV3';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { EntityEdgeSchema } from '../../../src/schemas/EntityEdge.schema';
import { getAutomaticClaimReadScope } from '../../../src/storage/AutomaticClaimReadScope';
import type { GraphData } from '../../../src/schemas';
import type { CompositionalAutomaticClaimMeaningV2 } from '../../../src/schemas/CompositionalAutomaticMemory.schema';

const NOW = '2026-10-25T12:00:03.000Z';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function claimMeaning(graph: GraphData): CompositionalAutomaticClaimMeaningV2 {
  const claim = graph.edges[0]?.attributes.engram_claim_v1 as
    | { meaning?: CompositionalAutomaticClaimMeaningV2 }
    | undefined;
  if (!claim?.meaning) throw new Error('Expected committed compositional claim fixture');
  return claim.meaning;
}

function selector(f: ReturnType<typeof makeCompositionalCommittedClaimFixture>) {
  return { namespace: f.request.namespace, operationId: f.operation.operationId };
}

function operationFailureReason(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof CompositionalSnapshotIndexErrorV3 ? error.reason : 'other';
  }
}

describe('V3 operation-selected immutable snapshot index (read data only)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('derives the subject from the selected committed human V3 operation without a caller subject selector', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const token = createCompositionalOperationSnapshotIndexV3(f.graph, selector(f), scope);
    const view = getOwnedCompositionalSnapshotV3(token);

    expect(view).not.toBeNull();
    expect(view?.subjectId).toBe(f.operation.identity.binding.subjectId);
    expect(view?.subject.uuid).toBe(f.operation.identity.binding.subjectId);
    expect(view?.operation(f.operation.operationId)).toEqual(f.operation);
    expect(Object.keys(token)).toEqual([]);
    expect(Object.isFrozen(view?.graph)).toBe(true);
    expect(getOwnedCompositionalSnapshotV3({ ...token })).toBeNull();

    const withCallerSubject = { ...selector(f), subjectId: view!.subjectId };
    expect(() =>
      createCompositionalOperationSnapshotIndexV3(
        f.graph,
        withCallerSubject,
        getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
      ),
    ).toThrow();
  });

  it('fails closed for missing, cross-namespace, and non-V3 operation selectors', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const missingScope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    expect(
      operationFailureReason(() =>
        createCompositionalOperationSnapshotIndexV3(
          f.graph,
          { ...selector(f), operationId: randomUUID() },
          missingScope,
        ),
      ),
    ).toBe('missing_operation');

    const wrongNamespaceScope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    expect(
      operationFailureReason(() =>
        createCompositionalOperationSnapshotIndexV3(
          f.graph,
          { ...selector(f), namespace: `${f.request.namespace}-other` },
          wrongNamespaceScope,
        ),
      ),
    ).toBe('missing_operation');

    const v2 = makeHumanFixture(f.request.namespace);
    const v2Scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    expect(
      operationFailureReason(() =>
        createCompositionalOperationSnapshotIndexV3(
          v2.graph,
          { namespace: f.request.namespace, operationId: v2.humanOperation.operationId },
          v2Scope,
        ),
      ),
    ).toBe('unsupported_mode');
  });

  it('rejects copied index tokens and indexes from a different read scope', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const token = createCompositionalOperationSnapshotIndexV3(f.graph, selector(f), scope);
    const request = {
      namespace: f.request.namespace,
      subjectId: f.operation.identity.binding.subjectId,
      meanings: [claimMeaning(f.graph)],
    };
    const inspector = createCompositionalOverlapBatchInspectorV3();

    expect(inspector.prepareFromOwnedIndex({ ...token }, request, { budget, now: NOW })).toEqual({
      status: 'incomplete',
      reason: 'invalid_batch',
    });
    expect(
      inspector.prepareFromOwnedIndex(token, request, {
        budget: { remaining: 512, deferred: 0 },
        now: NOW,
      }),
    ).toEqual({ status: 'incomplete', reason: 'invalid_resources' });
    expect(budget.remaining).toBe(512);
  });

  it('does not clone an expired scope and starts its deadline before admission work', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const clone = jest.spyOn(BoundedJson, 'cloneBoundedAutomaticCaptureJson');
    const graphClone = jest.spyOn(Lossless, 'parseLosslessAutomaticCaptureGraph');
    clock.mockReturnValue(6000);

    expect(
      operationFailureReason(() =>
        createCompositionalOperationSnapshotIndexV3(f.graph, selector(f), scope),
      ),
    ).toBe('budget_exhausted');
    expect(clone).not.toHaveBeenCalled();
    expect(graphClone).not.toHaveBeenCalled();
  });

  it('never invokes graph, source, selector or proxy accessors while cloning input', () => {
    const f = makeCompositionalCommittedClaimFixture();
    let selectorReads = 0;
    const hostileSelector = Object.defineProperty(
      { operationId: f.operation.operationId },
      'namespace',
      {
        enumerable: true,
        get() {
          selectorReads += 1;
          return f.request.namespace;
        },
      },
    );
    expect(() =>
      createCompositionalOperationSnapshotIndexV3(
        f.graph,
        hostileSelector,
        getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
      ),
    ).toThrow();
    expect(selectorReads).toBe(0);

    const hostileGraph = copy(f.graph) as GraphData;
    let sourceReads = 0;
    Object.defineProperty(hostileGraph.episodes[0], 'content', {
      enumerable: true,
      configurable: true,
      get() {
        sourceReads += 1;
        return f.source.content;
      },
    });
    expect(() =>
      createCompositionalOperationSnapshotIndexV3(
        hostileGraph,
        selector(f),
        getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
      ),
    ).toThrow();
    expect(sourceReads).toBe(0);

    let proxyTraps = 0;
    const proxiedGraph = new Proxy(f.graph, {
      get() {
        proxyTraps += 1;
        throw new Error('proxy access must not run');
      },
      ownKeys() {
        proxyTraps += 1;
        throw new Error('proxy ownKeys must not run');
      },
      getPrototypeOf() {
        proxyTraps += 1;
        throw new Error('proxy prototype access must not run');
      },
    });
    expect(() =>
      createCompositionalOperationSnapshotIndexV3(
        proxiedGraph,
        selector(f),
        getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
      ),
    ).toThrow();
    expect(proxyTraps).toBe(0);
  });

  it('reuses one full-root clone, binding validation, indices and shared budget in the owned-index batch path', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const graphClone = jest.spyOn(Lossless, 'parseLosslessAutomaticCaptureGraph');
    const bindings = jest.spyOn(Identity, 'assertAutomaticBindingRegistryIntegrity');
    const token = createCompositionalOperationSnapshotIndexV3(f.graph, selector(f), scope);
    expect(graphClone).toHaveBeenCalledTimes(1);
    expect(bindings).toHaveBeenCalledTimes(1);

    const request = {
      namespace: f.request.namespace,
      subjectId: f.operation.identity.binding.subjectId,
      meanings: [claimMeaning(f.graph)],
    };
    const inspector = createCompositionalOverlapBatchInspectorV3();
    const prepared = inspector.prepareFromOwnedIndex(token, request, { budget, now: NOW });
    expect(prepared.status).toBe('prepared_data');
    if (prepared.status !== 'prepared_data') throw new Error('Expected prepared batch data');
    expect(inspector.readBundle(prepared.batch, 0).status).toBe('complete_data');
    expect(graphClone).toHaveBeenCalledTimes(1);
    expect(bindings).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(508);
  });

  it('keeps protected Explicit missing-intent intake possible above128 candidates without claiming overlap inspection', () => {
    for (const intentSetting of [false, true]) {
      const f = makeCompositionalCaptureFixture('I like English.');
      const input = {
        ...f.input,
        request: {
          ...f.input.request,
          settings: { ...f.input.request.settings, profileId: 'explicit' as const, intentSetting },
        },
      };
      const built = buildCompositionalHumanCaptureSourceV3({ ...f.graph, episodes: [] }, input);
      const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
        ...f.operation,
        identity: built.identity,
        descriptor: built.descriptor,
      });
      const graph = {
        ...f.graph,
        episodes: [structuredClone(built.episode)],
        automatic_operations_v1: { version: 1 as const, operations: [operation] },
      };
      for (let i = 0; i < 129; i++)
        graph.edges.push(
          EntityEdgeSchema.parse({
            uuid: randomUUID(),
            group_id: operation.identity.namespace,
            source_node_uuid: operation.identity.binding.subjectId,
            target_node_uuid: operation.identity.binding.subjectId,
            name: 'PREFERS',
            fact: 'Unknown synthetic preference',
            created_at: graph.exported_at,
            updated_at: graph.exported_at,
          }),
        );
      const budget = { remaining: 512, deferred: 0 };
      const scope = getAutomaticClaimReadScope(budget);
      const token = createCompositionalOperationSnapshotIndexV3(
        graph,
        { namespace: operation.identity.namespace, operationId: operation.operationId },
        scope,
      );
      const view = getOwnedCompositionalSnapshotV3(token)!;
      const evidence = interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
        view.episode(operation.identity.sourceId),
        operation.descriptor,
        operation.identity,
      );
      expect(evidence.evidence.result.coverage).toBe('complete');
      expect(operation.descriptor.policy.requiresExplicitIntent).toBe(true);
      expect(view.candidates).toHaveLength(129);
      expect(view.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
      expect(budget.remaining).toBe(512);
      // Intake proves no selection/acceptance; the pure planner's later safe
      // missing-intent branch may decline all occurrences without hydrating.
      const owner = view.episode(operation.identity.sourceId)!.attributes.engram_write_owner_v3 as {
        intentEvidence: boolean;
      };
      expect(owner.intentEvidence).toBe(intentSetting);
      if (intentSetting) {
        const result = projectCompositionalPreferenceV2Meaning({
          preference: evidence.evidence.result,
          namespace: view.namespace,
          subjectId: view.subjectId,
        });
        if (!result.ok) throw new Error('fixture');
        expect(
          createCompositionalOverlapBatchInspectorV3().prepareFromOwnedIndex(
            token,
            { namespace: view.namespace, subjectId: view.subjectId, meanings: [result.meaning] },
            { budget, now: NOW },
          ),
        ).toEqual({ status: 'incomplete', reason: 'inspection_capacity' });
        expect(budget.remaining).toBe(512);
      }
    }
  });
  it('produces the same diagnostics and byte count as the existing full-graph prepare path', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const request = {
      namespace: f.request.namespace,
      subjectId: f.operation.identity.binding.subjectId,
      meanings: [claimMeaning(f.graph)],
    };
    const directBudget = { remaining: 512, deferred: 0 };
    const directInspector = createCompositionalOverlapBatchInspectorV3();
    const direct = directInspector.prepare(f.graph, request, { budget: directBudget, now: NOW });
    if (direct.status !== 'prepared_data') throw new Error('Expected direct batch data');
    const directData = directInspector.readBundle(direct.batch, 0);
    if (directData.status !== 'complete_data') throw new Error('Expected direct bundle data');

    const ownedBudget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(ownedBudget);
    const token = createCompositionalOperationSnapshotIndexV3(f.graph, selector(f), scope);
    const ownedInspector = createCompositionalOverlapBatchInspectorV3();
    const owned = ownedInspector.prepareFromOwnedIndex(token, request, {
      budget: ownedBudget,
      now: NOW,
    });
    if (owned.status !== 'prepared_data') throw new Error('Expected owned-index batch data');
    const ownedData = ownedInspector.readBundle(owned.batch, 0);
    if (ownedData.status !== 'complete_data') throw new Error('Expected owned-index bundle data');

    expect(ownedData).toEqual(directData);
    expect(Buffer.byteLength(JSON.stringify(ownedData), 'utf8')).toBe(
      Buffer.byteLength(JSON.stringify(directData), 'utf8'),
    );
    expect(ownedBudget.remaining).toBe(directBudget.remaining);
  });

  it('admits an oversized candidate snapshot as an index but refuses batch hydration before spending source budget', () => {
    const f = makeCompositionalCommittedClaimFixture();
    const target = f.graph.entities.find(
      (entity) => entity.uuid === f.graph.edges[0].target_node_uuid,
    );
    if (!target) throw new Error('Expected the fixture preference value');
    for (let index = 0; index < 129; index++)
      f.graph.edges.push(
        EntityEdgeSchema.parse({
          uuid: randomUUID(),
          group_id: f.request.namespace,
          source_node_uuid: f.operation.identity.binding.subjectId,
          target_node_uuid: target.uuid,
          name: 'PREFERS',
          fact: `Additional manual candidate ${index}`,
          created_at: f.graph.exported_at,
          updated_at: f.graph.exported_at,
        }),
      );
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const token = createCompositionalOperationSnapshotIndexV3(f.graph, selector(f), scope);
    const view = getOwnedCompositionalSnapshotV3(token);
    expect(view?.candidates.length).toBeGreaterThan(128);

    const result = createCompositionalOverlapBatchInspectorV3().prepareFromOwnedIndex(
      token,
      {
        namespace: f.request.namespace,
        subjectId: f.operation.identity.binding.subjectId,
        meanings: [claimMeaning(f.graph)],
      },
      { budget, now: NOW },
    );
    expect(result).toEqual({ status: 'incomplete', reason: 'inspection_capacity' });
    expect(budget.remaining).toBe(512);
  });
});
