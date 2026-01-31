import type {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class EngramNeo4jApi implements ICredentialType {
	name = 'engramNeo4jApi';

	displayName = 'Engram Neo4j Connection';

	documentationUrl = 'https://neo4j.com/docs/';

	properties: INodeProperties[] = [
		{
			displayName: 'URI',
			name: 'uri',
			type: 'string',
			default: 'bolt://localhost:7687',
			placeholder: 'bolt://localhost:7687',
			description: 'The Neo4j connection URI (bolt:// or neo4j://)',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: 'neo4j',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'Database',
			name: 'database',
			type: 'string',
			default: 'neo4j',
			description: 'The Neo4j database to use',
		},
	];

	// Test via Neo4j HTTP Transactional API (port 7474 maps from bolt 7687)
	test: ICredentialTestRequest = {
		request: {
			method: 'POST',
			baseURL: '={{$credentials.uri.replace("bolt://", "http://").replace("neo4j://", "http://").replace(":7687", ":7474").replace("://localhost:", "://127.0.0.1:")}}',
			url: '=/db/{{$credentials.database}}/tx/commit',
			headers: {
				'Content-Type': 'application/json',
			},
			auth: {
				username: '={{$credentials.username}}',
				password: '={{$credentials.password}}',
			},
			body: {
				statements: [{ statement: 'RETURN 1' }],
			},
		},
	};
}
