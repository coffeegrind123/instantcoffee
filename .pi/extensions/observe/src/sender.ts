/**
 * Delivers envelopes to instantcoffee-observe's POST /api/events.
 *
 * The rule this file exists to keep: observability must never cost the session
 * anything. Handlers enqueue and return immediately; one drain loop POSTs in
 * order (the server pairs Pre/Post and Start/Stop by arrival); a dead observe
 * server costs one failed request per backoff window, not one per event; and
 * the queue is bounded so a long offline stretch cannot grow pi's heap.
 */

import type { Envelope } from "./mapper.ts";
import { now as clockNow } from "./clock.ts";

export const EVENTS_PATH = "/api/events";

export interface SenderOptions {
	url: string;
	projectSlug: string | null;
	timeoutMs: number;
	maxQueue: number;
	backoffMs: number;
	fetchFn?: typeof fetch;
	now?: () => number;
}

export interface SenderStats {
	url: string;
	sent: number;
	dropped: number;
	queued: number;
	lastError: string | null;
	lastErrorAt: number | null;
	lastOkAt: number | null;
}

export class Sender {
	private readonly opts: SenderOptions;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private queue: Envelope[] = [];
	private draining: Promise<void> | null = null;
	private offlineUntil = 0;
	private stats: SenderStats;

	constructor(opts: SenderOptions) {
		this.opts = opts;
		this.fetchFn = opts.fetchFn ?? fetch;
		this.now = opts.now ?? clockNow;
		this.stats = {
			url: opts.url,
			sent: 0,
			dropped: 0,
			queued: 0,
			lastError: null,
			lastErrorAt: null,
			lastOkAt: null,
		};
	}

	send(envelope: Envelope): void {
		if (this.queue.length >= this.opts.maxQueue) {
			this.queue.shift();
			this.stats.dropped++;
		}
		this.queue.push(envelope);
		this.kick();
	}

	/** Wait for the queue to empty, but never longer than `deadlineMs`. */
	async flush(deadlineMs: number): Promise<void> {
		this.kick();
		const draining = this.draining;
		if (!draining) {
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, deadlineMs);
		});
		await Promise.race([draining, deadline]);
		clearTimeout(timer);
	}

	snapshot(): SenderStats {
		return { ...this.stats, queued: this.queue.length };
	}

	private kick(): void {
		if (this.draining || this.queue.length === 0) {
			return;
		}
		this.draining = this.drain().finally(() => {
			this.draining = null;
		});
	}

	private async drain(): Promise<void> {
		while (this.queue.length > 0) {
			// While observe is known to be down, discard instead of retrying per
			// event — a session that outlives the dashboard must stay cheap.
			if (this.now() < this.offlineUntil) {
				this.stats.dropped += this.queue.length;
				this.queue = [];
				return;
			}

			const envelope = this.queue.shift() as Envelope;
			try {
				const rejected = await this.post(envelope);
				if (rejected) {
					this.stats.dropped++;
					this.stats.lastError = rejected;
					this.stats.lastErrorAt = this.now();
					continue;
				}
				this.stats.sent++;
				this.stats.lastOkAt = this.now();
			} catch (err) {
				this.stats.dropped++;
				this.stats.lastError = describe(err);
				this.stats.lastErrorAt = this.now();
				this.offlineUntil = this.now() + this.opts.backoffMs;
			}
		}
	}

	/**
	 * POST one envelope. Returns null on success, or the server's reason when it
	 * rejected this event (4xx): that is this extension's bug, not an outage, so
	 * it must not trip the offline backoff for every event after it. Throws on
	 * transport failures and 5xx/429.
	 */
	private async post(envelope: Envelope): Promise<string | null> {
		const body: Record<string, unknown> = { hook_payload: envelope };
		if (this.opts.projectSlug) {
			body.meta = { env: { INSTANTCOFFEE_OBSERVE_PROJECT_SLUG: this.opts.projectSlug } };
		}
		const res = await this.fetchFn(`${this.opts.url}${EVENTS_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.opts.timeoutMs),
		});
		if (res.ok) {
			return null;
		}
		const reason = `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`.trim();
		if (res.status >= 400 && res.status < 500 && res.status !== 429) {
			return reason;
		}
		throw new Error(reason);
	}
}

function describe(err: unknown): string {
	if (err instanceof Error) {
		const cause = (err as Error & { cause?: { code?: string } }).cause;
		return cause?.code ? `${err.message} (${cause.code})` : err.message;
	}
	return String(err);
}
