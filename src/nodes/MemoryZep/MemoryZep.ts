/* eslint-disable n8n-nodes-base/node-dirname-against-convention */
import {
  NodeConnectionType,
  type IExecuteFunctions,
  type INodeType,
  type INodeTypeDescription,
  type SupplyData,
  NodeOperationError,
  IDataObject,
} from "n8n-workflow";
import { ZepMemory } from "@langchain/community/memory/zep";
import { ZepCloudMemory } from "@langchain/community/memory/zep_cloud";
import { ZepClient, Session, ISession } from "@getzep/zep-js";

import { logWrapper } from "../../utils/logWrapper";
import { getConnectionHintNoticeField } from "../../utils/sharedFields";
import { sessionIdOption, sessionKeyProperty } from "../../descriptions";
import { getSessionId } from "../../utils/helpers";
import type { BaseChatMemory } from "@langchain/community/dist/memory/chat_memory";
import type { InputValues, MemoryVariables } from "@langchain/core/memory";
import type { BaseMessage } from "@langchain/core/messages";

// Extend ZepCloudMemory to trim white space in messages.
class WhiteSpaceTrimmedZepCloudMemory extends ZepCloudMemory {
  override async loadMemoryVariables(
    values: InputValues
  ): Promise<MemoryVariables> {
    const memoryVariables = await super.loadMemoryVariables(values);
    memoryVariables.chat_history = memoryVariables.chat_history.filter(
      (m: BaseMessage) => m.content.toString().trim()
    );
    return memoryVariables;
  }
}

export class MemoryZep implements INodeType {
  description: INodeTypeDescription = {
    displayName: "MyZep Memory",
    name: "myMemoryZep",
    icon: "file:zep.png",
    group: ["transform"],
    version: [1, 1.1, 1.2],
    description: "Use MyZep Memory",
    defaults: {
      name: "MyZep",
    },
    codex: {
      categories: ["AI"],
      subcategories: {
        AI: ["Memory"],
      },
      resources: {
        primaryDocumentation: [
          {
            url: "https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memoryzep/",
          },
        ],
      },
    },
    inputs: [],
    outputs: [NodeConnectionType.AiMemory],
    outputNames: ["Memory"],
    credentials: [
      {
        name: "myZepApi",
        required: true,
      },
    ],
    properties: [
      getConnectionHintNoticeField([NodeConnectionType.AiAgent]),
      {
        ...sessionIdOption,
        displayOptions: {
          show: {
            "@version": [{ _cnd: { gte: 1.2 } }],
          },
        },
      },
      sessionKeyProperty,
      {
        displayName: "Session Metadata",
        name: "sessionMetadata",
        type: "fixedCollection",
        typeOptions: {
          multipleValues: true,
        },
        default: {},
        options: [
          {
            name: "metadataValues",
            displayName: "Metadata",
            values: [
              {
                displayName: "Key",
                name: "key",
                type: "string",
                default: "",
              },
              {
                displayName: "Value",
                name: "value",
                type: "string",
                default: "",
              },
            ],
          },
        ],
        displayOptions: {
          show: {
            "@version": [{ _cnd: { gte: 1.2 } }],
          },
        },
      },
    ],
  };

  async supplyData(
    this: IExecuteFunctions,
    itemIndex: number
  ): Promise<SupplyData> {
    const credentials = await this.getCredentials("myZepApi");
    console.log("credentials", credentials);

    if (!credentials.apiKey) {
      throw new NodeOperationError(this.getNode(), "API key is required");
    }

    const nodeVersion = this.getNode().typeVersion;
    console.log("nodeVersion", nodeVersion);
    const sessionId =
      nodeVersion >= 1.2
        ? getSessionId(this, itemIndex)
        : (this.getNodeParameter("sessionId", itemIndex) as string);
    console.log("sessionId", sessionId);
    const sessionMetadataValues = this.getNodeParameter(
      "sessionMetadata.metadataValues",
      itemIndex,
      []
    ) as IDataObject[];
    const sessionMetadata: IDataObject = {};
    for (const metadata of sessionMetadataValues) {
      sessionMetadata[metadata.key as string] = metadata.value;
    }

    let memory: BaseChatMemory;
    let zepClient: ZepClient | undefined;

    try {
      const isCloud = credentials.cloud as boolean;
      const apiUrl = isCloud
        ? "https://api.getzep.com"
        : (credentials.apiUrl as string);

      if (!isCloud && !apiUrl) {
        throw new NodeOperationError(
          this.getNode(),
          "API URL is required for MyZep Open Source"
        );
      }

      // Initialize ZepClient using the init method
      if (Object.keys(sessionMetadata).length > 0 || !isCloud) {
        console.log("initializing ZepClient");
        try {
          zepClient = await ZepClient.init(apiUrl, credentials.apiKey as string);
        } catch (error) {
          console.error("Error initializing ZepClient:", error);
          throw new Error(
            `Failed to initialize ZepClient: ${(error as Error).message}`
          );
        }
      }

      if (isCloud) {
        console.log("initializing WhiteSpaceTrimmedZepCloudMemory");
        memory = new WhiteSpaceTrimmedZepCloudMemory({
          sessionId,
          apiKey: credentials.apiKey as string,
          memoryType: "perpetual",
          memoryKey: "chat_history",
          returnMessages: true,
          inputKey: "input",
          outputKey: "output",
          separateMessages: false,
        });
      } else {
        memory = new ZepMemory({
          sessionId,
          baseURL: apiUrl,
          apiKey: credentials.apiKey as string,
          memoryKey: "chat_history",
          returnMessages: true,
          inputKey: "input",
          outputKey: "output",
        });
      }

      // Use ZepClient only if it was initialized and there's metadata to add
      if (zepClient && Object.keys(sessionMetadata).length > 0) {
        console.log("adding session metadata to ZepClient");
        const sessionData: ISession = {
          session_id: sessionId,
          metadata: sessionMetadata,
        };
        const session = new Session(sessionData);
        console.log("session", session);
        try {
          await zepClient.memory.addSession(session);
          console.log("session added");
        } catch (error) {
          console.error("Error adding session:", error);
          throw new Error(
            `Failed to add session: ${(error as Error).message}`
          );
        }
      }

      return {
        response: logWrapper(memory, this),
      };
    } catch (error: unknown) {
      throw new NodeOperationError(
        this.getNode(),
        `Failed to initialize MyZep memory: ${(error as Error).message}`,
        { description: "Check your API key and URL (for non-cloud usage)" }
      );
    }
  }
}
