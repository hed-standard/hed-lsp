/**
 * Tests for the daemon's rate-limit primitives. The clock is a parameter, so every case passes the
 * time it wants and the real token bucket, client table, and client key run unchanged. No mocks.
 */

import { describe, expect, it } from 'vitest';
import { ClientTable, clientKey, normalizeIp, TokenBucket } from '../daemon/limits.js';

describe('TokenBucket', () => {
	it('allows up to the burst and then refuses with a whole-second wait', () => {
		const bucket = new TokenBucket(10, 5, 0);

		expect(bucket.take(5, 0)).toEqual({ allowed: true });
		expect(bucket.take(1, 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
	});

	it('refills at the rate and never above the burst', () => {
		const bucket = new TokenBucket(10, 5, 0);
		bucket.take(5, 0);

		// 300 ms refills 3 tokens.
		expect(bucket.take(3, 300)).toEqual({ allowed: true });
		expect(bucket.take(1, 300)).toEqual({ allowed: false, retryAfterSeconds: 1 });
		// A long idle period refills to the burst, not beyond it.
		expect(bucket.take(5, 3_600_000)).toEqual({ allowed: true });
		expect(bucket.take(1, 3_600_000)).toEqual({ allowed: false, retryAfterSeconds: 1 });
	});

	it('reports the wait in whole seconds, rounded up, and at least one', () => {
		const bucket = new TokenBucket(1, 20, 0);
		bucket.take(20, 0);

		expect(bucket.take(1, 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
		expect(bucket.take(10, 0)).toEqual({ allowed: false, retryAfterSeconds: 10 });
		// 0.5 s of refill leaves 9.5 s for a cost of 10.
		expect(bucket.take(10, 500)).toEqual({ allowed: false, retryAfterSeconds: 10 });
		expect(Number.isInteger((bucket.take(7, 500) as { retryAfterSeconds: number }).retryAfterSeconds)).toBe(true);
	});

	it('takes nothing when it refuses', () => {
		const bucket = new TokenBucket(1, 10, 0);
		bucket.take(8, 0);

		expect(bucket.take(5, 0).allowed).toBe(false);
		expect(bucket.take(2, 0)).toEqual({ allowed: true });
	});

	it('charges a cost above the burst as the whole burst', () => {
		const bucket = new TokenBucket(1, 4, 0);

		expect(bucket.take(100, 0)).toEqual({ allowed: true });
		expect(bucket.take(100, 0)).toEqual({ allowed: false, retryAfterSeconds: 4 });
		expect(bucket.take(100, 4000)).toEqual({ allowed: true });
	});

	it('ignores a clock that steps backwards', () => {
		const bucket = new TokenBucket(10, 5, 1000);
		bucket.take(5, 1000);

		expect(bucket.take(1, 0).allowed).toBe(false);
		expect(bucket.take(1, 1100)).toEqual({ allowed: true });
	});

	it('rejects a rate or burst that is not positive', () => {
		expect(() => new TokenBucket(0, 5, 0)).toThrow(RangeError);
		expect(() => new TokenBucket(1, 0, 0)).toThrow(RangeError);
	});
});

describe('ClientTable', () => {
	function table(maxClients: number, idleMs: number): ClientTable<{ made: number }> {
		return new ClientTable({ maxClients, idleMs, create: (now) => ({ made: now }) });
	}

	it('creates state once per client and returns the same state afterwards', () => {
		const clients = table(10, 1000);
		const first = clients.get('a', 0);

		expect(clients.get('a', 10)).toBe(first);
		expect(clients.get('b', 10)).not.toBe(first);
		expect(clients.size).toBe(2);
	});

	it('evicts the least recently used client past the maximum of 2', () => {
		const clients = table(2, 1_000_000);
		clients.get('a', 0);
		clients.get('b', 1);
		clients.get('a', 2); // a is now the most recent
		clients.get('c', 3);

		expect(clients.size).toBe(2);
		expect(clients.has('a')).toBe(true);
		expect(clients.has('b')).toBe(false);
		expect(clients.has('c')).toBe(true);
	});

	it('gives a client that was evicted fresh state when it returns', () => {
		const clients = table(1, 1_000_000);
		const first = clients.get('a', 0);
		clients.get('b', 1);

		expect(clients.get('a', 2)).not.toBe(first);
	});

	it('drops clients idle past the limit, and keeps the recently seen', () => {
		const clients = table(10, 1000);
		clients.get('old', 0);
		clients.get('fresh', 900);

		expect(clients.sweep(1000)).toBe(1);
		expect(clients.has('old')).toBe(false);
		expect(clients.has('fresh')).toBe(true);
	});

	it('expires an idle client on access, so it returns with fresh state', () => {
		const clients = table(10, 1000);
		const first = clients.get('a', 0);

		expect(clients.get('a', 999)).toBe(first);
		expect(clients.get('a', 1998)).toBe(first);
		expect(clients.get('a', 2998)).not.toBe(first);
	});

	it('holds a bucket per client so one client cannot spend another one', () => {
		const clients = new ClientTable({ maxClients: 10, idleMs: 1000, create: (now) => new TokenBucket(1, 2, now) });

		expect(clients.get('a', 0).take(2, 0).allowed).toBe(true);
		expect(clients.get('a', 0).take(1, 0).allowed).toBe(false);
		expect(clients.get('b', 0).take(2, 0).allowed).toBe(true);
	});

	it('rejects a maximum that is not a positive integer', () => {
		expect(() => table(0, 1000)).toThrow(RangeError);
		expect(() => table(1.5, 1000)).toThrow(RangeError);
	});
});

describe('normalizeIp', () => {
	it.each([
		['1.2.3.4', '1.2.3.4'],
		['::ffff:1.2.3.4', '1.2.3.4'],
		['::FFFF:102:304', '1.2.3.4'],
		['0:0:0:0:0:ffff:7f00:1', '127.0.0.1'],
		['::1', '0:0:0:0:0:0:0:1'],
		['2001:DB8::1', '2001:db8:0:0:0:0:0:1'],
		['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0:0:0:0:0:1'],
		['fe80::1%en0', 'fe80:0:0:0:0:0:0:1'],
		['::', '0:0:0:0:0:0:0:0'],
		['64:ff9b::1.2.3.4', '64:ff9b:0:0:0:0:102:304'],
		['  10.0.0.1 ', '10.0.0.1'],
	])('writes %s as %s', (input, expected) => {
		expect(normalizeIp(input)).toBe(expected);
	});

	it.each(['', 'host', '1.2.3', '256.1.1.1', '1.2.3.4.5', '2001:db8::1::2', '[::1]', '1.2.3.4:80', 'unknown'])(
		'rejects %j',
		(input) => {
			expect(normalizeIp(input)).toBeNull();
		},
	);
});

describe('clientKey', () => {
	const trusted = ['127.0.0.1', '0:0:0:0:0:0:0:1'];

	it('keys an IPv4 peer by its address', () => {
		expect(clientKey('203.0.113.9', undefined, trusted)).toBe('203.0.113.9');
	});

	it('normalizes an IPv4-mapped IPv6 peer to the IPv4 address', () => {
		expect(clientKey('::ffff:203.0.113.9', undefined, trusted)).toBe('203.0.113.9');
		expect(clientKey('::ffff:cb00:7109', undefined, trusted)).toBe('203.0.113.9');
	});

	it('keys an IPv6 peer by its /64, so addresses of one subscriber share a key', () => {
		const a = clientKey('2001:db8:abcd:12::1', undefined, trusted);
		const b = clientKey('2001:db8:abcd:12:ffff:eeee:dddd:cccc', undefined, trusted);
		const other = clientKey('2001:db8:abcd:13::1', undefined, trusted);

		expect(a).toBe('2001:db8:abcd:12::/64');
		expect(b).toBe(a);
		expect(other).not.toBe(a);
	});

	it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
		expect(clientKey('203.0.113.9', '198.51.100.7', trusted)).toBe('203.0.113.9');
		expect(clientKey('203.0.113.9', '198.51.100.7, 192.0.2.1', trusted)).toBe('203.0.113.9');
	});

	it('uses the rightmost X-Forwarded-For entry from a trusted proxy', () => {
		// The proxy appended the last entry; the earlier ones came from the client and can be forged.
		expect(clientKey('127.0.0.1', '6.6.6.6, 198.51.100.7', trusted)).toBe('198.51.100.7');
		expect(clientKey('127.0.0.1', ' 198.51.100.7 ', trusted)).toBe('198.51.100.7');
	});

	it('recognizes a trusted proxy whatever form its address takes', () => {
		expect(clientKey('::ffff:127.0.0.1', '198.51.100.7', trusted)).toBe('198.51.100.7');
		expect(clientKey('::1', '198.51.100.7', trusted)).toBe('198.51.100.7');
	});

	it('keys a forwarded IPv6 client by its /64 and a mapped one by its IPv4 address', () => {
		expect(clientKey('127.0.0.1', '2001:db8:1:2:3:4:5:6', trusted)).toBe('2001:db8:1:2::/64');
		expect(clientKey('127.0.0.1', '::ffff:198.51.100.7', trusted)).toBe('198.51.100.7');
	});

	it('falls back to the peer when the rightmost entry is not an IP address', () => {
		expect(clientKey('127.0.0.1', '198.51.100.7, not-an-ip', trusted)).toBe('127.0.0.1');
		expect(clientKey('127.0.0.1', '198.51.100.7,', trusted)).toBe('127.0.0.1');
		expect(clientKey('127.0.0.1', '', trusted)).toBe('127.0.0.1');
	});

	it('ignores X-Forwarded-For when no proxy is trusted', () => {
		expect(clientKey('127.0.0.1', '198.51.100.7', [])).toBe('127.0.0.1');
	});

	it('uses one shared key for a peer without a usable address', () => {
		expect(clientKey(undefined, '198.51.100.7', trusted)).toBe('unknown');
		expect(clientKey('garbage', undefined, trusted)).toBe('unknown');
	});
});
