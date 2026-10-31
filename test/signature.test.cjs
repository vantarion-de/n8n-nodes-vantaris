// Standard Webhooks signature check. Known-answer vectors and cases taken from the official repository
// standard-webhooks/standard-webhooks, libraries/javascript/src/webhook.test.ts (commit ab68441, main, 31.10.2026).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sign, verify } = require(path.join(__dirname, '..', 'dist', 'nodes', 'shared', 'signature.js'));

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const MSG_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const PAYLOAD = '{"test": 2432232314}';
const VECTOR_TS = 1614265330;
const VECTOR_SIG = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const BINARY_SIG = 'v1,sEcZ042G8Crqgxbybb3y0eDxQR3TcfYsk11I1XULhSI=';
const TOLERANCE = 5 * 60;

const now = () => Math.floor(Date.now() / 1000);
function headers(ts = now(), payload = PAYLOAD, secret = SECRET) {
	return { 'webhook-id': MSG_ID, 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, MSG_ID, ts, payload) };
}

test('known-answer vector: sign()', () => {
	assert.equal(sign(SECRET, MSG_ID, VECTOR_TS, PAYLOAD), VECTOR_SIG);
});

test('known-answer vector: binary payload is signed byte for byte', () => {
	assert.equal(sign(SECRET, MSG_ID, VECTOR_TS, BINARY), BINARY_SIG);
});

test('known-answer vector verifies at its own timestamp', () => {
	const h = { 'webhook-id': MSG_ID, 'webhook-timestamp': String(VECTOR_TS), 'webhook-signature': VECTOR_SIG };
	assert.deepEqual(verify(SECRET, h, Buffer.from(PAYLOAD), VECTOR_TS), { ok: true });
});

test('valid signature is valid', () => {
	assert.deepEqual(verify(SECRET, headers(), Buffer.from(PAYLOAD)), { ok: true });
});

test('verification works with and without the whsec_ prefix', () => {
	assert.deepEqual(verify(SECRET.slice('whsec_'.length), headers(), PAYLOAD), { ok: true });
});

test('missing id, timestamp or signature fails', () => {
	for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
		const h = headers();
		delete h[name];
		assert.equal(verify(SECRET, h, PAYLOAD).ok, false, name);
	}
});

test('invalid signature fails', () => {
	const h = { ...headers(), 'webhook-signature': 'v1,dawfeoifkpqwoekfpqoekf' };
	assert.equal(verify(SECRET, h, PAYLOAD).ok, false);
});

test('partial signature fails', () => {
	const h = headers();
	h['webhook-signature'] = h['webhook-signature'].slice(0, Math.floor(h['webhook-signature'].length / 2));
	assert.equal(verify(SECRET, h, PAYLOAD).ok, false);
	assert.equal(verify(SECRET, { ...h, 'webhook-signature': 'v1,' }, PAYLOAD).ok, false);
});

test('timestamp older or newer than the tolerance fails', () => {
	assert.equal(verify(SECRET, headers(now() - TOLERANCE - 1), PAYLOAD).ok, false);
	assert.equal(verify(SECRET, headers(now() + TOLERANCE + 1), PAYLOAD).ok, false);
	assert.equal(verify(SECRET, headers(now() - TOLERANCE + 5), PAYLOAD).ok, true);
});

test('multiple signatures: one valid among others passes; malformed ones are skipped', () => {
	const valid = headers()['webhook-signature'];
	const h = headers();
	h['webhook-signature'] = ['v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=', valid, 'v2,abc', 'v1,not-base64!'].join(' ');
	assert.deepEqual(verify(SECRET, h, PAYLOAD), { ok: true });
});

test('valid signature with an unknown version fails', () => {
	const h = headers();
	h['webhook-signature'] = h['webhook-signature'].replace(/^v1,/, 'v2,');
	assert.equal(verify(SECRET, h, PAYLOAD).ok, false);
});

test('a changed body (e.g. re-serialised JSON) fails', () => {
	const h = headers();
	assert.equal(verify(SECRET, h, JSON.stringify(JSON.parse(PAYLOAD))).ok, false);
});

test('a different secret fails', () => {
	assert.equal(verify('whsec_' + Buffer.from('another secret').toString('base64'), headers(), PAYLOAD).ok, false);
});
