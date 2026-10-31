import type { INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { apiCallFields, apiCallOperation } from './apiCall';
import { fieldProperties, operationProperties, resourceProperty } from './generated/description';
import { loadOptions } from './generated/lookups';

export class Vantaris implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'VantarIS',
		name: 'vantaris',
		icon: { light: 'file:vantaris.svg', dark: 'file:vantaris.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Work with tickets, tasks, assets, risks, processes, documents and controls in VantarIS',
		defaults: {
			name: 'VantarIS',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'vantarisApi',
				required: true,
			},
		],
		requestDefaults: {
			baseURL:
				'={{ String($credentials.baseUrl).trim().replace(/\\/+$/, "").replace(/\\/api\\/v1$/i, "") + "/api/v1" }}',
			headers: {
				Accept: 'application/json',
			},
			ignoreHttpStatusErrors: true,
		},
		properties: [resourceProperty, ...operationProperties, apiCallOperation, ...fieldProperties, ...apiCallFields],
	};

	methods = { loadOptions };
}
