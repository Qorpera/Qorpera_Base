import type { CloudModelLoginVault } from "./cloud-model-login-vault.ts";
import { cloudVaultFailureClass } from "./cloud-vault-database-failure.ts";

/**
 * The vault's own upkeep (Stateless Compute step 1, founder decisions 2026-09-28). Every few
 * minutes each company's broker:
 * - records the ChatGPT account of its new logins, then switches off members' old node logins
 *   that a vault login of the same account replaced (their pins move to the vault login first,
 *   and their work finishes on them first);
 * - renews its idle logins itself, one at a time, so a login nobody used does not lapse before its
 *   next run. A run's own renewal and this one share the login's one renewal lock;
 * - ends at OpenAI the ChatGPT plan logins nothing uses any longer (their member disconnected or left),
 *   under the same lock;
 * - reads the usage of its logins at their usage limit that are due a reading, once a day and once a reset passed
 *   (the daily usage check, migration 20260930575000), so work waiting on them goes on when they have room.
 */

/** How often the broker looks for due logins. */
const PASS_EVERY_MS = 5 * 60_000;
/** Logins renewed in one pass at most; the rest wait for the next pass. */
const RENEWALS_PER_PASS = 12;
/** Plan logins ended in one pass at most. */
const REVOCATIONS_PER_PASS = 4;
/** Taking a login gets this long; the renewal then runs to its own budget. */
const TAKE_DEADLINE_MS = 15_000;
/** Usage rechecks in one pass at most, each within this long (its reads take 8 s each, its saves 5 s). */
const RECHECKS_PER_PASS = 4;
const RECHECK_DEADLINE_MS = 30_000;

/** The daily usage check's one step (CloudModelLoginUsage.recheck, bound to the company). */
export interface CloudModelLoginRecheck {
	recheck(signal: AbortSignal): Promise<"read" | "none">;
}

export class CloudModelLoginUpkeep {
	readonly #vault: Pick<
		CloudModelLoginVault,
		"renewIdle" | "recordAccounts" | "switchOffReplacedNodeLogins" | "revokeUnused"
	>;
	readonly #usage: CloudModelLoginRecheck | undefined;
	readonly #passEveryMs: number;
	readonly #firstPassMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	#started = false;
	#closed = false;

	constructor(options: {
		vault: Pick<
			CloudModelLoginVault,
			"renewIdle" | "recordAccounts" | "switchOffReplacedNodeLogins" | "revokeUnused"
		>;
		/** The daily usage check; without it the pass reads no usage. */
		usage?: CloudModelLoginRecheck;
		passEveryMs?: number;
		/** The first pass waits this long; by default a random part of a pass, so the brokers that
		 * share one helper do not all renew at once after a restart. */
		firstPassMs?: number;
	}) {
		this.#vault = options.vault;
		this.#usage = options.usage;
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

	/** One pass: accounts and the switch-off first, then due logins until none is left, a take fails,
	 * or the pass has done enough, then unused plan logins. Each part's failure is logged by fact and class only
	 * (cloudVaultFailureClass): an error's text may name a login. */
	async pass(): Promise<void> {
		await this.#renewals();
		await this.#rechecks();
		for (let ended = 0; ended < REVOCATIONS_PER_PASS && !this.#closed; ended += 1) {
			try {
				if ((await this.#vault.revokeUnused(AbortSignal.timeout(TAKE_DEADLINE_MS))) !== "revoked") return;
			} catch (error) {
				console.error(
					`Model login upkeep: ending an unused ChatGPT plan login failed (class: ${cloudVaultFailureClass(error)}); the next pass tries again.`,
				);
				return;
			}
		}
	}

	/** Due usage rechecks, one at a time, until none is due, one fails, or the pass has done enough. */
	async #rechecks(): Promise<void> {
		if (!this.#usage) return;
		for (let read = 0; read < RECHECKS_PER_PASS && !this.#closed; read += 1) {
			try {
				if ((await this.#usage.recheck(AbortSignal.timeout(RECHECK_DEADLINE_MS))) === "none") return;
			} catch (error) {
				console.error(
					`Model login upkeep: a usage recheck failed (class: ${cloudVaultFailureClass(error)}); the next pass tries again.`,
				);
				return;
			}
		}
	}

	async #renewals(): Promise<void> {
		try {
			await this.#vault.recordAccounts(AbortSignal.timeout(TAKE_DEADLINE_MS * 2));
		} catch (error) {
			console.error(
				`Model login upkeep: recording login accounts failed (class: ${cloudVaultFailureClass(error)}); the next pass tries again.`,
			);
		}
		try {
			const switched = await this.#vault.switchOffReplacedNodeLogins(AbortSignal.timeout(TAKE_DEADLINE_MS));
			if (switched.switchedOff > 0)
				console.error(
					`Model login upkeep: switched off ${switched.switchedOff} old node login(s) the vault replaced.`,
				);
		} catch (error) {
			console.error(
				`Model login upkeep: the switch-off pass failed (class: ${cloudVaultFailureClass(error)}); the next pass tries again.`,
			);
		}
		for (let renewed = 0; renewed < RENEWALS_PER_PASS && !this.#closed; renewed += 1) {
			try {
				if ((await this.#vault.renewIdle(AbortSignal.timeout(TAKE_DEADLINE_MS))) === "none") return;
			} catch (error) {
				// The database or the answer failed: the next pass tries again. The error itself may name
				// a login; only the fact and its class are logged, so a broken call never switches renewal off unseen.
				console.error(
					`Model login upkeep: a pass stopped on an error (class: ${cloudVaultFailureClass(error)}); the next pass tries again.`,
				);
				return;
			}
		}
	}
}
