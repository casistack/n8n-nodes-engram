import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { EntityEdgeSchema } from '../../../src/schemas/EntityEdge.schema';
import { EntityNodeSchema } from '../../../src/schemas/EntityNode.schema';
import * as Identity from '../../../src/storage/AutomaticIdentity';
import * as Lossless from '../../../src/storage/LosslessAutomaticCaptureGraph';
import * as RecordIdentity from '../../../src/storage/CompositionalRecordIdentityV3';
import { getAutomaticClaimReadScope } from '../../../src/storage/AutomaticClaimReadScope';
import type { GraphData } from '../../../src/schemas';
import {
  CompositionalSnapshotIndexErrorV3,
  createCompositionalRetrievalSnapshotIndexV3,
  getOwnedCompositionalRetrievalSnapshotV3,
  getOwnedCompositionalSnapshotV3,
  selectCompositionalRetrievalSubjectIndexV3,
} from '../../../src/extraction/CompositionalSnapshotIndexV3';

function graphWithTwoSubjects() {
  const fixture = makeCompositionalCommittedClaimFixture();
  const graph = structuredClone(fixture.graph) as GraphData;
  const originalSubject = graph.entities.find(
    (entity) => entity.uuid === fixture.operation.identity.binding.subjectId,
  );
  const target = graph.entities.find((entity) => entity.uuid === graph.edges[0]?.target_node_uuid);
  if (!originalSubject || !target) throw new Error('Expected committed fixture rows');

  const secondSubject = EntityNodeSchema.parse({
    ...originalSubject,
    uuid: randomUUID(),
    // The same display name must not merge separate subject identities.
    name: originalSubject.name,
    attributes: {},
  });
  graph.entities.push(secondSubject);
  const secondEdge = EntityEdgeSchema.parse({
    uuid: randomUUID(),
    group_id: fixture.request.namespace,
    source_node_uuid: secondSubject.uuid,
    target_node_uuid: target.uuid,
    name: 'PREFERS',
    fact: 'Synthetic second-subject preference',
    episodes: [],
    attributes: {},
    created_at: graph.exported_at,
    updated_at: graph.exported_at,
  });
  const secondEdgeSibling = EntityEdgeSchema.parse({
    ...secondEdge,
    uuid: randomUUID(),
    fact: 'Synthetic second-subject sibling preference',
  });
  graph.edges.push(secondEdge, secondEdgeSibling);
  return { fixture, graph, originalSubject, secondSubject, secondEdge, secondEdgeSibling };
}

function failureReason(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof CompositionalSnapshotIndexErrorV3 ? error.reason : 'other';
  }
}

describe('V3 shared retrieval snapshot index', () => {
  afterEach(() => jest.restoreAllMocks());

  it('clones and validates the full root once, then selects multiple subjects from shared maps', () => {
    const { fixture, graph, originalSubject, secondSubject, secondEdge, secondEdgeSibling } =
      graphWithTwoSubjects();
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const graphClone = jest.spyOn(Lossless, 'parseLosslessAutomaticCaptureGraph');
    const bindings = jest.spyOn(Identity, 'assertAutomaticBindingRegistryIntegrity');
    const recordIds = jest.spyOn(RecordIdentity, 'assertCompositionalRecordIdentityV3');
    const check = jest.fn();
    const retrieval = createCompositionalRetrievalSnapshotIndexV3(
      graph,
      { namespace: fixture.request.namespace },
      scope,
      check,
    );
    const ownedRoot = getOwnedCompositionalRetrievalSnapshotV3(retrieval);
    expect(ownedRoot).not.toBeNull();
    expect(Object.keys(retrieval)).toEqual([]);
    expect(Object.isFrozen(retrieval)).toBe(true);
    expect(Object.isFrozen(ownedRoot?.graph)).toBe(true);
    expect(ownedRoot?.namespace).toBe(fixture.request.namespace);
    expect(ownedRoot?.edge(secondEdge.uuid)).toEqual(secondEdge);
    expect(graphClone).toHaveBeenCalledTimes(1);
    expect(bindings).toHaveBeenCalledTimes(1);
    expect(recordIds).toHaveBeenCalledTimes(1);

    const checksAfterRoot = check.mock.calls.length;
    const first = selectCompositionalRetrievalSubjectIndexV3(
      retrieval,
      graph.edges[0].uuid,
      scope,
      check,
    );
    const checksAfterFirst = check.mock.calls.length;
    const second = selectCompositionalRetrievalSubjectIndexV3(
      retrieval,
      secondEdge.uuid,
      scope,
      check,
    );
    const firstView = getOwnedCompositionalSnapshotV3(first);
    const secondView = getOwnedCompositionalSnapshotV3(second);

    expect(firstView?.subject.uuid).toBe(originalSubject.uuid);
    expect(secondView?.subject.uuid).toBe(secondSubject.uuid);
    expect(firstView?.candidates.map((edge) => edge.uuid)).toEqual([graph.edges[0].uuid]);
    expect(secondView?.candidates.map((edge) => edge.uuid)).toEqual(
      [secondEdge.uuid, secondEdgeSibling.uuid].sort(),
    );
    expect(firstView?.snapshotHash).toBe(ownedRoot?.snapshotHash);
    expect(secondView?.snapshotHash).toBe(ownedRoot?.snapshotHash);
    expect(checksAfterFirst - checksAfterRoot).toBeLessThan(10);
    expect(check.mock.calls.length - checksAfterFirst).toBeLessThan(10);
    expect(graphClone).toHaveBeenCalledTimes(1);
    expect(bindings).toHaveBeenCalledTimes(1);
    expect(recordIds).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(512);
  });

  it('rejects copied roots, cross-scope selection, and edges outside the root namespace', () => {
    const { fixture, graph, secondEdge } = graphWithTwoSubjects();
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const retrieval = createCompositionalRetrievalSnapshotIndexV3(
      graph,
      { namespace: fixture.request.namespace },
      scope,
    );
    expect(getOwnedCompositionalRetrievalSnapshotV3({ ...retrieval })).toBeNull();
    expect(
      failureReason(() =>
        selectCompositionalRetrievalSubjectIndexV3({ ...retrieval }, secondEdge.uuid, scope),
      ),
    ).toBe('invalid_scope');
    expect(
      failureReason(() =>
        selectCompositionalRetrievalSubjectIndexV3(
          retrieval,
          secondEdge.uuid,
          getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
        ),
      ),
    ).toBe('invalid_scope');

    const otherNamespaceEdge = EntityEdgeSchema.parse({
      ...secondEdge,
      uuid: randomUUID(),
      group_id: `${fixture.request.namespace}-other`,
    });
    const otherGraph = structuredClone(graph) as GraphData;
    otherGraph.edges.push(otherNamespaceEdge);
    const otherScope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const otherRoot = createCompositionalRetrievalSnapshotIndexV3(
      otherGraph,
      { namespace: fixture.request.namespace },
      otherScope,
    );
    expect(
      failureReason(() =>
        selectCompositionalRetrievalSubjectIndexV3(otherRoot, otherNamespaceEdge.uuid, otherScope),
      ),
    ).toBe('invalid_snapshot');
  });

  it('keeps namespace bytes exact and scans malformed bindings outside the selected namespace', () => {
    const { fixture, graph } = graphWithTwoSubjects();
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const exactNamespace = `${fixture.request.namespace} `;
    const retrieval = createCompositionalRetrievalSnapshotIndexV3(
      graph,
      { namespace: exactNamespace },
      scope,
    );
    expect(getOwnedCompositionalRetrievalSnapshotV3(retrieval)?.namespace).toBe(exactNamespace);

    const malformed = structuredClone(graph) as GraphData;
    const outsideSubject = EntityNodeSchema.parse({
      ...malformed.entities[0],
      uuid: randomUUID(),
      group_id: 'unselected-namespace',
      attributes: { [Identity.BINDINGS_ATTRIBUTE]: [{ forged: true }] },
    });
    malformed.entities.push(outsideSubject);
    expect(() =>
      createCompositionalRetrievalSnapshotIndexV3(
        malformed,
        { namespace: fixture.request.namespace },
        getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
      ),
    ).toThrow();
  });

  it('checks the shared deadline before cloning the root and propagates cooperative abort identity', () => {
    const { fixture, graph } = graphWithTwoSubjects();
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const graphClone = jest.spyOn(Lossless, 'parseLosslessAutomaticCaptureGraph');
    clock.mockReturnValue(6000);
    expect(
      failureReason(() =>
        createCompositionalRetrievalSnapshotIndexV3(
          graph,
          { namespace: fixture.request.namespace },
          scope,
        ),
      ),
    ).toBe('budget_exhausted');
    expect(graphClone).not.toHaveBeenCalled();

    clock.mockRestore();
    const abort = Object.freeze({ kind: 'retrieval-index-cancel' });
    let caught: unknown;
    try {
      createCompositionalRetrievalSnapshotIndexV3(
        graph,
        { namespace: fixture.request.namespace },
        getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
        () => {
          throw abort;
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(abort);
  });
});
