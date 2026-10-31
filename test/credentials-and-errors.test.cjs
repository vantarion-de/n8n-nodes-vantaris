// Credential test against any instance address, cursor pagination and readable problem answers.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BASE_URLS, TEST_KEY, runNode, runCredentialTest, withMock, VantarisApi } = require('./harness.cjs');

const PING = { status: 200, body: { ok: true, api_version: '1', key: { label: 'n8n', prefix: 'vtk_0123456789ab', scopes: ['data:read'] }, time: '2026-10-31T12:00:00Z' } };

for (const baseUrl of BASE_URLS) {
	test(`credential test calls GET ${baseUrl}/api/v1/ping with the key`, async () => {
		await withMock(async (mock) => {
			mock.reset(() => PING);
			const { error } = await runCredentialTest(baseUrl);
			assert.equal(error, undefined, error?.message);
			assert.equal(mock.requests.length, 1);
			assert.equal(mock.requests[0].method, 'GET');
			assert.equal(mock.requests[0].url, `${baseUrl}/api/v1/ping`);
			assert.equal(mock.requests[0].headers.authorization, `Bearer ${TEST_KEY}`);
		});
	});
}

test('credential test tolerates a trailing slash and an address that already ends in /api/v1', async () => {
	await withMock(async (mock) => {
		mock.reset(() => PING);
		for (const typed of ['https://grc.kunde.example/', ' https://grc.kunde.example/api/v1 ', 'https://grc.kunde.example/api/v1/']) {
			const { error } = await runCredentialTest(typed);
			assert.equal(error, undefined, error?.message);
		}
		assert.deepEqual(
			mock.requests.map((r) => r.url),
			Array(3).fill('https://grc.kunde.example/api/v1/ping'),
		);
	});
});

test('credential test fails on 401 invalid_key', async () => {
	await withMock(async (mock) => {
		mock.reset(() => ({ status: 401, body: { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'invalid_key' } }));
		const { error } = await runCredentialTest('https://vantaris.app', 'vtk_ffffffffffff_wrong');
		assert.ok(error, 'error expected');
	});
});

test('credential fields: address defaults to https://vantaris.app, key is a password field', () => {
	const cred = new VantarisApi();
	const base = cred.properties.find((p) => p.name === 'baseUrl');
	const key = cred.properties.find((p) => p.name === 'apiKey');
	assert.equal(base.default, 'https://vantaris.app');
	assert.equal(key.typeOptions.password, true);
	assert.equal(cred.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
});

test('Return All follows next_cursor over all pages and keeps the filters', async () => {
	await withMock(async (mock) => {
		const pages = { '': ['c1', [1, 2]], c1: ['c2', [3, 4]], c2: [null, [5]] };
		mock.reset((req) => {
			const [next, ids] = pages[req.query.cursor ?? ''];
			return { status: 200, body: { ok: true, data: ids.map((id) => ({ id })), next_cursor: next } };
		});
		const { items, error } = await runNode({
			baseUrl: 'https://grc.kunde.example',
			parameters: { resource: 'incident', operation: 'getAll', returnAll: true, filters: { q: 'mail', status: 'open' } },
		});
		assert.equal(error, undefined, error?.message);
		assert.deepEqual(items.map((i) => i.json.id), [1, 2, 3, 4, 5]);
		assert.deepEqual(
			mock.requests.map((r) => r.query),
			[
				{ q: 'mail', status: 'open', limit: '500' },
				{ q: 'mail', status: 'open', limit: '500', cursor: 'c1' },
				{ q: 'mail', status: 'open', limit: '500', cursor: 'c2' },
			],
		);
	});
});

test('Limit sends one request with ?limit and no cursor', async () => {
	await withMock(async (mock) => {
		mock.reset(() => ({ status: 200, body: { ok: true, data: [{ id: 1 }], next_cursor: 'more' } }));
		const { items, error } = await runNode({
			baseUrl: 'https://vantaris.app',
			parameters: { resource: 'asset', operation: 'getAll', returnAll: false, limit: 1 },
		});
		assert.equal(error, undefined, error?.message);
		assert.equal(mock.requests.length, 1);
		assert.deepEqual(mock.requests[0].query, { limit: '1' });
		assert.equal(items.length, 1);
	});
});

test('an error on a later page surfaces as a readable error', async () => {
	await withMock(async (mock) => {
		mock.reset((req) =>
			req.query.cursor
				? { status: 400, body: { type: 'about:blank', title: 'Bad Request', status: 400, code: 'invalid_cursor', detail: 'The cursor is broken.' } }
				: { status: 200, body: { ok: true, data: [{ id: 1 }], next_cursor: 'x' } },
		);
		const { error } = await runNode({ baseUrl: 'https://vantaris.app', parameters: { resource: 'task', operation: 'getAll', returnAll: true } });
		assert.match(error.message, /400 Bad Request \(invalid_cursor\)/);
		assert.match(error.description, /The cursor is broken/);
	});
});

const PROBLEMS = [
	{
		answer: { status: 422, body: { type: 'about:blank', title: 'Unprocessable Content', status: 422, code: 'validation_failed', errors: [{ field: 'name', code: 'required' }, { field: 'owner', code: 'invalid_reference' }] } },
		message: /VantarIS answered 422 Unprocessable Content \(validation_failed\)/,
		description: /Field 'name': required\nField 'owner': invalid_reference/,
	},
	{
		answer: { status: 403, body: { type: 'about:blank', title: 'Forbidden', status: 403, code: 'module_unavailable', reason: 'not_booked', detail: 'The module is not available for the tenant.' } },
		message: /403 Forbidden \(module_unavailable\/not_booked\)/,
		description: /The module is not available for the tenant\./,
	},
	{
		answer: { status: 403, body: { type: 'about:blank', title: 'Forbidden', status: 403, code: 'https_required' } },
		message: /\(https_required\)/,
		description: /only over HTTPS/,
	},
	{
		answer: { status: 412, body: { type: 'about:blank', title: 'Precondition Failed', status: 412, code: 'precondition_failed' } },
		message: /412 Precondition Failed \(precondition_failed\)/,
		description: /read it again and retry with the new ETag/,
	},
	{
		answer: { status: 429, headers: { 'retry-after': '30' }, body: { type: 'about:blank', title: 'Too Many Requests', status: 429, code: 'rate_limited' } },
		message: /429 Too Many Requests \(rate_limited\)/,
		description: /batching settings/,
	},
	{
		answer: { status: 502, headers: { 'content-type': 'text/html' }, body: '<html>Bad gateway</html>' },
		message: /VantarIS answered 502 HTTP 502/,
		description: /Bad gateway/,
	},
];

for (const p of PROBLEMS) {
	test(`problem answer ${p.answer.status} ${p.answer.body.code ?? ''} becomes a readable node error`, async () => {
		await withMock(async (mock) => {
			mock.reset(() => p.answer);
			const { error } = await runNode({
				baseUrl: 'https://vantaris.app',
				parameters: { resource: 'task', operation: 'update', taskId: '42', updateFields: { name: 'x' } },
			});
			assert.ok(error, 'error expected');
			assert.match(error.message, p.message);
			assert.match(error.description ?? '', p.description);
			assert.equal(String(error.httpCode), String(p.answer.status));
		});
	});
}
