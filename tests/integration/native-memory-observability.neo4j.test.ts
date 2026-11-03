import neo4j from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { executeAutonomousPersonalAdminV4 } from '../../src/utils/autonomousPersonalAdmin';
import { NativeMemoryObservabilityV1Schema } from '../../src/schemas/NativeMemoryObservabilityV1.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

jest.setTimeout(90_000);
const uri = process.env.NEO4J_TEST_URI;
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
const describeBackend = uri ? describe : describe.skip;

describeBackend('native observability on actual Neo4j', () => {
  it('observes capture without persisting telemetry or changing source ownership', async () => {
    const store = new Neo4jStorage(uri!, username, password, database);
    const driver = neo4j.driver(uri!, neo4j.auth.basic(username, password));
    let namespace: string | undefined;
    try {
      await store.initialize();
      const seed = await seedAutonomousPersonalCaptureSubject(store);
      namespace = seed.request.namespace;
      const original = structuredClone(await store.getEntity(seed.subject.uuid));
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body).not.toHaveProperty('temperature');
        const input = JSON.parse(body.messages[1].content);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    units: input.units.map((unit: { unitId: string }) => ({
                      unitId: unit.unitId,
                      category: 'preference',
                      risk: 'ordinary',
                      usefulness: 'personal_memory',
                      downgrade: [],
                    })),
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
          { status: 200 },
        );
      });
      const result = await executeAutonomousPersonalAdminV4(
        nativeAutonomousPersonalCaptureContext(seed, {
          extraParameters: { nativeDiagnostics: 'enabled' },
        }),
        store,
      );
      expect(result.status).toBe('captured');
      const sidecar = NativeMemoryObservabilityV1Schema.parse(result.native_diagnostics_v1);
      expect(sidecar.native_requests).toMatchObject({
        attempted: 1,
        completed: 1,
        total_tokens: 5,
      });
      expect(sidecar.observer_errors).toBe(0);
      expect(await store.getEntity(seed.subject.uuid)).toEqual(original);
      const graph = await store.exportGraph(namespace);
      expect(graph.edges.filter((edge) => edge.attributes.engram_claim_v1)).toHaveLength(1);
      expect(JSON.stringify(graph)).not.toContain('native_diagnostics_v1');
    } finally {
      jest.restoreAllMocks();
      await store.close();
      const session = driver.session({ database });
      try {
        if (namespace) {
          await session.run(
            'MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op',
            { namespace },
          );
          await session.run(
            'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
            { namespace },
          );
          await session.run('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
            namespace,
          });
        }
      } finally {
        await session.close();
        await driver.close();
      }
    }
  });
});
