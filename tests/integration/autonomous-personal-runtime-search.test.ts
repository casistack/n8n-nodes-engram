import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { AutonomousPersonalOperationV4 } from '../../src/schemas/AutonomousPersonalOperationV4.schema';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  publishAutonomousPersonalMemoryHandoffV4,
  type PrivateAutonomousPersonalMemoryLineageV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import * as parentReaderApi from '../../src/memory/AutonomousPersonalMemoryParentReaderV4';
import { loadCompositionalCompatibilityRuntimeReaderV4 } from '../../src/search/CompositionalRuntimeReaderV3';
import { getCompositionalRuntimeAutomaticReadContextV3 } from '../../src/search/CompositionalRuntimeReaderV3';
import {
  getAutonomousPersonalRuntimeDisplayV4,
  getAutonomousPersonalRuntimeLexicalHintV4,
  governAutonomousPersonalRuntimeEdgesV4,
} from '../../src/search/AutonomousPersonalRuntimeSearchV4';
import { AutonomousPersonalRuntimeDisplayV4OwnedDataSchema } from '../../src/schemas/AutonomousPersonalRuntimeSearchV4.schema';
import { AutonomousPersonalClaimV3OwnedDataSchema } from '../../src/schemas/AutonomousPersonalClaimV3.schema';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import * as recordIntegrityApi from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import {
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  type AutomaticClaimReadScope,
} from '../../src/storage/AutomaticClaimReadScope';
import type { AutonomousPersonalNativeMemoryConfigV4 } from '../../src/schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { CompositionalRuntimeReaderV3 } from '../../src/schemas/CompositionalRuntimeReaderV3.schema';
import type { EdgeSearchResult, IGraphStorage } from '../../src/storage/IGraphStorage';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { HybridSearchEngine } from '../../src/search/HybridSearchEngine';
import { RetrievalGovernance } from '../../src/search/RetrievalGovernance';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import {
  autonomousPersonalMemoryContextV4,
  autonomousPersonalMemoryStoreHashV4,
} from '../helpers/autonomousPersonalMemoryBackend';
import { readAutonomousPersonalNativeMemoryConfigV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';

type CommittedOperation = Extract<AutonomousPersonalOperationV4, { state: 'committed' }>;
type PriorCapture = { readonly content: string; readonly category: 'preference' | 'work_role' };
type Capture = {
  readonly operation: CommittedOperation;
  readonly sourceId: string;
  readonly native: { instance: string; workflow: string; execution: string };
  readonly content: string;
};
type Fixture = {
  readonly directory: string;
  readonly owner: GraphologyStorage;
  readonly config: AutonomousPersonalNativeMemoryConfigV4;
  readonly lineage: PrivateAutonomousPersonalMemoryLineageV4;
  readonly parent: parentReaderApi.PrivateAutonomousPersonalMemoryParentReaderV4;
  readonly compatibility: CompositionalRuntimeReaderV3;
  readonly budget: { remaining: number; deferred: number };
  readonly scope: AutomaticClaimReadScope;
  readonly controller: AbortController;
  readonly captures: readonly Capture[];
  readonly namespace: string;
  readonly trusted: { active: boolean; failure: unknown };
};

async function createFixture(priorCaptures: readonly PriorCapture[]): Promise<Fixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-runtime-search-v4-'));
  const workflowId = `runtime-search-${randomUUID()}`;
  const file = join(directory, `${workflowId}-engram.json`);
  let producer: GraphologyStorage | undefined;
  let owner: GraphologyStorage | undefined;
  let producerOpen = false;
  let ownerOpen = false;
  let parent: parentReaderApi.PrivateAutonomousPersonalMemoryParentReaderV4 | undefined;
  try {
    producer = new GraphologyStorage(file);
    await producer.initialize();
    producerOpen = true;
    const seed = await seedAutonomousPersonalCaptureSubject(producer);
    const captures: Capture[] = [];

    const capture = async (
      content: string,
      category: 'preference' | 'work_role' | null,
      profileId: 'conservative' | 'explicit',
    ): Promise<Capture> => {
      const turn = `runtime-search-turn-${randomUUID()}`;
      const native = {
        instance: `runtime-search-instance-${turn}`,
        workflow: workflowId,
        execution: `runtime-search-execution-${turn}`,
      };
      const providerOutputCategories: string[] = [];
      let providerRequestedUnitCount = 0;
      const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        if (category === null) throw new Error('no-claim fixture must not dispatch provider');
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const user = JSON.parse(body.messages[1]!.content) as {
          units: Array<{ unitId: string }>;
        };
        providerRequestedUnitCount = user.units.length;
        providerOutputCategories.push(...user.units.map(() => category));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    units: user.units.map(({ unitId }) => ({
                      unitId,
                      category,
                      risk: 'ordinary',
                      usefulness: 'personal_memory',
                      downgrade: [],
                    })),
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      let completed: Awaited<ReturnType<typeof completeNativeAutonomousPersonalCaptureV4>>;
      try {
        const context = nativeAutonomousPersonalCaptureContext(seed, {
          content,
          executionId: native.execution,
          workflowId: native.workflow,
          instanceId: native.instance,
          routeId: 'route:runtime-search-v4',
          model: 'model:runtime-search-v4',
          requestLimit: 2,
          deadlineMs: 30_000,
          extraParameters: {
            automaticMemoryProfile: profileId,
            automaticIntent: 'disabled',
            automaticTurn: turn,
            automaticInput: content,
            automaticWrapper: 'disabled',
            queueTemperatureMode: 'providerDefault',
          },
        });
        completed = await completeNativeAutonomousPersonalCaptureV4(context, producer!);
        if (completed.kind !== 'original_turn') {
          let persistedSummary: unknown = { available: false };
          try {
            const graph = await producer!.exportGraph(seed.request.namespace);
            const operations = (graph.automatic_operations_v1?.operations ?? [])
              .filter(
                (operation): operation is CommittedOperation =>
                  operation.version === 4 &&
                  operation.state === 'committed' &&
                  operation.identity.turn === turn,
              )
              .map((operation) => {
                const receipt = operation.terminalReceipt;
                const sourceId = operation.identity.sourceId;
                const sourceRows = graph.episodes.filter((episode) => episode.uuid === sourceId);
                return {
                  state: operation.state,
                  sourceRowCount: sourceRows.length,
                  receiptKind: receipt?.kind,
                  acceptedCoverage:
                    receipt?.kind === 'human_autonomous_capture_committed'
                      ? receipt.acceptedCoverage
                      : undefined,
                  items:
                    receipt?.kind === 'human_autonomous_capture_committed' &&
                    receipt.selection.kind === 'occurrences'
                      ? receipt.selection.items.map(({ kind, state, effect, reason, claimId }) => ({
                          kind,
                          state,
                          effect,
                          reason,
                          claimCreated: claimId !== null,
                        }))
                      : undefined,
                };
              });
            persistedSummary = { matchingOperationCount: operations.length, operations };
          } catch {
            persistedSummary = { available: false };
          }
          throw new Error(
            `Expected actual C2 original turn; fixed diagnostics=${JSON.stringify({
              kind: completed.kind,
              observation: completed.kind === 'no_origin' ? completed.observation : undefined,
              decisionKind: completed.kind === 'decision' ? completed.result.kind : undefined,
              providerCalled: provider.mock.calls.length > 0,
              providerRequestedUnitCount,
              providerOutputCategories,
              persistedSummary,
            })}`,
          );
        }
        if (category === null) expect(provider).not.toHaveBeenCalled();
        else expect(provider).toHaveBeenCalled();

        const graph = await producer!.exportGraph(seed.request.namespace);
        const operations = (graph.automatic_operations_v1?.operations ?? []).filter(
          (operation): operation is CommittedOperation =>
            operation.version === 4 &&
            operation.state === 'committed' &&
            operation.identity.turn === turn,
        );
        if (operations.length !== 1) throw new Error('Expected one actual committed Operation4');
        const operation = operations[0]!;
        const published = publishAutonomousPersonalMemoryHandoffV4(
          context,
          producer!,
          completed.origin,
        );
        if (published.kind !== 'published')
          throw new Error(`Expected actual C2 handoff, got ${published.kind}`);
        return { operation, sourceId: published.sourceId, native, content };
      } finally {
        provider.mockRestore();
      }
    };

    for (const prior of priorCaptures)
      captures.push(await capture(prior.content, prior.category, 'conservative'));
    const current = await capture('What games are on today?', null, 'explicit');
    captures.push(current);

    await producer.close();
    producerOpen = false;
    owner = new GraphologyStorage(file);
    await owner.initialize();
    ownerOpen = true;

    const storeHash = autonomousPersonalMemoryStoreHashV4(file);
    const identity = current.operation.identity;
    const memoryContext = autonomousPersonalMemoryContextV4({
      persistPath: file,
      storageWorkflowId: workflowId,
      native: current.native,
      namespace: identity.namespace,
      issuer: identity.issuer,
      actorReference: identity.actorReference,
      turn: identity.turn,
      sourceId: current.sourceId,
      profileId: 'explicit',
      explicitIntent: false,
      currentHumanQuery: current.content,
      sourceMapping: { mode: 'full_body' },
      routeId: 'route:runtime-search-v4',
      model: 'model:runtime-search-v4',
    });
    const config = await readAutonomousPersonalNativeMemoryConfigV4(memoryContext, 0, storeHash);
    const lineage = consumeAutonomousPersonalMemoryHandoffV4(
      memoryContext,
      config.storeHash,
      config.namespace,
      config.issuer,
      config.actorReference,
      config.turn,
      config.sourceId,
    );
    if (!lineage) throw new Error('Expected genuine C2 lineage for the reopened Memory owner');

    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const controller = new AbortController();
    const trusted = { active: false, failure: undefined as unknown };
    const work: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal: controller.signal,
    });
    const check = () => {
      if (trusted.active) throw trusted.failure;
    };
    const opened = await parentReaderApi.openAutonomousPersonalMemoryParentReaderV4(
      owner,
      lineage,
      config,
      { scope, work, check },
    );
    if (opened.kind !== 'reader_ready')
      throw new Error(`Expected ParentReader, got ${opened.reason}`);
    parent = opened.reader;
    const loaded = await loadCompositionalCompatibilityRuntimeReaderV4(owner, parent, budget);
    if (loaded.status !== 'ready')
      throw new Error(`Expected compatibility reader, got ${loaded.reason}`);
    return {
      directory,
      owner,
      config,
      lineage,
      parent,
      compatibility: loaded.reader,
      budget,
      scope,
      controller,
      captures,
      namespace: identity.namespace,
      trusted,
    };
  } catch (error) {
    if (parent && owner) parentReaderApi.closeAutonomousPersonalMemoryParentReaderV4(owner, parent);
    if (ownerOpen) await owner?.close();
    if (producerOpen) await producer?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function closeFixture(fixture: Fixture): Promise<void> {
  parentReaderApi.closeAutonomousPersonalMemoryParentReaderV4(fixture.owner, fixture.parent);
  await fixture.owner.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
  jest.restoreAllMocks();
}

function createdClaimIds(capture: Capture): string[] {
  const receipt = capture.operation.terminalReceipt;
  if (
    receipt.kind !== 'human_autonomous_capture_committed' ||
    receipt.selection.kind !== 'occurrences'
  )
    return [];
  return receipt.selection.items.flatMap((item) =>
    item.effect === 'created' && item.claimId ? [item.claimId] : [],
  );
}

async function actualRankedHits(
  fixture: Fixture,
  query: string,
  claimIds: readonly string[],
): Promise<EdgeSearchResult[]> {
  const hits = await fixture.owner.searchEdges(query, fixture.namespace, {
    limit: 200,
    include_expired: true,
  });
  const wanted = new Set(claimIds);
  return hits.filter((hit) => wanted.has(hit.edge.uuid));
}

function runGovernance(fixture: Fixture, hits: unknown, filters?: unknown, view?: unknown) {
  return governAutonomousPersonalRuntimeEdgesV4(
    fixture.owner,
    fixture.parent,
    fixture.compatibility,
    hits,
    filters,
    view,
  );
}

describe('Claim3-only Autonomous Personal runtime search V4', () => {
  it('accepts genuine current-authority rows under a later no-claim parent and preserves full meaning/order', async () => {
    const fixture = await createFixture([
      {
        content:
          'For summaries, I prefer answers in plain Canadian French with one practical example before any technical definitions.',
        category: 'preference',
      },
    ]);
    try {
      const ids = createdClaimIds(fixture.captures[0]!);
      if (ids.length < 1) {
        const receipts = fixture.captures.slice(0, 1).map(({ operation }) => {
          const receipt = operation.terminalReceipt;
          return {
            terminal: receipt.kind,
            acceptedCoverage:
              receipt.kind === 'human_autonomous_capture_committed'
                ? receipt.acceptedCoverage
                : undefined,
            selectionKind:
              receipt.kind === 'human_autonomous_capture_committed'
                ? receipt.selection.kind
                : undefined,
            items:
              receipt.kind === 'human_autonomous_capture_committed' &&
              receipt.selection.kind === 'occurrences'
                ? receipt.selection.items.map(({ kind, state, effect, reason, claimId }) => ({
                    kind,
                    state,
                    effect,
                    reason,
                    claimId,
                  }))
                : undefined,
          };
        });
        throw new Error(
          `Expected Canadian-French compound Claim3 row; fixed receipt summary=${JSON.stringify(receipts)}`,
        );
      }
      const hits = await actualRankedHits(fixture, 'prefer', ids);
      expect(new Set(hits.map((hit) => hit.edge.uuid))).toEqual(new Set(ids));
      const candidates = jest.spyOn(
        parentReaderApi,
        'readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4',
      );
      const ranked = [hits[0]!, hits[0]!, ...hits.slice(1)];
      const governed = runGovernance(fixture, ranked);
      expect(governed.results.map((hit) => hit.edge.uuid)).toEqual([
        ...new Set(ranked.map((hit) => hit.edge.uuid)),
      ]);
      expect(candidates).toHaveBeenCalledTimes(ids.length);
      expect(candidates.mock.calls.map((call) => call[2])).toEqual(expect.arrayContaining(ids));
      const laterQuestion = fixture.captures[1]!;
      expect(laterQuestion.content).toBe('What games are on today?');
      expect(laterQuestion.operation.terminalReceipt.kind).toBe(
        'human_autonomous_source_verdict_committed',
      );
      expect(createdClaimIds(laterQuestion)).toHaveLength(0);
      expect(laterQuestion.sourceId).not.toBe(fixture.captures[0]!.sourceId);
      const persisted = await fixture.owner.exportGraph(fixture.namespace);
      const priorSource = persisted.episodes.find(
        (episode) => episode.uuid === fixture.captures[0]!.sourceId,
      );
      const laterSource = persisted.episodes.find(
        (episode) => episode.uuid === laterQuestion.sourceId,
      );
      expect(priorSource).toBeDefined();
      expect(laterSource).toBeDefined();
      expect(Date.parse(priorSource!.reference_time)).toBeLessThan(
        Date.parse(laterSource!.reference_time),
      );
      for (const hit of governed.results) {
        expect(hit.edge).toEqual(
          ranked.find((candidate) => candidate.edge.uuid === hit.edge.uuid)?.edge,
        );
        const display = getAutonomousPersonalRuntimeDisplayV4(hit);
        expect(display).not.toBeNull();
        expect(AutonomousPersonalRuntimeDisplayV4OwnedDataSchema.safeParse(display).success).toBe(
          true,
        );
        expect(display).not.toHaveProperty('proof');
        expect(display).not.toHaveProperty('rowHash');
        expect(display).not.toHaveProperty('operationId');
        expect(display).not.toHaveProperty('rawSpan');
        expect(display).not.toHaveProperty('attributes');
        expect(getAutonomousPersonalRuntimeLexicalHintV4(hit)).toBe(
          `${hit.edge.fact} preference preferences preferred`,
        );
        const claim = AutonomousPersonalClaimV3OwnedDataSchema.parse(
          hit.edge.attributes.engram_claim_v1,
        );
        expect(display?.kind).toBe('typed_preference');
        if (display?.kind === 'typed_preference' && claim.kind === 'typed_preference') {
          expect(display.meaning).toEqual(claim.meaning);
          expect(display.meaning).toHaveProperty('bundles.0.rootPaths');
          expect(display.meaning).toHaveProperty('bundles.0.nodes');
          expect(display.meaning).toHaveProperty('bundles.0.edges');
          expect(display.meaning).toHaveProperty('bundles.0.nodes.0.kind');
          expect(display.meaning).toHaveProperty('bundles.0.relation');
        }
        expect(hit.provenance).toHaveLength(1);
        expect(hit.provenance[0]?.episode_review_status).toBe('accepted');
        expect(hit.provenance[0]?.fact_review_status).toBe('accepted');
        expect(hit.provenance[0]?.source_episode_uuid).toBe(
          fixture.captures.find((capture) => createdClaimIds(capture).includes(hit.edge.uuid))
            ?.operation.identity.sourceId,
        );
        expect(Object.isFrozen(hit)).toBe(true);
        expect(Object.isFrozen(display)).toBe(true);
      }

      const namespaceProjection = jest.spyOn(
        parentReaderApi,
        'getAutonomousPersonalMemoryParentNamespaceGraphV4',
      );
      const route = RetrievalGovernance.forAutonomousPersonalMemoryV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
      );
      if (!route) throw new Error('Expected the exact ParentReader-owned governance route');
      expect(
        RetrievalGovernance.forAutonomousPersonalMemoryV4(
          fixture.owner,
          fixture.parent,
          fixture.compatibility,
        ),
      ).toBe(route);
      expect(namespaceProjection).toHaveBeenCalledTimes(1);

      const snapshotRead = jest.spyOn(fixture.owner, 'readCompositionalRetrievalSnapshotV3');
      const backendEpisodes = jest.spyOn(fixture.owner, 'getEpisodes');
      const backendEntity = jest.spyOn(fixture.owner, 'getEntity');
      const integrityIndex = jest.spyOn(
        recordIntegrityApi,
        'createIntegrityCheckedAutonomousPersonalClaimIndexV4',
      );
      const beforeFixedCalls = candidates.mock.calls.length;
      const filteredFixed = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
        [{ ...hits[0]!, score: hits[0]!.score + 0.25 }],
        { sender_id: 'no-such-fixed-source' },
      );
      expect(filteredFixed.results).toHaveLength(0);
      expect(filteredFixed.decisions[0]?.reasons).toEqual(['no_source_episode_matched_filters']);
      expect(candidates).toHaveBeenCalledTimes(beforeFixedCalls);

      const fixed = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
        hits,
      );
      expect(fixed.results.map((hit) => hit.edge.uuid)).toEqual(ids);
      expect(getAutonomousPersonalRuntimeDisplayV4(fixed.results[0]!)).not.toBeNull();
      expect(candidates).toHaveBeenCalledTimes(beforeFixedCalls);

      const changedTuple = structuredClone(hits[0]!);
      changedTuple.edge.fact += ' changed after ranking';
      const changedFixed = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
        [changedTuple],
      );
      expect(changedFixed.results).toHaveLength(0);
      expect(changedFixed.decisions[0]?.reasons).toEqual(['automatic_claim_row_mismatch']);
      const validAfterChanged = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
        hits,
      );
      expect(validAfterChanged.results.map((hit) => hit.edge.uuid)).toEqual(ids);
      expect(candidates).toHaveBeenCalledTimes(beforeFixedCalls);

      const missingTuple = structuredClone(hits[0]!);
      missingTuple.edge.uuid = randomUUID();
      const missingFixed = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
        [missingTuple],
      );
      expect(missingFixed.results).toHaveLength(0);
      expect(missingFixed.decisions[0]?.reasons).toEqual(['automatic_claim_authority']);
      expect(candidates).toHaveBeenCalledTimes(beforeFixedCalls + 1);
      const missingAgain = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
        [{ ...missingTuple, score: missingTuple.score + 0.5 }],
      );
      expect(missingAgain.results).toHaveLength(0);
      expect(candidates).toHaveBeenCalledTimes(beforeFixedCalls + 1);

      const automaticContext = getCompositionalRuntimeAutomaticReadContextV3(
        fixture.compatibility,
        { mode: 'current' },
      );
      if (!automaticContext) throw new Error('Expected original compatibility read counters');
      const hostileHits = new Proxy([], {
        get() {
          throw new Error('wrong budget must reject before ranked-hit inspection');
        },
        ownKeys() {
          throw new Error('wrong budget must reject before ranked-hit inspection');
        },
      });
      const wrongBudget = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
        hostileHits,
        {},
        { ...automaticContext.sources },
      );
      expect(wrongBudget).toEqual({ results: [], decisions: [] });
      const wrongConflict = await route.governance.governAutonomousPersonalMemoryEdgesV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
        hits,
        {},
        undefined,
        { ...automaticContext, conflicts: { ...automaticContext.conflicts } },
      );
      expect(wrongConflict).toEqual({ results: [], decisions: [] });
      expect(candidates).toHaveBeenCalledTimes(beforeFixedCalls + 1);
      expect(namespaceProjection).toHaveBeenCalledTimes(1);
      expect(snapshotRead).not.toHaveBeenCalled();
      expect(integrityIndex).not.toHaveBeenCalled();
      expect(backendEpisodes).not.toHaveBeenCalled();
      expect(backendEntity).not.toHaveBeenCalled();

      const candidateReadCount = candidates.mock.calls.length;
      const engine = new HybridSearchEngine(fixture.owner);
      const typedHit = governed.results[0]!;
      const typedDisplay = getAutonomousPersonalRuntimeDisplayV4(typedHit);
      if (typedDisplay?.kind !== 'typed_preference')
        throw new Error('Expected a live typed preference display');
      const formatted = engine.formatAsContextWithAudit(
        { entities: [], edges: governed.results },
        undefined,
        true,
      );
      const typedLine = formatted.context
        .split('\n')
        .find((line) => line.includes('preference (structured):'));
      expect(typedLine).toContain(JSON.stringify(typedDisplay.meaning));
      expect(formatted.audit.fact_section.included_ids).toContain(typedHit.edge.uuid);
      for (const privateField of [
        'proof',
        'rowHash',
        'operationId',
        'terminalReceipt',
        'rawSpan',
        'contentSpan',
        'source_episode_uuid',
        'attributes',
      ])
        expect(formatted.context).not.toContain(privateField);
      expect(formatted.context).not.toContain(fixture.captures[0]!.operation.operationId);
      expect(formatted.context).not.toContain(fixture.captures[0]!.operation.identity.sourceId);

      const tiny = engine.formatAsContextWithAudit({ entities: [], edges: governed.results }, 1);
      expect(tiny.audit.fact_section.included_ids).not.toContain(typedHit.edge.uuid);
      expect(tiny.context).not.toContain(JSON.stringify(typedDisplay.meaning));

      const copied = structuredClone(typedHit);
      const copiedFormat = engine.formatAsContextWithAudit({ entities: [], edges: [copied] });
      expect(copiedFormat.audit.final_context_item_ids).not.toContain(copied.edge.uuid);
      expect(copiedFormat.context).not.toContain(copied.edge.fact);
      expect(snapshotRead).not.toHaveBeenCalled();
      expect(integrityIndex).not.toHaveBeenCalled();
      expect(candidates).toHaveBeenCalledTimes(candidateReadCount);

      const sourceTime = governed.results[0]!.provenance[0]!.reference_time;
      const filtered = runGovernance(fixture, hits, { reference_after: sourceTime });
      expect(filtered.results.map((hit) => hit.edge.uuid)).toEqual(
        hits.map((hit) => hit.edge.uuid),
      );
      const denied = runGovernance(fixture, hits, { sender_id: 'no-such-source-sender' });
      expect(denied.results).toHaveLength(0);
      expect(
        denied.decisions.every((item) => item.reasons[0] === 'no_source_episode_matched_filters'),
      ).toBe(true);

      const candidateCountBeforeCancelledFormatter = candidates.mock.calls.length;
      fixture.controller.abort();
      const cancelledFormat = engine.formatAsContextWithAudit({
        entities: [],
        edges: governed.results,
      });
      expect(cancelledFormat.audit.final_context_item_ids).not.toContain(typedHit.edge.uuid);
      expect(cancelledFormat.context).not.toContain(typedHit.edge.fact);
      expect(snapshotRead).not.toHaveBeenCalled();
      expect(integrityIndex).not.toHaveBeenCalled();
      expect(candidates).toHaveBeenCalledTimes(candidateCountBeforeCancelledFormatter);
    } finally {
      await closeFixture(fixture);
    }
  }, 30_000);

  it('retains exact statement literal and event date, and emits fixed historical/asOf decisions', async () => {
    const fixture = await createFixture([
      { content: 'I work as a ceramicist.', category: 'work_role' },
    ]);
    try {
      const ids = createdClaimIds(fixture.captures[0]!);
      expect(ids).toHaveLength(1);
      const hits = await actualRankedHits(fixture, 'ceramicist', ids);
      expect(hits).toHaveLength(1);
      const current = runGovernance(fixture, hits);
      expect(current.results).toHaveLength(1);
      const engine = new HybridSearchEngine(fixture.owner);
      const display = getAutonomousPersonalRuntimeDisplayV4(current.results[0]!);
      expect(display).toMatchObject({
        kind: 'source_statement_record',
        statementLiteral: 'I work as a ceramicist.',
      });
      if (display?.kind !== 'source_statement_record')
        throw new Error('Expected statement display');
      expect(getAutonomousPersonalRuntimeLexicalHintV4(current.results[0]!)).toBe(
        current.results[0]!.edge.fact,
      );
      const graph = await fixture.owner.exportGraph(fixture.namespace);
      const source = graph.episodes.find(
        (episode) => episode.uuid === fixture.captures[0]!.operation.identity.sourceId,
      );
      expect(source).toBeDefined();
      expect(display.sourceEventTime).toBe(source?.reference_time);
      expect(display.sourceEventTime).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(display.source.reviewStatus).toBe('accepted');
      const formatted = engine.formatAsContextWithAudit(
        { entities: [], edges: current.results },
        undefined,
        true,
      );
      const statementLine = formatted.context
        .split('\n')
        .find((line) => line.includes('Source statement dated'));
      expect(statementLine).toContain(display.sourceEventTime);
      expect(statementLine).toContain(display.statementLiteral);
      expect(formatted.audit.fact_section.included_ids).toContain(current.results[0]!.edge.uuid);
      for (const privateField of ['operationId', 'terminalReceipt', 'proof', 'rowHash', 'rawSpan'])
        expect(formatted.context).not.toContain(privateField);

      const historical = runGovernance(fixture, hits, {}, { mode: 'historical' });
      expect(historical.results).toHaveLength(0);
      expect(historical.decisions.map((item) => item.reasons[0])).toEqual([
        'autonomous_personal_historical_unsupported',
      ]);
      const asOf = runGovernance(
        fixture,
        hits,
        {},
        { mode: 'asOf', at: '2020-01-01T00:00:00.000Z' },
      );
      expect(asOf.results).toHaveLength(0);
      expect(asOf.decisions.map((item) => item.reasons[0])).toEqual([
        'autonomous_personal_as_of_unsupported',
      ]);
      const mismatchFilter = runGovernance(fixture, hits, {
        reference_before: '2000-01-01T00:00:00.000Z',
      });
      expect(mismatchFilter.results).toHaveLength(0);
      expect(mismatchFilter.decisions[0]?.reasons).toEqual(['no_source_episode_matched_filters']);

      parentReaderApi.closeAutonomousPersonalMemoryParentReaderV4(fixture.owner, fixture.parent);
      expect(getAutonomousPersonalRuntimeDisplayV4(current.results[0]!)).toBeNull();
      expect(getAutonomousPersonalRuntimeLexicalHintV4(current.results[0]!)).toBeNull();
      const afterClose = engine.formatAsContextWithAudit({ entities: [], edges: current.results });
      expect(afterClose.audit.final_context_item_ids).not.toContain(current.results[0]!.edge.uuid);
      expect(afterClose.context).not.toContain(display.statementLiteral);
    } finally {
      await closeFixture(fixture);
    }
  }, 30_000);

  it('rejects wrong bindings, changed row preimages and unknown metadata without ordinary fallback', async () => {
    const fixture = await createFixture([
      { content: 'I prefer concise explanations.', category: 'preference' },
    ]);
    try {
      const ids = createdClaimIds(fixture.captures[0]!);
      const hits = await actualRankedHits(fixture, 'concise', ids);
      expect(hits).toHaveLength(1);
      let traps = 0;
      const hostile = new Proxy([], {
        get() {
          traps += 1;
          throw new Error('must not inspect hits before owner authentication');
        },
        ownKeys() {
          traps += 1;
          throw new Error('must not inspect hits before owner authentication');
        },
      });
      expect(
        governAutonomousPersonalRuntimeEdgesV4(
          {} as IGraphStorage,
          fixture.parent,
          fixture.compatibility,
          hostile,
        ),
      ).toEqual({ results: [], decisions: [] });
      expect(traps).toBe(0);
      expect(
        governAutonomousPersonalRuntimeEdgesV4(
          fixture.owner,
          fixture.parent,
          {} as CompositionalRuntimeReaderV3,
          hits,
        ),
      ).toEqual({ results: [], decisions: [] });

      const changed = structuredClone(hits[0]!);
      changed.edge.fact += ' altered after ranking';
      const mismatch = runGovernance(fixture, [changed]);
      expect(mismatch.results).toHaveLength(0);
      expect(mismatch.decisions[0]?.reasons).toEqual(['automatic_claim_row_mismatch']);

      const unknown = structuredClone(hits[0]!);
      unknown.edge.attributes.engram_claim_v1 = { version: 99, family: 'unknown' };
      const readCandidate = jest.spyOn(
        parentReaderApi,
        'readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4',
      );
      const hidden = runGovernance(fixture, [unknown]);
      expect(hidden.results).toHaveLength(0);
      expect(hidden.decisions[0]?.reasons).toEqual(['automatic_claim_authority']);
      expect(readCandidate).not.toHaveBeenCalled();
      expect(getAutonomousPersonalRuntimeDisplayV4(unknown)).toBeNull();
    } finally {
      await closeFixture(fixture);
    }
  }, 30_000);

  it.each([new Error('runtime search trusted failure'), undefined])(
    'publishes no prefix when original work fails after a candidate read (%s)',
    async (failure) => {
      const fixture = await createFixture([
        { content: 'I prefer concise explanations.', category: 'preference' },
        { content: 'I prefer quiet evenings.', category: 'preference' },
      ]);
      try {
        const ids = fixture.captures.slice(0, 2).flatMap(createdClaimIds);
        const hits = await actualRankedHits(fixture, 'prefer', ids);
        expect(hits.length).toBeGreaterThanOrEqual(2);
        const original =
          parentReaderApi.readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4;
        const spy = jest
          .spyOn(parentReaderApi, 'readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4')
          .mockImplementation((...args) => {
            const candidate = original(...args);
            fixture.trusted.active = true;
            fixture.trusted.failure = failure;
            return candidate;
          });
        let threw = false;
        let caught: unknown;
        try {
          runGovernance(fixture, hits);
        } catch (error) {
          threw = true;
          caught = error;
        }
        expect(threw).toBe(true);
        expect(caught).toBe(failure);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        await closeFixture(fixture);
      }
    },
    30_000,
  );

  it('returns no partial result when the original signal or shared byte scope expires mid-loop', async () => {
    const fixture = await createFixture([
      { content: 'I prefer concise explanations.', category: 'preference' },
      { content: 'I prefer quiet evenings.', category: 'preference' },
    ]);
    try {
      const ids = fixture.captures.slice(0, 2).flatMap(createdClaimIds);
      const hits = await actualRankedHits(fixture, 'prefer', ids);
      expect(hits.length).toBeGreaterThanOrEqual(2);
      const original = parentReaderApi.readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4;
      jest
        .spyOn(parentReaderApi, 'readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4')
        .mockImplementation((...args) => {
          const candidate = original(...args);
          fixture.controller.abort();
          return candidate;
        });
      const aborted = runGovernance(fixture, hits);
      expect(aborted).toEqual({ results: [], decisions: [] });
      expect(getAutonomousPersonalRuntimeDisplayV4(aborted.results[0])).toBeNull();
    } finally {
      await closeFixture(fixture);
    }

    const scoped = await createFixture([
      { content: 'I prefer concise explanations.', category: 'preference' },
      { content: 'I prefer quiet evenings.', category: 'preference' },
    ]);
    try {
      const ids = scoped.captures.slice(0, 2).flatMap(createdClaimIds);
      const hits = await actualRankedHits(scoped, 'prefer', ids);
      const original = parentReaderApi.readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4;
      jest
        .spyOn(parentReaderApi, 'readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4')
        .mockImplementation((...args) => {
          const candidate = original(...args);
          const remaining = getAutomaticClaimReadScopeRemaining(scoped.scope);
          if (remaining)
            chargeAutomaticClaimContextBytes(scoped.scope, remaining.contextBytesRemaining);
          return candidate;
        });
      expect(runGovernance(scoped, hits)).toEqual({ results: [], decisions: [] });
    } finally {
      await closeFixture(scoped);
    }
  }, 60_000);
});
