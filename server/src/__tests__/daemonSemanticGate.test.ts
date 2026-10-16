/**
 * Tests for the semantic gate: the slots, the queue behind them, and what happens to a request that
 * is waiting when it times out. They run the real gate on real promises and real abort signals,
 * with no model, because the gate does not care what runs inside a slot. The model-gated tests in
 * daemonSemantic.test.ts run it through HTTP. No mocks.
 */

import { describe, expect, it } from 'vitest';
import { WorkCancelled } from '../daemon/limits.js';
import { ApiError } from '../daemon/protocol.js';
import { SEMANTIC_BUSY_RETRY_SECONDS, SemanticGate } from '../daemon/semantic.js';

const live = (): AbortSignal => new AbortController().signal;

/** Whether a promise has settled by now, without waiting for it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	const marker = Symbol('pending');
	return (
		(await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			Promise.resolve(marker),
		])) !== marker
	);
}

describe('SemanticGate', () => {
	it('grants a free slot at once', async () => {
		const gate = new SemanticGate(1, 8);

		const release = await gate.acquire(live());

		expect(gate.running).toBe(1);
		expect(gate.queued).toBe(0);
		release();
		expect(gate.running).toBe(0);
	});

	it('queues a request when every slot is taken, and serves the queue in order as slots are released', async () => {
		const gate = new SemanticGate(1, 8);
		const order: string[] = [];
		const first = await gate.acquire(live());
		const second = gate.acquire(live()).then((release) => {
			order.push('second');
			return release;
		});
		const third = gate.acquire(live()).then((release) => {
			order.push('third');
			return release;
		});

		expect(gate.queued).toBe(2);
		expect(await settled(second)).toBe(false);
		first();
		const secondRelease = await second;
		expect(order).toEqual(['second']);
		expect(await settled(third)).toBe(false);
		// The slot went from one holder to the next, never free in between.
		expect(gate.running).toBe(1);
		secondRelease();
		(await third)();

		expect(order).toEqual(['second', 'third']);
		expect(gate.running).toBe(0);
		expect(gate.queued).toBe(0);
	});

	it('does not let a newcomer take a slot ahead of a request that is waiting', async () => {
		const gate = new SemanticGate(1, 8);
		const first = await gate.acquire(live());
		const waiting = gate.acquire(live());
		first();
		const newcomer = gate.acquire(live());

		const release = await waiting;

		expect(await settled(newcomer)).toBe(false);
		expect(gate.queued).toBe(1);
		release();
		(await newcomer)();
	});

	it('runs as many requests at once as there are slots', async () => {
		const gate = new SemanticGate(2, 1);
		const a = await gate.acquire(live());
		const b = await gate.acquire(live());
		const c = gate.acquire(live());

		expect(gate.running).toBe(2);
		expect(gate.queued).toBe(1);
		await expect(gate.acquire(live())).rejects.toMatchObject({ code: 'SEMANTIC_BUSY' });
		a();
		(await c)();
		b();
		expect(gate.running).toBe(0);
	});

	it('refuses with SEMANTIC_BUSY and a Retry-After of 5 when the slots and the queue are full', async () => {
		const gate = new SemanticGate(1, 1);
		const holder = await gate.acquire(live());
		const queued = gate.acquire(live());

		const refusal = await gate.acquire(live()).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(ApiError);
		expect(refusal).toMatchObject({ code: 'SEMANTIC_BUSY', status: 503, options: { retryAfterSeconds: 5 } });
		expect(SEMANTIC_BUSY_RETRY_SECONDS).toBe(5);
		holder();
		(await queued)();
	});

	it('refuses at once when the queue is 0 and the slot is taken', async () => {
		const gate = new SemanticGate(1, 0);
		const holder = await gate.acquire(live());

		await expect(gate.acquire(live())).rejects.toMatchObject({ code: 'SEMANTIC_BUSY' });
		holder();
		(await gate.acquire(live()))();
	});

	it('removes a waiting request from the queue when its signal aborts, and never gives it the slot', async () => {
		const gate = new SemanticGate(1, 8);
		const holder = await gate.acquire(live());
		const aborting = new AbortController();
		const cancelled = gate.acquire(aborting.signal);
		const next = gate.acquire(live());
		expect(gate.queued).toBe(2);

		aborting.abort();

		await expect(cancelled).rejects.toBeInstanceOf(WorkCancelled);
		expect(gate.queued).toBe(1);
		holder();
		(await next)();
		expect(gate.running).toBe(0);
	});

	it('counts the time spent queued toward a timer: a waiter whose timer fires leaves the queue', async () => {
		const gate = new SemanticGate(1, 8);
		const holder = await gate.acquire(live());
		const startedAt = Date.now();

		const timedOut = await gate.acquire(AbortSignal.timeout(60)).catch((error: unknown) => error);

		expect(timedOut).toBeInstanceOf(WorkCancelled);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
		expect(gate.queued).toBe(0);
		holder();
		expect(gate.running).toBe(0);
	});

	it('refuses a request whose signal has already aborted, without taking a slot', async () => {
		const gate = new SemanticGate(1, 8);
		const controller = new AbortController();
		controller.abort();

		await expect(gate.acquire(controller.signal)).rejects.toBeInstanceOf(WorkCancelled);

		expect(gate.running).toBe(0);
	});

	it('ignores a second release of the same slot, so it cannot hand one slot to two requests', async () => {
		const gate = new SemanticGate(1, 8);
		const first = await gate.acquire(live());
		const second = gate.acquire(live());
		const third = gate.acquire(live());

		first();
		first();
		const secondRelease = await second;

		expect(gate.running).toBe(1);
		expect(await settled(third)).toBe(false);
		secondRelease();
		(await third)();
	});

	it('rejects a concurrency or queue that is not a valid integer', () => {
		expect(() => new SemanticGate(0, 1)).toThrow(RangeError);
		expect(() => new SemanticGate(1.5, 1)).toThrow(RangeError);
		expect(() => new SemanticGate(1, -1)).toThrow(RangeError);
		expect(() => new SemanticGate(1, 0.5)).toThrow(RangeError);
	});
});
