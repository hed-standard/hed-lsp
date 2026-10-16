/**
 * Tests for the daemon's limit primitives. The clock is a parameter, so every case passes the time
 * it wants and the real token bucket, client table, and client key run unchanged. The slot limiter
 * and the cancellation helpers run on real promises and real abort signals. No mocks.
 */

import { describe, expect, it } from 'vitest';
import {
	abortable,
	batchCost,
	ClientTable,
	clientKey,
	itemCost,
	monotonicNow,
	normalizeIp,
	SlotLimiter,
	TokenBucket,
	throwIfCancelled,
	WorkCancelled,
} from '../daemon/limits.js';

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

	it('checks without taking, so a check can be repeated and a later take still works', () => {
		const bucket = new TokenBucket(1, 5, 0);

		expect(bucket.check(5, 0)).toEqual({ allowed: true });
		expect(bucket.check(5, 0)).toEqual({ allowed: true });
		expect(bucket.take(5, 0)).toEqual({ allowed: true });
		expect(bucket.check(1, 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
		expect(bucket.check(3, 0)).toEqual({ allowed: false, retryAfterSeconds: 3 });
	});

	it('refills when it is checked, so a check at a later time sees the refilled tokens', () => {
		const bucket = new TokenBucket(2, 4, 0);
		bucket.take(4, 0);

		expect(bucket.check(2, 1000)).toEqual({ allowed: true });
		expect(bucket.check(3, 1000)).toEqual({ allowed: false, retryAfterSeconds: 1 });
		expect(bucket.take(2, 1000)).toEqual({ allowed: true });
		expect(bucket.check(1, 1000).allowed).toBe(false);
	});
});

describe('monotonicNow', () => {
	/** Run `action` while the wall clock reads `offsetMs` away from the real time, as after a clock adjustment. */
	async function withWallClockStep<T>(offsetMs: number, action: () => Promise<T>): Promise<T> {
		const realNow = Date.now;
		Date.now = () => realNow() + offsetMs;
		try {
			return await action();
		} finally {
			Date.now = realNow;
		}
	}

	it('keeps moving forward when the wall clock steps back an hour, and does not read the wall clock', async () => {
		const before = monotonicNow();

		const after = await withWallClockStep(-3_600_000, async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return monotonicNow();
		});

		expect(after - before).toBeGreaterThanOrEqual(25);
		expect(after - before).toBeLessThan(3000);
	});

	it('lets a bucket that reads it refill across a backward step of the wall clock', async () => {
		const bucket = new TokenBucket(100, 10, monotonicNow());
		expect(bucket.take(10, monotonicNow())).toEqual({ allowed: true });
		expect(bucket.take(1, monotonicNow()).allowed).toBe(false);

		await withWallClockStep(-3_600_000, async () => {
			// 100 tokens a second: 60 ms refills 6.
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(bucket.take(1, monotonicNow())).toEqual({ allowed: true });
		});
	});
});

describe('SlotLimiter', () => {
	it('hands out its capacity and then refuses', () => {
		const slots = new SlotLimiter(2);

		const first = slots.tryAcquire();
		const second = slots.tryAcquire();

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(slots.tryAcquire()).toBeNull();
		expect(slots.active).toBe(2);
	});

	it('takes a slot back when it is released, and ignores a second release of the same slot', () => {
		const slots = new SlotLimiter(1);
		const release = slots.tryAcquire();

		release?.();
		release?.();

		expect(slots.active).toBe(0);
		const again = slots.tryAcquire();
		expect(again).not.toBeNull();
		// The extra release above did not make a second slot appear.
		expect(slots.tryAcquire()).toBeNull();
		again?.();
	});

	it('rejects a capacity that is not a positive integer', () => {
		expect(() => new SlotLimiter(0)).toThrow(RangeError);
		expect(() => new SlotLimiter(1.5)).toThrow(RangeError);
	});
});

describe('cancellation', () => {
	it('throws WorkCancelled from throwIfCancelled only once the signal has aborted', () => {
		const controller = new AbortController();

		expect(() => throwIfCancelled(controller.signal)).not.toThrow();
		controller.abort();
		expect(() => throwIfCancelled(controller.signal)).toThrow(WorkCancelled);
	});

	it('gives the value of a promise that settles before the signal aborts', async () => {
		const controller = new AbortController();

		await expect(abortable(Promise.resolve(7), controller.signal)).resolves.toBe(7);
		await expect(abortable(Promise.reject(new Error('own failure')), controller.signal)).rejects.toThrow('own failure');
	});

	it('stops waiting with WorkCancelled when the signal aborts, and leaves the promise running', async () => {
		const controller = new AbortController();
		let finish!: (value: string) => void;
		const slow = new Promise<string>((resolve) => {
			finish = resolve;
		});

		const waiting = abortable(slow, controller.signal);
		controller.abort();

		await expect(waiting).rejects.toBeInstanceOf(WorkCancelled);
		finish('done');
		await expect(slow).resolves.toBe('done');
	});

	it('rejects at once for a signal that has already aborted', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(abortable(Promise.resolve(1), controller.signal)).rejects.toBeInstanceOf(WorkCancelled);
	});

	it('stops waiting when a real timer aborts the signal', async () => {
		const never = new Promise<void>(() => undefined);

		await expect(abortable(never, AbortSignal.timeout(30))).rejects.toBeInstanceOf(WorkCancelled);
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

describe('itemCost', () => {
	it('costs one unit for each chars-per-unit characters, rounded up', () => {
		expect(itemCost(1, 256)).toBe(1);
		expect(itemCost(256, 256)).toBe(1);
		expect(itemCost(257, 256)).toBe(2);
		expect(itemCost(512, 256)).toBe(2);
		expect(itemCost(513, 256)).toBe(3);
		expect(itemCost(4096, 256)).toBe(16);
		expect(itemCost(4097, 256)).toBe(17);
	});

	it('never costs less than one unit, even for the empty string', () => {
		expect(itemCost(0, 256)).toBe(1);
		expect(itemCost(0, 1)).toBe(1);
	});

	it('follows the chars-per-unit setting, down to one character a unit', () => {
		expect(itemCost(10, 1)).toBe(10);
		expect(itemCost(10, 3)).toBe(4);
		expect(itemCost(10, 1_000_000)).toBe(1);
	});
});

describe('batchCost', () => {
	it('adds the cost of each string, so many short strings and few long ones can cost the same', () => {
		const shortOnes = Array.from({ length: 16 }, () => 'Sensory-event');
		const oneLong = ['a'.repeat(4096)];

		expect(batchCost(shortOnes, 256)).toBe(16);
		expect(batchCost(oneLong, 256)).toBe(16);
		expect(batchCost([...shortOnes, ...oneLong], 256)).toBe(32);
	});

	it('costs one unit for an item that is not a string, and nothing for no items', () => {
		expect(batchCost([42, null, undefined, { x: 1 }, ['a'], true], 256)).toBe(6);
		expect(batchCost([], 256)).toBe(0);
	});
});
