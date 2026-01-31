import {
	NodeConnectionType,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IDataObject,
	NodeOperationError,
} from 'n8n-workflow';

import { createStorage } from '../../storage/StorageFactory';
import type { GraphData } from '../../schemas';
import { nowIso } from '../../utils/temporal';
import { CommunityDetector } from '../../community/CommunityDetector';
import { CommunitySummarizer } from '../../community/CommunitySummarizer';
import { LlmClient } from '../../extraction/LlmClient';

export class EngramAdmin implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Engram Admin',
		name: 'engramAdmin',
		icon: 'file:engram-admin.png',
		group: ['transform'],
		version: 1,
		description: 'Manage and administer the Engram knowledge graph',
		defaults: {
			name: 'Engram Admin',
		},
		inputs: [NodeConnectionType.Main],
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
			{
				name: 'engramExtractionApi',
				required: false,
				displayOptions: {
					show: {
						generateSummaries: [true],
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
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					// --- Monitoring ---
					{
						name: 'Stats',
						value: 'stats',
						description: 'Get graph statistics with enhanced metrics',
					},
					{
						name: 'List Groups',
						value: 'listGroups',
						description: 'List all groups/sessions with per-group statistics',
					},
					{
						name: 'Group Stats',
						value: 'groupStats',
						description: 'Get detailed statistics for a specific group/session',
					},
					// --- Data Lifecycle ---
					{
						name: 'Apply Retention',
						value: 'applyRetention',
						description: 'Remove old episodes based on a retention policy',
					},
					{
						name: 'Clear Group',
						value: 'clearGroup',
						description: 'Clear all data for a specific group/session',
					},
					{
						name: 'Bulk Clear Groups',
						value: 'bulkClearGroups',
						description: 'Clear multiple groups/sessions at once',
					},
					{
						name: 'Clear All',
						value: 'clearAll',
						description: 'Clear ALL data from the graph (destructive!)',
					},
					// --- Data Hygiene ---
					{
						name: 'Orphaned Entities',
						value: 'orphanedEntities',
						description: 'Find or remove entities with no relationships',
					},
					{
						name: 'Duplicate Entities',
						value: 'duplicateEntities',
						description: 'Find entities with duplicate or similar names',
					},
					{
						name: 'Expire Stale Edges',
						value: 'expireStaleEdges',
						description: 'Find and expire edges with broken references or past validity',
					},
					// --- Data Portability ---
					{
						name: 'Export',
						value: 'export',
						description: 'Export graph data as JSON',
					},
					{
						name: 'Import',
						value: 'import',
						description: 'Import graph data from JSON',
					},
					// --- Analysis ---
					{
						name: 'Detect Communities',
						value: 'detectCommunities',
						description: 'Detect entity communities/clusters using label propagation',
					},
				],
				default: 'stats',
			},
			// --- Group ID (required) for single-group operations ---
			{
				displayName: 'Group ID',
				name: 'groupId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: [
							'clearGroup',
							'applyRetention',
							'groupStats',
							'expireStaleEdges',
							'duplicateEntities',
							'orphanedEntities',
							'detectCommunities',
						],
					},
				},
				description: 'The group/session ID to operate on',
			},
			// --- Group ID (optional filter) for global operations ---
			{
				displayName: 'Group ID',
				name: 'groupIdFilter',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['export', 'stats'],
					},
				},
				description: 'Optional: limit to a specific group/session. Leave empty to include all groups.',
			},
			// --- Retention parameters ---
			{
				displayName: 'Retention Type',
				name: 'retentionType',
				type: 'options',
				options: [
					{
						name: 'Keep for N Days',
						value: 'days',
						description: 'Delete episodes older than N days',
					},
					{
						name: 'Keep Last N Episodes',
						value: 'max_episodes',
						description: 'Keep only the most recent N episodes',
					},
				],
				default: 'days',
				displayOptions: {
					show: {
						operation: ['applyRetention'],
					},
				},
				description: 'How to determine which episodes to remove',
			},
			{
				displayName: 'Retention Value',
				name: 'retentionValue',
				type: 'number',
				default: 30,
				typeOptions: {
					minValue: 1,
				},
				displayOptions: {
					show: {
						operation: ['applyRetention'],
					},
				},
				description: 'Number of days or maximum episodes to keep',
			},
			// --- Bulk clear parameters ---
			{
				displayName: 'Group IDs',
				name: 'groupIds',
				type: 'json',
				default: '[]',
				required: true,
				displayOptions: {
					show: {
						operation: ['bulkClearGroups'],
					},
				},
				description: 'JSON array of group/session IDs to clear, e.g. ["session-1", "session-2"]',
			},
			{
				displayName: 'Confirm Destructive',
				name: 'confirmDestructive',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['bulkClearGroups'],
					},
				},
				description: 'Safety latch: must be enabled for the bulk clear to proceed',
			},
			// --- Orphaned entities parameters ---
			{
				displayName: 'Delete Orphans',
				name: 'deleteOrphans',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['orphanedEntities'],
					},
				},
				description: 'If enabled, orphaned entities will be deleted. Otherwise, they are only listed.',
			},
			// --- Expire stale edges parameters ---
			{
				displayName: 'Dry Run',
				name: 'dryRun',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						operation: ['expireStaleEdges'],
					},
				},
				description: 'If enabled, only reports stale edges without modifying them. Disable to actually expire them.',
			},
			// --- List groups parameters ---
			{
				displayName: 'Include Per-Group Stats',
				name: 'includeStats',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						operation: ['listGroups'],
					},
				},
				description: 'Include entity/edge/episode counts per group. Slightly slower for large deployments.',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 100,
				typeOptions: {
					minValue: 1,
					maxValue: 500,
				},
				displayOptions: {
					show: {
						operation: ['listGroups'],
					},
				},
				description: 'Maximum number of groups to return',
			},
			// --- Import data ---
			{
				displayName: 'Import Data',
				name: 'importData',
				type: 'json',
				default: '{}',
				required: true,
				displayOptions: {
					show: {
						operation: ['import'],
					},
				},
				description: 'JSON data to import (must contain entities, edges, and episodes arrays from a previous export)',
			},
			// --- Community Detection Parameters ---
			{
				displayName: 'Min Community Size',
				name: 'minCommunitySize',
				type: 'number',
				default: 2,
				typeOptions: {
					minValue: 2,
					maxValue: 100,
				},
				displayOptions: {
					show: {
						operation: ['detectCommunities'],
					},
				},
				description: 'Minimum number of entities required to form a community',
			},
			{
				displayName: 'Generate Summaries',
				name: 'generateSummaries',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['detectCommunities'],
					},
				},
				description: 'Use an LLM to generate natural language summaries for each community. Requires Engram Extraction LLM credential.',
			},
			{
				displayName: 'Summary Model',
				name: 'summaryModel',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['detectCommunities'],
						generateSummaries: [true],
					},
				},
				placeholder: 'e.g. gpt-4o-mini',
				description: 'LLM model to use for generating community summaries',
			},
			{
				displayName: 'Summary Concurrency',
				name: 'summaryConcurrency',
				type: 'number',
				default: 3,
				typeOptions: {
					minValue: 1,
					maxValue: 10,
				},
				displayOptions: {
					show: {
						operation: ['detectCommunities'],
						generateSummaries: [true],
					},
				},
				description: 'Number of communities to summarize concurrently',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const backend = this.getNodeParameter('backend', 0, 'embedded') as string;
		const operation = this.getNodeParameter('operation', 0) as string;

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
			storage = createStorage({
				backend: 'embedded',
				persistPath: `engram-data/${workflowId}-engram.json`,
			});
		}
		await storage.initialize();

		const returnData: INodeExecutionData[] = [];

		try {
			for (let i = 0; i < items.length; i++) {
				try {
					switch (operation) {
						// =============================================
						// MONITORING
						// =============================================
						case 'stats': {
							const groupId = this.getNodeParameter('groupIdFilter', i, '') as string;
							const baseStats = await storage.getStats(groupId || undefined);
							const data = await storage.exportGraph(groupId || undefined);

							const activeEdges = data.edges.filter((e) => e.expired_at === null).length;
							const expiredEdges = data.edges.filter((e) => e.expired_at !== null).length;
							const groupCount = baseStats.group_ids.length;

							const enhancedStats = {
								...baseStats,
								group_count: groupCount,
								active_edge_count: activeEdges,
								expired_edge_count: expiredEdges,
								avg_edges_per_entity: baseStats.entity_count > 0
									? Math.round((baseStats.edge_count / baseStats.entity_count) * 100) / 100
									: 0,
								avg_episodes_per_group: groupCount > 0
									? Math.round((baseStats.episode_count / groupCount) * 100) / 100
									: 0,
								storage_backend: backend,
								data_span_days:
									baseStats.oldest_episode && baseStats.newest_episode
										? Math.round(
												((new Date(baseStats.newest_episode).getTime() -
													new Date(baseStats.oldest_episode).getTime()) /
													(1000 * 60 * 60 * 24)) *
													10,
											) / 10
										: null,
							};

							returnData.push({ json: enhancedStats as unknown as IDataObject });
							break;
						}

						case 'listGroups': {
							const includeStats = this.getNodeParameter('includeStats', i, true) as boolean;
							const limit = this.getNodeParameter('limit', i, 100) as number;
							const globalStats = await storage.getStats();
							const allGroupIds = globalStats.group_ids.slice(0, limit);

							if (includeStats) {
								for (const gid of allGroupIds) {
									const gStats = await storage.getStats(gid);
									returnData.push({
										json: {
											group_id: gid,
											entity_count: gStats.entity_count,
											edge_count: gStats.edge_count,
											episode_count: gStats.episode_count,
											entity_types: gStats.entity_types,
											oldest_episode: gStats.oldest_episode,
											newest_episode: gStats.newest_episode,
										},
									});
								}
							} else {
								for (const gid of allGroupIds) {
									returnData.push({ json: { group_id: gid } });
								}
							}

							if (returnData.length === 0) {
								returnData.push({
									json: {
										message: 'No groups found',
										total_groups: 0,
									},
								});
							}
							break;
						}

						case 'groupStats': {
							const groupId = this.getNodeParameter('groupId', i) as string;
							if (!groupId) {
								throw new NodeOperationError(
									this.getNode(),
									'Group ID is required for Group Stats operation',
									{ itemIndex: i },
								);
							}

							const gStats = await storage.getStats(groupId);
							const gData = await storage.exportGraph(groupId);

							const activeEdges = gData.edges.filter((e) => e.expired_at === null).length;
							const expiredEdges = gData.edges.filter((e) => e.expired_at !== null).length;

							// Find relationship types
							const relationshipTypes: Record<string, number> = {};
							for (const edge of gData.edges) {
								relationshipTypes[edge.name] = (relationshipTypes[edge.name] || 0) + 1;
							}

							returnData.push({
								json: {
									group_id: groupId,
									entity_count: gStats.entity_count,
									edge_count: gStats.edge_count,
									episode_count: gStats.episode_count,
									entity_types: gStats.entity_types,
									relationship_types: relationshipTypes,
									active_edge_count: activeEdges,
									expired_edge_count: expiredEdges,
									avg_edges_per_entity: gStats.entity_count > 0
										? Math.round((gStats.edge_count / gStats.entity_count) * 100) / 100
										: 0,
									oldest_episode: gStats.oldest_episode,
									newest_episode: gStats.newest_episode,
									data_span_days:
										gStats.oldest_episode && gStats.newest_episode
											? Math.round(
													((new Date(gStats.newest_episode).getTime() -
														new Date(gStats.oldest_episode).getTime()) /
														(1000 * 60 * 60 * 24)) *
														10,
												) / 10
											: null,
								},
							});
							break;
						}

						// =============================================
						// DATA LIFECYCLE
						// =============================================
						case 'applyRetention': {
							const groupId = this.getNodeParameter('groupId', i) as string;
							if (!groupId) {
								throw new NodeOperationError(
									this.getNode(),
									'Group ID is required for Apply Retention operation',
									{ itemIndex: i },
								);
							}
							const retentionType = this.getNodeParameter('retentionType', i) as string;
							const retentionValue = this.getNodeParameter('retentionValue', i) as number;

							const removed = await storage.applyRetention(groupId, {
								type: retentionType as 'days' | 'max_episodes',
								value: retentionValue,
							});

							returnData.push({
								json: {
									success: true,
									operation: 'applyRetention',
									group_id: groupId,
									policy: { type: retentionType, value: retentionValue },
									episodes_removed: removed,
								},
							});
							break;
						}

						case 'clearGroup': {
							const groupId = this.getNodeParameter('groupId', i) as string;
							if (!groupId) {
								throw new NodeOperationError(
									this.getNode(),
									'Group ID is required for Clear Group operation',
									{
										itemIndex: i,
										description: 'Provide the session/group ID whose data you want to delete.',
									},
								);
							}
							await storage.clearGroup(groupId);
							returnData.push({
								json: { success: true, operation: 'clearGroup', group_id: groupId },
							});
							break;
						}

						case 'bulkClearGroups': {
							const confirmDestructive = this.getNodeParameter('confirmDestructive', i, false) as boolean;
							if (!confirmDestructive) {
								throw new NodeOperationError(
									this.getNode(),
									'Confirm Destructive must be enabled to proceed with Bulk Clear Groups',
									{
										itemIndex: i,
										description: 'This is a safety measure. Enable "Confirm Destructive" to proceed.',
									},
								);
							}

							const groupIdsRaw = this.getNodeParameter('groupIds', i) as unknown;
							let groupIds: string[];
							if (Array.isArray(groupIdsRaw)) {
								groupIds = groupIdsRaw.filter((id): id is string => typeof id === 'string' && id.length > 0);
							} else {
								throw new NodeOperationError(
									this.getNode(),
									'Group IDs must be a JSON array of strings',
									{ itemIndex: i },
								);
							}

							if (groupIds.length === 0) {
								throw new NodeOperationError(
									this.getNode(),
									'Group IDs array is empty',
									{ itemIndex: i },
								);
							}

							const cleared: string[] = [];
							const failed: Array<{ group_id: string; error: string }> = [];

							for (const gid of groupIds) {
								try {
									await storage.clearGroup(gid);
									cleared.push(gid);
								} catch (err) {
									failed.push({ group_id: gid, error: (err as Error).message });
								}
							}

							returnData.push({
								json: {
									success: failed.length === 0,
									operation: 'bulkClearGroups',
									cleared,
									failed,
									total_cleared: cleared.length,
									total_failed: failed.length,
								},
							});
							break;
						}

						case 'clearAll': {
							await storage.clearAll();
							returnData.push({
								json: { success: true, operation: 'clearAll' },
							});
							break;
						}

						// =============================================
						// DATA HYGIENE
						// =============================================
						case 'orphanedEntities': {
							const groupId = this.getNodeParameter('groupId', i) as string;
							if (!groupId) {
								throw new NodeOperationError(
									this.getNode(),
									'Group ID is required for Orphaned Entities operation',
									{ itemIndex: i },
								);
							}
							const deleteOrphans = this.getNodeParameter('deleteOrphans', i, false) as boolean;

							const entities = await storage.listEntities(groupId, { limit: 10000 });
							const orphaned: Array<{
								uuid: string;
								name: string;
								entity_type: string;
								summary: string;
								created_at: string;
							}> = [];

							for (const entity of entities) {
								const edges = await storage.getEdgesForEntity(entity.uuid);
								if (edges.length === 0) {
									orphaned.push({
										uuid: entity.uuid,
										name: entity.name,
										entity_type: entity.entity_type,
										summary: entity.summary,
										created_at: entity.created_at,
									});
								}
							}

							if (deleteOrphans) {
								for (const o of orphaned) {
									await storage.deleteEntity(o.uuid);
								}
							}

							returnData.push({
								json: {
									operation: 'orphanedEntities',
									group_id: groupId,
									orphaned,
									total_orphaned: orphaned.length,
									deleted: deleteOrphans,
								},
							});
							break;
						}

						case 'duplicateEntities': {
							const groupId = this.getNodeParameter('groupId', i) as string;
							if (!groupId) {
								throw new NodeOperationError(
									this.getNode(),
									'Group ID is required for Duplicate Entities operation',
									{ itemIndex: i },
								);
							}

							const entities = await storage.listEntities(groupId, { limit: 10000 });
							const nameMap = new Map<string, typeof entities>();

							for (const entity of entities) {
								const key = entity.name.toLowerCase().trim();
								if (!nameMap.has(key)) nameMap.set(key, []);
								nameMap.get(key)!.push(entity);
							}

							const duplicateGroups: Array<{
								canonical_name: string;
								count: number;
								entities: Array<{
									uuid: string;
									name: string;
									entity_type: string;
									edge_count: number;
									created_at: string;
								}>;
							}> = [];

							for (const [canonicalName, group] of nameMap) {
								if (group.length > 1) {
									const enriched = [];
									for (const e of group) {
										const edges = await storage.getEdgesForEntity(e.uuid);
										enriched.push({
											uuid: e.uuid,
											name: e.name,
											entity_type: e.entity_type,
											edge_count: edges.length,
											created_at: e.created_at,
										});
									}
									duplicateGroups.push({
										canonical_name: canonicalName,
										count: group.length,
										entities: enriched,
									});
								}
							}

							returnData.push({
								json: {
									operation: 'duplicateEntities',
									group_id: groupId,
									duplicate_groups: duplicateGroups,
									total_duplicate_groups: duplicateGroups.length,
								},
							});
							break;
						}

						case 'expireStaleEdges': {
							const groupId = this.getNodeParameter('groupId', i) as string;
							if (!groupId) {
								throw new NodeOperationError(
									this.getNode(),
									'Group ID is required for Expire Stale Edges operation',
									{ itemIndex: i },
								);
							}
							const dryRun = this.getNodeParameter('dryRun', i, true) as boolean;

							const data = await storage.exportGraph(groupId);
							const entityUuids = new Set(data.entities.map((e) => e.uuid));
							const staleEdges: Array<{
								uuid: string;
								name: string;
								fact: string;
								reason: string;
							}> = [];

							for (const edge of data.edges) {
								if (edge.expired_at) continue; // already expired

								if (
									!entityUuids.has(edge.source_node_uuid) ||
									!entityUuids.has(edge.target_node_uuid)
								) {
									staleEdges.push({
										uuid: edge.uuid,
										name: edge.name,
										fact: edge.fact,
										reason: 'dangling_reference',
									});
								} else if (edge.invalid_at && new Date(edge.invalid_at) < new Date()) {
									staleEdges.push({
										uuid: edge.uuid,
										name: edge.name,
										fact: edge.fact,
										reason: 'past_invalid_at',
									});
								}
							}

							if (!dryRun) {
								for (const edge of staleEdges) {
									await storage.updateEdge(edge.uuid, { expired_at: nowIso() });
								}
							}

							returnData.push({
								json: {
									operation: 'expireStaleEdges',
									group_id: groupId,
									dry_run: dryRun,
									stale_edges: staleEdges,
									total_stale: staleEdges.length,
									expired: !dryRun,
								},
							});
							break;
						}

						// =============================================
						// ANALYSIS
						// =============================================
						case 'detectCommunities': {
							const groupId = this.getNodeParameter('groupId', i) as string;
							if (!groupId) {
								throw new NodeOperationError(
									this.getNode(),
									'Group ID is required for Detect Communities operation',
									{ itemIndex: i },
								);
							}

							const minCommunitySize = this.getNodeParameter('minCommunitySize', i, 2) as number;
							const generateSummaries = this.getNodeParameter('generateSummaries', i, false) as boolean;

							const detector = new CommunityDetector(storage);
							let result = await detector.detect(groupId, { minCommunitySize });

							if (generateSummaries) {
								const extractionCreds = await this.getCredentials('engramExtractionApi');
								const model = this.getNodeParameter('summaryModel', i, '') as string;
								const concurrency = this.getNodeParameter('summaryConcurrency', i, 3) as number;

								if (!model) {
									throw new NodeOperationError(
										this.getNode(),
										'Summary Model is required when Generate Summaries is enabled',
										{ itemIndex: i },
									);
								}

								const llm = new LlmClient({
									apiKey: extractionCreds.apiKey as string,
									baseUrl: extractionCreds.baseUrl as string,
									model,
								});
								const summarizer = new CommunitySummarizer(llm);
								result = await summarizer.summarizeAll(result, concurrency);
							}

							returnData.push({
								json: {
									total_entities: result.total_entities,
									unclustered_entities: result.unclustered_entities,
									detection_method: result.detection_method,
									community_count: result.communities.length,
									communities: result.communities.map((c) => ({
										id: c.id,
										label: c.label,
										summary: c.summary,
										entity_count: c.entity_count,
										edge_count: c.edge_count,
										key_entities: c.key_entities,
										members: c.members.map((m) => ({
											uuid: m.entity.uuid,
											name: m.entity.name,
											entity_type: m.entity.entity_type,
											edge_count: m.edges.length,
										})),
									})),
								},
							});
							break;
						}

						// =============================================
						// DATA PORTABILITY
						// =============================================
						case 'export': {
							const groupId = this.getNodeParameter('groupIdFilter', i, '') as string;
							const data = await storage.exportGraph(groupId || undefined);
							returnData.push({ json: data as unknown as IDataObject });
							break;
						}

						case 'import': {
							const importData = this.getNodeParameter('importData', i) as unknown;
							if (
								!importData ||
								typeof importData !== 'object' ||
								!Array.isArray((importData as GraphData).entities) ||
								!Array.isArray((importData as GraphData).edges) ||
								!Array.isArray((importData as GraphData).episodes)
							) {
								throw new NodeOperationError(
									this.getNode(),
									'Invalid import data format',
									{
										itemIndex: i,
										description:
											'Import data must be a JSON object with "entities", "edges", and "episodes" arrays. Use data from a previous Export operation.',
									},
								);
							}
							await storage.importGraph(importData as GraphData);
							const graphData = importData as GraphData;
							returnData.push({
								json: {
									success: true,
									operation: 'import',
									imported: {
										entities: graphData.entities.length,
										edges: graphData.edges.length,
										episodes: graphData.episodes.length,
									},
								},
							});
							break;
						}
					}
				} catch (error: unknown) {
					if (error instanceof NodeOperationError) throw error;
					throw new NodeOperationError(
						this.getNode(),
						`Engram Admin error: ${(error as Error).message}`,
						{ itemIndex: i },
					);
				}
			}
		} finally {
			if (backend === 'neo4j') {
				await storage.close();
			}
		}

		return [returnData.length > 0 ? returnData : [{ json: {} }]];
	}
}
