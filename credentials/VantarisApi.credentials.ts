import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class VantarisApi implements ICredentialType {
	name = 'vantarisApi';

	displayName = 'VantarIS API';

	icon: Icon = { light: 'file:../nodes/Vantaris/vantaris.svg', dark: 'file:../nodes/Vantaris/vantaris.dark.svg' };

	documentationUrl = 'https://github.com/vantarion-de/n8n-nodes-vantaris#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Instance Address',
			name: 'baseUrl',
			type: 'string',
			default: 'https://vantaris.app',
			required: true,
			placeholder: 'e.g. https://grc.example.com',
			description:
				'Address of the VantarIS instance: https://vantaris.app, the whitelabel address of your company or the address of an on-premise installation',
		},
		{
			displayName: 'Access Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'e.g. vtk_0123456789ab_…',
			description: 'Access key from the page "API keys" of the company in VantarIS (starts with vtk_)',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{String($credentials.baseUrl).trim().replace(/\\/+$/, "").replace(/\\/api\\/v1$/i, "")}}/api/v1',
			url: '/ping',
			method: 'GET',
		},
	};
}
