import { performance } from 'perf_hooks';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import * as CommitProof from '../../../src/extraction/AutomaticClaimCommitProof';
import {
  CompositionalSnapshotIndexErrorV3,
  createCompositionalRetrievalSnapshotIndexV3,
  getOwnedCompositionalRetrievalSnapshotV3,
  getOwnedCompositionalSnapshotV3,
  selectCompositionalRetrievalSubjectIndexV3,
} from '../../../src/extraction/CompositionalSnapshotIndexV3';
import type { GraphData } from '../../../src/schemas';
import { getAutomaticClaimReadScope } from '../../../src/storage/AutomaticClaimReadScope';
import {
  applyAutomaticBindingCommand,
  BINDINGS_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';

function actualLiteralFixture() {
  const fixture = makeHumanFixture(`owned-access-${Date.now()}-${Math.random()}`);
  const graph = structuredClone(fixture.graph) as GraphData;
  const edge = graph.edges.find((row) =>
    Object.prototype.hasOwnProperty.call(row.attributes, 'engram_claim_v1'),
  );
  if (!edge) throw new Error('Expected an actual committed V1 literal edge');
  const bindingRef = fixture.humanIdentity.binding;
  if (!bindingRef) throw new Error('Expected the capture binding reference');
  const subject = graph.entities.find((row) => row.uuid === bindingRef.subjectId);
  if (!subject) throw new Error('Expected the captured subject');
  const binding = (subject.attributes[BINDINGS_ATTRIBUTE] as Array<Record<string, unknown>>)?.[0];
  if (!binding) throw new Error('Expected the validated subject binding');
  const budget = { remaining: 512, deferred: 0 };
  const scope = getAutomaticClaimReadScope(budget);
  const token = createCompositionalRetrievalSnapshotIndexV3(
    graph,
    { namespace: fixture.human.group_id },
    scope,
  );
  const view = getOwnedCompositionalRetrievalSnapshotV3(token);
  if (!view) throw new Error('Expected an owned retrieval view');
  return {
    fixture,
    graph,
    edge,
    subject,
    binding,
    bindingRef,
    subjectId: bindingRef.subjectId,
    budget,
    scope,
    token,
    view,
  };
}

function expectBudgetExhausted(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CompositionalSnapshotIndexErrorV3);
  expect((caught as CompositionalSnapshotIndexErrorV3).reason).toBe('budget_exhausted');
}

describe('V3 retrieval owned read access', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exposes exact namespace rows, operations and the actual current binding through the owned root', () => {
    const f = actualLiteralFixture();
    const { namespace, issuer, actorReference } = f.fixture.humanIdentity;
    expect(f.view.entity(f.subject.uuid)).toBeDefined();
    expect(f.view.episode(f.fixture.human.uuid)?.content).toBe(f.fixture.human.content);
    expect(f.view.edge(f.edge.uuid)?.uuid).toBe(f.edge.uuid);
    expect(f.view.edge('missing-edge')).toBeUndefined();
    expect(f.view.operation(f.fixture.humanOperation.operationId)).toEqual(
      f.fixture.humanOperation,
    );
    expect(f.view.operationsForSource(f.fixture.human.uuid)).toHaveLength(1);
    expect(f.view.currentBinding(namespace, issuer, actorReference)).toEqual(f.binding);
    expect(f.view.currentBinding(`${namespace}-other`, issuer, actorReference)).toBeNull();
    expect(() =>
      f.view.assertBinding(`${namespace}-other`, issuer, actorReference, f.bindingRef),
    ).toThrow('missing_binding');
    expect(f.view.assertBinding(namespace, issuer, actorReference, f.bindingRef).uuid).toBe(
      f.subject.uuid,
    );
    expect(f.view.graph).not.toBe(f.graph);
    expect(Object.isFrozen(f.view.graph)).toBe(true);
  });

  it('returns the actual revoked binding record as data while the existing assertion rejects it', () => {
    const f = actualLiteralFixture();
    const graph = structuredClone(f.graph) as GraphData;
    const revoked = applyAutomaticBindingCommand(
      graph,
      {
        action: 'revoke',
        namespace: f.fixture.humanIdentity.namespace,
        bindingId: f.binding.bindingId as string,
        expectedRevision: f.binding.revision as number,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic authority change',
      },
      f.binding.bindingId as string,
      '2026-10-26T12:00:00.000Z',
    );
    const token = createCompositionalRetrievalSnapshotIndexV3(
      graph,
      { namespace: f.fixture.humanIdentity.namespace },
      getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
    );
    const view = getOwnedCompositionalRetrievalSnapshotV3(token)!;
    const { namespace, issuer, actorReference } = f.fixture.humanIdentity;

    expect(view.currentBinding(namespace, issuer, actorReference)).toEqual(revoked);
    expect(() => view.assertBinding(namespace, issuer, actorReference, f.bindingRef)).toThrow(
      'binding_revoked',
    );
  });

  it('shares one immutable actual V1 proof projection between the retrieval root and selected subject views', () => {
    const f = actualLiteralFixture();
    const project = jest.spyOn(CommitProof, 'projectAutomaticClaimReadContextWithUsage');
    const rootResult = f.view.projectLiteralCommitContext(f.edge.uuid, 512 * 1024);
    expect(rootResult.result.status).toBe('committed');

    const subjectToken = selectCompositionalRetrievalSubjectIndexV3(f.token, f.edge.uuid, f.scope);
    const subjectView = getOwnedCompositionalSnapshotV3(subjectToken);
    expect(subjectView).not.toBeNull();
    const subjectResult = subjectView!.projectLiteralCommitContext(f.edge.uuid, 512 * 1024);

    expect(project).toHaveBeenCalledTimes(1);
    expect(subjectResult).toBe(rootResult);
    expect(Object.isFrozen(rootResult)).toBe(true);
    expect(Object.isFrozen(rootResult.result)).toBe(true);
    expect(f.budget).toEqual({ remaining: 512, deferred: 0 });
  });

  it('does not let a small failed inspection poison a later larger request, and honors a smaller later bound', () => {
    const f = actualLiteralFixture();
    const project = jest.spyOn(CommitProof, 'projectAutomaticClaimReadContextWithUsage');

    const tooSmall = f.view.projectLiteralCommitContext(f.edge.uuid, 0);
    expect(tooSmall).toEqual({
      result: { status: 'invalid', reason: 'context_too_large' },
      inspectedBytes: 1,
    });
    const full = f.view.projectLiteralCommitContext(f.edge.uuid, 512 * 1024);
    expect(full.result.status).toBe('committed');
    expect(full.inspectedBytes).toBeGreaterThan(1);

    const smaller = f.view.projectLiteralCommitContext(f.edge.uuid, full.inspectedBytes - 1);
    expect(smaller).toEqual({
      result: { status: 'invalid', reason: 'context_too_large' },
      inspectedBytes: full.inspectedBytes,
    });
    expect(f.view.projectLiteralCommitContext(f.edge.uuid, 512 * 1024)).toBe(full);
    expect(project).toHaveBeenCalledTimes(2);
    expect(f.budget).toEqual({ remaining: 512, deferred: 0 });
  });

  it('caches a bounded failure for an existing malformed literal row', () => {
    const f = actualLiteralFixture();
    f.edge.attributes.engram_claim_v1 = { malformed: true };
    const reindexed = createCompositionalRetrievalSnapshotIndexV3(
      f.graph,
      { namespace: f.fixture.human.group_id },
      getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
    );
    const view = getOwnedCompositionalRetrievalSnapshotV3(reindexed)!;
    const project = jest.spyOn(CommitProof, 'projectAutomaticClaimReadContextWithUsage');

    const first = view.projectLiteralCommitContext(f.edge.uuid, 512 * 1024);
    const second = view.projectLiteralCommitContext(f.edge.uuid, 512 * 1024);

    expect(first.result).toMatchObject({ status: 'invalid', reason: 'invalid_claim' });
    expect(second).toBe(first);
    expect(project).toHaveBeenCalledTimes(1);
  });

  it('rechecks original scope and latched cancellation on retained root and subject closures', () => {
    const fixture = makeHumanFixture(`owned-scope-${Date.now()}-${Math.random()}`);
    const abort = Object.freeze({ kind: 'owned-access-abort' });
    let cancelled = false;
    const check = () => {
      if (cancelled) throw abort;
    };
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const token = createCompositionalRetrievalSnapshotIndexV3(
      fixture.graph,
      { namespace: fixture.human.group_id },
      scope,
      check,
    );
    const root = getOwnedCompositionalRetrievalSnapshotV3(token)!;
    const subjectId = fixture.humanIdentity.binding?.subjectId;
    if (!subjectId) throw new Error('Expected the capture binding reference');
    const edge = fixture.graph.edges[0];
    const subjectToken = selectCompositionalRetrievalSubjectIndexV3(token, edge.uuid, scope);
    const subject = getOwnedCompositionalSnapshotV3(subjectToken)!;
    expect(root.entity(subjectId)).toBeDefined();

    cancelled = true;
    for (const read of [
      () => root.entity(subjectId),
      () => root.projectLiteralCommitContext(edge.uuid, 512 * 1024),
      () => subject.entity(subjectId),
      () => subject.projectLiteralCommitContext(edge.uuid, 512 * 1024),
    ]) {
      let caught: unknown;
      try {
        read();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(abort);
    }
    let getterError: unknown;
    try {
      getOwnedCompositionalRetrievalSnapshotV3(token);
    } catch (error) {
      getterError = error;
    }
    expect(getterError).toBe(abort);
  });

  it('returns no root view after expiry and rejects method calls on a retained view', () => {
    const fixture = makeHumanFixture(`owned-expiry-${Date.now()}-${Math.random()}`);
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const token = createCompositionalRetrievalSnapshotIndexV3(
      fixture.graph,
      { namespace: fixture.human.group_id },
      scope,
    );
    const retained = getOwnedCompositionalRetrievalSnapshotV3(token)!;
    const subjectId = fixture.humanIdentity.binding?.subjectId;
    if (!subjectId) throw new Error('Expected the capture binding reference');
    clock.mockReturnValue(6000);

    expect(getOwnedCompositionalRetrievalSnapshotV3(token)).toBeNull();
    expectBudgetExhausted(() => retained.entity(subjectId));
  });
});
