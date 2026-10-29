import neo4j from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';
import {
  providerPreflightBackendContract,
  type ProviderPreflightBackendFixture,
} from '../helpers/autonomousPersonalProviderPreflightContract';

jest.setTimeout(90_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;

describeNeo('actual Neo4j provider preflight', () => {
  providerPreflightBackendContract('same observable actual-source contract', async () => {
    const uri = process.env.NEO4J_TEST_URI!;
    const user = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
    const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
    const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    const stores: Neo4jStorage[] = [];
    const readers: jest.SpyInstance[] = [];
    async function query(cypher: string, parameters: Record<string, unknown> = {}) {
      const session = driver.session({ database });
      try {
        return await session.run(cypher, parameters);
      } finally {
        await session.close();
      }
    }
    async function open() {
      const storage = new Neo4jStorage(uri, user, password, database);
      await storage.initialize();
      stores.push(storage);
      readers.push(
        jest.spyOn(
          storage as unknown as { readAutonomousPersonalSnapshotV4: () => Promise<unknown> },
          'readAutonomousPersonalSnapshotV4',
        ),
      );
      return storage;
    }
    const store = await open();
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    const fixture: ProviderPreflightBackendFixture = {
      store,
      seed,
      nativeState: async () => {
        const nodes = await query(
          'MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties ORDER BY id',
        );
        const edges = await query(
          'MATCH ()-[r]->() RETURN elementId(r) AS id, type(r) AS type, properties(r) AS properties ORDER BY id',
        );
        return {
          nodes: nodes.records.map((record) => record.toObject()),
          edges: edges.records.map((record) => record.toObject()),
        };
      },
      readCount: () => readers.reduce((total, spy) => total + spy.mock.calls.length, 0),
      anotherOwner: open,
      close: async () => {
        for (const storage of stores) await storage.close();
        for (const namespace of new Set([seed.request.namespace, fixture.seed.request.namespace])) {
          await query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
            namespace,
          });
          await query(
            'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
            { namespace },
          );
          await query('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
            namespace,
          });
        }
        await driver.close();
      },
    };
    return fixture;
  });
});
