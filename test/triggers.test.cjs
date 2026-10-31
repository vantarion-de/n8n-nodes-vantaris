// Webhook trigger (subscribe, unsubscribe, signature, echo suppression), polling trigger (cursor, duplicates,
// restart, echo suppression) and the dropdown lookups.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { TEST_KEY, withMock, fakeContext, VantarisTrigger, VantarisPollingTrigger, Vantaris } = require('./harness.cjs');
const { sign } = require(path.join(__dirname, '..', 'dist', 'nodes', 'shared', 'signature.js'));

const BASE = 'https://grc.kunde.example';
const HOOK_URL = 'https://n8n.example/webhook/abc/webhook';
const SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const OWN = 'vtk_0123'; // first 4 characters of the key id of TEST_KEY
const OTHER = 'vtk_9999';

function evt(n, type = 'task.updated', actor = { kind: 'user', via: 'ui' }) {
	return {
		id: `evt_a${n}`,
		type,
		occurred_at: `2026-10-31T10:${String(n).padStart(2, '0')}:00Z`,
		tenant: 2,
		object: { type: type.split('.')[0], id: 100 + n, href: `/api/v1/tasks/${100 + n}`, name: `Aufgabe ${n}` },
		changes: ['status'],
		actor,
		data: {},
	};
}

// ---------- webhook trigger ----------
test('webhook trigger: create subscribes with target URL and events, stores id and secret', async () => {
	await withMock(async (mock) => {
		mock.reset(() => ({ status: 201, headers: { location: 'https://grc.kunde.example/api/v1/webhooks/17' }, body: { ok: true, data: { id: 17, target_url: HOOK_URL, events: ['task.*', 'incident.deadline'], status: 'active', secret: SECRET } } }));
		const staticData = {};
		const ctx = fakeContext({ baseUrl: BASE, staticData, webhookUrl: HOOK_URL, parameters: { events: ['task.*', 'incident.deadline'] } });
		const ok = await new VantarisTrigger().webhookMethods.default.create.call(ctx);
		assert.equal(ok, true);
		const req = mock.requests[0];
		assert.equal(req.method, 'POST');
		assert.equal(req.url, `${BASE}/api/v1/webhooks`);
		assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
		assert.deepEqual(req.body, { target_url: HOOK_URL, events: ['task.*', 'incident.deadline'], description: 'n8n: Flow X' });
		assert.deepEqual(staticData, { webhookId: 17, webhookSecret: SECRET, webhookUrl: HOOK_URL });
	});
});

test('webhook trigger: create surfaces a refused target (422) as readable error', async () => {
	await withMock(async (mock) => {
		mock.reset(() => ({ status: 422, body: { type: 'about:blank', title: 'Unprocessable Content', status: 422, code: 'validation_failed', errors: [{ field: 'target_url', code: 'invalid_value' }] } }));
		const ctx = fakeContext({ baseUrl: BASE, webhookUrl: 'http://localhost:5678/webhook-test/x', parameters: { events: ['*'] } });
		await assert.rejects(new VantarisTrigger().webhookMethods.default.create.call(ctx), (e) => {
			assert.match(e.message, /422/);
			assert.match(e.description, /Field 'target_url': invalid_value/);
			return true;
		});
	});
});

test('webhook trigger: checkExists is true only for the same active subscription', async () => {
	await withMock(async (mock) => {
		const trigger = new VantarisTrigger();
		const hook = (over) => ({ status: 200, body: { ok: true, data: { id: 17, target_url: HOOK_URL, events: ['task.*'], status: 'active', ...over } } });
		const run = async (answer, events = ['task.*']) => {
			mock.reset((req) => (req.method === 'DELETE' ? { status: 204 } : answer));
			const staticData = { webhookId: 17, webhookSecret: SECRET, webhookUrl: HOOK_URL };
			const ctx = fakeContext({ baseUrl: BASE, staticData, webhookUrl: HOOK_URL, parameters: { events } });
			return { exists: await trigger.webhookMethods.default.checkExists.call(ctx), staticData, requests: mock.requests.map((r) => `${r.method} ${r.path}`) };
		};
		let r = await run(hook({}));
		assert.equal(r.exists, true);
		assert.deepEqual(r.requests, ['GET /api/v1/webhooks/17']);
		r = await run({ status: 404, body: { type: 'about:blank', title: 'Not Found', status: 404, code: 'resource_not_found' } });
		assert.equal(r.exists, false);
		assert.deepEqual(r.staticData, {});
		r = await run(hook({ status: 'disabled', disabled_reason: 'failures' }));
		assert.equal(r.exists, false);
		assert.deepEqual(r.requests, ['GET /api/v1/webhooks/17', 'DELETE /api/v1/webhooks/17']);
		r = await run(hook({}), ['task.*', 'incident.*']);
		assert.equal(r.exists, false, 'changed events need a new subscription');
		const none = fakeContext({ baseUrl: BASE, staticData: {}, webhookUrl: HOOK_URL, parameters: { events: ['*'] } });
		assert.equal(await trigger.webhookMethods.default.checkExists.call(none), false);
	});
});

test('webhook trigger: delete unsubscribes and tolerates an already removed subscription', async () => {
	await withMock(async (mock) => {
		for (const status of [204, 404]) {
			mock.reset(() => (status === 204 ? { status } : { status, body: { type: 'about:blank', title: 'Not Found', status, code: 'resource_not_found' } }));
			const staticData = { webhookId: 17, webhookSecret: SECRET, webhookUrl: HOOK_URL };
			const ctx = fakeContext({ baseUrl: BASE, staticData });
			assert.equal(await new VantarisTrigger().webhookMethods.default.delete.call(ctx), true);
			assert.equal(mock.requests[0].method, 'DELETE');
			assert.equal(mock.requests[0].url, `${BASE}/api/v1/webhooks/17`);
			assert.deepEqual(staticData, {});
		}
	});
});

function delivery(event, { secret = SECRET, ts = Math.floor(Date.now() / 1000), tamper = false } = {}) {
	const raw = Buffer.from(JSON.stringify(event));
	const headers = { 'webhook-id': event.id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, event.id, ts, raw), 'content-type': 'application/json' };
	return { headers, rawBody: tamper ? Buffer.from(JSON.stringify({ ...event, type: 'task.deleted' })) : raw, body: event };
}

async function receive(request, parameters = {}) {
	const ctx = fakeContext({
		baseUrl: BASE,
		staticData: { webhookId: 17, webhookSecret: SECRET, webhookUrl: HOOK_URL },
		request,
		parameters: { events: ['*'], ignoreOwnChanges: true, includeObject: false, ...parameters },
	});
	const result = await new VantarisTrigger().webhook.call(ctx);
	return { result, response: ctx.responseLog };
}

test('webhook trigger: a correctly signed event starts the workflow', async () => {
	const { result } = await receive(delivery(evt(1)));
	assert.deepEqual(result.workflowData, [[{ json: evt(1) }]]);
	assert.deepEqual(result.webhookResponse, { received: true });
});

test('webhook trigger: wrong signature, wrong secret or an old timestamp answer 401 and start nothing', async () => {
	for (const req of [
		delivery(evt(1), { tamper: true }),
		delivery(evt(1), { secret: 'whsec_' + Buffer.from('other').toString('base64') }),
		delivery(evt(1), { ts: Math.floor(Date.now() / 1000) - 3600 }),
	]) {
		const { result, response } = await receive(req);
		assert.equal(result.workflowData, undefined);
		assert.equal(result.noWebhookResponse, true);
		assert.equal(response.status, 401);
	}
});

test('webhook trigger: own changes are ignored (echo suppression), others pass', async () => {
	const own = evt(2, 'task.updated', { kind: 'api', via: 'api', key: OWN });
	const other = evt(3, 'task.updated', { kind: 'api', via: 'api', key: OTHER });
	let r = await receive(delivery(own));
	assert.equal(r.result.workflowData, undefined);
	assert.deepEqual(r.result.webhookResponse, { received: true, ignored: true });
	r = await receive(delivery(other));
	assert.equal(r.result.workflowData[0].length, 1);
	r = await receive(delivery(own), { ignoreOwnChanges: false });
	assert.equal(r.result.workflowData[0].length, 1, 'option off: own changes pass');
});

test('webhook trigger: events outside the chosen types are ignored', async () => {
	const r = await receive(delivery(evt(4, 'asset.created')), { events: ['task.*', 'incident.deadline'] });
	assert.equal(r.result.workflowData, undefined);
	const ok = await receive(delivery(evt(5, 'incident.deadline')), { events: ['task.*', 'incident.deadline'] });
	assert.equal(ok.result.workflowData[0].length, 1);
});

test('webhook trigger: "Include Object" loads the object with the key', async () => {
	await withMock(async (mock) => {
		mock.reset(() => ({ status: 200, body: { ok: true, data: { id: 101, name: 'Aufgabe 1', status: 'open' } } }));
		const { result } = await receive(delivery(evt(1)), { includeObject: true });
		assert.equal(mock.requests[0].url, `${BASE}/api/v1/tasks/101`);
		assert.deepEqual(result.workflowData[0][0].json.object_data, { id: 101, name: 'Aufgabe 1', status: 'open' });
	});
});

// ---------- polling trigger ----------
function feed(pages) {
	// pages: map of "after" cursor ('' = no cursor) => {data, next_cursor, has_more}
	return (req) => {
		if (req.query.after && !(req.query.after in pages)) return { status: 400, body: { type: 'about:blank', title: 'Bad Request', status: 400, code: 'invalid_cursor' } };
		const key = req.query.since ? `since:${req.query.since}` : (req.query.after ?? '');
		const page = pages[key];
		if (!page) return { status: 200, body: { data: [], next_cursor: req.query.after ?? 'c0', has_more: false } };
		return { status: 200, body: page };
	};
}

async function poll(staticData, parameters = {}, mode = 'trigger') {
	const ctx = fakeContext({ baseUrl: BASE, staticData, mode, parameters: { events: ['*'], ignoreOwnChanges: true, includeObject: false, ...parameters } });
	const out = await new VantarisPollingTrigger().poll.call(ctx);
	return out ? out[0].map((i) => i.json.id) : null;
}

test('polling trigger: first poll only primes the cursor, later polls return new events', async () => {
	await withMock(async (mock) => {
		mock.reset(
			feed({
				'': { data: [evt(1), evt(2)], next_cursor: 'c2', has_more: false },
				c2: { data: [evt(3), evt(4)], next_cursor: 'c4', has_more: false },
				c4: { data: [], next_cursor: 'c4', has_more: false },
			}),
		);
		const state = {};
		assert.equal(await poll(state), null, 'no replay of the past on activation');
		assert.equal(state.cursor, 'c2');
		assert.deepEqual(await poll(state), ['evt_a3', 'evt_a4']);
		assert.equal(state.cursor, 'c4');
		assert.equal(await poll(state), null);
		assert.deepEqual(
			mock.requests.map((r) => r.query),
			[{ limit: '200' }, { limit: '200', after: 'c2' }, { limit: '200', after: 'c4' }],
		);
		assert.equal(mock.requests[0].url.startsWith(`${BASE}/api/v1/events`), true);
	});
});

test('polling trigger: follows has_more within one poll and drops duplicates', async () => {
	await withMock(async (mock) => {
		mock.reset(
			feed({
				c0: { data: [evt(5), evt(6)], next_cursor: 'c6', has_more: true },
				c6: { data: [evt(6), evt(7)], next_cursor: 'c7', has_more: false },
			}),
		);
		const state = { cursor: 'c0', seen: ['evt_a5'] };
		assert.deepEqual(await poll(state), ['evt_a6', 'evt_a7'], 'evt_a5 seen before, evt_a6 repeated on the next page');
		assert.equal(state.cursor, 'c7');
		assert.equal(state.lastOccurredAt, '2026-10-31T10:07:00Z');
	});
});

test('polling trigger: an expired cursor restarts at the newest seen time without duplicates', async () => {
	await withMock(async (mock) => {
		mock.reset(feed({ 'since:2026-10-31T10:07:00Z': { data: [evt(7), evt(8)], next_cursor: 'c8', has_more: false } }));
		const state = { cursor: 'gone', seen: ['evt_a7'], lastOccurredAt: '2026-10-31T10:07:00Z' };
		assert.deepEqual(await poll(state), ['evt_a8']);
		assert.equal(state.cursor, 'c8');
		assert.deepEqual(mock.requests.map((r) => r.query), [{ limit: '200', after: 'gone' }, { limit: '200', since: '2026-10-31T10:07:00Z' }]);
	});
});

test('polling trigger: echo suppression and type filter; types go to the API as ?types=', async () => {
	await withMock(async (mock) => {
		mock.reset(
			feed({
				c0: {
					data: [evt(1, 'task.updated', { kind: 'api', via: 'api', key: OWN }), evt(2, 'task.created'), evt(3, 'asset.created'), evt(4, 'incident.deadline', { kind: 'system', via: 'cron' })],
					next_cursor: 'c4',
					has_more: false,
				},
			}),
		);
		const state = { cursor: 'c0' };
		assert.deepEqual(await poll(state, { events: ['task.*', 'incident.deadline'] }), ['evt_a2', 'evt_a4']);
		assert.equal(mock.requests[0].query.types, 'task.*,incident.deadline');
		assert.deepEqual(state.seen, ['evt_a1', 'evt_a2', 'evt_a3', 'evt_a4'], 'filtered events are still marked as seen');
	});
});

test('polling trigger: own changes pass when the option is off', async () => {
	await withMock(async (mock) => {
		mock.reset(feed({ c0: { data: [evt(1, 'task.updated', { kind: 'api', via: 'api', key: OWN })], next_cursor: 'c1', has_more: false } }));
		assert.deepEqual(await poll({ cursor: 'c0' }, { ignoreOwnChanges: false }), ['evt_a1']);
	});
});

test('polling trigger: manual "Fetch Test Event" returns sample events and keeps the stored cursor', async () => {
	await withMock(async (mock) => {
		mock.reset(feed({ '': { data: [evt(1), evt(2)], next_cursor: 'c2', has_more: false } }));
		const state = { cursor: 'keep' };
		assert.deepEqual(await poll(state, {}, 'manual'), ['evt_a1', 'evt_a2']);
		assert.deepEqual(state, { cursor: 'keep' });
		assert.deepEqual(mock.requests[0].query, { limit: '10' });
	});
});

test('polling trigger: problem answers surface readably', async () => {
	await withMock(async (mock) => {
		mock.reset(() => ({ status: 403, body: { type: 'about:blank', title: 'Forbidden', status: 403, code: 'insufficient_scope' } }));
		await assert.rejects(poll({ cursor: 'c0' }), /403 Forbidden \(insufficient_scope\)/);
	});
});

// ---------- lookups ----------
test('lookups: statuses and categories from /meta, owners from employees and roles over all pages, tags', async () => {
	await withMock(async (mock) => {
		mock.reset((req) => {
			if (req.path === "/api/v1/incidents/meta" || req.path === "/api/v1/assets/meta") {
				return { status: 200, body: { ok: true, data: { statuses: [{ id: 60, key: 'open', label: 'Offen' }, { id: 61, key: 'closed', label: 'Geschlossen' }], categories: [{ id: 3, name: 'IT' }] } } };
			}
			if (req.path === '/api/v1/employees') {
				return req.query.cursor
					? { status: 200, body: { ok: true, data: [{ id: 2, ref: 'emp_2', name: 'Bea Beispiel' }], next_cursor: null } }
					: { status: 200, body: { ok: true, data: [{ id: 1, ref: 'emp_1', name: 'Anna Muster' }], next_cursor: 'p2' } };
			}
			if (req.path === '/api/v1/roles') return { status: 200, body: { ok: true, data: [{ id: 4, ref: 'role_4', name: 'ISB' }], next_cursor: null } };
			if (req.path === '/api/v1/tags') return { status: 200, body: { ok: true, data: [{ group: 'tag', resources: ['incidents'], terms: ['NIS2', 'Phishing'] }] } };
			return { status: 404, body: { type: 'about:blank', title: 'Not Found', status: 404, code: 'not_found' } };
		});
		const methods = new Vantaris().methods.loadOptions;
		const ctx = fakeContext({ baseUrl: BASE });
		assert.deepEqual(await methods.getIncidentStatus.call(ctx), [
			{ name: 'Geschlossen', value: 'closed' },
			{ name: 'Offen', value: 'open' },
		]);
		assert.deepEqual(await methods.getAssetCategory.call(ctx), [{ name: 'IT', value: 3 }]);
		assert.deepEqual(await methods.getIncidentOwner.call(ctx), [
			{ name: 'Anna Muster', value: 'emp_1' },
			{ name: 'Bea Beispiel', value: 'emp_2' },
			{ name: 'Role: ISB', value: 'role_4' },
		]);
		assert.deepEqual(await methods.getIncidentTag.call(ctx), [
			{ name: 'NIS2', value: 'NIS2' },
			{ name: 'Phishing', value: 'Phishing' },
		]);
		const tagReq = mock.requests.find((r) => r.path === '/api/v1/tags');
		assert.deepEqual(tagReq.query, { group: 'tag' });
		const emp = mock.requests.filter((r) => r.path === '/api/v1/employees').map((r) => r.query);
		assert.deepEqual(emp, [{ limit: '500' }, { limit: '500', cursor: 'p2' }]);
	});
});
