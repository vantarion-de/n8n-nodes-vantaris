import type {
	IDataObject,
	IExecuteSingleFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INode,
	INodeExecutionData,
	IPollFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const CREDENTIAL_NAME = 'vantarisApi';

export type ApiContext = IHookFunctions | ILoadOptionsFunctions | IPollFunctions | IWebhookFunctions | IExecuteSingleFunctions;

/** Base address of the API for any instance address (vantaris.app, whitelabel, on-premise). */
export function apiBaseUrl(baseUrl: unknown): string {
	const root = String(baseUrl ?? '')
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/api\/v1$/i, '');
	return `${root}/api/v1`;
}

/** Public key id of an access key vtk_<12 hex>_<secret>; the secret part never leaves this function. */
export function keyId(apiKey: unknown): string | undefined {
	const m = /^vtk_([0-9a-f]{12})_/i.exec(String(apiKey ?? ''));
	return m ? `vtk_${m[1].toLowerCase()}` : undefined;
}

/** True when an event was caused by the key of these credentials (actor.key is "vtk_" + the first 4 chars of the id). */
export function isOwnChange(event: IDataObject, apiKey: unknown): boolean {
	const id = keyId(apiKey);
	const actor = (event.actor ?? {}) as IDataObject;
	const key = typeof actor.key === 'string' ? actor.key.toLowerCase() : '';
	if (!id || !key.startsWith('vtk_') || key.length < 8) return false;
	return id.startsWith(key);
}

function parseBody(body: unknown): unknown {
	if (Buffer.isBuffer(body)) body = body.toString('utf8');
	if (typeof body === 'string' && body.trim() !== '') {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	return body;
}

/** Readable message for an RFC 9457 problem answer of the VantarIS API. */
export function describeProblem(status: number, rawBody: unknown): { message: string; description: string } {
	const body = parseBody(rawBody);
	const p = (body && typeof body === 'object' ? body : {}) as IDataObject;
	const code = typeof p.code === 'string' ? p.code : '';
	const reason = typeof p.reason === 'string' ? p.reason : '';
	const title = typeof p.title === 'string' ? p.title : `HTTP ${status}`;
	const parts = [code, reason].filter(Boolean).join('/');
	const message = `VantarIS answered ${status} ${title}${parts ? ` (${parts})` : ''}`;
	const lines: string[] = [];
	if (typeof p.detail === 'string' && p.detail) lines.push(p.detail);
	if (typeof p.parameter === 'string' && p.parameter) lines.push(`Parameter: ${p.parameter}`);
	if (Array.isArray(p.errors)) {
		for (const e of p.errors as IDataObject[]) lines.push(`Field '${String(e.field)}': ${String(e.code)}`);
	}
	if (status === 401) lines.push('Check the access key in the VantarIS credentials.');
	if (status === 403 && code === 'https_required') lines.push('The instance accepts the key only over HTTPS.');
	if (status === 412) lines.push('The object changed since it was read; read it again and retry with the new ETag.');
	if (status === 429) lines.push('Too many requests; wait and retry, or space the requests out using the batching settings.');
	if (!lines.length && typeof body === 'string') lines.push(body.slice(0, 500));
	return { message, description: lines.join('\n') };
}

export function problemError(node: INode, status: number, body: unknown): NodeApiError {
	const { message, description } = describeProblem(status, body);
	const parsed = parseBody(body);
	const payload = (parsed && typeof parsed === 'object' ? parsed : { body: String(parsed ?? '') }) as JsonObject;
	return new NodeApiError(node, payload, { message, description, httpCode: String(status) });
}

/** Declarative postReceive: turns a problem answer into a readable error, unwraps "data" where present. */
export async function handleResponse(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	if (response.statusCode >= 400) throw problemError(this.getNode(), response.statusCode, response.body);
	const body = parseBody(response.body);
	if (response.statusCode === 204 || body === undefined || body === null || body === '') {
		return [{ json: { success: true } }];
	}
	return items.map((item) => ({ ...item, json: (typeof body === 'object' ? body : { body }) as IDataObject }));
}

export interface RequestOptions {
	qs?: IDataObject;
	body?: IDataObject | Buffer;
	headers?: IDataObject;
	/** Return problem answers (status >= 400) instead of throwing. */
	returnProblems?: boolean;
}

/** Authenticated request to the API for triggers and lookups; throws a readable NodeApiError on problems. */
export async function vantarisRequest(
	this: ApiContext,
	method: IHttpRequestMethods,
	path: string,
	options: RequestOptions = {},
): Promise<{ status: number; body: IDataObject; headers: IDataObject }> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const request: IHttpRequestOptions = {
		method,
		url: `${apiBaseUrl(credentials.baseUrl)}${path}`,
		qs: options.qs,
		headers: { Accept: 'application/json', ...(options.headers ?? {}) },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (options.body !== undefined) request.body = options.body;
	const response = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		CREDENTIAL_NAME,
		request,
	)) as IN8nHttpFullResponse;
	if (response.statusCode >= 400 && !options.returnProblems) {
		throw problemError(this.getNode(), response.statusCode, response.body);
	}
	const body = parseBody(response.body);
	return {
		status: response.statusCode,
		body: (body && typeof body === 'object' ? body : {}) as IDataObject,
		headers: (response.headers ?? {}) as IDataObject,
	};
}

/** Reads a value at a dot path ("data.statuses", "data.0.terms"); '' returns the input. */
export function pick(source: unknown, path: string): unknown {
	if (!path) return source;
	let node: unknown = source;
	for (const part of path.split('.')) {
		if (node === null || node === undefined) return undefined;
		node = (node as IDataObject)[part];
	}
	return node;
}
