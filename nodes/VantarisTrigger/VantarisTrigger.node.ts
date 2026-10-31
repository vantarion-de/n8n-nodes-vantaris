import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { keepEvent } from '../shared/events';
import { EVENT_ROUTES } from '../shared/generated/events';
import { verify } from '../shared/signature';
import { attachObject, triggerProperties } from '../shared/triggerProperties';
import { CREDENTIAL_NAME, problemError, vantarisRequest } from '../shared/transport';

interface HookState extends IDataObject {
	webhookId?: number;
	webhookSecret?: string;
	webhookUrl?: string;
}

const itemPath = (id: number) => EVENT_ROUTES.itemPath.replace(':id', encodeURIComponent(String(id)));

function sameEvents(a: unknown, b: string[]): boolean {
	const x = Array.isArray(a) ? [...a].map(String).sort() : [];
	const y = [...b].sort();
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

export class VantarisTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'VantarIS Trigger',
		name: 'vantarisTrigger',
		icon: { light: 'file:vantaris.svg', dark: 'file:vantaris.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{ "Webhook: " + [].concat($parameter["events"]).join(", ") }}',
		description: 'Starts the workflow instantly when something happens in VantarIS (signed webhook)',
		defaults: {
			name: 'VantarIS Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'vantarisApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				// empty: answer with the webhookResponse returned by webhook() instead of n8n's default
				responseData: '',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'VantarIS subscribes this workflow when it is activated and removes the subscription when it is deactivated. The production URL must be reachable over HTTPS from the VantarIS instance.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			...triggerProperties,
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as HookState;
				const url = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events', []) as string[];
				if (!state.webhookId || !state.webhookSecret) return false;
				const { status, body } = await vantarisRequest.call(this, 'GET', itemPath(state.webhookId), {
					returnProblems: true,
				});
				if (status === 404) {
					delete state.webhookId;
					delete state.webhookSecret;
					delete state.webhookUrl;
					return false;
				}
				if (status >= 400) throw problemError(this.getNode(), status, body);
				const hook = (body.data ?? {}) as IDataObject;
				if (hook.target_url === url && hook.status === 'active' && sameEvents(hook.events, events)) return true;
				await vantarisRequest.call(this, 'DELETE', itemPath(state.webhookId), { returnProblems: true });
				delete state.webhookId;
				delete state.webhookSecret;
				delete state.webhookUrl;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as HookState;
				const url = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events', []) as string[];
				const workflow = this.getWorkflow();
				const { body } = await vantarisRequest.call(this, 'POST', EVENT_ROUTES.subscribePath, {
					body: {
						target_url: url,
						events: events.length ? events : ['*'],
						description: `n8n: ${workflow.name ?? workflow.id ?? 'workflow'}`.slice(0, 255),
					},
				});
				const hook = (body.data ?? body) as IDataObject;
				state.webhookId = Number(hook.id);
				state.webhookSecret = String(hook.secret ?? '');
				state.webhookUrl = url;
				return !!state.webhookId && !!state.webhookSecret;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as HookState;
				if (state.webhookId) {
					const { status, body } = await vantarisRequest.call(this, 'DELETE', itemPath(state.webhookId), {
						returnProblems: true,
					});
					if (status >= 400 && status !== 404) throw problemError(this.getNode(), status, body);
				}
				delete state.webhookId;
				delete state.webhookSecret;
				delete state.webhookUrl;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const state = this.getWorkflowStaticData('node') as HookState;
		const req = this.getRequestObject() as unknown as {
			headers: Record<string, unknown>;
			rawBody?: Buffer;
			readRawBody?: () => Promise<void>;
			body?: unknown;
		};
		if (!req.rawBody && req.readRawBody) await req.readRawBody();
		const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');
		const check = state.webhookSecret
			? verify(state.webhookSecret, req.headers, raw, Math.floor(Date.now() / 1000), EVENT_ROUTES.toleranceSeconds)
			: { ok: false as const, reason: 'no subscription secret stored; reactivate the workflow' };
		if (!check.ok) {
			const res = this.getResponseObject();
			res.status(401).json({ error: 'invalid signature', reason: check.reason });
			return { noWebhookResponse: true };
		}
		const event = this.getBodyData() as IDataObject;
		const credentials = await this.getCredentials(CREDENTIAL_NAME);
		const keep = keepEvent(event, {
			types: this.getNodeParameter('events', []) as string[],
			ignoreOwnChanges: this.getNodeParameter('ignoreOwnChanges', true) as boolean,
			apiKey: credentials.apiKey,
		});
		if (!keep) return { webhookResponse: { received: true, ignored: true } };
		const out = (this.getNodeParameter('includeObject', false) as boolean)
			? await attachObject.call(this, event)
			: event;
		return { workflowData: [this.helpers.returnJsonArray([out])], webhookResponse: { received: true } };
	}
}
