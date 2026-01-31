import type {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class EngramExtractionApi implements ICredentialType {
	name = 'engramExtractionApi';

	displayName = 'Engram Extraction LLM';

	documentationUrl = 'https://github.com/casistack/n8n-nodes-engram';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'API key for the LLM provider (OpenAI, OpenRouter, or any OpenAI-compatible service)',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.openai.com/v1',
			hint: 'OpenAI: https://api.openai.com/v1 | OpenRouter: https://openrouter.ai/api/v1 | Ollama: http://localhost:11434/v1',
			description:
				'Base URL for the OpenAI-compatible API endpoint. The model list is fetched from this URL.',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/models',
			method: 'GET',
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
