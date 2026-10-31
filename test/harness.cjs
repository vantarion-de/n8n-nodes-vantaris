// Test harness: runs the built nodes in n8n-core's real execution engine (WorkflowExecute + RoutingNode) and
// answers their HTTP calls from a local mock server. Every outgoing request is rerouted to the mock, whatever
// base URL the credentials name, and recorded with its original URL. No request leaves the machine.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.N8N_USER_FOLDER ??= fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-vantaris-test-'));
process.env.N8N_LOG_LEVEL ??= 'silent';

const core = require('n8n-core');
const wf = require('n8n-workflow');

const dist = path.join(__dirname, '..', 'dist');
const { Vantaris } = require(path.join(dist, 'nodes/Vantaris/Vantaris.node.js'));
const { VantarisTrigger } = require(path.join(dist, 'nodes/VantarisTrigger/VantarisTrigger.node.js'));
const { VantarisPollingTrigger } = require(path.join(dist, 'nodes/VantarisPollingTrigger/VantarisPollingTrigger.node.js'));
const { VantarisApi } = require(path.join(dist, 'credentials/VantarisApi.credentials.js'));
const generated = require(path.join(dist, 'nodes/Vantaris/generated/description.js'));
const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profile', 'profile.json'), 'utf8'));

// The three kinds of instance address the connector must handle (example domains only).
const BASE_URLS = ['https://vantaris.app', 'https://grc.kunde.example', 'http://vantaris.intern.example:8080'];
const TEST_KEY = 'vtk_0123456789ab_TESTKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

// ---------- mock server ----------
class MockServer {
	constructor() {
		this.requests = [];
		this.handler = () => ({ status: 200, body: { ok: true, data: {} } });
		this.server = http.createServer((req, res) => {
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', async () => {
				const raw = Buffer.concat(chunks);
				const original = new URL(String(req.headers['x-original-url'] ?? `http://mock${req.url}`));
				let json;
				try {
					json = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
				} catch {
					json = undefined;
				}
				const record = {
					method: req.method,
					url: original.href,
					origin: original.origin,
					path: original.pathname,
					query: Object.fromEntries(original.searchParams),
					headers: req.headers,
					raw,
					body: json,
				};
				this.requests.push(record);
				const answer = await this.handler(record);
				const status = answer.status ?? 200;
				const headers = { ...(answer.headers ?? {}) };
				if (answer.body === undefined) {
					res.writeHead(status, headers);
					return res.end();
				}
				headers['content-type'] ??= status >= 400 ? 'application/problem+json' : 'application/json';
				res.writeHead(status, headers);
				res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
			});
		});
	}
	async start() {
		await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
		this.base = `http://127.0.0.1:${this.server.address().port}`;
		return this;
	}
	reset(handler) {
		this.requests = [];
		if (handler) this.handler = handler;
	}
	async stop() {
		await new Promise((r) => this.server.close(r));
	}
}

let activeMock;
// Reroute n8n's axios (the default instance used by @n8n/backend-network) to the mock server.
const axiosPath = require.resolve('axios', { paths: [path.dirname(require.resolve('@n8n/backend-network'))] });
const axios = require(axiosPath);
axios.interceptors.request.use((config) => {
	if (!activeMock) throw new Error('no mock server active');
	const original = axios.getUri(config);
	const u = new URL(original);
	config.headers = config.headers ?? {};
	if (typeof config.headers.set === 'function') config.headers.set('x-original-url', original);
	else config.headers['x-original-url'] = original;
	config.baseURL = undefined;
	config.params = undefined;
	config.url = `${activeMock.base}${u.pathname}${u.search}`;
	delete config.httpAgent;
	delete config.httpsAgent;
	config.proxy = false;
	return config;
});

// ---------- execution ----------
const credentialTypes = { vantarisApi: new VantarisApi() };
function nodeTypesFor(types) {
	return {
		getByName: (name) => types[name],
		getByNameAndVersion: (name) => types[name],
		getKnownTypes: () => ({}),
	};
}

function credentialsHelper(credentials) {
	return {
		getParentTypes: () => [],
		getDecrypted: async () => credentials,
		getCredentials: async () => ({}),
		getCredentialsProperties: (type) => credentialTypes[type].properties,
		isCredentialUsableByNode: () => true,
		// Generic authentication as n8n applies it: resolve the credential's header expressions.
		authenticate: async (creds, typeName, request, workflow, node) => {
			const auth = credentialTypes[typeName].authenticate;
			const headers = { ...(request.headers ?? {}) };
			for (const [name, value] of Object.entries(auth.properties.headers ?? {})) {
				headers[name] = workflow.expression.getParameterValue(value, null, 0, 0, node.name, [], 'internal', {
					$credentials: creds,
				});
			}
			return { ...request, headers };
		},
		preAuthentication: async () => undefined,
		updateCredentials: async () => {},
		updateCredentialsOauthTokenData: async () => {},
	};
}

function additionalData(credentials, workflowData) {
	return {
		credentialsHelper: credentialsHelper(credentials),
		hooks: new core.ExecutionLifecycleHooks('manual', 'test-execution', workflowData),
		executeWorkflow: async () => ({}),
		restApiUrl: 'http://localhost:5678/rest',
		webhookBaseUrl: 'http://localhost:5678/webhook',
		webhookWaitingBaseUrl: 'http://localhost:5678/webhook-waiting',
		webhookTestBaseUrl: 'http://localhost:5678/webhook-test',
		formWaitingBaseUrl: 'http://localhost:5678/form-waiting',
		instanceBaseUrl: 'http://localhost:5678',
		variables: {},
		userId: 'test-user',
		setExecutionStatus: () => {},
		logAiEvent: () => {},
		getRunExecutionData: async () => undefined,
		startRunnerTask: async () => ({}),
	};
}

/**
 * Runs one node with the given parameters. Input items may carry binary data ({json, binary: {data: {...}}}).
 * Returns {items, error}.
 */
async function runNode({ nodeType, parameters, baseUrl, apiKey = TEST_KEY, input }) {
	const type = nodeType ?? new Vantaris();
	const name = 'Node';
	const workflowData = {
		id: 'wf-test',
		name: 'test',
		active: false,
		nodes: [
			{
				id: 'n1',
				name,
				type: 'vantaris',
				typeVersion: 1,
				position: [0, 0],
				parameters,
				credentials: { vantarisApi: { id: 'c1', name: 'VantarIS' } },
			},
		],
		connections: {},
		settings: {},
	};
	const workflow = new wf.Workflow({ ...workflowData, nodeTypes: nodeTypesFor({ vantaris: type }) });
	const execute = new core.WorkflowExecute(additionalData({ baseUrl, apiKey }, workflowData), 'manual');
	const node = workflow.getNode(name);
	let run;
	if (input) {
		const runExecutionData = wf.createRunExecutionData({
			executionData: {
				nodeExecutionStack: [{ node, data: { main: [input] }, source: null }],
			},
		});
		const ex = new core.WorkflowExecute(additionalData({ baseUrl, apiKey }, workflowData), 'manual', runExecutionData);
		run = await ex.processRunExecutionData(workflow);
	} else {
		run = await execute.run({ workflow, startNode: node });
	}
	const rd = run.data.resultData;
	if (rd.error) return { items: [], error: rd.error };
	const out = rd.runData[name]?.[0];
	if (out?.error) return { items: [], error: out.error };
	return { items: out?.data?.main?.[0] ?? [], error: undefined };
}

/** Runs the credential test request the way n8n does: a declarative request built from credential.test.request. */
async function runCredentialTest(baseUrl, apiKey = TEST_KEY) {
	const cred = new VantarisApi();
	const testType = {
		description: {
			displayName: 'Credential test',
			name: 'credTest',
			group: ['transform'],
			version: 1,
			defaults: { name: 'Credential test' },
			inputs: ['main'],
			outputs: ['main'],
			credentials: [{ name: 'vantarisApi', required: true }],
			requestDefaults: { ...cred.test.request },
			properties: [],
		},
	};
	return await runNode({ nodeType: testType, parameters: {}, baseUrl, apiKey });
}

async function withMock(fn) {
	const mock = await new MockServer().start();
	activeMock = mock;
	try {
		return await fn(mock);
	} finally {
		activeMock = undefined;
		await mock.stop();
	}
}

/** Minimal function context for trigger, hook and load-options methods (static data, parameters, real HTTP). */
function fakeContext({ parameters = {}, baseUrl, apiKey = TEST_KEY, staticData = {}, mode = 'trigger', webhookUrl, request } = {}) {
	const nodeInfo = { name: 'Node', type: 'vantaris', typeVersion: 1, parameters };
	const responseLog = { status: 200, body: undefined };
	const ctx = {
		getNode: () => nodeInfo,
		getMode: () => mode,
		getWorkflow: () => ({ id: 'wf-test', name: 'Flow X', active: true }),
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, fallback) => (name in parameters ? parameters[name] : fallback),
		getNodeWebhookUrl: () => webhookUrl,
		getCredentials: async () => ({ baseUrl, apiKey }),
		getRequestObject: () => request,
		getBodyData: () => request?.body,
		getHeaderData: () => request?.headers,
		getResponseObject: () => ({
			status(code) {
				responseLog.status = code;
				return this;
			},
			json(body) {
				responseLog.body = body;
				return this;
			},
		}),
		responseLog,
		helpers: {
			returnJsonArray: (items) => [].concat(items).map((json) => ({ json })),
			httpRequestWithAuthentication: async function (_type, options) {
				const url = new URL(options.url);
				for (const [k, v] of Object.entries(options.qs ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
				const headers = { ...(options.headers ?? {}), Authorization: `Bearer ${apiKey}`, 'x-original-url': url.href };
				let body;
				if (options.body !== undefined) {
					body = Buffer.isBuffer(options.body) ? options.body : JSON.stringify(options.body);
					headers['content-type'] ??= 'application/json';
				}
				const res = await fetch(`${activeMock.base}${url.pathname}${url.search}`, { method: options.method, headers, body });
				const text = await res.text();
				let parsed = text;
				try {
					parsed = text ? JSON.parse(text) : '';
				} catch {
					parsed = text;
				}
				if (!options.ignoreHttpStatusErrors && res.status >= 400) throw new Error(`HTTP ${res.status}`);
				return options.returnFullResponse ? { statusCode: res.status, headers: Object.fromEntries(res.headers), body: parsed } : parsed;
			},
		},
	};
	return ctx;
}

module.exports = {
	BASE_URLS,
	TEST_KEY,
	MockServer,
	runNode,
	runCredentialTest,
	withMock,
	fakeContext,
	profile,
	generated,
	Vantaris,
	VantarisTrigger,
	VantarisPollingTrigger,
	VantarisApi,
};
