import neo4j from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';
import {
  corruptProviderOperation,
  providerTamperContract,
} from '../helpers/autonomousPersonalProviderTamperContract';

jest.setTimeout(90_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;

describeNeo('actual Neo4j corrupt provider authority', () => {
  providerTamperContract(async () => {
    const uri = process.env.NEO4J_TEST_URI!;
    const user = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
    const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
    const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    const store = new Neo4jStorage(uri, user, password, database);
    await store.initialize();
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    const namespace = seed.request.namespace;
    async function query(cypher: string, parameters: Record<string, unknown> = {}) {
      const session = driver.session({ database });
      try {
        return await session.run(cypher, parameters);
      } finally {
        await session.close();
      }
    }
    return {
      store,
      seed,
      nativeState: async () => {
        const nodes = await query(
          'MATCH (n) RETURN elementId(n) AS id, properties(n) AS properties ORDER BY id',
        );
        const edges = await query(
          'MATCH ()-[r]->() RETURN elementId(r) AS id, properties(r) AS properties ORDER BY id',
        );
        return {
          nodes: nodes.records.map((r) => r.toObject()),
          edges: edges.records.map((r) => r.toObject()),
        };
      },
      corrupt: async (kind) => {
        if (kind === 'source_missing') {
          await query('MATCH (e:Episode {group_id:$namespace}) DETACH DELETE e', { namespace });
        } else if (kind === 'source_content') {
          await query('MATCH (e:Episode {group_id:$namespace}) SET e.content=$content', {
            namespace,
            content: 'I prefer an altered source.',
          });
        } else if (kind === 'source_owner' || kind === 'source_envelope') {
          const result = await query(
            'MATCH (e:Episode {group_id:$namespace}) RETURN e.attributes AS attributes',
            { namespace },
          );
          const attributes = JSON.parse(result.records[0].get('attributes'));
          attributes[
            kind === 'source_owner' ? 'engram_write_owner_v4' : 'engram_source_envelope_v3'
          ] = { invalid: true };
          await query('MATCH (e:Episode {group_id:$namespace}) SET e.attributes=$attributes', {
            namespace,
            attributes: JSON.stringify(attributes),
          });
        } else if (kind === 'operation_missing') {
          await query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
            namespace,
          });
        } else {
          const result = await query(
            'MATCH (op:AutomaticOperation {namespace:$namespace}) RETURN op.record_json AS data',
            { namespace },
          );
          const operation = JSON.parse(result.records[0].get('data'));
          corruptProviderOperation(operation, kind);
          await query(
            'MATCH (op:AutomaticOperation {namespace:$namespace}) SET op.record_json=$data',
            {
              namespace,
              data: JSON.stringify(operation),
            },
          );
        }
      },
      close: async () => {
        await store.close();
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
        await driver.close();
      },
    };
  });
});
