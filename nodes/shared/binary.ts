import type { IDataObject, IExecuteSingleFunctions, IHttpRequestOptions } from 'n8n-workflow';

/** Declarative preSend: sends the input binary field as application/octet-stream; its file name becomes ?name=. */
export async function sendBinaryBody(this: IExecuteSingleFunctions, request: IHttpRequestOptions): Promise<IHttpRequestOptions> {
	const field = this.getNodeParameter('binaryPropertyName', 'data') as string;
	const meta = this.helpers.assertBinaryData(field);
	const buffer = await this.helpers.getBinaryDataBuffer(field);
	const qs: IDataObject = { ...(request.qs ?? {}) };
	if (!qs.name && meta.fileName) qs.name = meta.fileName;
	return {
		...request,
		qs,
		body: buffer,
		json: false,
		headers: { ...(request.headers ?? {}), 'Content-Type': 'application/octet-stream' },
	};
}
