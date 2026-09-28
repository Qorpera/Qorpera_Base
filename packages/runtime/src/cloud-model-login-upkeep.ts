import type { CloudModelLoginVault } from "./cloud-model-login-vault.ts";

/**
 * The vault's own upkeep (Stateless Compute step 1, founder decisions 2026-09-28): every few
 * minutes each company's broker renews its idle logins itself, one at a time, so a login nobody
 * used does not lapse before its next run. A run's own renewal and this one share the login's
 * one renewal lock, so they never clash.
 */

/** How often the broker looks for due logins. */
const PASS_EVERY_MS = 5 * 60_000;
/** Logins renewed in one pass at most; the rest wait for the next pass. */
const RENEWALS_PER_PASS = 12;
/** Taking a login gets this long; the renewal then runs to its own budget. */
const TAKE_DEADLINE_MS = 15_000;

export class CloudModelLoginUpkeep {
	readonly #vault: Pick<CloudModelLoginVault, "renewIdle">;
	readonly #passEveryMs: number;
	readonly #firstPassMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	#started = false;
	#closed = false;

	constructor(options: {
		vault: Pick<CloudModelLoginVault, "renewIdle">;
		passEveryMs?: number;
		/** The first pass waits this long; by default a random part of a pass, so the brokers that
		 * share one helper do not all renew at once after a restart. */
		firstPassMs?: number;
	}) {
		this.#vault = options.vault;
		this.#passEveryMs = options.passEveryMs ?? PASS_EVERY_MS;
		this.#firstPassMs = options.firstPassMs ?? 30_000 + Math.floor(Math.random() * this.#passEveryMs);
	}

	start(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		const loop = (): void => {
			if (this.#closed) return;
			this.#running = this.pass().finally(() => {
				this.#running = undefined;
				if (!this.#closed) this.#timer = setTimeout(loop, this.#passEveryMs);
			});
		};
		this.#timer = setTimeout(loop, this.#firstPassMs);
	}

	async close(): Promise<void> {
		this.#closed = true;
		clearTimeout(this.#timer);
		await this.#running;
	}

	/** One pass: renews due logins until none is left, a take fails, or the pass has done enough. */
	async pass(): Promise<void> {
		for (let renewed = 0; renewed < RENEWALS_PER_PASS && !this.#closed; renewed += 1) {
			try {
				if ((await this.#vault.renewIdle(AbortSignal.timeout(TAKE_DEADLINE_MS))) === "none") return;
			} catch {
				// The database or the answer failed: the next pass tries again. The error itself may name
				// a login; only the fact is logged, so a broken call never switches renewal off unseen.
				console.error("Model login upkeep: a pass stopped on an error; the next pass tries again.");
				return;
			}
		}
	}
}
