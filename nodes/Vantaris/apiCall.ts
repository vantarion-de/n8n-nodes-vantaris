import type {
	IDataObject,
	IExecuteSingleFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { handleResponse } from '../shared/transport';

const showApiCall = { show: { resource: ['apiCall'] } };

/** Declarative preSend of "API Call": query, JSON body and headers from the parameters. */
export async function prepareApiCall(this: IExecuteSingleFunctions, request: IHttpRequestOptions): Promise<IHttpRequestOptions> {
	const query = this.getNodeParameter('queryParameters', {}) as { parameter?: Array<{ name: string; value: string }> };
	const qs: IDataObject = { ...(request.qs ?? {}) };
	for (const p of query.parameter ?? []) if (p.name) qs[p.name] = p.value;
	const options = this.getNodeParameter('options', {}) as IDataObject;
	const headers: IDataObject = { ...(request.headers ?? {}) };
	if (options.ifMatch) headers['If-Match'] = options.ifMatch;
	if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
	const method = String(this.getNodeParameter('method', 'GET')) as IHttpRequestMethods;
	const out: IHttpRequestOptions = { ...request, method, qs, headers };
	if (method !== 'GET' && method !== 'DELETE' && this.getNodeParameter('sendBody', false)) {
		const raw = this.getNodeParameter('body', '{}');
		try {
			out.body = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
		} catch {
			throw new NodeOperationError(this.getNode(), "The 'Body' parameter is not valid JSON", {
				description: 'Enter a JSON object, e.g. {"name": "Firewall rules"}',
			});
		}
	} else delete out.body;
	return out;
}

export const apiCallOperation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: showApiCall,
	options: [
		{
			name: 'Make a Request',
			value: 'request',
			action: 'Make an API call',
			description: 'Call any route of the VantarIS API with the rights of the access key',
			routing: {
				request: {
					url: '={{ "/" + String($parameter.path).trim().replace(/^\\/+/, "").replace(/^api\\/v1\\//, "") }}',
				},
				send: { preSend: [prepareApiCall] },
				output: { postReceive: [handleResponse] },
			},
		},
	],
	default: 'request',
};

export const apiCallFields: INodeProperties[] = [
	{
		displayName: 'Method',
		name: 'method',
		type: 'options',
		options: [
			{ name: 'DELETE', value: 'DELETE' },
			{ name: 'GET', value: 'GET' },
			{ name: 'PATCH', value: 'PATCH' },
			{ name: 'POST', value: 'POST' },
			{ name: 'PUT', value: 'PUT' },
		],
		default: 'GET',
		displayOptions: showApiCall,
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		default: '/permissions',
		required: true,
		placeholder: 'e.g. /incidents/123/links',
		description: 'Route below /api/v1, as listed in the OpenAPI description of the instance',
		displayOptions: showApiCall,
	},
	{
		displayName: 'Query Parameters',
		name: 'queryParameters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Parameter',
		default: {},
		displayOptions: showApiCall,
		options: [
			{
				displayName: 'Parameter',
				name: 'parameter',
				values: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'Value', name: 'value', type: 'string', default: '' },
				],
			},
		],
	},
	{
		displayName: 'Send Body',
		name: 'sendBody',
		type: 'boolean',
		default: false,
		description: 'Whether to send a JSON body',
		displayOptions: { show: { resource: ['apiCall'], method: ['PATCH', 'POST', 'PUT'] } },
	},
	{
		displayName: 'Body',
		name: 'body',
		type: 'json',
		default: '{}',
		required: true,
		description: 'JSON body of the request',
		displayOptions: { show: { resource: ['apiCall'], method: ['PATCH', 'POST', 'PUT'], sendBody: [true] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showApiCall,
		options: [
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description: 'Repeats of the same create request within 24 hours create nothing twice',
			},
			{
				displayName: 'If-Match (ETag)',
				name: 'ifMatch',
				type: 'string',
				default: '',
				description: 'ETag of the version that was read; a newer version answers 412',
			},
		],
	},
];
