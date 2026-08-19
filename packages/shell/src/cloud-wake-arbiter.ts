import { randomUUID } from "node:crypto";
import type { QorperaHostedPrimary } from "./hosted-primary.ts";

/**
 * Per-company client of the hosted wake claims (migration 20260819012000,
 * contract in supabase/SESSIONS.md).
 *
 * Autonomous wakes are claimed rows: every machine with the company open
 * derives the same deterministic key for a due wake occurrence, and exactly
 * one machine's claim succeeds — the winner runs the wake, a loser consumes
 * the occurrence locally without running. Completion makes the occurrence
 * final everywhere; an abandoned claim (executor died, spawn failed) simply
 * lets the lease expire so another machine takes the occurrence over.
 *
 * Every method that talks to the cloud can reject. Callers degrade to
 * today's solo behaviour on failure — arbitration deduplicates wakes when
 * the cloud is reachable, and must never make solo work impossible when it
 * is not. Wakes are single-flight per company, so one active claim is all
 * this class ever holds.
 */

export type WakeClaimOutcome = "claimed" | "lost-in-flight" | "lost-already-run";

const RENEW_INTERVAL_MS = 60_000;
const WAKE_LEASE_SECONDS = 300;

export class CloudWakeArbiter {
	readonly claimantId: string;
	readonly #primary: QorperaHostedPrimary;
	readonly #environmentId: string;
	#activeKey: string | undefined;
	#lastRenewAt = 0;

	constructor(primary: QorperaHostedPrimary, environmentId: string, claimantId: string = randomUUID()) {
		this.#primary = primary;
		this.#environmentId = environmentId;
		this.claimantId = claimantId;
	}

	get activeKey(): string | undefined {
		return this.#activeKey;
	}

	/** Try to become the executor for the wake occurrence. Re-claiming the
	 * key this machine already holds refreshes the lease (idempotent retry
	 * after a failed spawn). */
	async claim(wakeKey: string): Promise<WakeClaimOutcome> {
		const result = await this.#primary.claimWake(this.#environmentId, wakeKey, this.claimantId, WAKE_LEASE_SECONDS);
		if (!result.claimed) {
			return result.reason === "already-run" ? "lost-already-run" : "lost-in-flight";
		}
		this.#activeKey = wakeKey;
		this.#lastRenewAt = Date.now();
		return "claimed";
	}

	/** Keep the lease alive while the wake runs. Throttled internally; safe
	 * to call from every activity frame. */
	async renewIfDue(): Promise<void> {
		const key = this.#activeKey;
		if (!key) return;
		const now = Date.now();
		if (now - this.#lastRenewAt < RENEW_INTERVAL_MS) return;
		this.#lastRenewAt = now;
		await this.#primary.renewWake(this.#environmentId, key, this.claimantId, WAKE_LEASE_SECONDS);
	}

	/** The wake ran to completion: the occurrence is final on every machine. */
	async complete(): Promise<void> {
		const key = this.#activeKey;
		if (!key) return;
		this.#activeKey = undefined;
		await this.#primary.completeWake(this.#environmentId, key, this.claimantId);
	}

	/** The executor died or the wake failed: never mark the occurrence final —
	 * drop the local claim and let the lease expire so another machine (or
	 * this one, later) takes the occurrence over. */
	abandon(): void {
		this.#activeKey = undefined;
	}
}
