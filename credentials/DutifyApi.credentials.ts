import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class DutifyApi implements ICredentialType {
	name = 'dutifyApi';

	displayName = 'Dutify API';

	icon: ICredentialType['icon'] = {
		light: 'file:../icons/dutify.svg',
		dark: 'file:../icons/dutify.dark.svg',
	};

	documentationUrl = 'https://dutify.ai/mp/api/v1/api-catalog';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://dutify.ai',
			description: 'Only change this for a self-hosted or tenant-specific Dutify instance',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			// Same as every request: a blank Base URL means https://dutify.ai, trailing slashes trimmed.
			baseURL: '={{($credentials.baseUrl || "https://dutify.ai").replace(/\\/+$/, "")}}',
			url: '/mp/api/v1/api-keys/current',
		},
	};
}
