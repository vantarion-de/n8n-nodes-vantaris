import type { IDataObject, INodeExecutionData, INodeType, INodeTypeDescription, IPollFunctions } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type { PollState } from '../shared/events';
import { pollEvents, PollError } from '../shared/events';
import { EVENT_ROUTES } from '../shared/generated/events';
import { attachObject, triggerProperties } from '../shared/triggerProperties';
import { CREDENTIAL_NAME, problemError, vantarisRequest } from '../shared/transport';

export class VantarisPollingTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'VantarIS Polling Trigger',
		name: 'vantarisPollingTrigger',
		icon: { light: 'file:vantaris.svg', dark: 'file:vantaris.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{ "Polling: " + [].concat($parameter["events"]).join(", ") }}',
		description:
			'Starts the workflow when something happens in VantarIS, by reading the event feed at an interval (no inbound connection needed)',
		defaults: {
			name: 'VantarIS Polling Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'vantarisApi',
				required: true,
			},
		],
		properties: [
			{
				displayName:
					'Reads new events since the last poll. Events of the past are not replayed when the workflow is activated. Use the VantarIS Trigger for instant delivery.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			...triggerProperties,
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const stored = this.getWorkflowStaticData('node') as PollState & IDataObject;
		const credentials = await this.getCredentials(CREDENTIAL_NAME);
		const manual = this.getMode() === 'manual';
		const fetchPage = async (qs: IDataObject) =>
			await vantarisRequest.call(this, 'GET', EVENT_ROUTES.feedPath, { qs, returnProblems: true });
		let result;
		try {
			result = await pollEvents(
				{ cursor: stored.cursor, seen: stored.seen, lastOccurredAt: stored.lastOccurredAt },
				fetchPage,
				{
					types: this.getNodeParameter('events', []) as string[],
					ignoreOwnChanges: this.getNodeParameter('ignoreOwnChanges', true) as boolean,
					apiKey: credentials.apiKey,
				},
				{ manual },
			);
		} catch (error) {
			if (error instanceof PollError) throw problemError(this.getNode(), error.status, error.body);
			throw new NodeOperationError(this.getNode(), error as Error);
		}
		if (!manual) {
			stored.cursor = result.state.cursor;
			stored.seen = result.state.seen;
			stored.lastOccurredAt = result.state.lastOccurredAt;
		}
		if (!result.events.length) return null;
		const includeObject = this.getNodeParameter('includeObject', false) as boolean;
		const out: IDataObject[] = [];
		for (const event of result.events) out.push(includeObject ? await attachObject.call(this, event) : event);
		return [this.helpers.returnJsonArray(out)];
	}
}
