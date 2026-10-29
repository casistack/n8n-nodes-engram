import neo4j from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { seedAutonomousPersonalCaptureSubject } from '../helpers/autonomousPersonalCaptureBackend';
import {
  autonomousPersonalAutomaticCompletionContract,
  type AutonomousPersonalAutomaticCompletionFixture,
} from '../helpers/autonomousPersonalAutomaticCompletionContract';

jest.setTimeout(90_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;

describeNeo('actual Neo4j automatic personal completion', () => {
  autonomousPersonalAutomaticCompletionContract(
    async (): Promise<AutonomousPersonalAutomaticCompletionFixture> => {
      const uri = process.env.NEO4J_TEST_URI!;
      const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
      const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
      const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
      const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
      const createStore = () => new Neo4jStorage(uri, username, password, database);
      let store = createStore();
      let storeOpen = false;
      let namespace: string | undefined;
      try {
        await store.initialize();
        storeOpen = true;
        const seed = await seedAutonomousPersonalCaptureSubject(store);
        namespace = seed.request.namespace;
        const seededNamespace = seed.request.namespace;
        return {
          get storage() {
            return store;
          },
          seed,
          readPersisted: async () => store.exportGraph(seededNamespace),
          reopen: async () => {
            if (storeOpen) await store.close();
            storeOpen = false;
            store = createStore();
            await store.initialize();
            storeOpen = true;
          },
          cleanup: async () => {
            try {
              if (storeOpen) await store.close();
              storeOpen = false;
            } finally {
              try {
                const cleanupNamespace = namespace;
                if (cleanupNamespace !== undefined) {
                  const session = driver.session({ database });
                  try {
                    await session.run(
                      'MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op',
                      { namespace: cleanupNamespace },
                    );
                    await session.run(
                      'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
                      { namespace: cleanupNamespace },
                    );
                    await session.run(
                      'MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock',
                      { namespace: cleanupNamespace },
                    );
                  } finally {
                    await session.close();
                  }
                }
              } finally {
                await driver.close();
              }
            }
          },
        };
      } catch (error) {
        try {
          if (storeOpen) await store.close();
        } finally {
          await driver.close();
        }
        throw error;
      }
    },
  );
});
