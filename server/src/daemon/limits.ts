/**
 * Rate-limit primitives for the daemon: a token bucket, a bounded table of clients with
 * least-recently-used eviction and idle expiry, and the client key.
 *
 * Time is always a parameter (milliseconds, any monotonic origin), so the callers pass the clock
 * and the primitives stay deterministic. Nothing here touches the network or the filesystem, and
 * the client table lives in memory only.
 */

import * as net from 'node:net';

/** The outcome of taking tokens: allowed, or the whole seconds to wait before the cost fits. */
export type TakeResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * A token bucket that holds up to `burst` tokens and refills at `ratePerSec`. A request is charged
 * its cost in items. A cost larger than the burst is charged as the whole burst, so it can pass
 * from a full bucket instead of being refused forever.
 */
export class TokenBucket {
	private tokens: number;
	private last: number;

	constructor(
		readonly ratePerSec: number,
		readonly burst: number,
		now: number,
	) {
		if (!(ratePerSec > 0) || !(burst > 0)) {
			throw new RangeError('ratePerSec and burst must be positive');
		}
		this.tokens = burst;
		this.last = now;
	}

	/** Take `cost` tokens at time `now` (milliseconds). Nothing is taken when the answer is no. */
	take(cost: number, now: number): TakeResult {
		this.refill(now);
		const charge = Math.min(cost, this.burst);
		if (this.tokens >= charge) {
			this.tokens -= charge;
			return { allowed: true };
		}
		const seconds = (charge - this.tokens) / this.ratePerSec;
		return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(seconds)) };
	}

	private refill(now: number): void {
		// A clock that steps backwards adds nothing.
		const elapsedSeconds = Math.max(0, now - this.last) / 1000;
		this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSec);
		this.last = Math.max(this.last, now);
	}
}

export interface ClientTableOptions<T> {
	/** The most clients held at once; the least recently seen is evicted past it. */
	maxClients: number;
	/** A client not seen for this many milliseconds is dropped. */
	idleMs: number;
	/** Build the state for a client first seen at `now`. */
	create: (now: number) => T;
}

interface TableEntry<T> {
	value: T;
	lastSeen: number;
}

/**
 * A bounded table of per-client state. Entries stay in order of last use, so eviction and expiry
 * both take from the front. A client that was evicted or expired and comes back starts with fresh
 * state, which is the accepted cost of keeping the table bounded.
 */
export class ClientTable<T> {
	private readonly entries = new Map<string, TableEntry<T>>();

	constructor(private readonly options: ClientTableOptions<T>) {
		if (!Number.isInteger(options.maxClients) || options.maxClients < 1) {
			throw new RangeError('maxClients must be a positive integer');
		}
	}

	/** The state for `key`, created when missing, and marked as used at `now`. */
	get(key: string, now: number): T {
		this.sweep(now);
		const found = this.entries.get(key);
		if (found) {
			found.lastSeen = now;
			// Delete and set again to move the entry to the most recently used end.
			this.entries.delete(key);
			this.entries.set(key, found);
			return found.value;
		}
		const entry: TableEntry<T> = { value: this.options.create(now), lastSeen: now };
		this.entries.set(key, entry);
		while (this.entries.size > this.options.maxClients) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.entries.delete(oldest.value);
		}
		return entry.value;
	}

	/** Drop clients idle past the limit. Returns how many were dropped. */
	sweep(now: number): number {
		let dropped = 0;
		for (const [key, entry] of this.entries) {
			if (now - entry.lastSeen < this.options.idleMs) {
				break;
			}
			this.entries.delete(key);
			dropped++;
		}
		return dropped;
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	get size(): number {
		return this.entries.size;
	}
}

/** Parse an IPv6 address into eight 16-bit groups, or null when it is not one. */
function parseIpv6(text: string): number[] | null {
	let address = text;
	const zone = address.indexOf('%');
	if (zone !== -1) {
		address = address.slice(0, zone);
	}
	if (!net.isIPv6(address)) {
		return null;
	}

	// An IPv4 tail (::ffff:1.2.3.4) is two groups; parse the rest with a placeholder in its place.
	let tail: number[] | null = null;
	const lastColon = address.lastIndexOf(':');
	const lastPart = address.slice(lastColon + 1);
	if (lastPart.includes('.')) {
		const octets = lastPart.split('.').map(Number);
		tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
		address = `${address.slice(0, lastColon + 1)}0:0`;
	}

	const halves = address.split('::');
	const head = halves[0] ? halves[0].split(':') : [];
	const rest = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
	const missing = halves.length > 1 ? 8 - head.length - rest.length : 0;
	const groups = [...head, ...new Array<string>(Math.max(0, missing)).fill('0'), ...rest].map((part) =>
		Number.parseInt(part, 16),
	);
	if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) {
		return null;
	}
	if (tail) {
		groups[6] = tail[0];
		groups[7] = tail[1];
	}
	return groups;
}

/** The dotted form of the IPv4 address held in the last two groups. */
function dottedFrom(high: number, low: number): string {
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Normalize an IP address for comparison. IPv4 stays dotted, an IPv4-mapped IPv6 address
 * (`::ffff:1.2.3.4`) becomes its IPv4 form, and any other IPv6 address becomes eight lowercase
 * hexadecimal groups without leading zeros. Returns null when the text is not an IP address.
 */
export function normalizeIp(address: string): string | null {
	const text = address.trim();
	if (net.isIPv4(text)) {
		return text;
	}
	const groups = parseIpv6(text);
	if (!groups) {
		return null;
	}
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
		return dottedFrom(groups[6], groups[7]);
	}
	return groups.map((group) => group.toString(16)).join(':');
}

/**
 * The key a client is limited under. The peer address is used unless the peer is a trusted proxy,
 * in which case the rightmost X-Forwarded-For entry is used (the one the proxy appended). An entry
 * that is not an IP address is never trusted, so the key falls back to the peer. An IPv6 client is
 * keyed by its /64 prefix, because one subscriber usually controls a whole /64.
 */
export function clientKey(
	peerAddress: string | undefined,
	forwardedFor: string | undefined,
	trustedProxies: readonly string[],
): string {
	const peer = peerAddress === undefined ? null : normalizeIp(peerAddress);
	if (peer === null) {
		return 'unknown';
	}
	let address = peer;
	if (forwardedFor && trustedProxies.includes(peer)) {
		const entries = forwardedFor.split(',');
		const rightmost = entries[entries.length - 1]?.trim() ?? '';
		address = normalizeIp(rightmost) ?? peer;
	}
	if (!address.includes(':')) {
		return address;
	}
	return `${address.split(':').slice(0, 4).join(':')}::/64`;
}
