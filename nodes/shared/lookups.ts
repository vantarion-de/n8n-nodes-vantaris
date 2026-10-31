import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { pick, vantarisRequest } from './transport';

/** One route that feeds a dropdown, as described by the integration profile. */
export interface LookupSource {
	path: string;
	query: IDataObject;
	items: string;
	value: string;
	label: string;
	paginated: boolean;
	labelPrefix?: string;
}

const MAX_PAGES = 20;

/** Loads the options of one lookup from all its sources (e.g. employees and roles for "owner"). */
export async function loadLookup(this: ILoadOptionsFunctions, sources: LookupSource[]): Promise<INodePropertyOptions[]> {
	const out: INodePropertyOptions[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const qs: IDataObject = { ...source.query };
			if (source.paginated) qs.limit = 500;
			if (cursor) qs.cursor = cursor;
			const { body } = await vantarisRequest.call(this, 'GET', source.path, { qs });
			const items = pick(body, source.items);
			for (const item of Array.isArray(items) ? items : []) {
				const value = pick(item, source.value);
				const label = pick(item, source.label);
				if (value === undefined || value === null || value === '') continue;
				const key = String(value);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({
					name: `${source.labelPrefix ?? ''}${String(label ?? value)}`,
					value: typeof value === 'number' ? value : key,
				});
			}
			cursor = source.paginated && typeof body.next_cursor === 'string' ? body.next_cursor : undefined;
			if (!cursor) break;
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
