import * as fs from 'fs';
import * as path from 'path';
import { NodeConnectionType, NodeOperationError, jsonStringify } from 'n8n-workflow';
import type {
  EventNamesAiNodesType,
  IDataObject,
  IExecuteFunctions,
  IWebhookFunctions,
} from 'n8n-workflow';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseOutputParser } from '@langchain/core/output_parsers';
import type { BaseMessage } from '@langchain/core/messages';
import type { Tool } from '@langchain/core/tools';
import type { BaseLLM } from '@langchain/core/language_models/llms';
import type { BaseChatMemory } from '@langchain/community/memory/chat_memory';
import type { BaseChatMessageHistory } from '@langchain/core/chat_history';
function hasMethods<T>(obj: unknown, ...methodNames: Array<string | symbol>): obj is T {
  return methodNames.every(
    (methodName) =>
      typeof obj === 'object' &&
      obj !== null &&
      methodName in obj &&
      typeof (obj as Record<string | symbol, unknown>)[methodName] === 'function',
  );
}

export function getMetadataFiltersValues(
  ctx: IExecuteFunctions,
  itemIndex: number,
): Record<string, never> | undefined {
  const options = ctx.getNodeParameter('options', itemIndex, {});

  if (options.metadata) {
    const { metadataValues: metadata } = options.metadata as {
      metadataValues: Array<{
        name: string;
        value: string;
      }>;
    };
    if (metadata.length > 0) {
      return metadata.reduce((acc, { name, value }) => ({ ...acc, [name]: value }), {});
    }
  }

  if (options.searchFilterJson) {
    return ctx.getNodeParameter('options.searchFilterJson', itemIndex, '', {
      ensureType: 'object',
    }) as Record<string, never>;
  }

  return undefined;
}

export function isBaseChatMemory(obj: unknown) {
  return hasMethods<BaseChatMemory>(obj, 'loadMemoryVariables', 'saveContext');
}

export function isBaseChatMessageHistory(obj: unknown) {
  return hasMethods<BaseChatMessageHistory>(obj, 'getMessages', 'addMessage');
}

export function isChatInstance(model: unknown): model is BaseChatModel {
  const namespace = (model as BaseLLM)?.lc_namespace ?? [];

  return namespace.includes('chat_models');
}

export function isToolsInstance(model: unknown): model is Tool {
  const namespace = (model as Tool)?.lc_namespace ?? [];

  return namespace.includes('tools');
}

export async function getOptionalOutputParsers(
  ctx: IExecuteFunctions,
): Promise<Array<BaseOutputParser<unknown>>> {
  let outputParsers: BaseOutputParser[] = [];

  if (ctx.getNodeParameter('hasOutputParser', 0, true) === true) {
    outputParsers = (await ctx.getInputConnectionData(
      NodeConnectionType.AiOutputParser,
      0,
    )) as BaseOutputParser[];
  }

  return outputParsers;
}

export function getPromptInputByType(options: {
  ctx: IExecuteFunctions;
  i: number;
  promptTypeKey: string;
  inputKey: string;
}) {
  const { ctx, i, promptTypeKey, inputKey } = options;
  const prompt = ctx.getNodeParameter(promptTypeKey, i) as string;

  let input;
  if (prompt === 'auto') {
    input = ctx.evaluateExpression('{{ $json["chatInput"] }}', i) as string;
  } else {
    input = ctx.getNodeParameter(inputKey, i) as string;
  }

  if (input === undefined) {
    throw new NodeOperationError(ctx.getNode(), 'No prompt specified', {
      description:
        "Expected to find the prompt in an input field called 'chatInput' (this is what the chat trigger node outputs). To use something else, change the 'Prompt' parameter",
    });
  }

  return input;
}

export function getSessionId(
  ctx: IExecuteFunctions | IWebhookFunctions,
  itemIndex: number,
  selectorKey = 'sessionIdType',
  autoSelect = 'fromInput',
  customKey = 'sessionKey',
) {
  let sessionId = '';
  const selectorType = ctx.getNodeParameter(selectorKey, itemIndex) as string;

  if (selectorType === autoSelect) {
    // If memory node is used in webhook like node(like chat trigger node), it doesn't have access to evaluateExpression
    // so we try to extract sessionId from the bodyData
    if ('getBodyData' in ctx) {
      const bodyData = ctx.getBodyData() ?? {};
      sessionId = bodyData.sessionId as string;
    } else {
      sessionId = ctx.evaluateExpression('{{ $json.sessionId }}', itemIndex) as string;
    }

    if (sessionId === '' || sessionId === undefined) {
      throw new NodeOperationError(ctx.getNode(), 'No session ID found', {
        description:
          "Expected to find the session ID in an input field called 'sessionId' (this is what the chat trigger node outputs). To use something else, change the 'Session ID' parameter",
        itemIndex,
      });
    }
  } else {
    sessionId = ctx.getNodeParameter(customKey, itemIndex, '') as string;
    if (sessionId === '' || sessionId === undefined) {
      throw new NodeOperationError(ctx.getNode(), 'Key parameter is empty', {
        description:
          "Provide a key to use as session ID in the 'Key' parameter or use the 'Take from previous node automatically' option to use the session ID from the previous node, e.t. chat trigger node",
        itemIndex,
      });
    }
  }

  return sessionId.trim();
}

export async function logAiEvent(
  executeFunctions: IExecuteFunctions,
  event: EventNamesAiNodesType,
  data?: IDataObject,
) {
  try {
    await executeFunctions.logAiEvent(event, data ? jsonStringify(data) : undefined);
  } catch (error) {
    executeFunctions.logger.debug(`Error logging AI event: ${event}`);
  }
}

export function serializeChatHistory(chatHistory: BaseMessage[]): string {
  return chatHistory
    .map((chatMessage) => {
      if (chatMessage._getType() === 'human') {
        return `Human: ${chatMessage.content}`;
      } else if (chatMessage._getType() === 'ai') {
        return `Assistant: ${chatMessage.content}`;
      } else {
        return `${chatMessage.content}`;
      }
    })
    .join('\n');
}

export const getConnectedTools = async (
  ctx: IExecuteFunctions,
  enforceUniqueNames: boolean,
  _convertStructuredTool: boolean = true,
) => {
  const connectedTools =
    ((await ctx.getInputConnectionData(NodeConnectionType.AiTool, 0)) as Tool[]) || [];

  if (!enforceUniqueNames) return connectedTools;

  const seenNames = new Set<string>();

  const finalTools = [];

  for (const tool of connectedTools) {
    const { name } = tool;
    if (seenNames.has(name)) {
      throw new NodeOperationError(
        ctx.getNode(),
        `You have multiple tools with the same name: '${name}', please rename them to avoid conflicts`,
      );
    }
    seenNames.add(name);

    finalTools.push(tool);
  }

  return finalTools;
};

// ---------------------------------------------------------------------------
// Storage path resolution & migration
// ---------------------------------------------------------------------------

/**
 * Resolves the n8n `.n8n` folder using the same logic as n8n-core:
 *   N8N_USER_FOLDER > $HOME > process.cwd()
 */
function getN8nFolder(): string {
  const homeVarName = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const userHome = process.env.N8N_USER_FOLDER ?? process.env[homeVarName] ?? process.cwd();
  return path.join(userHome, '.n8n');
}

/**
 * Validates a resolved storage path against traversal attacks.
 */
function validateStoragePath(resolved: string): void {
  if (resolved.includes('..') || resolved.startsWith('/etc') || resolved.startsWith('/dev')) {
    throw new Error(`Invalid storage path: ${resolved}`);
  }
}

export interface StoragePathOptions {
  /** Custom storage directory from node parameter (empty = use default) */
  customStoragePath: string;
  /** Workflow ID (falls back to 'default') */
  workflowId: string;
}

/**
 * Resolves the persist path for Graphology embedded storage.
 *
 * Priority:
 *   1. Custom path provided by the user  →  {customPath}/{workflowId}-engram.json
 *   2. Default n8n storage location      →  ~/.n8n/storage/n8n-nodes-engram/{workflowId}-engram.json
 */
export function resolveStoragePath(opts: StoragePathOptions): string {
  const workflowId = opts.workflowId || 'default';
  const filename = `${workflowId}-engram.json`;

  if (opts.customStoragePath && opts.customStoragePath.trim()) {
    const resolved = path.resolve(opts.customStoragePath.trim());
    validateStoragePath(resolved);
    return path.join(resolved, filename);
  }

  const n8nFolder = getN8nFolder();
  return path.join(n8nFolder, 'storage', 'n8n-nodes-engram', filename);
}

export interface MigrationOptions {
  /** The new resolved persist path */
  newPath: string;
  /** Workflow ID for computing the legacy path */
  workflowId: string;
  /** Workflow static data (node-scoped) for tracking path changes */
  staticData: IDataObject;
  /** Optional logger */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Auto-migrates graph data from legacy or previously-configured locations
 * to the new persist path.
 *
 * - If data already exists at `newPath` → no-op (idempotent).
 * - Checks the last-used path in workflow static data, then the legacy
 *   relative path `engram-data/{workflowId}-engram.json`.
 * - **Copies** (does not move) the source file — the original is preserved.
 * - Stores the current path in static data for future migration detection.
 * - Never throws — migration failure is logged but does not break the workflow.
 */
export function migrateStorageIfNeeded(opts: MigrationOptions): void {
  const { newPath, workflowId, staticData, logger } = opts;

  try {
    // Already have data at the new location — nothing to do
    if (fs.existsSync(newPath)) {
      staticData.__engramPersistPath = newPath;
      return;
    }

    const candidates: string[] = [];

    // 1. Last-used path from workflow static data
    const lastPath = staticData.__engramPersistPath as string | undefined;
    if (lastPath && lastPath !== newPath && fs.existsSync(lastPath)) {
      candidates.push(lastPath);
    }

    // 2. Default n8n storage path (handles switching from default → custom)
    const n8nFolder = getN8nFolder();
    const defaultPath = path.join(
      n8nFolder,
      'storage',
      'n8n-nodes-engram',
      `${workflowId}-engram.json`,
    );
    if (
      defaultPath !== newPath &&
      !candidates.includes(defaultPath) &&
      fs.existsSync(defaultPath)
    ) {
      candidates.push(defaultPath);
    }

    // 3. Legacy relative path (pre-v0.2.7) — resolved from CWD
    const legacyPath = path.resolve(`engram-data/${workflowId}-engram.json`);
    if (legacyPath !== newPath && !candidates.includes(legacyPath) && fs.existsSync(legacyPath)) {
      candidates.push(legacyPath);
    }

    // 4. Legacy path relative to n8n home (Docker containers may differ in CWD)
    const legacyN8nPath = path.join(n8nFolder, '..', `engram-data/${workflowId}-engram.json`);
    const resolvedLegacyN8n = path.resolve(legacyN8nPath);
    if (
      resolvedLegacyN8n !== newPath &&
      !candidates.includes(resolvedLegacyN8n) &&
      resolvedLegacyN8n !== legacyPath &&
      fs.existsSync(resolvedLegacyN8n)
    ) {
      candidates.push(resolvedLegacyN8n);
    }

    if (candidates.length > 0) {
      const sourcePath = candidates[0];
      const dir = path.dirname(newPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.copyFileSync(sourcePath, newPath);
      logger?.info(`Engram: Migrated graph data from ${sourcePath} to ${newPath}`);
    }

    // Store current path for future migration detection
    staticData.__engramPersistPath = newPath;
  } catch (err) {
    logger?.warn(`Engram: Storage migration failed: ${(err as Error).message}`);
    // Do NOT update staticData on failure — leave old path so next execution retries
  }
}
