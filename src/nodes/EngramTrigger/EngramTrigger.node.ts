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

interface TriggerItem {
  uuid: string;
  created_at: string;
}

interface TriggerCursor {
  backend: string;
  event: string;
  groupId: string;
  createdAt: string;
  uuid: string;
}

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
    const groupId = groupIdRaw.trim();
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

    const cursor = getTriggerCursor(staticData, {
      backend,
      event,
      groupId,
    });

    try {
      const newItems: INodeExecutionData[] = [];
      const data = await storage.exportGraph(groupId || undefined);

      const candidates =
        event === 'new_entity'
          ? data.entities
          : event === 'new_episode'
            ? data.episodes
            : data.edges;

      const sorted = [...candidates].sort(compareTriggerItems);
      const freshItems = sorted.filter((item) => isAfterCursor(item, cursor));

      for (const item of freshItems) {
        newItems.push({ json: item });
      }

      if (freshItems.length > 0) {
        const last = freshItems[freshItems.length - 1];
        staticData.__engramTriggerCursor = {
          backend,
          event,
          groupId,
          createdAt: last.created_at,
          uuid: last.uuid,
        };
        staticData.lastPollTime = last.created_at;
      }

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

function compareTriggerItems(a: TriggerItem, b: TriggerItem): number {
  const tsDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (tsDiff !== 0) return tsDiff;
  return a.uuid.localeCompare(b.uuid);
}

function isAfterCursor(item: TriggerItem, cursor: TriggerCursor): boolean {
  const itemTs = new Date(item.created_at).getTime();
  const cursorTs = new Date(cursor.createdAt).getTime();

  if (itemTs > cursorTs) return true;
  if (itemTs < cursorTs) return false;
  return item.uuid > cursor.uuid;
}

function getTriggerCursor(
  staticData: Record<string, unknown>,
  config: { backend: string; event: string; groupId: string },
): TriggerCursor {
  const stored = staticData.__engramTriggerCursor as Partial<TriggerCursor> | undefined;

  if (
    stored &&
    stored.backend === config.backend &&
    stored.event === config.event &&
    stored.groupId === config.groupId &&
    typeof stored.createdAt === 'string' &&
    typeof stored.uuid === 'string'
  ) {
    return stored as TriggerCursor;
  }

  const legacyTime =
    typeof staticData.lastPollTime === 'string'
      ? staticData.lastPollTime
      : new Date(0).toISOString();

  return {
    backend: config.backend,
    event: config.event,
    groupId: config.groupId,
    createdAt: legacyTime,
    uuid: '',
  };
}
