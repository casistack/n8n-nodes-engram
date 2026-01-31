import type { IGraphStorage } from './IGraphStorage';
import { GraphologyStorage } from './GraphologyStorage';

export interface EmbeddedStorageConfig {
  backend: 'embedded';
  persistPath?: string;
}

export interface Neo4jStorageConfig {
  backend: 'neo4j';
  uri: string;
  username: string;
  password: string;
  database?: string;
}

export type StorageConfig = EmbeddedStorageConfig | Neo4jStorageConfig;

/**
 * Singleton map for embedded storage instances.
 * Ensures the same graph state is shared across multiple supplyData() calls
 * within a single n8n instance.
 */
const embeddedInstances = new Map<string, GraphologyStorage>();

export function createStorage(config: StorageConfig): IGraphStorage {
  switch (config.backend) {
    case 'embedded': {
      const key = config.persistPath ?? '__default__';
      let instance = embeddedInstances.get(key);
      if (!instance) {
        instance = new GraphologyStorage(config.persistPath);
        embeddedInstances.set(key, instance);
      }
      return instance;
    }
    case 'neo4j': {
      // Neo4jStorage import is deferred to avoid loading neo4j-driver
      // when using embedded mode
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Neo4jStorage } = require('./Neo4jStorage') as {
        Neo4jStorage: new (
          uri: string,
          username: string,
          password: string,
          database?: string,
        ) => IGraphStorage;
      };
      return new Neo4jStorage(config.uri, config.username, config.password, config.database);
    }
    default:
      throw new Error(`Unknown storage backend: ${(config as { backend: string }).backend}`);
  }
}
