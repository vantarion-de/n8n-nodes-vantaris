import type {
	DeclarativeRestApiSettings,
	IDataObject,
	IExecutePaginationFunctions,
	IHttpRequestOptions,
	IN8nHttpFullResponse,
	INodeExecutionData,
} from 'n8n-workflow';
import { CREDENTIAL_NAME, problemError } from './transport';

const PAGE_SIZE = 500;
const MAX_PAGES = 1000;

/** Declarative pagination for "Return All": follows next_cursor until the last page (limit/cursor of the API). */
export async function cursorPagination(
	this: IExecutePaginationFunctions,
	requestData: DeclarativeRestApiSettings.ResultOptions,
): Promise<INodeExecutionData[]> {
	const out: INodeExecutionData[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const qs: IDataObject = { ...(requestData.options.qs ?? {}), limit: PAGE_SIZE };
		if (cursor) qs.cursor = cursor;
		else delete qs.cursor;
		const response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_NAME, {
			...requestData.options,
			url: requestData.options.url ?? '',
			qs,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		} as IHttpRequestOptions)) as IN8nHttpFullResponse;
		if (response.statusCode >= 400) throw problemError(this.getNode(), response.statusCode, response.body);
		const body = (typeof response.body === 'string' ? JSON.parse(response.body) : response.body) as IDataObject;
		const data = Array.isArray(body?.data) ? (body.data as IDataObject[]) : [];
		for (const json of data) out.push({ json });
		cursor = typeof body?.next_cursor === 'string' && body.next_cursor ? body.next_cursor : undefined;
		if (!cursor) break;
	}
	return out;
}
