#!/usr/bin/env node
// Generates the node descriptions of n8n-nodes-vantaris from the integration profile (profile/profile.json in this
// package). Run after updating the profile:  npm run generate
// Writes: nodes/Vantaris/generated/{description,lookups}.ts and nodes/shared/generated/events.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profilePath = process.argv[2] ?? join(root, 'profile', 'profile.json');
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

const OP_VALUE = { create: 'create', get: 'get', list: 'getAll', search: 'search', update: 'update', set_status: 'setStatus', add_comment: 'addComment', upload: 'upload', delete: 'delete' };
const OP_NAME = { create: 'Create', get: 'Get', list: 'Get Many', search: 'Search', update: 'Update', set_status: 'Set Status', add_comment: 'Add Comment', upload: 'Upload', delete: 'Delete' };
const FIELD_NAMES = { text_html: 'Comment', description_html: 'Description', close: 'Close', q: 'Search Text', changed_since: 'Changed Since', parent_id: 'Parent ID', folder_id: 'Folder ID', review_due: 'Review Due' };
const LOOKUP_WORD = { status: 'Status', category: 'Category', owner: 'Owner', tag: 'Tag' };

const camel = (s) => s.replace(/[-_\s]+([a-z0-9])/gi, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
const pascal = (s) => camel(s).replace(/^[a-z]/, (c) => c.toUpperCase());
const titleCase = (s) =>
	s
		.replace(/_html$/, '')
		.split(/[_\s-]+/)
		.map((w) => (w === 'id' ? 'ID' : w === 'url' ? 'URL' : w.charAt(0).toUpperCase() + w.slice(1)))
		.join(' ');
const displayName = (name) => FIELD_NAMES[name] ?? titleCase(name);
// Title Case for names (n8n lint: node-param-display-name-miscased); also after "(" and quotes.
const titleWords = (s) =>
	String(s)
		.split(' ')
		.map((w) =>
			/^(a|an|the|of|on|in|to|or|and|by|for)$/i.test(w)
				? w.toLowerCase()
				: w.replace(/^([("'„]*)(\p{Ll})/u, (_, p, c) => p + c.toUpperCase()),
		)
		.join(' ')
		.replace(/^([("'„]*)(\p{Ll})/u, (_, p, c) => p + c.toUpperCase());
// Sentence case for actions (n8n lint: node-param-operation-option-action-miscased, which uses sentence-case):
// words in capitals stay, punctuation goes, everything else lower case, first letter upper case.
function actionCase(text) {
	const out = String(text)
		.trim()
		.split(/\s+/)
		.map((w) => (w.length > 1 && w === w.toUpperCase() && /\p{Lu}/u.test(w) ? w : w.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase()))
		.filter(Boolean)
		.join(' ');
	return out.charAt(0).toUpperCase() + out.slice(1);
}
const enumName = (v) => {
	const s = String(v);
	return s.startsWith('-') ? `${titleCase(s.slice(1))} (Descending)` : titleCase(s);
};
function sentence(text) {
	if (!text) return undefined;
	const t = String(text).trim().replace(/\s+/g, ' ').replace(/\bids?\b/g, (m) => (m === 'id' ? 'ID' : 'IDs'));
	const s = t.charAt(0).toUpperCase() + t.slice(1);
	// n8n lint (node-param-description-excess-final-period): one sentence (ignoring "e.g.") ends without period
	const single = s.replace('e.g.', '').replace('i.e.', '').split('. ').length === 1;
	return single ? s.replace(/\.+$/, '') : s.endsWith('.') ? s : `${s}.`;
}

const FN = (name) => `__FN__${name}__`;
const usedFns = new Set();
const fn = (name) => {
	usedFns.add(name);
	return FN(name);
};

// ---------- lookups ----------
const lookupMethods = {}; // methodName => sources
function lookupMethod(resource, lookupName) {
	const sources = resource.lookups?.[lookupName];
	if (!sources?.length) return undefined;
	const name = `get${pascal(resource.key)}${pascal(lookupName)}`;
	lookupMethods[name] = sources.map((s) => ({
		path: s.path,
		query: s.query ?? {},
		items: s.items,
		value: s.value,
		label: s.label,
		paginated: !!s.paginated,
		...(lookupName === 'owner' && /\/roles$/.test(s.path) ? { labelPrefix: 'Role: ' } : {}),
	}));
	return name;
}

// ---------- parameters ----------
function baseParam(field, resource) {
	const name = camel(field.name);
	const p = { displayName: displayName(field.name), name, type: 'string', default: '' };
	const desc = sentence(field.description_en);
	const lookup = field.lookup ? lookupMethod(resource, field.lookup) : undefined;
	if (lookup) {
		const multi = field.type === 'array';
		p.displayName = `${LOOKUP_WORD[field.lookup] ?? displayName(field.name)} ${multi ? 'Names or IDs' : 'Name or ID'}`;
		p.type = multi ? 'multiOptions' : 'options';
		p.typeOptions = { loadOptionsMethod: lookup };
		p.default = multi ? [] : '';
		p.description = multi
			? 'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>'
			: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>';
		return p;
	}
	if (field.enum?.length) {
		p.type = 'options';
		p.options = [...field.enum]
			.map((v) => ({ name: enumName(v), value: v }))
			.sort((a, b) => a.name.localeCompare(b.name));
		p.default = field.default ?? field.enum[0];
	} else if (field.type === 'boolean') {
		p.type = 'boolean';
		p.default = false;
	} else if (field.type === 'integer' || field.type === 'number') {
		p.type = 'number';
		p.default = field.default ?? field.minimum ?? 0;
		if (field.minimum !== undefined || field.maximum !== undefined) {
			p.typeOptions = {};
			if (field.minimum !== undefined) p.typeOptions.minValue = field.minimum;
			if (field.maximum !== undefined) p.typeOptions.maxValue = field.maximum;
		}
	} else if (field.type === 'array') {
		p.type = 'string';
		p.typeOptions = { multipleValues: true };
		p.default = [];
	} else if (field.type === 'object') {
		p.type = 'json';
		p.default = '{}';
	} else {
		if (field.html) p.typeOptions = { rows: 4 };
		if (field.format === 'date') p.placeholder = 'e.g. 2026-12-31';
		if (field.format === 'date-time') p.placeholder = 'e.g. 2026-12-31T08:00:00Z';
	}
	if (desc && desc.toLowerCase() !== p.displayName.toLowerCase()) p.description = field.html ? `${desc} (HTML)` : desc;
	if (p.type === 'boolean') p.description = `Whether to ${p.description ? p.description.charAt(0).toLowerCase() + p.description.slice(1) : p.displayName.toLowerCase()}`;
	return p;
}

function sendBody(field, p) {
	const send = { type: 'body', property: field.name };
	if (p.type === 'json') send.value = '={{ typeof $value === "string" ? JSON.parse($value) : $value }}';
	return { send };
}

function show(resourceValue, opValue, extra = {}) {
	return { show: { resource: [resourceValue], operation: [opValue], ...extra } };
}

function sortOptions(list) {
	return list.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function buildAction(resource, action) {
	const rv = camel(resource.key);
	const ov = OP_VALUE[action.key];
	const props = [];
	const pathParams = action.params.filter((p) => p.in === 'path');
	const query = action.params.filter((p) => p.in === 'query' && !p.role);
	const headers = action.params.filter((p) => p.in === 'header');
	const fields = action.body?.content_type === 'application/json' ? (action.body.fields ?? []).filter((f) => !f.read_only) : [];

	let url = action.path;
	for (const pp of pathParams) {
		const isId = resource.id && pp.name === resource.id.name;
		const name = isId ? `${camel(resource.key)}Id` : camel(pp.name);
		props.push({
			displayName: isId ? `${resource.label_en} ID` : displayName(pp.name),
			name,
			type: 'string',
			required: true,
			default: '',
			placeholder: pp.type === 'integer' ? 'e.g. 123' : 'e.g. 0f8fad5b-d9cb-469f-a165-70867728950e',
			description: isId ? `ID of the ${resource.label_en.toLowerCase()}` : sentence(pp.description_en),
			displayOptions: show(rv, ov),
		});
		url = url.replace(`{${pp.name}}`, `{{encodeURIComponent($parameter.${name})}}`);
	}

	const routing = { request: { method: action.method, url: `=${url}` }, output: { postReceive: [fn('handleResponse')] } };
	if (action.response.items_field) routing.output.postReceive.push({ type: 'rootProperty', properties: { property: action.response.items_field } });

	if (action.key === 'list' || action.key === 'search') {
		if (action.paginated) {
			props.push({
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: 'Whether to return all results or only up to a given limit',
				displayOptions: show(rv, ov),
				routing: { send: { paginate: '={{ $value }}' } },
			});
			const limit = action.params.find((p) => p.role === 'limit');
			props.push({
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1, maxValue: limit?.maximum ?? 500 },
				description: 'Max number of results to return',
				displayOptions: show(rv, ov, { returnAll: [false] }),
				routing: { send: { type: 'query', property: 'limit' } },
			});
			routing.operations = { pagination: fn('cursorPagination') };
		}
	}

	// body fields: required ones top level, the rest in a collection
	const isUpdate = action.key === 'update';
	const optional = [];
	for (const f of fields) {
		const p = baseParam(f, resource);
		const top = f.required && !isUpdate;
		if (top) {
			props.push({ ...p, required: true, displayOptions: show(rv, ov), routing: sendBody(f, p) });
		} else optional.push({ ...p, routing: sendBody(f, p) });
	}
	if (optional.length) {
		props.push({
			displayName: isUpdate ? 'Update Fields' : 'Additional Fields',
			name: isUpdate ? 'updateFields' : 'additionalFields',
			type: 'collection',
			placeholder: 'Add Field',
			default: {},
			displayOptions: show(rv, ov),
			options: sortOptions(optional),
		});
	}

	// binary upload
	if (action.body && (action.body.binary || action.body.content_type !== 'application/json')) {
		props.push({
			displayName: 'Input Binary Field',
			name: 'binaryPropertyName',
			type: 'string',
			default: 'data',
			required: true,
			hint: 'The name of the input binary field containing the file to be uploaded',
			displayOptions: show(rv, ov),
		});
		routing.send = { ...(routing.send ?? {}), preSend: [fn('sendBinaryBody')] };
	}

	// query parameters
	const filters = [];
	const options = [];
	for (const q of query) {
		const p = baseParam(q, resource);
		p.routing = { send: { type: 'query', property: q.name, ...(p.type === 'multiOptions' || p.typeOptions?.multipleValues ? { value: '={{ [].concat($value).join(",") }}' } : {}) } };
		if (q.required) props.push({ ...p, required: true, displayOptions: show(rv, ov) });
		else if (q.name === 'sort' || q.name === 'include' || action.key === 'upload' || action.key === 'get') options.push(p);
		else filters.push(p);
	}
	for (const h of headers) {
		const p = baseParam(h, resource);
		p.name = h.role === 'if_match' ? 'ifMatch' : h.role === 'idempotency_key' ? 'idempotencyKey' : camel(h.name);
		p.displayName = h.role === 'if_match' ? 'If-Match (ETag)' : h.role === 'idempotency_key' ? 'Idempotency Key' : h.name;
		p.routing = { request: { headers: { [h.name]: '={{ $value }}' } } };
		options.push(p);
	}
	if (filters.length) {
		props.push({ displayName: 'Filters', name: 'filters', type: 'collection', placeholder: 'Add Filter', default: {}, displayOptions: show(rv, ov), options: sortOptions(filters) });
	}
	if (options.length) {
		props.push({ displayName: 'Options', name: 'options', type: 'collection', placeholder: 'Add Option', default: {}, displayOptions: show(rv, ov), options: sortOptions(options) });
	}

	const option = {
		name: OP_NAME[action.key],
		value: ov,
		action: actionCase(action.label_en),
		description: sentence(action.label_en),
		routing,
	};
	return { option, props };
}

const resourceOptions = [];
const operationProps = [];
const fieldProps = [];
// Event feed and webhook subscriptions are the triggers' business; "API Call" still reaches them.
for (const resource of profile.resources.filter((r) => !r.infrastructure)) {
	const rv = camel(resource.key);
	resourceOptions.push({ name: resource.label_en, value: rv });
	const opts = [];
	for (const action of resource.actions) {
		const { option, props } = buildAction(resource, action);
		opts.push(option);
		fieldProps.push(...props);
	}
	opts.sort((a, b) => a.name.localeCompare(b.name));
	operationProps.push({
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [rv] } },
		options: opts,
		default: opts.find((o) => o.value === 'get')?.value ?? opts[0].value,
	});
}
resourceOptions.push({ name: 'API Call', value: 'apiCall' });
resourceOptions.sort((a, b) => a.name.localeCompare(b.name));
const resourceProperty = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: resourceOptions,
	default: camel(profile.resources.find((r) => !r.infrastructure)?.key ?? 'apiCall'),
};

// ---------- emit ----------
const header = (what) => `// GENERATED by scripts/generate.mjs from profile/profile.json (${what}). Do not edit by hand.\n`;
function literal(value) {
	return JSON.stringify(value, null, '\t').replace(/"__FN__(\w+)__"/g, '$1');
}
const out = (rel, text) => {
	const file = join(root, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	console.log(`geschrieben: ${rel}`);
};

const imports = [];
if (usedFns.has('handleResponse')) imports.push("import { handleResponse } from '../../shared/transport';");
if (usedFns.has('cursorPagination')) imports.push("import { cursorPagination } from '../../shared/pagination';");
if (usedFns.has('sendBinaryBody')) imports.push("import { sendBinaryBody } from '../../shared/binary';");
out(
	'nodes/Vantaris/generated/description.ts',
	`${header('node properties')}import type { INodeProperties } from 'n8n-workflow';
${imports.join('\n')}

export const resourceProperty: INodeProperties = ${literal(resourceProperty)};

export const operationProperties: INodeProperties[] = ${literal(operationProps)};

export const fieldProperties: INodeProperties[] = ${literal(fieldProps)};
`,
);

const methodNames = Object.keys(lookupMethods).sort();
out(
	'nodes/Vantaris/generated/lookups.ts',
	`${header('dropdown sources')}import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import type { LookupSource } from '../../shared/lookups';
import { loadLookup } from '../../shared/lookups';

export const LOOKUPS: Record<string, LookupSource[]> = ${literal(Object.fromEntries(methodNames.map((n) => [n, lookupMethods[n]])))};

export const loadOptions = {
${methodNames
	.map(
		(n) => `\tasync ${n}(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
\t\treturn await loadLookup.call(this, LOOKUPS.${n});
\t},`,
	)
	.join('\n')}
};
`,
);

const events = profile.events ?? {};
const eventOptions = [
	...(events.patterns ?? []).map((p) => ({ name: titleWords(p.label_en), value: p.pattern })),
	...(events.catalog ?? []).map((e) => ({ name: titleWords(e.label_en), value: e.type, ...(e.description_en ? { description: sentence(e.description_en) } : {}) })),
];
const hooks = profile.webhooks ?? {};
const ep = {
	feedPath: events.feed?.path ?? '/events',
	subscribePath: hooks.subscribe?.path ?? '/webhooks',
	itemPath: (hooks.unsubscribe?.path ?? '/webhooks/{id}').replace(/\{[^}]+\}/, ':id'),
	toleranceSeconds: hooks.signature?.tolerance_seconds ?? 300,
};
out(
	'nodes/shared/generated/events.ts',
	`${header('event catalog and routes')}import type { INodePropertyOptions } from 'n8n-workflow';

export const EVENT_OPTIONS: INodePropertyOptions[] = ${literal(eventOptions)};

export const EVENT_ROUTES = ${literal(ep)} as const;
`,
);
