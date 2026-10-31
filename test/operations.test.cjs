// Every operation generated from the profile builds the right request (method, path, query, body, headers) for
// every kind of instance address, executed by n8n-core's real declarative engine.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BASE_URLS, TEST_KEY, runNode, withMock, profile, generated } = require('./harness.cjs');

const OP_VALUE = { create: 'create', get: 'get', list: 'getAll', search: 'search', update: 'update', set_status: 'setStatus', add_comment: 'addComment', upload: 'upload', delete: 'delete' };
const camel = (s) => s.replace(/[-_\s]+([a-z0-9])/gi, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());

function sample(field) {
	if (field.lookup === 'status') return ['open', 'open'];
	if (field.lookup === 'category') return [3, 3];
	if (field.lookup === 'owner') return ['emp_5', 'emp_5'];
	if (field.lookup === 'tag') return field.type === 'array' ? [['alpha', 'beta'], ['alpha', 'beta']] : ['alpha', 'alpha'];
	if (field.enum?.length) return [field.enum[field.enum.length - 1], field.enum[field.enum.length - 1]];
	if (field.type === 'boolean') return [true, true];
	if (field.type === 'integer' || field.type === 'number') return [field.minimum ?? 1, field.minimum ?? 1];
	if (field.type === 'array') return [['x', 'y'], ['x', 'y']];
	if (field.type === 'object') return ['{"assets": [1, 2]}', { assets: [1, 2] }];
	if (field.format === 'date') return ['2026-12-31', '2026-12-31'];
	if (field.html) return ['<p>Hallo Welt</p>', '<p>Hallo Welt</p>'];
	return ['Firewall-Regeln prüfen', 'Firewall-Regeln prüfen'];
}

/** Parameters for one action plus the request it must produce, derived from the profile (not from the node). */
function plan(resource, action) {
	const params = { resource: camel(resource.key), operation: OP_VALUE[action.key] };
	let path = action.path;
	const expect = { method: action.method, query: {}, body: undefined, headers: {} };
	for (const p of action.params.filter((x) => x.in === 'path')) {
		const value = p.type === 'integer' ? '42' : '0f8fad5b-d9cb-469f-a165-70867728950e';
		params[resource.id && p.name === resource.id.name ? `${camel(resource.key)}Id` : camel(p.name)] = value;
		path = path.replace(`{${p.name}}`, value);
	}
	expect.path = `/api/v1${path}`;
	const json = action.body?.content_type === 'application/json';
	const fields = json ? action.body.fields.filter((f) => !f.read_only) : [];
	const isUpdate = action.key === 'update';
	const collection = isUpdate ? 'updateFields' : 'additionalFields';
	if (json) expect.body = {};
	for (const f of fields.filter((x) => x.required && !isUpdate)) {
		const [given, sent] = sample(f);
		params[camel(f.name)] = given;
		expect.body[f.name] = sent;
	}
	// one optional field per type kind, so string, lookup, list and JSON routing are all exercised
	const optional = fields.filter((x) => !(x.required && !isUpdate));
	const picked = new Map();
	for (const f of optional) {
		const kind = f.lookup ? `lookup:${f.lookup}` : f.type;
		if (!picked.has(kind)) picked.set(kind, f);
	}
	if (picked.size) params[collection] = {};
	for (const f of picked.values()) {
		const [given, sent] = sample(f);
		params[collection][camel(f.name)] = given;
		expect.body[f.name] = sent;
	}
	if (action.key === 'list' || action.key === 'search') {
		params.returnAll = false;
		params.limit = 7;
		expect.query.limit = '7';
		const filter = action.params.find((p) => p.in === 'query' && !p.role && p.name === 'q');
		if (filter) {
			params.filters = { q: 'fire' };
			expect.query.q = 'fire';
		}
		const status = action.params.find((p) => p.in === 'query' && p.name === 'status');
		if (status) {
			params.filters = { ...(params.filters ?? {}), status: 'open' };
			expect.query.status = 'open';
		}
	}
	const options = {};
	for (const h of action.params.filter((p) => p.in === 'header')) {
		if (h.role === 'idempotency_key') {
			options.idempotencyKey = 'n8n-test-0001';
			expect.headers['idempotency-key'] = 'n8n-test-0001';
		}
		if (h.role === 'if_match') {
			options.ifMatch = 'W/"etag-1"';
			expect.headers['if-match'] = 'W/"etag-1"';
		}
	}
	let input;
	if (action.body && !json) {
		params.binaryPropertyName = 'data';
		const folder = action.params.find((p) => p.in === 'query' && p.name === 'folder_id');
		if (folder) {
			options.folderId = 'root';
			expect.query.folder_id = 'root';
		}
		expect.query.name = 'bericht.pdf';
		expect.raw = 'PDF-Inhalt';
		expect.contentType = 'application/octet-stream';
		input = [{ json: {}, binary: { data: { data: Buffer.from('PDF-Inhalt').toString('base64'), mimeType: 'application/pdf', fileName: 'bericht.pdf' } } }];
	}
	if (Object.keys(options).length) params.options = options;
	return { params, expect, input };
}

function answer(action) {
	if (action.response.kind === 'list') return { status: 200, body: { ok: true, data: [{ id: 1 }, { id: 2 }], next_cursor: null } };
	if (action.response.kind === 'empty') return { status: 204 };
	return { status: action.response.status, body: { ok: true, data: { id: 42, name: 'Antwort' } } };
}

const actions = profile.resources.filter((r) => !r.infrastructure).flatMap((r) => r.actions.map((a) => [r, a]));

test('event feed and webhook subscriptions are not offered as actions (the triggers use them)', () => {
	for (const r of profile.resources.filter((x) => x.infrastructure)) {
		assert.ok(!generated.resourceProperty.options.some((o) => o.value === camel(r.key)), r.key);
	}
});

test('every profile action has a generated operation', () => {
	for (const [resource, action] of actions) {
		const ops = generated.operationProperties.find((p) => p.displayOptions?.show?.resource?.includes(camel(resource.key)));
		assert.ok(ops, `operations for ${resource.key}`);
		assert.ok(ops.options.some((o) => o.value === OP_VALUE[action.key]), `${resource.key}.${action.key}`);
	}
	assert.ok(actions.length >= 27, `contract minimum covered (${actions.length} actions)`);
});

for (const baseUrl of BASE_URLS) {
	test(`all ${actions.length} operations build the right request against ${baseUrl}`, async () => {
		await withMock(async (mock) => {
			for (const [resource, action] of actions) {
				const label = `${resource.key}.${action.key} @ ${baseUrl}`;
				const { params, expect, input } = plan(resource, action);
				mock.reset(() => answer(action));
				const { items, error } = await runNode({ parameters: params, baseUrl, input });
				assert.equal(error, undefined, `${label}: ${error?.message} ${error?.description ?? ''}`);
				assert.equal(mock.requests.length, 1, `${label}: one request`);
				const req = mock.requests[0];
				assert.equal(req.origin, new URL(baseUrl).origin, `${label}: origin`);
				assert.equal(req.method, expect.method, `${label}: method`);
				assert.equal(req.path, expect.path, `${label}: path`);
				assert.deepEqual(req.query, expect.query, `${label}: query`);
				assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`, `${label}: auth`);
				assert.equal(req.headers.accept, 'application/json', `${label}: accept`);
				for (const [h, v] of Object.entries(expect.headers)) assert.equal(req.headers[h], v, `${label}: header ${h}`);
				if (expect.raw !== undefined) {
					assert.equal(req.raw.toString('utf8'), expect.raw, `${label}: binary body`);
					assert.equal(req.headers['content-type'], expect.contentType, `${label}: content type`);
				} else if (expect.body !== undefined) {
					assert.deepEqual(req.body, expect.body, `${label}: body`);
				} else {
					assert.equal(req.raw.length, 0, `${label}: no body`);
				}
				if (action.response.kind === 'list') assert.deepEqual(items.map((i) => i.json), [{ id: 1 }, { id: 2 }], `${label}: items`);
				else assert.deepEqual(items.map((i) => i.json), [{ id: 42, name: 'Antwort' }], `${label}: data`);
			}
		});
	});
}

test('API call: method, path, query, JSON body and headers as entered', async () => {
	await withMock(async (mock) => {
		mock.reset(() => ({ status: 201, body: { ok: true, data: { created: true } } }));
		const { items, error } = await runNode({
			baseUrl: 'https://grc.kunde.example/',
			parameters: {
				resource: 'apiCall',
				operation: 'request',
				method: 'POST',
				path: 'api/v1/incidents/42/links',
				queryParameters: { parameter: [{ name: 'include', value: 'links' }] },
				sendBody: true,
				body: '{"assets": [7]}',
				options: { idempotencyKey: 'abc-12345', ifMatch: '"v1"' },
			},
		});
		assert.equal(error, undefined, error?.message);
		const req = mock.requests[0];
		assert.equal(req.method, 'POST');
		assert.equal(req.url, 'https://grc.kunde.example/api/v1/incidents/42/links?include=links');
		assert.deepEqual(req.body, { assets: [7] });
		assert.equal(req.headers['idempotency-key'], 'abc-12345');
		assert.equal(req.headers['if-match'], '"v1"');
		assert.deepEqual(items[0].json, { ok: true, data: { created: true } });
	});
});

test('API call: GET sends no body even with "Send Body" left over', async () => {
	await withMock(async (mock) => {
		mock.reset(() => ({ status: 200, body: { ok: true, data: {} } }));
		const { error } = await runNode({
			baseUrl: 'https://vantaris.app',
			parameters: { resource: 'apiCall', operation: 'request', method: 'GET', path: '/permissions', sendBody: true, body: '{"x":1}' },
		});
		assert.equal(error, undefined, error?.message);
		assert.equal(mock.requests[0].url, 'https://vantaris.app/api/v1/permissions');
		assert.equal(mock.requests[0].raw.length, 0);
	});
});
