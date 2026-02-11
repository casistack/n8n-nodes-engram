import {
  NodeConnectionType,
  type INodeType,
  type INodeTypeDescription,
  type IPollFunctions,
  type INodeExecutionData,
  NodeOperationError,
} from 'n8n-workflow';

import { createStorage } from '../../storage/StorageFactory';
import { resolveStoragePath, migrateStorageIfNeeded } from '../../utils/helpers';
import { customStoragePathProperty } from '../../descriptions';

export class EngramTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Engram Trigger',
    name: 'engramTrigger',
    icon: 'file:engram-trigger.png',
    group: ['trigger'],
    version: 1,
    description:
      'Triggers when new entities, relationships, or episodes are added to the knowledge graph',
    defaults: {
      name: 'Engram Trigger',
    },
    polling: true,
    inputs: [],
    outputs: [NodeConnectionType.Main],
    credentials: [
      {
        name: 'engramNeo4jApi',
        required: false,
        displayOptions: {
          show: {
            backend: ['neo4j'],
          },
        },
      },
    ],
    properties: [
      {
        displayName: 'Backend',
        name: 'backend',
        type: 'options',
        options: [
          { name: 'Embedded (Graphology)', value: 'embedded' },
          { name: 'Neo4j (Remote)', value: 'neo4j' },
        ],
        default: 'embedded',
      },
      customStoragePathProperty,
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        options: [
          {
            name: 'New Entity',
            value: 'new_entity',
            description: 'Fires when a new entity is added',
          },
          {
            name: 'New Relationship',
            value: 'new_relationship',
            description: 'Fires when a new relationship is added',
          },
          {
            name: 'New Episode',
            value: 'new_episode',
            description: 'Fires when a new episode is added',
          },
        ],
        default: 'new_entity',
      },
      {
        displayName: 'Group ID',
        name: 'groupId',
        type: 'string',
        default: '',
        description: 'Only trigger for this group/session. Leave empty to watch all groups.',
      },
    ],
  };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    const backend = this.getNodeParameter('backend', 'embedded') as string;
    const event = this.getNodeParameter('event') as string;
    const groupIdRaw = this.getNodeParameter('groupId', '') as string;
    const groupId = groupIdRaw.trim() || undefined;
    const staticData = this.getWorkflowStaticData('node');

    let storage;
    if (backend === 'neo4j') {
      const credentials = await this.getCredentials('engramNeo4jApi');
      storage = createStorage({
        backend: 'neo4j',
        uri: credentials.uri as string,
        username: credentials.username as string,
        password: credentials.password as string,
        database: credentials.database as string,
      });
    } else {
      const workflowId = this.getWorkflow().id ?? 'default';
      const customPath = this.getNodeParameter('customStoragePath', '') as string;
      const persistPath = resolveStoragePath({
        customStoragePath: customPath,
        workflowId,
      });

      migrateStorageIfNeeded({
        newPath: persistPath,
        workflowId,
        staticData,
        logger: this.logger,
      });

      storage = createStorage({
        backend: 'embedded',
        persistPath,
      });
    }
    await storage.initialize();

    // Get the last poll timestamp from static data
    const lastPollTime = (staticData.lastPollTime as string) || new Date(0).toISOString();

    const lastPollDate = new Date(lastPollTime).getTime();

    try {
      const newItems: INodeExecutionData[] = [];

      if (event === 'new_entity') {
        const entities = await storage.listEntities(groupId ?? '', { limit: 100 });
        for (const entity of entities) {
          if (new Date(entity.created_at).getTime() > lastPollDate) {
            newItems.push({ json: entity });
          }
        }
      } else if (event === 'new_episode') {
        const episodes = await storage.getRecentEpisodes(groupId ?? '', 100);
        for (const episode of episodes) {
          if (new Date(episode.created_at).getTime() > lastPollDate) {
            newItems.push({ json: episode });
          }
        }
      } else if (event === 'new_relationship') {
        const data = await storage.exportGraph(groupId);
        for (const edge of data.edges) {
          if (new Date(edge.created_at).getTime() > lastPollDate) {
            newItems.push({ json: edge });
          }
        }
      }

      // Update the last poll timestamp
      staticData.lastPollTime = new Date().toISOString();

      if (newItems.length === 0) return null;
      return [newItems];
    } catch (error: unknown) {
      throw new NodeOperationError(
        this.getNode(),
        `Engram Trigger error: ${(error as Error).message}`,
      );
    } finally {
      if (backend === 'neo4j') {
        await storage.close();
      }
    }
  }
}
