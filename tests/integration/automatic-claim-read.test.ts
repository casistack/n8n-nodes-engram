import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import neo4j, { type Session } from 'neo4j-driver';
import { makeHumanFixture } from '../helpers/automaticCommittedFixture';
import { GraphDataSchema, type GraphData } from '../../src/schemas';
import { AutomaticCaptureOperationV2Schema } from '../../src/schemas/AutomaticCaptureOperation.schema';
import { validateAutomaticClaimReadContext } from '../../src/extraction/AutomaticClaims';
import {
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
} from '../../src/storage/AutomaticClaimReadScope';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';

jest.setTimeout(30000);

const driverForTests = () =>
  neo4j.driver(
    process.env.NEO4J_TEST_URI!.replace('://localhost:', '://127.0.0.1:'),
    neo4j.auth.basic('neo4j', process.env.NEO4J_TEST_PASSWORD ?? 'password'),
  );

async function seedNeo4j(graph: GraphData): Promise<void> {
  const driver = driverForTests();
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      for (const entity of graph.entities)
        await tx.run('CREATE (n:Entity) SET n += $props', {
          props: { ...entity, attributes: JSON.stringify(entity.attributes) },
        });
      for (const episode of graph.episodes)
        await tx.run('CREATE (n:Episode) SET n += $props', {
          props: { ...episode, attributes: JSON.stringify(episode.attributes) },
        });
      for (const edge of graph.edges)
        await tx.run(
          'MATCH (a:Entity {uuid:$a}), (b:Entity {uuid:$b}) CREATE (a)-[r:RELATES_TO]->(b) SET r += $props',
          {
            a: edge.source_node_uuid,
            b: edge.target_node_uuid,
            props: { ...edge, attributes: JSON.stringify(edge.attributes) },
          },
        );
      for (const [position, op] of (graph.automatic_operations_v1?.operations ?? []).entries())
        await tx.run('CREATE (op:AutomaticOperation) SET op += $props', {
          props: {
            operation_id: op.operationId,
            store_hash: op.identity.storeHash,
            namespace: op.identity.namespace,
            source_id: op.identity.sourceId,
            role: op.identity.role,
            position,
            record_json: JSON.stringify(op),
          },
        });
      await tx.run(
        "MERGE (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.automatic_operations_v1_present=true, lock.revision=coalesce(lock.revision,0)+1",
      );
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

for (const backend of ['embedded', 'neo4j'] as const) {
  const suite = backend === 'neo4j' && !process.env.NEO4J_TEST_URI ? describe.skip : describe;
  suite(`${backend} committed capture claim reads`, () => {
    let directory: string;
    let fixture: ReturnType<typeof makeHumanFixture>;
    let storage: IGraphStorage;
    let path: string;
    const create = () =>
      backend === 'embedded'
        ? new GraphologyStorage(path)
        : new Neo4jStorage(
            process.env.NEO4J_TEST_URI!,
            'neo4j',
            process.env.NEO4J_TEST_PASSWORD ?? 'password',
          );
    const scope = () => getAutomaticClaimReadScope({ remaining: 1024, deferred: 0 });
    const seed = async () => {
      if (backend === 'embedded') fs.writeFileSync(path, JSON.stringify(fixture.graph));
      else await seedNeo4j(fixture.graph);
      await storage.initialize();
    };
    beforeEach(() => {
      directory = fs.mkdtempSync(join(tmpdir(), 'engram-claim-read-'));
      path = join(directory, 'store.json');
      fixture = makeHumanFixture(`claim-read-${randomUUID()}`);
      storage = create();
    });
    afterEach(async () => {
      await storage.close();
      if (backend === 'neo4j') {
        const driver = driverForTests();
        const session = driver.session();
        try {
          await session.executeWrite(async (tx) => {
            await tx.run('MATCH (op:AutomaticOperation {namespace:$group}) DETACH DELETE op', {
              group: fixture.human.group_id,
            });
            await tx.run(
              'MATCH (n) WHERE n.group_id=$group AND (n:Entity OR n:Episode) DETACH DELETE n',
              { group: fixture.human.group_id },
            );
          });
        } finally {
          await session.close();
          await driver.close();
        }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });

    it('returns exact committed evidence, with bounded hydration and byte accounting', async () => {
      await seed();
      const readScope = scope();
      const before = getAutomaticClaimReadScopeRemaining(readScope)!;
      const result = await storage.readAutomaticClaimContext!(
        fixture.human.group_id,
        fixture.graph.edges[0].uuid,
        readScope,
      );
      expect(result.status).toBe('committed');
      if (result.status !== 'committed') throw new Error(`Unexpected read: ${result.reason}`);
      expect(validateAutomaticClaimReadContext(fixture.graph.edges[0], result.context)).toBe(true);
      expect(result.context.source).toEqual(fixture.human);
      expect(JSON.stringify(result.context)).not.toContain('completionCallHash');
      const after = getAutomaticClaimReadScopeRemaining(readScope)!;
      expect(before.sourceHydrationsRemaining - after.sourceHydrationsRemaining).toBe(4);
      expect(before.attemptsRemaining - after.attemptsRemaining).toBe(1);
      expect(after.contextBytesRemaining).toBeLessThan(before.contextBytesRemaining);
    });

    it('withholds source-only evidence and charges the failed proof lookup', async () => {
      fixture.graph.automatic_operations_v1 = { version: 1, operations: [] };
      await seed();
      const readScope = scope();
      const before = getAutomaticClaimReadScopeRemaining(readScope)!;
      const result = await storage.readAutomaticClaimContext!(
        fixture.human.group_id,
        fixture.graph.edges[0].uuid,
        readScope,
      );
      expect(result).toEqual({ status: 'uncommitted', reason: 'missing_operation' });
      const after = getAutomaticClaimReadScopeRemaining(readScope)!;
      expect(after.sourceHydrationsRemaining).toBe(before.sourceHydrationsRemaining - 4);
      expect(after.contextBytesRemaining).toBeLessThan(before.contextBytesRemaining);
    });

    it('supports a valid 64 KiB source with exact application-owned mapping', async () => {
      fixture = makeHumanFixture(
        fixture.human.group_id,
        'x'.repeat(65536 - 'I prefer concise explanations.'.length),
      );
      expect(Buffer.byteLength(fixture.human.content, 'utf8')).toBe(65536);
      await seed();
      const result = await storage.readAutomaticClaimContext!(
        fixture.human.group_id,
        fixture.graph.edges[0].uuid,
        scope(),
      );
      expect(result.status).toBe('committed');
      if (result.status !== 'committed') throw new Error('Expected full supported source geometry');
      expect(result.context.source.content).toBe(fixture.human.content);
      expect(validateAutomaticClaimReadContext(fixture.graph.edges[0], result.context)).toBe(true);
    });

    it('does not expose mutable nested references into a scoped snapshot', async () => {
      await seed();
      const readScope = scope();
      const first = await storage.readAutomaticClaimContext!(
        fixture.human.group_id,
        fixture.graph.edges[0].uuid,
        readScope,
      );
      if (first.status !== 'committed') throw new Error('Expected initial committed context');
      const owner = first.context.source.attributes.engram_write_owner_v2 as Record<
        string,
        unknown
      >;
      owner.turn = 'synthetic-caller-mutation';
      const second = await storage.readAutomaticClaimContext!(
        fixture.human.group_id,
        fixture.graph.edges[0].uuid,
        readScope,
      );
      expect(second.status).toBe('committed');
      if (second.status !== 'committed') throw new Error('Expected detached scoped context');
      expect(validateAutomaticClaimReadContext(fixture.graph.edges[0], second.context)).toBe(true);
      expect(second.context.source).toEqual(fixture.human);
    });

    it.each(['captured', 'leased', 'failed', 'interrupted', 'cancelled'] as const)(
      'withholds a %s operation without returning partial proof',
      async (state) => {
        const { terminalReceipt, completionCallHash, ...base } = fixture.humanOperation as Extract<
          typeof fixture.humanOperation,
          { state: 'committed' }
        >;
        expect(completionCallHash).toMatch(/^[a-f0-9]{64}$/);
        const now = fixture.human.created_at;
        const stateFields =
          state === 'captured'
            ? { generation: 0 }
            : state === 'leased'
              ? {
                  lease: {
                    token: randomUUID(),
                    acquiredAt: now,
                    renewedAt: now,
                    expiresAt: new Date(Date.parse(now) + 60000).toISOString(),
                    claimKind: 'initial',
                  },
                }
              : state === 'failed'
                ? { failedAt: now, failureCode: 'storage_error' }
                : state === 'interrupted'
                  ? { interruptedAt: now, failureCode: 'invocation_interrupted' }
                  : {
                      terminalReceipt: {
                        version: 2,
                        kind: 'cancelled',
                        operationId: terminalReceipt.operationId,
                        sourceId: terminalReceipt.sourceId,
                        sourceHash: terminalReceipt.sourceHash,
                        descriptorHash: terminalReceipt.descriptorHash,
                        terminalAt: now,
                        acceptedCoverage: 'none',
                      },
                    };
        fixture.graph.automatic_operations_v1!.operations = [
          AutomaticCaptureOperationV2Schema.parse({ ...base, state, ...stateFields }),
        ];
        await seed();
        expect(
          await storage.readAutomaticClaimContext!(
            fixture.human.group_id,
            fixture.graph.edges[0].uuid,
            scope(),
          ),
        ).toEqual({ status: 'uncommitted', reason: 'capture_not_committed' });
      },
    );

    it('refreshes current review changes from another writer in the same read scope', async () => {
      await seed();
      const readScope = scope();
      const oldEdge = fixture.graph.edges[0];
      expect(
        (await storage.readAutomaticClaimContext!(fixture.human.group_id, oldEdge.uuid, readScope))
          .status,
      ).toBe('committed');
      const other = create();
      await other.initialize();
      try {
        await other.updateEpisode(fixture.human.uuid, { review_status: 'rejected' });
        const next = await storage.readAutomaticClaimContext!(
          fixture.human.group_id,
          oldEdge.uuid,
          readScope,
        );
        expect(next.status).toBe('committed');
        if (next.status !== 'committed')
          throw new Error('Expected coherent committed capture history');
        expect(next.context.source.review_status).toBe('rejected');
        expect(validateAutomaticClaimReadContext(oldEdge, next.context)).toBe(false);
      } finally {
        await other.close();
      }
    });

    it('does not issue I/O with an exhausted shared hydration allowance', async () => {
      await seed();
      const budget = { remaining: 3, deferred: 0 };
      expect(
        await storage.readAutomaticClaimContext!(
          fixture.human.group_id,
          fixture.graph.edges[0].uuid,
          getAutomaticClaimReadScope(budget),
        ),
      ).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
      expect(budget).toEqual({ remaining: 3, deferred: 0 });
    });

    it('withholds oversized context and charges inspected failed rows', async () => {
      fixture = makeHumanFixture(
        fixture.human.group_id,
        'x'.repeat(65536 - 'I prefer concise explanations.'.length),
      );
      const edge = fixture.graph.edges[0];
      const subject = fixture.graph.entities.find(
        (entity) => entity.uuid === edge.source_node_uuid,
      );
      const value = fixture.graph.entities.find((entity) => entity.uuid === edge.target_node_uuid);
      if (!subject || !value) throw new Error('Expected coherent committed capture endpoints');
      // Oversize a schema-allowed summary field. Native attributes stay below their independent
      // 512 KiB cap, so this remains a valid marker-1 snapshot and exercises ClaimRead's row cap.
      subject.summary = 'x'.repeat(600 * 1024);
      expect(GraphDataSchema.safeParse(fixture.graph).success).toBe(true);
      expect(Buffer.byteLength(fixture.human.content, 'utf8')).toBe(65536);
      for (const row of [
        ...fixture.graph.entities,
        ...fixture.graph.edges,
        ...fixture.graph.episodes,
      ]) {
        expect(Buffer.byteLength(JSON.stringify(row.attributes), 'utf8')).toBeLessThanOrEqual(
          512 * 1024,
        );
      }
      expect(Buffer.byteLength(JSON.stringify({ edge, subject }), 'utf8')).toBeGreaterThan(
        512 * 1024,
      );
      expect(
        Buffer.byteLength(JSON.stringify({ edge, subject, value, source: fixture.human }), 'utf8'),
      ).toBeGreaterThan(512 * 1024);
      await seed();
      const readScope = scope();
      const before = getAutomaticClaimReadScopeRemaining(readScope)!;
      const result = await storage.readAutomaticClaimContext!(
        fixture.human.group_id,
        fixture.graph.edges[0].uuid,
        readScope,
      );
      expect(result).toEqual({ status: 'invalid', reason: 'context_too_large' });
      expect(result).not.toHaveProperty('context');
      const after = getAutomaticClaimReadScopeRemaining(readScope)!;
      expect(after.contextBytesRemaining).toBeLessThan(before.contextBytesRemaining);
      expect(after.sourceHydrationsRemaining).toBe(before.sourceHydrationsRemaining - 4);
    });

    if (backend === 'neo4j') {
      it('bounds callback replay attempts before issuing further real database reads', async () => {
        await seed();
        const internal = storage as unknown as { getSession(): Session };
        const originalGetSession = internal.getSession.bind(storage);
        let queries = 0;
        const getSession = jest.spyOn(internal, 'getSession').mockImplementation(() => {
          const session = originalGetSession();
          const originalRead = session.executeRead.bind(session);
          session.executeRead = async (work, config) => {
            const replay = () =>
              originalRead(async (tx) => {
                const originalRun = tx.run.bind(tx);
                const run = jest.spyOn(tx, 'run').mockImplementation((query, parameters) => {
                  queries++;
                  return originalRun(query, parameters);
                });
                try {
                  return await work(tx);
                } finally {
                  run.mockRestore();
                }
              }, config);
            await replay();
            await replay();
            await replay();
            const beforeFourth = queries;
            const result = await replay();
            expect(queries).toBe(beforeFourth);
            return result;
          };
          return session;
        });
        try {
          const readScope = scope();
          expect(
            await storage.readAutomaticClaimContext!(
              fixture.human.group_id,
              fixture.graph.edges[0].uuid,
              readScope,
            ),
          ).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
          const remaining = getAutomaticClaimReadScopeRemaining(readScope)!;
          expect(remaining.sourceHydrationsRemaining).toBe(1012);
          expect(remaining.attemptsRemaining).toBe(125);
          expect(queries).toBeGreaterThan(0);
        } finally {
          getSession.mockRestore();
        }
      });

      it.each(['source_review', 'edge_review', 'binding_revocation'] as const)(
        'retries a real coherent read after concurrent %s',
        async (mutation) => {
          await seed();
          const other = create();
          await other.initialize();
          const internal = storage as unknown as { getSession(): Session };
          const originalGetSession = internal.getSession.bind(storage);
          let changed = false;
          const getSession = jest.spyOn(internal, 'getSession').mockImplementation(() => {
            const session = originalGetSession();
            const originalRead = session.executeRead.bind(session);
            session.executeRead = (work, config) =>
              originalRead(async (tx) => {
                const originalRun = tx.run.bind(tx);
                const run = jest.spyOn(tx, 'run').mockImplementation((query, parameters) => {
                  const result = originalRun(query, parameters);
                  if (
                    !changed &&
                    typeof query === 'string' &&
                    query.includes('MATCH (source:Episode')
                  ) {
                    changed = true;
                    // Neo4j Result is a thenable rather than a native Promise.
                    // Keep that contract and inject the concurrent real writer
                    // only after the source rows have reached this transaction.
                    const mutate = async () => {
                      if (mutation === 'source_review')
                        await other.updateEpisode(fixture.human.uuid, {
                          review_status: 'rejected',
                        });
                      else if (mutation === 'edge_review') {
                        const edge = fixture.graph.edges[0];
                        const extraction = edge.attributes.engram_extraction as Record<
                          string,
                          unknown
                        >;
                        await other.updateEdge(edge.uuid, {
                          attributes: {
                            ...edge.attributes,
                            engram_extraction: { ...extraction, review_status: 'rejected' },
                          },
                        });
                      } else
                        await other.automaticBindingCommand!({
                          action: 'revoke',
                          namespace: fixture.human.group_id,
                          bindingId: fixture.binding.bindingId,
                          expectedRevision: fixture.binding.revision,
                          authorizedBy: 'synthetic-reviewer',
                          reason: 'Synthetic concurrent revocation',
                        });
                    };
                    return new Proxy(result, {
                      get(target, key) {
                        if (key === 'then')
                          return (
                            resolve: (rows: Awaited<typeof result>) => unknown,
                            reject?: (error: unknown) => unknown,
                          ) =>
                            target.then(async (rows) => {
                              await mutate();
                              return resolve(rows);
                            }, reject);
                        const value = Reflect.get(target, key);
                        return typeof value === 'function' ? value.bind(target) : value;
                      },
                    });
                  }
                  return result;
                });
                try {
                  return await work(tx);
                } finally {
                  run.mockRestore();
                }
              }, config);
            return session;
          });
          try {
            const readScope = scope();
            const result = await storage.readAutomaticClaimContext!(
              fixture.human.group_id,
              fixture.graph.edges[0].uuid,
              readScope,
            );
            expect(changed).toBe(true);
            expect(result.status).toBe('committed');
            if (result.status !== 'committed')
              throw new Error('Expected refreshed coherent capture');
            expect(validateAutomaticClaimReadContext(fixture.graph.edges[0], result.context)).toBe(
              false,
            );
            expect(getAutomaticClaimReadScopeRemaining(readScope)!.sourceHydrationsRemaining).toBe(
              1016,
            );
          } finally {
            getSession.mockRestore();
            await other.close();
          }
        },
      );
    }

    if (backend === 'embedded') {
      it('discards a replaced open snapshot and reserves another bounded attempt', async () => {
        await seed();
        const other = create();
        await other.initialize();
        const original = fs.promises.stat.bind(fs.promises);
        let readerStats = 0;
        let changed = false;
        const spy = jest.spyOn(fs.promises, 'stat').mockImplementation((async (
          ...args: Parameters<typeof fs.promises.stat>
        ) => {
          if (args[0] === path && !changed && ++readerStats === 2) {
            changed = true;
            await other.updateEpisode(fixture.human.uuid, { review_status: 'rejected' });
          }
          return original(...args);
        }) as typeof fs.promises.stat);
        const readScope = scope();
        try {
          const result = await storage.readAutomaticClaimContext!(
            fixture.human.group_id,
            fixture.graph.edges[0].uuid,
            readScope,
          );
          expect(changed).toBe(true);
          expect(result.status).toBe('committed');
          if (result.status !== 'committed')
            throw new Error('Expected refreshed committed context');
          expect(result.context.source.review_status).toBe('rejected');
          expect(getAutomaticClaimReadScopeRemaining(readScope)!.sourceHydrationsRemaining).toBe(
            1016,
          );
        } finally {
          spy.mockRestore();
          await other.close();
        }
      });

      it('does not resurrect a cached capture when its native file is missing', async () => {
        await seed();
        const readScope = scope();
        expect(
          (
            await storage.readAutomaticClaimContext!(
              fixture.human.group_id,
              fixture.graph.edges[0].uuid,
              readScope,
            )
          ).status,
        ).toBe('committed');
        fs.unlinkSync(path);
        expect(
          await storage.readAutomaticClaimContext!(
            fixture.human.group_id,
            fixture.graph.edges[0].uuid,
            readScope,
          ),
        ).toEqual({ status: 'unavailable', reason: 'missing_store' });
        expect(fs.existsSync(path)).toBe(false);
      });
    }
  });
}
