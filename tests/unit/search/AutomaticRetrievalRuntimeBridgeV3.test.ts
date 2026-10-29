import { randomUUID } from 'crypto';
import { makeHumanFixture } from '../../helpers/automaticCommittedFixture';
import { automaticClaimVisible } from '../../../src/search/AutomaticRetrieval';
import { automaticClaimVisibleForCompositionalRuntimeV3 } from '../../../src/search/AutomaticRetrieval';
import {
  loadCompositionalRuntimeReaderV3,
  readCompositionalRuntimeLiteralContextV3,
} from '../../../src/search/CompositionalRuntimeReaderV3';
import { CompositionalRetrievalSnapshotV3Schema } from '../../../src/schemas/CompositionalRetrievalSnapshotV3.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import * as CommitProof from '../../../src/extraction/AutomaticClaimCommitProof';
import { projectAutomaticClaimReadContext } from '../../../src/extraction/AutomaticClaimCommitProof';
import * as Claims from '../../../src/extraction/AutomaticClaims';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';
import { WRITE_OWNER_V2_ATTRIBUTE } from '../../../src/storage/AutomaticIdentity';
import {
  beginAutomaticClaimReadAttempt,
  getAutomaticClaimReadScopeRemaining,
  type AutomaticClaimReadScope,
} from '../../../src/storage/AutomaticClaimReadScope';
import type { EntityEdge, GraphData } from '../../../src/schemas';
import type { AutomaticReadBudget } from '../../../src/schemas/AutomaticRuntime.schema';

const BACKEND_NOW = '2026-10-25T12:00:10.000Z';

function unscoped(graph: GraphData): unknown {
  const snapshot = { ...graph };
  delete snapshot.group_id;
  return snapshot;
}

async function runtimeFor(graph: GraphData, namespace: string, check: () => void = () => {}) {
  const budget = { remaining: 512, deferred: 0 };
  let scopeUsed: AutomaticClaimReadScope | undefined;
  const read = jest.fn(async (scope: AutomaticClaimReadScope) => {
    scopeUsed = scope;
    if (!beginAutomaticClaimReadAttempt(scope))
      return { status: 'deferred' as const, reason: 'budget_exhausted' as const };
    return CompositionalRetrievalSnapshotV3Schema.parse({
      status: 'snapshot',
      graph: unscoped(graph),
      backendNow: BACKEND_NOW,
    });
  });
  const storage = { readCompositionalRetrievalSnapshotV3: read } as unknown as IGraphStorage;
  const result = await loadCompositionalRuntimeReaderV3(storage, { namespace }, { budget, check });
  if (result.status !== 'ready') throw new Error(`Expected runtime reader: ${result.reason}`);
  return { reader: result.reader, storage, read, budget, scope: () => scopeUsed! };
}

function fixture() {
  const f = makeHumanFixture(`runtime-literal-${randomUUID()}`);
  const edge = f.graph.edges[0];
  if (!edge) throw new Error('Expected a committed literal claim edge');
  return { ...f, edge };
}

function increaseCommitTime(f: ReturnType<typeof fixture>, terminalAt: string): void {
  const ledger = f.graph.automatic_operations_v1;
  if (!ledger) throw new Error('Expected committed V2 operation');
  const operation = ledger.operations[0];
  if (operation.version !== 2 || operation.state !== 'committed')
    throw new Error('Expected committed human operation');
  const changed = structuredClone(operation);
  changed.lastObservedAt = terminalAt;
  if (changed.terminalReceipt.kind !== 'human_capture_committed')
    throw new Error('Expected human terminal receipt');
  changed.terminalReceipt.terminalAt = terminalAt;
  changed.terminalReceipt.receipt.commitAt = terminalAt;
  ledger.operations = [AutomaticCaptureOperationV2Schema.parse(changed)];
}

function oppositeUncommitted(f: ReturnType<typeof fixture>): EntityEdge {
  const graph = f.graph;
  const source = structuredClone(f.human);
  source.uuid = randomUUID();
  source.source_message_id = `${source.source_message_id}-opposite`;
  source.attributes = structuredClone(source.attributes);
  const edge = structuredClone(f.edge);
  edge.uuid = randomUUID();
  edge.fact = 'Synthetic opposite polarity edge';
  edge.episodes = [source.uuid];
  const metadata = edge.attributes.engram_claim_v1 as {
    sourceId: string;
    claim: { polarity: string };
  };
  metadata.sourceId = source.uuid;
  metadata.claim.polarity = metadata.claim.polarity === 'positive' ? 'negative' : 'positive';
  graph.episodes.push(source);
  graph.edges.push(edge);
  return edge;
}

describe('actual-origin V1 literal bridge', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps the omitted-reader legacy path call counts, budgets, and result unchanged', async () => {
    const f = fixture();
    const related = f.graph.edges.filter(
      (edge) =>
        edge.source_node_uuid === f.edge.source_node_uuid &&
        edge.target_node_uuid === f.edge.target_node_uuid,
    );
    const storage = {
      getEntity: jest.fn(
        async (id: string) => f.graph.entities.find((row) => row.uuid === id) ?? null,
      ),
      getEpisode: jest.fn(
        async (id: string) => f.graph.episodes.find((row) => row.uuid === id) ?? null,
      ),
      getEdgesBetween: jest.fn(async () => related),
      readAutomaticClaimContext: jest.fn(
        async (groupId: string, edgeId: string, scope: AutomaticClaimReadScope) => {
          if (!beginAutomaticClaimReadAttempt(scope))
            return { status: 'deferred' as const, reason: 'budget_exhausted' as const };
          return projectAutomaticClaimReadContext(f.graph, groupId, edgeId);
        },
      ),
    } as unknown as IGraphStorage;
    const sources = { remaining: 512, deferred: 0 };
    const scans: AutomaticReadBudget = { remaining: 128 };

    expect(await automaticClaimVisible(storage, f.edge, sources, scans)).toBe('current');

    expect(storage.getEntity).toHaveBeenCalledTimes(2);
    expect(storage.getEpisode).toHaveBeenCalledTimes(1);
    expect(storage.readAutomaticClaimContext).toHaveBeenCalledTimes(1);
    expect(storage.getEdgesBetween).toHaveBeenCalledTimes(1);
    expect(sources).toEqual({ remaining: 505, deferred: 0 });
    expect(scans.remaining).toBe(128 - related.length);
  });

  it('uses actual rows and the committed proof for current, historical, and asOf visibility', async () => {
    const f = fixture();
    const commitAt = '2026-10-25T12:00:05.000Z';
    increaseCommitTime(f, commitAt);
    const runtime = await runtimeFor(f.graph, f.human.group_id);
    const currentScans = { remaining: 128 };
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, f.edge, currentScans),
    ).toBe('current');
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(
        runtime.reader,
        f.edge,
        { remaining: 128 },
        {
          mode: 'historical',
        },
      ),
    ).toBe('historical_record');
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(
        runtime.reader,
        f.edge,
        { remaining: 128 },
        {
          mode: 'asOf',
          at: '2026-10-25T12:00:03.000Z',
        },
      ),
    ).toBe('hidden');
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(
        runtime.reader,
        f.edge,
        { remaining: 128 },
        {
          mode: 'asOf',
          at: commitAt,
        },
      ),
    ).toBe('historical_record');
    expect(runtime.budget).toEqual({ remaining: 500, deferred: 0 });
  });

  it('retains old V1 owner evidence validation without requiring a V2 operation', async () => {
    const f = fixture();
    const source = f.graph.episodes.find((episode) => episode.uuid === f.human.uuid);
    if (!source) throw new Error('Expected the V1 human source');
    delete source.attributes[WRITE_OWNER_V2_ATTRIBUTE];
    delete f.graph.automatic_operations_v1;
    const runtime = await runtimeFor(f.graph, f.human.group_id);

    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, f.edge, { remaining: 128 }),
    ).toBe('current');
    expect(runtime.budget.remaining).toBe(500);
  });

  it('ignores a definite uncommitted opposite but hides when opposite provenance is uncertain', async () => {
    const f = fixture();
    const opposite = oppositeUncommitted(f);
    const runtime = await runtimeFor(f.graph, f.human.group_id);
    const scans = { remaining: 128 };

    expect(automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, f.edge, scans)).toBe(
      'current',
    );
    expect(scans.remaining).toBe(126);
    expect(automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, f.edge, scans)).toBe(
      'current',
    );
    expect(scans.remaining).toBe(126);

    const corrupt = fixture();
    const uncertain = structuredClone(corrupt.edge);
    uncertain.uuid = randomUUID();
    uncertain.fact = 'Synthetic unverifiable opposite edge';
    const malformed = uncertain.attributes.engram_claim_v1 as { claim: { polarity: string } };
    malformed.claim.polarity = malformed.claim.polarity === 'positive' ? 'negative' : 'positive';
    corrupt.graph.edges.push(uncertain);
    const uncertainRuntime = await runtimeFor(corrupt.graph, corrupt.human.group_id);
    const uncertainScans = { remaining: 128 };

    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(
        uncertainRuntime.reader,
        corrupt.edge,
        uncertainScans,
      ),
    ).toBe('hidden');
    expect(opposite.uuid).not.toBe(f.edge.uuid);
  });

  it('rejects fake readers and altered caller edge rows before treating them as evidence', async () => {
    const f = fixture();
    const runtime = await runtimeFor(f.graph, f.human.group_id);
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3({} as never, f.edge, { remaining: 128 }),
    ).toBe('hidden');
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(
        runtime.reader,
        { ...f.edge, fact: 'Forged caller text' },
        { remaining: 128 },
      ),
    ).toBe('hidden');
    const forgedOrdinary = structuredClone(f.edge);
    delete forgedOrdinary.attributes.engram_claim_v1;
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, forgedOrdinary, {
        remaining: 128,
      }),
    ).toBe('hidden');

    let traps = 0;
    const getterEdge = Object.defineProperty({}, 'attributes', {
      get() {
        traps++;
        throw new Error('must not inspect before reader authentication');
      },
    });
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3({} as never, getterEdge as never, {
        remaining: 128,
      }),
    ).toBe('hidden');
    const proxyEdge = new Proxy(
      {},
      {
        get() {
          traps++;
          throw new Error('proxy must remain unread');
        },
        ownKeys() {
          traps++;
          throw new Error('proxy must remain unread');
        },
      },
    );
    expect(
      automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, proxyEdge as never, {
        remaining: 128,
      }),
    ).toBe('hidden');
    expect(traps).toBe(0);
  });

  it('reuses the runtime proof cache across repeated consistency and visibility requests', async () => {
    const f = fixture();
    const runtime = await runtimeFor(f.graph, f.human.group_id);
    const project = jest.spyOn(CommitProof, 'projectAutomaticClaimReadContextWithUsage');
    const initial = getAutomaticClaimReadScopeRemaining(runtime.scope())!;
    const consistency = readCompositionalRuntimeLiteralContextV3(runtime.reader, f.edge.uuid);
    expect(consistency.status).toBe('committed');
    const first = { remaining: 128 };
    expect(automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, f.edge, first)).toBe(
      'current',
    );
    const scansAfterFirst = first.remaining;
    expect(automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, f.edge, first)).toBe(
      'current',
    );
    expect(first.remaining).toBe(scansAfterFirst);
    expect(project).toHaveBeenCalledTimes(1);
    const remaining = getAutomaticClaimReadScopeRemaining(runtime.scope())!;
    expect(remaining.sourceHydrationsRemaining).toBe(initial.sourceHydrationsRemaining - 4);
    expect(runtime.budget.remaining).toBe(500);
  });

  it('propagates the reader cancellation identity after proof validation', async () => {
    const f = fixture();
    const abort = Object.freeze({ kind: 'runtime-literal-abort' });
    let cancelled = false;
    const runtime = await runtimeFor(f.graph, f.human.group_id, () => {
      if (cancelled) throw abort;
    });
    const validate = Claims.validateAutomaticClaimReadContext;
    jest.spyOn(Claims, 'validateAutomaticClaimReadContext').mockImplementation((...args) => {
      const valid = validate(...args);
      cancelled = true;
      return valid;
    });

    let caught: unknown;
    try {
      automaticClaimVisibleForCompositionalRuntimeV3(runtime.reader, f.edge, { remaining: 128 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(abort);
  });
});
