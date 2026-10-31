import type { IDataObject } from 'n8n-workflow';
import { isOwnChange } from './transport';

/** True when an event type matches one of the patterns ("*", "task.*", "incident.deadline"). */
export function matchesTypes(type: string, patterns: string[]): boolean {
	if (!patterns.length || patterns.includes('*')) return true;
	return patterns.some((p) => (p.endsWith('.*') ? type.startsWith(p.slice(0, -1)) : p === type));
}

/** Patterns as the API expects them in ?types= (undefined = all). */
export function typesParam(patterns: string[]): string | undefined {
	if (!patterns.length || patterns.includes('*')) return undefined;
	return patterns.join(',');
}

export interface EventFilter {
	types: string[];
	ignoreOwnChanges: boolean;
	apiKey: unknown;
}

/** Applies the type patterns and the echo suppression ("ignore own changes"). */
export function keepEvent(event: IDataObject, filter: EventFilter): boolean {
	if (typeof event.type !== 'string' || !matchesTypes(event.type, filter.types)) return false;
	if (filter.ignoreOwnChanges && isOwnChange(event, filter.apiKey)) return false;
	return true;
}

export interface PollState {
	cursor?: string;
	seen?: string[];
	lastOccurredAt?: string;
}

export interface EventPage {
	status: number;
	body: IDataObject;
}

export type FetchPage = (query: IDataObject) => Promise<EventPage>;

export const SEEN_LIMIT = 1000;
export const MAX_PAGES = 10;
export const PAGE_LIMIT = 200;

function remember(state: PollState, events: IDataObject[]): void {
	const seen = state.seen ?? [];
	const known = new Set(seen);
	for (const e of events) {
		if (typeof e.id === 'string' && !known.has(e.id)) {
			known.add(e.id);
			seen.push(e.id);
		}
		if (typeof e.occurred_at === 'string' && (!state.lastOccurredAt || e.occurred_at > state.lastOccurredAt)) {
			state.lastOccurredAt = e.occurred_at;
		}
	}
	state.seen = seen.slice(-SEEN_LIMIT);
}

function problemCode(page: EventPage): string {
	return typeof page.body.code === 'string' ? page.body.code : '';
}

export class PollError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: IDataObject,
	) {
		super(`events request failed with ${status}`);
	}
}

/**
 * One poll of GET /events. Without a stored cursor the first call only primes the position (no events are
 * emitted for the past). Afterwards it reads every page after the cursor, drops duplicates (by event id),
 * events of other types and, if asked, the key's own changes. An expired cursor restarts at the time of the
 * newest seen event; the seen ids keep that restart free of duplicates.
 */
export async function pollEvents(
	state: PollState,
	fetchPage: FetchPage,
	filter: EventFilter,
	options: { manual?: boolean } = {},
): Promise<{ events: IDataObject[]; state: PollState }> {
	const next: PollState = { cursor: state.cursor, seen: [...(state.seen ?? [])], lastOccurredAt: state.lastOccurredAt };
	const types = typesParam(filter.types);
	const base: IDataObject = { limit: options.manual ? 10 : PAGE_LIMIT };
	if (types) base.types = types;

	if (options.manual) {
		const page = await fetchPage(base);
		if (page.status >= 400) throw new PollError(page.status, page.body);
		const data = Array.isArray(page.body.data) ? (page.body.data as IDataObject[]) : [];
		return { events: data.filter((e) => keepEvent(e, filter)).slice(-10), state };
	}

	const priming = !next.cursor;
	const collected: IDataObject[] = [];
	let query: IDataObject = priming ? { ...base } : { ...base, after: next.cursor };
	let restarted = false;
	for (let i = 0; i < MAX_PAGES; i++) {
		const page = await fetchPage(query);
		if (page.status === 400 && problemCode(page) === 'invalid_cursor' && !restarted) {
			restarted = true;
			query = next.lastOccurredAt ? { ...base, since: next.lastOccurredAt } : { ...base };
			continue;
		}
		if (page.status >= 400) throw new PollError(page.status, page.body);
		const data = Array.isArray(page.body.data) ? (page.body.data as IDataObject[]) : [];
		const seen = new Set(next.seen);
		for (const e of data) {
			if (typeof e.id !== 'string' || seen.has(e.id)) continue;
			seen.add(e.id);
			collected.push(e);
		}
		remember(next, data);
		if (typeof page.body.next_cursor === 'string' && page.body.next_cursor) next.cursor = page.body.next_cursor;
		if (!page.body.has_more) break;
		query = { ...base, after: next.cursor };
	}
	if (priming) return { events: [], state: next };
	return { events: collected.filter((e) => keepEvent(e, filter)), state: next };
}
