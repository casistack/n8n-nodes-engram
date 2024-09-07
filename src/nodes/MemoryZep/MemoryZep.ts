/* eslint-disable n8n-nodes-base/node-dirname-against-convention */
import {
	NodeConnectionType,
	type IExecuteFunctions,
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
	NodeOperationError,
	IDataObject,
} from 'n8n-workflow';
import { ZepMemory } from '@langchain/community/memory/zep';
import { ZepCloudMemory } from '@langchain/community/memory/zep_cloud';
import { ZepClient, Session } from "@getzep/zep-js";

import { logWrapper } from '../../utils/logWrapper';
import { getConnectionHintNoticeField } from '../../utils/sharedFields';
import { sessionIdOption, sessionKeyProperty } from '../../descriptions';
import { getSessionId } from '../../utils/helpers';
import type { BaseChatMemory } from '@langchain/community/dist/memory/chat_memory';
import type { InputValues, MemoryVariables } from '@langchain/core/memory';
import type { BaseMessage } from '@langchain/core/messages';

// Extend ZepCloudMemory to trim white space in messages.
class WhiteSpaceTrimmedZepCloudMemory extends ZepCloudMemory {
	override async loadMemoryVariables(values: InputValues): Promise<MemoryVariables> {
		const memoryVariables = await super.loadMemoryVariables(values);
		memoryVariables.chat_history = memoryVariables.chat_history.filter((m: BaseMessage) =>
			m.content.toString().trim(),
		);
		return memoryVariables;
	}
}

export class MemoryZep implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MyZep Memory',
		name: 'myMemoryZep',
		icon: 'file:zep.png',
		group: ['transform'],
		version: [1, 1.1, 1.2],
		description: 'Use MyZep Memory',
		defaults: {
			name: 'MyZep',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Memory'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memoryzep/',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionType.AiMemory],
		outputNames: ['Memory'],
		credentials: [
			{
				name: 'myZepApi',
				required: true,
			},
		],
		properties: [
			getConnectionHintNoticeField([NodeConnectionType.AiAgent]),
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						'@version': [1],
					},
				},
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				description: 'The key to use to store the memory',
				displayOptions: {
					show: {
						'@version': [1.1],
					},
				},
			},
			{
				...sessionIdOption,
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.2 } }],
					},
				},
			},
			sessionKeyProperty,
			{
				displayName: 'Session Metadata',
				name: 'sessionMetadata',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				options: [
					{
						name: 'metadataValues',
						displayName: 'Metadata',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
				displayOptions: {
					show: {
						'@version': [{ _cnd: { gte: 1.2 } }],
					},
				},
			},
		],
	};

	async supplyData(this: IExecuteFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('myZepApi');

		console.log('Credentials:', JSON.stringify({ ...credentials, apiKey: '[REDACTED]' }));

		if (!credentials.apiKey) {
			throw new NodeOperationError(this.getNode(), 'API key is required');
		}

		const nodeVersion = this.getNode().typeVersion;
		console.log('Node version:', nodeVersion);

		const sessionId = nodeVersion >= 1.2
			? getSessionId(this, itemIndex)
			: this.getNodeParameter('sessionId', itemIndex) as string;
		console.log('Session ID:', sessionId);

		const sessionMetadataValues = this.getNodeParameter('sessionMetadata.metadataValues', itemIndex, []) as IDataObject[];
		const sessionMetadata: IDataObject = {};
		for (const metadata of sessionMetadataValues) {
			sessionMetadata[metadata.key as string] = metadata.value;
		}
		console.log('Session Metadata:', sessionMetadata);

		let memory: BaseChatMemory;
		let zepClient: ZepClient;

		try {
			const isCloud = credentials.cloud as boolean;
			console.log('Is Cloud:', isCloud);

			let apiUrl: string;
			if (isCloud) {
				apiUrl = "https://api.getzep.com";
			} else {
				if (!credentials.apiUrl) {
					throw new NodeOperationError(this.getNode(), 'API URL is required for MyZep Open Source');
				}
				apiUrl = credentials.apiUrl as string;
				// Ensure the API URL ends with a trailing slash
				if (!apiUrl.endsWith('/')) {
					apiUrl += '/';
				}
			}
			console.log('API URL:', apiUrl);

			console.log('Initializing ZepClient');
			try {
				// Create ZepClient instance
				zepClient = new ZepClient(apiUrl, credentials.apiKey as string);

				if (isCloud) {
					// For cloud version, perform health check
					console.log('Performing health check for cloud version');
					const healthResponse = await fetch(`${apiUrl}healthz`, {
						headers: zepClient.headers,
					});
					if (!healthResponse.ok) {
						throw new Error(`Server health check failed: ${healthResponse.statusText}`);
					}
				} else {
					// For open-source version, try to fetch the server version
					console.log('Fetching server version for open-source');
					// const versionResponse = await fetch(`${apiUrl}version`, {
					// 	headers: zepClient.headers,
					// });
					// if (!versionResponse.ok) {
					// 	throw new Error(`Failed to fetch server version: ${versionResponse.statusText}`);
					// }
					// const versionInfo = await versionResponse.json();
					// console.log('Zep Server Version:', versionInfo.version);
				}

				console.log('ZepClient initialized successfully');
			} catch (error) {
				console.error('Error initializing ZepClient:', error);
				throw new NodeOperationError(
					this.getNode(),
					`Failed to initialize ZepClient: ${(error as Error).message}`,
					{ description: 'Check your API key and URL, and ensure the Zep server is accessible' }
				);
			}

			if (isCloud) {
				console.log('Initializing WhiteSpaceTrimmedZepCloudMemory');
				memory = new WhiteSpaceTrimmedZepCloudMemory({
					sessionId,
					apiKey: credentials.apiKey as string,
					memoryType: 'perpetual',
					memoryKey: 'chat_history',
					returnMessages: true,
					inputKey: 'input',
					outputKey: 'output',
					separateMessages: false,
				});
			} else {
				console.log('Initializing ZepMemory');
				memory = new ZepMemory({
					sessionId,
					baseURL: apiUrl,
					apiKey: credentials.apiKey as string,
					memoryKey: 'chat_history',
					returnMessages: true,
					inputKey: 'input',
					outputKey: 'output',
				});
			}

			// Create a Session instance
			const session = new Session({
				session_id: sessionId,
				metadata: sessionMetadata,
			});

			console.log('Adding session with metadata');
			// Add or update session with metadata
			await zepClient.memory.addSession(session);

			console.log('Zep memory initialized successfully');
			return {
				response: logWrapper(memory, this),
			};
		} catch (error) {
			console.error('Error initializing Zep memory:', error);
			throw new NodeOperationError(
				this.getNode(),
				`Failed to initialize Zep memory: ${(error as Error).message}`,
				{ description: 'Check your API key and URL (for non-cloud usage)' }
			);
		}
	}
}