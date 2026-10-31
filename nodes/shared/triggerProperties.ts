import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { EVENT_OPTIONS } from './generated/events';
import type { ApiContext } from './transport';
import { vantarisRequest } from './transport';

export const triggerProperties: INodeProperties[] = [
	{
		displayName: 'Events',
		name: 'events',
		type: 'multiOptions',
		options: EVENT_OPTIONS,
		default: ['*'],
		required: true,
		description: 'Event types or groups that start the workflow',
	},
	{
		displayName: 'Ignore Own Changes',
		name: 'ignoreOwnChanges',
		type: 'boolean',
		default: true,
		description:
			'Whether to skip events caused by the access key of these credentials, so that a workflow does not react to its own writes',
	},
	{
		displayName: 'Include Object',
		name: 'includeObject',
		type: 'boolean',
		default: false,
		description:
			'Whether to load the current object of each event (with the rights of the access key) and add it as "object_data"',
	},
];

/** Adds the current object behind event.object.href, unless the object was deleted. */
export async function attachObject(this: ApiContext, event: IDataObject): Promise<IDataObject> {
	const object = (event.object ?? {}) as IDataObject;
	const href = typeof object.href === 'string' ? object.href : '';
	if (!href || String(event.type ?? '').endsWith('.deleted')) return event;
	const path = href.replace(/^.*\/api\/v1(?=\/)/, '');
	const { status, body } = await vantarisRequest.call(this, 'GET', path, { returnProblems: true });
	return { ...event, object_data: status < 400 ? (body.data ?? body) : null };
}
