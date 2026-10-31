import { createHmac, timingSafeEqual } from 'crypto';

/** Standard Webhooks (https://www.standardwebhooks.com), symmetric scheme "v1" (HMAC-SHA256). */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

function secretBytes(secret: string): Buffer {
	const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
	return Buffer.from(raw, 'base64');
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
	const value = headers[name] ?? headers[name.toLowerCase()];
	if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
	return value === undefined || value === null ? undefined : String(value);
}

/** Signature "v1,<base64>" over "{id}.{timestamp}.{body}", the body signed byte for byte. */
export function sign(secret: string, id: string, timestamp: number, body: Buffer | string): string {
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
	const mac = createHmac('sha256', secretBytes(secret))
		.update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), payload]))
		.digest('base64');
	return `v1,${mac}`;
}

export function verify(
	secret: string,
	headers: Record<string, unknown>,
	body: Buffer | string,
	nowSeconds: number = Math.floor(Date.now() / 1000),
	toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
	const id = header(headers, 'webhook-id');
	const ts = header(headers, 'webhook-timestamp');
	const sigHeader = header(headers, 'webhook-signature');
	if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing webhook headers' };
	if (!/^\d+$/.test(ts)) return { ok: false, reason: 'invalid timestamp' };
	const timestamp = Number(ts);
	if (nowSeconds - timestamp > toleranceSeconds) return { ok: false, reason: 'timestamp too old' };
	if (timestamp - nowSeconds > toleranceSeconds) return { ok: false, reason: 'timestamp too new' };
	const expected = Buffer.from(sign(secret, id, timestamp, body).slice(3), 'base64');
	for (const candidate of sigHeader.split(' ')) {
		const [version, value] = candidate.split(',', 2);
		if (version !== 'v1' || !value) continue;
		const given = Buffer.from(value, 'base64');
		if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
	}
	return { ok: false, reason: 'no matching signature' };
}
