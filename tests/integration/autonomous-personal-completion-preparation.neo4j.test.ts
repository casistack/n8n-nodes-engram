import neo4j from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';
import {
  autonomousPersonalCompletionPreparationContract,
  type AutonomousPersonalCompletionPreparationFixture,
} from '../helpers/autonomousPersonalCompletionPreparationContract';

jest.setTimeout(90_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;

describeNeo('actual Neo4j completion preparation handle', () => {
  autonomousPersonalCompletionPreparationContract(
    async (): Promise<AutonomousPersonalCompletionPreparationFixture> => {
      const uri = process.env.NEO4J_TEST_URI!;
      const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
      const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
      const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
      const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
      const store = new Neo4jStorage(uri, username, password, database);
      try {
        await store.initialize();
        const seed = await seedAutonomousPersonalCaptureSubject(store);
        const namespace = seed.request.namespace;
        const query = async (cypher: string) => {
          const session = driver.session({ database });
          try {
            await session.run(cypher, { namespace });
          } finally {
            await session.close();
          }
        };
        return {
          store,
          seed,
          close: async () => {
            try {
              await store.close();
              await query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op');
              await query(
                'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
              );
              await query('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock');
            } finally {
              await driver.close();
            }
          },
        };
      } catch (error) {
        await store.close();
        await driver.close();
        throw error;
      }
    },
  );
});
