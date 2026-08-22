import { randomUUID } from "node:crypto";
import type { ArbiterExecutionPin } from "./cloud-session-arbiter.ts";
import { type QorperaHostedPrimary, WakeOwnershipError } from "./hosted-primary.ts";

/**
 * Per-company client of the hosted wake claims (migration 20260819012000,
 * contract in supabase/SESSIONS.md).
 *
 * Autonomous wakes are claimed rows: every machine with the company open
 * derives the same deterministic key for a due wake occurrence, and exactly
 * one machine's claim succeeds — the winner runs the wake, a loser consumes
 * the occurrence locally without running. Completion makes the occurrence
 * final everywhere; an abandoned claim is quarantined after lease expiry so
 * a possibly completed external action is never run twice.
 *
 * Every method that talks to the cloud can reject. A cloud company leaves
 * the wake pending on failure; it never executes an unclaimed local copy.
 * Wakes are single-flight per company, so one active claim is all this class
 * ever holds.
 */

export type WakeClaimOutcome =
	| "claimed"
	| "lost-in-flight"
	| "lost-already-run"
	| "lost-stale-revision"
	| "lost-requires-review";

const RENEW_INTERVAL_MS = 60_000;
const WAKE_LEASE_SECONDS = 300;

export class CloudWakeArbiter {
	readonly claimantId: string;
	readonly #primary: QorperaHostedPrimary;
	readonly #environmentId: string;
	#activeKey: string | undefined;
	#activeExecutionId: string | undefined;
	#lastRenewAt = 0;
	#leaseExpiresAt = 0;

	constructor(primary: QorperaHostedPrimary, environmentId: string, claimantId: string = randomUUID()) {
		this.#primary = primary;
		this.#environmentId = environmentId;
		this.claimantId = claimantId;
	}

	get activeKey(): string | undefined {
		return this.#activeKey;
	}

	get activeExecutionId(): string | undefined {
		return this.#activeExecutionId;
	}

	/** Try to become the executor for the wake occurrence. Re-claiming the
	 * key this machine already holds refreshes the lease (idempotent retry
	 * after a failed spawn). */
	async claim(wakeKey: string, staffAgentId: string, pin: ArbiterExecutionPin): Promise<WakeClaimOutcome> {
		const result = await this.#primary.claimWake(
			this.#environmentId,
			wakeKey,
			this.claimantId,
			staffAgentId,
			pin.companySnapshotId,
			pin.staffVersion,
			WAKE_LEASE_SECONDS,
		);
		if (!result.claimed) {
			if (result.reason === "already-run") return "lost-already-run";
			if (result.reason === "requires-review") return "lost-requires-review";
			return result.reason === "stale-revision" ? "lost-stale-revision" : "lost-in-flight";
		}
		this.#activeKey = wakeKey;
		this.#activeExecutionId = result.executionId;
		this.#lastRenewAt = Date.now();
		this.#leaseExpiresAt = this.#lastRenewAt + WAKE_LEASE_SECONDS * 1_000;
		return "claimed";
	}

	/** Keep the lease alive while the wake runs. Throttled internally; safe
	 * to call from every activity frame. */
	async renewIfDue(): Promise<void> {
		const key = this.#activeKey;
		if (!key) return;
		const now = Date.now();
		if (now - this.#lastRenewAt < RENEW_INTERVAL_MS) return;
		try {
			await this.#primary.renewWake(this.#environmentId, key, this.claimantId, WAKE_LEASE_SECONDS);
		} catch (error) {
			if (Date.now() >= this.#leaseExpiresAt) throw new WakeOwnershipError("renew");
			throw error;
		}
		if (this.#activeKey === key) {
			this.#lastRenewAt = now;
			this.#leaseExpiresAt = Date.now() + WAKE_LEASE_SECONDS * 1_000;
		}
	}

	/** The wake ran to completion: the occurrence is final on every machine. */
	async complete(): Promise<void> {
		const key = this.#activeKey;
		if (!key) return;
		await this.#primary.completeWake(this.#environmentId, key, this.claimantId);
		if (this.#activeKey === key) this.#activeKey = undefined;
		this.#activeExecutionId = undefined;
	}

	/** The executor died or the wake failed: drop the local handle. The server
	 * quarantines the occurrence after lease expiry for explicit review. */
	abandon(): void {
		this.#activeKey = undefined;
		this.#activeExecutionId = undefined;
		this.#leaseExpiresAt = 0;
	}
}
