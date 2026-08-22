import { randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import {
	type HostedSessionRecoveryPage,
	type PendingSessionInput,
	type QorperaHostedPrimary,
	type SessionInputReceipt,
	type SessionTurnClaim,
	type SessionTurnInput,
	SessionTurnOwnershipError,
} from "./hosted-primary.ts";

/**
 * Per-company client of the hosted session arbiter (migration 20260818007000,
 * contract in supabase/SESSIONS.md).
 *
 * The cloud owns the conversation: one open session per staff agent, adopted
 * or atomically created, and every turn — the kickoff included — is a queue
 * row that exactly one executor claims. This class holds the per-company
 * mapping from staff agents to their hosted sessions plus the single active
 * claim, and nothing else; timers, children, and dispatch stay in main.ts
 * where the runtime lifecycle already lives.
 *
 * Every method that talks to the cloud can reject. Cloud companies keep
 * the prompt in the composer on failure; they never fork the authoritative
 * conversation into a machine-local fallback.
 */

export interface ArbiterSessionRef {
	hostedSessionId: string;
	/** Trail identity: the local trail header id equals this by construction. */
	clientSessionId: string;
	staffAgentId: string;
	title: string;
	createdAt: string;
	companySnapshotId?: string;
	staffVersion?: number;
	/** True when this machine's ensure created the session (and its kickoff row). */
	created: boolean;
}

export interface ArbiterExecutionPin {
	companySnapshotId: string;
	staffVersion: number;
}

export interface ArbiterClaim {
	turnId: string;
	hostedSessionId: string;
	staffAgentId: string;
	companySnapshotId: string;
	staffVersion: number;
	inputs: SessionTurnInput[];
	claimedAt: number;
	leaseExpiresAt: number;
}

const RENEW_INTERVAL_MS = 45_000;
const TURN_LEASE_SECONDS = 180;

export class CloudSessionArbiter {
	readonly claimantId: string;
	readonly #primary: QorperaHostedPrimary;
	readonly #environmentId: string;
	readonly #byStaff = new Map<string, ArbiterSessionRef>();
	#activeClaim: ArbiterClaim | undefined;
	#lastRenewAt = 0;
	#lastClaimRefusal?: Extract<SessionTurnClaim, { claimed: false }>["reason"];

	constructor(primary: QorperaHostedPrimary, environmentId: string, claimantId: string = randomUUID()) {
		this.#primary = primary;
		this.#environmentId = environmentId;
		this.claimantId = claimantId;
	}

	sessionForStaff(staffAgentId: string): ArbiterSessionRef | undefined {
		return this.#byStaff.get(staffAgentId);
	}

	get activeClaim(): ArbiterClaim | undefined {
		return this.#activeClaim;
	}

	get lastClaimRefusal(): Extract<SessionTurnClaim, { claimed: false }>["reason"] | undefined {
		return this.#lastClaimRefusal;
	}

	/** Adopt the staff agent's open hosted session, or create it (which also
	 * enqueues the one kickoff row server-side). The preferred client session
	 * id is used only when this call ends up creating; adoption always takes
	 * the cloud's identity so the local trail file matches every other
	 * machine's. */
	async ensureSession(
		staffAgentId: string,
		title: string,
		preferredClientSessionId?: string,
	): Promise<ArbiterSessionRef> {
		const clientSessionId = preferredClientSessionId ?? randomUUID();
		const handle = await this.#primary.ensureStaffSession(this.#environmentId, staffAgentId, clientSessionId, title);
		let ref: ArbiterSessionRef;
		if (handle.created) {
			ref = {
				hostedSessionId: handle.sessionId,
				clientSessionId: handle.clientSessionId,
				staffAgentId,
				title: handle.title,
				createdAt: handle.createdAt,
				...(handle.companySnapshotId ? { companySnapshotId: handle.companySnapshotId } : {}),
				...(handle.staffVersion ? { staffVersion: handle.staffVersion } : {}),
				created: true,
			};
		} else {
			ref = {
				hostedSessionId: handle.sessionId,
				clientSessionId: handle.clientSessionId,
				staffAgentId,
				title: handle.title,
				createdAt: handle.createdAt,
				...(handle.companySnapshotId ? { companySnapshotId: handle.companySnapshotId } : {}),
				...(handle.staffVersion ? { staffVersion: handle.staffVersion } : {}),
				created: false,
			};
		}
		this.#byStaff.set(staffAgentId, ref);
		return ref;
	}

	/** Enqueue a complete reviewed prompt. Binary attachments are already
	 * content-addressed cloud references; the queue row is therefore the
	 * durable authority for text and images together. */
	async appendPrompt(staffAgentId: string, clientInputId: string, body: JsonValue): Promise<SessionInputReceipt> {
		const ref = this.#requireSession(staffAgentId);
		return this.#primary.appendSessionInput(ref.hostedSessionId, clientInputId, body);
	}

	async pendingInputs(staffAgentId: string): Promise<PendingSessionInput[]> {
		return this.#primary.listSessionInputs(this.#requireSession(staffAgentId).hostedSessionId);
	}

	async recoveries(staffAgentId: string, limit = 10): Promise<HostedSessionRecoveryPage> {
		return this.#primary.listSessionRecoveries(this.#requireSession(staffAgentId).hostedSessionId, undefined, limit);
	}

	async executionRecoveries(staffAgentId: string, limit = 20) {
		return this.#primary.listSessionExecutionRunRecoveries(this.#requireSession(staffAgentId).hostedSessionId, limit);
	}

	async resolveExecutionRecovery(staffAgentId: string, runId: string, action: "retry" | "discard"): Promise<void> {
		this.#requireSession(staffAgentId);
		await this.#primary.resolveFailedExecutionRun(runId, action);
	}

	async resolveRecovery(staffAgentId: string, turnId: string, resolution: "retry" | "discard"): Promise<void> {
		await this.#primary.resolveSessionRecovery(
			this.#requireSession(staffAgentId).hostedSessionId,
			turnId,
			resolution,
		);
	}

	/** Try to become the executor for the staff agent's pending turn. Returns
	 * the claimed inputs (kickoff first when present), or undefined when the
	 * queue is empty or another executor's turn is in flight. */
	async claimTurn(staffAgentId: string, pin: ArbiterExecutionPin): Promise<ArbiterClaim | undefined> {
		const ref = this.#requireSession(staffAgentId);
		if (this.#activeClaim) return undefined;
		const claim = await this.#primary.claimSessionTurn(
			ref.hostedSessionId,
			this.claimantId,
			pin.companySnapshotId,
			pin.staffVersion,
			TURN_LEASE_SECONDS,
		);
		if (!claim.claimed) {
			this.#lastClaimRefusal = claim.reason;
			return undefined;
		}
		this.#lastClaimRefusal = undefined;
		const claimedAt = Date.now();
		this.#activeClaim = {
			turnId: claim.turnId,
			hostedSessionId: ref.hostedSessionId,
			staffAgentId,
			companySnapshotId: claim.companySnapshotId,
			staffVersion: claim.staffVersion,
			inputs: claim.inputs,
			claimedAt,
			leaseExpiresAt: claimedAt + TURN_LEASE_SECONDS * 1_000,
		};
		this.#lastRenewAt = claimedAt;
		return this.#activeClaim;
	}

	/** Keep the lease alive while the agent works. Throttled internally; safe
	 * to call from every activity frame. */
	async renewIfDue(): Promise<void> {
		const claim = this.#activeClaim;
		if (!claim) return;
		const now = Date.now();
		if (now - this.#lastRenewAt < RENEW_INTERVAL_MS) return;
		try {
			await this.#primary.renewSessionTurn(claim.hostedSessionId, claim.turnId, this.claimantId, TURN_LEASE_SECONDS);
		} catch (error) {
			if (Date.now() >= claim.leaseExpiresAt) throw new SessionTurnOwnershipError("renew");
			throw error;
		}
		if (this.#activeClaim === claim) {
			this.#lastRenewAt = now;
			claim.leaseExpiresAt = Date.now() + TURN_LEASE_SECONDS * 1_000;
		}
	}

	/** The turn ran to completion: mark its inputs consumed. */
	async completeTurn(trailEndSequence: number, expectedClaim?: ArbiterClaim): Promise<void> {
		const claim = this.#activeClaim;
		if (!claim) {
			if (expectedClaim) throw new SessionTurnOwnershipError("complete");
			return;
		}
		if (expectedClaim && claim !== expectedClaim) throw new SessionTurnOwnershipError("complete");
		await this.#primary.completeSessionTurn(claim.hostedSessionId, claim.turnId, this.claimantId, trailEndSequence);
		if (this.#activeClaim === claim) this.#activeClaim = undefined;
	}

	async quarantineTurn(reason: string, expectedClaim?: ArbiterClaim): Promise<void> {
		const claim = this.#activeClaim;
		if (!claim) {
			if (expectedClaim) throw new SessionTurnOwnershipError("complete");
			return;
		}
		if (expectedClaim && claim !== expectedClaim) throw new SessionTurnOwnershipError("complete");
		await this.#primary.quarantineSessionTurn(claim.hostedSessionId, claim.turnId, this.claimantId, reason);
		if (this.#activeClaim === claim) this.#activeClaim = undefined;
	}

	async turnStatus(
		claim: ArbiterClaim,
	): Promise<"active" | "completed" | "quarantined" | "review_pending" | "unavailable"> {
		return (await this.#primary.getSessionTurnStatus(claim.hostedSessionId, claim.turnId, this.claimantId)).status;
	}

	/** The executor died or the turn failed before running: never mark the
	 * inputs consumed. The server quarantines an expired execution for review;
	 * it never offers an outcome-ambiguous operation to another machine. */
	abandonClaim(): void {
		this.#activeClaim = undefined;
	}

	#requireSession(staffAgentId: string): ArbiterSessionRef {
		const ref = this.#byStaff.get(staffAgentId);
		if (!ref) throw new Error("staff session has not been ensured");
		return ref;
	}
}
