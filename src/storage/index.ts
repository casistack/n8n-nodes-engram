export type {
  IGraphStorage,
  EntitySearchResult,
  EdgeSearchResult,
  ChangelogEntry,
  ListOptions,
  EntitySearchOptions,
  EdgeSearchOptions,
  VectorSearchOptions,
  RetentionPolicy,
} from './IGraphStorage';

export {
  createStorage,
  type StorageConfig,
  type EmbeddedStorageConfig,
  type Neo4jStorageConfig,
} from './StorageFactory';

export { GraphologyStorage } from './GraphologyStorage';
